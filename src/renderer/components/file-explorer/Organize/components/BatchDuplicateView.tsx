import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { MaterialIcon, cn } from '../../../../lib/utils'
import { t } from '@app/languages'
import { Button } from '../../../ui/button'
import { Badge } from '../../../ui/badge'
import { Checkbox } from '../../../ui/checkbox'
import { Switch } from '../../../ui/switch'
import { Input } from '../../../ui/input'
import {
  DuplicateGroup,
  DuplicateFileItem,
  DuplicateDetectionStrategy
} from '@firefly/types'
import { toast } from '../../../common/Toast'
import { SplitPane } from '../../../common/SplitPane'
import { FileTypeIcon, extractFileExtension } from '../../../common/FileTypeIcon'
import { SplitPreviewPanel } from '../../SplitPreviewPanel'
import { PAGE_IDS } from '../../../../constants/page-ids'
import { usePreviewOverlayStore } from '../../../../stores/preview-overlay-store'
import { ContextMenu, ContextMenuItem } from '../../../common/ContextMenu'
import { useAnalysisQueueStore } from '../../../../stores/analysis-queue-store'
import { LogCategory, logger } from '@firefly/shared'

interface BatchDuplicateViewProps {
  files: any[]
  workspaceDirectoryPath: string
  onExecuteTrash: (filePaths: string[]) => Promise<void>
  isTrashing?: boolean
  onSelectedCountChange?: (count: number) => void
  onProcessingStateChange?: (isProcessing: boolean) => void
  onFilesChanged?: () => Promise<void> | void
}

type RecommendRule =
  | 'highest_resolution'
  | 'highest_quality'
  | 'newest_modified'
  | 'oldest_created'
  | 'original_name'

/** 清理/查重策略定义项 */
interface StrategyDefinition {
  key: string
  label: string
  icon: string
  category: 'multimodal' | 'cleanup' | 'anomaly' | 'optimize'
  warning?: string
  /** 策略暂不可用（置灰显示，禁用勾选与筛选） */
  disabled?: boolean
  /** 悬停时展示的详细说明（原生 title 提示） */
  description?: string
}

/** 策略分类定义 */
interface StrategyCategory {
  key: 'multimodal' | 'cleanup' | 'anomaly' | 'optimize'
  name: string
  icon: string
}

/** 常见图片扩展名集合 */
const IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'bmp',
  'svg',
  'ico',
  'avif',
  'heic',
  'heif',
  'tiff',
  'tif'
])

