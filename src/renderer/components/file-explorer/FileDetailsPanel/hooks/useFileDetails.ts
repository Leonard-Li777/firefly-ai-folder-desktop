import { DirectoryItem, FileItem } from '@firefly/types'
import { LogCategory, logger } from '@firefly/shared'
import { useCallback, useEffect, useRef, useState } from 'react'

import { t } from '@app/languages'
import { toast } from '../../../common/Toast'
import { useAnalysisQueueStore } from '../../../../stores/analysis-queue-store'
import { notifyEnqueueResult } from '../../../../utils/enqueue-notifier'

/** 单文件/目录分析详情客户端 LRU 缓存（命中时 0ms 秒开，后台静默校验更新） */
const DETAILS_CACHE_MAX = 60
const fileDetailsCache = new Map<string, any>()

function getDetailsCacheKey(path: string, isDir: boolean): string {
  const norm =
    window.electronAPI?.utils?.normalizeForCache?.(path) ||
    path.toLowerCase().replace(/[\\/]+$/, '')
  return `${isDir ? 'dir' : 'file'}::${norm}`
}

function readDetailsCache(path: string, isDir: boolean): any | undefined {
  const key = getDetailsCacheKey(path, isDir)
  const hit = fileDetailsCache.get(key)
  if (hit !== undefined) {
    fileDetailsCache.delete(key)
    fileDetailsCache.set(key, hit)
  }
  return hit
}

function writeDetailsCache(path: string, isDir: boolean, value: any): void {
  const key = getDetailsCacheKey(path, isDir)
  if (fileDetailsCache.size >= DETAILS_CACHE_MAX && !fileDetailsCache.has(key)) {
    const oldest = fileDetailsCache.keys().next().value
    if (oldest !== undefined) fileDetailsCache.delete(oldest)
  }
  fileDetailsCache.set(key, value)
}

function invalidateDetailsCache(path?: string): void {
  if (!path) {
    fileDetailsCache.clear()
    return
  }
  fileDetailsCache.delete(getDetailsCacheKey(path, false))
  fileDetailsCache.delete(getDetailsCacheKey(path, true))
}

