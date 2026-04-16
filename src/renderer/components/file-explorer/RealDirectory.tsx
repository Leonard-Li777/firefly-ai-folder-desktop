import {
  DirectoryItem,
  FileItem as FileType,
  WorkspaceDirectory,
} from '@yonuc/types'
import { LogCategory, logger } from '@yonuc/shared'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '../ui/button'
import { DirectoryHeader } from './DirectoryHeader'
import { FileDetailsPanel } from './FileDetailsPanel'
import { FileList } from './FileList'
import { InvitationModal } from '../invitation/InvitationModal'
import { MaterialIcon } from '../../lib/utils'
import { NoWorkspaceDirectoryMessage } from '../common/NoWorkspaceDirectoryMessage'
import { QuotaWarningBar } from './QuotaWarningBar'
import { cn } from '../../lib/utils'
import { t } from '@app/languages'
import { toast } from '../common/Toast'
import { useAnalysisQueueStore } from '../../stores/analysis-queue-store'
import { useFileExplorerStore } from '../../stores/app-store'
import { useInvitation } from '../../hooks/useInvitation'
import { useNavigate } from 'react-router-dom'
import { useSearchStore } from '../../stores/search-store'
import { useSettingsStore } from '../../stores/settings-store'
import { useVirtualDirectoryStore } from '../../stores/virtual-directory-store'

interface RealDirectoryProps {
  onFileSelect?: (files: any[], isFromCheckbox?: boolean) => void
  onDirectoryChange?: (path: string) => void
}

