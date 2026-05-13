import { create } from 'zustand'
import { FileItem, DirectoryItem } from '@yonuc/types/types'

/**
 * 应用状态接口
 */
interface AppState {
  count: number
  increment: () => void
  decrement: () => void
  reset: () => void
}

/**
 * 应用状态管理store
 */
export const useAppStore = create<AppState>(set => ({
  count: 0,
  increment: () => set(state => ({ count: state.count + 1 })),
  decrement: () => set(state => ({ count: state.count - 1 })),
  reset: () => set({ count: 0 }),
}))

/**
 * 文件浏览器状态接口
 */
interface FileExplorerState {
  files: FileItem[]
  directories: DirectoryItem[]
  selectedFiles: FileItem[]
  expandedDirectories: Set<string>
  currentPath: string
  loading: boolean
  error: string | null
  sortBy: 'name' | 'size' | 'modified' | 'type' | 'smartName' | 'analysisStatus'
  sortOrder: 'asc' | 'desc'
  
  // 文件操作
  setFiles: (files: FileItem[]) => void
  setDirectories: (directories: DirectoryItem[]) => void
  setSelectedFiles: (files: FileItem[]) => void
  toggleFileSelection: (file: FileItem) => void
  clearSelection: () => void
  
  // 目录操作
  toggleDirectory: (path: string) => void
  expandDirectory: (path: string) => void
  collapseDirectory: (path: string) => void
  setCurrentPath: (path: string) => void
  
  // 排序操作
  setSortBy: (sortBy: 'name' | 'size' | 'modified' | 'type' | 'smartName' | 'analysisStatus') => void
  toggleSortOrder: () => void
  
  // 加载状态
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  
  // 数据操作
  addFile: (file: FileItem) => void
  removeFile: (path: string) => void
  updateFile: (path: string, updates: Partial<FileItem>) => void
  addDirectory: (directory: DirectoryItem) => void
  removeDirectory: (path: string) => void
  refreshDirectory: (path: string) => void
}

/**
 * 文件浏览器状态管理store
 */
export const useFileExplorerStore = create<FileExplorerState>((set, get) => ({
  files: [],
  directories: [],
  selectedFiles: [],
  expandedDirectories: new Set(['/']),
  currentPath: '',
  loading: false,
  error: null,
  sortBy: 'name',
  sortOrder: 'asc',
  
  setFiles: (files) => set({ files }),
  setDirectories: (directories) => set({ directories }),
  setSelectedFiles: (selectedFiles) => set({ selectedFiles }),
  
  toggleFileSelection: (file) => set((state) => {
    const isSelected = state.selectedFiles.some(f => f.path === file.path)
    return {
      selectedFiles: isSelected 
        ? state.selectedFiles.filter(f => f.path !== file.path)
        : [...state.selectedFiles, file]
    }
  }),
  
  clearSelection: () => set({ selectedFiles: [] }),
  
  toggleDirectory: (path) => set((state) => {
    const newExpanded = new Set(state.expandedDirectories)
    if (newExpanded.has(path)) {
      newExpanded.delete(path)
    } else {
      newExpanded.add(path)
    }
    return { expandedDirectories: newExpanded }
  }),
  
  expandDirectory: (path) => set((state) => {
    const newExpanded = new Set(state.expandedDirectories)
    newExpanded.add(path)
    return { expandedDirectories: newExpanded }
  }),
  
  collapseDirectory: (path) => set((state) => {
    const newExpanded = new Set(state.expandedDirectories)
    newExpanded.delete(path)
    return { expandedDirectories: newExpanded }
  }),
  
  setCurrentPath: (currentPath) => set({ currentPath }),
  
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  
  addFile: (file) => set((state) => ({
    files: [...state.files, file]
  })),
  
  removeFile: (path) => set((state) => ({
    files: state.files.filter(f => f.path !== path),
    selectedFiles: state.selectedFiles.filter(f => f.path !== path)
  })),
  
  updateFile: (path, updates) => set((state) => ({
    files: state.files.map(f => 
      f.path === path ? { ...f, ...updates } : f
    )
  })),
  
  addDirectory: (directory) => set((state) => ({
    directories: [...state.directories, directory]
  })),
  
  removeDirectory: (path) => set((state) => {
    const newDirectories = state.directories.filter(d => d.path !== path)
    const newExpanded = new Set(state.expandedDirectories)
    newExpanded.delete(path)
    
    return {
      directories: newDirectories,
      expandedDirectories: newExpanded
    }
  }),
  
  setSortBy: (sortBy) => set({ sortBy, sortOrder: 'asc' }),
  toggleSortOrder: () => set((state) => ({
    sortOrder: state.sortOrder === 'asc' ? 'desc' : 'asc'
  })),

  refreshDirectory: (path) => {
    const state = get()
    state.setLoading(true)
    state.setError(null)
    
    // 这里应该调用实际的文件系统API
    // 暂时使用模拟数据
    setTimeout(() => {
      state.setLoading(false)
    }, 500)
  }
}))

/**
 * 文件管理状态接口
 */
interface FileManagementState {
  files: File[]
  selectedFiles: string[]
  isLoading: boolean
  addFiles: (files: File[]) => void
  removeFile: (fileName: string) => void
  toggleSelectFile: (fileName: string) => void
  clearSelection: () => void
}

/**
 * 文件管理状态store
 */
export const useFileStore = create<FileManagementState>(set => ({
  files: [],
  selectedFiles: [],
  isLoading: false,
  addFiles: files =>
    set(state => ({
      files: [...state.files, ...files],
    })),
  removeFile: fileName =>
    set(state => ({
      files: state.files.filter(file => file.name !== fileName),
    })),
  toggleSelectFile: fileName =>
    set(state => ({
      selectedFiles: state.selectedFiles.includes(fileName)
        ? state.selectedFiles.filter(name => name !== fileName)
        : [...state.selectedFiles, fileName],
    })),
  clearSelection: () => set({ selectedFiles: [] }),
}))

/**
 * AI模型状态接口
 */
interface AIModelState {
  isModelLoaded: boolean
  modelStatus: 'idle' | 'loading' | 'loaded' | 'error'
  loadModel: () => Promise<void>
  unloadModel: () => void
  setModelStatus: (status: 'idle' | 'loading' | 'loaded' | 'error', isLoaded?: boolean) => void
}

/**
 * AI模型状态store
 */
export const useAIModelStore = create<AIModelState>(set => ({
  isModelLoaded: false,
  modelStatus: 'idle',
  loadModel: async () => {
    set({ modelStatus: 'loading' })
    try {
      // 使用 llama-server 加载模型
      await new Promise(resolve => setTimeout(resolve, 1000)) // 模拟加载
      set({ isModelLoaded: true, modelStatus: 'loaded' })
    } catch (error) {
      set({ modelStatus: 'error' })
    }
  },
  unloadModel: () =>
    set({
      isModelLoaded: false,
      modelStatus: 'idle',
    }),
  setModelStatus: (status, isLoaded) =>
    set({
      modelStatus: status,
      isModelLoaded: isLoaded !== undefined ? isLoaded : status === 'loaded',
    }),
}))