export function useFileDetails(
  item: FileItem | DirectoryItem | undefined,
  workspaceDirectoryPath?: string,
  onFileUpdated?: () => void,
  currentDirectoryPath?: string
) {
  const [analysisResult, setAnalysisResult] = useState<any>(null)
  const [reanalyzing, setReanalyzing] = useState(false)
  const [queueStatus, setQueueStatus] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const lastSeenStatusRef = useRef<string | null>(null)
  const reanalyzeStartTimeRef = useRef<number>(0)
  const lastSeenUpdatedAtRef = useRef<number>(0)
  const seenTerminalDeltaKeysRef = useRef<Set<string>>(new Set())
  const requestSeqRef = useRef<number>(0)
  const analysisResultRef = useRef<any>(null)
  analysisResultRef.current = analysisResult

  // isDirectory 兼容两种对象：FileItem（有 isDirectory 字段）和虚拟目录树节点（有 isFile 字段）
  const isDirectory = item
    ? (item as any).isFile === true
      ? false
      : 'isDirectory' in item && item.isDirectory
    : !!workspaceDirectoryPath

  const refreshAnalysis = useCallback(
    async (options?: { bypassCache?: boolean }) => {
      // 优先使用 item.path，兼容虚拟目录树节点的 originalPath，如果是工作区目录视图（无 item）则使用 currentDirectoryPath，最后回退到 workspaceDirectoryPath
      const currentPath =
        item?.path || (item as any)?.originalPath || currentDirectoryPath || workspaceDirectoryPath
      if (!currentPath) return

      const seq = ++requestSeqRef.current
      const isDirFlag = Boolean(isDirectory)
      let cachedValue: any = undefined
      if (options?.bypassCache) {
        invalidateDetailsCache(currentPath)
      } else {
        cachedValue = readDetailsCache(currentPath, isDirFlag)
        if (cachedValue !== undefined) {
          setAnalysisResult(cachedValue)
        }
      }

      try {
        const res = isDirFlag
          ? await window.electronAPI!.getDirectoryAnalysisResult(currentPath)
          : await window.electronAPI!.getFileAnalysisResult(currentPath)
        if (seq !== requestSeqRef.current) return
        writeDetailsCache(currentPath, isDirFlag, res)
        // 缓存命中且后台静默刷新数据无变化时，跳过重复 setState，避免触发整面板二次重渲染
        if (cachedValue !== undefined && JSON.stringify(res) === JSON.stringify(cachedValue)) {
          return
        }
        setAnalysisResult(res)
      } catch (e) {
        if (seq === requestSeqRef.current) {
          logger.error(LogCategory.FILE_ANALYSIS, '刷新分析结果失败:', e)
        }
      }
    },
    [
      item?.path,
      (item as any)?.originalPath,
      currentDirectoryPath,
      workspaceDirectoryPath,
      isDirectory
    ]
  )

  // 切换文件或目录时：直接从内存 store 同步读取队列状态（零额外 IPC），并按 LRU 缓存 + 请求序号加载分析详情
  useEffect(() => {
    const targetPath =
      item?.path || (item as any)?.originalPath || currentDirectoryPath || workspaceDirectoryPath

    if (!targetPath) {
      setReanalyzing(false)
      setQueueStatus(null)
      lastSeenUpdatedAtRef.current = 0
      seenTerminalDeltaKeysRef.current.clear()
    } else {
      lastSeenUpdatedAtRef.current = 0
      seenTerminalDeltaKeysRef.current.clear()
      const { isPathEqual } = window.electronAPI!.utils || {
        isPathEqual: (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
      }
      const snapshot = useAnalysisQueueStore.getState().snapshot
      const queueItem = snapshot?.items?.find((i: any) => i.path && isPathEqual(i.path, targetPath))

      if (queueItem && (queueItem.status === 'pending' || queueItem.status === 'analyzing')) {
        setReanalyzing(true)
        setQueueStatus(queueItem.status)
        lastSeenStatusRef.current = queueItem.status
      } else {
        setReanalyzing(prev => (prev ? false : prev))
        setQueueStatus(prev => (prev !== null ? null : prev))
        lastSeenStatusRef.current = null
      }
    }

    refreshAnalysis()
  }, [
    item?.path,
    (item as any)?.originalPath,
    currentDirectoryPath,
    workspaceDirectoryPath,
    isDirectory,
    refreshAnalysis
  ])

  // 监听智能文件名更新事件和全局文件变更，失效缓存并自动刷新详情面板中的智能文件名与分析结果
  useEffect(() => {
    const handleRefresh = () => {
      invalidateDetailsCache()
      refreshAnalysis({ bypassCache: true })
    }
    window.addEventListener('smartname-updated', handleRefresh)
    window.addEventListener('files-updated', handleRefresh)
    return () => {
      window.removeEventListener('smartname-updated', handleRefresh)
      window.removeEventListener('files-updated', handleRefresh)
    }
  }, [refreshAnalysis])

  // 监听目录画像更新事件（由后端 saveContextAnalysis / clearDirectoryContext 广播）
  useEffect(() => {
    if (!window.electronAPI?.onDirectoryContextUpdated) return
    const cleanup = window.electronAPI.onDirectoryContextUpdated(data => {
      if (data?.directoryPath) {
        invalidateDetailsCache(data.directoryPath)
      }
      const targetPath =
        item?.path || (item as any)?.originalPath || currentDirectoryPath || workspaceDirectoryPath
      if (!targetPath) return
      const { isPathEqual } = window.electronAPI!.utils || {
        isPathEqual: (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
      }
      if (data?.directoryPath && isPathEqual(data.directoryPath, targetPath)) {
        refreshAnalysis({ bypassCache: true })
      }
    })
    return () => {
      cleanup()
    }
  }, [
    item?.path,
    (item as any)?.originalPath,
    currentDirectoryPath,
    workspaceDirectoryPath,
    refreshAnalysis
  ])

  // 监听单文件分析更新与异步返送打标落库（驱动右侧属性面板热刷新，无需切换文件）
  useEffect(() => {
    if (!window.electronAPI?.onFileAnalysisUpdated) return
    const cleanup = window.electronAPI.onFileAnalysisUpdated(payload => {
      if (payload?.filePath) {
        invalidateDetailsCache(payload.filePath)
      }
      const targetPath =
        item?.path || (item as any)?.originalPath || currentDirectoryPath || workspaceDirectoryPath
      if (!targetPath) return
      const { isPathEqual } = window.electronAPI!.utils || {
        isPathEqual: (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
      }
      const curResult = analysisResultRef.current
      const isTarget =
        (payload?.filePath && isPathEqual(payload.filePath, targetPath)) ||
        (payload?.fileFingerprint &&
          (curResult?.fingerprint === payload.fileFingerprint ||
            curResult?.fileFingerprint === payload.fileFingerprint))

      if (isTarget) {
        if (payload?.status === 'completed' || payload?.source === 'retag') {
          setReanalyzing(false)
          setQueueStatus(null)
        }
        refreshAnalysis({ bypassCache: true })
        if (onFileUpdated) {
          onFileUpdated()
        }
      }
    })
    return () => {
      cleanup()
    }
  }, [
    item?.path,
    (item as any)?.originalPath,
    currentDirectoryPath,
    workspaceDirectoryPath,
    refreshAnalysis,
    onFileUpdated
  ])

  // 监听分析队列更新（支持单文件与目录画像队列项，接入双轨 terminalDeltas）
  useEffect(() => {
    const targetPath =
      item?.path || (item as any)?.originalPath || currentDirectoryPath || workspaceDirectoryPath
    if (!targetPath) return

    let cancelled = false
    const pendingTimers = new Set<ReturnType<typeof setTimeout>>()

    const scheduleTerminalRefresh = (bypassCache: boolean) => {
      const timer = setTimeout(() => {
        pendingTimers.delete(timer)
        if (cancelled) return
        refreshAnalysis(bypassCache ? { bypassCache: true } : undefined)
        if (onFileUpdated) {
          onFileUpdated()
        }
      }, 200)
      pendingTimers.add(timer)
    }

    const cleanup = window.electronAPI!.onAnalysisQueueUpdated((rawPayload: any) => {
      const { isPathEqual } = window.electronAPI!.utils || {
        isPathEqual: (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
      }
      const isDualTrack = Boolean(
        rawPayload &&
        typeof rawPayload === 'object' &&
        'snapshot' in rawPayload &&
        rawPayload.snapshot
      )
      const snapshot = isDualTrack ? rawPayload.snapshot : rawPayload
      const terminalDeltas: any[] =
        isDualTrack && Array.isArray(rawPayload.terminalDeltas) ? rawPayload.terminalDeltas : []

      let terminalDeltaHit = false
      for (const delta of terminalDeltas) {
        if (!delta?.path || !isPathEqual(delta.path, targetPath)) continue
        const dedupeKey = `${delta.id}:${delta.status}:${delta.updatedAt}`
        if (seenTerminalDeltaKeysRef.current.has(dedupeKey)) continue
        seenTerminalDeltaKeysRef.current.add(dedupeKey)
        terminalDeltaHit = true

        lastSeenStatusRef.current = delta.status
        lastSeenUpdatedAtRef.current = delta.updatedAt || Date.now()

        if (delta.status === 'completed') {
          if (Date.now() - (delta.updatedAt || 0) < 5000) {
            toast.success(isDirectory ? t('目录画像分析完成') : t('分析完成'))
          }
        } else if (delta.status === 'failed') {
          toast.error(t('分析失败: {}', [delta.error]) || t('未知错误'))
        }

        setReanalyzing(false)
        setQueueStatus(null)
        scheduleTerminalRefresh(true)
      }

      // B1 / V-03：terminalDeltas 命中并触发 200ms 刷新后，必须跳过下方兜底清空分支，杜绝同一终态双刷
      if (terminalDeltaHit) {
        return
      }

      const queueItem = snapshot?.items?.find((i: any) => i.path && isPathEqual(i.path, targetPath))

      if (queueItem) {
        const isStatusChange = lastSeenStatusRef.current !== queueItem.status
        const isNewTimestamp =
          queueItem.updatedAt && queueItem.updatedAt > lastSeenUpdatedAtRef.current

        if (
          !isDualTrack &&
          (queueItem.status === 'completed' || queueItem.status === 'failed') &&
          (isStatusChange || isNewTimestamp)
        ) {
          lastSeenStatusRef.current = queueItem.status
          lastSeenUpdatedAtRef.current = queueItem.updatedAt || Date.now()

          if (queueItem.status === 'completed') {
            if (Date.now() - queueItem.updatedAt < 5000) {
              toast.success(isDirectory ? t('目录画像分析完成') : t('分析完成'))
            }
          } else {
            toast.error(t('分析失败: {}', [queueItem.error]) || t('未知错误'))
          }

          setReanalyzing(false)
          setQueueStatus(null)
          scheduleTerminalRefresh(false)
        } else if (queueItem.status === 'analyzing' || queueItem.status === 'pending') {
          setReanalyzing(true)
          setQueueStatus(queueItem.status)
          lastSeenStatusRef.current = queueItem.status
          lastSeenUpdatedAtRef.current = queueItem.updatedAt || Date.now()
        }
      } else if (lastSeenStatusRef.current) {
        setReanalyzing(false)
        setQueueStatus(null)
        lastSeenStatusRef.current = null
        refreshAnalysis()
        if (onFileUpdated) {
          onFileUpdated()
        }
      }
    })

    return () => {
      cancelled = true
      for (const timer of pendingTimers) {
        clearTimeout(timer)
      }
      pendingTimers.clear()
      cleanup()
    }
  }, [
    item?.path,
    (item as any)?.originalPath,
    currentDirectoryPath,
    workspaceDirectoryPath,
    isDirectory,
    onFileUpdated,
    refreshAnalysis
  ])

  const handleReanalyze = async () => {
    if (!item || isDirectory) return
    try {
      lastSeenStatusRef.current = 'pending'
      reanalyzeStartTimeRef.current = Date.now()
      setReanalyzing(true)
      setQueueStatus('pending')
      await window.electronAPI!.addToAnalysisQueue(
        [
          {
            path: item.path,
            name: item.name,
            size: (item as FileItem).size || 0,
            type: (item as FileItem).extension || 'file'
          }
        ],
        true
      )
      await window.electronAPI!.startAnalysis()
      toast.success(t('文件已加入分析队列，正在分析...'))
    } catch (error: any) {
      setReanalyzing(false)
      setQueueStatus(null)
      lastSeenStatusRef.current = null
      let errorMsg = error?.message || t('未知错误')
      const match = errorMsg.match(/Error invoking remote method '[^']+':\s*(.*)/)
      if (match && match[1]) errorMsg = match[1]
      if (errorMsg.includes('配额')) toast.error(errorMsg)
      else {
        logger.error(LogCategory.FILE_ANALYSIS, '重新分析失败:', error)
        toast.error(t('分析失败，请重试'))
      }
    }
  }

  // 批量分析子文件
  const handleBatchAnalyzeSubfiles = async () => {
    let targetPath = ''
    if (item && 'path' in item) {
      targetPath = item.path
    } else if (!item && workspaceDirectoryPath) {
      targetPath = workspaceDirectoryPath
    }

    if (!targetPath) return

    try {
      const { addItems, start } = useAnalysisQueueStore.getState()

      // 将目录本身作为 folder 类型加入队列，由后端 processDirectory 进行单元识别和展开
      const dirName = item?.name || targetPath.split(/[/\\]/).pop() || ''
      const allToAdd = [{ path: targetPath, name: dirName, size: 0, type: 'folder' as const }]

      if (allToAdd.length > 0) {
        await addItems(allToAdd)
        await start()
        toast.success(t('已将 {count} 个项目加入分析队列', { count: 1 }))
      } else {
        toast.info(t('该目录下没有可分析的内容'))
      }
    } catch (error: any) {
      logger.error(LogCategory.RENDERER, '批量分析子文件失败:', error)
      const msg = error instanceof Error ? error.message : String(error)
      toast.error(
        t('批量分析失败: {error}', {
          error: msg.replace(/^Error invoking remote method.*?: Error: /, '')
        })
      )
    }
  }

  // 清空文件分析结果
  const handleClearAnalysis = async () => {
    if (!item || isDirectory || !analysisResult || !('smartName' in analysisResult)) {
      logger.warn(LogCategory.FILE_ANALYSIS, '清空分析失败：无效的文件或分析结果')
      return
    }

    try {
      setDeleting(true)

      const result = await (window.electronAPI! as any).resetFileAnalysis(analysisResult.path)

      if (result && result.success) {
        toast.success(t('已清空分析'))

        refreshAnalysis({ bypassCache: true })

        if (onFileUpdated) {
          onFileUpdated()
        }
      } else {
        const errorMsg = result?.error || t('服务器响应失败')
        logger.error(LogCategory.FILE_ANALYSIS, '清空分析失败:', errorMsg)
        toast.error(t('清空分析失败: {error}', { error: errorMsg }))
      }
    } catch (error: any) {
      logger.error(LogCategory.FILE_ANALYSIS, '清空分析失败:', error)
      toast.error(t('清空分析失败: {error}', { error: error.message || t('未知错误') }))
    } finally {
      setDeleting(false)
    }
  }

  // 处理目录重新分析
  const handleDirectoryReanalyze = async () => {
    let targetPath = (item as any)?.path

    if (!targetPath && analysisResult && 'fileCount' in analysisResult) {
      targetPath = analysisResult.path
    }

    if (!targetPath && !item) {
      try {
        const currentDir = await window.electronAPI!.getCurrentWorkspaceDirectory()

        if (currentDir) {
          targetPath = currentDir.path
        }
      } catch (e) {
        logger.error(LogCategory.FILE_ANALYSIS, '获取当前工作目录失败:', e)
      }
    }

    if (!targetPath) {
      logger.error(LogCategory.FILE_ANALYSIS, '无法获取目录路径')
      toast.error(t('无法获取目录路径，请刷新后重试'))
      return
    }

    try {
      setReanalyzing(true)

      await window.electronAPI!.analyzeDirectoryContext(targetPath, true)

      toast.success(t('目录重新分析完成'))

      const dirResult = await window.electronAPI!.getDirectoryAnalysisResult(targetPath)
      setAnalysisResult(dirResult as any)

      if (onFileUpdated) {
        onFileUpdated()
      }
    } catch (error: any) {
      let errorMsg = error?.message || t('未知错误')
      const match = errorMsg.match(/Error invoking remote method '[^']+':\s*(.*)/)
      if (match && match[1]) errorMsg = match[1]
      if (errorMsg.includes('配额')) {
        toast.error(errorMsg)
      } else {
        logger.error(LogCategory.FILE_ANALYSIS, '目录重新分析失败:', error)
        toast.error(t('分析失败，请重试'))
      }
    } finally {
      setReanalyzing(false)
    }
  }

  // 处理目录清空分析
  const handleDirectoryClearAnalysis = async () => {
    if (!analysisResult || !('fileCount' in analysisResult)) {
      logger.warn(LogCategory.FILE_ANALYSIS, '清空目录分析失败：无效的目录或分析结果')
      return
    }

    try {
      setDeleting(true)

      await window.electronAPI!.clearDirectoryContext(analysisResult.path)

      toast.success(t('已清空目录分析'))

      const dirResult = await window.electronAPI!.getDirectoryAnalysisResult(analysisResult.path)
      setAnalysisResult(dirResult as any)

      if (onFileUpdated) {
        onFileUpdated()
      }
    } catch (error: any) {
      logger.error(LogCategory.FILE_ANALYSIS, '清空目录分析失败:', error)
      toast.error(t('清空目录分析失败: {error}', { error: error.message || t('未知错误') }))
    } finally {
      setDeleting(false)
    }
  }

  return {
    analysisResult,
    reanalyzing,
    queueStatus,
    deleting,
    isDirectory,
    handleReanalyze,
    handleBatchAnalyzeSubfiles,
    handleDirectoryReanalyze,
    handleClearAnalysis,
    handleDirectoryClearAnalysis,
    refreshAnalysis
  }
}
