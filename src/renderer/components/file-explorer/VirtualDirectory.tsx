import {
  AIDirectoryStructure,
  BatchProgress,
  ConflictResolutionOptions,
  DirectoryNode,
  FileConflict,
  FileInfoForAI,
  OrganizeStatistics
} from '@yonuc/types'
import {
  DimensionGroup,
  DimensionTag,
  DirectoryItem,
  FileItem as FileType,
  SavedVirtualDirectory,
  SelectedTag,
  WorkspaceDirectory
} from '@yonuc/types'
import { LogCategory, logger } from '@yonuc/shared'
import React, { useEffect, useMemo, useRef, useState } from 'react'

import { AIOrganizeProgressDialog } from '../organize/AIOrganizeProgressDialog'
import { Button } from '../ui/button'
import { ConfirmOrganizeDialog } from '../organize/ConfirmOrganizeDialog'
import { ConflictResolutionDialog } from '../organize/ConflictResolutionDialog'
import { DirectoryHeader } from './DirectoryHeader'
import { EmptyFolderCleanupDialog } from '../organize/EmptyFolderCleanupDialog'
import { FileDetailsPanel } from './FileDetailsPanel'
import { FileList } from './FileList'
import { GenerateVirtualDirectoriesDialog } from '../organize/GenerateVirtualDirectoriesDialog'
import { InvitationModal } from '../invitation/InvitationModal'
import { MaterialIcon } from '../../lib/utils'
import { NoWorkspaceDirectoryMessage } from '../common/NoWorkspaceDirectoryMessage'
import { OrganizeErrorDialog } from '../organize/OrganizeErrorDialog'
import { OrganizeProgressDialog } from '../organize/OrganizeProgressDialog'
import { OrganizeResultDialog } from '../organize/OrganizeResultDialog'
import { QuotaWarningBar } from './QuotaWarningBar'
import { captureEvent } from '../../lib/posthog'
import { cn } from '../../lib/utils'
import { t } from '@app/languages'
import { toast } from '../common/Toast'
import { useAnalysisQueueStore } from '../../stores/analysis-queue-store'
import { useInvitation } from '../../hooks/useInvitation'
import { useNavigate } from 'react-router-dom'
import { useSearchStore } from '../../stores/search-store'
import { useSettingsStore } from '../../stores/settings-store'
import { useVirtualDirectoryStore } from '../../stores/virtual-directory-store'

interface VirtualDirectoryProps {
  onFileSelect?: (files: any[], isFromCheckbox?: boolean) => void
}