export const BatchDuplicateView: React.FC<BatchDuplicateViewProps> = ({
  files,
  workspaceDirectoryPath,
  onExecuteTrash,
  isTrashing = false,
  onSelectedCountChange,
  onProcessingStateChange,
  onFilesChanged
}) => {
  const [minSimilarity, setMinSimilarity] = useState<number>(7.5)
  const [duplicateGroups, setDuplicateGroups] = useState<DuplicateGroup[]>([])
  const [isScanning, setIsScanning] = useState(false)
  const [hasScanned, setHasScanned] = useState(false)
  const [scannedCount, setScannedCount] = useState<number>(0)
  const [activeStrategyFilter, setActiveStrategyFilter] = useState<string>('all')
  const [searchKeyword, setSearchKeyword] = useState<string>('')
  const [collapsedCategories, setCollapsedCategories] = useState<Record<string, boolean>>({})
  const [enabledStrategies, setEnabledStrategies] = useState<string[]>([
    'exact_hash',
    'image_phash',
    'audio_hash',
    'empty_folders',
    'big_files',
    'empty_files',
    'temporary_files',
    'invalid_symlinks',
    'broken_files',
    'bad_extensions',
    'bad_names',
    'exif_remover',
    'video_optimizer'
  ])
  const [recommendRule, setRecommendRule] = useState<RecommendRule>('highest_resolution')
  const [previewingPath, setPreviewingPath] = useState<string>('')
  const [trashingGroupId, setTrashingGroupId] = useState<string | null>(null)
  const [isBatchProcessing, setIsBatchProcessing] = useState<boolean>(false)
  const [streamingScannedCount, setStreamingScannedCount] = useState<number>(0)
  const [streamingTotalCount, setStreamingTotalCount] = useState<number>(0)
  const [currentScanStage, setCurrentScanStage] = useState<string>('')

  // 将批量处理执行状态即时同步给顶栏操作按钮
  useEffect(() => {
    if (onProcessingStateChange) {
      onProcessingStateChange(isBatchProcessing)
    }
  }, [isBatchProcessing, onProcessingStateChange])

  // 建立由真实路径到智能文件名/元数据的快速映射索引
  const fileMetaMap = useMemo(() => {
    const map = new Map<string, any>()
    for (const f of files) {
      if (f.path) {
        map.set(f.path, f)
      }
    }
    return map
  }, [files])

  // 格式化文件大小
  const formatBytes = useCallback((bytes: number): string => {
    if (!bytes || bytes <= 0) return '0 B'
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
    return `${bytes} B`
  }, [])

  // 执行双轨扫描 (支持全 16 种策略调度，全量覆盖工作区物理文件，支持实时流式进度)
  const handleScan = async (overrideSimilarity?: number, overrideStrategies?: string[]) => {
    setIsScanning(true)
    setDuplicateGroups([])
    setStreamingScannedCount(0)
    setStreamingTotalCount(files.length || 0)
    setCurrentScanStage(t('初始化多模态引擎...'))

    const sim = overrideSimilarity ?? minSimilarity
    const currentStrategies = overrideStrategies ?? enabledStrategies

    // 订阅流式进度
    let cleanupProgress: (() => void) | undefined = undefined
    let localMaxScanned = 0
    let localMaxTotal = 0

    if (window.electronAPI?.organizeBatch?.onScanProgress) {
      cleanupProgress = window.electronAPI.organizeBatch.onScanProgress(data => {
        if (data.scanned !== undefined && data.scanned > 0) {
          localMaxScanned = Math.max(localMaxScanned, data.scanned)
          setStreamingScannedCount(localMaxScanned)
          setScannedCount(localMaxScanned)
        }
        if (data.totalScanned !== undefined && data.totalScanned > 0) {
          localMaxTotal = Math.max(localMaxTotal, data.totalScanned)
          setStreamingTotalCount(localMaxTotal)
          if (!localMaxScanned) {
            setScannedCount(localMaxTotal)
          }
        }
        if (data.stage) {
          setCurrentScanStage(data.stage)
        }
        if (data.group) {
          setDuplicateGroups(prev => {
            if (prev.some(g => g.groupId === data.group.groupId)) return prev
            return [...prev, data.group]
          })
        }
      })
    }

    try {
      if (window.electronAPI?.organizeBatch?.scanDuplicates) {
        const groups = await window.electronAPI.organizeBatch.scanDuplicates({
          workspaceDirectoryPath,
          minSimilarity: sim,
          strategies: currentStrategies as DuplicateDetectionStrategy[]
        })
        const normalizedGroups: DuplicateGroup[] = (groups || []).map((g: DuplicateGroup, idx: number) => ({
          ...g,
          groupId: g.groupId || `${g.strategy}_${idx}`,
          files: (g.files || []).map((f: DuplicateFileItem) => ({ ...f }))
        }))
        setDuplicateGroups(normalizedGroups)
        const finalCount = localMaxScanned || localMaxTotal || streamingScannedCount || 0
        setScannedCount(finalCount)
        setHasScanned(true)
        toast.success(t('查重扫描完成，发现 {count} 个相似组', { count: normalizedGroups.length }))
      }
    } catch (err: any) {
      toast.error(err?.message || t('查重扫描失败'))
    } finally {
      cleanupProgress?.()
      setIsScanning(false)
    }
  }

  // 移除组件挂载时的自动扫描 (避免 Keep-Alive 导致切换目录后静默在后台扫描整个工作区)
  useEffect(() => {
    // 切换工作区目录时，重置扫描状态，等待用户主动点击开始扫描
    setDuplicateGroups([])
    setHasScanned(false)
    setScannedCount(0)
  }, [workspaceDirectoryPath])

  const toggleStrategy = (stratKey: string) => {
    const updated = enabledStrategies.includes(stratKey)
      ? enabledStrategies.filter(s => s !== stratKey)
      : [...enabledStrategies, stratKey]
    setEnabledStrategies(updated)
    // 如果用户勾选了策略，自动将筛选视角重置回全部结果，确保能立即看到所有勾选策略的扫描结果
    if (activeStrategyFilter !== 'all') {
      setActiveStrategyFilter('all')
    }
    if (hasScanned) {
      handleScan(minSimilarity, updated)
    }
  }

  const toggleCategoryCollapse = (catKey: string) => {
    setCollapsedCategories(prev => ({
      ...prev,
      [catKey]: !prev[catKey]
    }))
  }

  // 切换保留规则 (即时应用并重新计算每组的保留项与删除勾选)
  const handleApplyRule = async (rule: RecommendRule) => {
    setRecommendRule(rule)
    if (window.electronAPI?.organizeBatch?.applyKeepRule) {
      try {
        const calculated = await window.electronAPI.organizeBatch.applyKeepRule(duplicateGroups, rule)
        if (calculated && Array.isArray(calculated)) {
          setDuplicateGroups(calculated)
          return
        }
      } catch (e) {
        logger.warn(LogCategory.FILE_ORGANIZATION, 'IPC applyKeepRule 调用失败，降级本地计算', e)
      }
    }

    // 本地降级同步即时重算
    setDuplicateGroups(prev => {
      const cloned = prev.map(g => ({
        ...g,
        files: (g.files || []).map(f => ({ ...f }))
      }))
      for (const group of cloned) {
        if (!group.files || group.files.length === 0) continue

        // 单体清理/修复类策略保护
        const isStandaloneAllSelectStrategy = [
          'empty_files',
          'empty_folders',
          'temporary_files',
          'invalid_symlinks',
          'broken_files',
          'bad_names',
          'video_optimizer'
        ].includes(group.strategy)

        if (isStandaloneAllSelectStrategy) {
          group.files.forEach(f => {
            f.isRecommendedKeep = false
            f.selectedForDelete = true
          })
          group.recommendedKeepFingerprint = undefined
          continue
        }

        if (
          group.strategy === 'big_files' ||
          group.strategy === 'exif_remover' ||
          group.strategy === 'bad_extensions'
        ) {
          group.files.forEach(f => {
            f.isRecommendedKeep = true
            f.selectedForDelete = false
          })
          group.recommendedKeepFingerprint = undefined
          continue
        }

        // 多模态/查重组
        let bestIndex = 0
        for (let i = 1; i < group.files.length; i++) {
          const curr = group.files[i]
          const best = group.files[bestIndex]

          const parseRes = (resStr?: string) => {
            if (!resStr) return 0
            const match = resStr.match(/(\d+)\s*[xX*×]\s*(\d+)/)
            return match ? parseInt(match[1], 10) * parseInt(match[2], 10) : 0
          }

          const currRes = parseRes(curr.resolution)
          const bestRes = parseRes(best.resolution)
          const currQuality = curr.qualityScore || 0
          const bestQuality = best.qualityScore || 0
          const currSize = curr.size || 0
          const bestSize = best.size || 0
          const currModTime = new Date(curr.modifiedAt || 0).getTime() || 0
          const bestModTime = new Date(best.modifiedAt || 0).getTime() || 0
          const currCreateTime = new Date(curr.createdAt || curr.modifiedAt || 0).getTime() || 0
          const bestCreateTime = new Date(best.createdAt || best.modifiedAt || 0).getTime() || 0
          const isCurrCopy = /副本|copy|\(\d+\)|_\d+$/i.test(curr.name)
          const isBestCopy = /副本|copy|\(\d+\)|_\d+$/i.test(best.name)

          if (rule === 'highest_resolution') {
            if (currRes !== bestRes) {
              if (currRes > bestRes) bestIndex = i
            } else if (currQuality !== bestQuality && (currQuality > 0 || bestQuality > 0)) {
              if (currQuality > bestQuality) bestIndex = i
            } else if (currSize !== bestSize) {
              if (currSize > bestSize) bestIndex = i
            } else if (currCreateTime !== bestCreateTime) {
              if (currCreateTime < bestCreateTime) bestIndex = i
            }
          } else if (rule === 'highest_quality') {
            if (currQuality !== bestQuality && (currQuality > 0 || bestQuality > 0)) {
              if (currQuality > bestQuality) bestIndex = i
            } else if (currRes !== bestRes) {
              if (currRes > bestRes) bestIndex = i
            } else if (currSize !== bestSize) {
              if (currSize > bestSize) bestIndex = i
            } else if (currCreateTime !== bestCreateTime) {
              if (currCreateTime < bestCreateTime) bestIndex = i
            }
          } else if (rule === 'newest_modified') {
            if (currModTime !== bestModTime) {
              if (currModTime > bestModTime) bestIndex = i
            } else if (currSize !== bestSize) {
              if (currSize > bestSize) bestIndex = i
            }
          } else if (rule === 'oldest_created') {
            if (currCreateTime !== bestCreateTime) {
              if (currCreateTime < bestCreateTime) bestIndex = i
            } else if (currSize !== bestSize) {
              if (currSize > bestSize) bestIndex = i
            }
          } else if (rule === 'original_name') {
            if (!isCurrCopy && isBestCopy) {
              bestIndex = i
            } else if (isCurrCopy && !isBestCopy) {
              // 保留最佳
            } else if (curr.name.length !== best.name.length) {
              if (curr.name.length < best.name.length) bestIndex = i
            } else if (currCreateTime !== bestCreateTime) {
              if (currCreateTime < bestCreateTime) bestIndex = i
            }
          }
        }

        group.files.forEach((f, idx) => {
          if (idx === bestIndex) {
            f.isRecommendedKeep = true
            f.selectedForDelete = false
          } else {
            f.isRecommendedKeep = false
            f.selectedForDelete = true
          }
        })
        group.recommendedKeepFingerprint = group.files[bestIndex]?.fingerprint
      }
      return cloned
    })
  }

  // 计算缩略图或图片直显 URL（完全参考 FileList / GridCell 实现机制）
  const getFileThumbnailUrl = useCallback(
    (file: DuplicateFileItem): string | null => {
      const ext = extractFileExtension(file.path) || extractFileExtension(file.name)
      const isImg = IMAGE_EXTENSIONS.has(ext)
      const normalize =
        window.electronAPI?.utils?.normalizeForCache || ((p: string) => p)

      // 1. 如果有明确缩略图路径
      if (file.thumbnailPath) {
        const thumbPath = file.thumbnailPath
        const isAbs =
          /^[a-zA-Z]:[\\/]/.test(thumbPath) ||
          thumbPath.startsWith('/') ||
          thumbPath.startsWith('\\')
        let absPath = ''
        if (isAbs) {
          absPath = thumbPath
        } else if (workspaceDirectoryPath) {
          absPath = `${workspaceDirectoryPath.replace(/[\\/]+$/, '')}/${thumbPath.replace(/^[\\/]+/, '')}`
        }
        if (absPath) {
          const normalized = normalize(absPath).replace(/\\/g, '/')
          const cleanPath = normalized.startsWith('/') ? normalized : `/${normalized}`
          return `file://${cleanPath}`
        }
      }

      // 2. 如果本身就是图片类型，直接使用原生 file:// 加载原图作为预览
      if (isImg && file.path) {
        const normalized = normalize(file.path).replace(/\\/g, '/')
        const cleanPath = normalized.startsWith('/') ? normalized : `/${normalized}`
        return `file://${cleanPath}`
      }

      return null
    },
    [workspaceDirectoryPath]
  )

  // 点击文件的多选框切换选择状态（selectedForDelete 代表待删除/待处理，按组独立隔离）
  const handleToggleFileSelection = (
    targetGroup: DuplicateGroup,
    targetPath: string,
    nextChecked?: boolean
  ) => {
    setDuplicateGroups(prev => {
      return prev.map(group => {
        // 严格且唯一匹配当前操作的 targetGroup 实例/groupId，避免跨组影响同路径文件
        const isTargetGroup =
          (group.groupId && targetGroup.groupId && group.groupId === targetGroup.groupId) ||
          group === targetGroup
        if (!isTargetGroup) return group

        const newFiles = group.files.map(file => {
          if (file.path !== targetPath) return file
          const targetSelected =
            typeof nextChecked === 'boolean' ? nextChecked : !file.selectedForDelete
          return {
            ...file,
            selectedForDelete: targetSelected,
            isRecommendedKeep: !targetSelected
          }
        })
        return {
          ...group,
          files: newFiles
        }
      })
    })
  }

  // 点击文件触发右侧分栏预览
  const handleSelectFileForPreview = (file: DuplicateFileItem) => {
    setPreviewingPath(file.path)
    const ext = extractFileExtension(file.path) || extractFileExtension(file.name)
    const meta = fileMetaMap.get(file.path)
    const displayTitle = meta?.smartName || file.name
    usePreviewOverlayStore
      .getState()
      .openPreview(file.path, displayTitle, ext, PAGE_IDS.ORGANIZE)
  }

  // 右键菜单状态（对齐 FileList 组件）
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    file: DuplicateFileItem
  } | null>(null)

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, file: DuplicateFileItem) => {
      e.preventDefault()
      e.stopPropagation()
      handleSelectFileForPreview(file)
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        file
      })
    },
    []
  )

  const { addItems } = useAnalysisQueueStore()

  // 构建右键菜单项（同 FileList 组件）
  const contextMenuItems = useMemo((): ContextMenuItem[] => {
    if (!contextMenu) return []
    const file = contextMenu.file
    const ext = extractFileExtension(file.path) || extractFileExtension(file.name)
    const meta = fileMetaMap.get(file.path)
    const displayTitle = meta?.smartName || file.name

    const queueItems = useAnalysisQueueStore.getState().snapshot.items
    const isPathEqual = window.electronAPI?.utils?.isPathEqual || ((p1: string, p2: string) => p1 === p2)
    const queueItem = queueItems.find(q => isPathEqual(q.path, file.path))
    const isAnalyzingOrPending = queueItem?.status === 'analyzing' || queueItem?.status === 'pending'
    const isAnalyzed = Boolean(file.qualityScore !== undefined || meta?.isAnalyzed)

    return [
      {
        label: t('预览'),
        icon: 'visibility',
        onClick: () => {
          usePreviewOverlayStore
            .getState()
            .openPreview(file.path, displayTitle, ext, PAGE_IDS.ORGANIZE)
        }
      },
      {
        label: t('用默认程序打开'),
        icon: 'open_in_new',
        onClick: async () => {
          try {
            await window.electronAPI!.utils.openFileWithDefaultApp(file.path)
          } catch (error: any) {
            logger.error(LogCategory.RENDERER, '打开文件失败:', error)
            toast.error(t('打开文件失败'))
          }
        }
      },
      {
        label: t('复制文件路径'),
        icon: 'content_copy',
        onClick: async () => {
          try {
            await window.electronAPI!.utils.copyFileToClipboard(file.path)
            toast.success(t('已复制到剪贴板'))
          } catch (error: any) {
            logger.error(LogCategory.RENDERER, '复制文件失败:', error)
            toast.error(t('复制失败'))
          }
        }
      },
      isAnalyzed
        ? {
            label: t('重新分析'),
            icon: 'refresh',
            disabled: isAnalyzingOrPending,
            onClick: async () => {
              try {
                await addItems([
                  {
                    path: file.path,
                    name: file.name,
                    size: file.size || 0,
                    type: ext
                  }
                ], true)
                toast.success(t('已加入分析队列'))
              } catch (error) {
                logger.error(LogCategory.RENDERER, '加入分析队列失败:', error)
                toast.error(t('操作失败'))
              }
            }
          }
        : {
            label: t('立即分析'),
            icon: 'analytics',
            disabled: isAnalyzingOrPending,
            onClick: async () => {
              try {
                await addItems([
                  {
                    path: file.path,
                    name: file.name,
                    size: file.size || 0,
                    type: ext
                  }
                ], false)
                toast.success(t('已加入分析队列'))
              } catch (error) {
                logger.error(LogCategory.RENDERER, '加入分析队列失败:', error)
                toast.error(t('操作失败'))
              }
            }
          },
      {
        label: t('在真实目录中定位'),
        icon: 'folder_open',
        onClick: async () => {
          try {
            await window.electronAPI!.utils.showItemInFolder(file.path)
          } catch (error: any) {
            logger.error(LogCategory.RENDERER, '打开目录失败:', error)
            toast.error(t('打开目录失败'))
          }
        }
      },
      {
        label: t('在虚拟目录中定位'),
        icon: 'account_tree',
        onClick: async () => {
          try {
            const hardlinkPath = await window.electronAPI!.analyzedDirectory.findFirstHardlink(
              file.path
            )
            if (hardlinkPath) {
              await window.electronAPI!.utils.showItemInFolder(hardlinkPath)
            } else {
              toast.info(t('请先导出虚拟目录（虚拟目录不占硬盘空间）'))
            }
          } catch (error: any) {
            logger.error(LogCategory.RENDERER, '查找虚拟目录硬链接失败:', error)
            toast.error(t('操作失败'))
          }
        }
      }
    ]
  }, [contextMenu, fileMetaMap, addItems])

  // 单个组内：全选删除 / 全保留 / 反选 (仅在当前组生效)
  const handleToggleGroupAction = (targetGroup: DuplicateGroup, action: 'keep_all' | 'trash_all' | 'invert') => {
    setDuplicateGroups(prev => {
      return prev.map(group => {
        const isTargetGroup =
          (group.groupId && targetGroup.groupId && group.groupId === targetGroup.groupId) ||
          group === targetGroup
        if (!isTargetGroup) return group

        const newFiles = group.files.map(f => {
          if (action === 'keep_all') {
            return { ...f, isRecommendedKeep: true, selectedForDelete: false }
          } else if (action === 'trash_all') {
            return { ...f, isRecommendedKeep: false, selectedForDelete: true }
          } else {
            const nextSelected = !f.selectedForDelete
            return { ...f, isRecommendedKeep: !nextSelected, selectedForDelete: nextSelected }
          }
        })
        return {
          ...group,
          files: newFiles
        }
      })
    })
  }

  // 全局动作：全保留 / 反选 (全局有效)
  const handleGlobalToggleAction = (action: 'keep_all' | 'invert') => {
    setDuplicateGroups(prev => {
      return prev.map(group => {
        const newFiles = group.files.map(f => {
          if (action === 'keep_all') {
            return { ...f, isRecommendedKeep: true, selectedForDelete: false }
          } else {
            const nextSelected = !f.selectedForDelete
            return { ...f, isRecommendedKeep: !nextSelected, selectedForDelete: nextSelected }
          }
        })
        return { ...group, files: newFiles }
      })
    })
    if (action === 'keep_all') {
      toast.info(t('已全部设置为保留'))
    } else {
      toast.info(t('已全局反选'))
    }
  }

  // 单组执行即时专属操作 (优化/清理/更名/修正/移入回收站)
  const handleExecuteGroupAction = async (group: DuplicateGroup, gIdx: number) => {
    const targetPaths = group.files.filter(f => f.selectedForDelete && f.path).map(f => f.path)
    if (targetPaths.length === 0) {
      toast.warning(t('本组内未勾选任何文件'))
      return
    }

    setTrashingGroupId(group.groupId || String(gIdx))
    const isVideoOpt = group.strategy === 'video_optimizer'
    const isExifClean = group.strategy === 'exif_remover'
    const loadingToastId = isVideoOpt
      ? toast.loading(t('正在对 {count} 个视频进行高效能优化转码，请稍候...', { count: targetPaths.length }))
      : isExifClean
      ? toast.loading(t('正在处理 {count} 个图片的 Exif 隐私信息清除...', { count: targetPaths.length }))
      : null

    try {
      if (group.strategy === 'video_optimizer') {
        const res = await window.electronAPI?.organizeBatch?.executeStrategyFix('optimize', targetPaths, workspaceDirectoryPath)
        if (loadingToastId) toast.dismiss(loadingToastId)
        if (res?.errors && res.errors.length > 0 && res.successCount === 0) {
          toast.error(t('视频优化转码失败: {err}', { err: res.errors[0]?.error || '' }))
          return
        }
        toast.success(t('已完成 {count} 个视频的高效能转码优化并导出至目录', { count: res?.successCount || targetPaths.length }))
      } else if (group.strategy === 'exif_remover') {
        const res = await window.electronAPI?.organizeBatch?.executeStrategyFix('clean_exif', targetPaths, workspaceDirectoryPath)
        if (loadingToastId) toast.dismiss(loadingToastId)
        if (res?.errors && res.errors.length > 0 && res.successCount === 0) {
          toast.error(t('Exif 隐私信息擦除失败: {err}', { err: res.errors[0]?.error || '' }))
          return
        }
        toast.success(t('已成功生成 {count} 个无 Exif 隐私信息的图片副本至目录', { count: res?.successCount || targetPaths.length }))
      } else if (group.strategy === 'bad_names') {
        const badNameTargets = group.files
          .filter(f => f.selectedForDelete && f.path)
          .map(f => ({ path: f.path, newName: f.fingerprint || undefined }))
        const res = await window.electronAPI?.organizeBatch?.executeStrategyFix('rename_bad_name', badNameTargets, workspaceDirectoryPath)
        toast.success(t('已成功按推荐名更名 {count} 个异常文件名', { count: res?.successCount || targetPaths.length }))
      } else if (group.strategy === 'bad_extensions') {
        const res = await window.electronAPI?.organizeBatch?.executeStrategyFix('fix_extension', targetPaths, workspaceDirectoryPath)
        toast.success(t('已成功修正 {count} 个文件的错误扩展名', { count: res?.successCount || targetPaths.length }))
      } else {
        await onExecuteTrash(targetPaths)
      }

      // 操作成功后从当前状态中移除已被处理的文件或组
      setDuplicateGroups(prev => {
        const nextGroups = prev.map(g => {
          if (g.groupId === group.groupId || prev.indexOf(g) === gIdx) {
            const remainingFiles = g.files.filter(f => !targetPaths.includes(f.path))
            return { ...g, files: remainingFiles }
          }
          return g
        }).filter(g => {
          const isStandalone = [
            'empty_files',
            'empty_folders',
            'big_files',
            'temporary_files',
            'invalid_symlinks',
            'broken_files',
            'bad_extensions',
            'bad_names',
            'exif_remover',
            'video_optimizer'
          ].includes(g.strategy)
          return isStandalone ? g.files.length > 0 : g.files.length > 1
        })
        return nextGroups
      })

      // 通知父组件和全局重新拉取最新数据库真实文件名列表
      if (onFilesChanged) {
        await onFilesChanged()
      }
    } catch (err: any) {
      toast.error(err?.message || t('执行操作失败'))
    } finally {
      setTrashingGroupId(null)
    }
  }

  // 统计信息计算
  const statistics = useMemo(() => {
    let redundantCount = 0
    let freedBytes = 0
    let keepCount = 0

    for (const group of duplicateGroups) {
      for (const f of group.files) {
        if (f.selectedForDelete) {
          redundantCount++
          freedBytes += f.size || 0
        } else {
          keepCount++
        }
      }
    }

    return {
      totalGroups: duplicateGroups.length,
      redundantCount,
      keepCount,
      freedBytes: formatBytes(freedBytes),
      rawFreedBytes: freedBytes
    }
  }, [duplicateGroups, formatBytes])

  // 策略分类列表
  const STRATEGY_CATEGORIES = useMemo<StrategyCategory[]>(() => [
    { key: 'multimodal', name: t('多模态与内容查重'), icon: 'fingerprint' },
    { key: 'cleanup', name: t('目录与空项清理'), icon: 'folder_delete' },
    { key: 'anomaly', name: t('异常与失效文件'), icon: 'report_problem' },
    { key: 'optimize', name: t('优化转换与隐私'), icon: 'tune' }
  ], [])

  // 16 大核心策略定义表 (按分类组织)
  const STRATEGY_DEFINITIONS = useMemo<StrategyDefinition[]>(() => [
    { key: 'exact_hash', label: t('精确内容一致'), icon: 'fingerprint', category: 'multimodal' },
    { key: 'image_phash', label: t('相似图片'), icon: 'image', category: 'multimodal' },
    { key: 'audio_hash', label: t('相似音乐'), icon: 'audiotrack', category: 'multimodal' },
    { key: 'video_phash', label: t('相似视频'), icon: 'videocam', category: 'multimodal', warning: t('查找耗时较长') },
    { key: 'text_simhash', label: t('文档语义相似'), icon: 'article', category: 'multimodal', disabled: true },
    { key: 'filename_heuristic', label: t('副本衍生文件'), icon: 'copy_all', category: 'multimodal', disabled: true },

    { key: 'empty_folders', label: t('空文件夹'), icon: 'folder_open', category: 'cleanup' },
    { key: 'big_files', label: t('超大文件'), icon: 'save', category: 'cleanup', description: t('发现单文件体积大于或等于 10MB 的超大文件') },
    { key: 'empty_files', label: t('空文件'), icon: 'insert_drive_file', category: 'cleanup' },
    { key: 'temporary_files', label: t('临时缓存'), icon: 'auto_delete', category: 'cleanup' },

    { key: 'invalid_symlinks', label: t('断裂软链接'), icon: 'link_off', category: 'anomaly' },
    { key: 'broken_files', label: t('损坏文件'), icon: 'broken_image', category: 'anomaly' },
    { key: 'bad_extensions', label: t('错误扩展名'), icon: 'extension_off', category: 'anomaly' },
    { key: 'bad_names', label: t('异常文件名'), icon: 'edit_attributes', category: 'anomaly' },

    { key: 'exif_remover', label: t('Exif隐私清理'), icon: 'privacy_tip', category: 'optimize', description: t('扫描图片中携带的 Exif 元数据（如 GPS 定位、拍摄器材、时间等隐私），清理后将另存为无隐私副本至 .VirtualDirectory/.cleaned_exif 目录，完全保留原文件。') },
    { key: 'video_optimizer', label: t('视频优化转换'), icon: 'smart_display', category: 'optimize', warning: t('优化过程耗时较长'), description: t('采用 AV1/HEVC 高能效编码转码压缩视频，优化后将另存为高清轻量副本至 .VirtualDirectory/.video_optimizer 目录，完全保留原文件。') }
  ], [])

  // 过滤后的组 (支持策略筛选和关键词搜索)
  const filteredGroups = useMemo(() => {
    return duplicateGroups.filter(group => {
      if (activeStrategyFilter !== 'all' && group.strategy !== activeStrategyFilter) {
        return false
      }
      if (searchKeyword.trim()) {
        const kw = searchKeyword.toLowerCase().trim()
        const matchDesc = group.description?.toLowerCase().includes(kw)
        const matchFile = group.files.some(
          f => f.name.toLowerCase().includes(kw) || f.path.toLowerCase().includes(kw)
        )
        return matchDesc || matchFile
      }
      return true
    })
  }, [duplicateGroups, activeStrategyFilter, searchKeyword])

  // 全局全部已勾选待处理文件总数（包含删除、更名、扩展名修正、视频优化、Exif清理等所有策略组）
  const totalSelectedCount = useMemo(() => {
    let count = 0
    for (const group of duplicateGroups) {
      for (const f of group.files) {
        if (f.selectedForDelete && f.path) {
          count++
        }
      }
    }
    return count
  }, [duplicateGroups])

  // 当勾选待处理文件数量变动时，即时同步给父组件（用于顶栏按钮显示：批量处理全部勾选 (N)）
  useEffect(() => {
    if (onSelectedCountChange) {
      onSelectedCountChange(totalSelectedCount)
    }
  }, [totalSelectedCount, onSelectedCountChange])

  // 批量处理全部勾选执行逻辑：
  // 根据分组类型，针对每组已勾选的文件依次执行对应操作（避免并发竞态）；
  // 优先执行删除操作，如果后续操作中文件已被删除或已不存在，则安全跳过。
  const handleExecuteBatchProcessAll = async () => {
    let hasAnySelected = false
    for (const g of duplicateGroups) {
      if (g.files.some(f => f.selectedForDelete && f.path)) {
        hasAnySelected = true
        break
      }
    }
    if (!hasAnySelected) {
      toast.warning(t('未勾选任何需要处理的文件'))
      return
    }

    setIsBatchProcessing(true)
    const deletedPathsSet = new Set<string>()
    let totalDeleted = 0
    let totalRenamed = 0
    let totalExtFixed = 0
    let totalOptimized = 0
    let totalExifCleaned = 0
    const processedPaths = new Set<string>()

    const globalLoadingToastId = toast.loading(t('正在批量处理勾选的文件，请稍候...'))

    try {
      // 阶段 1：优先执行所有「删除到回收站」类的策略组
      const trashGroups = duplicateGroups.filter(g => {
        return (
          g.strategy !== 'bad_names' &&
          g.strategy !== 'bad_extensions' &&
          g.strategy !== 'video_optimizer' &&
          g.strategy !== 'exif_remover'
        )
      })

      const allTrashPaths: string[] = []
      for (const group of trashGroups) {
        for (const file of group.files) {
          if (file.selectedForDelete && file.path && !deletedPathsSet.has(file.path)) {
            allTrashPaths.push(file.path)
            deletedPathsSet.add(file.path)
            processedPaths.add(file.path)
          }
        }
      }

      if (allTrashPaths.length > 0) {
        try {
          await onExecuteTrash(allTrashPaths)
          totalDeleted += allTrashPaths.length
        } catch (err: any) {
          logger.error(LogCategory.RENDERER, '批量删除失败:', err)
          toast.error(t('部分文件删除失败: {message}', { message: err?.message || '' }))
        }
      }

      // 阶段 2：依次执行专属修复类策略组（更名 -> 扩展名修正 -> 视频转码 -> Exif清理）
      // 每次执行前检查文件是否已被删除（deletedPathsSet），避免处理已删除或不存在的文件

      // 2.1 异常文件名更名 (bad_names)：严格采用 Omni 计算并返回的推荐名
      const badNameGroups = duplicateGroups.filter(g => g.strategy === 'bad_names')
      const badNameTargets: Array<{ path: string; newName?: string }> = []
      for (const group of badNameGroups) {
        for (const file of group.files) {
          if (
            file.selectedForDelete &&
            file.path &&
            !deletedPathsSet.has(file.path) &&
            !processedPaths.has(file.path)
          ) {
            badNameTargets.push({ path: file.path, newName: file.fingerprint || undefined })
            processedPaths.add(file.path)
          }
        }
      }
      if (badNameTargets.length > 0) {
        try {
          const res = await window.electronAPI?.organizeBatch?.executeStrategyFix(
            'rename_bad_name',
            badNameTargets
          )
          totalRenamed += res?.successCount || badNameTargets.length
        } catch (err: any) {
          logger.error(LogCategory.RENDERER, '批量更名失败:', err)
        }
      }

      // 2.2 错误扩展名修正 (bad_extensions)
      const badExtGroups = duplicateGroups.filter(g => g.strategy === 'bad_extensions')
      const badExtPaths: string[] = []
      for (const group of badExtGroups) {
        for (const file of group.files) {
          if (
            file.selectedForDelete &&
            file.path &&
            !deletedPathsSet.has(file.path) &&
            !processedPaths.has(file.path)
          ) {
            badExtPaths.push(file.path)
            processedPaths.add(file.path)
          }
        }
      }
      if (badExtPaths.length > 0) {
        try {
          const res = await window.electronAPI?.organizeBatch?.executeStrategyFix(
            'fix_extension',
            badExtPaths
          )
          totalExtFixed += res?.successCount || badExtPaths.length
        } catch (err: any) {
          logger.error(LogCategory.RENDERER, '批量修正扩展名失败:', err)
        }
      }

      // 2.3 视频优化转码 (video_optimizer)
      const videoOptGroups = duplicateGroups.filter(g => g.strategy === 'video_optimizer')
      const videoOptPaths: string[] = []
      for (const group of videoOptGroups) {
        for (const file of group.files) {
          if (
            file.selectedForDelete &&
            file.path &&
            !deletedPathsSet.has(file.path) &&
            !processedPaths.has(file.path)
          ) {
            videoOptPaths.push(file.path)
            processedPaths.add(file.path)
          }
        }
      }
      if (videoOptPaths.length > 0) {
        try {
          const res = await window.electronAPI?.organizeBatch?.executeStrategyFix(
            'optimize',
            videoOptPaths,
            workspaceDirectoryPath
          )
          totalOptimized += res?.successCount || videoOptPaths.length
        } catch (err: any) {
          logger.error(LogCategory.RENDERER, '批量视频优化失败:', err)
        }
      }

      // 2.4 Exif 隐私清理 (exif_remover)
      const exifGroups = duplicateGroups.filter(g => g.strategy === 'exif_remover')
      const exifPaths: string[] = []
      for (const group of exifGroups) {
        for (const file of group.files) {
          if (
            file.selectedForDelete &&
            file.path &&
            !deletedPathsSet.has(file.path) &&
            !processedPaths.has(file.path)
          ) {
            exifPaths.push(file.path)
            processedPaths.add(file.path)
          }
        }
      }
      if (exifPaths.length > 0) {
        try {
          const res = await window.electronAPI?.organizeBatch?.executeStrategyFix(
            'clean_exif',
            exifPaths,
            workspaceDirectoryPath
          )
          totalExifCleaned += res?.successCount || exifPaths.length
        } catch (err: any) {
          logger.error(LogCategory.RENDERER, '批量清理Exif失败:', err)
        }
      }

      // 阶段 3：从前端状态中移除已成功处理的文件项并剔除空组
      setDuplicateGroups(prev => {
        return prev
          .map(g => {
            const remaining = g.files.filter(f => !processedPaths.has(f.path))
            return { ...g, files: remaining }
          })
          .filter(g => {
            const isStandalone = [
              'empty_files',
              'empty_folders',
              'big_files',
              'temporary_files',
              'invalid_symlinks',
              'broken_files',
              'bad_extensions',
              'bad_names',
              'exif_remover',
              'video_optimizer'
            ].includes(g.strategy)
            return isStandalone ? g.files.length > 0 : g.files.length > 1
          })
      })

      if (globalLoadingToastId) toast.dismiss(globalLoadingToastId)

      // 阶段 4：汇总反馈与提示
      const detailParts: string[] = []
      if (totalDeleted > 0) detailParts.push(t('删除 {count} 个', { count: totalDeleted }))
      if (totalRenamed > 0) detailParts.push(t('更名 {count} 个', { count: totalRenamed }))
      if (totalExtFixed > 0) detailParts.push(t('修正格式 {count} 个', { count: totalExtFixed }))
      if (totalOptimized > 0) detailParts.push(t('优化视频 {count} 个', { count: totalOptimized }))
      if (totalExifCleaned > 0)
        detailParts.push(t('清理隐私 {count} 个', { count: totalExifCleaned }))

      const totalCount =
        totalDeleted + totalRenamed + totalExtFixed + totalOptimized + totalExifCleaned
      if (totalCount > 0) {
        toast.success(
          t('批量处理完成，共处理 {count} 个项目（{details}）', {
            count: totalCount,
            details: detailParts.join('，')
          })
        )
      } else {
        toast.info(t('未检测到需要处理的有效文件'))
      }

      // 阶段 5：触发父级重新拉取数据库最新真实文件
      if (onFilesChanged) {
        await onFilesChanged()
      }
    } catch (err: any) {
      if (globalLoadingToastId) toast.dismiss(globalLoadingToastId)
      toast.error(err?.message || t('批量处理执行失败'))
    } finally {
      if (globalLoadingToastId) toast.dismiss(globalLoadingToastId)
      setIsBatchProcessing(false)
    }
  }

  // 判断某组是否以图片网格展示：
  // 规则：异常与失效文件组（如断裂软链接、损坏文件、错误扩展名、异常文件名）必须以列表模式显示，以便突出排查理由
  const isImageGroup = useCallback((group: DuplicateGroup): boolean => {
    const isAnomaly =
      group.strategy === 'invalid_symlinks' ||
      group.strategy === 'broken_files' ||
      group.strategy === 'bad_extensions' ||
      group.strategy === 'bad_names'
    if (isAnomaly) return false

    if (group.strategy === 'image_phash') return true
    const imageCount = group.files.filter(f => {
      const ext = extractFileExtension(f.path) || extractFileExtension(f.name)
      return IMAGE_EXTENSIONS.has(ext)
    }).length
    return imageCount > 0 && imageCount >= group.files.length / 2
  }, [])

  return (
    <div className="flex-1 flex overflow-hidden bg-background">
      <SplitPane
        direction="horizontal"
        storageKey="organize-batch-duplicate-main"
        className="flex-1"
        sections={[
          // ─── 1. 左栏：清理分析统计与策略筛选器 ──────────────────────────────
          {
            id: 'duplicate-sidebar',
            type: 'pixel',
            defaultSize: 330,
            minSize: 280,
            content: (
              <div className="h-full flex flex-col bg-card/60 backdrop-blur-xs border-r border-border/60 overflow-hidden">
                <div className="p-4 border-b border-border/50 space-y-3.5 shrink-0">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                        <MaterialIcon icon="cleaning_services" className="text-base" />
                      </div>
                      <div>
                        <div className="text-xs font-bold text-foreground">{t('清理分析统计')}</div>
                        <div className="text-[10px] text-muted-foreground">{t('智能查重与冗余分析')}</div>
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleScan()}
                      disabled={isScanning}
                      className="h-7 text-xs gap-1 rounded-lg border-primary/30 text-primary hover:bg-primary/10 transition-all active:scale-95 shadow-2xs"
                    >
                      <MaterialIcon icon="refresh" className={cn('text-sm', isScanning && 'animate-spin')} />
                      <span>{isScanning ? t('扫描中...') : t('重新扫描')}</span>
                    </Button>
                  </div>

                      {/* 空间与文件统计看板 */}
                  <div className="grid grid-cols-3 gap-2">
                    <div className="p-2.5 rounded-xl border border-border/50 bg-background/80 flex flex-col justify-between shadow-2xs">
                      <div className="text-[10px] text-muted-foreground font-medium">{t('已扫描文件')}</div>
                      <div className="text-base font-extrabold text-foreground tabular-nums tracking-tight mt-1">
                        {scannedCount}
                      </div>
                    </div>
                    <div className="p-2.5 rounded-xl border border-border/50 bg-background/80 flex flex-col justify-between shadow-2xs">
                      <div className="text-[10px] text-muted-foreground font-medium">{t('冗余组数')}</div>
                      <div className="text-base font-extrabold text-foreground tabular-nums tracking-tight mt-1">
                        {statistics.totalGroups}
                      </div>
                    </div>
                    <div className="p-2.5 rounded-xl border border-emerald-500/20 bg-emerald-500/5 dark:bg-emerald-950/20 flex flex-col justify-between shadow-2xs">
                      <div className="text-[10px] text-emerald-600 dark:text-emerald-400 font-medium">{t('可释放空间')}</div>
                      <div className="text-base font-extrabold text-emerald-600 dark:text-emerald-400 tabular-nums tracking-tight mt-1 truncate" title={statistics.freedBytes}>
                        {statistics.freedBytes}
                      </div>
                    </div>
                  </div>

                  {/* 最小相似度阈值滑块与预设 (0.0 ~ 10.0 动态平滑映射) */}
                  <div className="pt-3 border-t border-border/40 space-y-2.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground font-medium flex items-center gap-1">
                        <MaterialIcon icon="tune" className="text-xs text-primary" />
                        {t('相似度匹配阈值')}
                      </span>
                      <span className="font-bold text-primary font-mono text-xs px-1.5 py-0.5 rounded-md bg-primary/10 tabular-nums">
                        {minSimilarity.toFixed(1)}
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={10}
                      step={0.1}
                      value={minSimilarity}
                      onChange={e => setMinSimilarity(Number(e.target.value))}
                      onMouseUp={() => handleScan(minSimilarity)}
                      onTouchEnd={() => handleScan(minSimilarity)}
                      className="w-full h-1.5 bg-muted rounded-lg appearance-none cursor-pointer accent-primary hover:accent-primary/80 transition-colors"
                    />
                    <div className="grid grid-cols-5 gap-1">
                      {[
                        { label: t('容差'), val: 0.0, tip: t('最大容差') },
                        { label: t('连拍'), val: 5.0, tip: t('连拍微移') },
                        { label: t('标准'), val: 7.5, tip: t('推荐标准') },
                        { label: t('严苛'), val: 9.0, tip: t('高度相似') },
                        { label: t('精确'), val: 10.0, tip: t('内容完全一致') }
                      ].map(preset => {
                        const isSelected = Math.abs(minSimilarity - preset.val) < 0.01
                        return (
                          <button
                            key={preset.val}
                            type="button"
                            title={preset.tip}
                            onClick={() => {
                              setMinSimilarity(preset.val)
                              handleScan(preset.val)
                            }}
                            className={cn(
                              'py-1 rounded-md text-[10px] font-semibold border transition-all duration-150 active:scale-95 cursor-pointer',
                              isSelected
                                ? 'bg-primary text-primary-foreground border-primary shadow-xs'
                                : 'bg-background text-muted-foreground border-border/70 hover:bg-accent hover:text-foreground'
                            )}
                          >
                            {preset.label}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                  {/* 全部发现结果 (Switch 控件控制全局筛选) */}
                  <div
                    onClick={() => setActiveStrategyFilter('all')}
                    className={cn(
                      'w-full flex items-center justify-between py-1 text-sm font-bold transition-all duration-150 shadow-2xs cursor-pointer select-none',
                      activeStrategyFilter === 'all'
                        ? 'text-primary'
                        : 'text-foreground'
                    )}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="flex flex-col">
                        <span className="truncate">{t('显示所有检出的结果')}</span>
                      </div>
                                            <Badge
                        variant="secondary"
                        className="text-xs px-2 py-0.5 h-5 font-mono font-bold rounded-md bg-muted text-foreground"
                      >
                        {duplicateGroups.length}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-2 shrink-0" onClick={e => e.stopPropagation()}>

                      <Switch
                        checked={activeStrategyFilter === 'all'}
                        onCheckedChange={checked => {
                          if (checked) {
                            setActiveStrategyFilter('all')
                          } else {
                            // 若关闭全选，默认落到第一个有结果的策略或首个策略
                            const firstStrat = duplicateGroups[0]?.strategy || STRATEGY_DEFINITIONS[0]?.key || 'all'
                            setActiveStrategyFilter(firstStrat)
                          }
                        }}
                        className="scale-90 data-[state=checked]:bg-primary"
                        title={t('切换全部结果视图')}
                      />
                    </div>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto p-2.5 space-y-2.5">


                  {STRATEGY_CATEGORIES.map(category => {
                    const catStrategies = STRATEGY_DEFINITIONS.filter(s => s.category === category.key)
                    const isCollapsed = collapsedCategories[category.key]
                    const catCount = duplicateGroups.filter(g =>
                      catStrategies.some(s => s.key === g.strategy)
                    ).length

                    return (
                      <div key={category.key} className="rounded-xl border border-border/60 bg-card/40 overflow-hidden shadow-2xs">
                        <div
                          onClick={() => toggleCategoryCollapse(category.key)}
                          className="px-3 py-2 bg-muted/40 flex items-center justify-between cursor-pointer hover:bg-muted/70 transition-colors select-none"
                        >
                          <div className="flex items-center gap-2 text-xs font-bold text-foreground">
                            <MaterialIcon
                              icon={isCollapsed ? 'chevron_right' : 'expand_more'}
                              className="text-sm text-muted-foreground"
                            />
                            <span>{category.name}</span>
                          </div>
                          {catCount > 0 && (
                            <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 font-mono font-bold bg-primary/10 text-primary">
                              {catCount}
                            </Badge>
                          )}
                        </div>

                        {!isCollapsed && (
                          <div className="p-2 space-y-1.5">
                            {catStrategies.map(strat => {
                              const count = duplicateGroups.filter(g => g.strategy === strat.key).length
                              const isActive = activeStrategyFilter === strat.key
                              const isEnabled = enabledStrategies.includes(strat.key)
                              const isDisabled = strat.disabled === true

                              return (
                                <div
                                  key={strat.key}
                                  className={cn(
                                    'w-full flex items-center justify-between px-3 py-2 rounded-xl text-sm font-semibold transition-all duration-150 group border',
                                    isActive
                                      ? 'bg-primary/10 text-primary border-primary/40 font-bold shadow-2xs'
                                      : 'text-foreground hover:bg-accent/60 hover:text-foreground border-transparent bg-background/50',
                                    isDisabled && 'opacity-40 cursor-not-allowed hover:bg-transparent hover:text-muted-foreground'
                                  )}
                                >
                                  <div
                                    className="flex items-center gap-2.5 cursor-pointer flex-1 min-w-0"
                                    onClick={() => !isDisabled && setActiveStrategyFilter(strat.key)}
                                  >
                                    <Checkbox
                                      checked={isEnabled}
                                      disabled={isDisabled}
                                      onCheckedChange={() => toggleStrategy(strat.key)}
                                      onClick={e => e.stopPropagation()}
                                      className="h-4 w-4 rounded-md data-[state=checked]:bg-primary data-[state=checked]:border-primary"
                                    />
                                    <MaterialIcon icon={strat.icon} className="text-base text-primary/80 flex-shrink-0" />
                                    <span className="truncate text-xs md:text-sm tracking-tight" title={strat.description}>{strat.label}</span>
                                    {strat.description && (
                                      <MaterialIcon
                                        icon="help_outline"
                                        className="text-base text-muted-foreground/50 group-hover:text-primary/70 flex-shrink-0 cursor-help"
                                        title={strat.description}
                                      />
                                    )}
                                  </div>

                                  <div className="flex items-center gap-1.5 flex-shrink-0">
                                    {strat.warning && (
                                      <Badge variant="outline" className="text-[11px] px-1.5 py-0 h-4 font-medium text-amber-600 border-amber-600/30 bg-amber-500/5">
                                        {strat.warning}
                                      </Badge>
                                    )}
                                    {isDisabled && (
                                      <Badge variant="outline" className="text-[11px] px-1.5 py-0 h-4 text-muted-foreground border-border/40">
                                        {t('即将推出')}
                                      </Badge>
                                    )}
                                    {count > 0 && (
                                      <Badge
                                        variant={isActive ? 'default' : 'secondary'}
                                        className={cn(
                                          'text-xs px-2 py-0.5 h-4.5 font-mono font-bold',
                                          isActive ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground'
                                        )}
                                      >
                                        {count}
                                      </Badge>
                                    )}
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          },
          // ─── 2. 中栏：对比工作台 ──────────────────────────────
          {
            id: 'duplicate-content',
            type: 'flex',
            defaultSize: 2,
            minSize: 420,
            content: (
              <div className="h-full flex flex-col overflow-hidden bg-background">
                <div className="p-3 border-b border-border/50 bg-card/40 backdrop-blur-xs flex items-center justify-between flex-wrap gap-2.5 shrink-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-bold text-foreground flex items-center gap-1.5">
                      <MaterialIcon icon="auto_fix_high" className="text-sm text-primary" />
                      {t('推荐保留规则：')}
                    </span>
                    <select
                      value={recommendRule}
                      onChange={e => handleApplyRule(e.target.value as RecommendRule)}
                      className="text-xs font-semibold h-7.5 rounded-lg border border-border bg-background px-2.5 focus:ring-1 focus:ring-primary outline-hidden shadow-2xs cursor-pointer"
                    >
                      <option value="highest_resolution">{t('★ 最高分辨率优先 (多模态推荐)')}</option>
                      <option value="highest_quality">{t('★ 最佳 AI 质量评分优先')}</option>
                      <option value="newest_modified">{t('🕒 最新修改时间优先')}</option>
                      <option value="oldest_created">{t('📅 最早创建时间优先 (保留母本)')}</option>
                      <option value="original_name">{t('📝 原始简短文件名优先')}</option>
                    </select>
                  </div>

                  <div className="flex items-center gap-3">
                    <div className="relative w-44 md:w-56">
                      <MaterialIcon
                        icon="search"
                        className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground"
                      />
                      <Input
                        value={searchKeyword}
                        onChange={e => setSearchKeyword(e.target.value)}
                        placeholder={t('搜索组名或文件名...')}
                        className="h-7.5 text-xs pl-7 pr-6 rounded-lg bg-background"
                      />
                      {searchKeyword && (
                        <button
                          type="button"
                          onClick={() => setSearchKeyword('')}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        >
                          <MaterialIcon icon="close" className="text-xs" />
                        </button>
                      )}
                    </div>

                    <div className="flex items-center gap-1.5">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleGlobalToggleAction('keep_all')}
                        disabled={duplicateGroups.length === 0 || totalSelectedCount === 0}
                        className="h-7.5 text-xs font-semibold px-2.5 gap-1.5 rounded-lg border-border hover:bg-accent/60 cursor-pointer shadow-2xs"
                        title={t('取消所有选中项，全部标记为保留')}
                      >
                        <MaterialIcon icon="done_all" className="text-sm text-emerald-600 dark:text-emerald-400" />
                        <span>{t('全保留')}</span>
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleGlobalToggleAction('invert')}
                        disabled={duplicateGroups.length === 0}
                        className="h-7.5 text-xs font-semibold px-2.5 gap-1.5 rounded-lg border-border hover:bg-accent/60 cursor-pointer shadow-2xs"
                        title={t('全局反向选择所有文件')}
                      >
                        <MaterialIcon icon="swap_horiz" className="text-sm text-primary" />
                        <span>{t('反选')}</span>
                      </Button>
                    </div>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                  {/* 扫描中顶部流式状态 Banner (不遮挡下方的实时流式结果) */}
                  {isScanning && (
                    <div className="relative overflow-hidden rounded-2xl border border-primary/25 bg-gradient-to-r from-primary/10 via-card to-background p-4 shadow-sm space-y-3">
                      {/* 背景动态流光 */}
                      <div className="absolute top-0 right-0 w-48 h-full bg-primary/5 rounded-full blur-2xl pointer-events-none -z-10 animate-pulse" />

                      <div className="flex items-center justify-between flex-wrap gap-3">
                        <div className="flex items-center gap-3">
                          <div className="relative w-10 h-10 rounded-xl bg-primary/15 border border-primary/30 flex items-center justify-center text-primary shadow-xs shrink-0">
                            <MaterialIcon icon="fingerprint" className="text-xl animate-pulse" />
                            <span className="absolute -top-1 -right-1 flex h-2.5 w-2.5">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-primary"></span>
                            </span>
                          </div>
                          <div className="space-y-0.5">
                            <div className="text-xs md:text-sm font-bold text-foreground flex items-center gap-2">
                              <span>{t('Omni 多模态双轨扫描中...')}</span>
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-primary/10 text-primary border border-primary/20">
                                <MaterialIcon icon="sync" className="text-xs animate-spin" />
                                {currentScanStage || t('特征比对中')}
                              </span>
                            </div>
                            <div className="text-[11px] text-muted-foreground">
                              {streamingScannedCount > 0
                                ? t('已扫描 {scanned} / {total} 个文件，已流式发现 {found} 个待处理组', {
                                    scanned: streamingScannedCount,
                                    total: streamingTotalCount || files.length,
                                    found: duplicateGroups.length
                                  })
                                : t('正在对 {count} 个文件进行多模态哈希比对与启发式规则分析...', {
                                    count: files.length
                                  })}
                            </div>
                          </div>
                        </div>

                        {/* 右侧阶段徽标与取消/刷新 */}
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-mono font-bold text-primary tabular-nums">
                            {streamingTotalCount > 0 && streamingScannedCount > 0
                              ? `${Math.min(100, Math.round((streamingScannedCount / streamingTotalCount) * 100))}%`
                              : ''}
                          </span>
                        </div>
                      </div>

                      {/* 线性微进度条 */}
                      <div className="h-1.5 w-full bg-muted/60 rounded-full overflow-hidden relative">
                        {streamingTotalCount > 0 && streamingScannedCount > 0 ? (
                          <div
                            className="h-full bg-primary rounded-full transition-all duration-300"
                            style={{
                              width: `${Math.min(100, Math.round((streamingScannedCount / streamingTotalCount) * 100))}%`
                            }}
                          />
                        ) : (
                          <div className="absolute inset-y-0 left-0 right-0 bg-gradient-to-r from-transparent via-primary to-transparent rounded-full animate-pulse opacity-90" />
                        )}
                      </div>
                    </div>
                  )}

                  {!hasScanned && !isScanning ? (
                    <div className="h-full min-h-[380px] flex flex-col items-center justify-center p-6 text-center select-none">
                      <div className="relative max-w-md w-full p-8 rounded-3xl border border-border/60 bg-gradient-to-b from-card/80 via-card/50 to-background/90 backdrop-blur-md shadow-lg shadow-black/5 dark:shadow-black/20 flex flex-col items-center space-y-6 transition-all duration-300 hover:border-primary/30">
                        {/* 装饰性背景微光晕 */}
                        <div className="absolute -top-10 left-1/2 -translate-x-1/2 w-48 h-48 bg-primary/10 rounded-full blur-3xl pointer-events-none -z-10" />

                        {/* 图标容器 */}
                        <div className="relative">
                          <div className="w-20 h-20 rounded-3xl bg-gradient-to-br from-primary/20 via-primary/10 to-primary/5 border border-primary/25 flex items-center justify-center text-primary shadow-inner shadow-primary/10">
                            <MaterialIcon icon="cleaning_services" className="text-4xl drop-shadow-xs" />
                          </div>
                          <span className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-background border border-primary/30 flex items-center justify-center shadow-xs text-primary">
                            <MaterialIcon icon="auto_awesome" className="text-sm" />
                          </span>
                        </div>

                        {/* 主文案与说明 */}
                        <div className="space-y-2 max-w-sm">
                          <h3 className="text-lg font-bold text-foreground tracking-tight">
                            {t('尚未开始分析此工作区')}
                          </h3>
                          <p className="text-xs text-muted-foreground leading-relaxed">
                            {t('深度检测当前工作区内的重复文件、图像相似副本、大文件及异常文件，并提供一键智能瘦身方案')}
                          </p>
                        </div>

                        {/* 能力特性胶囊 */}
                        <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-medium bg-muted/60 text-muted-foreground border border-border/40">
                            <MaterialIcon icon="fingerprint" className="text-xs text-primary" />
                            {t('多模态哈希查重')}
                          </span>
                          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-medium bg-muted/60 text-muted-foreground border border-border/40">
                            <MaterialIcon icon="image_search" className="text-xs text-primary" />
                            {t('视觉感知相似度')}
                          </span>
                          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-medium bg-muted/60 text-muted-foreground border border-border/40">
                            <MaterialIcon icon="report_problem" className="text-xs text-amber-500" />
                            {t('异常与断链排查')}
                          </span>
                        </div>

                        {/* 主操作按钮 */}
                        <div className="pt-2 w-full flex flex-col items-center gap-2">
                          <Button
                            size="lg"
                            onClick={() => handleScan()}
                            className="w-full max-w-xs h-11 text-sm font-bold gap-2.5 rounded-xl bg-gradient-to-r from-primary to-primary/90 text-primary-foreground hover:brightness-105 active:scale-[0.98] shadow-md shadow-primary/20 transition-all duration-200 cursor-pointer"
                          >
                            <span>{t('开始清理分析与查重')}</span>
                          </Button>
                        </div>
                      </div>
                    </div>
                  ) : filteredGroups.length === 0 ? (
                    <div className="h-72 flex flex-col items-center justify-center text-muted-foreground space-y-3">
                      <div className={cn(
                        "w-14 h-14 rounded-2xl flex items-center justify-center shadow-xs",
                        isScanning ? "bg-primary/10 text-primary" : "bg-emerald-500/10 text-emerald-500"
                      )}>
                        <MaterialIcon
                          icon={isScanning ? "search" : "verified"}
                          className={cn("text-3xl", isScanning && "animate-pulse")}
                        />
                      </div>
                      <div className="text-center space-y-1">
                        <div className="text-sm font-bold text-foreground">
                          {isScanning
                            ? t('正在持续比对文件特征...')
                            : activeStrategyFilter !== 'all' && duplicateGroups.length > 0
                              ? t('当前所选策略下无重复文件')
                              : t('未发现重复或冗余文件')}
                        </div>
                        <div className="text-xs text-muted-foreground max-w-sm">
                          {isScanning
                            ? t('扫描中一旦发现重复或相似组将即刻呈现在下方，请稍候')
                            : searchKeyword
                              ? t('没有找到与搜索关键词匹配的重复文件组')
                              : activeStrategyFilter !== 'all' && duplicateGroups.length > 0
                                ? t('其他策略分类中发现了 {count} 个待处理组，点击下方按钮可查看全部', { count: duplicateGroups.length })
                                : t('当前工作区文件非常整洁，无冗余副本或多余碎片')}
                        </div>
                        {activeStrategyFilter !== 'all' && duplicateGroups.length > 0 && (
                          <div className="pt-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setActiveStrategyFilter('all')}
                              className="text-xs gap-1.5 rounded-lg border-primary/40 text-primary hover:bg-primary/10"
                            >
                              <MaterialIcon icon="dashboard" className="text-sm" />
                              <span>{t('查看全部 {count} 个发现结果', { count: duplicateGroups.length })}</span>
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    filteredGroups.map((group, gIdx) => {
                      const isImage = isImageGroup(group)
                      const maxGroupSize = Math.max(...group.files.map(f => f.size || 0))
                      const bestScore = Math.max(...group.files.map(f => f.qualityScore || 0))
                      const groupSelectedCount = group.files.filter(f => f.selectedForDelete).length
                      const isTrashingThisGroup = trashingGroupId === (group.groupId || String(gIdx))

                      return (
                        <div
                          key={group.groupId || gIdx}
                          className="rounded-2xl border border-border/70 bg-card p-4 space-y-3.5 shadow-xs hover:border-border transition-colors"
                        >
                          <div className="flex items-center justify-between flex-wrap gap-2 pb-2.5 border-b border-border/40">
                            <div className="flex items-center gap-2 flex-wrap">
                              <Badge variant="secondary" className="font-bold text-xs gap-1.5 px-2.5 py-1 rounded-lg">
                                <MaterialIcon
                                  icon={
                                    group.strategy === 'invalid_symlinks' ||
                                    group.strategy === 'broken_files' ||
                                    group.strategy === 'bad_extensions' ||
                                    group.strategy === 'bad_names'
                                      ? 'error_outline'
                                      : 'hub'
                                  }
                                  className={cn(
                                    'text-xs',
                                    group.strategy === 'invalid_symlinks' ||
                                    group.strategy === 'broken_files' ||
                                    group.strategy === 'bad_extensions' ||
                                    group.strategy === 'bad_names'
                                      ? 'text-amber-500'
                                      : 'text-primary'
                                  )}
                                />
                                {group.strategy === 'exact_hash'
                                  ? t('100% 精确一致')
                                  : group.strategy === 'image_phash'
                                    ? t('视觉相似图片')
                                    : group.strategy === 'audio_hash' || group.strategy === 'audio_match'
                                      ? t('相似音乐')
                                      : group.strategy === 'video_phash' || group.strategy === 'video_keyframes'
                                        ? t('相似视频')
                                        : group.strategy === 'empty_folders'
                                          ? t('空文件夹')
                                          : group.strategy === 'big_files'
                                            ? t('超大文件')
                                            : group.strategy === 'empty_files'
                                              ? t('空文件')
                                              : group.strategy === 'temporary_files'
                                                ? t('临时缓存')
                                                : group.strategy === 'invalid_symlinks'
                                                  ? t('断裂软链接')
                                                  : group.strategy === 'broken_files'
                                                    ? t('损坏文件')
                                                    : group.strategy === 'bad_extensions'
                                                      ? t('错误扩展名')
                                                      : group.strategy === 'bad_names'
                                                        ? t('异常文件名')
                                                        : group.strategy === 'exif_remover'
                                                          ? t('Exif隐私清理')
                                                          : group.strategy === 'video_optimizer'
                                                            ? t('视频优化')
                                                            : group.strategy === 'text_simhash'
                                                              ? t('文档语义相似')
                                                              : t('副本衍生文件')}
                                                               {/* 专属指标徽章 (根据策略动态呈现贴切文案：相似度、置信度、可优化度等) */}
                              {(() => {
                                const strat = group.strategy
                                const percent = Math.round(group.similarityPercentage || 100)

                                if (strat === 'exact_hash') {
                                  return (
                                    <span className="text-xs text-emerald-600 dark:text-emerald-400 font-mono font-bold px-2 py-0.5 rounded-md bg-emerald-500/10 border border-emerald-500/20">
                                      {t('精确一致 100%')}
                                    </span>
                                  )
                                }
                                if (strat === 'broken_files') {
                                  return (
                                    <span className="text-xs text-destructive font-mono font-bold px-2 py-0.5 rounded-md bg-destructive/10 border border-destructive/20">
                                      {t('损坏置信度 100%')}
                                    </span>
                                  )
                                }
                                if (strat === 'invalid_symlinks') {
                                  return (
                                    <span className="text-xs text-amber-600 dark:text-amber-400 font-mono font-bold px-2 py-0.5 rounded-md bg-amber-500/10 border border-amber-500/20">
                                      {t('断裂失效 100%')}
                                    </span>
                                  )
                                }
                                if (strat === 'bad_extensions') {
                                  return (
                                    <span className="text-xs text-indigo-600 dark:text-indigo-400 font-mono font-bold px-2 py-0.5 rounded-md bg-indigo-500/10 border border-indigo-500/20">
                                      {t('格式置信度 100%')}
                                    </span>
                                  )
                                }
                                if (strat === 'bad_names') {
                                  return (
                                    <span className="text-xs text-amber-600 dark:text-amber-400 font-mono font-bold px-2 py-0.5 rounded-md bg-amber-500/10 border border-amber-500/20">
                                      {t('命名合规度 100%')}
                                    </span>
                                  )
                                }
                                if (strat === 'video_optimizer') {
                                  return (
                                    <span className="text-xs text-primary font-mono font-bold px-2 py-0.5 rounded-md bg-primary/10 border border-primary/20">
                                      {t('优化空间 {percent}%', { percent })}
                                    </span>
                                  )
                                }
                                if (strat === 'exif_remover') {
                                  return (
                                    <span className="text-xs text-emerald-600 dark:text-emerald-400 font-mono font-bold px-2 py-0.5 rounded-md bg-emerald-500/10 border border-emerald-500/20">
                                      {t('隐私敏感度 100%')}
                                    </span>
                                  )
                                }
                                if (strat === 'empty_files') {
                                  return (
                                    <span className="text-xs text-muted-foreground font-mono font-bold px-2 py-0.5 rounded-md bg-muted/60 border border-border/40">
                                      {t('0 字节空文件')}
                                    </span>
                                  )
                                }
                                if (strat === 'empty_folders') {
                                  return (
                                    <span className="text-xs text-muted-foreground font-mono font-bold px-2 py-0.5 rounded-md bg-muted/60 border border-border/40">
                                      {t('空文件夹')}
                                    </span>
                                  )
                                }
                                if (strat === 'temporary_files') {
                                  return (
                                    <span className="text-xs text-muted-foreground font-mono font-bold px-2 py-0.5 rounded-md bg-muted/60 border border-border/40">
                                      {t('临时缓存')}
                                    </span>
                                  )
                                }
                                if (strat === 'big_files') {
                                  return (
                                    <span className="text-xs text-amber-600 dark:text-amber-400 font-mono font-bold px-2 py-0.5 rounded-md bg-amber-500/10 border border-amber-500/20">
                                      {t('大文件排序')}
                                    </span>
                                  )
                                }

                                // 默认多模态查重（图片、音乐、视频、文档相似度）
                                return (
                                  <span className="text-xs text-emerald-600 dark:text-emerald-400 font-mono font-bold px-2 py-0.5 rounded-md bg-emerald-500/10 border border-emerald-500/20">
                                    {t('相似度 {percent}%', { percent })}
                                  </span>
                                )
                              })()}
                              </Badge>
                            </div>

                            <div className="flex items-center gap-2 flex-wrap ml-auto justify-end">
                              {/* 组快捷操作按钮 */}
                              <div className="flex items-center gap-1 bg-muted/40 p-0.5 rounded-lg border border-border/40">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleToggleGroupAction(group, 'keep_all')}
                                  className="h-6 px-2 text-[11px] text-muted-foreground hover:text-emerald-600 rounded-md cursor-pointer font-medium"
                                  title={t('本组全部保留')}
                                >
                                  {t('全保留')}
                                </Button>
                                <span className="text-border text-xs">|</span>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleToggleGroupAction(group, 'invert')}
                                  className="h-6 px-2 text-[11px] text-muted-foreground hover:text-primary rounded-md cursor-pointer font-medium"
                                  title={t('反选本组状态')}
                                >
                                  {t('反选')}
                                </Button>
                              </div>

                             

                              {/* 本组专属：执行操作按钮 (针对特殊策略显示 优化/清理/更名/修正，普通查重显示 删除) */}
                              {(() => {
                                const isVideoOpt = group.strategy === 'video_optimizer'
                                const isExif = group.strategy === 'exif_remover'
                                const isBadNames = group.strategy === 'bad_names'
                                const isBadExt = group.strategy === 'bad_extensions'

                                let actionLabel = t('删除')
                                let actionIcon = 'delete'
                                let actionVariantClass =
                                  'border-destructive/30 text-destructive hover:bg-destructive hover:text-destructive-foreground'

                                if (isVideoOpt) {
                                  actionLabel = t('优化')
                                  actionIcon = 'auto_fix_high'
                                  actionVariantClass =
                                    'border-primary/30 text-primary hover:bg-primary hover:text-primary-foreground'
                                } else if (isExif) {
                                  actionLabel = t('清理')
                                  actionIcon = 'cleaning_services'
                                  actionVariantClass =
                                    'border-emerald-500/30 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-600 hover:text-white'
                                } else if (isBadNames) {
                                  actionLabel = t('更名')
                                  actionIcon = 'drive_file_rename_outline'
                                  actionVariantClass =
                                    'border-amber-500/30 text-amber-600 dark:text-amber-400 hover:bg-amber-600 hover:text-white'
                                } else if (isBadExt) {
                                  actionLabel = t('修正')
                                  actionIcon = 'build'
                                  actionVariantClass =
                                    'border-indigo-500/30 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-600 hover:text-white'
                                }

                                const countText =
                                  groupSelectedCount > 0
                                    ? `${actionLabel} (${groupSelectedCount})`
                                    : actionLabel

                                return (
                                  <Button
                                    size="sm"
                                    variant="secondary"
                                    onClick={() => handleExecuteGroupAction(group, gIdx)}
                                    disabled={isTrashingThisGroup || isTrashing || groupSelectedCount === 0}
                                    className={cn(
                                      'h-6.5 px-2.5 text-xs font-bold gap-1 rounded-lg transition-all cursor-pointer shadow-2xs',
                                      actionVariantClass
                                    )}
                                    title={t('对本组选中的文件执行{action}', { action: actionLabel })}
                                  >
                                    <MaterialIcon
                                      icon={isTrashingThisGroup ? 'sync' : actionIcon}
                                      className={cn('text-xs', isTrashingThisGroup && 'animate-spin')}
                                    />
                                    <span>
                                      {isTrashingThisGroup
                                        ? t('处理中...')
                                        : countText}
                                    </span>
                                  </Button>
                                )
                              })()}
                            </div>
                          </div>

                          {isImage ? (
                            /* 1. 图片网格展示模式：平均分布，达到最小间隙自动换行 */
                            <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
                              {group.files.map((file, fIdx) => {
                                const isSelectedForDelete = !!file.selectedForDelete
                                const isPreviewing = previewingPath === file.path
                                const meta = fileMetaMap.get(file.path)
                                const isMaxSize = file.size === maxGroupSize && maxGroupSize > 0
                                const thumbUrl = getFileThumbnailUrl(file)
                                const ext = extractFileExtension(file.path) || extractFileExtension(file.name)

                                  const isVideoOpt = group.strategy === 'video_optimizer'
                                  const isExif = group.strategy === 'exif_remover'
                                  const isBadNames = group.strategy === 'bad_names'
                                  const isBadExt = group.strategy === 'bad_extensions'
                                  const isFixStrategy = isVideoOpt || isExif || isBadNames || isBadExt

                                  let selectedClass = 'border-destructive/60 bg-destructive/10 ring-1 ring-destructive/30 shadow-xs'
                                  if (isVideoOpt) {
                                    selectedClass = 'border-primary/60 bg-primary/10 ring-1 ring-primary/30 shadow-xs'
                                  } else if (isExif) {
                                    selectedClass = 'border-emerald-500/60 bg-emerald-500/10 ring-1 ring-emerald-500/30 shadow-xs'
                                  } else if (isBadNames) {
                                    selectedClass = 'border-amber-500/60 bg-amber-500/10 ring-1 ring-amber-500/30 shadow-xs'
                                  } else if (isBadExt) {
                                    selectedClass = 'border-indigo-500/60 bg-indigo-500/10 ring-1 ring-indigo-500/30 shadow-xs'
                                  }

                                  return (
                                    <div
                                      key={file.fileId || fIdx}
                                      onClick={() => handleSelectFileForPreview(file)}
                                      onContextMenu={(e) => handleContextMenu(e, file)}
                                      className={cn(
                                        'group relative rounded-xl border p-2.5 cursor-pointer transition-all duration-150 select-none flex flex-col justify-between',
                                        'bg-background hover:shadow-md hover:border-primary/50',
                                        isSelectedForDelete ? selectedClass : 'border-border/60 bg-background',
                                        isPreviewing && 'ring-2 ring-primary border-primary'
                                      )}
                                      title={`${file.name}\n${t('大小: {size}', { size: formatBytes(file.size) })}\n${file.resolution ? `${t('分辨率: {res}', { res: file.resolution })}\n` : ''}${t('路径: {path}', { path: file.path })}`}
                                    >
                                      {/* 顶部大 Checkbox 悬浮/固定于右上角 */}
                                      <div
                                        className="absolute top-0 right-0 z-20 shadow-xs cursor-pointer select-none"
                                        onClick={e => {
                                          e.stopPropagation()
                                          handleToggleFileSelection(group, file.path)
                                        }}
                                      >
                                        <input
                                          type="checkbox"
                                          checked={isSelectedForDelete}
                                          onChange={e => {
                                            e.stopPropagation()
                                            handleToggleFileSelection(group, file.path, e.target.checked)
                                          }}
                                          onClick={e => e.stopPropagation()}
                                          className="h-5 w-5 rounded-md border-2 border-primary text-destructive accent-destructive cursor-pointer"
                                          title={t('勾选此文件')}
                                        />
                                      </div>

                                      {/* 图片缩略图预览容器 */}
                                      <div className="w-full aspect-square rounded-lg overflow-hidden bg-muted/30 flex items-center justify-center relative mb-2 border border-border/30">
                                        {thumbUrl ? (
                                          <img
                                            src={thumbUrl}
                                            alt={file.name}
                                            loading="lazy"
                                            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                                            onError={(e) => {
                                              ;(e.target as HTMLElement).style.display = 'none'
                                            }}
                                          />
                                        ) : (
                                          <FileTypeIcon
                                            path={file.path}
                                            extension={ext}
                                            className="w-12 h-12 object-contain"
                                          />
                                        )}

                                        {/* 图片规格角标 */}
                                        {file.resolution && (
                                          <div className="absolute bottom-1 right-1 px-1 py-0.2 rounded bg-black/60 text-white text-[9px] font-mono">
                                            {file.resolution}
                                          </div>
                                        )}
                                      </div>

                                      {/* 文件名信息 (真实文件名 + 智能文件名) */}
                                      <div className="space-y-1 min-w-0">
                                        <div
                                          className={cn(
                                            'text-xs font-semibold truncate',
                                            isSelectedForDelete && !isFixStrategy ? 'text-muted-foreground line-through opacity-80' : 'text-foreground'
                                          )}
                                          title={file.name}
                                        >
                                          {file.name}
                                        </div>

                                        {meta?.smartName && meta.smartName !== file.name && (
                                          <div
                                            className="text-[11px] text-primary truncate font-medium flex items-center gap-1"
                                            title={t('智能命名: {name}', { name: meta.smartName })}
                                          >
                                            <MaterialIcon icon="auto_awesome" className="text-[10px] shrink-0" />
                                            <span className="truncate">{meta.smartName}</span>
                                          </div>
                                        )}

                                        <div className="flex items-center justify-between text-[10px] text-muted-foreground font-mono pt-1">
                                          <span>{formatBytes(file.size)}</span>
                                          {isMaxSize && group.files.length > 1 && (
                                            <span className="text-[9px] px-1 py-0 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 font-bold">
                                              {t('最大')}
                                            </span>
                                          )}
                                        </div>
                                      </div>
                                    </div>
                                  )
                                })}
                              </div>
                            ) : (
                              /* 2. 文档列表展示模式 (左侧图标/缩略图，右侧文件信息) */
                              <div className="space-y-2">
                                {group.files.map((file, fIdx) => {
                                  const isSelectedForDelete = !!file.selectedForDelete
                                  const isPreviewing = previewingPath === file.path
                                  const meta = fileMetaMap.get(file.path)
                                  const ext = extractFileExtension(file.path) || extractFileExtension(file.name)
                                  const isMaxSize = file.size === maxGroupSize && maxGroupSize > 0
                                  const isBestScore = file.qualityScore === bestScore && bestScore > 0
                                  const thumbUrl = getFileThumbnailUrl(file)

                                  const isVideoOpt = group.strategy === 'video_optimizer'
                                  const isExif = group.strategy === 'exif_remover'
                                  const isBadNames = group.strategy === 'bad_names'
                                  const isBadExt = group.strategy === 'bad_extensions'
                                  const isFixStrategy = isVideoOpt || isExif || isBadNames || isBadExt

                                  let selectedClass = 'border-destructive/60 bg-destructive/10 ring-1 ring-destructive/30 shadow-xs'
                                  if (isVideoOpt) {
                                    selectedClass = 'border-primary/60 bg-primary/10 ring-1 ring-primary/30 shadow-xs'
                                  } else if (isExif) {
                                    selectedClass = 'border-emerald-500/60 bg-emerald-500/10 ring-1 ring-emerald-500/30 shadow-xs'
                                  } else if (isBadNames) {
                                    selectedClass = 'border-amber-500/60 bg-amber-500/10 ring-1 ring-amber-500/30 shadow-xs'
                                  } else if (isBadExt) {
                                    selectedClass = 'border-indigo-500/60 bg-indigo-500/10 ring-1 ring-indigo-500/30 shadow-xs'
                                  }

                                  return (
                                    <div
                                      key={file.fileId || fIdx}
                                      onClick={() => handleSelectFileForPreview(file)}
                                      onContextMenu={(e) => handleContextMenu(e, file)}
                                      className={cn(
                                        'flex items-center justify-between p-3 rounded-xl border transition-all duration-150 cursor-pointer select-none gap-3.5',
                                        'bg-background hover:bg-accent/40',
                                        isSelectedForDelete ? selectedClass : 'border-border/60 bg-background',
                                        isPreviewing && 'ring-2 ring-primary border-primary'
                                      )}
                                    >
                                      {/* 左侧：文件图标/缩略图 + 文件名/路径信息 */}
                                      <div className="flex items-center gap-3 min-w-0 flex-1">
                                        <div className="w-10 h-10 rounded-lg bg-muted/40 flex items-center justify-center shrink-0 border border-border/40 overflow-hidden">
                                          {thumbUrl ? (
                                            <img
                                              src={thumbUrl}
                                              alt={file.name}
                                              loading="lazy"
                                              className="w-full h-full object-cover"
                                              onError={(e) => {
                                                ;(e.target as HTMLElement).style.display = 'none'
                                              }}
                                            />
                                          ) : (
                                            <FileTypeIcon
                                              path={file.path}
                                              extension={ext}
                                              className="w-7 h-7 object-contain"
                                            />
                                          )}
                                        </div>

                                        <div className="min-w-0 flex-1 space-y-1">
                                          <div className="flex items-center gap-2 flex-wrap">
                                            <span
                                              className={cn(
                                                'text-xs font-bold truncate max-w-[280px] sm:max-w-[420px]',
                                                isSelectedForDelete && !isFixStrategy
                                                  ? 'text-muted-foreground line-through opacity-80'
                                                  : 'text-foreground'
                                              )}
                                              title={file.name}
                                            >
                                              {file.name}
                                            </span>

                                          {/* 针对异常文件策略的特有字段重点高亮呈现 */}
                                          {group.strategy === 'bad_names' && file.fingerprint && (
                                            <span
                                              className="text-[11px] px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-1 border border-emerald-500/20"
                                              title={t('建议更名: {name}', { name: file.fingerprint })}
                                            >
                                              <MaterialIcon icon="drive_file_rename_outline" className="text-xs shrink-0" />
                                              <span>{t('推荐更名: {name}', { name: file.fingerprint })}</span>
                                            </span>
                                          )}

                                          {group.strategy === 'bad_extensions' && file.fingerprint && (
                                            <span
                                              className="text-[11px] px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium flex items-center gap-1 border border-amber-500/20"
                                              title={t('真实格式应为: {ext}', { ext: file.fingerprint })}
                                            >
                                              <MaterialIcon icon="extension" className="text-xs shrink-0" />
                                              <span>{t('实际格式: {ext}', { ext: file.fingerprint })}</span>
                                            </span>
                                          )}

                                          {group.strategy === 'broken_files' && file.fingerprint && (
                                            <span
                                              className="text-[11px] px-2 py-0.5 rounded-md bg-destructive/10 text-destructive font-medium flex items-center gap-1 border border-destructive/20"
                                              title={file.fingerprint}
                                            >
                                              <MaterialIcon icon="error" className="text-xs shrink-0" />
                                              <span className="truncate max-w-[220px]">{file.fingerprint}</span>
                                            </span>
                                          )}

                                          {group.strategy === 'invalid_symlinks' && file.fingerprint && (
                                            <span
                                              className="text-[11px] px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium flex items-center gap-1 border border-amber-500/20"
                                              title={file.fingerprint}
                                            >
                                              <MaterialIcon icon="link_off" className="text-xs shrink-0" />
                                              <span className="truncate max-w-[240px]">{file.fingerprint}</span>
                                            </span>
                                          )}

                                          {group.strategy === 'video_optimizer' && file.fingerprint && (
                                            <span
                                              className="text-[11px] px-2 py-0.5 rounded-md bg-primary/10 text-primary font-medium flex items-center gap-1 border border-primary/20"
                                              title={file.fingerprint}
                                            >
                                              <MaterialIcon icon="smart_display" className="text-xs shrink-0" />
                                              <span className="truncate max-w-[220px]">{file.fingerprint}</span>
                                            </span>
                                          )}
                                        </div>

                                        {meta?.smartName && meta.smartName !== file.name && group.strategy !== 'bad_names' && (
                                          <div className="text-xs text-primary font-semibold truncate flex items-center gap-1.5">
                                            <MaterialIcon icon="auto_awesome" className="text-xs shrink-0" />
                                            <span className="truncate">{meta.smartName}</span>
                                          </div>
                                        )}

                                        <div className="text-[10px] text-muted-foreground/80 font-mono truncate" title={file.path}>
                                          {file.path}
                                        </div>
                                      </div>
                                    </div>

                                    {/* 右侧：元数据信息 (大小、修改时间、质量分) + 尾部大 Checkbox */}
                                    <div className="flex items-center gap-4 text-xs font-mono text-muted-foreground shrink-0">
                                      <div className="text-right">
                                        <div className="flex items-center justify-end gap-1.5">
                                          <span className="font-bold text-foreground">{formatBytes(file.size)}</span>
                                          {isMaxSize && group.files.length > 1 && (
                                            <span className="text-[9px] px-1 py-0 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 font-bold">
                                              {t('最大')}
                                            </span>
                                          )}
                                        </div>
                                        {file.modifiedAt && (
                                          <div className="text-[10px] text-muted-foreground/70">
                                            {file.modifiedAt.split('T')[0] || file.modifiedAt}
                                          </div>
                                        )}
                                      </div>

                                      {file.qualityScore !== undefined && file.qualityScore !== null && (
                                        <div className="text-right hidden sm:block">
                                          <div className="text-[10px] text-muted-foreground">{t('质量分')}</div>
                                          <div className="font-bold text-foreground flex items-center gap-1">
                                            {file.qualityScore}
                                            {isBestScore && (
                                              <span className="text-[9px] px-1 py-0 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-bold">
                                                {t('最优')}
                                              </span>
                                            )}
                                          </div>
                                        </div>
                                      )}

                                      {/* 列表尾部的大 Checkbox */}
                                      <div
                                        className="pl-2 border-l border-border/40 flex items-center p-1 cursor-pointer select-none"
                                        onClick={e => {
                                          e.stopPropagation()
                                          handleToggleFileSelection(group, file.path)
                                        }}
                                      >
                                        <input
                                          type="checkbox"
                                          checked={isSelectedForDelete}
                                          onChange={e => {
                                            e.stopPropagation()
                                            handleToggleFileSelection(group, file.path, e.target.checked)
                                          }}
                                          onClick={e => e.stopPropagation()}
                                          className="h-5 w-5 rounded-md border-2 border-primary text-destructive accent-destructive cursor-pointer"
                                          title={t('勾选以删除此文件')}
                                        />
                                      </div>
                                    </div>
                                  </div>
                                )
                              })}
                            </div>
                          )}
                        </div>
                      )
                    })
                  )}
                </div>

                {/* 隐藏的批量处理执行触发挂载点（供顶部统一操作栏触发） */}
                <button
                  id="btn-trash-duplicates-trigger"
                  type="button"
                  onClick={handleExecuteBatchProcessAll}
                  disabled={isTrashing || isBatchProcessing || totalSelectedCount === 0}
                  className="hidden"
                  aria-hidden="true"
                />
              </div>
            )
          },
          // ─── 3. 右栏：文件预览面板 ──────────────────────────────
          {
            id: 'duplicate-preview',
            type: 'pixel',
            defaultSize: 360,
            minSize: 260,
            content: (
              <div className="h-full flex flex-col overflow-hidden bg-card/40 border-l border-border/60">
                <SplitPreviewPanel pageId={PAGE_IDS.ORGANIZE} />
              </div>
            )
          }
        ]}
      />

      {/* 4. 文件右键菜单 (对齐 FileList 组件) */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}