export const RealDirectory: React.FC<RealDirectoryProps> = ({
  onFileSelect: externalOnFileSelect,
  onDirectoryChange,
}) => {
  const navigate = useNavigate()

  // 内部处理文件选择的函敶
  const handleFileSelect = (
    newSelection: (string | FileType | DirectoryItem)[],
    isFromCheckbox = false
  ) => {
    const { selectedFiles, setSelectedFiles } = useFileExplorerStore.getState()

    const normalizePath = (p?: string) => (p ? p.replace(/\\/g, '/') : '')
    const resolveByPath = (path: string) => {
      const { directories, files } = useFileExplorerStore.getState()
      const all = [...directories, ...files]
      const n = normalizePath(path)
      return all.find(it => normalizePath((it as any).path) === n) || null
    }
    const toObjectEntry = (entry: string | FileType | DirectoryItem) => {
      if (entry && typeof entry === 'object') return entry as FileType | DirectoryItem
      const path = typeof entry === 'string' ? entry : ''
      if (!path) return null
      return resolveByPath(path)
    }
    const getEntryPath = (entry: string | FileType | DirectoryItem) =>
      typeof entry === 'object' ? ((entry as any).path as string) : entry || ''

    if (isFromCheckbox) {
      // Create a set of the current selection paths for efficient lookup
      const currentSelectionPaths = new Set(
        selectedFiles.filter(f => !!(f as any).path).map((f: any) => normalizePath(f.path))
      )
      // Create a set of the new selection paths
      const newSelectionPaths = new Set(
        newSelection.map(e => normalizePath(getEntryPath(e))).filter(Boolean)
      )

      // Determine which files to add and which to remove
      const filesToAdd = newSelection
        .filter(e => {
          const p = normalizePath(getEntryPath(e))
          return p && !currentSelectionPaths.has(p)
        })
        .map(toObjectEntry)
        .filter(Boolean) as (FileType | DirectoryItem)[]
      const filesToRemove = selectedFiles.filter((f: any) => {
        const p = normalizePath(f.path)
        return p && !newSelectionPaths.has(p)
      })

      let updatedSelection = [...selectedFiles]

      if (filesToAdd.length > 0) {
        updatedSelection = [...updatedSelection, ...(filesToAdd as FileType[])]

      }
      if (filesToRemove.length > 0) {
        const pathsToRemove = new Set(
          filesToRemove.filter(f => !!f.path).map(f => normalizePath(f.path))
        )
        updatedSelection = updatedSelection.filter(
          f => !pathsToRemove.has(f.path.replace(/\\/g, '/'))
        )
      }

      // 处理目录递归选择
      const directorySelected = newSelection
        .map(toObjectEntry)
        .find(obj => !!obj && (obj as any).isDirectory) as DirectoryItem | undefined

      if (directorySelected) {
        const isSelected = directorySelected.path
          ? newSelectionPaths.has(normalizePath(directorySelected.path))
          : false
        const allItems = [
          ...useFileExplorerStore.getState().directories,
          ...useFileExplorerStore.getState().files,
        ]

        const getAllChildItems = (dirPath: string): (FileType | DirectoryItem)[] => {
          const children = allItems.filter(
            item => normalizePath((item as any).parentPath) === normalizePath(dirPath)
          )
          let allChildren = [...children]
          children.forEach(child => {
            if ('isDirectory' in child && child.isDirectory) {
              allChildren = [...allChildren, ...getAllChildItems(child.path)]
            }
          })
          return allChildren
        }

        const childItems = getAllChildItems(directorySelected.path || '')
        const childPaths = new Set(
          childItems.filter(item => !!item.path).map(item => normalizePath(item.path))
        )

        if (isSelected) {
          const itemsToAdd = [directorySelected, ...childItems].filter(
            item => !currentSelectionPaths.has(normalizePath(item.path))
          )
          updatedSelection = [...updatedSelection, ...(itemsToAdd as FileType[])]
        } else {
          const pathsToRemove = new Set([normalizePath(directorySelected.path), ...childPaths])
          updatedSelection = updatedSelection.filter(
            (f: unknown) => !pathsToRemove.has(normalizePath((f as FileType).path))
          )
        }
      }

      setSelectedFiles(updatedSelection)
    } else {
      // For single-item clicks, update only the details panel, not the selection state
      // This ensures clicking a directory name only shows details, without adding it to any list
      if (newSelection.length > 0) {
        const selectedItemObject = toObjectEntry(newSelection[0])
        if (selectedItemObject) {
          // Check if clicking the same item to toggle selection
          if (selectedItem && selectedItem.path === selectedItemObject.path) {
            setSelectedItem(null)
          } else {
            setSelectedItem(selectedItemObject)
          }
          setShowDetailsPanel(true)
          // Note: We intentionally do NOT modify selectedFiles here to avoid confusion
          // Only checkbox interactions should modify the selection
        }
      } else {
        setSelectedItem(null)
        setShowDetailsPanel(true)
      }
    }

    if (externalOnFileSelect) {
      externalOnFileSelect(newSelection, isFromCheckbox)
    }
  }
  const {
    currentPath,
    files: storeFiles,
    directories: storeDirectories,
    selectedFiles,
    setCurrentPath,
    toggleDirectory,
    expandDirectory,
    collapseDirectory,
  } = useFileExplorerStore()

  const { setCurrentWorkspaceDirectory: setGlobalWorkspaceDirectory } = useVirtualDirectoryStore()

  // 使用 useMemo 稳定 files 和 directories 的引用，避免不必要的重新渲染
  // 只有当数组长度或第一个/最后一个元素的路径变化时才更新
  const files = useMemo(() => storeFiles, [
    storeFiles.length,
    storeFiles[0]?.path,
    storeFiles[storeFiles.length - 1]?.path
  ])
  
  const directories = useMemo(() => storeDirectories, [
    storeDirectories.length,
    storeDirectories[0]?.path,
    storeDirectories[storeDirectories.length - 1]?.path
  ])

  const { config, updateConfigValue } = useSettingsStore()
  const [viewMode, setViewMode] = useState<'list' | 'grid'>(config.defaultView || 'list')
  const [workspaceDirectories, setWorkspaceDirectories] = useState<WorkspaceDirectory[]>([])
  const [currentWorkspaceDirectory, setCurrentWorkspaceDirectory] =
    useState<WorkspaceDirectory | null>(null)
  const [showDirectoryDropdown, setShowDirectoryDropdown] = useState(false)
  const [selectedItem, setSelectedItem] = useState<FileType | DirectoryItem | null>(null)
  const [showDetailsPanel, setShowDetailsPanel] = useState(true)

  // 邀请相关状态
  const [showInvitationModal, setShowInvitationModal] = useState(false)
  const { invitationCount, isInvited, quota, refreshCount: refreshInvitationCount, isLoading: isInvitationLoading } = useInvitation(true)

  const [machineId, setMachineId] = useState('')
  const [navigationHistory, setNavigationHistory] = useState<string[]>([])
  const [currentHistoryIndex, setCurrentHistoryIndex] = useState(-1)
  const [isHistoryNavigation, setIsHistoryNavigation] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const { snapshot, openModal, addItems, start } = useAnalysisQueueStore()

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
      logger.info(LogCategory.RENDERER, `[分析队列] 检测到项目分析完成，准备刷新列表...`)
      
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
      
      refreshTimer.current = setTimeout(() => {
        refreshDirectoryContents()
        setRefreshKey(Date.now()) // 更新 Key，强制刷新图片
        lastCompletedIds.current = currentCompletedIds
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

  // search store
  const { realDirectoryKeyword, setRealDirectoryKeyword, clearRealDirectorySearch } =
    useSearchStore()

  // 过滤文件和目录（根据搜索关键词）
  const filteredData = useMemo(() => {
    if (!realDirectoryKeyword.trim()) {
      return { files, directories }
    }

    const keyword = realDirectoryKeyword.toLowerCase().trim()

    const filteredFiles = files.filter(file => {
      // 搜索文件名
      if (file.name.toLowerCase().includes(keyword)) return true
      // 搜索文件路径
      if (file.path.toLowerCase().includes(keyword)) return true
      // 搜索文件扩展名
      if (file.extension && file.extension.toLowerCase().includes(keyword)) return true
      return false
    })

    const filteredDirs = directories.filter(dir => {
      // 搜索目录名
      if (dir.name.toLowerCase().includes(keyword)) return true
      // 搜索目录路径
      if (dir.path.toLowerCase().includes(keyword)) return true
      return false
    })

    return { files: filteredFiles, directories: filteredDirs }
  }, [files, directories, realDirectoryKeyword])

  // 当搜索过滤结果变化时，清理不在结果中的已选中项
  useEffect(() => {
    if (selectedFiles.length > 0) {
      const allFilteredPaths = new Set([
        ...filteredData.files.map(f => f.path.replace(/\\/g, '/')),
        ...filteredData.directories.map(d => d.path.replace(/\\/g, '/'))
      ])

      const newSelected = selectedFiles.filter(f => {
        const path = (f as any).path?.replace(/\\/g, '/')
        return path && allFilteredPaths.has(path)
      })

      if (newSelected.length !== selectedFiles.length) {
        useFileExplorerStore.getState().setSelectedFiles(newSelected)
      }
    }
  }, [filteredData])

  // 监听defaultView配置变化
  useEffect(() => {
    if (config.defaultView) {
      setViewMode(config.defaultView)
    }
  }, [config.defaultView])

  // 点击外部区域关闭下拉菜单
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDirectoryDropdown(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [])

  // 获取当前目录的文件列表的函数
  const loadDirectoryContents = useCallback(async () => {
    if (!currentPath || !currentWorkspaceDirectory) return // 只有在有工作目录且路径存在时才加载内容

    try {
      const { files, directories } = await window.electronAPI!.readDirectory(currentPath)
      logger.info(LogCategory.RENDERER, '接收到目录数据', {
        currentPath,
        filesCount: files.length,
        directoriesCount: directories.length,
        directoryNames: directories.map((d: DirectoryItem) => d.name)
      })
      useFileExplorerStore.getState().setFiles(files)
      useFileExplorerStore.getState().setDirectories(directories)
      logger.info(LogCategory.RENDERER, '已更新store', { 
        storeFilesCount: useFileExplorerStore.getState().files.length,
        storeDirectoriesCount: useFileExplorerStore.getState().directories.length
      })
    } catch (error) {
      logger.error(LogCategory.RENDERER, '读取目录失败:', error)
      // 读取失败时清空文件和目录
      useFileExplorerStore.getState().setFiles([])
      useFileExplorerStore.getState().setDirectories([])
    }
  }, [currentPath, currentWorkspaceDirectory]);

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
        
        // 分离副作用：先设置目录，路径更新交给 useEffect
        setCurrentWorkspaceDirectory(currentDir)
        // 同步到全局虚拟目录 Store
        setGlobalWorkspaceDirectory(currentDir)
      } catch (error) {
        logger.error(LogCategory.RENDERER, '获取工作目录失败:', error)
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
      // 只有当路径不一致时才更新，避免无限循环
      if (currentPath !== currentWorkspaceDirectory.path && (!currentPath || !currentPath.startsWith(currentWorkspaceDirectory.path))) {
        setCurrentPath(currentWorkspaceDirectory.path)
      }
    } else {
      if (currentPath !== '') {
        setCurrentPath('')
      }
    }
  }, [currentWorkspaceDirectory])

  // 监听当前目录的文件更新事件（增量刷新）
  useEffect(() => {
    let debounceTimer: NodeJS.Timeout | null = null;

    const unsubscribeFiles = window.electronAPI!.onDirectoryFilesUpdated?.((updatedPath: string) => {
      // 只有当更新的目录是当前显示的目录时，才重新加载内容
      const normalize = (p: string) => p.replace(/\\/g, '/').toLowerCase();
      if (currentPath && normalize(updatedPath) === normalize(currentPath)) {
        if (debounceTimer) clearTimeout(debounceTimer);
        
        debounceTimer = setTimeout(() => {
          logger.info(LogCategory.RENDERER, '当前目录文件有更新，执行防抖加载:', updatedPath)
          loadDirectoryContents()
        }, 500); // 500ms 防抖
      }
    })

    return () => {
      if (unsubscribeFiles) {
        unsubscribeFiles()
      }
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
    }
  }, [currentPath, loadDirectoryContents]) // 依赖项确保闭包内的路径是最新的

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
  const handleSelectWorkspaceDirectory = async (directory: WorkspaceDirectory) => {
    try {
      await window.electronAPI!.setCurrentWorkspaceDirectory(directory.path)
      setCurrentWorkspaceDirectory(directory)
      // 同步到全局虚拟目录 Store
      setGlobalWorkspaceDirectory(directory)
      setCurrentPath(directory.path)
      setShowDirectoryDropdown(false)
      // 重置导航历史，确保工作空间切换时历史被隔离
      setNavigationHistory([])
      setCurrentHistoryIndex(-1)

      if (onDirectoryChange) {
        onDirectoryChange(directory.path)
      }
    } catch (error) {
      logger.error(LogCategory.RENDERER, '设置当前工作目录失败:', error)
    }
  }

  // 添加工作目录
  const handleAddWorkspaceDirectory = async (type: 'SPEEDY' | 'PRIVATE' = 'SPEEDY') => {
    // 私有目录完全限制取消，邀请码弹窗只通过 QuotaWarningBar 组件由用户手动点开

    try {
      const result = await window.electronAPI!.utils.showOpenDialog({
        properties: ['openDirectory'],
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
          updatedAt: new Date(),
        }

        await window.electronAPI!.addWorkspaceDirectory(newDirectory)

        // 重新加载工作目录
        const directories = await window.electronAPI!.getAllWorkspaceDirectories()
        setWorkspaceDirectories(directories)

        // 设置为当前目录
        await handleSelectWorkspaceDirectory(newDirectory)
      }
    } catch (error: any) {
      logger.error(LogCategory.RENDERER, '添加工作目录失败:', error)
      const msg = error instanceof Error ? error.message : t('添加工作目录失败')
      // 提取实际错误消息，去掉 IPC 调用前缀
      toast.error(msg.replace(/^Error invoking remote method.*?: Error: /, ''), 5000)
    }
  }

  const handleBack = () => {
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
  }

  const handleForward = () => {
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
  }

  const handleUp = () => {
    console.log('handleUp called', {
      currentPath,
      currentWorkspaceDirectory: currentWorkspaceDirectory?.path,
      realDirectoryKeyword, // 添加搜索关键词日志
    })

    // 检查是否应该禁用向上导航
    if (isUpButtonDisabled()) {
      console.log('Up button is disabled - already at workspace directory root')
      return
    }

    // 使用更健壮的路径处理函数
    const parentPath = getParentPath(currentPath)
    console.log('Navigating to parent path:', parentPath)
    
    // 清空搜索关键词，避免过滤目录
    console.log('Clearing search keyword before navigation')
    clearRealDirectorySearch()
    console.log('Search keyword after clear:', realDirectoryKeyword)
    
    setCurrentPath(parentPath)
    if (onDirectoryChange) {
      onDirectoryChange(parentPath)
    }
  }

  // 获取父路径的辅助函数，保持Windows原生路径格式（反斜杠）
  const getParentPath = (currentPath: string): string => {
    if (!currentPath || currentPath === '') {
      return ''
    }

    // 检查是否为Windows盘符根目录（如 C:\ 或 C:）
    if (/^[A-Za-z]:\\?$/.test(currentPath)) {
      return currentPath.endsWith('\\') ? currentPath : currentPath + '\\'
    }

    // 移除末尾的斜杠
    const cleanPath = currentPath.replace(/[\\\/]+$/, '')

    // 使用 path.dirname 的逻辑，但保持原生分隔符
    const lastSeparatorIndex = Math.max(
      cleanPath.lastIndexOf('\\'),
      cleanPath.lastIndexOf('/')
    )

    if (lastSeparatorIndex === -1) {
      return ''
    }

    const parentPath = cleanPath.substring(0, lastSeparatorIndex)

    // 如果父路径是盘符（如 C:），添加反斜杠
    if (/^[A-Za-z]:$/.test(parentPath)) {
      return parentPath + '\\'
    }

    return parentPath || ''
  }

  // 检查向上按钮是否应该被禁用
  const isUpButtonDisabled = () => {
    // 用户操作总是限制在工作目录范围内，所以必须有工作目录
    if (!currentWorkspaceDirectory) {
      return true // 没有工作目录时禁用向上按钮
    }

    // 只要当前目录是工作目录根目录，就禁用向上按钮
    const normalizedCurrentPath = currentPath.replace(/\\/g, '/')
    const normalizedWorkspacePath = currentWorkspaceDirectory.path
      ? currentWorkspaceDirectory.path.replace(/\\/g, '/')
      : ''

    return normalizedCurrentPath === normalizedWorkspacePath
  }

  const handleDirectoryChange = (path: string) => {
    setCurrentPath(path)
    // 确保当前目录被展开，以便显示其子目录
    expandDirectory(path)
    // 同时展开父目录，确保目录树结构正确
    const parentPath = path.split('/').slice(0, -1).join('/') || '/'
    if (parentPath !== '/') {
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
  }

  // 搜索处理函数
  const handleSearch = (keyword: string) => {
    setRealDirectoryKeyword(keyword)
  }

  // 刷新当前目录内容的函数
  const refreshDirectoryContents = async () => {
    if (!currentPath || !currentWorkspaceDirectory) return
    try {
      const { files, directories } = await window.electronAPI!.readDirectory(currentPath)
      useFileExplorerStore.getState().setFiles(files)
      useFileExplorerStore.getState().setDirectories(directories)
      logger.info(LogCategory.RENDERER, '目录内容已刷新:', currentPath)

      // 如果一个项目当前在详情面板中被选中，同样更新它的数据
      // 这是为了确保在分析完成后，详情面板的缩略图也能刷新
      if (selectedItem) {
        const normalizedSelectedItemPath = selectedItem.path.replace(/\\/g, '/')
        const allItems = [...files, ...directories]
        const updatedSelectedItem = allItems.find(it => it.path.replace(/\\/g, '/') === normalizedSelectedItemPath)
        
        if (updatedSelectedItem) {
          logger.info(LogCategory.RENDERER, '同步更新选中项:', updatedSelectedItem.name)
          setSelectedItem(updatedSelectedItem)
        }
      }
    } catch (error) {
      logger.error(LogCategory.RENDERER, '刷新文件列表失败:', error)
    }
  }

  return (
    <div className="flex-1 flex flex-col bg-muted/10 overflow-hidden">
      {/* Shared Header */}
      <DirectoryHeader
        currentWorkspaceDirectory={currentWorkspaceDirectory}
        workspaceDirectories={workspaceDirectories}
        showDirectoryDropdown={showDirectoryDropdown}
        isRealDirectory={true}
        onToggleDirectoryDropdown={() => setShowDirectoryDropdown(!showDirectoryDropdown)}
        onSelectWorkspaceDirectory={handleSelectWorkspaceDirectory}
        onAddWorkspaceDirectory={handleAddWorkspaceDirectory}
        dropdownRef={dropdownRef}
        onSearch={handleSearch}
      />

      {currentWorkspaceDirectory ? (
        <div className="flex-1 flex flex-col overflow-hidden">
          <QuotaWarningBar
            quota={quota}
            currentWorkspaceDirectory={currentWorkspaceDirectory}
            machineId={machineId}
            setMachineId={setMachineId}
            setShowInvitationModal={setShowInvitationModal}
          />
          <div className="flex-1 flex overflow-x-auto overflow-y-hidden">
            <main className="flex-1 min-w-0 bg-card overflow-hidden flex">
            <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
              {/* Navigation Bar / Toolbar */}
              <div className="flex-shrink-0 border-b border-border px-3 py-2 flex items-center justify-between bg-card">
                <div className="flex items-center space-x-2 flex-1 min-w-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0 text-foreground dark:text-foreground hover:bg-accent dark:hover:bg-accent"
                    onClick={handleBack}
                    disabled={currentHistoryIndex <= 0}
                  >
                    <MaterialIcon icon="arrow_back" className="text-xl" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0 text-foreground dark:text-foreground hover:bg-accent dark:hover:bg-accent"
                    onClick={handleForward}
                    disabled={currentHistoryIndex >= navigationHistory.length - 1}
                  >
                    <MaterialIcon icon="arrow_forward" className="text-xl" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0 text-foreground dark:text-foreground hover:bg-accent dark:hover:bg-accent"
                    onClick={handleUp}
                    disabled={isUpButtonDisabled()}
                  >
                    <MaterialIcon icon="arrow_upward" className="text-xl" />
                  </Button>
                  <div className="text-sm font-medium text-foreground dark:text-foreground ml-3 truncate flex-shrink min-w-0">
                    {currentPath}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0 text-muted-foreground hover:text-primary transition-colors"
                    onClick={() => {
                      if (currentPath) {
                        window.electronAPI!.utils.openPathInExplorer(currentPath)
                      }
                    }}
                    title={t('在系统文件浏览器中打开')}
                  >
                    <MaterialIcon icon="open_in_new" className="text-base" />
                  </Button>
                </div>
                <div className="flex items-center space-x-2 text-foreground dark:text-foreground">
                  {/* View Mode Toggle */}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0 text-foreground dark:text-foreground hover:bg-accent dark:hover:bg-accent"
                    onClick={async () => {
                      const newMode = viewMode === 'list' ? 'grid' : 'list'
                      setViewMode(newMode)
                      // 同步到 ConfigOrchestrator
                      try {
                        await updateConfigValue('DEFAULT_VIEW', newMode)
                      } catch (error) {
                        logger.error(LogCategory.RENDERER, 'Failed to update view mode:', error)
                      }
                    }}
                    title={viewMode === 'list' ? t('切换为缩略图视图'): t('切换为列表视图')}
                  >
                    <MaterialIcon
                      icon={viewMode === 'list' ? 'view_list' : 'grid_view'}
                      className="text-xl"
                    />
                  </Button>
                  
                  {/* Select All Checkbox - Show in both list and grid view */}
                  <label className="flex items-center gap-2 px-2 py-1 rounded hover:bg-accent/20 dark:hover:bg-accent/20 cursor-pointer transition-colors">
                    <input
                      type="checkbox"
                      className="w-4 h-4 rounded border-gray-300 dark:border-gray-600 text-primary focus:ring-primary cursor-pointer"
                      checked={
                        (() => {
                          const totalItems = filteredData.files.length + filteredData.directories.length
                          if (totalItems === 0) return false
                          
                          // 规范化路径进行比较
                          const selectedPaths = new Set(
                            selectedFiles.map(f => (f.path || '').replace(/\\/g, '/'))
                          )
                          const allItemPaths = new Set(
                            [...filteredData.directories, ...filteredData.files].map(item =>
                              (item.path || '').replace(/\\/g, '/')
                            )
                          )
                          
                          // 检查所有项是否都被选中
                          return allItemPaths.size > 0 && allItemPaths.size === selectedPaths.size &&
                            Array.from(allItemPaths).every(path => selectedPaths.has(path))
                        })()
                      }
                      onChange={(e) => {
                        if (e.target.checked) {
                          // 全选当前可见的文件和目录
                          const allItems = [...filteredData.directories, ...filteredData.files]
                          handleFileSelect(allItems.map(item => item.path), true)
                        } else {
                          // 取消全选
                          handleFileSelect([], true)
                        }
                      }}
                      title={
                        (() => {
                          const totalItems = filteredData.files.length + filteredData.directories.length
                          if (totalItems === 0) return t('没有文件')
                          
                          const selectedPaths = new Set(
                            selectedFiles.map(f => (f.path || '').replace(/\\/g, '/'))
                          )
                          const allItemPaths = new Set(
                            [...filteredData.directories, ...filteredData.files].map(item =>
                              (item.path || '').replace(/\\/g, '/')
                            )
                          )
                          
                          const isAllSelected = allItemPaths.size > 0 && allItemPaths.size === selectedPaths.size &&
                            Array.from(allItemPaths).every(path => selectedPaths.has(path))
                          
                          return isAllSelected ? t('取消全选') : t('全选当前页面')
                        })()
                      }
                    />
                    <span className="text-sm text-foreground/70 dark:text-foreground/70 whitespace-nowrap">
                      {t('全选')}
                    </span>
                  </label>
                  <Button
                    variant={selectedFiles.length ? 'default' : 'secondary'}
                    size="sm"
                    className="gap-1"
                      onClick={async () => {
                        try {
                          const { selectedFiles } = useFileExplorerStore.getState()
                        
                          // 检查是否有选中文件
                          if (selectedFiles.length === 0) {
                            toast.warning(t('请先勾选要分析的文件。小技巧：你可以利用搜索过滤内容，再使用全选'))
                            return
                          }
                        
                          // 使用 Map 去重，避免同一个文件被添加多次
                          const uniqueFiles = new Map<string, any>();
                          selectedFiles.forEach((f: any) => {
                            if (f?.path && !uniqueFiles.has(f.path)) {
                              uniqueFiles.set(f.path, f);
                            }
                          });
                        
                          const filesToAdd = Array.from(uniqueFiles.values())
                            .map((f: any) => ({
                              path: f?.path,
                              name: f?.name,
                              size: f?.isDirectory ? 0 : f?.size || 0,
                              type: f?.isDirectory ? 'folder' : f?.extension || 'file',
                            }))
                            .filter(i => !!i.path)
                          
                          if (filesToAdd.length > 0) {
                            await addItems(filesToAdd)
                            await start()
                          }
                        } catch (error: any) {
                          // 提取实际错误消息，去掉 IPC 调用前缀
                          let errorMsg = error?.message || '未知错误'
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
                      }}
                  >
                    <MaterialIcon icon="auto_awesome" className="text-base" />
                    <span>{t('立即分析')}</span>
                  </Button>
                  <Button variant="secondary" size="sm" className="gap-1" onClick={openModal}>
                    {t('分析队列 ({length}/{snapshotLength})', {length: snapshot.items.filter(i => i.status !== 'completed').length, snapshotLength: snapshot.items.length})}
                  </Button>
                </div>
              </div>

              {/* File List - 只有这个区域可以滚动 */}
              <div className="flex-1 overflow-auto bg-muted dark:bg-muted">
                  <FileList
                    files={filteredData.files}
                    directories={filteredData.directories}
                    selectedFiles={selectedFiles}
                    activeItem={selectedItem}
                    onFileSelect={handleFileSelect}
                    onDirectoryChange={handleDirectoryChange}
                    viewMode={viewMode}
                    currentPath={currentPath}
                    isRealDirectory={true}
                    workspaceDirectoryPath={currentWorkspaceDirectory?.path}
                    refreshKey={refreshKey}
                  />
              </div>
            </div>

            {/* File Details Panel - 固定位置,右侧吸附 */}
            {showDetailsPanel && (
              <FileDetailsPanel
                item={selectedItem || undefined}
                workspaceDirectoryPath={currentWorkspaceDirectory?.path}
                onClose={() => setShowDetailsPanel(false)}
                onFileDeleted={refreshDirectoryContents}
                onFileUpdated={refreshDirectoryContents}
              />
            )}
          </main>
          </div>
        </div>
      ) : (
        <NoWorkspaceDirectoryMessage onAddWorkspaceDirectory={handleAddWorkspaceDirectory} />
      )}

      {/* 邀请提示弹窗 */}
      <InvitationModal
        isOpen={showInvitationModal}
        onClose={() => setShowInvitationModal(false)}
        invitationCount={invitationCount}
        isInvited={isInvited}
        quota={quota}
        machineId={machineId}
        onRedeem={async (code: string) => {
          try {
            const result = await window.electronAPI!.invitation.redeem(code)
            if (result.success) {
              await refreshInvitationCount()
              toast.success('兑换成功！')
              return { success: true }
            } else {
              toast.error(result.error || '兑换失败')
              return { success: false, error: result.error }
            }
          } catch (e: any) {
            toast.error('兑换失败：' + e.message)
            return { success: false, error: e.message }
          }
        }}
        onRefresh={async () => {
          const newCount = await refreshInvitationCount()
          if (newCount.count >= 3) {
            await window.electronAPI!.updateConfigValue('IS_PRIVATE_DIRECTORY_UNLOCKED', true)
            toast.success(t('恭喜！您已满足邀请条件，请重新点击创建私有目录'))
            setShowInvitationModal(false)
          } else {
            toast.info(t('当前邀请人数：{count}/3，还需要邀请 {need} 人', {
              count: newCount.count,
              need: 3 - newCount.count
            }))
          }
        }}
        isLoading={isInvitationLoading}
      />
    </div>
  )
}


