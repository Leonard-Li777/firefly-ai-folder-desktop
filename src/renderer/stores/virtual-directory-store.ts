import { create } from 'zustand'
import { FileItem, DirectoryItem, WorkspaceDirectory, DimensionGroup, DimensionTag, SelectedTag, SavedVirtualDirectory, AnalysisQueueItem } from '@yonuc/types'



interface VirtualDirectoryStore {
  // Current workspace directory
  currentWorkspaceDirectory: WorkspaceDirectory | null
  setCurrentWorkspaceDirectory: (directory: WorkspaceDirectory | null) => void
  workspaceDirectories: WorkspaceDirectory[]
  setWorkspaceDirectories: (directories: WorkspaceDirectory[]) => void

  // Dimension groups and tags
  dimensionGroups: DimensionGroup[]
  setDimensionGroups: (groups: DimensionGroup[]) => void

  // Selected tags for filtering
  selectedTags: SelectedTag[]
  addSelectedTag: (tag: SelectedTag) => void
  removeSelectedTag: (dimensionId: number) => void
  clearSelectedTags: () => void

  // Filtered files
  filteredFiles: (FileItem | DirectoryItem)[]
  setFilteredFiles: (files: (FileItem | DirectoryItem)[]) => void
  totalFilesCount: number
  setTotalFilesCount: (count: number) => void

  // View settings
  sortBy: 'name' | 'date' | 'size' | 'type' | 'smartName' | 'analysisStatus' | 'qualityScore' | 'author' | 'language'
  sortOrder: 'asc' | 'desc'
  viewMode: 'list' | 'grid'
  setSortBy: (sortBy: 'name' | 'date' | 'size' | 'type' | 'smartName' | 'analysisStatus' | 'qualityScore' | 'author' | 'language') => void
  setSortOrder: (order: 'asc' | 'desc') => void
  setViewMode: (mode: 'list' | 'grid') => void

  // Saved virtual directories
  savedDirectories: SavedVirtualDirectory[]
  setSavedDirectories: (directories: SavedVirtualDirectory[]) => void
  addSavedDirectory: (directory: SavedVirtualDirectory) => void
  removeSavedDirectory: (id: string) => void
  loadSavedDirectory: (directory: SavedVirtualDirectory) => void

  // Loading state
  isLoading: boolean
  setIsLoading: (loading: boolean) => void

  // Selected item for details panel
  selectedItem: FileItem | DirectoryItem | null
  setSelectedItem: (item: FileItem | DirectoryItem | null) => void
  selectedFiles: (FileItem | DirectoryItem)[]
  setSelectedFiles: (files: (FileItem | DirectoryItem)[]) => void
  showDetailsPanel: boolean
  setShowDetailsPanel: (show: boolean) => void

  // New files notification
  hasNewFiles: boolean
  newFilesCount: number
  newAnalyzedPaths: Set<string>
  setHasNewFiles: (hasNew: boolean, count?: number) => void
  incrementNewFilesCount: (items: AnalysisQueueItem[]) => void
}

export const useVirtualDirectoryStore = create<VirtualDirectoryStore>((set, get) => ({
  // Initial state
  currentWorkspaceDirectory: null,
  workspaceDirectories: [],
  dimensionGroups: [],
  selectedTags: [],
  filteredFiles: [],
  totalFilesCount: 0,
  sortBy: 'name',
  sortOrder: 'asc',
  viewMode: 'list',
  savedDirectories: [],
  isLoading: false,
  selectedItem: null,
  selectedFiles: [],
  showDetailsPanel: true,
  hasNewFiles: false,
  newFilesCount: 0,
  newAnalyzedPaths: new Set<string>(),

  // Current workspace directory
  setCurrentWorkspaceDirectory: (directory) => {
    set({
      currentWorkspaceDirectory: directory,
      selectedTags: [],
      filteredFiles: [],
      totalFilesCount: 0,
      hasNewFiles: false,
      newFilesCount: 0,
      newAnalyzedPaths: new Set<string>()
    })
  },

  setWorkspaceDirectories: (directories) => set({ workspaceDirectories: directories }),

  // Dimension groups
  setDimensionGroups: (groups) => set({ dimensionGroups: groups }),

  // Selected tags management
  addSelectedTag: (tag) => {
    const { selectedTags } = get()
    // Remove existing tag from same dimension (mutual exclusion within dimension)
    const filtered = selectedTags.filter((t) => t.dimensionId !== tag.dimensionId)
    set({ selectedTags: [...filtered, tag] })
  },

  removeSelectedTag: (dimensionId) => {
    const { selectedTags } = get()
    // Remove the tag and any child dimension tags
    const dimensionToRemove = selectedTags.find((t) => t.dimensionId === dimensionId)
    if (!dimensionToRemove) return

    // Find all child dimensions
    const { dimensionGroups } = get()
    const childDimensionIds = new Set<number>()
    
    const findChildDimensions = (parentId: number) => {
      dimensionGroups.forEach((group) => {
        if (group.parentDimensionIds?.includes(parentId)) {
          childDimensionIds.add(group.id)
          findChildDimensions(group.id)
        }
      })
    }
    
    findChildDimensions(dimensionId)

    // Remove parent and all children
    const filtered = selectedTags.filter(
      (t) => t.dimensionId !== dimensionId && !childDimensionIds.has(t.dimensionId)
    )
    set({ selectedTags: filtered })
  },

  clearSelectedTags: () => set({ selectedTags: [] }),

  // Filtered files
  setFilteredFiles: (files) => set({ filteredFiles: files }),
  setTotalFilesCount: (count) => set({ totalFilesCount: count }),

  // View settings
  setSortBy: (sortBy) => set({ sortBy }),
  setSortOrder: (order) => set({ sortOrder: order }),
  setViewMode: (mode) => set({ viewMode: mode }),

  // Saved directories
  setSavedDirectories: (directories) => set({ savedDirectories: directories }),
  
  addSavedDirectory: (directory) => {
    const { savedDirectories } = get()
    set({ savedDirectories: [...savedDirectories, directory] })
  },
  
  removeSavedDirectory: (id) => {
    const { savedDirectories } = get()
    set({ savedDirectories: savedDirectories.filter((d) => d.id !== id) })
  },
  
  loadSavedDirectory: (directory) => {
    set({
      selectedTags: directory.filter.selectedTags,
      sortBy: directory.filter.sortBy,
      sortOrder: directory.filter.sortOrder,
      viewMode: directory.filter.viewMode,
    })
  },

  // Loading state
  setIsLoading: (loading) => set({ isLoading: loading }),

  // Selected item
  setSelectedItem: (item) => set({ selectedItem: item }),
  setSelectedFiles: (files) => set({ selectedFiles: files }),
  setShowDetailsPanel: (show) => set({ showDetailsPanel: show }),

  // New files notification
  setHasNewFiles: (hasNew, count) => set({ 
    hasNewFiles: hasNew, 
    newFilesCount: hasNew ? (count !== undefined ? count : get().newFilesCount) : 0,
    newAnalyzedPaths: hasNew ? get().newAnalyzedPaths : new Set<string>()
  }),
  incrementNewFilesCount: (items) => {
    const { newAnalyzedPaths } = get()
    const newPaths = new Set(newAnalyzedPaths)
    let added = false
    
    items.forEach(item => {
      if (item.path && !newPaths.has(item.path)) {
        newPaths.add(item.path)
        added = true
      }
    })
    
    if (added) {
      set({ 
        hasNewFiles: true, 
        newAnalyzedPaths: newPaths,
        newFilesCount: newPaths.size 
      })
    }
  },
}))
