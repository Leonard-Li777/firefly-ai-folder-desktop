import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  WorkspaceDirectory,
  FileItem as FileType,
  SelectedTag,
  DimensionGroup,
  DimensionTag
} from '@firefly/types'
import { LogCategory, logger } from '@firefly/shared'
import { performanceTracker } from '../../../../lib/performance-metrics'
import { toast } from '../../../common/Toast'
import { t } from '@app/languages'
import { useAnalyzedDirectoryStore } from '../../../../stores/analyzed-directory-store'
import { useSettingsStore } from '../../../../stores/settings-store'
import { useModelStore } from '../../../../stores/model-store'
import { useSearchStore } from '../../../../stores/search-store'
import { useAnalysisQueueStore } from '../../../../stores/analysis-queue-store'
import { PAGE_SIZE } from '../constants'

/**
 * 虚拟目录状态管理 Hook
 * 处理工作目录、维度组、文件列表的加载和同步逻辑
 */
export const useAnalyzedDirectoryState = (
  isExportMode: boolean,
  clearSelectedTags: () => void,
  addSelectedTag: (tag: SelectedTag) => void,
  unionMode: 'union' | 'intersection' = 'union',
  onAnalysisComplete?: () => void
) => {
  const navigate = useNavigate()
  const {
    currentWorkspaceDirectory,
    setCurrentWorkspaceDirectory,
    dimensionGroups,
    setDimensionGroups,
    selectedTags,
    filteredFiles,
    setFilteredFiles,
    sortBy,
    sortOrder,
    viewMode,
    setSortBy,
    setSortOrder,
    setViewMode,
    setSavedDirectories,
    isLoading,
    setIsLoading,
    selectedItem,
    setSelectedItem,
    showDetailsPanel,
    setShowDetailsPanel,
    totalFilesCount,
    setTotalFilesCount,
    workspaceDirectories,
    setWorkspaceDirectories
  } = useAnalyzedDirectoryStore()

  const { config, getConfigValue, updateConfigValue } = useSettingsStore()
  const { serviceStatus, modelMode } = useModelStore()
  const { analyzedDirectoryKeyword, setAnalyzedDirectoryKeyword } = useSearchStore()
  const { snapshot } = useAnalysisQueueStore()

  const [isDimensionLoading, setIsDimensionLoading] = useState(false)
  const [showDirectoryDropdown, setShowDirectoryDropdown] = useState(false)
  const [analyzedFilesCount, setAnalyzedFilesCount] = useState<number | null>(null)
  const [offset, setOffset] = useState(0)
  const [machineId, setMachineId] = useState('')

  const prevWorkspacePathRef = useRef<string | undefined>(undefined)
  const isPerformanceTrackingStarted = useRef(false)
  const isFirstLoadRef = useRef(true)
  const lastCompletedIds = useRef<Set<number>>(new Set())
  const refreshTimer = useRef<NodeJS.Timeout | null>(null)
  const [lastSingleTag, setLastSingleTag] = useState<SelectedTag | null>(null)

  // Load initial data
  useEffect(() => {
    if (!isPerformanceTrackingStarted.current) {
      performanceTracker.clear()
      performanceTracker.start('Total Switch Time (Real to Virtual)')
      performanceTracker.start('Component Mount to Initial Render')
      isPerformanceTrackingStarted.current = true
    }
    loadWorkspaceDirectories()
  }, [])

  // 监听分析队列状态变化，自动刷新数据
  useEffect(() => {
    const completedItems = snapshot.items.filter(item => item.status === 'completed')
    const currentCompletedIds = new Set<number>(completedItems.map(item => item.id))

    let hasNewCompletion = false
    for (const id of currentCompletedIds) {
      if (!lastCompletedIds.current.has(id)) {
        hasNewCompletion = true
        break
      }
    }

    if (hasNewCompletion) {
      // 立即更新已知完成 ID 集合，防止防抖等待期间后续队列推送重复触发误判
      lastCompletedIds.current = currentCompletedIds

      logger.info(LogCategory.RENDERER, `[虚拟目录] 检测到项目分析完成，准备刷新数据...`)
      if (refreshTimer.current) clearTimeout(refreshTimer.current)

      refreshTimer.current = setTimeout(() => {
        loadFilteredFiles()
        loadDimensionGroups()
        refreshTimer.current = null
        onAnalysisComplete?.()
      }, 1500)
    } else if (currentCompletedIds.size !== lastCompletedIds.current.size) {
      lastCompletedIds.current = currentCompletedIds
    }
  }, [snapshot.items])

  useEffect(() => {
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
    }
  }, [])

  // Reload files when filters or search keyword change
  useEffect(() => {
    loadFilteredFiles()
  }, [selectedTags, sortBy, sortOrder, analyzedDirectoryKeyword, unionMode])

  // Reload data when workspace directory or language changes
  useEffect(() => {
    if (currentWorkspaceDirectory) {
      setAnalyzedFilesCount(null)
      loadDimensionGroups()
      isFirstLoadRef.current = true

      prevWorkspacePathRef.current = currentWorkspaceDirectory.path

      if (selectedTags.length > 0) {
        clearSelectedTags()
      } else {
        loadFilteredFiles()
      }
    } else {
      setDimensionGroups([])
      setAnalyzedFilesCount(0)
      setFilteredFiles([])
    }
  }, [currentWorkspaceDirectory, config.language])

  // 监听工作目录更新事件
  useEffect(() => {
    const unsubscribe = window.electronAPI!.onWorkspaceDirectoriesUpdated?.(() => {
      logger.info(LogCategory.RENDERER, '工作目录已更新，重新加载...')
      loadWorkspaceDirectories()
    })
    return () => {
      if (unsubscribe) unsubscribe()
    }
  }, [])

  // 监听工作目录重置事件
  useEffect(() => {
    const handleWorkspaceReset = () => {
      logger.info(LogCategory.RENDERER, '收到工作目录重置事件')
    }
    window.addEventListener('workspace-reset', handleWorkspaceReset)
    return () => {
      window.removeEventListener('workspace-reset', handleWorkspaceReset)
    }
  }, [])

  // 监听忽略规则变更事件
  useEffect(() => {
    const unsubscribe = window.electronAPI!.onIgnoreRulesChanged?.(() => {
      logger.info(LogCategory.RENDERER, '忽略规则已变更，自动刷新列表...')
      loadDimensionGroups()
      loadFilteredFiles()
    })
    return () => {
      if (unsubscribe) unsubscribe()
    }
  }, [currentWorkspaceDirectory])

  // 记录非勾选模式下的单选状态
  useEffect(() => {
    if (!isExportMode) {
      if (selectedTags.length === 1) {
        setLastSingleTag(selectedTags[0])
      } else if (selectedTags.length === 0) {
        setLastSingleTag(null)
      }
    }
  }, [selectedTags, isExportMode])

  const loadWorkspaceDirectories = async () => {
    const perfKey = 'Load Workspace Directories (Renderer)'
    performanceTracker.start(perfKey)
    try {
      const [mId, directories, current] = await Promise.all([
        (async () => {
          try {
            const start = performance.now()
            const result = await window.electronAPI!.getMachineId()
            performanceTracker.record('IPC: getMachineId', performance.now() - start)
            return result
          } catch (e) {
            logger.error(LogCategory.RENDERER, 'Failed to get machine ID:', e)
            return ''
          }
        })(),
        (async () => {
          const start = performance.now()
          const result = await window.electronAPI!.getAllWorkspaceDirectories()
          performanceTracker.record('IPC: getAllWorkspaceDirectories', performance.now() - start)
          return result
        })(),
        (async () => {
          const start = performance.now()
          const result = await window.electronAPI!.getCurrentWorkspaceDirectory()
          performanceTracker.record('IPC: getCurrentWorkspaceDirectory', performance.now() - start)
          return result
        })()
      ])

      setMachineId(mId)
      setWorkspaceDirectories(directories)

      const { isPathEqual } = window.electronAPI!.utils
      const currentInStore = useAnalyzedDirectoryStore.getState().currentWorkspaceDirectory
      const foundInList = directories.find(d => isPathEqual(d.path, currentInStore?.path))

      if (!currentInStore || !foundInList) {
        setCurrentWorkspaceDirectory(current)
      } else {
        setCurrentWorkspaceDirectory(foundInList)
      }
    } catch (error) {
      logger.error(LogCategory.RENDERER, 'Failed to load workspace directories:', error)
      toast.error(t('加载工作目录失败'))
    } finally {
      performanceTracker.end(perfKey)
    }
  }

  const loadDimensionGroups = async () => {
    const perfKey = 'Load Dimension Groups (Renderer)'
    performanceTracker.start(perfKey)
    try {
      setIsDimensionLoading(true)

      const selectedTagList = selectedTags.map(tag => ({
        dimensionId: tag.dimensionId,
        tagValue: tag.tagValue
      }))

      const [response, count] = await Promise.all([
        (async () => {
          const start = performance.now()
          const result = await window.electronAPI!.analyzedDirectory.getDimensionGroups({
            workspaceDirectoryPath: currentWorkspaceDirectory?.path,
            removeEmptyTags: true
          })
          performanceTracker.record('IPC: getDimensionGroups', performance.now() - start)
          return result
        })(),
        (async () => {
          const start = performance.now()
          const result = await window.electronAPI!.analyzedDirectory.getAnalyzedFilesCount(
            currentWorkspaceDirectory?.path
          )
          performanceTracker.record('IPC: getAnalyzedFilesCount', performance.now() - start)
          return result
        })()
      ])

      const groups = response.groups
      if (response.performance) {
        performanceTracker.record('Dimension DB Query', response.performance.dbQueryTime, {
          process: 'Main'
        })
        performanceTracker.record('Dimension Total Logic', response.performance.totalTime, {
          process: 'Main'
        })
      }

      setDimensionGroups(groups)
      setAnalyzedFilesCount(count)
    } catch (error) {
      logger.error(LogCategory.RENDERER, 'Failed to load dimension groups:', error)
      toast.error(t('加载维度分组失败'))
      setAnalyzedFilesCount(0)
    } finally {
      setIsDimensionLoading(false)
      performanceTracker.end(perfKey)
    }
  }

  const loadFilteredFiles = async (isLoadMore = false) => {
    const perfKey = isLoadMore ? 'Load More Files (Renderer)' : 'Load Initial Files (Renderer)'
    performanceTracker.start(perfKey)
    try {
      if (isLoading) return

      if (!isLoadMore) {
        setIsLoading(false)
        setOffset(0)
      }

      setIsLoading(true)
      const currentOffset = isLoadMore ? offset + PAGE_SIZE : 0

      const result = await window.electronAPI!.analyzedDirectory.getFilteredFilesPaged({
        selectedTags,
        sortBy,
        sortOrder,
        workspaceDirectoryPath: currentWorkspaceDirectory?.path,
        searchKeyword: analyzedDirectoryKeyword,
        limit: PAGE_SIZE,
        offset: currentOffset,
        unionMode
      })

      if (result.performance) {
        performanceTracker.record(
          `Files DB Query (${isLoadMore ? 'More' : 'Initial'})`,
          result.performance.dbQueryTime,
          { process: 'Main' }
        )
        performanceTracker.record(
          `Files Total Logic (${isLoadMore ? 'More' : 'Initial'})`,
          result.performance.totalTime,
          { process: 'Main' }
        )
      }

      if (isLoadMore) {
        setFilteredFiles([...filteredFiles, ...result.items])
        setOffset(currentOffset)
      } else {
        setFilteredFiles(result.items)
        setOffset(0)
        if (isFirstLoadRef.current && result.items.length > 0) {
          setSelectedItem(result.items[0] as FileType)
          isFirstLoadRef.current = false
        }
      }
      setTotalFilesCount(result.total)
    } catch (error) {
      logger.error(LogCategory.RENDERER, 'Failed to load filtered files:', error)
      toast.error(t('加载文件列表失败'))
    } finally {
      setIsLoading(false)
      performanceTracker.end(perfKey)
    }
  }

  return {
    navigate,
    currentWorkspaceDirectory,
    setCurrentWorkspaceDirectory,
    dimensionGroups,
    selectedTags,
    filteredFiles,
    setFilteredFiles,
    sortBy,
    sortOrder,
    viewMode,
    setSortBy,
    setSortOrder,
    setViewMode,
    setSavedDirectories,
    isLoading,
    setIsLoading,
    selectedItem,
    setSelectedItem,
    showDetailsPanel,
    setShowDetailsPanel,
    totalFilesCount,
    setTotalFilesCount,
    config,
    getConfigValue,
    updateConfigValue,
    serviceStatus,
    modelMode,
    analyzedDirectoryKeyword,
    setAnalyzedDirectoryKeyword,
    workspaceDirectories,
    isDimensionLoading,
    showDirectoryDropdown,
    setShowDirectoryDropdown,
    analyzedFilesCount,
    machineId,
    setMachineId,
    loadFilteredFiles,
    loadDimensionGroups,
    loadWorkspaceDirectories,
    lastSingleTag
  }
}
