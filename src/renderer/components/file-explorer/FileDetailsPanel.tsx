import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '../ui/alert-dialog'
import { DirectoryItem, FileItem, getQualityScoreStars } from '@yonuc/types'
import { LogCategory, logger, formatFileSize, formatDuration, FileCategory, isCategory } from '@yonuc/shared'
import { MaterialIcon, cn } from '../../lib/utils'
import React, { useEffect, useRef, useState } from 'react'

import { Button } from '../ui/button'
import { ProgressBar } from '../ui/ProgressBar'
import { t } from '@app/languages'
import { toast } from '../common/Toast'
import { PersistentTooltip } from '../common/PersistentTooltip'

interface FileDetailsPanelProps {
  item?: FileItem | DirectoryItem

  onClose?: () => void

  onFileDeleted?: () => void // 删除文件后的回调

  onFileUpdated?: () => void // 文件更新后的回调

  workspaceDirectoryPath?: string // 工作目录路径，用于生成缩略图URL

  workspaceDirectoryType?: 'SPEEDY' | 'PRIVATE' // 工作目录类型
}

interface FileAnalysisResult {
  id: string

  path: string

  name: string

  smartName?: string

  size: number

  type: string

  mimeType: string

  createdAt: string

  modifiedAt: string

  accessedAt?: string

  description?: string

  content?: string

  multimodalContent?: string

  lrc?: string

  qualityScore?: number

  qualityConfidence?: number

  qualityReasoning?: string

  qualityCriteria?: {
    technical: number

    aesthetic: number

    content: number

    completeness: number

    timeliness: number
  }

  author?: string

  language?: string

  isAnalyzed: boolean

  lastAnalyzedAt?: string

  isHit?: boolean

  lastHitAt?: string

  dimensionTags: Array<{
    dimension: string

    level: number

    tags: Array<{
      name: string

      confidence: number

      isAiGenerated: boolean

      source: string
    }>
  }>

  contentTags: string[]

  groupingReason?: string // 分组/分类理由

  groupingConfidence?: number // 分组/分类置信度

  metadata?: Record<string, any> // 文件元数据

  analysisStats?: {
    durationMs: number
    phases?: Record<string, number>
    model?: { id?: string; name?: string; provider?: string }
    hardware?: { gpu?: string; vram?: number; platform?: string }
  }
}

interface DirectoryAnalysisResult {
  id: string

  path: string

  name: string

  contextAnalysis?: {
    directoryPath: string

    directoryType?: string

    fileTypeDistribution: Record<string, number>

    namingPatterns?: string[]

    languageDetected?: string[]

    specialFiles?: string[]

    recommendedDimensions?: string[]

    recommendedTags?: Record<string, string[]>

    analysisStrategy?: string

    namingPattern?: string

    confidence: number

    analyzedAt: Date | string
  }

  lastScanAt?: string

  createdAt: string

  updatedAt: string

  fileCount: number

  analyzedFileCount: number

  isAnalyzed: boolean
}

/**

 * 可折叠文本组件 - 显示指定行数，超过可展开/收起

 */

const CollapsibleText: React.FC<{
  text: string

  maxLines?: number

  className?: string
}> = ({ text, maxLines = 4, className = '' }) => {
  const [isExpanded, setIsExpanded] = useState(false)

  const textRef = useRef<HTMLParagraphElement>(null)

  const [needsCollapse, setNeedsCollapse] = useState(false)

  useEffect(() => {
    if (textRef.current) {
      const lineHeight = parseInt(window.getComputedStyle(textRef.current).lineHeight)

      const height = textRef.current.scrollHeight

      const lines = Math.round(height / lineHeight)

      setNeedsCollapse(lines > maxLines)
    }
  }, [text, maxLines])

  return (
    <div>
      <p
        ref={textRef}
        className={cn(
          'text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap',
          !isExpanded && needsCollapse && `line-clamp-${maxLines}`,
          className
        )}

        style={
          !isExpanded && needsCollapse
            ? {
                display: '-webkit-box',

                WebkitLineClamp: maxLines,

                WebkitBoxOrient: 'vertical',

                overflow: 'hidden'
              }
            : {}
        }
      >
        {text}
      </p>

      {needsCollapse && (
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="text-xs text-primary hover:text-primary/80 underline hover:no-underline mt-1 transition-colors"
        >
          {isExpanded ? t('收起') : t('展开')}
        </button>
      )}
    </div>
  )
}

