import { DirectoryItem, FileItem as FileType, WorkspaceDirectory } from '@firefly/types'
import { LogCategory, logger } from '@firefly/shared'
import React, { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react'

import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import { SearchBar } from '../common/SearchBar'
import { DirectoryHeader } from './DirectoryHeader'
import { FileDetailsPanel } from './FileDetailsPanel/index'
import { FileList } from './FileList'
import { FileExplorerLayout } from './FileExplorerLayout'
import { Breadcrumbs } from './Breadcrumbs'
import { UnlockPrivateQuotaModal } from '../invitation/UnlockPrivateQuotaModal'
import { MaterialIcon, cn } from '../../lib/utils'
import { NoWorkspaceDirectoryMessage } from '../common/NoWorkspaceDirectoryMessage'
import { QuotaWarningBar } from './QuotaWarningBar'
import i18nScope, { t } from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'
import { toast } from '../common/Toast'
import { useAnalysisQueueStore } from '../../stores/analysis-queue-store'
import { useFileExplorerStore } from '../../stores/app-store'
import { useInvitation } from '../../hooks/useInvitation'
import { useNavigate, useLocation } from 'react-router-dom'
import { useSearchStore } from '../../stores/search-store'
import { useSettingsStore } from '../../stores/settings-store'
import { useVirtualDirectoryStore } from '../../stores/virtual-directory-store'
import { useOrganizeStore } from '../../stores/organize-store'
import { PersistentTooltip } from '../common/PersistentTooltip'
import { CardSizePopover } from '../common/CardSizePopover'
import { MiniViewDisplaySettingsPopover } from '../common/MiniViewDisplaySettingsPopover'
import { usePreviewOverlayStore } from '../../stores/preview-overlay-store'
import { getPreviewRouteType, getExtFromSmartName } from '../../lib/preview-utils'
import { SplitPreviewPanel } from './SplitPreviewPanel'
import { SplitPane } from '../common/SplitPane'
import { PAGE_IDS } from '../../constants/page-ids'
import { useTierStore } from '../../stores/tier-store'
import { RestrictedFeatureOverlay } from '../common/RestrictedFeatureOverlay'

interface RealDirectoryProps {
  onFileSelect?: (files: any[], isFromCheckbox?: boolean) => void
  onDirectoryChange?: (path: string) => void
}

export const RealDirectory: React.FC<RealDirectoryProps> = ({
  onFileSelect: externalOnFileSelect,
  onDirectoryChange
}) => {
  useVoerkaI18n(i18nScope)
  const navigate = useNavigate()
  const location = useLocation()
  const [selectedItem, setSelectedItem] = useState<FileType | DirectoryItem | null>(null)
  const [showDetailsPanel, setShowDetailsPanel] = useState(true)

  const pageStates = usePreviewOverlayStore(s => s.pageStates)

  // 当路由切回真实目录页面或选中项发生变化时，自动刷新/恢复属于当前页面的预览
  useEffect(() => {
    if (location.pathname === '/real-directory') {
      const splitState = usePreviewOverlayStore.getState()
      const pageMode = splitState.pageStates[PAGE_IDS.REAL_DIRECTORY]?.mode ?? 'split'
      if (pageMode === 'split') {
        if (
          selectedItem &&
          selectedItem.path &&
          !('isDirectory' in selectedItem && (selectedItem as any).isDirectory)
        ) {
          const fileItem = selectedItem as FileType
          const ext =
            fileItem.extension ||
            getExtFromSmartName(fileItem.smartName || fileItem.name) ||
            fileItem.path.split('.').pop() ||
            ''
          const routeType = getPreviewRouteType(ext)
          if (routeType !== 'unsupported') {
            if (
              splitState.filePath !== fileItem.path ||
              splitState.activePageId !== PAGE_IDS.REAL_DIRECTORY
            ) {
              splitState.openPreview(
                fileItem.path,
                fileItem.smartName || fileItem.name,
                ext,
                PAGE_IDS.REAL_DIRECTORY
              )
            }
          } else if (splitState.activePageId === PAGE_IDS.REAL_DIRECTORY && splitState.filePath) {
            splitState.clearPreview(PAGE_IDS.REAL_DIRECTORY)
          }
        } else if (splitState.activePageId === PAGE_IDS.REAL_DIRECTORY && splitState.filePath) {
          splitState.clearPreview(PAGE_IDS.REAL_DIRECTORY)
        }
      }
    }
  }, [location.pathname, selectedItem])

  const { computed_limits, entitlements, fetchProfile } = useTierStore()

  // 优化选择回调，减少重渲染及复杂度
  const selectedItemRef = useRef(selectedItem)
  useEffect(() => {
    selectedItemRef.current = selectedItem
  }, [selectedItem])

  const handleFileSelect = useCallback(
    (newSelection: (string | FileType | DirectoryItem)[], isFromCheckbox = false) => {
      const { setSelectedFiles, directories, files } = useFileExplorerStore.getState()
      const normalize =
        window.electronAPI?.utils?.normalizeForCache ||
        ((p: string) => p.toLowerCase().replace(/[\\/]+$/, ''))

      // 预先创建 lookup Map 提升查找性能 (O(N))
      const itemMap = new Map<string, FileType | DirectoryItem>()
      directories.forEach(d => {
        if (d?.path) itemMap.set(normalize(d.path), d)
      })
      files.forEach(f => {
        if (f?.path) itemMap.set(normalize(f.path), f)
      })

      const toObjectEntry = (entry: string | FileType | DirectoryItem) => {
        if (entry && typeof entry === 'object') return entry as FileType | DirectoryItem
        return entry && typeof entry === 'string' ? itemMap.get(normalize(entry)) || null : null
      }

      let effectiveSelection = newSelection

      if (isFromCheckbox || newSelection.length > 1) {
        const resolvedSelection = newSelection.map(toObjectEntry).filter(Boolean) as FileType[]
        setSelectedFiles(resolvedSelection)

        // 仅在单选时更新 selectedItem 触发深度预览与属性加载；全选/多选时不盲目激活末尾项
        if (resolvedSelection.length === 1) {
          setSelectedItem(resolvedSelection[0])
        } else if (resolvedSelection.length === 0) {
          setSelectedItem(null)
        }
        setShowDetailsPanel(true)
        effectiveSelection = resolvedSelection
      } else {
        if (newSelection.length > 0) {
          const selectedItemObject = toObjectEntry(newSelection[0])
          if (selectedItemObject) {
            const currentSelectedFiles = useFileExplorerStore.getState().selectedFiles
            const { isPathEqual } = window.electronAPI!.utils
            const isAlreadySelected = currentSelectedFiles.some(f =>
              isPathEqual(f.path, selectedItemObject.path)
            )

            if (isAlreadySelected) {
              setSelectedItem(null)
              setSelectedFiles([])
              effectiveSelection = []
            } else {
              setSelectedItem(selectedItemObject)
              setSelectedFiles([selectedItemObject as FileType])
            }
            setShowDetailsPanel(true)
          }
        } else {
          setSelectedItem(null)
          setSelectedFiles([])
          setShowDetailsPanel(true)
          effectiveSelection = []
        }
      }

      if (externalOnFileSelect) externalOnFileSelect(effectiveSelection, isFromCheckbox)
    },
    [externalOnFileSelect]
  )

  const getSelectedFiles = useCallback(() => {
    return useFileExplorerStore.getState().selectedFiles
  }, [])

  const currentPath = useFileExplorerStore(s => s.currentPath)
  const storeFiles = useFileExplorerStore(s => s.files)
  const storeDirectories = useFileExplorerStore(s => s.directories)
  const selectedFiles = useFileExplorerStore(s => s.selectedFiles)
  const setCurrentPath = useFileExplorerStore(s => s.setCurrentPath)
  const expandDirectory = useFileExplorerStore(s => s.expandDirectory)

  const currentWorkspaceDirectory = useVirtualDirectoryStore(s => s.currentWorkspaceDirectory)
  const setCurrentWorkspaceDirectory = useVirtualDirectoryStore(s => s.setCurrentWorkspaceDirectory)
  const workspaceDirectories = useVirtualDirectoryStore(s => s.workspaceDirectories)
  const setWorkspaceDirectories = useVirtualDirectoryStore(s => s.setWorkspaceDirectories)
  const snapshot = useAnalysisQueueStore(s => s.snapshot)

  const isWorkspaceActive = useMemo(() => {
    if (!currentWorkspaceDirectory || !workspaceDirectories.length) return true
    const type = currentWorkspaceDirectory.type
    if (type !== 'SPEEDY' && type !== 'PRIVATE') return true

    const sameTypeDirs = workspaceDirectories.filter(d => d.type === type)
    const { isPathEqual } = window.electronAPI!.utils
    const index = sameTypeDirs.findIndex(
      d =>
        d.path &&
        currentWorkspaceDirectory.path &&
        isPathEqual(d.path, currentWorkspaceDirectory.path)
    )
    if (index === -1) return true

    const limit =
      type === 'SPEEDY'
        ? (computed_limits?.speedy_dir_slot_limit ?? 1)
        : (computed_limits?.private_dir_slot_limit ?? 1)

    if (index < limit) return true

    return false
  }, [currentWorkspaceDirectory, workspaceDirectories, computed_limits])

  // 使用 useMemo 稳定 files 和 directories 的引用，避免不必要的重新渲染
  const files = useMemo(() => storeFiles, [storeFiles])
  const directories = useMemo(() => storeDirectories, [storeDirectories])

  const configDefaultView = useSettingsStore(s => s.config.defaultView)
  const updateConfigValue = useSettingsStore(s => s.updateConfigValue)
  const setRealDirectoryKeyword = useSearchStore(s => s.setRealDirectoryKeyword)
  const realDirectoryKeyword = useSearchStore(s => s.realDirectoryKeyword)
  const clearRealDirectorySearch = useSearchStore(s => s.clearRealDirectorySearch)

  const [viewMode, setViewMode] = useState<'list' | 'grid' | 'waterfall'>(
    configDefaultView || 'list'
  )
  const [showDirectoryDropdown, setShowDirectoryDropdown] = useState(false)

  const isSplitView = (pageStates[PAGE_IDS.REAL_DIRECTORY]?.mode ?? 'split') === 'split'

  // 邀请相关状态
  const [showInvitationModal, setShowInvitationModal] = useState(false)
  const {
    quota,
    refreshCount: refreshInvitationCount,
    isLoading: isInvitationLoading
  } = useInvitation(true)

  const [machineId, setMachineId] = useState('')
  const [navigationHistory, setNavigationHistory] = useState<string[]>([])
  const [currentHistoryIndex, setCurrentHistoryIndex] = useState(-1)
  const [isHistoryNavigation, setIsHistoryNavigation] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // 跨目录搜索状态
  const [workspaceSearchResults, setWorkspaceSearchResults] = useState<FileType[]>([])
  const [isSearchingAllDirs, setIsSearchingAllDirs] = useState(false)
  const searchDebounceRef = useRef<NodeJS.Timeout | null>(null)

  const toggleQueue = useAnalysisQueueStore(s => s.toggleQueue)
  const addItems = useAnalysisQueueStore(s => s.addItems)
  const start = useAnalysisQueueStore(s => s.start)

  // 用于强制刷新缩略图缓存的 Key
  const [refreshKey, setRefreshKey] = useState(Date.now())

  // 监听分析队列变化，自动刷新目录内容
  const refreshTimer = useRef<NodeJS.Timeout | null>(null)
  const lastCompletedIds = useRef<Set<number>>(new Set())

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
      // 立即更新已知完成 ID 集合，防止防抖等待期间后续队列推送重复触发误判
      lastCompletedIds.current = currentCompletedIds

      logger.info(LogCategory.RENDERER, `[分析队列] 检测到项目分析完成，准备刷新列表...`)

      if (refreshTimer.current) clearTimeout(refreshTimer.current)

      refreshTimer.current = setTimeout(() => {
        refreshDirectoryContents()
        setRefreshKey(Date.now()) // 更新 Key，强制刷新图片
        refreshTimer.current = null
      }, 1000)
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

  // search store (already optimized)

  const handleSearch = useCallback(
    (keyword: string) => {
      setRealDirectoryKeyword(keyword)
    },
    [setRealDirectoryKeyword]
  )

  // 跨目录搜索：关键词变化时，搜索当前工作空间所有子目录
  useEffect(() => {
    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current)
      searchDebounceRef.current = null
    }

    if (!realDirectoryKeyword.trim() || !currentWorkspaceDirectory?.path) {
      setWorkspaceSearchResults([])
      setIsSearchingAllDirs(false)
      return
    }

    const keyword = realDirectoryKeyword.trim()
    // 文件系统搜索无长度限制，直接触发跨目录搜索

    setIsSearchingAllDirs(true)

    searchDebounceRef.current = setTimeout(async () => {
      try {
        const results = await window.electronAPI!.searchWorkspaceFiles(
          keyword,
          currentWorkspaceDirectory.path
        )
        // 后端已返回 FileItem 格式，直接使用
        setWorkspaceSearchResults(results)
      } catch (error) {
        logger.error(LogCategory.RENDERER, '跨目录搜索失败:', error)
        setWorkspaceSearchResults([])
      } finally {
        setIsSearchingAllDirs(false)
      }
    }, 300)

    return () => {
      if (searchDebounceRef.current) {
        clearTimeout(searchDebounceRef.current)
      }
    }
  }, [realDirectoryKeyword, currentWorkspaceDirectory?.path])

  // 过滤文件和目录（根据搜索关键词）
  const filteredData = useMemo(() => {
    if (!realDirectoryKeyword.trim()) {
      return { files, directories }
    }

    const keyword = realDirectoryKeyword.toLowerCase().trim()

    // 跨目录搜索进行中，保留当前目录结果作为过渡
    if (isSearchingAllDirs) {
      return { files, directories }
    }

    // 跨目录搜索完成，使用搜索结果
    if (workspaceSearchResults.length > 0 || !isSearchingAllDirs) {
      return { files: workspaceSearchResults, directories: [] }
    }

    return { files, directories }
  }, [files, directories, realDirectoryKeyword, workspaceSearchResults, isSearchingAllDirs])

  const isAllSelected = useMemo(() => {
    const totalItems = filteredData.files.length + filteredData.directories.length
    if (totalItems === 0) return false

    // 长度不等直接返回 O(1) 短路，避免昂贵的 Set 计算
    if (selectedFiles.length < totalItems) return false

    const normalize =
      window.electronAPI?.utils?.normalizeForCache ||
      ((p: string) => p.toLowerCase().replace(/[\\/]+$/, ''))
    const selectedPaths = new Set(
      selectedFiles.map(f => normalize(typeof f === 'string' ? f : f?.path || ''))
    )

    const allItems = [...filteredData.directories, ...filteredData.files]
    return allItems.every(item => item.path && selectedPaths.has(normalize(item.path)))
  }, [filteredData, selectedFiles])

  const isIndeterminate = useMemo(() => {
    return selectedFiles.length > 0 && !isAllSelected
  }, [selectedFiles.length, isAllSelected])

  const toggleSelectAll = useCallback(() => {
    const totalItems = filteredData.files.length + filteredData.directories.length
    if (totalItems === 0) return

    if (isAllSelected) {
      handleFileSelect([], true)
    } else {
      const allItems = [...filteredData.directories, ...filteredData.files]
      handleFileSelect(allItems, true)
    }
  }, [filteredData, isAllSelected, handleFileSelect])

  // 当搜索过滤结果变化时，清理不在结果中的已选中项
  useEffect(() => {
    if (selectedFiles.length > 0) {
      const { normalizeForCache } = window.electronAPI!.utils
      const allFilteredPaths = new Set([
        ...filteredData.files.map(f => normalizeForCache(f.path)),
        ...filteredData.directories.map(d => normalizeForCache(d.path))
      ])

      const newSelected = selectedFiles.filter(f => {
        const path = normalizeForCache((f as any).path)
        return path && allFilteredPaths.has(path)
      })

      if (newSelected.length !== selectedFiles.length) {
        useFileExplorerStore.getState().setSelectedFiles(newSelected)
      }
    }
  }, [filteredData])

  // 监听defaultView配置变化
  useEffect(() => {
    if (configDefaultView) {
      setViewMode(configDefaultView)
    }
  }, [configDefaultView])

  // 工作目录下拉菜单的 click-outside 关闭逻辑已下沉至 DirectoryHeader 内部统一处理

  // 获取当前目录的文件列表的函数
  const loadDirectoryContents = useCallback(async () => {
    if (!currentPath || !currentWorkspaceDirectory) return // 只有在有工作目录且路径存在时才加载内容

    try {
      const { files, directories } = await window.electronAPI!.readDirectory(currentPath)
      useFileExplorerStore.getState().setFiles(files)
      useFileExplorerStore.getState().setDirectories(directories)
      logger.info(LogCategory.RENDERER, '已更新store', {
        storeFilesCount: useFileExplorerStore.getState().files.length,
        storeDirectoriesCount: useFileExplorerStore.getState().directories.length
      })
    } catch (error) {
      logger.error(LogCategory.RENDERER, '读取目录失败:', error)
      const message = t('未知错误')
      toast.error(t('读取目录失败: {message}', { message }))
      // 读取失败时清空文件和目录
      useFileExplorerStore.getState().setFiles([])
      useFileExplorerStore.getState().setDirectories([])
    }
  }, [currentPath, currentWorkspaceDirectory])

  // 获取工作目录及相关事件监听
  useEffect(() => {
    const loadWorkspaceDirectories = async (isInitial = false) => {
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

        const currentDir = await window.electronAPI!.getCurrentWorkspaceDirectory()
        const { isPathEqual } = window.electronAPI!.utils

        // 关键修复：防止竞态条件
        // 只有在以下情况才从后端同步当前工作目录：
        // 1. 初始加载
        // 2. 当前 Store 中没有选中的目录
        // 3. 当前选中的目录已经不再最新的目录列表中（可能被删除了）
        const currentInStore = useVirtualDirectoryStore.getState().currentWorkspaceDirectory
        const foundInList = directories.find(d => isPathEqual(d.path, currentInStore?.path))

        if (isInitial || !currentInStore || !foundInList) {
          logger.info(LogCategory.RENDERER, '同步后端当前工作目录:', currentDir?.name || 'null')
          setCurrentWorkspaceDirectory(currentDir)
        } else {
          // 关键修复：保持选中状态，但同步后端返回的完整信息（如 ID）
          logger.info(LogCategory.RENDERER, '同步当前工作目录完整信息:', foundInList.name)
          setCurrentWorkspaceDirectory(foundInList)
        }
      } catch (error) {
        logger.error(LogCategory.RENDERER, '获取工作目录失败:', error)
        toast.error(t('获取工作目录失败'))
      }
    }

    loadWorkspaceDirectories(true)

    // 监听工作目录更新事件 (例如删除或添加了新的根目录)
    const unsubscribe = window.electronAPI!.onWorkspaceDirectoriesUpdated?.(() => {
      logger.info(LogCategory.RENDERER, '工作目录已更新，重新加载...')
      loadWorkspaceDirectories(false)
    })

    return () => {
      if (unsubscribe) {
        unsubscribe()
      }
    }
  }, []) // 初始加载执行一次，内部监听器长期存活

  // 监听忽略规则变更事件
  useEffect(() => {
    const unsubscribe = window.electronAPI!.onIgnoreRulesChanged?.(() => {
      logger.info(LogCategory.RENDERER, '忽略规则已变更，自动刷新列表...')
      refreshDirectoryContents()
    })

    return () => {
      if (unsubscribe) {
        unsubscribe()
      }
    }
  }, [currentPath, currentWorkspaceDirectory])

  // 处理工作空间切换带来的路径更新副作用
  useEffect(() => {
    if (currentWorkspaceDirectory) {
      // 只有当路径不在当前工作区范围内时才强制重置为根目录
      // 允许路径是工作区路径的子目录
      const { isSubPath } = window.electronAPI!.utils

      if (!currentPath || !isSubPath(currentWorkspaceDirectory.path, currentPath)) {
        logger.info(
          LogCategory.RENDERER,
          '检测到工作区变更或非法路径，重置当前路径:',
          currentWorkspaceDirectory.path
        )
        setCurrentPath(currentWorkspaceDirectory.path)
      }
    } else {
      // 注意：只有在确定没有工作目录时（且不是初始加载状态），才清空路径
      // 我们通过检查 workspaceDirectories 是否已加载来判断
      if (workspaceDirectories.length > 0 && currentPath !== '') {
        logger.info(LogCategory.RENDERER, '工作目录为空，清空路径')
        setCurrentPath('')
      }
    }
  }, [currentWorkspaceDirectory, workspaceDirectories.length])

  // 监听当前目录的文件更新事件（增量刷新）
  useEffect(() => {
    let debounceTimer: NodeJS.Timeout | null = null

    const unsubscribeFiles = window.electronAPI!.onDirectoryFilesUpdated?.(
      (updatedPath: string) => {
        // 只有当更新的目录是当前显示的目录时，才重新加载内容
        const { isPathEqual } = window.electronAPI!.utils
        if (currentPath && isPathEqual(updatedPath, currentPath)) {
          if (debounceTimer) clearTimeout(debounceTimer)

          debounceTimer = setTimeout(() => {
            logger.info(LogCategory.RENDERER, '当前目录文件有更新，执行防抖加载:', updatedPath)
            loadDirectoryContents()
          }, 500) // 500ms 防抖
        }
      }
    )

    return () => {
      if (unsubscribeFiles) {
        unsubscribeFiles()
      }
      if (debounceTimer) {
        clearTimeout(debounceTimer)
      }
    }
  }, [currentPath, loadDirectoryContents]) // 依赖项确保闭包内的路径是最新的

  // 监听全局智能文件名与文件更新事件
  useEffect(() => {
    const handleSmartNameUpdated = () => {
      loadDirectoryContents()
    }
    window.addEventListener('smartname-updated', handleSmartNameUpdated)
    window.addEventListener('files-updated', handleSmartNameUpdated)
    return () => {
      window.removeEventListener('smartname-updated', handleSmartNameUpdated)
      window.removeEventListener('files-updated', handleSmartNameUpdated)
    }
  }, [loadDirectoryContents])

  // 获取当前目录的文件列表
  useEffect(() => {
    loadDirectoryContents()
  }, [loadDirectoryContents]) // 依赖于 loadDirectoryContents 函数本身

  // 更新导航历史记录
  useEffect(() => {
    if (currentPath && navigationHistory[currentHistoryIndex] !== currentPath) {
      // 如果是历史导航（后退/前进），不添加新历史记录
      if (isHistoryNavigation) {
        setIsHistoryNavigation(false)
        return
      }

      // 否则，添加新的历史记录
      setNavigationHistory(prev => {
        const newHistory = prev.slice(0, currentHistoryIndex + 1)
        newHistory.push(currentPath)
        return newHistory
      })
      setCurrentHistoryIndex(prev => prev + 1)
    }
  }, [currentPath, isHistoryNavigation, navigationHistory, currentHistoryIndex])

  // 选择工作目录
  const handleSelectWorkspaceDirectory = useCallback(
    async (directory: WorkspaceDirectory) => {
      try {
        // 保存当前工作区的搜索词
        if (currentWorkspaceDirectory?.path) {
          const oldKey = `real-dir-search-${currentWorkspaceDirectory.path}`
          if (realDirectoryKeyword.trim()) {
            localStorage.setItem(oldKey, realDirectoryKeyword)
          } else {
            localStorage.removeItem(oldKey)
          }
        }

        await window.electronAPI!.setCurrentWorkspaceDirectory(directory.path)
        setCurrentWorkspaceDirectory(directory)
        setCurrentPath(directory.path)
        setShowDirectoryDropdown(false)
        // 重置导航历史，确保工作空间切换时历史被隔离
        setNavigationHistory([])
        setCurrentHistoryIndex(-1)

        // 恢复新工作区的搜索词
        const newKey = `real-dir-search-${directory.path}`
        const saved = localStorage.getItem(newKey) || ''
        setRealDirectoryKeyword(saved)

        if (onDirectoryChange) {
          onDirectoryChange(directory.path)
        }
      } catch (error) {
        logger.error(LogCategory.RENDERER, '设置当前工作目录失败:', error)
        toast.error(t('设置当前工作目录失败'))
      }
    },
    [
      onDirectoryChange,
      setCurrentPath,
      setCurrentWorkspaceDirectory,
      currentWorkspaceDirectory,
      realDirectoryKeyword
    ]
  )

  // 添加工作目录
  const handleAddWorkspaceDirectory = useCallback(
    async (type: 'SPEEDY' | 'PRIVATE' = 'SPEEDY') => {
      // 私有目录完全限制取消，邀请码弹窗只通过 QuotaWarningBar 组件由用户手动点开

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
            lastScanAt: null,
            createdAt: new Date(),
            updatedAt: new Date()
          }

          // 4. 调用后端添加目录
          await window.electronAPI!.addWorkspaceDirectory(newDirectory)

          // 5. 显式重新加载所有目录以获取完整的后端对象（含 ID 等）
          const allDirectories = await window.electronAPI!.getAllWorkspaceDirectories()
          setWorkspaceDirectories(allDirectories)

          // 6. 自动选中新创建的目录
          const { isPathEqual } = window.electronAPI!.utils
          const officialDirectory = allDirectories.find(d => isPathEqual(d.path, directoryPath))

          if (officialDirectory) {
            logger.info(LogCategory.RENDERER, '自动选中新创建的工作目录:', officialDirectory.name)
            await handleSelectWorkspaceDirectory(officialDirectory)
          } else {
            // 兜底：如果列表中没找到（不应该发生），则使用原始对象
            logger.warn(LogCategory.RENDERER, '列表中未找到新添加的目录，尝试使用原始对象选中')
            await handleSelectWorkspaceDirectory(newDirectory)
          }
        }
      } catch (error: any) {
        logger.error(LogCategory.RENDERER, '添加工作目录失败:', error)
        const msg = error instanceof Error ? error.message : t('添加工作目录失败')
        // 提取实际错误消息，去掉 IPC 调用前缀
        toast.error(msg.replace(/^Error invoking remote method.*?: Error: /, ''), 5000)
      }
    },
    [handleSelectWorkspaceDirectory, setWorkspaceDirectories]
  )

  const handleBack = useCallback(() => {
    if (currentHistoryIndex > 0) {
      const previousPath = navigationHistory[currentHistoryIndex - 1]
      setIsHistoryNavigation(true)
      setCurrentHistoryIndex(prev => prev - 1)
      setCurrentPath(previousPath)
      // 清空搜索关键词，避免过滤目录
      clearRealDirectorySearch()
      if (onDirectoryChange) {
        onDirectoryChange(previousPath)
      }
    }
  }, [
    currentHistoryIndex,
    navigationHistory,
    setCurrentPath,
    clearRealDirectorySearch,
    onDirectoryChange
  ])

  const handleForward = useCallback(() => {
    if (currentHistoryIndex < navigationHistory.length - 1) {
      const nextPath = navigationHistory[currentHistoryIndex + 1]
      setIsHistoryNavigation(true)
      setCurrentHistoryIndex(prev => prev + 1)
      setCurrentPath(nextPath)
      // 清空搜索关键词，避免过滤目录
      clearRealDirectorySearch()
      if (onDirectoryChange) {
        onDirectoryChange(nextPath)
      }
    }
  }, [
    currentHistoryIndex,
    navigationHistory,
    setCurrentPath,
    clearRealDirectorySearch,
    onDirectoryChange
  ])

  const isUpButtonDisabled = useCallback(() => {
    // 用户操作总是限制在工作目录范围内，所以必须有工作目录
    if (!currentWorkspaceDirectory) {
      return true // 没有工作目录时禁用向上按钮
    }

    // 只要当前目录是工作目录根目录，就禁用向上按钮
    const { isPathEqual } = window.electronAPI!.utils
    return isPathEqual(currentPath, currentWorkspaceDirectory.path)
  }, [currentPath, currentWorkspaceDirectory])

  const getParentPath = useCallback((currentPath: string): string => {
    if (!currentPath || currentPath === '') {
      return ''
    }

    const separator = window.electronAPI?.utils?.pathSeparator || '/'

    // 检查是否为Windows盘符根目录（如 C:\ 或 C:）
    if (/^[A-Za-z]:\\?$/.test(currentPath)) {
      return currentPath.endsWith(separator) ? currentPath : currentPath + separator
    }

    // 移除末尾的斜杠
    const cleanPath = currentPath.replace(/[\\\/]+$/, '')

    // 使用 path.dirname 的逻辑，但保持原生分隔符
    const lastSeparatorIndex = Math.max(cleanPath.lastIndexOf('\\'), cleanPath.lastIndexOf('/'))

    if (lastSeparatorIndex === -1) {
      return ''
    }

    const parentPath = cleanPath.substring(0, lastSeparatorIndex)

    // 如果父路径是盘符（如 C:），添加反斜杠
    if (/^[A-Za-z]:$/.test(parentPath)) {
      return parentPath + separator
    }

    return parentPath || ''
  }, [])

  const handleUp = useCallback(() => {
    // 检查是否应该禁用向上导航
    if (isUpButtonDisabled()) {
      return
    }

    // 使用更健壮的路径处理函数
    const parentPath = getParentPath(currentPath)

    // 清空搜索关键词，避免过滤目录
    clearRealDirectorySearch()

    setCurrentPath(parentPath)
    if (onDirectoryChange) {
      onDirectoryChange(parentPath)
    }
  }, [
    currentPath,
    isUpButtonDisabled,
    getParentPath,
    setCurrentPath,
    clearRealDirectorySearch,
    onDirectoryChange
  ])

  const handleDirectoryChange = useCallback(
    (path: string) => {
      setCurrentPath(path)
      // 确保当前目录被展开，以便显示其子目录
      expandDirectory(path)
      // 同时展开父目录，确保目录树结构正确
      const separator = window.electronAPI?.utils?.pathSeparator || '/'
      const parentPath = getParentPath(path)
      if (parentPath && parentPath !== separator) {
        expandDirectory(parentPath)
      }
      // 清空选中状态
      setSelectedItem(null)
      setShowDetailsPanel(true)
      useFileExplorerStore.getState().setSelectedFiles([])
      // 清空搜索关键词，避免过滤目录
      clearRealDirectorySearch()
      if (onDirectoryChange) {
        onDirectoryChange(path)
      }
    },
    [
      setCurrentPath,
      expandDirectory,
      getParentPath,
      setSelectedItem,
      setShowDetailsPanel,
      clearRealDirectorySearch,
      onDirectoryChange
    ]
  )

  // 刷新当前目录内容的函数
  const refreshDirectoryContents = useCallback(async () => {
    if (!currentPath || !currentWorkspaceDirectory) return
    try {
      const { files, directories } = await window.electronAPI!.readDirectory(currentPath)
      useFileExplorerStore.getState().setFiles(files)
      useFileExplorerStore.getState().setDirectories(directories)
      logger.info(LogCategory.RENDERER, '目录内容已刷新:', currentPath)

      // 如果一个项目当前在详情面板中被选中，同样更新它的数据
      // 这是为了确保在分析完成后，详情面板的缩略图也能刷新
      if (selectedItem) {
        const { isPathEqual } = window.electronAPI!.utils
        const allItems = [...files, ...directories]
        const updatedSelectedItem = allItems.find(it => isPathEqual(it.path, selectedItem.path))

        if (updatedSelectedItem) {
          logger.info(LogCategory.RENDERER, '同步更新选中项:', updatedSelectedItem.name)
          setSelectedItem(updatedSelectedItem)
        }
      }
    } catch (error) {
      logger.error(LogCategory.RENDERER, '刷新文件列表失败:', error)
      const message = t('未知错误')
      toast.error(t('刷新文件列表失败: {message}', { message }))
    }
  }, [currentPath, currentWorkspaceDirectory, selectedItem, setSelectedItem])

  const handleBatchAnalyzeAction = useCallback(async () => {
    try {
      const { selectedFiles } = useFileExplorerStore.getState()

      // 检查是否有选中文件
      if (selectedFiles.length === 0) {
        toast.warning(
          t('请先【全选】或【框选】您要分析的文件。小技巧：可以利用搜索过滤内容，再使用【全选】')
        )
        return
      }

      // 使用 Map 去重，避免同一个文件被添加多次
      const uniqueFiles = new Map<string, any>()
      selectedFiles.forEach((f: any) => {
        if (f?.path && !uniqueFiles.has(f.path)) {
          uniqueFiles.set(f.path, f)
        }
      })

      const filesToAdd = Array.from(uniqueFiles.values())
        .map((f: any) => ({
          path: f?.path,
          name: f?.name,
          size: f?.isDirectory ? 0 : f?.size || 0,
          type: f?.isDirectory ? 'folder' : f?.extension || 'file'
        }))
        .filter(i => !!i.path)

      if (filesToAdd.length > 0) {
        await addItems(filesToAdd)
        await start()
        // 强制以 split 面板形式打开队列，确保用户点击「队列：x/x」时能正常切换
        // 注意：必须同时把 viewMode 置为 'split'，否则 window 模式下队列面板不会渲染
        useAnalysisQueueStore.setState({
          viewMode: 'split',
          isSplitOpen: true,
          showModal: false,
          isSplitMinimized: false
        })
        window.electronAPI?.setQueueViewMode?.({ mode: 'split', isSplitOpen: true })
      }
    } catch (error: any) {
      // 提取实际错误消息，去掉 IPC 调用前缀
      let errorMsg = error?.message || t('未知错误')
      const match = errorMsg.match(/Error invoking remote method '[^']+':\s*(.*)/)
      if (match && match[1]) {
        errorMsg = match[1]
      }

      if (errorMsg.includes('配额')) {
        toast.error(errorMsg)
      } else if (errorMsg) {
        toast.error(t('分析失败：{error}', { error: errorMsg }))
      }
    }
  }, [addItems, start])

  return (
    <div className="flex-1 flex flex-col bg-muted/30 overflow-hidden animate-in fade-in duration-300 slide-in-from-bottom-1">
      <DirectoryHeader
        currentWorkspaceDirectory={currentWorkspaceDirectory}
        workspaceDirectories={workspaceDirectories}
        showDirectoryDropdown={showDirectoryDropdown}
        isRealDirectory={true}
        onToggleDirectoryDropdown={forceState =>
          setShowDirectoryDropdown(forceState !== undefined ? forceState : !showDirectoryDropdown)
        }
        onSelectWorkspaceDirectory={handleSelectWorkspaceDirectory}
        onAddWorkspaceDirectory={handleAddWorkspaceDirectory}
        dropdownRef={dropdownRef}
        onSearch={handleSearch}
      />

      {currentWorkspaceDirectory ? (
        <div className="flex-1 flex flex-col overflow-hidden">
          <QuotaWarningBar
            currentWorkspaceDirectory={currentWorkspaceDirectory}
            machineId={machineId}
            setMachineId={setMachineId}
            setShowInvitationModal={setShowInvitationModal}
          />
          <div className="flex-1 flex overflow-hidden relative">
            <main className="flex-1 min-w-0 bg-card overflow-hidden flex flex-col">
              <FileExplorerLayout
                files={filteredData.files}
                directories={filteredData.directories}
                selectedFiles={selectedFiles}
                activeItem={selectedItem}
                onFileSelect={handleFileSelect}
                onDirectoryChange={handleDirectoryChange}
                viewMode={viewMode}
                onViewModeChange={mode => setViewMode(mode as any)}
                currentPath={currentPath}
                isRealDirectory={true}
                showsmartName={true}
                workspaceDirectoryPath={currentWorkspaceDirectory?.path}
                workspaceDirectoryType={currentWorkspaceDirectory?.type as any}
                refreshKey={refreshKey}
                onBack={handleBack}
                onForward={handleForward}
                onUp={handleUp}
                pageId={PAGE_IDS.REAL_DIRECTORY}
                showDetailsPanel={showDetailsPanel}
                showPreviewPanel={isSplitView}
                onCloseDetailsPanel={() => setShowDetailsPanel(false)}
                onFileDeleted={refreshDirectoryContents}
                onFileUpdated={refreshDirectoryContents}
                renderToolbar={layoutContext => (
                  <div className="flex-shrink-0 border-b border-border px-3 py-1.5 flex flex-wrap items-center justify-between bg-card gap-y-2 gap-x-3 min-h-[44px]">
                    {/* 左侧：集成式导航胶囊与面包屑 */}
                    <div className="flex items-center space-x-2 flex-1 min-w-[200px]">
                      <div className="inline-flex items-center rounded-lg border border-border/60 bg-muted/20 p-0.5 shadow-2xs">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-foreground/80 hover:text-foreground hover:bg-background/80 rounded-md transition-all disabled:opacity-30 cursor-pointer"
                          onClick={handleBack}
                          disabled={currentHistoryIndex <= 0}
                          title={t('后退 (Alt+Left / Backspace)')}
                        >
                          <MaterialIcon icon="arrow_back" className="text-lg" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-foreground/80 hover:text-foreground hover:bg-background/80 rounded-md transition-all disabled:opacity-30 cursor-pointer"
                          onClick={handleForward}
                          disabled={currentHistoryIndex >= navigationHistory.length - 1}
                          title={t('前进 (Alt+Right)')}
                        >
                          <MaterialIcon icon="arrow_forward" className="text-lg" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-foreground/80 hover:text-foreground hover:bg-background/80 rounded-md transition-all disabled:opacity-30 cursor-pointer"
                          onClick={handleUp}
                          disabled={isUpButtonDisabled()}
                          title={t('向上 (Alt+Up)')}
                        >
                          <MaterialIcon icon="arrow_upward" className="text-lg" />
                        </Button>
                      </div>

                      <div
                        className="flex items-center text-sm font-medium text-foreground dark:text-foreground ml-1 min-w-0 overflow-x-auto custom-scrollbar-hide"
                        data-breadcrumbs-container
                      >
                        <Breadcrumbs
                          currentPath={currentPath}
                          basePath={currentWorkspaceDirectory?.path || ''}
                          onNavigate={path => {
                            setCurrentPath(path)
                            clearRealDirectorySearch()
                            if (onDirectoryChange) onDirectoryChange(path)
                          }}
                        />
                      </div>

                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0 text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors flex-shrink-0 rounded-md cursor-pointer"
                        onClick={() => {
                          if (currentPath) {
                            window
                              .electronAPI!.utils.openPathInExplorer(currentPath)
                              .catch((error: any) => {
                                logger.error(
                                  LogCategory.RENDERER,
                                  '无法在资源管理器中打开目录:',
                                  error
                                )
                                const message =
                                  error?.message?.replace(
                                    /^Error invoking remote method.*?: Error: /,
                                    ''
                                  ) || String(error)
                                toast.error(t('无法打开目录: {message}', { message }))
                              })
                          }
                        }}
                        title={t('在系统文件浏览器中打开')}
                      >
                        <MaterialIcon icon="open_in_new" className="text-base" />
                      </Button>
                      <div className="flex-1" />
                    </div>

                    {/* 右侧：搜索、视图设置、一体化全选分析胶囊及工具 */}
                    <div className="flex items-center gap-2 text-foreground dark:text-foreground ml-auto">
                      {/* 搜索框 */}
                      <div className="flex-shrink-0 relative z-10 h-8 flex items-center">
                        <SearchBar
                          type="real-directory"
                          placeholder={t('搜索...')}
                          onSearch={handleSearch}
                          className="w-30 focus-within:w-80 transition-all duration-300"
                        />
                      </div>

                      {/* 视图模式与显示设置 Mini 下拉弹窗 */}
                      <MiniViewDisplaySettingsPopover
                        viewMode={layoutContext.viewMode}
                        onViewModeChange={async newMode => {
                          layoutContext.setViewMode(newMode)
                          try {
                            await updateConfigValue('DEFAULT_VIEW', newMode)
                          } catch (error) {
                            logger.error(LogCategory.RENDERER, 'Failed to update view mode:', error)
                          }
                        }}
                        gridCardWidth={layoutContext.gridCardWidth}
                        onGridCardWidthChange={layoutContext.setGridCardWidth}
                      />

                      {/* 分隔线 */}
                      <div className="h-4 w-px bg-border/60 mx-0.5" />

                      {/* 全选 + 批量分析 + 队列进度 一体化分段操作胶囊 */}
                      <div
                        className={cn(
                          'flex items-stretch h-8 rounded-lg border shadow-2xs overflow-hidden transition-all duration-200 bg-background',
                          selectedFiles.length > 0
                            ? 'border-primary/40 ring-1 ring-primary/20'
                            : 'border-border'
                        )}
                      >
                        {/* 1. 复选框与全选/已选状态标签 */}
                        <div
                          role="checkbox"
                          aria-checked={isAllSelected ? true : isIndeterminate ? 'mixed' : false}
                          onClick={toggleSelectAll}
                          className={cn(
                            'flex items-center gap-1.5 px-2.5 cursor-pointer select-none transition-colors group',
                            selectedFiles.length > 0
                              ? 'bg-primary/5 hover:bg-primary/10 text-primary'
                              : 'hover:bg-accent/60 text-muted-foreground hover:text-foreground',
                            filteredData.files.length + filteredData.directories.length === 0 &&
                              'opacity-40 cursor-not-allowed pointer-events-none'
                          )}
                          title={
                            filteredData.files.length + filteredData.directories.length === 0
                              ? t('没有文件')
                              : isAllSelected
                                ? t('取消全选')
                                : t('全选当前页面 (Ctrl+A)')
                          }
                        >
                          <Checkbox
                            checked={isAllSelected ? true : isIndeterminate ? 'indeterminate' : false}
                            onCheckedChange={() => toggleSelectAll()}
                            className={cn(
                              'transition-transform duration-150',
                              selectedFiles.length > 0 ? 'border-primary' : 'border-muted-foreground/60'
                            )}
                          />
                          <span className="text-xs font-medium whitespace-nowrap">
                            {selectedFiles.length === 0
                              ? t('全选')
                              : isAllSelected
                                ? t('已全选 ({count})', { count: selectedFiles.length })
                                : t('已选 {count} 项', { count: selectedFiles.length })}
                          </span>
                        </div>

                        {/* 中部分割线 */}
                        <div
                          className={cn(
                            'w-px self-stretch',
                            selectedFiles.length > 0 ? 'bg-primary/20' : 'bg-border'
                          )}
                        />

                        {/* 2. 批量分析行动按钮 */}
                        <Button
                          variant={selectedFiles.length ? 'default' : 'ghost'}
                          size="sm"
                          className={cn(
                            'h-full gap-1.5 rounded-none border-0 px-3 transition-all duration-200 text-xs font-medium cursor-pointer',
                            selectedFiles.length > 0
                              ? 'bg-primary text-primary-foreground hover:bg-primary/90 shadow-2xs'
                              : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                          )}
                          onClick={handleBatchAnalyzeAction}
                          title={
                            selectedFiles.length === 0
                              ? t('请先勾选或框选要分析的文件')
                              : t('批量分析选中的 {count} 个文件', { count: selectedFiles.length })
                          }
                        >
                          <MaterialIcon
                            icon="auto_awesome"
                            className={cn('text-sm', selectedFiles.length > 0 && 'animate-pulse')}
                          />
                          <span>{t('批量分析')}</span>
                        </Button>

                        {/* 3. 分析队列状态（当队列有任务时无缝附加） */}
                        {snapshot.items.length > 0 && (
                          <>
                            <div
                              className={cn(
                                'w-px self-stretch',
                                selectedFiles.length > 0 ? 'bg-primary/20' : 'bg-border'
                              )}
                            />
                            <PersistentTooltip
                              id="real_dir_analysis_queue_hint"
                              content={t('查看和管理文件分析进度')}
                              visible={snapshot.running}
                              position="bottom"
                              delay={1000}
                            >
                              <Button
                                variant="ghost"
                                size="sm"
                                className={cn(
                                  'h-full gap-1.5 rounded-none border-0 px-2.5 transition-all duration-300 text-xs cursor-pointer',
                                  snapshot.running
                                    ? 'bg-primary/10 text-primary hover:bg-primary/20'
                                    : 'hover:bg-accent text-muted-foreground hover:text-foreground'
                                )}
                                onClick={e => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  toggleQueue()
                                }}
                              >
                                {snapshot.running && (
                                  <MaterialIcon icon="sync" className="animate-spin text-xs text-primary" />
                                )}
                                <span className="font-semibold text-xs">
                                  {!snapshot.running
                                    ? t('队列已暂停 ({length}/{snapshotLength})', {
                                        length: snapshot.items.filter(i => i.status === 'completed')
                                          .length,
                                        snapshotLength: snapshot.items.length
                                      })
                                    : t('队列 ({length}/{snapshotLength})', {
                                        length: snapshot.items.filter(i => i.status === 'completed')
                                          .length,
                                        snapshotLength: snapshot.items.length
                                      })}
                                </span>
                              </Button>
                            </PersistentTooltip>
                          </>
                        )}
                      </div>

                      {/* 分隔线 */}
                      <div className="h-4 w-px bg-border/60 mx-0.5" />

                      {/* 文件清理入口按钮 */}
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 gap-1.5 shadow-2xs hover:bg-accent border-border/80 text-xs font-medium rounded-lg px-2.5 transition-all hover:border-primary/40 cursor-pointer"
                        onClick={() => {
                          const store = useOrganizeStore.getState()
                          store.setActiveBranch('batch-duplicate')
                          store.setStage('batch-duplicate')
                          navigate('/organize')
                        }}
                        title={t('扫描并清理重复、临时与大文件')}
                      >
                        <MaterialIcon icon="cleaning_services" className="text-sm text-primary" />
                        <span>{t('文件清理')}</span>
                      </Button>
                    </div>
                  </div>
                )}
              />
            </main>
            {!isWorkspaceActive && currentWorkspaceDirectory && (
              <RestrictedFeatureOverlay
                type={currentWorkspaceDirectory.type || 'SPEEDY'}
                targetName={currentWorkspaceDirectory.name}
                targetId={currentWorkspaceDirectory.id!}
                onSuccess={() => {
                  fetchProfile()
                  window.dispatchEvent(new CustomEvent('workspace-directories-updated'))
                }}
              />
            )}
          </div>
        </div>
      ) : (
        <NoWorkspaceDirectoryMessage onAddWorkspaceDirectory={handleAddWorkspaceDirectory} />
      )}

      {/* 解锁私有目录无限额度弹窗 */}
      <UnlockPrivateQuotaModal
        isOpen={showInvitationModal}
        onClose={() => setShowInvitationModal(false)}
        quota={quota}
        onRefresh={async () => {
          await refreshInvitationCount()
        }}
        isLoading={isInvitationLoading}
        workspaceId={currentWorkspaceDirectory?.id}
      />
    </div>
  )
}
