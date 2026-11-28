import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { MaterialIcon, cn } from '../../../../lib/utils'
import { t } from '@app/languages'
import { Button } from '../../../ui/button'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel
} from '../../../ui/alert-dialog'
import { Badge } from '../../../ui/badge'
import { Checkbox } from '../../../ui/checkbox'
import { Switch } from '../../../ui/switch'
import { Input } from '../../../ui/input'
import { DuplicateGroup, DuplicateFileItem, DuplicateDetectionStrategy } from '@firefly/types'
import { toast } from '../../../common/Toast'
import { SplitPane } from '../../../common/SplitPane'
import { extractFileExtension } from '../../../common/FileTypeIcon'
import { SplitPreviewPanel } from '../../SplitPreviewPanel'
import { PAGE_IDS } from '../../../../constants/page-ids'
import { usePreviewOverlayStore } from '../../../../stores/preview-overlay-store'
import { ContextMenu, ContextMenuItem } from '../../../common/ContextMenu'
import { useAnalysisQueueStore } from '../../../../stores/analysis-queue-store'
import { notifyEnqueueResult } from '../../../../utils/enqueue-notifier'
import { LogCategory, logger } from '@firefly/shared'
import { resolveThumbnailUrl } from '../../FileList/components/thumbnail-url-utils'
import { DuplicateVirtualList } from './batch-duplicate-view/DuplicateVirtualList'

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
  const [isDestructiveConfirmOpen, setIsDestructiveConfirmOpen] = useState<boolean>(false)
  const [streamingScannedCount, setStreamingScannedCount] = useState<number>(0)
  const [streamingTotalCount, setStreamingTotalCount] = useState<number>(0)
  const [currentScanStage, setCurrentScanStage] = useState<string>('')

  // ffprobe 可用性检测：随包内置（lock.resources.ffprobe），仅精简/裁剪包会缺失。
  // 缺失时置灰"相似视频"与"视频优化转换"，杜绝静默 0 结果假阴性
  const [ffprobeAvailable, setFfprobeAvailable] = useState<boolean>(true)

  useEffect(() => {
    let cancelled = false
    const probe = async () => {
      try {
        const res = await window.electronAPI?.utils?.detectFfprobe?.()
        if (!cancelled) setFfprobeAvailable(Boolean(res?.available))
      } catch {
        if (!cancelled) setFfprobeAvailable(false)
      }
    }
    probe()
    return () => {
      cancelled = true
    }
  }, [])

  // Issue #738: ffprobe 缺失时将视频类策略从默认勾选中剔除，保持 UI 与实际能力一致
  useEffect(() => {
    if (!ffprobeAvailable) {
      setEnabledStrategies(prev => prev.filter(s => s !== 'video_phash' && s !== 'video_optimizer'))
    }
  }, [ffprobeAvailable])

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
        const normalizedGroups: DuplicateGroup[] = (groups || []).map(
          (g: DuplicateGroup, idx: number) => ({
            ...g,
            groupId: g.groupId || `${g.strategy}_${idx}`,
            files: (g.files || []).map((f: DuplicateFileItem) => ({ ...f }))
          })
        )
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
    // Issue #738: 缺少外部 ffprobe 时禁止启用视频类策略，避免静默 0 结果假阴性
    if (!ffprobeAvailable && (stratKey === 'video_phash' || stratKey === 'video_optimizer')) {
      toast.warning(t('需安装外部 ffprobe 依赖'))
      return
    }
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
        const calculated = await window.electronAPI.organizeBatch.applyKeepRule(
          duplicateGroups,
          rule
        )
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

  // 计算缩略图或图片直显 URL（统一使用 resolveThumbnailUrl）
  const getFileThumbnailUrl = useCallback(
    (file: DuplicateFileItem): string | null => {
      const url = resolveThumbnailUrl(file.thumbnailPath, file.path, workspaceDirectoryPath)
      return url || null
    },
    [workspaceDirectoryPath]
  )

  // 点击文件的多选框切换选择状态（selectedForDelete 代表待删除/待处理，按组独立隔离）
  // useCallback 稳定引用：虚拟行 React.memo 依赖 handler 引用稳定，避免勾选引发全列表重渲染
  const handleToggleFileSelection = useCallback(
    (targetGroup: DuplicateGroup, targetPath: string, nextChecked?: boolean) => {
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
    },
    []
  )

  // 点击文件触发右侧分栏预览
  const handleSelectFileForPreview = useCallback(
    (file: DuplicateFileItem) => {
      setPreviewingPath(file.path)
      const ext = extractFileExtension(file.path) || extractFileExtension(file.name)
      const meta = fileMetaMap.get(file.path)
      const displayTitle = meta?.smartName || file.name
      usePreviewOverlayStore.getState().openPreview(file.path, displayTitle, ext, PAGE_IDS.ORGANIZE)
    },
    [fileMetaMap]
  )

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
    [handleSelectFileForPreview]
  )

  // R-25：改为 getState() 直取稳定 action，不再整份订阅分析队列 store
  // （原全量订阅形态会让队列每次进度推送都重渲染整个查重视图）

  // 构建右键菜单项（同 FileList 组件）
  const contextMenuItems = useMemo((): ContextMenuItem[] => {
    if (!contextMenu) return []
    const file = contextMenu.file
    const ext = extractFileExtension(file.path) || extractFileExtension(file.name)
    const meta = fileMetaMap.get(file.path)
    const displayTitle = meta?.smartName || file.name

    const queueItems = useAnalysisQueueStore.getState().snapshot.items
    const addItems = useAnalysisQueueStore.getState().addItems
    const isPathEqual =
      window.electronAPI?.utils?.isPathEqual || ((p1: string, p2: string) => p1 === p2)
    const queueItem = queueItems.find(q => isPathEqual(q.path, file.path))
    const isAnalyzingOrPending =
      queueItem?.status === 'analyzing' || queueItem?.status === 'pending'
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
                const res = await addItems(
                  [
                    {
                      path: file.path,
                      name: file.name,
                      size: file.size || 0,
                      type: ext
                    }
                  ],
                  true
                )
                notifyEnqueueResult(res)
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
                const res = await addItems(
                  [
                    {
                      path: file.path,
                      name: file.name,
                      size: file.size || 0,
                      type: ext
                    }
                  ],
                  false
                )
                notifyEnqueueResult(res)
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
  }, [contextMenu, fileMetaMap])

  // 单个组内：全选删除 / 全保留 / 反选 (仅在当前组生效)
  const handleToggleGroupAction = useCallback(
    (targetGroup: DuplicateGroup, action: 'keep_all' | 'trash_all' | 'invert') => {
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
    },
    []
  )

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
  const handleExecuteGroupAction = useCallback(
    async (group: DuplicateGroup, gIdx: number) => {
      // 耗时操作（如视频优化、Exif清理）按文件大小从小到大升序排序，小文件优先秒级完成，最慢的大文件排在最后
      const sortedFiles = [...group.files]
        .filter(f => f.selectedForDelete && f.path)
        .sort((a, b) => (a.size || 0) - (b.size || 0))
      const targetPaths = sortedFiles.map(f => f.path)
      if (targetPaths.length === 0) {
        toast.warning(t('本组内未勾选任何文件'))
        return
      }

      setTrashingGroupId(group.groupId || String(gIdx))
      const isVideoOpt = group.strategy === 'video_optimizer'
      const isExifClean = group.strategy === 'exif_remover'
      const loadingToastId = isVideoOpt
        ? toast.loading(
            t('正在对 {count} 个视频进行高效能优化转码，首个完成后将自动定位...', {
              count: targetPaths.length
            })
          )
        : isExifClean
          ? toast.loading(
              t('正在处理 {count} 个图片的 Exif 隐私信息清除，首个完成后将自动定位...', {
                count: targetPaths.length
              })
            )
          : null

      try {
        if (group.strategy === 'video_optimizer') {
          const res = await window.electronAPI?.organizeBatch?.executeStrategyFix(
            'optimize',
            targetPaths,
            workspaceDirectoryPath
          )
          if (loadingToastId) toast.dismiss(loadingToastId)
          if (res?.errors && res.errors.length > 0 && res.successCount === 0) {
            toast.error(t('视频优化转码失败: {err}', { err: res.errors[0]?.error || '' }))
            return
          }
          toast.success(
            t('已完成 {count} 个视频的高效能转码优化并导出至目录', {
              count: res?.successCount || targetPaths.length
            })
          )
        } else if (group.strategy === 'exif_remover') {
          const res = await window.electronAPI?.organizeBatch?.executeStrategyFix(
            'clean_exif',
            targetPaths,
            workspaceDirectoryPath
          )
          if (loadingToastId) toast.dismiss(loadingToastId)
          if (res?.errors && res.errors.length > 0 && res.successCount === 0) {
            toast.error(t('Exif 隐私信息擦除失败: {err}', { err: res.errors[0]?.error || '' }))
            return
          }
          toast.success(
            t('已成功生成 {count} 个无 Exif 隐私信息的图片副本至目录', {
              count: res?.successCount || targetPaths.length
            })
          )
        } else if (group.strategy === 'bad_names') {
          const badNameTargets = group.files
            .filter(f => f.selectedForDelete && f.path)
            .map(f => ({ path: f.path, newName: f.fingerprint || undefined }))
          const res = await window.electronAPI?.organizeBatch?.executeStrategyFix(
            'rename_bad_name',
            badNameTargets,
            workspaceDirectoryPath
          )
          toast.success(
            t('已成功按推荐名更名 {count} 个异常文件名', {
              count: res?.successCount || targetPaths.length
            })
          )
        } else if (group.strategy === 'bad_extensions') {
          const res = await window.electronAPI?.organizeBatch?.executeStrategyFix(
            'fix_extension',
            targetPaths,
            workspaceDirectoryPath
          )
          toast.success(
            t('已成功修正 {count} 个文件的错误扩展名', {
              count: res?.successCount || targetPaths.length
            })
          )
        } else {
          await onExecuteTrash(targetPaths)
        }

        // 操作成功后从当前状态中移除已被处理的文件或组
        setDuplicateGroups(prev => {
          const nextGroups = prev
            .map(g => {
              if (g.groupId === group.groupId || prev.indexOf(g) === gIdx) {
                const remainingFiles = g.files.filter(f => !targetPaths.includes(f.path))
                return { ...g, files: remainingFiles }
              }
              return g
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
    },
    [workspaceDirectoryPath, onExecuteTrash, onFilesChanged]
  )

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
  const STRATEGY_CATEGORIES = useMemo<StrategyCategory[]>(
    () => [
      { key: 'multimodal', name: t('多模态与内容查重'), icon: 'fingerprint' },
      { key: 'cleanup', name: t('目录与空项清理'), icon: 'folder_delete' },
      { key: 'anomaly', name: t('异常与失效文件'), icon: 'report_problem' },
      { key: 'optimize', name: t('优化转换与隐私'), icon: 'tune' }
    ],
    []
  )

  // 16 大核心策略定义表 (按分类组织)
  const STRATEGY_DEFINITIONS = useMemo<StrategyDefinition[]>(
    () => [
      { key: 'exact_hash', label: t('精确内容一致'), icon: 'fingerprint', category: 'multimodal' },
      { key: 'image_phash', label: t('相似图片'), icon: 'image', category: 'multimodal' },
      { key: 'audio_hash', label: t('相似音乐'), icon: 'audiotrack', category: 'multimodal' },
      {
        key: 'video_phash',
        label: t('相似视频'),
        icon: 'videocam',
        category: 'multimodal',
        warning: t('查找耗时较长'),
        description: t('需安装外部 ffprobe 依赖'),
        disabled: !ffprobeAvailable
      },
      {
        key: 'text_simhash',
        label: t('文档语义相似'),
        icon: 'article',
        category: 'multimodal',
        disabled: true
      },
      {
        key: 'filename_heuristic',
        label: t('副本衍生文件'),
        icon: 'copy_all',
        category: 'multimodal',
        disabled: true
      },

      { key: 'empty_folders', label: t('空文件夹'), icon: 'folder_open', category: 'cleanup' },
      {
        key: 'big_files',
        label: t('超大文件'),
        icon: 'save',
        category: 'cleanup',
        description: t('发现单文件体积大于或等于 10MB 的超大文件')
      },
      { key: 'empty_files', label: t('空文件'), icon: 'insert_drive_file', category: 'cleanup' },
      { key: 'temporary_files', label: t('临时缓存'), icon: 'auto_delete', category: 'cleanup' },

      { key: 'invalid_symlinks', label: t('断裂软链接'), icon: 'link_off', category: 'anomaly' },
      { key: 'broken_files', label: t('损坏文件'), icon: 'broken_image', category: 'anomaly' },
      { key: 'bad_extensions', label: t('错误扩展名'), icon: 'extension_off', category: 'anomaly' },
      { key: 'bad_names', label: t('异常文件名'), icon: 'edit_attributes', category: 'anomaly' },

      {
        key: 'exif_remover',
        label: t('Exif隐私清理'),
        icon: 'privacy_tip',
        category: 'optimize',
        description: t(
          '扫描图片中携带的 Exif 元数据（如 GPS 定位、拍摄器材、时间等隐私），清理后将另存为无隐私副本至 .VirtualDirectory/.cleaned_exif 目录，完全保留原文件。'
        )
      },
      {
        key: 'video_optimizer',
        label: t('视频优化转换'),
        icon: 'smart_display',
        category: 'optimize',
        warning: t('优化过程耗时较长'),
        description: t(
          '采用 AV1/HEVC 高能效编码转码压缩视频，优化后将另存为高清轻量副本至 .VirtualDirectory/.video_optimizer 目录，完全保留原文件。'
        ),
        disabled: !ffprobeAvailable
      }
    ],
    [ffprobeAvailable]
  )

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

  // 计算当前勾选待处理项目的分类统计（删除/更名/修正扩展名/清理隐私/优化转码）
  const selectedActionSummary = useMemo(() => {
    let trashCount = 0
    let renameCount = 0
    let extFixCount = 0
    let exifCleanCount = 0
    let videoOptCount = 0

    for (const group of duplicateGroups) {
      for (const file of group.files) {
        if (!file.selectedForDelete || !file.path) {
          continue
        }
        if (group.strategy === 'bad_names') {
          renameCount++
        } else if (group.strategy === 'bad_extensions') {
          extFixCount++
        } else if (group.strategy === 'exif_remover') {
          exifCleanCount++
        } else if (group.strategy === 'video_optimizer') {
          videoOptCount++
        } else {
          trashCount++
        }
      }
    }

    const totalCount = trashCount + renameCount + extFixCount + exifCleanCount + videoOptCount
    const hasTrash = trashCount > 0
    const nonTrashKinds: Array<'rename' | 'extFix' | 'exif' | 'videoOpt'> = []
    if (renameCount > 0) nonTrashKinds.push('rename')
    if (extFixCount > 0) nonTrashKinds.push('extFix')
    if (exifCleanCount > 0) nonTrashKinds.push('exif')
    if (videoOptCount > 0) nonTrashKinds.push('videoOpt')

    const hasNonTrash = nonTrashKinds.length > 0
    const isPureTrash = hasTrash && !hasNonTrash
    const isPureNonTrash = !hasTrash && hasNonTrash
    const isSingleNonTrash = isPureNonTrash && nonTrashKinds.length === 1
    const singleNonTrashType = isSingleNonTrash ? nonTrashKinds[0] : null
    const distinctActionTypeCount = (hasTrash ? 1 : 0) + nonTrashKinds.length

    return {
      trashCount,
      renameCount,
      extFixCount,
      exifCleanCount,
      videoOptCount,
      totalCount,
      hasTrash,
      hasNonTrash,
      isPureTrash,
      isPureNonTrash,
      isSingleNonTrash,
      singleNonTrashType,
      distinctActionTypeCount
    }
  }, [duplicateGroups])

  // 根据当前勾选项目的实际操作类型，智能生成准确的弹窗标题、描述与确认按钮文案
  const confirmDialogConfig = useMemo(() => {
    const {
      trashCount,
      renameCount,
      extFixCount,
      exifCleanCount,
      videoOptCount,
      totalCount,
      hasTrash,
      isPureTrash,
      isPureNonTrash,
      singleNonTrashType,
      distinctActionTypeCount
    } = selectedActionSummary

    let title = t('确认执行批量处理？')
    let mainDescription = ''
    let confirmBtnText = t('确认批量处理')
    let isDestructive = hasTrash

    if (isPureTrash) {
      title = t('确认批量移入回收站？')
      mainDescription = t(
        '选中的 {count} 个文件将被移入回收站。此操作为破坏性文件清理，请核对后确认。',
        { count: totalCount }
      )
      confirmBtnText = t('确认移入回收站')
    } else if (isPureNonTrash && singleNonTrashType) {
      isDestructive = false
      if (singleNonTrashType === 'rename') {
        title = t('确认批量重命名？')
        mainDescription = t(
          '选中的 {count} 个文件将被按推荐规范重命名。此操作不包含删除，请核对后确认。',
          { count: renameCount }
        )
        confirmBtnText = t('确认重命名')
      } else if (singleNonTrashType === 'extFix') {
        title = t('确认批量修正扩展名？')
        mainDescription = t('选中的 {count} 个文件将根据真实文件类型修正扩展名，请核对后确认。', {
          count: extFixCount
        })
        confirmBtnText = t('确认修正')
      } else if (singleNonTrashType === 'exif') {
        title = t('确认批量清理隐私信息？')
        mainDescription = t(
          '选中的 {count} 个图片将清除 Exif 隐私信息并另存为无隐私副本（保留原文件），请核对后确认。',
          { count: exifCleanCount }
        )
        confirmBtnText = t('确认清理隐私')
      } else if (singleNonTrashType === 'videoOpt') {
        title = t('确认批量优化视频？')
        mainDescription = t(
          '选中的 {count} 个视频将进行转码压缩并另存为优化副本（保留原文件），请核对后确认。',
          { count: videoOptCount }
        )
        confirmBtnText = t('确认优化')
      }
    } else if (isPureNonTrash) {
      isDestructive = false
      title = t('确认执行批量处理？')
      mainDescription = t(
        '即将对选中的 {count} 个文件执行批量处理。本次操作均为非删除的安全处理，原文件均会妥善保留，请核对后确认。',
        { count: totalCount }
      )
      confirmBtnText = t('确认执行处理')
    } else {
      // 既有破坏性删除又有安全处理项 (hasTrash && hasNonTrash)
      title = t('确认执行批量处理？')
      mainDescription = t(
        '即将对选中的 {count} 个项目执行批量处理。其中包含移入回收站与安全处理项目，请仔细核对明细后确认。',
        { count: totalCount }
      )
      confirmBtnText = t('确认批量处理')
    }

    return {
      title,
      mainDescription,
      confirmBtnText,
      isDestructive,
      showDetailsCard: distinctActionTypeCount > 1
    }
  }, [selectedActionSummary])

  // 当勾选待处理文件数量变动时，即时同步给父组件（用于顶栏按钮显示：批量处理全部勾选 (N)）
  useEffect(() => {
    if (onSelectedCountChange) {
      onSelectedCountChange(totalSelectedCount)
    }
  }, [totalSelectedCount, onSelectedCountChange])

  // 批量处理全部勾选执行逻辑：
  // 破坏性操作前置二次确认弹窗防误触，确认后按策略分组依次执行
  const handleExecuteBatchProcessAll = () => {
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

    // 弹出破坏性二次确认安全弹窗 (Spec §4.4 / §7.1.1)
    setIsDestructiveConfirmOpen(true)
  }

  const executeBatchProcessConfirmed = async () => {
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

      // 阶段 2：依次执行专属修复类策略组（更名 -> 扩展名修正 -> Exif隐私清理 -> 视频优化转码）
      // 耗时较短的轻量级操作优先执行，耗时最长的视频转码放到所有分类分组的最后执行
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

      // 2.3 Exif 隐私清理 (exif_remover) - 轻量级图片处理优先执行，按文件大小升序排列
      const exifGroups = duplicateGroups.filter(g => g.strategy === 'exif_remover')
      const exifFiles: Array<{ path: string; size: number }> = []
      for (const group of exifGroups) {
        for (const file of group.files) {
          if (
            file.selectedForDelete &&
            file.path &&
            !deletedPathsSet.has(file.path) &&
            !processedPaths.has(file.path)
          ) {
            exifFiles.push({ path: file.path, size: file.size || 0 })
            processedPaths.add(file.path)
          }
        }
      }
      exifFiles.sort((a, b) => a.size - b.size)
      const exifPaths = exifFiles.map(f => f.path)

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

      // 2.4 视频优化转码 (video_optimizer) - 耗时最长的重量级任务放到所有分组最后压轴执行，内部按文件大小升序处理
      const videoOptGroups = duplicateGroups.filter(g => g.strategy === 'video_optimizer')
      const videoOptFiles: Array<{ path: string; size: number }> = []
      for (const group of videoOptGroups) {
        for (const file of group.files) {
          if (
            file.selectedForDelete &&
            file.path &&
            !deletedPathsSet.has(file.path) &&
            !processedPaths.has(file.path)
          ) {
            videoOptFiles.push({ path: file.path, size: file.size || 0 })
            processedPaths.add(file.path)
          }
        }
      }
      videoOptFiles.sort((a, b) => a.size - b.size)
      const videoOptPaths = videoOptFiles.map(f => f.path)

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

  return (
    <div data-testid="batch-duplicate-view" className="flex-1 flex overflow-hidden bg-background">
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
                        <div className="text-[10px] text-muted-foreground">
                          {t('智能查重与冗余分析')}
                        </div>
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleScan()}
                      disabled={isScanning}
                      className="h-7 text-xs gap-1 rounded-lg border-primary/30 text-primary hover:bg-primary/10 transition-all active:scale-95 shadow-2xs"
                    >
                      <MaterialIcon
                        icon="refresh"
                        className={cn('text-sm', isScanning && 'animate-spin')}
                      />
                      <span>{isScanning ? t('扫描中...') : t('重新扫描')}</span>
                    </Button>
                  </div>

                  {/* 空间与文件统计看板 */}
                  <div className="grid grid-cols-3 gap-2">
                    <div className="p-2.5 rounded-xl border border-border/50 bg-background/80 flex flex-col justify-between shadow-2xs">
                      <div className="text-[10px] text-muted-foreground font-medium">
                        {t('已扫描文件')}
                      </div>
                      <div className="text-base font-extrabold text-foreground tabular-nums tracking-tight mt-1">
                        {scannedCount}
                      </div>
                    </div>
                    <div className="p-2.5 rounded-xl border border-border/50 bg-background/80 flex flex-col justify-between shadow-2xs">
                      <div className="text-[10px] text-muted-foreground font-medium">
                        {t('冗余组数')}
                      </div>
                      <div className="text-base font-extrabold text-foreground tabular-nums tracking-tight mt-1">
                        {statistics.totalGroups}
                      </div>
                    </div>
                    <div className="p-2.5 rounded-xl border border-emerald-500/20 bg-emerald-500/5 dark:bg-emerald-950/20 flex flex-col justify-between shadow-2xs">
                      <div className="text-[10px] text-emerald-600 dark:text-emerald-400 font-medium">
                        {t('可释放空间')}
                      </div>
                      <div
                        className="text-base font-extrabold text-emerald-600 dark:text-emerald-400 tabular-nums tracking-tight mt-1 truncate"
                        title={statistics.freedBytes}
                      >
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
                      activeStrategyFilter === 'all' ? 'text-primary' : 'text-foreground'
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
                    <div
                      className="flex items-center gap-2 shrink-0"
                      onClick={e => e.stopPropagation()}
                    >
                      <Switch
                        checked={activeStrategyFilter === 'all'}
                        onCheckedChange={checked => {
                          if (checked) {
                            setActiveStrategyFilter('all')
                          } else {
                            // 若关闭全选，默认落到第一个有结果的策略或首个策略
                            const firstStrat =
                              duplicateGroups[0]?.strategy || STRATEGY_DEFINITIONS[0]?.key || 'all'
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
                    const catStrategies = STRATEGY_DEFINITIONS.filter(
                      s => s.category === category.key
                    )
                    const isCollapsed = collapsedCategories[category.key]
                    const catCount = duplicateGroups.filter(g =>
                      catStrategies.some(s => s.key === g.strategy)
                    ).length

                    return (
                      <div
                        key={category.key}
                        className="rounded-xl border border-border/60 bg-card/40 overflow-hidden shadow-2xs"
                      >
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
                            <Badge
                              variant="secondary"
                              className="text-[10px] px-1.5 py-0 h-4 font-mono font-bold bg-primary/10 text-primary"
                            >
                              {catCount}
                            </Badge>
                          )}
                        </div>

                        {!isCollapsed && (
                          <div className="p-2 space-y-1.5">
                            {catStrategies.map(strat => {
                              const count = duplicateGroups.filter(
                                g => g.strategy === strat.key
                              ).length
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
                                    isDisabled &&
                                      'opacity-40 cursor-not-allowed hover:bg-transparent hover:text-muted-foreground'
                                  )}
                                >
                                  <div
                                    className="flex items-center gap-2.5 cursor-pointer flex-1 min-w-0"
                                    onClick={() =>
                                      !isDisabled && setActiveStrategyFilter(strat.key)
                                    }
                                  >
                                    <Checkbox
                                      checked={isEnabled}
                                      disabled={isDisabled}
                                      onCheckedChange={() => toggleStrategy(strat.key)}
                                      onClick={e => e.stopPropagation()}
                                      className="h-4 w-4 rounded-md data-[state=checked]:bg-primary data-[state=checked]:border-primary"
                                    />
                                    <MaterialIcon
                                      icon={strat.icon}
                                      className="text-base text-primary/80 flex-shrink-0"
                                    />
                                    <span
                                      className="truncate text-xs md:text-sm tracking-tight"
                                      title={strat.description}
                                    >
                                      {strat.label}
                                    </span>
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
                                      <Badge
                                        variant="outline"
                                        className="text-[11px] px-1.5 py-0 h-4 font-medium text-amber-600 border-amber-600/30 bg-amber-500/5"
                                      >
                                        {strat.warning}
                                      </Badge>
                                    )}
                                    {isDisabled && (
                                      <Badge
                                        variant="outline"
                                        className="text-[11px] px-1.5 py-0 h-4 text-muted-foreground border-border/40"
                                      >
                                        {t('即将推出')}
                                      </Badge>
                                    )}
                                    {count > 0 && (
                                      <Badge
                                        variant={isActive ? 'default' : 'secondary'}
                                        className={cn(
                                          'text-xs px-2 py-0.5 h-4.5 font-mono font-bold',
                                          isActive
                                            ? 'bg-primary text-primary-foreground'
                                            : 'bg-muted text-foreground'
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
                      <option value="highest_resolution">
                        {t('★ 最高分辨率优先 (多模态推荐)')}
                      </option>
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
                        <MaterialIcon
                          icon="done_all"
                          className="text-sm text-emerald-600 dark:text-emerald-400"
                        />
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

                {/* 扫描中顶部流式状态 Banner：固定在列表上方，不随结果滚动 (不遮挡下方的实时流式结果) */}
                {isScanning && (
                  <div className="px-4 pt-4 shrink-0">
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
                                ? t(
                                    '已扫描 {scanned} / {total} 个文件，已流式发现 {found} 个待处理组',
                                    {
                                      scanned: streamingScannedCount,
                                      total: streamingTotalCount || files.length,
                                      found: duplicateGroups.length
                                    }
                                  )
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
                  </div>
                )}

                {!hasScanned && !isScanning ? (
                  <div className="flex-1 overflow-y-auto p-4">
                    <div className="h-full min-h-[380px] flex flex-col items-center justify-center p-6 text-center select-none">
                      <div className="relative max-w-md w-full p-8 rounded-3xl border border-border/60 bg-gradient-to-b from-card/80 via-card/50 to-background/90 backdrop-blur-md shadow-lg shadow-black/5 dark:shadow-black/20 flex flex-col items-center space-y-6 transition-all duration-300 hover:border-primary/30">
                        {/* 装饰性背景微光晕 */}
                        <div className="absolute -top-10 left-1/2 -translate-x-1/2 w-48 h-48 bg-primary/10 rounded-full blur-3xl pointer-events-none -z-10" />

                        {/* 图标容器 */}
                        <div className="relative">
                          <div className="w-20 h-20 rounded-3xl bg-gradient-to-br from-primary/20 via-primary/10 to-primary/5 border border-primary/25 flex items-center justify-center text-primary shadow-inner shadow-primary/10">
                            <MaterialIcon
                              icon="cleaning_services"
                              className="text-4xl drop-shadow-xs"
                            />
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
                            {t(
                              '深度检测当前工作区内的重复文件、图像相似副本、大文件及异常文件，并提供一键智能瘦身方案'
                            )}
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
                            <MaterialIcon
                              icon="report_problem"
                              className="text-xs text-amber-500"
                            />
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
                  </div>
                ) : filteredGroups.length === 0 ? (
                  <div className="flex-1 overflow-y-auto p-4">
                    <div className="h-72 flex flex-col items-center justify-center text-muted-foreground space-y-3">
                      <div
                        className={cn(
                          'w-14 h-14 rounded-2xl flex items-center justify-center shadow-xs',
                          isScanning
                            ? 'bg-primary/10 text-primary'
                            : 'bg-emerald-500/10 text-emerald-500'
                        )}
                      >
                        <MaterialIcon
                          icon={isScanning ? 'search' : 'verified'}
                          className={cn('text-3xl', isScanning && 'animate-pulse')}
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
                                ? t(
                                    '其他策略分类中发现了 {count} 个待处理组，点击下方按钮可查看全部',
                                    { count: duplicateGroups.length }
                                  )
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
                              <span>
                                {t('查看全部 {count} 个发现结果', {
                                  count: duplicateGroups.length
                                })}
                              </span>
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ) : (
                  <DuplicateVirtualList
                    groups={filteredGroups}
                    fileMetaMap={fileMetaMap}
                    previewingPath={previewingPath}
                    trashingGroupId={trashingGroupId}
                    isTrashing={isTrashing}
                    formatBytes={formatBytes}
                    getFileThumbnailUrl={getFileThumbnailUrl}
                    onToggleFileSelection={handleToggleFileSelection}
                    onSelectFileForPreview={handleSelectFileForPreview}
                    onContextMenu={handleContextMenu}
                    onToggleGroupAction={handleToggleGroupAction}
                    onExecuteGroupAction={handleExecuteGroupAction}
                  />
                )}
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

      {/* 5. 二次确认安全弹窗 (根据勾选项目类型智能适配准确描述) */}
      <AlertDialog open={isDestructiveConfirmOpen} onOpenChange={setIsDestructiveConfirmOpen}>
        <AlertDialogContent data-testid="confirm-destructive">
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmDialogConfig.title}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>{confirmDialogConfig.mainDescription}</p>

                {confirmDialogConfig.showDetailsCard && (
                  <div className="mt-2.5 space-y-1.5 rounded-lg border border-border/60 bg-muted/40 p-2.5 text-xs text-foreground/85">
                    <div className="text-[11px] font-semibold text-muted-foreground mb-1">
                      {t('待处理项目明细：')}
                    </div>
                    {selectedActionSummary.trashCount > 0 && (
                      <div className="flex items-center justify-between text-destructive">
                        <span className="flex items-center gap-1.5 font-medium">
                          <MaterialIcon icon="delete" className="text-sm" />
                          <span>{t('移入系统回收站（可还原）')}</span>
                        </span>
                        <span className="font-semibold tabular-nums">
                          {t('{count} 个文件', { count: selectedActionSummary.trashCount })}
                        </span>
                      </div>
                    )}
                    {selectedActionSummary.renameCount > 0 && (
                      <div className="flex items-center justify-between text-amber-600 dark:text-amber-400">
                        <span className="flex items-center gap-1.5 font-medium">
                          <MaterialIcon icon="drive_file_rename_outline" className="text-sm" />
                          <span>{t('按推荐规范重命名')}</span>
                        </span>
                        <span className="font-semibold tabular-nums">
                          {t('{count} 个文件', { count: selectedActionSummary.renameCount })}
                        </span>
                      </div>
                    )}
                    {selectedActionSummary.extFixCount > 0 && (
                      <div className="flex items-center justify-between text-indigo-600 dark:text-indigo-400">
                        <span className="flex items-center gap-1.5 font-medium">
                          <MaterialIcon icon="build" className="text-sm" />
                          <span>{t('修正错误扩展名')}</span>
                        </span>
                        <span className="font-semibold tabular-nums">
                          {t('{count} 个文件', { count: selectedActionSummary.extFixCount })}
                        </span>
                      </div>
                    )}
                    {selectedActionSummary.exifCleanCount > 0 && (
                      <div className="flex items-center justify-between text-emerald-600 dark:text-emerald-400">
                        <span className="flex items-center gap-1.5 font-medium">
                          <MaterialIcon icon="privacy_tip" className="text-sm" />
                          <span>{t('清理 Exif 隐私（另存副本保留原件）')}</span>
                        </span>
                        <span className="font-semibold tabular-nums">
                          {t('{count} 个图片', { count: selectedActionSummary.exifCleanCount })}
                        </span>
                      </div>
                    )}
                    {selectedActionSummary.videoOptCount > 0 && (
                      <div className="flex items-center justify-between text-primary">
                        <span className="flex items-center gap-1.5 font-medium">
                          <MaterialIcon icon="auto_fix_high" className="text-sm" />
                          <span>{t('视频转码优化（另存副本保留原件）')}</span>
                        </span>
                        <span className="font-semibold tabular-nums">
                          {t('{count} 个视频', { count: selectedActionSummary.videoOptCount })}
                        </span>
                      </div>
                    )}
                  </div>
                )}

                {selectedActionSummary.hasTrash && selectedActionSummary.hasNonTrash && (
                  <p className="text-[11px] text-muted-foreground pt-1">
                    {t(
                      '注：移入回收站的文件随时可在系统回收站中还原；更名、修正与优化类操作不删除原文件。'
                    )}
                  </p>
                )}
                {selectedActionSummary.isPureNonTrash && confirmDialogConfig.showDetailsCard && (
                  <p className="text-[11px] text-muted-foreground pt-1">
                    {t('注：本次批量处理不包含任何删除操作，原文件均会安全保留。')}
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              data-testid="confirm-destructive-cancel"
              onClick={() => setIsDestructiveConfirmOpen(false)}
            >
              {t('取消')}
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="confirm-destructive-accept"
              className={cn(
                confirmDialogConfig.isDestructive
                  ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                  : 'bg-primary text-primary-foreground hover:bg-primary/90'
              )}
              onClick={() => {
                setIsDestructiveConfirmOpen(false)
                executeBatchProcessConfirmed()
              }}
            >
              {confirmDialogConfig.confirmBtnText}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
