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

  // 执行双轨扫描 (支持全 16 种策略调度)
  const handleScan = async (overrideSimilarity?: number, overrideStrategies?: string[]) => {
    setIsScanning(true)
    setDuplicateGroups([])
    const sim = overrideSimilarity ?? minSimilarity
    const currentStrategies = overrideStrategies ?? enabledStrategies
    const targetFileIds = files.map(f => f.id).filter(Boolean)

    try {
      if (window.electronAPI?.organizeBatch?.scanDuplicates) {
        const groups = await window.electronAPI.organizeBatch.scanDuplicates({
          workspaceDirectoryPath,
          fileIds: targetFileIds.length > 0 ? targetFileIds : undefined,
          minSimilarity: sim,
          strategies: currentStrategies as DuplicateDetectionStrategy[]
        })
        const normalizedGroups: DuplicateGroup[] = (groups || []).map((g: DuplicateGroup, idx: number) => ({
          ...g,
          groupId: g.groupId || `${g.strategy}_${idx}`,
          files: (g.files || []).map((f: DuplicateFileItem) => ({ ...f }))
        }))
        setDuplicateGroups(normalizedGroups)
        setScannedCount(files.length)
        setHasScanned(true)
        toast.success(t('查重扫描完成，发现 {count} 个相似组', { count: normalizedGroups.length }))
      }
    } catch (err: any) {
      toast.error(err?.message || t('查重扫描失败'))
    } finally {
      setIsScanning(false)
    }
  }

  // 组件挂载时自动扫描
  useEffect(() => {
    handleScan()
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
    handleScan(minSimilarity, updated)
  }

  const toggleCategoryCollapse = (catKey: string) => {
    setCollapsedCategories(prev => ({
      ...prev,
      [catKey]: !prev[catKey]
    }))
  }

  // 切换保留规则
  const handleApplyRule = (rule: RecommendRule) => {
    setRecommendRule(rule)
    setDuplicateGroups(prev => {
      const updated = [...prev]
      if (window.electronAPI?.organizeBatch?.applyKeepRule) {
        window.electronAPI.organizeBatch.applyKeepRule(updated, rule)
      }
      return updated
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

  // 单组执行即时专属操作 (优化/清理/更名/修正/移入回收站)
  const handleExecuteGroupAction = async (group: DuplicateGroup, gIdx: number) => {
    const targetPaths = group.files.filter(f => f.selectedForDelete && f.path).map(f => f.path)
    if (targetPaths.length === 0) {
      toast.warning(t('本组内未勾选任何文件'))
      return
    }

    setTrashingGroupId(group.groupId || String(gIdx))
    try {
      if (group.strategy === 'video_optimizer') {
        const res = await window.electronAPI?.organizeBatch?.executeStrategyFix('optimize', targetPaths)
        toast.success(t('已完成 {count} 个视频的高效能转码优化', { count: res?.successCount || targetPaths.length }))
      } else if (group.strategy === 'exif_remover') {
        const res = await window.electronAPI?.organizeBatch?.executeStrategyFix('clean_exif', targetPaths)
        toast.success(t('已成功擦除 {count} 个图片的 Exif 隐私信息', { count: res?.successCount || targetPaths.length }))
      } else if (group.strategy === 'bad_names') {
        const res = await window.electronAPI?.organizeBatch?.executeStrategyFix('rename_bad_name', targetPaths)
        toast.success(t('已成功规范化更名 {count} 个异常文件名', { count: res?.successCount || targetPaths.length }))
      } else if (group.strategy === 'bad_extensions') {
        const res = await window.electronAPI?.organizeBatch?.executeStrategyFix('fix_extension', targetPaths)
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
    { key: 'video_phash', label: t('相似视频'), icon: 'videocam', category: 'multimodal', warning: t('耗时较长') },
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

    { key: 'exif_remover', label: t('Exif隐私清理'), icon: 'privacy_tip', category: 'optimize', description: t('扫描并移除图片/视频文件中携带的 Exif 元数据（如拍摄位置、相机型号、时间戳等隐私信息），防止隐私泄露。') },
    { key: 'video_optimizer', label: t('视频优化转换'), icon: 'smart_display', category: 'optimize', description: t('对视频进行转码压缩与格式优化，在尽量保持画质的前提下大幅减小文件体积，便于存储与分享。') }
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

  // 全局待删除文件列表：
  // 核心判定：仅将属于「删除到回收站」操作的策略（多模态查重、空文件、空文件夹、临时缓存、损坏文件、断裂软链接等）计入全局删除计数；
  // 而属于专属操作（异常文件名更名、错误扩展名修正、视频优化转码、Exif清理）的文件不属于删除操作，不计入删除到回收站计数。
  const filesToDelete = useMemo(() => {
    const list: string[] = []
    const NON_TRASH_STRATEGIES = new Set([
      'bad_names', // 对应「更名」操作
      'bad_extensions', // 对应「修正」扩展名操作
      'video_optimizer', // 对应「优化」转码操作
      'exif_remover' // 对应「清理」Exif元数据操作
    ])

    for (const group of duplicateGroups) {
      if (NON_TRASH_STRATEGIES.has(group.strategy)) continue
      for (const f of group.files) {
        if (f.selectedForDelete && f.path) {
          list.push(f.path)
        }
      }
    }
    return list
  }, [duplicateGroups])

  // 当勾选待清理文件数量变动时，即时同步给父组件（用于顶栏按钮显示：删除到回收站 (N)）
  useEffect(() => {
    if (onSelectedCountChange) {
      onSelectedCountChange(filesToDelete.length)
    }
  }, [filesToDelete.length, onSelectedCountChange])

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
                        {scannedCount || files.length}
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
                </div>

                <div className="flex-1 overflow-y-auto p-2.5 space-y-2.5">
                  {/* 全部发现结果 (Switch 控件控制全局筛选) */}
                  <div
                    onClick={() => setActiveStrategyFilter('all')}
                    className={cn(
                      'w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-sm font-bold transition-all duration-150 shadow-2xs cursor-pointer select-none',
                      activeStrategyFilter === 'all'
                        ? 'bg-primary/10 text-primary border border-primary/40 shadow-xs'
                        : 'bg-card text-foreground hover:bg-accent/80 border border-border/60'
                    )}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="flex flex-col">
                        <span className="truncate">{t('全部发现结果')}</span>
                        <span className="text-[10px] font-normal text-muted-foreground">
                          {t('显示所有策略检出的文件组')}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0" onClick={e => e.stopPropagation()}>
                      <Badge
                        variant="secondary"
                        className="text-xs px-2 py-0.5 h-5 font-mono font-bold rounded-md bg-muted text-foreground"
                      >
                        {duplicateGroups.length}
                      </Badge>
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
                            <MaterialIcon icon={category.icon} className="text-sm text-primary" />
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
                                      <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 font-medium text-amber-600 border-amber-600/30 bg-amber-500/5">
                                        {strat.warning}
                                      </Badge>
                                    )}
                                    {isDisabled && (
                                      <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 text-muted-foreground border-border/40">
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

                    <div className="text-xs font-semibold text-foreground flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-destructive/10 text-destructive border border-destructive/20">
                      <MaterialIcon icon="delete_sweep" className="text-sm" />
                      <span>{t('{count} 个待删除', { count: filesToDelete.length })}</span>
                    </div>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                  {isScanning ? (
                    <div className="h-72 flex flex-col items-center justify-center text-muted-foreground space-y-4">
                      <div className="relative flex items-center justify-center">
                        <div className="w-16 h-16 rounded-3xl bg-primary/10 flex items-center justify-center text-primary animate-pulse">
                          <MaterialIcon icon="fingerprint" className="text-3xl animate-bounce" />
                        </div>
                        <span className="absolute -top-1 -right-1 flex h-3 w-3">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                          <span className="relative inline-flex rounded-full h-3 w-3 bg-primary"></span>
                        </span>
                      </div>
                      <div className="text-center space-y-1.5">
                        <div className="text-sm font-bold text-foreground flex items-center justify-center gap-2">
                          <MaterialIcon icon="sync" className="text-sm text-primary animate-spin" />
                          <span>{t('Omni 多模态双轨扫描中...')}</span>
                        </div>
                        <div className="text-xs text-muted-foreground max-w-sm">
                          {t('正在对 {count} 个文件进行多模态哈希比对与启发式规则分析', { count: files.length })}
                        </div>
                      </div>
                    </div>
                  ) : filteredGroups.length === 0 ? (
                    <div className="h-72 flex flex-col items-center justify-center text-muted-foreground space-y-3">
                      <div className="w-14 h-14 rounded-2xl bg-emerald-500/10 text-emerald-500 flex items-center justify-center shadow-xs">
                        <MaterialIcon icon="verified" className="text-3xl" />
                      </div>
                      <div className="text-center space-y-1">
                        <div className="text-sm font-bold text-foreground">
                          {activeStrategyFilter !== 'all' && duplicateGroups.length > 0
                            ? t('当前所选策略下无重复文件')
                            : t('未发现重复或冗余文件')}
                        </div>
                        <div className="text-xs text-muted-foreground max-w-sm">
                          {searchKeyword
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
                                    variant="outline"
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
                                        className="absolute top-2 right-2 z-20 p-1 rounded-md bg-background/80 backdrop-blur-xs shadow-xs cursor-pointer select-none"
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

                {/* 隐藏的清理执行触发挂载点（供顶部统一操作栏触发） */}
                <button
                  id="btn-trash-duplicates-trigger"
                  type="button"
                  onClick={() => onExecuteTrash(filesToDelete)}
                  disabled={isTrashing || filesToDelete.length === 0}
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


