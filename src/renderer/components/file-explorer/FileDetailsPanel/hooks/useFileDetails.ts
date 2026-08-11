import { DirectoryItem, FileItem } from '@firefly/types'
import { LogCategory, logger } from '@firefly/shared'
import { useCallback, useEffect, useRef, useState } from 'react'

import { t } from '@app/languages'
import { toast } from '../../../common/Toast'
import { useAnalysisQueueStore } from '../../../../stores/analysis-queue-store'

export function useFileDetails(
  item: FileItem | DirectoryItem | undefined,
  workspaceDirectoryPath?: string,
  onFileUpdated?: () => void,
  currentDirectoryPath?: string
) {
  const [analysisResult, setAnalysisResult] = useState<any>(null)
  const [reanalyzing, setReanalyzing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const lastSeenStatusRef = useRef<string | null>(null)
  const reanalyzeStartTimeRef = useRef<number>(0)

  // isDirectory 兼容两种对象：FileItem（有 isDirectory 字段）和虚拟目录树节点（有 isFile 字段）
  const isDirectory = item
    ? (item as any).isFile === true
      ? false
      : 'isDirectory' in item && item.isDirectory
    : !!workspaceDirectoryPath

  const refreshAnalysis = useCallback(async () => {
    // 优先使用 item.path，兼容虚拟目录树节点的 originalPath，如果是工作区目录视图（无 item）则使用 currentDirectoryPath，最后回退到 workspaceDirectoryPath
    const currentPath =
      item?.path || (item as any)?.originalPath || currentDirectoryPath || workspaceDirectoryPath
    if (!currentPath) return
    try {
      const res = isDirectory
        ? await window.electronAPI!.getDirectoryAnalysisResult(currentPath)
        : await window.electronAPI!.getFileAnalysisResult(currentPath)
      setAnalysisResult(res)
    } catch (e) {
      logger.error(LogCategory.FILE_ANALYSIS, '刷新分析结果失败:', e)
    }
  }, [
    item?.path,
    (item as any)?.originalPath,
    currentDirectoryPath,
    workspaceDirectoryPath,
    isDirectory
  ])

  // 切换文件时重置分析状态并加载数据
  useEffect(() => {
    const checkInitialQueueStatus = async () => {
      if (!item) {
        setReanalyzing(false)
        return
      }

      try {
        const { isPathEqual } = window.electronAPI!.utils
        const itemPath = item.path || (item as any).originalPath
        const snapshot = await window.electronAPI!.getAnalysisQueue()
        const queueItem = snapshot.items.find(
          (i: any) => i.path && itemPath && isPathEqual(i.path, itemPath)
        )

        if (queueItem && (queueItem.status === 'pending' || queueItem.status === 'analyzing')) {
          setReanalyzing(true)
          lastSeenStatusRef.current = queueItem.status
        } else {
          setReanalyzing(false)
        }
      } catch (e) {
        logger.error(LogCategory.FILE_ANALYSIS, '检查初始分析队列状态失败:', e)
        setReanalyzing(false)
      }
    }

    checkInitialQueueStatus()
    if (item) {
      refreshAnalysis()
    } else {
      const targetPath = currentDirectoryPath || workspaceDirectoryPath
      if (targetPath) {
        window.electronAPI!.getDirectoryAnalysisResult(targetPath).then((res: any) => {
          setAnalysisResult(res)
        })
      }
    }
  }, [
    item?.path,
    (item as any)?.originalPath,
    currentDirectoryPath,
    workspaceDirectoryPath,
    isDirectory,
    refreshAnalysis
  ])

  // 监听分析队列更新
  useEffect(() => {
    if (!item) return

    const cleanup = window.electronAPI!.onAnalysisQueueUpdated((snapshot: any) => {
      const { isPathEqual } = window.electronAPI!.utils
      const itemPath = item.path || (item as any).originalPath
      const queueItem = snapshot.items.find(
        (i: any) => i.path && itemPath && isPathEqual(i.path, itemPath)
      )

      if (queueItem) {
        if (
          (queueItem.status === 'completed' || queueItem.status === 'failed') &&
          lastSeenStatusRef.current !== queueItem.status
        ) {
          lastSeenStatusRef.current = queueItem.status

          if (queueItem.status === 'completed') {
            if (Date.now() - queueItem.updatedAt < 5000) {
              toast.success(t('分析完成'))
            }
          } else {
            toast.error(t('分析失败: {}', [queueItem.error]) || t('未知错误'))
          }

          setReanalyzing(false)

          setTimeout(() => {
            refreshAnalysis()
            if (onFileUpdated) {
              onFileUpdated()
            }
          }, 200)
        } else if (queueItem.status === 'analyzing' || queueItem.status === 'pending') {
          setReanalyzing(true)
          lastSeenStatusRef.current = queueItem.status
        }
      } else if (lastSeenStatusRef.current) {
        const now = Date.now()
        if (now - reanalyzeStartTimeRef.current > 2000) {
          setReanalyzing(false)
          lastSeenStatusRef.current = null
          refreshAnalysis()
        }
      }
    })

    return () => {
      cleanup()
    }
  }, [item, onFileUpdated, refreshAnalysis])

  const handleReanalyze = async () => {
    if (!item || isDirectory) return
    try {
      lastSeenStatusRef.current = 'pending'
      reanalyzeStartTimeRef.current = Date.now()
      setReanalyzing(true)
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

        refreshAnalysis()

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