export const VirtualDirectory: React.FC<VirtualDirectoryProps> = ({
  onFileSelect: externalOnFileSelect
}) => {
  const navigate = useNavigate()

  const {
    invitationCount,
    isInvited,
    quota,
    refreshCount,
    isLoading: isInvitationLoading,
    redeemCode
  } = useInvitation(true)

  const {
    currentWorkspaceDirectory,
    setCurrentWorkspaceDirectory,
    dimensionGroups,
    setDimensionGroups,
    selectedTags,
    addSelectedTag,
    removeSelectedTag,
    clearSelectedTags,
    filteredFiles,
    setFilteredFiles,
    sortBy,
    sortOrder,
    viewMode,
    setSortBy,
    setSortOrder,
    setViewMode,
    savedDirectories,
    setSavedDirectories,
    addSavedDirectory,
    loadSavedDirectory,
    isLoading,
    setIsLoading,
    selectedItem,
    setSelectedItem,
    showDetailsPanel,
    setShowDetailsPanel
  } = useVirtualDirectoryStore()

  const { config, getConfigValue } = useSettingsStore()
  const [workspaceDirectories, setWorkspaceDirectories] = useState<WorkspaceDirectory[]>([])
  const [isDimensionLoading, setIsDimensionLoading] = useState(false)
  const [showDirectoryDropdown, setShowDirectoryDropdown] = useState(false)
  const [showManageModal, setShowManageModal] = useState(false)
  const [editingVirtualDirectoryId, setEditingVirtualDirectoryId] = useState<string | null>(null)
  const [editingDirectoryName, setEditingDirectoryName] = useState('')

  // 邀请相关状态
  const [showInvitationModal, setShowInvitationModal] = useState(false)
  const [machineId, setMachineId] = useState('')

  // 维度组展开状态：记录哪些维度组显示了隐藏的tag（计数为0的tag）
  const [expandedDimensionGroups, setExpandedDimensionGroups] = useState<Set<number>>(new Set())

  // 维度组折叠状态：记录哪些维度组被折叠了（用于目录树展示）
  const [collapsedDimensionGroups, setCollapsedDimensionGroups] = useState<Set<number>>(new Set())

  // 选中的标签（用于生成虚拟目录）- 需求4：从localStorage恢复
  const [selectedTagsForVirtualDir, setSelectedTagsForVirtualDir] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem('virtualDir_selectedTags')
      if (saved) {
        const parsed = JSON.parse(saved)
        return new Set(parsed)
      }
    } catch (error) {
      logger.error(LogCategory.RENDERER, 'Failed to load selected tags from localStorage:', error)
    }
    return new Set()
  })

  // 标签选择顺序栈（用于实现"后选优先"去重逻辑）- 需求4：从localStorage恢复
  const [selectionStack, setSelectionStack] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('virtualDir_selectionStack')
      if (saved) {
        return JSON.parse(saved)
      }
    } catch (error) {
      logger.error(LogCategory.RENDERER, 'Failed to load selection stack from localStorage:', error)
    }
    return []
  })

  // 已分析文件数量状态
  const [analyzedFilesCount, setAnalyzedFilesCount] = useState<number | null>(null)

  // 生成虚拟目录预览对话框
  const [showGenerateVirtualDirDialog, setShowGenerateVirtualDirDialog] = useState(false)

  // 文件勾选状态
  const [selectedFiles, setSelectedFiles] = useState<FileType[]>([])

  // 当搜索结果变化时，清理不在结果中的已选中项
  useEffect(() => {
    if (selectedFiles.length > 0) {
      const filteredPaths = new Set(filteredFiles.map(f => f.path.replace(/\\/g, '/')))
      const newSelected = selectedFiles.filter(f => filteredPaths.has(f.path.replace(/\\/g, '/')))

      if (newSelected.length !== selectedFiles.length) {
        setSelectedFiles(newSelected)
      }
    }
  }, [filteredFiles])

  // 需求4：保存选中状态到localStorage
  useEffect(() => {
    try {
      localStorage.setItem(
        'virtualDir_selectedTags',
        JSON.stringify(Array.from(selectedTagsForVirtualDir))
      )
    } catch (error) {
      logger.error(LogCategory.RENDERER, 'Failed to save selected tags to localStorage:', error)
    }
  }, [selectedTagsForVirtualDir])

  useEffect(() => {
    try {
      localStorage.setItem('virtualDir_selectionStack', JSON.stringify(selectionStack))
    } catch (error) {
      logger.error(LogCategory.RENDERER, 'Failed to save selection stack to localStorage:', error)
    }
  }, [selectionStack])

  // 监听defaultView配置变化
  useEffect(() => {
    if (config.defaultView) {
      setViewMode(config.defaultView)
    }
  }, [config.defaultView, setViewMode])

  // 整理真实目录相关状态
  const [showConfirmOrganizeDialog, setShowConfirmOrganizeDialog] = useState(false)
  const [showOrganizeProgressDialog, setShowOrganizeProgressDialog] = useState(false)
  const [showOrganizeErrorDialog, setShowOrganizeErrorDialog] = useState(false)
  const [organizePreview, setOrganizePreview] = useState<{
    fileCount: number
    directoryStructure: DirectoryNode[]
  } | null>(null)
  const [organizeProgress, setOrganizeProgress] = useState({
    currentFile: '',
    processedCount: 0,
    totalCount: 0,
    percentage: 0,
    estimatedTimeRemaining: 0
  })
  const [organizeResult, setOrganizeResult] = useState<OrganizeStatistics | null>(null)

  // 快速整理相关状态
  const [showAIProgressDialog, setShowAIProgressDialog] = useState(false)
  const [aiBatchProgress, setAIBatchProgress] = useState<BatchProgress>({
    currentBatch: 0,
    totalBatches: 0,
    processedFiles: 0,
    totalFiles: 0
  })
  const [aiGeneratedStructure, setAIGeneratedStructure] = useState<AIDirectoryStructure | null>(
    null
  )
  const [fileMapForOrganize, setFileMapForOrganize] = useState<Map<number, FileInfoForAI>>(
    new Map()
  )

  // 冲突解决相关状态
  const [showConflictDialog, setShowConflictDialog] = useState(false)
  const [conflicts, setConflicts] = useState<FileConflict[]>([])

  // 结果统计对话框
  const [showResultDialog, setShowResultDialog] = useState(false)

  // 空文件夹清理对话框
  const [showEmptyFolderCleanupDialog, setShowEmptyFolderCleanupDialog] = useState(false)
  const [emptyFolderScanPath, setEmptyFolderScanPath] = useState<string | null>(null)

  const dropdownRef = useRef<HTMLDivElement>(null!)
  const saveDropdownRef = useRef<HTMLDivElement>(null!)
  const sortDropdownRef = useRef<HTMLDivElement>(null!)

  // search store
  const { virtualDirectoryKeyword, setVirtualDirectoryKeyword, clearVirtualDirectorySearch } =
    useSearchStore()

  // 监听分析队列状态变化，自动刷新数据
  const { snapshot } = useAnalysisQueueStore()
  const lastCompletedIds = useRef<Set<number>>(new Set())
  const refreshTimer = useRef<NodeJS.Timeout | null>(null)
  const [refreshKey, setRefreshKey] = useState(Date.now())

  useEffect(() => {
    const completedItems = snapshot.items.filter(item => item.status === 'completed')
    const currentCompletedIds = new Set<number>(completedItems.map(item => item.id))

    // 检查是否有任何项目是从未完成变为已完成的（支持重新分析场景）
    let hasNewCompletion = false
    for (const id of currentCompletedIds) {
      if (!lastCompletedIds.current.has(id)) {
        hasNewCompletion = true
        break
      }
    }

    if (hasNewCompletion) {
      logger.info(LogCategory.RENDERER, `[虚拟目录] 检测到项目分析完成，准备刷新数据...`)

      if (refreshTimer.current) clearTimeout(refreshTimer.current)

      refreshTimer.current = setTimeout(() => {
        // 刷新文件列表和维度组
        loadFilteredFiles()
        loadDimensionGroups()
        setRefreshKey(Date.now()) // 更新缓存刷新 Key
        lastCompletedIds.current = currentCompletedIds
        refreshTimer.current = null
      }, 1500) // 虚拟目录刷新稍微延迟一点，等待数据库写入完全稳定
    } else if (currentCompletedIds.size !== lastCompletedIds.current.size) {
      lastCompletedIds.current = currentCompletedIds
    }
  }, [snapshot.items])

  // 组件卸载时清理定时器
  useEffect(() => {
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
    }
  }, [])

  // Load initial data
  useEffect(() => {
    loadSavedDirectoriesData()
    loadWorkspaceDirectories()
  }, [])

  // Reload files when filters or search keyword change
  useEffect(() => {
    loadFilteredFiles()
  }, [selectedTags, sortBy, sortOrder, virtualDirectoryKeyword])

  // Reload data when workspace directory or language changes
  useEffect(() => {
    if (currentWorkspaceDirectory) {
      setAnalyzedFilesCount(null)
      loadDimensionGroups()

      // If there are selected tags, clearing them will trigger useEffect dependent on selectedTags
      // to reload files. If there are no tags, we need to manually reload files.
      if (selectedTags.length > 0) {
        clearSelectedTags()
      } else {
        loadFilteredFiles()
      }
    } else {
      // 如果没有工作目录，清空所有维度组和文件
      setDimensionGroups([])
      setAnalyzedFilesCount(0)
      setFilteredFiles([])

      // Also clear virtual dir selection
      setSelectedTagsForVirtualDir(new Set())
      setSelectionStack([])
    }
  }, [currentWorkspaceDirectory, config.language])

  // Load workspace directories
  const loadWorkspaceDirectories = async () => {
    try {
      // 预加载机器ID
      try {
        const mId = await window.electronAPI!.getMachineId()
        setMachineId(mId)
      } catch (e) {
        logger.error(LogCategory.RENDERER, 'Failed to get machine ID:', e)
      }

      const directories = await window.electronAPI!.getAllWorkspaceDirectories()
      setWorkspaceDirectories(directories)
      const current = await window.electronAPI!.getCurrentWorkspaceDirectory()
      setCurrentWorkspaceDirectory(current)
    } catch (error) {
      logger.error(LogCategory.RENDERER, 'Failed to load workspace directories:', error)
    }
  }

  // 监听工作目录更新事件
  useEffect(() => {
    const unsubscribe = window.electronAPI!.onWorkspaceDirectoriesUpdated?.(() => {
      logger.info(LogCategory.RENDERER, '工作目录已更新，重新加载...')
      loadWorkspaceDirectories()
    })

    return () => {
      if (unsubscribe) {
        unsubscribe()
      }
    }
  }, [])

  // 监听忽略规则变更事件
  useEffect(() => {
    const unsubscribe = window.electronAPI!.onIgnoreRulesChanged?.(() => {
      logger.info(LogCategory.RENDERER, '忽略规则已变更，自动刷新列表...')
      // 同时刷新维度计数和文件列表
      loadDimensionGroups()
      loadFilteredFiles()
    })

    return () => {
      if (unsubscribe) {
        unsubscribe()
      }
    }
  }, [currentWorkspaceDirectory])

  // Load dimension groups with file counts
  const loadDimensionGroups = async () => {
    try {
      setIsDimensionLoading(true)

      // 获取当前语言配置
      const currentLanguage =
        config.language || getConfigValue<string>('DEFAULT_LANGUAGE') || 'zh-CN'

      // 传递当前工作目录和语言，统计该目录及其所有子目录下的文件
      const groups = await window.electronAPI!.virtualDirectory.getDimensionGroups(
        currentWorkspaceDirectory?.path
      )
      setDimensionGroups(groups)

      // 验证并清理无效的选中标签（防止切换目录后残留不存在的标签计数）
      const validTagKeys = new Set<string>()
      groups.forEach((group: DimensionGroup) => {
        group.tags.forEach((tag: DimensionTag) => {
          validTagKeys.add(`${tag.dimensionId}-${tag.tagValue}`)
        })
      })

      setSelectedTagsForVirtualDir(prev => {
        const next = new Set([...prev].filter(key => validTagKeys.has(key)))
        return next.size !== prev.size ? next : prev
      })

      setSelectionStack(prev => prev.filter(key => validTagKeys.has(key)))

      // 同时获取已分析文件数量（当前工作目录及其所有子目录）
      const count = await window.electronAPI!.virtualDirectory.getAnalyzedFilesCount(
        currentWorkspaceDirectory?.path
      )
      setAnalyzedFilesCount(count)

      // 动态更新：检查之前隐藏的tag是否现在有计数了
      // 如果某个维度组的所有tag都有计数了，自动收起展开状态
      setExpandedDimensionGroups(prev => {
        const newExpanded = new Set(prev)
        groups.forEach((group: DimensionGroup) => {
          const hasZeroCountTag = group.tags.some((tag: DimensionTag) => tag.fileCount === 0)
          // 如果该维度组没有计数为0的tag了，自动收起
          if (!hasZeroCountTag && newExpanded.has(group.id)) {
            newExpanded.delete(group.id)
          }
        })
        return newExpanded
      })
    } catch (error) {
      logger.error(LogCategory.RENDERER, 'Failed to load dimension groups:', error)
      setAnalyzedFilesCount(0)
    } finally {
      setIsDimensionLoading(false)
    }
  }

  // Load filtered files based on selected tags and search keyword
  const loadFilteredFiles = async () => {
    try {
      setIsLoading(true)
      const files = await window.electronAPI!.virtualDirectory.getFilteredFiles({
        selectedTags,
        sortBy,
        sortOrder,
        // 传递当前工作目录，显示该目录及其所有子目录下的已分析文件
        workspaceDirectoryPath: currentWorkspaceDirectory?.path,
        searchKeyword: virtualDirectoryKeyword // 传递搜索关键词到后端
      })
      setFilteredFiles(files)
    } catch (error) {
      logger.error(LogCategory.RENDERER, 'Failed to load filtered files:', error)
    } finally {
      setIsLoading(false)
    }
  }

  // Load saved virtual directories
  const loadSavedDirectoriesData = async () => {
    try {
      const saved = await window.electronAPI!.virtualDirectory.getSavedDirectories(
        currentWorkspaceDirectory?.path
      )
      setSavedDirectories(saved)
    } catch (error) {
      logger.error(LogCategory.RENDERER, 'Failed to load saved directories:', error)
    }
  }

  // Handle tag selection
  // 修改：实现单选模式，点击标签时清除其他标签，只保留当前标签（需求1：点击标签仅更新右侧区域）
  const handleTagClick = (tag: SelectedTag) => {
    clearSelectedTags()
    addSelectedTag(tag)
  }

  // Handle tag removal from breadcrumb
  const handleRemoveTag = (dimensionId: number) => {
    removeSelectedTag(dimensionId)
  }

  // 切换维度组的折叠状态（用于目录树展示）
  const toggleDimensionGroupCollapsed = (groupId: number) => {
    setCollapsedDimensionGroups(prev => {
      const newCollapsed = new Set(prev)
      if (newCollapsed.has(groupId)) {
        newCollapsed.delete(groupId)
      } else {
        newCollapsed.add(groupId)
      }
      return newCollapsed
    })
  }

  // 切换标签选中状态（用于生成虚拟目录）
  // 新增：维护selectionStack实现"后选优先"去重逻辑
  const toggleTagSelection = (dimensionId: number, tagValue: string) => {
    const key = `${dimensionId}-${tagValue}`
    setSelectedTagsForVirtualDir(prev => {
      const newSelected = new Set(prev)
      if (newSelected.has(key)) {
        newSelected.delete(key)
        // 从选择栈中移除
        setSelectionStack(prevStack => prevStack.filter(k => k !== key))
      } else {
        newSelected.add(key)
        // 添加到选择栈末尾（最高优先级）
        setSelectionStack(prevStack => [...prevStack, key])
      }
      return newSelected
    })
  }

  // 检查标签是否被选中
  const isTagSelected = (dimensionId: number, tagValue: string): boolean => {
    const key = `${dimensionId}-${tagValue}`
    return selectedTagsForVirtualDir.has(key)
  }

  // 打开生成虚拟目录预览对话框
  const handleOpenGenerateDialog = () => {
    if (!currentWorkspaceDirectory) {
      toast.warning(t('请先选择工作目录'))
      return
    }

    if (selectedTagsForVirtualDir.size === 0) {
      toast.warning(t('请至少选择一个标签'))
      return
    }

    setShowGenerateVirtualDirDialog(true)
  }

  // 确认生成虚拟目录（新实现：直接使用预览树结构）
  const handleConfirmGenerateVirtualDirectories = async (options: {
    deduplicateFiles: boolean
    openAfterGeneration: boolean
    flattenToRoot: boolean
    skipEmptyDirectories: boolean
    enableNestedClassification: boolean // 新增：嵌套分类选项
    directoryTree: any[] // 预览生成的目录树结构
    tagFileMap: Map<string, Array<{ name: string; smartName?: string; path?: string }>> // 文件映射表
  }) => {
    if (!currentWorkspaceDirectory) {
      return
    }

    setShowGenerateVirtualDirDialog(false)

    try {
      logger.info(
        LogCategory.RENDERER,
        '[VirtualDirectory] 开始生成虚拟目录，树结构:',
        options.directoryTree
      )
      logger.info(LogCategory.RENDERER, '[VirtualDirectory] 选项:', {
        flattenToRoot: options.flattenToRoot,
        skipEmptyDirectories: options.skipEmptyDirectories,
        enableNestedClassification: options.enableNestedClassification
      })

      // 将Map转换为普通对象，因为IPC不能直接传递Map
      const tagFileMapObj: any = {}
      options.tagFileMap.forEach((value, key) => {
        tagFileMapObj[key] = value
      })

      // 调用新的API直接根据预览树结构生成虚拟目录
      const result = await window.electronAPI!.virtualDirectory.generateFromPreviewTree({
        workspaceDirectoryPath: currentWorkspaceDirectory.path,
        directoryTree: options.directoryTree,
        tagFileMap: tagFileMapObj,
        options: {
          flattenToRoot: options.flattenToRoot,
          skipEmptyDirectories: options.skipEmptyDirectories
        }
      })

      logger.info(LogCategory.RENDERER, '[VirtualDirectory] 生成结果:', result)

      toast.success((result as any).message || '虚拟目录生成成功')

      // 重新加载已保存的虚拟目录列表 (串起业务逻辑)
      await loadSavedDirectoriesData()

      if (options.openAfterGeneration) {
        const virtualDirPath = `${currentWorkspaceDirectory.path}/.VirtualDirectory`
        await window.electronAPI!.utils.openPathInExplorer(virtualDirPath)
      }

      // 注意：不清空选中状态和选择栈，保持用户的勾选状态
      // 这样用户可以连续生成多个虚拟目录或重新生成
    } catch (error) {
      logger.error(LogCategory.RENDERER, 'Failed to generate virtual directories:', error)
      toast.error(
        t('生成虚拟目录失败: {error}', {
          error: error instanceof Error ? error.message : String(error)
        })
      )
    }
  }

  // 获取维度组的可见tag和隐藏tag
  const getVisibleAndHiddenTags = (group: DimensionGroup) => {
    let visibleTags = group.tags.filter((tag: DimensionTag) => tag.fileCount > 0)
    const hiddenTags = group.tags.filter((tag: DimensionTag) => tag.fileCount === 0)

    // 获取泛维度 ID 列表
    const panDimensionIds = getConfigValue<number[]>('PAN_DIMENSION_IDS') || []

    // 如果是泛维度，标签按文件计数从多到少排序
    if (panDimensionIds.includes(group.id)) {
      visibleTags = visibleTags.sort((a, b) => b.fileCount - a.fileCount)
    }

    // 从设置中读取是否显示空标签
    const showEmptyTags = getConfigValue<boolean>('SHOW_EMPTY_TAGS') ?? false

    // 根据设置决定显示哪些标签
    const tagsToShow = showEmptyTags ? group.tags : visibleTags

    return {
      visibleTags,
      hiddenTags,
      tagsToShow
    }
  }

  // 构建递归维度树结构
  interface DimensionTreeNode extends DimensionGroup {
    id: number
    name: string
    children?: DimensionTreeNode[]
    childTags?: Map<string, DimensionTreeNode[]> // 标签 -> 子维度映射
    level: number
  }

  // 递归构建维度树（支持基于 triggerTags 的细粒度层级）
  const buildDimensionTree = (
    parentId: number | null = null,
    parentTag: string | null = null,
    level = 0
  ): DimensionTreeNode[] => {
    // 获取当前层级的维度
    const currentLevelGroups = dimensionGroups.filter(group => {
      if (parentId === null) {
        // 顶级维度：没有父维度或没有triggerConditions
        return !group.triggerConditions || group.triggerConditions.length === 0
      } else {
        // 子维度：有父维度ID
        if (!group.parentDimensionIds?.includes(parentId)) {
          return false
        }

        // 如果指定了 parentTag，检查 triggerConditions
        if (parentTag && group.triggerConditions) {
          const parentDimension = dimensionGroups.find(g => g.id === parentId)
          if (!parentDimension) return false

          // 查找匹配的 triggerCondition
          const matchingCondition = group.triggerConditions.find(
            tc => tc.parentDimension === parentDimension.name
          )
          // 如果找到匹配的条件，检查 parentTag 是否在 triggerTags 中
          if (matchingCondition) {
            return matchingCondition.triggerTags?.includes(parentTag)
          }
        }

        return true
      }
    })

    // 为每个维度构建树节点
    return currentLevelGroups
      .map(group => {
        // 检查是否有子维度
        const hasChildren = dimensionGroups.some(childGroup => {
          return childGroup.parentDimensionIds?.includes(group.id)
        })

        // 如果有子维度，为每个 tag 构建子维度映射
        let childTags: Map<string, DimensionTreeNode[]> | undefined
        if (hasChildren) {
          childTags = new Map()
          group.tags.forEach(tag => {
            const children = buildDimensionTree(group.id, tag.tagValue, level + 1)
            if (children.length > 0) {
              childTags!.set(tag.tagValue, children)
            }
          })
        }

        return {
          ...group,
          level,
          childTags
        }
      })
      .sort((a, b) => a.level - b.level)
  }

  // 获取可见的维度组（树形结构）
  // 修改：始终显示完整的维度树，不根据选中状态改变（需求1：禁止左侧目录树发生跳转）
  const getVisibleDimensionGroups = (): DimensionTreeNode[] => {
    return buildDimensionTree()
  }

  // Delete a saved virtual directory (直接删除，无需确认)
  const handleDeleteDirectory = async (id: string) => {
    try {
      await window.electronAPI!.virtualDirectory.deleteDirectory(id, currentWorkspaceDirectory?.path)
      await loadSavedDirectoriesData()
      toast.success(t('虚拟目录已删除'))
    } catch (error) {
      logger.error(LogCategory.RENDERER, 'Failed to delete virtual directory:', error)
      toast.error(t('删除虚拟目录失败'))
    }
  }

  // Start editing a directory name
  const handleStartEdit = (dir: SavedVirtualDirectory) => {
    setEditingVirtualDirectoryId(dir.id)
    setEditingDirectoryName(dir.name)
  }

  // Save edited directory name
  const handleSaveEdit = async (id: string) => {
    if (!editingDirectoryName.trim()) {
      toast.warning(t('请输入虚拟目录名称'))
      return
    }

    try {
      await window.electronAPI!.virtualDirectory.renameDirectory(id, editingDirectoryName)
      await loadSavedDirectoriesData()
      setEditingVirtualDirectoryId(null)
      setEditingDirectoryName('')
      toast.success(t('重命名成功'))
    } catch (error) {
      logger.error(LogCategory.RENDERER, 'Failed to rename virtual directory:', error)
      toast.error(t('重命名虚拟目录失败'))
    }
  }

  // Cancel editing
  const handleCancelEdit = () => {
    setEditingVirtualDirectoryId(null)
    setEditingDirectoryName('')
  }

  // 确认整理
  const handleConfirmOrganize = async (createBackup: boolean) => {
    if (!currentWorkspaceDirectory || !organizePreview) {
      return
    }

    setShowConfirmOrganizeDialog(false)
    setShowOrganizeProgressDialog(true)

    try {
      let result: any

      // 判断是按虚拟目录整理还是一键整理
      if (aiGeneratedStructure) {
        // 一键整理（AI生成的结构）
        result = await window.electronAPI!.organizeRealDirectory.quickOrganize({
          workspaceDirectoryPath: currentWorkspaceDirectory.path,
          aiGeneratedStructure: aiGeneratedStructure as any
        })
      } else {
        // 按虚拟目录整理
        result = await window.electronAPI!.organizeRealDirectory.byVirtualDirectory({
          workspaceDirectoryPath: currentWorkspaceDirectory.path,
          savedDirectories
        })
      }

      setOrganizeResult(result)
      setShowOrganizeProgressDialog(false)

      // 检查是否有错误
      if (result.failedFiles > 0) {
        setShowOrganizeErrorDialog(true)
      } else {
        // 整理成功
        toast.success(t('成功移动 {count} 个文件', { count: result.movedFiles }))

        // 打开整理后的目录
        await window.electronAPI!.organizeRealDirectory.openDirectory(currentWorkspaceDirectory.path)

        // 如果是按虚拟目录整理，询问是否删除虚拟目录
        if (!aiGeneratedStructure && savedDirectories.length > 0) {
          const shouldDelete = await window.electronAPI!.utils.showMessageBox({
            type: 'question',
            title: t('整理完成'),
            message: t('整理完成！是否删除所有虚拟目录？'),
            buttons: [t('是'), t('否')],
            defaultId: 1
          })

          if (shouldDelete.response === 0) {
            await window.electronAPI!.organizeRealDirectory.deleteAllVirtualDirectories(
              currentWorkspaceDirectory.path
            )
            await loadSavedDirectoriesData()
            toast.success(t('虚拟目录已删除'))
          }
        }

        // 整理成功后，自动触发空文件夹清理（被动触发：有空文件夹才弹窗）
        try {
          const scanResult = await window.electronAPI!.emptyFolder.scan(currentWorkspaceDirectory.path)
          // scanResult 直接是数组，不是 { emptyFolders: [...] }
          if (scanResult && Array.isArray(scanResult) && scanResult.length > 0) {
            // 有空文件夹，弹出清理对话框
            setEmptyFolderScanPath(currentWorkspaceDirectory.path)
            setShowEmptyFolderCleanupDialog(true)
          }
          // 没有空文件夹，不展示任何弹窗（避免打扰）
        } catch (error: any) {
          logger.error(LogCategory.RENDERER, '扫描空文件夹失败:', error)
          // 扫描失败不影响整理流程，不显示错误提示
        }
      }

      // 清理AI生成的结构
      setAIGeneratedStructure(null)
    } catch (error: any) {
      logger.error(LogCategory.RENDERER, 'Failed to organize directory:', error)
      setShowOrganizeProgressDialog(false)
      toast.error(t('整理失败: {message}', { message: error.message }))
    }
  }

  // 取消整理
  const handleCancelOrganize = () => {
    setShowConfirmOrganizeDialog(false)
    setOrganizePreview(null)
  }

  // 确认整理为虚拟目录
  const handleConfirmOrganizeVirtualDirectory = async () => {
    if (!currentWorkspaceDirectory || !organizePreview) {
      return
    }

    setShowConfirmOrganizeDialog(false)

    try {
      // 构建文件名到完整路径的映射（从 selectedFiles 中获取）
      // 同时记录原始文件名和智能文件名，确保 AI 返回任何一个都能找到路径
      const fileNameToPath = new Map<string, string>()
      for (const file of selectedFiles) {
        // 使用原始文件名作为 key
        fileNameToPath.set(file.name, file.path)
        // 如果有智能文件名，也作为 key
        if (file.smartName) {
          fileNameToPath.set(file.smartName, file.path)
        }
      }

      // 构建 directoryTree，补充文件的完整路径
      const directoryTree = organizePreview.directoryStructure.map((dir, index) => {
        // 处理文件列表，补充完整路径
        const filesWithPath = dir.files?.map(f => {
          const fileName = typeof f === 'string' ? f : f.name
          const smartName = typeof f === 'string' ? undefined : f.smartName
          
          // 优先通过映射表找路径，如果 f 本身是对象且带路径也作为兜底
          const filePath = fileNameToPath.get(fileName) || (typeof f !== 'string' ? f.path : undefined)
          
          if (!filePath) {
            logger.warn(LogCategory.RENDERER, '[VirtualDirectory] 找不到文件路径:', fileName)
          }

          return {
            name: fileName,
            smartName,
            path: filePath
          }
        }).filter(f => f.path) // 过滤掉没有路径的文件

        return {
          name: dir.name,
          parent: dir.parent || '',
          description: dir.description,
          files: filesWithPath,
          fileCount: filesWithPath?.length || 0,
          dimensionId: (dir as any).dimensionId,
          dimensionName: (dir as any).dimensionName,
          tagValue: (dir as any).tagValue
        }
      })

      // 构建 tagFileMap：目录名 -> 文件列表
      const tagFileMap = new Map<string, Array<{ name: string; smartName?: string; path?: string }>>()
      for (const dir of directoryTree) {
        if (dir.files && dir.files.length > 0) {
          tagFileMap.set(dir.name, dir.files)
        }
      }

      // 调用虚拟目录生成服务
      const result = await window.electronAPI!.virtualDirectory.generateFromPreviewTree({
        workspaceDirectoryPath: currentWorkspaceDirectory.path,
        directoryTree,
        tagFileMap: Object.fromEntries(tagFileMap),
        options: {
          flattenToRoot: false,
          skipEmptyDirectories: true,
          enableNestedClassification: false
        }
      })

      logger.info(LogCategory.RENDERER, '[VirtualDirectory] 整理为虚拟目录结果:', result)
      toast.success((result as any).message || t('虚拟目录生成成功'))

      // 重新加载已保存的虚拟目录列表
      await loadSavedDirectoriesData()

      // 打开虚拟目录
      const virtualDirPath = `${currentWorkspaceDirectory.path}/.VirtualDirectory`
      await window.electronAPI!.utils.openPathInExplorer(virtualDirPath)

      // 创建虚拟目录后，扫描虚拟目录中的空文件夹
      try {
        const scanResult = await window.electronAPI!.emptyFolder.scan(virtualDirPath)
        // scanResult 直接是数组，不是 { emptyFolders: [...] }
        if (scanResult && Array.isArray(scanResult) && scanResult.length > 0) {
          setEmptyFolderScanPath(virtualDirPath)
          setShowEmptyFolderCleanupDialog(true)
        }
      } catch (error: any) {
        logger.error(LogCategory.RENDERER, '扫描虚拟目录空文件夹失败:', error)
      }

      // 清理AI生成的结构
      setAIGeneratedStructure(null)
    } catch (error: any) {
      logger.error(LogCategory.RENDERER, 'Failed to organize as virtual directory:', error)
      toast.error(t('整理为虚拟目录失败: {message}', { message: error.message }))
    }
  }

  // 关闭错误对话框
  const handleCloseErrorDialog = () => {
    setShowOrganizeErrorDialog(false)

    // 显示完整的统计结果对话框
    if (organizeResult) {
      setShowResultDialog(true)
    }
  }

  // 处理冲突解决
  const handleConflictResolve = async (options: ConflictResolutionOptions) => {
    setShowConflictDialog(false)
    // TODO: 实现冲突解决后的重新整理
    toast.info(t('冲突解决功能开发中，将在后续版本支持'))
  }

  // 取消冲突解决
  const handleConflictCancel = () => {
    setShowConflictDialog(false)
    setConflicts([])
    toast.info(t('已取消整理'))
  }

  // 导出错误日志
  const handleExportLog = async () => {
    if (!organizeResult || !currentWorkspaceDirectory) {
      return
    }

    try {
      const result = await window.electronAPI!.utils.showSaveDialog({
        title: t('导出错误日志'),
        defaultPath: `organize-errors-${new Date().toISOString().split('T')[0]}.json`,
        filters: [
          { name: t('JSON文件'), extensions: ['json'] },
          { name: t('所有文件'), extensions: ['*'] }
        ]
      })

      if (!result.canceled && result.filePath) {
        const logContent = JSON.stringify(
          {
            timestamp: new Date().toISOString(),
            summary: {
              totalFiles: organizeResult.totalFiles,
              movedFiles: organizeResult.movedFiles,
              failedFiles: organizeResult.failedFiles,
              createdDirectories: organizeResult.createdDirectories,
              elapsedTime: organizeResult.elapsedTime
            },
            errors: organizeResult.errors
          },
          null,
          2
        )

        // 使用IPC调用写入文件
        await window.electronAPI!.utils.writeFile(result.filePath, logContent)
        toast.success(t('错误日志已导出'))
      }
    } catch (error: any) {
      logger.error(LogCategory.RENDERER, 'Failed to export log:', error)
      toast.error(t('导出日志失败: {message}', { message: error.message }))
    }
  }

  // 一键整理真实目录
  const handleQuickOrganize = async (userInstruction?: string) => {
    console.log('[VirtualDirectory] handleQuickOrganize called', { userInstruction })
    if (!currentWorkspaceDirectory) {
      toast.warning(t('请先选择工作目录'))
      return
    }

    if (selectedFiles.length === 0) {
      toast.warning(t('请先勾选要整理的文件。小技巧：你可以利用搜索过滤内容，再使用全选'))
      return
    }

    captureEvent('点击一键整理', { 
      analyzedFilesCount,
      hasUserInstruction: !!userInstruction,
      selectedFilesCount: selectedFiles.length
    })

    try {
      // 显示AI分析进度对话框
      setShowAIProgressDialog(true)

      // 设置初始进度
      setAIBatchProgress({
        currentBatch: 0,
        totalBatches: 0,
        processedFiles: 0,
        totalFiles: 0
      })

      // 监听进度更新
      window.electronAPI!.organizeRealDirectory.onPlanProgress((progress: any) => {
        setAIBatchProgress({
          currentBatch: progress.currentBatch,
          totalBatches: progress.totalBatches,
          processedFiles: progress.processedFiles,
          totalFiles: progress.totalFiles,
          currentResult: progress.currentResult
        })
      })

      // 调用后端服务生成整理方案
      const generateOptions: any = {
        batchSize: 7,
        temperature: 0.3,
        filePaths: selectedFiles.map(f => f.path)
      }

      if (userInstruction && typeof userInstruction === 'string' && userInstruction.trim() !== '') {
        generateOptions.userInstruction = userInstruction
      }

      const safeOptions = JSON.parse(JSON.stringify(generateOptions))

      const structure = await window.electronAPI!.organizeRealDirectory.generatePlan({
        workspaceDirectoryPath: currentWorkspaceDirectory.path,
        options: safeOptions
      })

      // 移除进度监听器
      window.electronAPI!.organizeRealDirectory.removePlanProgressListener()

      // AI分析完成，保存结果
      setAIGeneratedStructure(structure as any)
      setShowAIProgressDialog(false)

      // 显示预览对话框
      setOrganizePreview({
        fileCount: structure.directories.reduce(
          (sum: number, dir: any) => sum + (dir.files?.length || 0),
          0
        ),
        directoryStructure: Array.isArray(structure.directories) ? (structure.directories as any) : []
      })
      setShowConfirmOrganizeDialog(true)
    } catch (error: any) {
      if (error && error.message && error.message.includes('CancellationRequested')) {
        logger.info(LogCategory.RENDERER, 'AI organize plan generation cancelled by user')
        return
      }

      logger.error(LogCategory.RENDERER, 'Failed to quick organize:', error)
      // 移除进度监听器
      window.electronAPI!.organizeRealDirectory.removePlanProgressListener()
      setShowAIProgressDialog(false)
      toast.error(t('一键整理失败: {message}', { message: error.message }))
    }
  }

  // 取消 AI 整理方案生成
  const handleCancelAIOrganize = async () => {
    if (currentWorkspaceDirectory) {
      try {
        await (window.electronAPI!.organizeRealDirectory as any).cancelPlan?.(currentWorkspaceDirectory.path)
        setShowAIProgressDialog(false)
        window.electronAPI!.organizeRealDirectory.removePlanProgressListener()
        toast.info(t('已取消 AI 整理方案生成'))
      } catch (error) {
        logger.error(LogCategory.RENDERER, 'Failed to cancel AI organize plan:', error)
      }
    }
  }

  // 是否所有可见文件都已选中
  const isAllVisibleItemsSelected = useMemo(() => {
    return filteredFiles.length > 0 && 
      filteredFiles.every(f => selectedFiles.some(sf => sf.path === f.path))
  }, [filteredFiles, selectedFiles])

  // 处理全选切换
  const handleToggleSelectAll = () => {
    if (isAllVisibleItemsSelected) {
      setSelectedFiles([])
    } else {
      setSelectedFiles([...filteredFiles.filter((f): f is FileType => 'size' in f)])
    }
  }

  // Handle file selection
  const handleFileSelect = (
    files: (string | FileType | DirectoryItem)[],
    isFromCheckbox = false
  ) => {
    if (isFromCheckbox) {
      // 勾选操作：更新选中的文件列表
      // 注意：FileList可能传递路径字符串数组或文件对象数组
      const newSelectedFiles = files.map(item => {
        if (typeof item === 'string') {
          // 如果是路径，从filteredFiles中找回对象
          return filteredFiles.find(f => f.path === item) as FileType
        }
        return item as FileType
      }).filter(Boolean)
      
      setSelectedFiles(newSelectedFiles)
      
      // 如果选中了至少一个，也更新详情面板的活动项
      if (newSelectedFiles.length > 0) {
        setSelectedItem(newSelectedFiles[newSelectedFiles.length - 1])
      }
    } else if (files.length > 0) {
      // 点击名称操作：仅更新详情面板显示，不改变勾选状态
      const item = files[0]
      if (typeof item !== 'string') {
        // Toggle item preview
        if (selectedItem && (item as any).path === (selectedItem as any).path) {
          setSelectedItem(null)
        } else {
          setSelectedItem(item as FileType)
        }
        setShowDetailsPanel(true)
      }
    } else {
      setSelectedItem(null)
      setShowDetailsPanel(true)
    }

    if (externalOnFileSelect) {
      externalOnFileSelect(files, isFromCheckbox)
    }
  }

  // Handle sort change
  const handleSortChange = (
    newSortBy:
      | 'name'
      | 'size'
      | 'modified'
      | 'type'
      | 'smartName'
      | 'analysisStatus'
      | 'author'
      | 'qualityScore'
      | 'language',
    newSortOrder: 'asc' | 'desc'
  ) => {
    // 将排序类型转换为后端期望的格式
    const backendSortBy = newSortBy === 'modified' ? 'date' : newSortBy
    setSortBy(backendSortBy as any)
    setSortOrder(newSortOrder)
  }

  // Handle workspace directory selection
  const handleSelectWorkspaceDirectory = async (
    directory: import('@yonuc/types').WorkspaceDirectory
  ) => {
    try {
      await window.electronAPI!.setCurrentWorkspaceDirectory(directory.path)
      setCurrentWorkspaceDirectory(directory)
      setShowDirectoryDropdown(false)
    } catch (error) {
      logger.error(LogCategory.RENDERER, 'Failed to set current workspace directory:', error)
    }
  }

  // Add new workspace directory
  const handleAddWorkspaceDirectory = async (type: 'SPEEDY' | 'PRIVATE' = 'SPEEDY') => {
    // 私有目录完全限制取消，所有逻辑已移至分析阶段
    try {
      const result = await window.electronAPI!.utils.showOpenDialog({
        properties: ['openDirectory']
      })

      if (!result.canceled && result.filePaths.length > 0) {
        const directoryPath = result.filePaths[0]
        const directoryName = directoryPath.split(/[\\/]/).pop() || directoryPath

        const newDirectory: WorkspaceDirectory = {
          path: directoryPath,
          name: directoryName,
          type: type,
          recursive: true,
          isActive: true,
          lastScanAt: undefined,
          createdAt: new Date(),
          updatedAt: new Date()
        }

        await window.electronAPI!.addWorkspaceDirectory(newDirectory)

        // Reload workspace directories
        const directories = await window.electronAPI!.getAllWorkspaceDirectories()
        setWorkspaceDirectories(directories)

        // Set as current directory
        await handleSelectWorkspaceDirectory(newDirectory)
      }
    } catch (error: any) {
      logger.error(LogCategory.RENDERER, 'Failed to add workspace directory:', error)
      const msg = error instanceof Error ? error.message : t('添加工作目录失败')
      // 提取实际错误消息，去掉 IPC 调用前缀
      toast.error(msg.replace(/^Error invoking remote method.*?: Error: /, ''), 5000)
    }
  }

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDirectoryDropdown(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const visibleGroups = getVisibleDimensionGroups()

  // 递归渲染维度树节点（支持基于 triggerTags 的子维度展示）
  const renderDimensionTreeNode = (node: DimensionTreeNode, parentTagValue?: string, parentIndent = 0, isFirstDimension = false): React.ReactNode => {
    // 优先级逻辑：如果存在当前父标签下的上下文统计结果，则优先使用上下文统计
    // 语言维度的展示由后端 contextualTags 通过文件类型过滤控制：
    // - 脚本上下文：只统计脚本文件的语言标签
    // - 文档/电子书上下文：只统计文档/电子书文件的语言标签
    let tagsToUse = node.tags
    if (parentTagValue && node.contextualTags && node.contextualTags[parentTagValue]) {
      tagsToUse = node.contextualTags[parentTagValue]
    }

    const { tagsToShow } = getVisibleAndHiddenTags({ ...node, tags: tagsToUse })
    const isCollapsed = collapsedDimensionGroups.has(node.id)
    const indentLevel = parentIndent + node.level * 10 // 累积缩进
    const isTopLevel = node.level === 0 // 是否为顶级维度

    return (
      <div key={`${node.id}-${parentTagValue || 'root'}`} className="dimension-group" style={{ marginLeft: `${indentLevel}px` }}>
        {/* 维度组头部（目录名） - 只显示一级维度名称 */}
        {isTopLevel && (
          <div className="flex items-center justify-between mb-2">
            <h3
              className="text-sm font-semibold text-foreground dark:text-foreground hover:text-primary dark:hover:text-primary cursor-pointer transition-colors flex items-center flex-1"
              onClick={() => toggleDimensionGroupCollapsed(node.id)}
            >
              {/* 折叠/展开图标 */}
              <MaterialIcon
                icon={isCollapsed ? 'chevron_right' : 'expand_more'}
                className="text-base mr-1"
              />
              {node.name}
            </h3>
            {isFirstDimension && (
              <button
                className="px-2 py-1 text-xs font-medium text-primary hover:text-background bg-card dark:bg-card border border-primary/20 dark:border-primary/40 rounded hover:bg-primary dark:hover:bg-primary transition-colors flex items-center"
                onClick={handleOpenGenerateDialog}
                title={selectedTagsForVirtualDir.size > 0 
                  ? t('生成 {count} 个虚拟目录', { count: selectedTagsForVirtualDir.size }) 
                  : t('生成虚拟目录')}
              >
                <MaterialIcon icon="create_new_folder" className="text-sm mr-1" />
                {t('生成虚拟目录')}
                {selectedTagsForVirtualDir.size > 0 && (
                  <span className="ml-1">({selectedTagsForVirtualDir.size})</span>
                )}
              </button>
            )}
          </div>
        )}

        {/* 标签列表（子目录） - 只在未折叠时显示 */}
        {!isCollapsed && (
          <>
            <div className={cn('space-y-1.5', isTopLevel && 'ml-4')}>
              {tagsToShow.map((tag: DimensionTag, index: number) => {
                const isSelected = isTagSelected(tag.dimensionId, tag.tagValue)
                const isDisabled = tag.fileCount === 0
                // 检查该标签下是否有子维度
                const hasChildDimensions = node.childTags && node.childTags.has(tag.tagValue)

                return (
                  <React.Fragment key={`${tag.dimensionId}-${tag.tagValue}-${index}`}>
                    <div className="flex items-center space-x-2 group">
                      {/* Checkbox */}
                      <input
                        type="checkbox"
                        checked={isSelected}
                        disabled={isDisabled}
                        onChange={() => toggleTagSelection(tag.dimensionId, tag.tagValue)}
                        className={cn(
                          'w-4 h-4 rounded border-border dark:border-border',
                          isDisabled
                            ? 'cursor-not-allowed opacity-50'
                            : 'cursor-pointer accent-primary'
                        )}
                      />

                      {/* 标签文本（无外框） */}
                      <button
                        className={cn(
                          'flex-1 text-xs px-2 py-1 flex items-center transition-colors rounded-sm',
                          isSelected && 'bg-primary/10 text-primary font-medium', // 选中状态增强显示
                          isDisabled
                            ? 'text-muted-foreground/50 dark:text-muted-foreground/50 cursor-not-allowed'
                            : 'text-foreground dark:text-foreground hover:bg-accent dark:hover:bg-accent hover:text-primary dark:hover:text-primary'
                        )}
                        onClick={() => {
                          if (!isDisabled) {
                            handleTagClick({
                              dimensionId: tag.dimensionId,
                              dimensionName: tag.dimensionName,
                              tagValue: tag.tagValue,
                              level: tag.level
                            })
                          }
                        }}
                        disabled={isDisabled}
                      >
                        <span className="flex-1 text-left">{tag.tagValue}</span>
                        <span
                          className={cn(
                            'text-[10px] ml-1',
                            isDisabled
                              ? 'text-muted-foreground/30 dark:text-muted-foreground/30'
                              : 'text-muted-foreground dark:text-muted-foreground'
                          )}
                        >
                          ({tag.fileCount})
                        </span>
                      </button>
                    </div>

                    {/* 渲染该标签下的子维度（如果有） */}
                    {hasChildDimensions && (
                      <div className="ml-4 mt-1 border-l border-border/50">
                        {node
                          .childTags!.get(tag.tagValue)!
                          .map(childNode => renderDimensionTreeNode(childNode, tag.tagValue, 0))}
                      </div>
                    )}
                  </React.Fragment>
                )
              })}
            </div>
          </>
        )}

        {isTopLevel && <div className="border-t border-border dark:border-border my-3"></div>}
      </div>
    )
  }

  // 检查当前工作目录是否有已分析的文件
  // 通过所有维度标签的文件数量来判断，而不是通过当前过滤后的文件列表
  const hasAnalyzedFiles = (analyzedFilesCount ?? 0) > 0

  // 保存按钮是否应该禁用
  const isSaveButtonDisabled = !hasAnalyzedFiles || !currentWorkspaceDirectory

  // 搜索处理函数
  const handleSearch = (keyword: string) => {
    setVirtualDirectoryKeyword(keyword)
  }


  return (
    <div className="flex-1 flex flex-col bg-muted/10 overflow-hidden">
      {/* Shared Header */}
      <DirectoryHeader
        currentWorkspaceDirectory={currentWorkspaceDirectory}
        workspaceDirectories={workspaceDirectories}
        showDirectoryDropdown={showDirectoryDropdown}
        isRealDirectory={false}
        onToggleDirectoryDropdown={() => setShowDirectoryDropdown(!showDirectoryDropdown)}
        onSelectWorkspaceDirectory={handleSelectWorkspaceDirectory}
        onAddWorkspaceDirectory={handleAddWorkspaceDirectory}
        dropdownRef={dropdownRef}
        onSearch={handleSearch}
      />

      {/* Main Content */}
      {currentWorkspaceDirectory ? (
        <div className="flex flex-1 flex-col overflow-hidden">
          <QuotaWarningBar
            quota={quota}
            currentWorkspaceDirectory={currentWorkspaceDirectory}
            machineId={machineId}
            setMachineId={setMachineId}
            setShowInvitationModal={setShowInvitationModal}
            />
          <div className="flex flex-1 overflow-x-auto overflow-y-hidden">
            {/* Left Sidebar - Tag Filters */}
            <aside className="w-64 flex-shrink-0 bg-card border-r border-border flex flex-col overflow-y-auto custom-scrollbar">
              <div className="flex-1 p-4 space-y-4">
                {isDimensionLoading && visibleGroups.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground dark:text-muted-foreground">
                    <div className="inline-block animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-primary dark:border-primary mb-2"></div>
                    <p className="text-sm">{t('加载中...')}</p>
                  </div>
                ) : visibleGroups.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <p className="text-sm">{t('暂无可用维度')}</p>
                  </div>
                ) : (
                  visibleGroups.map((node, index) => renderDimensionTreeNode(node, undefined, 0, index === 0))
                )}
              </div>
            </aside>

            {/* Main Content Area */}
            <main className="flex-1 min-w-0 bg-card dark:bg-card overflow-hidden flex">
              <div className="flex-1 min-w-0 flex flex-col">
                {/* Breadcrumb and Controls */}
                {/* 修改：面包屑显示单个选中标签，不使用箭头分隔（需求1：显示选中的单个标签）*/}
                <div className="border-b border-border dark:border-border px-4 py-2 flex items-center justify-between bg-muted/20">
                  <div className="flex items-center space-x-4 text-sm overflow-x-auto whitespace-nowrap flex-1 min-w-0">
                    <div className="flex items-center space-x-2 flex-shrink-0">
                      {selectedTags.length === 0 ? (
                        <span className="text-muted-foreground dark:text-muted-foreground">
                          {t('所有已分析文件')}
                        </span>
                      ) : (
                        <span className="bg-primary/10 dark:bg-primary/20 border border-primary dark:border-primary rounded-2xl px-2 flex items-center flex-shrink-0 text-primary dark:text-primary font-medium">
                          {selectedTags[0].tagValue}
                          <button
                            className="ml-2 text-primary hover:text-primary hover:bg-primary/20 rounded-full p-0.5 transition-colors"
                            onClick={() => handleRemoveTag(selectedTags[0].dimensionId)}
                          >
                            <MaterialIcon icon="close" className="text-sm" />
                          </button>
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center space-x-2 text-foreground dark:text-foreground">
                    {/* View Mode Toggle */}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 p-0 text-foreground dark:text-foreground hover:bg-accent dark:hover:bg-accent"
                      onClick={async () => {
                        const newMode = viewMode === 'list' ? 'grid' : 'list'
                        setViewMode(newMode)
                        // 同步到 ConfigOrchestrator
                        try {
                          const { updateConfigValue } = useSettingsStore.getState()
                          await updateConfigValue('DEFAULT_VIEW', newMode)
                        } catch (error) {
                          logger.error(LogCategory.RENDERER, 'Failed to update view mode:', error)
                        }
                      }}
                    >
                      <MaterialIcon
                        icon={viewMode === 'list' ? 'view_list' : 'grid_view'}
                        className="text-xl"
                      />
                    </Button>
                                        {/* Select All Checkbox - Replacement for old button position */}
                    <label className="flex items-center gap-2 px-2 py-1 rounded hover:bg-accent/20 dark:hover:bg-accent/20 cursor-pointer transition-colors flex-shrink-0">
                      <input
                        type="checkbox"
                        className="w-4 h-4 rounded border-input dark:border-input text-primary dark:text-primary focus:ring-ring focus:border-primary cursor-pointer"
                        checked={isAllVisibleItemsSelected}
                        onChange={handleToggleSelectAll}
                      />
                      <span className="text-sm font-medium text-foreground/70 dark:text-foreground/70 select-none">
                        {t('全选')}
                      </span>
                    </label>

                    {/* Quick Organize Button */}
                    <button
                      className="px-3 py-1 text-sm font-medium text-primary hover:text-background bg-card dark:bg-card border-input dark:border-input rounded-md hover:bg-primary dark:hover:bg-primary focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors flex items-center"
                      onClick={() => handleQuickOrganize()}
                      title={
                        !currentWorkspaceDirectory
                          ? t('请先选择工作目录')
                          : !hasAnalyzedFiles
                            ? t('当前工作目录没有已分析的文件')
                            : t('AI智能整理真实目录')
                      }
                    >
                      <MaterialIcon icon="auto_fix_high" className="text-base mr-1" />
                      {t('一键整理')}
                      {selectedFiles.length > 0 && (
                        <span className="ml-1">({selectedFiles.length})</span>
                      )}
                    </button>
                  </div>
                </div>

                {/* File List */}
                <div className="flex-1 flex flex-col overflow-hidden">
                  {isLoading || analyzedFilesCount === null ? (
                    <div className="flex items-center justify-center h-full">
                      <div className="text-center">
                        <div className="inline-block animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-primary dark:border-primary mb-4"></div>
                        <p className="text-foreground/80 dark:text-foreground/80">
                          {t('加载文件中...')}
                        </p>
                      </div>
                    </div>
                  ) : !hasAnalyzedFiles ? (
                    <div className="flex items-center justify-center h-full bg-muted">
                      <div className="text-center max-w-md">
                        <MaterialIcon
                          icon="info"
                          className="text-6xl text-yellow-600 dark:text-yellow-500 mb-4"
                        />
                        <h3 className="text-xl font-semibold text-foreground dark:text-foreground mb-2">
                          {t('暂无已分析文件')}
                        </h3>
                        <p className="text-foreground/80 dark:text-foreground/80 mb-4">
                          {t('当前工作目录还没有AI分析过的文件。请先在')}{' '}
                          <span className="font-semibold text-primary dark:text-primary">
                            {t(' 真实目录 ')}
                          </span>{' '}
                          {t('页签中勾选文件，然后点击')}{' '}
                          <span className="font-semibold text-primary dark:text-primary">
                            {t(' 立即分析 ')}
                          </span>{' '}
                          {t('进行AI分析。')}
                        </p>
                        <Button
                          variant="default"
                          onClick={() => {
                            // 切换到真实目录标签
                            navigate('/real-directory')
                          }}
                        >
                          {t('前往真实目录')}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <FileList
                      files={filteredFiles as FileType[]}
                      directories={[]}
                      viewMode={viewMode}
                      onFileSelect={handleFileSelect}
                      currentPath={currentWorkspaceDirectory?.path || ''}
                      onDirectoryChange={path => {
                        // 虚拟目录中不支持目录导航，所以这里不需要实现任何逻辑
                        console.log(
                          'Directory change requested in virtual directory (ignored):',
                          path
                        )
                      }}
                      selectedFiles={selectedFiles}
                      showAnalysisStatus={false}
                      showsmartName={true}
                      sortBy={sortBy === 'date' ? 'modified' : (sortBy as any)}
                      sortOrder={sortOrder}
                      disableClientSort={true}
                      onSortChange={handleSortChange}
                      workspaceDirectoryPath={currentWorkspaceDirectory?.path}
                      activeItem={selectedItem}
                    />
                  )}
                </div>
              </div>

              {/* Right Sidebar - File Details */}
              {showDetailsPanel && (
                <FileDetailsPanel
                  item={selectedItem || undefined}
                  workspaceDirectoryPath={currentWorkspaceDirectory?.path}
                  onClose={() => setShowDetailsPanel(false)}
                  onFileDeleted={async () => {
                    // 刷新文件列表
                    loadFilteredFiles()
                    // 重新加载维度组（更新tag计数）
                    loadDimensionGroups()
                  }}
                  onFileUpdated={async () => {
                    // 刷新文件列表
                    loadFilteredFiles()
                    // 重新加载维度组（更新tag计数）
                    loadDimensionGroups()
                  }}
                />
              )}
            </main>
          </div>
        </div>
      ) : (
        <NoWorkspaceDirectoryMessage onAddWorkspaceDirectory={handleAddWorkspaceDirectory} />
      )}

      {/* Manage Directories Modal */}
      {showManageModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-card dark:bg-card rounded-lg p-6 max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">{t('管理保存的虚拟目录')}</h3>
              <button
                className="p-2 text-muted-foreground dark:text-muted-foreground hover:text-foreground dark:text-foreground hover:bg-accent dark:bg-accent rounded-full transition-colors"
                onClick={() => {
                  setShowManageModal(false)
                  handleCancelEdit()
                }}
              >
                <MaterialIcon icon="close" className="text-xl" />
              </button>
            </div>

            {savedDirectories.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground dark:text-muted-foreground">
                {t('暂无已保存的虚拟目录')}
              </div>
            ) : (
              <div className="space-y-2">
                {savedDirectories.map(dir => (
                  <div
                    key={dir.id}
                    className="flex items-center justify-between p-3 border border-border dark:border-border rounded-md hover:bg-muted dark:bg-muted"
                  >
                    {editingVirtualDirectoryId === dir.id ? (
                      <div className="flex-1 flex items-center space-x-2">
                        <input
                          type="text"
                          value={editingDirectoryName}
                          onChange={e => setEditingDirectoryName(e.target.value)}
                          className="flex-1 px-2 py-1 border-input dark:border-input rounded"
                          onKeyDown={e => {
                            if (e.key === 'Enter') {
                              handleSaveEdit(dir.id)
                            } else if (e.key === 'Escape') {
                              handleCancelEdit()
                            }
                          }}
                          autoFocus
                        />
                        <button
                          className="px-3 py-1 text-sm text-white bg-primary dark:bg-primary hover:bg-primary/90 dark:bg-primary/90 rounded"
                          onClick={() => handleSaveEdit(dir.id)}
                        >
                          {t('保存')}
                        </button>
                        <button
                          className="px-3 py-1 text-sm text-foreground dark:text-foreground hover:bg-accent dark:hover:bg-accent rounded"
                          onClick={handleCancelEdit}
                        >
                          {t('取消')}
                        </button>
                      </div>
                    ) : (
                      <div className="flex-1">
                        <div className="font-medium">{dir.name}</div>
                        <div className="text-xs text-muted-foreground dark:text-muted-foreground">
                          {t('创建时间: {time}', { time: dir.createdAt.toLocaleString() })}
                        </div>
                        <div className="flex items-center space-x-2">
                          <button
                            className="p-2 text-foreground/80 dark:text-foreground/80 hover:text-primary dark:text-primary hover:bg-primary/10 dark:bg-primary/20 rounded"
                            onClick={() => handleStartEdit(dir)}
                            title={t('重命名')}
                          >
                            <MaterialIcon icon="edit" className="text-base" />
                          </button>
                          <button
                            className="p-2 text-foreground/80 dark:text-foreground/80 hover:text-red-600 hover:bg-red-50 rounded"
                            onClick={() => handleDeleteDirectory(dir.id)}
                            title={t('删除')}
                          >
                            <MaterialIcon icon="delete" className="text-base" />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="flex justify-end mt-6">
              <button
                className="px-4 py-2 text-sm text-foreground dark:text-foreground hover:bg-accent dark:hover:bg-accent rounded-md transition-colors"
                onClick={() => {
                  setShowManageModal(false)
                  handleCancelEdit()
                }}
              >
                {t('关闭')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 整理真实目录对话框 */}
      {showConfirmOrganizeDialog && organizePreview && (
        <ConfirmOrganizeDialog
          organizeType={aiGeneratedStructure ? 'quickOrganize' : 'byVirtualDirectory'}
          fileCount={organizePreview.fileCount}
          directoryStructure={organizePreview.directoryStructure}
          fileMap={fileMapForOrganize}
          onConfirm={handleConfirmOrganize}
          onCancel={handleCancelOrganize}
          onRegenerate={instruction => {
            setShowConfirmOrganizeDialog(false)
            handleQuickOrganize(instruction)
          }}
          onConfirmVirtualDirectory={handleConfirmOrganizeVirtualDirectory}
        />
      )}

      {showOrganizeProgressDialog && (
        <OrganizeProgressDialog
          currentFile={organizeProgress.currentFile}
          processedCount={organizeProgress.processedCount}
          totalCount={organizeProgress.totalCount}
          percentage={organizeProgress.percentage}
          estimatedTimeRemaining={organizeProgress.estimatedTimeRemaining}
        />
      )}

      {showOrganizeErrorDialog && organizeResult && (
        <OrganizeErrorDialog
          successCount={organizeResult.movedFiles}
          errors={organizeResult.errors}
          onClose={handleCloseErrorDialog}
        />
      )}

      {showAIProgressDialog && (
        <AIOrganizeProgressDialog
          batchProgress={aiBatchProgress}
          fileMap={fileMapForOrganize}
          onCancel={handleCancelAIOrganize}
        />
      )}

      {showConflictDialog && conflicts.length > 0 && (
        <ConflictResolutionDialog
          conflicts={conflicts}
          onResolve={handleConflictResolve}
          onCancel={handleConflictCancel}
        />
      )}

      {showResultDialog && organizeResult && (
        <OrganizeResultDialog
          statistics={organizeResult}
          onClose={() => setShowResultDialog(false)}
          onOpenDirectory={() => {
            if (currentWorkspaceDirectory) {
              window.electronAPI!.organizeRealDirectory.openDirectory(currentWorkspaceDirectory.path)
            }
          }}
          onExportLog={handleExportLog}
        />
      )}

      {/* 生成虚拟目录预览对话框 */}
      {showGenerateVirtualDirDialog && (
        <GenerateVirtualDirectoriesDialog
          isOpen={showGenerateVirtualDirDialog}
          onClose={() => setShowGenerateVirtualDirDialog(false)}
          onConfirm={handleConfirmGenerateVirtualDirectories}
          selectedTags={Array.from(selectedTagsForVirtualDir).map(key => {
            const [dimensionIdStr, ...tagValueParts] = key.split('-')
            const dimensionId = parseInt(dimensionIdStr)
            const tagValue = tagValueParts.join('-')
            const group = dimensionGroups.find(g => g.id === dimensionId)
            const tagObj = group?.tags.find(t => t.tagValue === tagValue)
            return {
              dimensionId,
              dimensionName: group?.name || '',
              tagValue,
              fileCount: tagObj?.fileCount || 0
            }
          })}
          dimensionGroups={dimensionGroups}
          workspaceDirectoryPath={currentWorkspaceDirectory?.path}
          selectionStack={selectionStack}
        />
      )}

      {/* 空文件夹清理对话框 */}
      {showEmptyFolderCleanupDialog && currentWorkspaceDirectory && (
        <EmptyFolderCleanupDialog
          isOpen={showEmptyFolderCleanupDialog}
          onClose={() => {
            setShowEmptyFolderCleanupDialog(false)
            setEmptyFolderScanPath(null)
          }}
          workspaceDirectoryPath={currentWorkspaceDirectory?.path}
          scanPath={emptyFolderScanPath || undefined}
        />
      )}

      {/* 邀请提示弹窗 */}
      <InvitationModal
        isOpen={showInvitationModal}
        onClose={() => setShowInvitationModal(false)}
        invitationCount={invitationCount}
        isInvited={isInvited}
        quota={quota}
        machineId={machineId}
        onRefresh={refreshCount}
        onRedeem={async code => {
          const result = await redeemCode(code)
          if (result.success) {
            // 兑换成功后刷新配额和已分析计数
            refreshCount()
            loadDimensionGroups()
          }

          return result
        }}
        isLoading={isInvitationLoading}
      />
    </div>
  )
}

export default VirtualDirectory
