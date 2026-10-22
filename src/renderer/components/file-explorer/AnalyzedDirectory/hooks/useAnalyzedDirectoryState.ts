import { useState, useEffect, useRef } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
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
import { useSearchViewAutoSwitch } from '../../FileList/hooks/useSearchViewAutoSwitch'

/**
 * 维度组加载超时上限（毫秒）。
 *
 * 主进程 getDimensionGroups 内部会先 await Omni 引擎就绪：引擎未启动时
 * `omniService.ensureRunning()` 要等 spawn 后的探活轮询（最长 40s），随后请求本身
 * 还有 3×8s 超时重试。工作目录尚无分析数据时，本地维度标签又会被 removeEmptyTags 清空，
 * 于是左侧「分类维度」面板会长时间停在"加载中"，最后才落到"暂无数据"。
 * 这里加超时兜底：到点即结束 loading 并降级为空维度，避免面板无限转圈。
 */
const DIMENSION_LOAD_TIMEOUT_MS = 8000

/**
 * 为 Promise 追加超时上限：超时后 reject 并回调 onTimeout，
 * 供调用方区分「超时降级」与「真实失败」。
 *
 * 注意：被包裹的 Promise 仍会继续执行，其后续结果由调用方的请求序号机制丢弃。
 */
const withTimeout = <T,>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout()
      reject(new Error(`DIMENSION_LOAD_TIMEOUT(${timeoutMs}ms)`))
    }, timeoutMs)
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      err => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })

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
  const location = useLocation()
  const currentPath = location.pathname
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

  // 搜索关键词非空时自动切换至 search-list 视图，清空后恢复原模式
  useSearchViewAutoSwitch({
    keyword: analyzedDirectoryKeyword,
    viewMode,
    setViewMode
  })
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
  /** 维度组请求序号：并发/过期请求不得覆盖最新一次加载的 loading 与数据状态 */
  const dimensionLoadSeqRef = useRef(0)
  /** 上一次观测到的 Omni 引擎运行态，用于识别「未就绪 → 运行中」的跃迁并补取受控维度树 */
  const omniRunningRef = useRef<boolean | null>(null)

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
      if (currentWorkspaceDirectory) {
        loadDimensionGroups()
        loadFilteredFiles()
      }
    })
    return () => {
      if (unsubscribe) unsubscribe()
    }
  }, [currentWorkspaceDirectory])

  // 监听工作目录重置事件
  useEffect(() => {
    const handleWorkspaceReset = () => {
      logger.info(LogCategory.RENDERER, '收到工作目录重置事件，清空状态并重新加载...')
      clearSelectedTags()
      setDimensionGroups([])
      setFilteredFiles([])
      setAnalyzedFilesCount(0)
      if (currentWorkspaceDirectory) {
        loadDimensionGroups()
        loadFilteredFiles()
      }
    }
    window.addEventListener('workspace-reset', handleWorkspaceReset)
    return () => {
      window.removeEventListener('workspace-reset', handleWorkspaceReset)
    }
  }, [currentWorkspaceDirectory])

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

  // 监听路由切换到已分析页面时自动刷新维度数据与文件列表
  useEffect(() => {
    if (currentPath === '/analyzed-directory' && currentWorkspaceDirectory) {
      loadDimensionGroups()
      loadFilteredFiles()
    }
  }, [currentPath, currentWorkspaceDirectory])

  // 监听全局标签/智能文件名变更事件（如批量更名、批量打标保存/全局删除标签后自动刷新）
  useEffect(() => {
    const handleTagsChanged = () => {
      if (currentWorkspaceDirectory) {
        loadDimensionGroups()
        loadFilteredFiles()
      }
    }
    window.addEventListener('tags-updated', handleTagsChanged)
    window.addEventListener('tags:updated', handleTagsChanged)
    window.addEventListener('smartname-updated', handleTagsChanged)
    window.addEventListener('files-updated', handleTagsChanged)
    return () => {
      window.removeEventListener('tags-updated', handleTagsChanged)
      window.removeEventListener('tags:updated', handleTagsChanged)
      window.removeEventListener('smartname-updated', handleTagsChanged)
      window.removeEventListener('files-updated', handleTagsChanged)
    }
  }, [currentWorkspaceDirectory])

  // 监听基础 AI 引擎（Omni）「未就绪 → 运行中」跃迁：
  // 冷启动期间受控分类树会先降级为空树（避免阻塞首屏），引擎就绪后自动重取一次，
  // 否则左侧「分类维度」会一直停留在"暂无数据"，直到用户手动触发刷新。
  useEffect(() => {
    const unsubscribe = window.electronAPI?.onOmniStatusChanged?.(status => {
      const wasRunning = omniRunningRef.current
      omniRunningRef.current = status.running
      if (wasRunning === false && status.running && currentWorkspaceDirectory) {
        logger.info(
          LogCategory.RENDERER,
          '[已分析目录] Omni 引擎已就绪，重新加载受控分类维度树'
        )
        loadDimensionGroups()
      }
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
    const seq = ++dimensionLoadSeqRef.current
    performanceTracker.start(perfKey)
    let timedOut = false
    try {
      setIsDimensionLoading(true)

      const selectedTagList = selectedTags.map(tag => ({
        dimensionId: tag.dimensionId,
        tagValue: tag.tagValue
      }))

      const [response, count] = await withTimeout(
        Promise.all([
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
        ]),
        DIMENSION_LOAD_TIMEOUT_MS,
        () => {
          timedOut = true
        }
      )

      // 已被更新的一次加载取代：丢弃过期结果，避免旧数据覆盖新状态
      if (seq !== dimensionLoadSeqRef.current) return

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
      if (seq !== dimensionLoadSeqRef.current) return
      if (timedOut) {
        // 超时属可观测降级（禁止静默吞异常）：记录 warn 并放开 loading，
        // 引擎就绪后会由 omni:status-changed 监听自动重取受控维度树。
        // 刻意不改写 analyzedFilesCount —— 超时无法证明"零已分析文件"，
        // 误置 0 会让右侧文件区错显"暂无已分析文件"空状态。
        logger.warn(
          LogCategory.RENDERER,
          `[已分析目录] 维度分组加载超时（>${DIMENSION_LOAD_TIMEOUT_MS}ms），本次降级为空维度，等待引擎就绪后自动重试`
        )
      } else {
        logger.error(LogCategory.RENDERER, 'Failed to load dimension groups:', error)
        toast.error(t('加载维度分组失败'))
        setAnalyzedFilesCount(0)
      }
    } finally {
      // 仅最新一次请求有权结束 loading，避免并发请求互相踩踏
      if (seq === dimensionLoadSeqRef.current) setIsDimensionLoading(false)
      performanceTracker.end(perfKey)
    }
  }

  const loadFilteredFiles = async (isLoadMore = false) => {
    const perfKey = 'Load Filtered Files (Renderer)'
    performanceTracker.start(perfKey)
    try {
      if (isLoading) return

      setIsLoading(true)
      const currentOffset = isLoadMore ? offset + 100 : 0

      const result = await window.electronAPI!.analyzedDirectory.getFilteredFilesPaged({
        selectedTags,
        sortBy,
        sortOrder,
        workspaceDirectoryPath: currentWorkspaceDirectory?.path,
        searchKeyword: analyzedDirectoryKeyword,
        limit: 100,
        offset: currentOffset,
        unionMode
      })

      if (isLoadMore) {
        setFilteredFiles([...filteredFiles, ...(result.items || [])])
        setOffset(currentOffset)
      } else {
        setFilteredFiles(result.items || [])
        setOffset(0)
        if (isFirstLoadRef.current && (result.items || []).length > 0) {
          setSelectedItem(result.items[0] as FileType)
          isFirstLoadRef.current = false
        }
      }
      setTotalFilesCount(result.total || 0)
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
