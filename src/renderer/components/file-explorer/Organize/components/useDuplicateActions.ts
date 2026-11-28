import React, { useCallback, useMemo } from 'react'
import { DuplicateFileItem, DuplicateGroup } from '@firefly/types'
import { LogCategory, logger } from '@firefly/shared'
import { t } from '@app/languages'
import { toast } from '../../../common/Toast'
import { extractFileExtension } from '../../../common/FileTypeIcon'
import { ContextMenuItem } from '../../../common/ContextMenu'
import { PAGE_IDS } from '../../../../constants/page-ids'
import { usePreviewOverlayStore } from '../../../../stores/preview-overlay-store'
import { useAnalysisQueueStore } from '../../../../stores/analysis-queue-store'
import { notifyEnqueueResult } from '../../../../utils/enqueue-notifier'
import { resolveThumbnailUrl } from '../../FileList/components/thumbnail-url-utils'
import {
  ConfirmDialogConfig,
  DuplicateStatistics,
  RecommendRule,
  SelectedActionSummary,
  StrategyCategory,
  StrategyDefinition
} from './batch-duplicate-view/types'
import {
  STANDALONE_GROUP_FILTER_STRATEGIES,
  applyKeepRuleLocally,
  getStrategyCategories,
  getStrategyDefinitions
} from './batch-duplicate-view/keep-rule-utils'

export interface UseDuplicateActionsParams {
  files: any[]
  workspaceDirectoryPath: string
  duplicateGroups: DuplicateGroup[]
  setDuplicateGroups: React.Dispatch<React.SetStateAction<DuplicateGroup[]>>
  setRecommendRule: React.Dispatch<React.SetStateAction<RecommendRule>>
  setPreviewingPath: React.Dispatch<React.SetStateAction<string>>
  setTrashingGroupId: React.Dispatch<React.SetStateAction<string | null>>
  setIsBatchProcessing: React.Dispatch<React.SetStateAction<boolean>>
  contextMenu: { x: number; y: number; file: DuplicateFileItem } | null
  setContextMenu: React.Dispatch<
    React.SetStateAction<{ x: number; y: number; file: DuplicateFileItem } | null>
  >
  activeStrategyFilter: string
  searchKeyword: string
  ffprobeAvailable: boolean
  onExecuteTrash: (filePaths: string[]) => Promise<void>
  onFilesChanged?: () => Promise<void> | void
}

export interface UseDuplicateActionsResult {
  fileMetaMap: Map<string, any>
  formatBytes: (bytes: number) => string
  handleApplyRule: (rule: RecommendRule) => Promise<void>
  getFileThumbnailUrl: (file: DuplicateFileItem) => string | null
  handleToggleFileSelection: (
    targetGroup: DuplicateGroup,
    targetPath: string,
    nextChecked?: boolean
  ) => void
  handleSelectFileForPreview: (file: DuplicateFileItem) => void
  handleContextMenu: (e: React.MouseEvent, file: DuplicateFileItem) => void
  contextMenuItems: ContextMenuItem[]
  handleToggleGroupAction: (
    targetGroup: DuplicateGroup,
    action: 'keep_all' | 'trash_all' | 'invert'
  ) => void
  handleGlobalToggleAction: (action: 'keep_all' | 'invert') => void
  handleExecuteGroupAction: (group: DuplicateGroup, gIdx: number) => Promise<void>
  statistics: DuplicateStatistics
  STRATEGY_CATEGORIES: StrategyCategory[]
  STRATEGY_DEFINITIONS: StrategyDefinition[]
  filteredGroups: DuplicateGroup[]
  totalSelectedCount: number
  selectedActionSummary: SelectedActionSummary
  confirmDialogConfig: ConfirmDialogConfig
  executeBatchProcessConfirmed: () => Promise<void>
}

/**
 * BatchDuplicateView 核心动作与衍生统计 Hook：
 * 抽离策略/统计/确认弹窗衍生计算、右键菜单项组装、组内/全局选择以及单组/批量执行流水线，
 * 完整保留 useMemo 与 useCallback 引用稳定性。
 */
export function useDuplicateActions({
  files,
  workspaceDirectoryPath,
  duplicateGroups,
  setDuplicateGroups,
  setRecommendRule,
  setPreviewingPath,
  setTrashingGroupId,
  setIsBatchProcessing,
  contextMenu,
  setContextMenu,
  activeStrategyFilter,
  searchKeyword,
  ffprobeAvailable,
  onExecuteTrash,
  onFilesChanged
}: UseDuplicateActionsParams): UseDuplicateActionsResult {
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
    setDuplicateGroups(prev => applyKeepRuleLocally(prev, rule))
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
    [setDuplicateGroups]
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
    [fileMetaMap, setPreviewingPath]
  )

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
    [handleSelectFileForPreview, setContextMenu]
  )

  // 构建右键菜单项（同 FileList 组件）
  const contextMenuItems: ContextMenuItem[] = useMemo((): ContextMenuItem[] => {
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
    [setDuplicateGroups]
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
              return STANDALONE_GROUP_FILTER_STRATEGIES.has(g.strategy)
                ? g.files.length > 0
                : g.files.length > 1
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
        if (loadingToastId) toast.dismiss(loadingToastId)
        setTrashingGroupId(null)
      }
    },
    [workspaceDirectoryPath, onExecuteTrash, onFilesChanged, setDuplicateGroups, setTrashingGroupId]
  )

  // 统计信息计算
  const statistics: DuplicateStatistics = useMemo(() => {
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
  const STRATEGY_CATEGORIES = useMemo<StrategyCategory[]>(() => getStrategyCategories(), [])

  // 16 大核心策略定义表 (按分类组织)
  const STRATEGY_DEFINITIONS = useMemo<StrategyDefinition[]>(
    () => getStrategyDefinitions(ffprobeAvailable),
    [ffprobeAvailable]
  )

  // 过滤后的组 (支持策略筛选和关键词搜索)
  const filteredGroups: DuplicateGroup[] = useMemo(() => {
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
  const selectedActionSummary: SelectedActionSummary = useMemo(() => {
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
  const confirmDialogConfig: ConfirmDialogConfig = useMemo(() => {
    const {
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
            return STANDALONE_GROUP_FILTER_STRATEGIES.has(g.strategy)
              ? g.files.length > 0
              : g.files.length > 1
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

  return {
    fileMetaMap,
    formatBytes,
    handleApplyRule,
    getFileThumbnailUrl,
    handleToggleFileSelection,
    handleSelectFileForPreview,
    handleContextMenu,
    contextMenuItems,
    handleToggleGroupAction,
    handleGlobalToggleAction,
    handleExecuteGroupAction,
    statistics,
    STRATEGY_CATEGORIES,
    STRATEGY_DEFINITIONS,
    filteredGroups,
    totalSelectedCount,
    selectedActionSummary,
    confirmDialogConfig,
    executeBatchProcessConfirmed
  }
}