export const FileDetailsPanel: React.FC<FileDetailsPanelProps> = ({
  item,

  onClose,

  onFileDeleted,

  onFileUpdated,

  workspaceDirectoryPath,

  workspaceDirectoryType
}) => {
  const [units, setUnits] = useState<any[]>([])
  const [analysisResult, setAnalysisResult] = useState<
    FileAnalysisResult | DirectoryAnalysisResult | null
  >(null)

  const [loading, setLoading] = useState(false)

  const [deleting, setDeleting] = useState(false)

  const [reanalyzing, setReanalyzing] = useState(false)

  const maskClass = workspaceDirectoryType === 'PRIVATE' ? 'ph-mask' : ''

  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const lastSeenStatusRef = useRef<string | null>(null)
  const reanalyzeStartTimeRef = useRef<number>(0)

  const isDirectory = item ? 'isDirectory' in item && item.isDirectory : false

  const showDirectory = !item // 没有选中任何项时显示目录信息

  // 检查文件是否是图片类型

  const isImageFile = (extension?: string) => {
    if (!extension) return false

    return isCategory(extension, FileCategory.IMAGE)
  }

  // 生成缩略图URL

  const getThumbnailUrl = () => {
    // 确保 item 存在且不是目录

    if (!item || isDirectory) {
      return null
    }

    // 类型检查，确保 item 是 FileItem 并且有 thumbnailPath 属性
    // 优先从 analysisResult 中获取，如果不存在再从 item 中获取
    const thumbPathRaw = (analysisResult as any)?.thumbnailPath || ('thumbnailPath' in item ? item.thumbnailPath : undefined)

    if (!thumbPathRaw) {
      return null
    }

    // 获取缩略图路径

    const thumbnailPath = thumbPathRaw as string

    // 获取工作目录路径 - 优先使用传入的 props，然后是 item 中的，最后是全局的

    let finalWorkspaceDirectoryPath = workspaceDirectoryPath || ''

    // 尝试从 item 中获取工作目录路径

    if (
      !finalWorkspaceDirectoryPath &&
      'workspaceDirectoryPath' in item &&
      item.workspaceDirectoryPath
    ) {
      finalWorkspaceDirectoryPath = item.workspaceDirectoryPath as string
    }

    // 如果仍然没有工作目录路径，返回 null

    if (!finalWorkspaceDirectoryPath) {
      return null
    }

    // 构建缩略图完整路径
    const { normalizeForCache } = window.electronAPI.utils

    const normalizedDirPath = normalizeForCache(finalWorkspaceDirectoryPath)

    const normalizedThumbPath = normalizeForCache(thumbnailPath)

    // 使用分析时间作为缓存刷新 key
    const refreshKey = (analysisResult as any)?.lastAnalyzedAt ? new Date((analysisResult as any).lastAnalyzedAt).getTime() : Date.now()

    return `file://${normalizedDirPath}/${normalizedThumbPath}?t=${refreshKey}`
  }

  // 生成原始图片URL - 如果没有缩略图，但文件本身是图片，则直接显示

  const getOriginalImageUrl = () => {
    if (!item || isDirectory || !('extension' in item) || !isImageFile(item.extension)) {
      return null
    }

    // 假设 item.path 是绝对路径
    const { normalizeForCache } = window.electronAPI.utils

    const normalizedPath = normalizeForCache(item.path)

    return `file://${normalizedPath}`
  }

  // 刷新分析结果

  const refreshAnalysis = async () => {
    if (!item) return

    try {
      if (isDirectory) {
        const dirResult = await window.electronAPI!.getDirectoryAnalysisResult(item.path)

        setAnalysisResult(dirResult as any)
      } else {
        const fileResult = await window.electronAPI!.getFileAnalysisResult(item.path)

        setAnalysisResult(fileResult as any)
      }
    } catch (e) {
      logger.error(LogCategory.FILE_ANALYSIS, '刷新分析结果失败:', e)
    }
  }

  // 切换文件时重置分析状态并加载数据
  useEffect(() => {
    const checkInitialQueueStatus = async () => {
      if (!item) {
        setReanalyzing(false)
        return
      }

      try {
        // 检查当前项（文件或目录）是否已经在分析队列中
        const snapshot = await window.electronAPI!.getAnalysisQueue()
        const queueItem = snapshot.items.find((i: any) => i.path === item.path)
        
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
    } else if (showDirectory && workspaceDirectoryPath) {
      // 如果没有选中文件,尝试加载当前目录的汇总信息
      window.electronAPI!.getDirectoryAnalysisResult(workspaceDirectoryPath).then((res: any) => {
        setAnalysisResult(res as any)
      })
    }
  }, [item?.path, showDirectory, workspaceDirectoryPath, isDirectory])

  // 监听分析队列更新

  useEffect(() => {
    // 如果没有选中项，则不监听
    if (!item) return

    const cleanup = window.electronAPI!.onAnalysisQueueUpdated((snapshot: any) => {
      // 查找当前项在队列中的状态
      const queueItem = snapshot.items.find((i: any) => i.path === item.path)

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

          // 刷新分析结果显示
          setTimeout(() => {
            refreshAnalysis()
            if (onFileUpdated) {
              onFileUpdated()
            }
          }, 200)
        } else if (queueItem.status === 'analyzing' || queueItem.status === 'pending') {
          // 确保在分析中时状态为 true
          setReanalyzing(true)
          lastSeenStatusRef.current = queueItem.status
        }
      } else if (reanalyzing) {
        // 如果文件从队列中消失了，且我们处于 reanalyzing 状态
        // 只有当距离重分析开始已经过去一段时间（例如 2 秒），我们才认为它真的完成了
        // 否则可能是由于异步延迟，项还没有出现在队列快照中
        const now = Date.now()
        if (now - reanalyzeStartTimeRef.current > 2000) {
          setReanalyzing(false)
          refreshAnalysis()
        }
      }
    })

    return () => {
      cleanup()
    }
  }, [item, onFileUpdated, reanalyzing])

  // 处理重新分析

  const handleReanalyze = async () => {
    if (!item || isDirectory) {
      return
    }

    try {
      // 重置状态记忆，以便能够接收新的"完成"事件

      lastSeenStatusRef.current = 'pending'
      reanalyzeStartTimeRef.current = Date.now()
      setReanalyzing(true)

      // 将文件添加到分析队列（强制重新分析）

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
      ) // true 表示强制重新分析

      // 启动分析

      await window.electronAPI!.startAnalysis()

      toast.success(t('文件已加入分析队列，正在分析...'))
    } catch (error: any) {
      // 提取实际错误消息，去掉 IPC 调用前缀
      let errorMsg = error?.message || t('未知错误')
      const match = errorMsg.match(/Error invoking remote method '[^']+':\s*(.*)/)
      if (match && match[1]) {
        errorMsg = match[1]
      }
      if (errorMsg.includes('配额')) {
        toast.error(errorMsg)
      } else {
        logger.error(LogCategory.FILE_ANALYSIS, '重新分析失败:', error)
        toast.error(t('分析失败，请重试'))
      }
      // 只有在出错且没有成功加入队列时才重置状态
      setReanalyzing(false)
    }
    // 成功加入队列后不立即 setReanalyzing(false)，等待队列监听器更新状态
  }

  // 处理清空分析

  const handleClearAnalysis = async () => {
    // 先关闭对话框，确保用户看到反馈
    setShowDeleteDialog(false)

    if (!item || isDirectory || !analysisResult || !isFileAnalysis(analysisResult)) {
      logger.warn(LogCategory.FILE_ANALYSIS, '清空分析失败：无效的文件或分析结果')
      return
    }

    try {
      setDeleting(true)

      const result = await (window.electronAPI as any).resetFileAnalysis(analysisResult.path)

      if (result && result.success) {
        toast.success(t('已清空分析'))

        // 刷新当前项
        refreshAnalysis()

        // 触发父组件刷新
        if (onFileUpdated) {
          onFileUpdated()
        }
      } else {
        const errorMsg = result?.error || t('服务器响应失败')
        logger.error(LogCategory.FILE_ANALYSIS, '清空分析失败:', errorMsg)
        toast.error(t('清空分析失败: {error}', { error: errorMsg }))
      }
    } catch (error: any) {
      console.error('清空分析失败:', error)
      toast.error(t('清空分析失败: {error}', { error: error.message || t('未知错误') }))
    } finally {
      setDeleting(false)
    }
  }

  // 处理目录重新分析

  const handleDirectoryReanalyze = async () => {
    let targetPath = item?.path

    // 如果没有 item.path (可能是当前工作目录)，尝试从 analysisResult 获取

    if (!targetPath && analysisResult && isDirAnalysis(analysisResult)) {
      targetPath = analysisResult.path
    }

    // 如果还是没有 (可能是未分析的当前工作目录)，尝试获取当前工作目录

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

      // 调用目录上下文分析
      await window.electronAPI!.analyzeDirectoryContext(targetPath, true)

      toast.success(t('目录重新分析完成'))

      // 重新加载分析结果

      const dirResult = await window.electronAPI!.getDirectoryAnalysisResult(targetPath)

      setAnalysisResult(dirResult as any)
    } catch (error: any) {
      // 提取实际错误消息，去掉 IPC 调用前缀
      let errorMsg = error?.message || t('未知错误')
      const match = errorMsg.match(/Error invoking remote method '[^']+':\s*(.*)/)
      if (match && match[1]) {
        errorMsg = match[1]
      }
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
    // 先关闭对话框，确保用户看到反馈
    setShowDeleteDialog(false)

    if (!analysisResult || !isDirAnalysis(analysisResult)) {
      logger.warn(LogCategory.FILE_ANALYSIS, '清空目录分析失败：无效的目录或分析结果')
      return
    }

    try {
      setDeleting(true)

      // 清空目录的上下文分析
      await window.electronAPI!.clearDirectoryContext(analysisResult.path)

      toast.success(t('已清空目录分析'))

      // 重新加载分析结果
      const dirResult = await window.electronAPI!.getDirectoryAnalysisResult(analysisResult.path)

      setAnalysisResult(dirResult as any)
    } catch (error: any) {
      logger.error(LogCategory.FILE_ANALYSIS, '清空目录分析失败:', error)
      toast.error(t('清空目录分析失败: {error}', { error: error.message || t('未知错误') }))
    } finally {
      setDeleting(false)
    }
  }

  // 生成虚拟路径

  const generateVirtualPath = (analysisResult: FileAnalysisResult): string => {
    if (!analysisResult) return ''

    const parts: string[] = []

    // 从维度标签中提取路径部分（优先顺序：文件类型 -> 文件用途）

    const dimensionOrder = [t('文件类型'), t('文件用途')]

    for (const dimName of dimensionOrder) {
      // 文件类型 文件用途

      const dimGroup = analysisResult.dimensionTags.find(d => d.dimension === dimName)

      if (dimGroup && dimGroup.tags.length > 0) {
        // 取第一个标签

        parts.push(dimGroup.tags[0].name)
      }
    }

    // 添加虚拟名（如果有）

    const smartName = analysisResult.smartName || analysisResult.name

    parts.push(smartName)

    return window.electronAPI?.utils?.normalizePath(parts.join('/')) || parts.join('/')
  }

  // 为内容标签生成颜色

  const getTagColor = (index: number) => {
    const colors = [
      // bg-primary/10 text-primary

      'bg-primary/10 text-primary',

      'bg-green-500/10 text-green-600 dark:text-green-500',

      'bg-yellow-500/10 text-yellow-600 dark:text-yellow-500',

      'bg-purple-500/10 text-purple-600 dark:text-purple-500',

      'bg-pink-500/10 text-pink-600 dark:text-pink-500',

      'bg-indigo-500/10 text-indigo-600 dark:text-indigo-500',

      'bg-red-500/10 text-red-600 dark:text-red-600',

      'bg-orange-500/10 text-orange-600 dark:text-orange-500',

      'bg-teal-500/10 text-teal-600 dark:text-teal-500',

      'bg-cyan-500/10 text-cyan-600 dark:text-cyan-500'
    ]

    return colors[index % colors.length]
  }

  useEffect(() => {
    const loadData = async () => {
      if (!item) {
        // 加载当前目录信息

        try {
          setLoading(true)

          const currentDir = await window.electronAPI!.getCurrentWorkspaceDirectory()

          if (currentDir) {
            const dirResult = await window.electronAPI!.getDirectoryAnalysisResult(currentDir.path)

            setAnalysisResult(dirResult as any)
          }
        } catch (e) {
          // 加载目录信息失败:" + (e as Error).message

          logger.error(LogCategory.FILE_ANALYSIS, '加载目录信息失败:', e)
        } finally {
          setLoading(false)
        }

        return
      }

      // 加载单元信息

      try {
        const res = await window.electronAPI!.getUnitsForPath(item.path)

        setUnits(res || [])
      } catch (e) {
        // 加载单元信息失败:" + (e as Error).message

        setUnits([])
      }

      // 加载AI分析结果

      try {
        setLoading(true)

        if (isDirectory) {
          const dirResult = await window.electronAPI!.getDirectoryAnalysisResult(item.path)

          setAnalysisResult(dirResult as any)
        } else {
          const fileResult = await window.electronAPI!.getFileAnalysisResult(item.path)

          setAnalysisResult(fileResult as any)
        }
      } catch (e) {
        // 加载AI分析结果失败:" + (e as Error).message

        logger.error(LogCategory.FILE_ANALYSIS, '加载AI分析结果失败:', e)

        setAnalysisResult(null)
      } finally {
        setLoading(false)
      }
    }

    loadData()
  }, [item, isDirectory])

  const isFileAnalysis = (result: any): result is FileAnalysisResult => {
    return result && 'smartName' in result
  }

  const isDirAnalysis = (result: any): result is DirectoryAnalysisResult => {
    return result && 'fileCount' in result
  }

  const formatDate = (dateString: string | Date) => {
    return new Date(dateString).toLocaleString()
  }

  return (
    <aside className="w-96 flex-shrink-0 bg-card border-l border-border flex flex-col h-full overflow-hidden">
      <div className="flex-1 overflow-y-auto p-6 pb-4">
        {/* 文件/目录图标和名称 */}
        <div className="text-center mb-6">
          {(() => {
            const displayUrl = getThumbnailUrl() || getOriginalImageUrl()
            if (displayUrl) {
              // 如果有缩略图或原始图片URL，显示预览
              return (
                <>
                  <div className="relative w-full aspect-video bg-muted rounded-lg overflow-hidden border border-border shadow-sm flex items-center justify-center group">
                    <img
                      src={displayUrl}
                      alt={item?.name}
                      className="w-full h-full object-contain"
                      onError={e => {
                        // 缩略图加载失败，显示默认图标
                        const target = e.target as HTMLImageElement
                        const parent = target.parentElement
                        if (parent) {
                          // 隐藏坏掉的图片
                          target.style.display = 'none'
                          // 检查是否已经添加了图标
                          if (!parent.querySelector('.fallback-icon')) {
                            const iconContainer = document.createElement('div')
                            iconContainer.className =
                              'fallback-icon w-full h-full flex items-center justify-center'
                            const icon = document.createElement('span')
                            icon.className = 'material-icons text-6xl text-primary'
                            icon.textContent = showDirectory || isDirectory ? 'folder' : 'description'
                            iconContainer.appendChild(icon)
                          }
                        }
                      }}
                    />
                  </div>
                  {/* 云端缓存标记/耗时统计 - 移至预览图下方 */}
                  {analysisResult && isFileAnalysis(analysisResult) && (analysisResult.isHit || analysisResult.analysisStats) && (
                    <div className="mt-3 flex justify-center animate-in fade-in slide-in-from-top-1 duration-500">
                      <div className="inline-flex items-center gap-1.5 bg-primary/10 text-primary px-3 py-1 rounded-full text-[10px] font-bold border border-primary/20 shadow-sm">
                        {analysisResult.isHit ? (
                          <>
                            <MaterialIcon icon="cloud_done" className="text-xs" />
                            {t('来自云端缓存')}
                          </>
                        ) : analysisResult.analysisStats ? (
                          <>
                            <MaterialIcon icon="timer" className="text-xs" />
                            <span>
                              {t('分析耗时')}: {formatDuration(analysisResult.analysisStats.durationMs)} {analysisResult.analysisStats.model?.name && (
                                <span className="opacity-80 mr-1">{analysisResult.analysisStats.model.name} </span>
                              )}
                            </span>
                          </>
                        ) : null}
                      </div>
                    </div>
                  )}
                </>
              )
            } else {
              // 没有任何预览，显示默认图标
              return (
                <div className="relative">
                  <MaterialIcon
                    icon={showDirectory || isDirectory ? 'folder' : 'description'}
                    className="text-6xl text-primary mx-auto"
                  />
                  {/* 云端缓存标记/耗时统计 - 只有图标模式时显示在下方 */}
                  {analysisResult && isFileAnalysis(analysisResult) && (analysisResult.isHit || analysisResult.analysisStats) && (
                    <div className="mt-2 flex justify-center">
                      <div className="inline-flex items-center gap-1 bg-primary/10 text-primary px-2 py-0.5 rounded-full text-[10px] font-bold border border-primary/20">
                        {analysisResult.isHit ? (
                          <>
                            <MaterialIcon icon="cloud_done" className="text-xs" />
                            {t('来自云端缓存')}
                          </>
                        ) : analysisResult.analysisStats ? (
                          <>
                            <MaterialIcon icon="timer" className="text-xs" />
                            <>
                              {t('总耗时 {}', [formatDuration(analysisResult.analysisStats.durationMs)])} {analysisResult.analysisStats.model?.name && (
                                <span className="opacity-80 mr-1">{analysisResult.analysisStats.model.name} </span>
                              )}
                            </>
                          </>
                        ) : null}
                      </div>
                    </div>
                  )}
                </div>
              )
            }
          })()}
          <h2 className="font-semibold text-lg mt-3 text-foreground">
            {showDirectory &&
              `⭐${
                analysisResult && isDirAnalysis(analysisResult) ? `${analysisResult.name}` : ''
              }`}
            {/* 目录类型 */}
            {analysisResult &&
              isDirAnalysis(analysisResult) &&
              analysisResult.contextAnalysis?.directoryType &&
              `(${analysisResult.contextAnalysis.directoryType})`}
            {/* AI分析结果 - AI摘要 */}
            {analysisResult && isFileAnalysis(analysisResult) && analysisResult.isAnalyzed && analysisResult.description ? (
              <div className="pt-4 mb-6">
                <div className={maskClass}>
                  <CollapsibleText text={analysisResult.description} maxLines={4} />
                </div>
              </div>
            ) : (
              item?.name || ''
            )}
          </h2>
          {item && !isDirectory && 'size' in item && (
            <p className="text-sm text-muted-foreground mt-1">{formatFileSize(item.size)}</p>
          )}
        </div>

        {/* 标签气泡 Section - 彩色气泡展示所有维度标签 */}
        {analysisResult && isFileAnalysis(analysisResult) && analysisResult.isAnalyzed && (
          <div className="border-t border-border pt-4 mb-6">
            <div className="flex flex-wrap gap-2">
              {(() => {
                const allTags: string[] = []
                if (analysisResult.dimensionTags && Array.isArray(analysisResult.dimensionTags)) {
                  analysisResult.dimensionTags.forEach(dimGroup => {
                    if (dimGroup.tags && Array.isArray(dimGroup.tags)) {
                      dimGroup.tags.forEach((tagObj: any) => allTags.push(tagObj.name))
                    }
                  })
                }

                return allTags.length > 0 ? (
                  allTags.map((tagName, idx) => (
                    <span
                      key={idx}
                      className={cn(
                        'text-xs px-3 py-1.5 rounded-full font-medium maskClass',
                        getTagColor(idx)
                      )}
                    >
                      {tagName}
                    </span>
                  ))
                ) : (
                  <span className="text-xs text-muted-foreground italic">
                    {t('标签分析失败，请重试或切换更强的模型')}
                  </span>
                )
              })()}
            </div>
          </div>
        )}

        {/* 路径信息 Section */}
        {item && !isDirectory && (
          <div className="border-t border-border pt-4 mb-6">
            <div className="text-sm space-y-2 text-muted-foreground">
              {analysisResult &&
                isFileAnalysis(analysisResult) &&
                analysisResult.isAnalyzed &&
                (analysisResult.smartName ||
                  (analysisResult.dimensionTags && analysisResult.dimensionTags.length > 0)) && (
                  <>
                    <div>
                      <strong className="font-medium text-foreground">{t('智能文件名:')}</strong>{' '}
                      <span className="break-all mt-1 text-primary maskClass">
                        {generateVirtualPath(analysisResult)}
                      </span>
                    </div>
                    <div>
                      <CollapsibleText
                        text={analysisResult.groupingReason || ''}
                        maxLines={4}
                        className="text-xs maskClass"
                      />
                    </div>
                  </>
                )}
            </div>
          </div>
        )}
        {/* 目录路径信息 */}
        {(showDirectory || isDirectory) && analysisResult && isDirAnalysis(analysisResult) && (
          <div className="border-t border-border pt-4 mb-6">
            <div className="text-sm space-y-2 text-muted-foreground">
              <div>
                <strong className="font-medium text-foreground">{t('路径:')}</strong>{' '}
                {analysisResult.path}
              </div>
              <p>
                <strong className="font-medium text-foreground">{t('文件总数:')}</strong>{' '}
                {analysisResult.fileCount} {t('个')}
              </p>
              <p>
                <strong className="font-medium text-foreground">{t('已分析:')}</strong>{' '}
                {analysisResult.analyzedFileCount} {t('个')}
              </p>
              {analysisResult.lastScanAt && (
                <p>
                  <strong className="font-medium text-foreground">{t('最后扫描:')}</strong>{' '}
                  {formatDate(analysisResult.lastScanAt)}
                </p>
              )}
            </div>
          </div>
        )}

        {/* AI分析结果 - 质量评分 */}
        {analysisResult && isFileAnalysis(analysisResult) && analysisResult.isAnalyzed && (
          <div className="border-t border-border pt-4 mb-6">
            <h3 className="text-sm font-semibold mb-3 text-foreground">{t('质量评分')}</h3>

            {!analysisResult.qualityScore ? (
              <div className="space-y-3">
                <div className="text-sm text-muted-foreground italic">
                  {t('暂无评分数据 (请点击下方"重新分析"获取)')}
                </div>
                {analysisResult.qualityReasoning && (
                  <div className={`mt-3 ${maskClass}`}>
                    <CollapsibleText
                      text={analysisResult.qualityReasoning}
                      maxLines={4}
                      className="text-xs"
                    />
                  </div>
                )}
              </div>
            ) : (
              <>
                <div className="flex items-center space-x-3 mb-3">
                  <div className="flex text-yellow-500 text-xl">
                    {getQualityScoreStars(analysisResult.qualityScore || 0).stars.map(
                      (starType, i) => (
                        <MaterialIcon key={i} icon={starType} className="text-xl" />
                      )
                    )}
                  </div>
                  <span className="text-sm text-foreground">
                    {analysisResult.qualityScore.toFixed(1)} / 10
                  </span>{' '}
                  {analysisResult.qualityConfidence !== undefined &&
                    analysisResult.qualityConfidence !== null && (
                      <span className="text-xs text-muted-foreground ml-2">
                        {t('置信度: ')}
                        {(analysisResult.qualityConfidence * 100).toFixed(0)}%
                      </span>
                    )}
                </div>

                {analysisResult.qualityCriteria && (
                  <div className="space-y-2">
                    <div className="flex items-center text-xs text-muted-foreground">
                      <span className="w-16">{t('技术指标')}</span>
                      <ProgressBar
                        value={analysisResult.qualityCriteria.technical}
                        max={10}
                        className="flex-1 h-1.5"
                        showValue
                      />
                    </div>
                    <div className="flex items-center text-xs text-muted-foreground">
                      <span className="w-16">{t('美学评估')}</span>
                      <ProgressBar
                        value={analysisResult.qualityCriteria.aesthetic}
                        max={10}
                        className="flex-1 h-1.5"
                        showValue
                      />
                    </div>
                    <div className="flex items-center text-xs text-muted-foreground">
                      <span className="w-16">{t('内容价值')}</span>
                      <ProgressBar
                        value={analysisResult.qualityCriteria.content}
                        max={10}
                        className="flex-1 h-1.5"
                        showValue
                      />
                    </div>
                    <div className="flex items-center text-xs text-muted-foreground">
                      <span className="w-16">{t('完整性')}</span>
                      <ProgressBar
                        value={analysisResult.qualityCriteria.completeness}
                        max={10}
                        className="flex-1 h-1.5"
                        showValue
                      />
                    </div>
                    <div className="flex items-center text-xs text-muted-foreground">
                      <span className="w-16">{t('时效性')}</span>
                      <ProgressBar
                        value={analysisResult.qualityCriteria.timeliness}
                        max={10}
                        className="flex-1 h-1.5"
                        showValue
                      />
                    </div>
                  </div>
                )}

                {analysisResult.qualityReasoning && (
                  <div className={`mt-4 ${maskClass}`}>
                    <CollapsibleText
                      text={analysisResult.qualityReasoning}
                      maxLines={4}
                      className="text-xs"
                    />
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* AI分析结果 - AI内容 */}
        {analysisResult && isFileAnalysis(analysisResult) && analysisResult.isAnalyzed && analysisResult.content && (
          <div className="border-t border-border pt-4 mb-6">
            <h3 className="text-sm font-semibold mb-3 text-foreground">{t('摘取内容')}</h3>
            <div className={maskClass}>
              <CollapsibleText text={analysisResult.content} maxLines={4} />
            </div>
          </div>
        )}

        {/* AI分析结果 - 多模态描述 */}
        {analysisResult && isFileAnalysis(analysisResult) && analysisResult.isAnalyzed && analysisResult.multimodalContent && (
          <div className="border-t border-border pt-4 mb-6">
            <h3 className="text-sm font-semibold mb-3 text-foreground">{t('多模态描述')}</h3>
            <div className={maskClass}>
              <CollapsibleText text={analysisResult.multimodalContent} maxLines={4} />
            </div>
          </div>
        )}

        {/* AI分析结果 - 语音/歌词内容 */}
        {analysisResult && isFileAnalysis(analysisResult) && analysisResult.isAnalyzed && analysisResult.lrc && (
          <div className="border-t border-border pt-4 mb-6">
            <h3 className="text-sm font-semibold mb-3 text-foreground">{t('语音/歌词/图片OCR内容')}</h3>
            <div className={maskClass}>
              <CollapsibleText text={analysisResult.lrc} maxLines={4} />
            </div>
          </div>
        )}

        {/* 目录上下文分析 - AI分析策略 */}
        {analysisResult &&
          isDirAnalysis(analysisResult) &&
          analysisResult.contextAnalysis?.analysisStrategy && (
            <div className="border-t border-border pt-4 mb-6">
              <h3 className="text-sm font-semibold mb-3 text-foreground ">
                {t('AI分析策略 ')}{' '}
                {analysisResult.contextAnalysis.confidence && (
                  <span className="text-xs font-light text-muted-foreground mt-3 text-right">
                    {t('置信度: ')}
                    {(analysisResult.contextAnalysis.confidence * 100).toFixed(0)}%
                  </span>
                )}
              </h3>
              <CollapsibleText
                text={analysisResult.contextAnalysis.analysisStrategy}
                maxLines={4}
              />
            </div>
          )}

        {/* 目录上下文分析 - 智能文件名格式 */}
        {analysisResult &&
          isDirAnalysis(analysisResult) &&
          analysisResult.contextAnalysis?.namingPattern && (
            <div className="border-t border-border pt-4 mb-6">
              <h3 className="text-sm font-semibold mb-3 text-foreground">{t('智能文件名格式')}</h3>
              <PersistentTooltip
                id="smart_name_format_hint"
                content={t('这里决定了目录中文件的命名规则，如果对此不满意，可以点底部的重新分析按钮；【终极大招】：可以去设置页面自定义提示词来引导AI生成您想要的文件名')}
                position="bottom"
                delay={1000}
              >
                <CollapsibleText
                  text={analysisResult.contextAnalysis.namingPattern}
                  maxLines={4}
                />
              </PersistentTooltip>
            </div>
          )}

        {/* 推荐标签 */}
        {analysisResult &&
          isDirAnalysis(analysisResult) &&
          analysisResult.contextAnalysis?.recommendedTags &&
          Object.keys(analysisResult.contextAnalysis.recommendedTags).length > 0 && (
            <div className="border-t border-border pt-4 mb-6">
              <div className="space-y-3">
                {Object.entries(analysisResult.contextAnalysis.recommendedTags).map(
                  ([dimension, tags], dimIdx) => (
                    <div key={dimIdx}>
                      <p className="text-xs font-medium text-foreground mb-1.5">{dimension}:</p>
                      <div className="flex flex-wrap gap-2">
                        {Array.isArray(tags) && tags.map((tag, tagIdx) => (
                          <span
                            key={tagIdx}
                            className={cn(
                              'text-xs px-3 py-1.5 rounded-full font-medium',
                              getTagColor(dimIdx * 10 + tagIdx)
                            )}
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    </div>
                  )
                )}
              </div>
            </div>
          )}

        {/* 文件类型分布 */}
        {analysisResult &&
          isDirAnalysis(analysisResult) &&
          analysisResult.contextAnalysis?.fileTypeDistribution &&
          Object.keys(analysisResult.contextAnalysis.fileTypeDistribution || {}).length > 0 && (
            <div className="border-t border-border pt-4 mb-6">
              <h3 className="text-sm font-semibold mb-3 text-foreground">{t('文件类型分布')}</h3>
              <div className="space-y-2">
                {Object.entries(analysisResult.contextAnalysis.fileTypeDistribution || {})
                  .sort(([, a], [, b]) => b - a)
                  .map(([type, count], idx) => {
                    const distribution = analysisResult?.contextAnalysis?.fileTypeDistribution || {};
                    const total = Object.values(distribution).reduce((sum: number, c: number) => sum + c, 0);
                    const percentage = total > 0 ? (count / total) * 100 : 0
                    return (
                      <div key={idx} className="flex items-center text-xs text-muted-foreground">
                        <span className="w-20 capitalize">{type}</span>
                        <div className="flex-1 mx-2">
                          <div className="h-1.5 bg-accent rounded-full overflow-hidden">
                            <div
                              className="h-full bg-primary/20 rounded-full"
                              style={{ width: `${percentage}%` }}
                            />
                          </div>
                        </div>
                        <span className="w-16 text-right">
                          {count} ({percentage.toFixed(0)}%)
                        </span>
                      </div>
                    )
                  })}
              </div>
            </div>
          )}

        {/* 目录特征 - 元数据 */}
        {analysisResult && isDirAnalysis(analysisResult) && analysisResult.contextAnalysis && (
          <div className="border-t border-border pt-4 mb-6">
            <div className="text-sm space-y-2 text-muted-foreground">
              {analysisResult.contextAnalysis.specialFiles &&
                analysisResult.contextAnalysis.specialFiles.length > 0 && (
                  <div>
                    <strong className="font-medium text-foreground">{t('特殊文件:')}</strong>
                    <div className="flex flex-wrap gap-2 mt-1">
                      {Array.isArray(analysisResult.contextAnalysis.specialFiles) && analysisResult.contextAnalysis.specialFiles.map((file, idx) => (
                        <span
                          key={idx}
                          className="text-xs bg-yellow-500/10 text-yellow-600 dark:text-yellow-500 px-2 py-1 rounded font-mono"
                        >
                          {file}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              {analysisResult.contextAnalysis.analyzedAt && (
                <p>
                  <strong className="font-medium text-foreground">{t('分析时间:')}</strong>{' '}
                  {formatDate(analysisResult.contextAnalysis.analyzedAt)}
                </p>
              )}
            </div>
          </div>
        )}

        {/* 元数据 Section */}
        {analysisResult && isFileAnalysis(analysisResult) && analysisResult.isAnalyzed && (
          <div className="border-t border-border pt-4 mb-6">
            <h3 className="text-sm font-semibold mb-3 text-foreground">{t('元数据')}</h3>
            <div className="text-sm space-y-2 text-muted-foreground">
              {analysisResult.author && (
                <p>
                  <strong className="font-medium text-foreground">{t('作者:')}</strong>{' '}
                  {analysisResult.author}
                </p>
              )}
              {analysisResult.language && (
                <p>
                  <strong className="font-medium text-foreground">{t('语言:')}</strong>{' '}
                  {analysisResult.language}
                </p>
              )}
              {analysisResult.mimeType && (
                <p>
                  <strong className="font-medium text-foreground">{t('MIME类型:')}</strong>{' '}
                  {/* 特殊处理 .lnk 文件显示正确的 MIME type */}
                  {analysisResult.mimeType === '.lnk' ||
                  (item &&
                    'extension' in item &&
                    item.extension === '.lnk' &&
                    analysisResult.mimeType === 'application/octet-stream')
                    ? 'application/x-ms-shortcut'
                    : analysisResult.mimeType}
                </p>
              )}
              {analysisResult.lastAnalyzedAt && (
                <p>
                  <strong className="font-medium text-foreground">{t('分析时间:')}</strong>{' '}
                  {formatDate(analysisResult.lastAnalyzedAt)}
                </p>
              )}
              {analysisResult.analysisStats && (
                <p>
                  <strong className="font-medium text-foreground">{t('分析耗时')}:</strong>{' '}
                  {formatDuration(analysisResult.analysisStats.durationMs)}                  {analysisResult.analysisStats.model?.name && (
                    <span className="text-primary mr-1">
                      [{analysisResult.analysisStats.model.name}]{' '}
                    </span>
                  )}
                </p>
              )}
              {analysisResult.metadata && (
                <CollapsibleText
                  text={(() => {
                    try {
                      // 格式化单个值
                      const formatValue = (val: any): string => {
                        if (
                          typeof val === 'string' &&
                          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(val)
                        ) {
                          try {
                            const date = new Date(val)
                            if (!isNaN(date.getTime())) return date.toLocaleString()
                          } catch (e) {}
                        }
                        return String(val)
                      }

                      // 递归格式化对象
                      const format = (obj: any, indent = ''): string => {
                        if (typeof obj !== 'object' || obj === null) return formatValue(obj)

                        return Object.entries(obj)
                          .map(([k, v]) => {
                            if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
                              return `${indent}${k}:\n${format(v, indent + '  ')}`
                            }

                            const valStr = Array.isArray(v)
                              ? `[${v.map(item => formatValue(item)).join(', ')}]`
                              : formatValue(v)

                            return `${indent}${k}: ${valStr}`
                          })
                          .join('\n')
                      }
                      return format(analysisResult.metadata)
                    } catch (e) {
                      return JSON.stringify(analysisResult.metadata, null, 2)
                    }
                  })()}
                  maxLines={10}
                  className="whitespace-pre-wrap font-mono text-xs"
                />
              )}
            </div>
          </div>
        )}

        {/* 最小单元 Section */}
        {units.length > 0 && (
          <div className="border-t border-border pt-4 mb-6">
            <h3 className="text-sm font-semibold mb-3 text-foreground">{t('最小单元')}</h3>
            <div className="space-y-2 text-sm text-foreground">
              {units.map((u, idx) => (
                <div key={u.id || idx} className="rounded border border-border p-2">
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 rounded bg-yellow-500/10 text-yellow-600 dark:text-yellow-500 text-xs">
                      {u.type}
                    </span>
                    {typeof u.groupingConfidence === 'number' && (
                      <span className="text-xs text-muted-foreground">
                        {Math.round(u.groupingConfidence * 100)}%
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">{u.reason}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 底部操作按钮 */}
      <div className="p-4">
        <div className="flex space-x-2">
          <div className="relative group flex-1">
            <Button
              variant="secondary"
              className="w-full"
              onClick={isDirectory || showDirectory ? handleDirectoryReanalyze : handleReanalyze}
              disabled={reanalyzing}
            >
              {reanalyzing ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-primary mr-2"></div>
                  {t('分析中...')}
                </>
              ) : (
                <>
                  <MaterialIcon icon="refresh" className="text-base mr-2" />
                  {analysisResult
                    ? isFileAnalysis(analysisResult)
                      ? analysisResult.isAnalyzed
                        ? t('重新分析')
                        : t('立即分析')
                      : t('重新分析')
                    : t('立即分析')}
                </>
              )}
            </Button>
            {(isDirectory || showDirectory) && (
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 p-2 bg-popover text-popover-foreground text-xs rounded-md shadow-lg border border-border opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-50 pointer-events-none">
                {t('仅分析目录，如果你要分析目录及其下子文件，请点击批量分析按钮')}
              </div>
            )}
          </div>

          {analysisResult &&
            ((isFileAnalysis(analysisResult) && analysisResult.isAnalyzed) ||
              isDirAnalysis(analysisResult)) && (
              <Button
                variant="secondary"
                className="flex-shrink-0 px-3"
                onClick={() => setShowDeleteDialog(true)}
                disabled={deleting || reanalyzing}
                title={t('清空分析结果')}
              >
                <MaterialIcon icon="delete_forever" className="text-base" />
              </Button>
            )}
        </div>
      </div>

      {/* 确认删除对话框 */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('确认清空分析结果？')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('此操作将删除该{category}的所有AI分析数据{sentens}，但不会删除{category}本身。', {
                category: isDirectory ? t('目录') : t('文件'),
                sentens: isDirectory
                  ? t('（包括目录结构分析、推荐标签等）')
                  : t('（包括摘要、标签、向量索引等）')
              })}
              <br />
              <br />
              {t('清空后，您可以重新进行分析。')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="secondary" onClick={() => setShowDeleteDialog(false)}>
              {t('取消')}
            </Button>
            <Button
              variant="destructive"
              onClick={isDirectory ? handleDirectoryClearAnalysis : handleClearAnalysis}
            >
              {t('确认清空')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  )
}