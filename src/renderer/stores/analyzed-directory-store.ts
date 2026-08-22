import { create } from 'zustand'
import {
  FileItem,
  DirectoryItem,
  WorkspaceDirectory,
  DimensionGroup,
  DimensionTag,
  SelectedTag,
  SavedAnalyzedDirectory,
  AnalysisQueueItem
} from '@firefly/types'

interface AnalyzedDirectoryStore {
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
  setSelectedTags: (tags: SelectedTag[]) => void
  addSelectedTag: (tag: SelectedTag) => void
  removeSelectedTag: (dimensionId: number, tagValue?: string, parentTagValue?: string) => void
  clearSelectedTags: () => void

  // Filtered files
  filteredFiles: (FileItem | DirectoryItem)[]
  setFilteredFiles: (
    files:
      | (FileItem | DirectoryItem)[]
      | ((prev: (FileItem | DirectoryItem)[]) => (FileItem | DirectoryItem)[])
  ) => void
  totalFilesCount: number
  setTotalFilesCount: (count: number) => void

  // View settings
  sortBy:
    | 'name'
    | 'date'
    | 'size'
    | 'type'
    | 'smartName'
    | 'analysisStatus'
    | 'qualityScore'
    | 'author'
    | 'language'
  sortOrder: 'asc' | 'desc'
  viewMode: 'list' | 'grid' | 'waterfall'
  setSortBy: (
    sortBy:
      | 'name'
      | 'date'
      | 'size'
      | 'type'
      | 'smartName'
      | 'analysisStatus'
      | 'qualityScore'
      | 'author'
      | 'language'
  ) => void
  setSortOrder: (order: 'asc' | 'desc') => void
  setViewMode: (mode: 'list' | 'grid' | 'waterfall') => void

  // Saved virtual directories
  savedDirectories: SavedAnalyzedDirectory[]
  setSavedDirectories: (directories: SavedAnalyzedDirectory[]) => void
  addSavedDirectory: (directory: SavedAnalyzedDirectory) => void
  removeSavedDirectory: (id: string) => void
  loadSavedDirectory: (directory: SavedAnalyzedDirectory) => void

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

export const useAnalyzedDirectoryStore = create<AnalyzedDirectoryStore>((set, get) => ({
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
  setCurrentWorkspaceDirectory: directory => {
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

  setWorkspaceDirectories: directories => set({ workspaceDirectories: directories }),

  // Dimension groups
  setDimensionGroups: groups => set({ dimensionGroups: groups }),

  // Selected tags management
  setSelectedTags: tags => set({ selectedTags: tags }),
  addSelectedTag: tag => {
    const { selectedTags } = get()
    // Check if tag already exists (same dimensionId, tagValue and parentTagValue)
    const exists = selectedTags.some(
      t =>
        t.dimensionId === tag.dimensionId &&
        t.tagValue === tag.tagValue &&
        t.parentTagValue === tag.parentTagValue
    )
    if (!exists) {
      set({ selectedTags: [...selectedTags, tag] })
    }
  },

  removeSelectedTag: (dimensionId: number, tagValue?: string, parentTagValue?: string) => {
    const { selectedTags } = get()
    if (tagValue) {
      // Remove specific tag from dimension (match on parentTagValue too)
      const filtered = selectedTags.filter(
        t =>
          !(
            t.dimensionId === dimensionId &&
            t.tagValue === tagValue &&
            t.parentTagValue === parentTagValue
          )
      )
      set({ selectedTags: filtered })
    } else {
      // Remove all tags from dimension (legacy behavior for backward compatibility)
      const filtered = selectedTags.filter(t => t.dimensionId !== dimensionId)
      set({ selectedTags: filtered })
    }
  },

  clearSelectedTags: () => set({ selectedTags: [] }),

  // Filtered files
  setFilteredFiles: filesOrFn => {
    if (typeof filesOrFn === 'function') {
      set(state => ({ filteredFiles: filesOrFn(state.filteredFiles) }))
    } else {
      set({ filteredFiles: filesOrFn })
    }
  },
  setTotalFilesCount: count => set({ totalFilesCount: count }),

  // View settings
  setSortBy: sortBy => set({ sortBy }),
  setSortOrder: order => set({ sortOrder: order }),
  setViewMode: mode => set({ viewMode: mode }),

  // Saved directories
  setSavedDirectories: directories => set({ savedDirectories: directories }),

  addSavedDirectory: directory => {
    const { savedDirectories } = get()
    set({ savedDirectories: [...savedDirectories, directory] })
  },

  removeSavedDirectory: id => {
    const { savedDirectories } = get()
    set({ savedDirectories: savedDirectories.filter(d => d.id !== id) })
  },

  loadSavedDirectory: directory => {
    set({
      selectedTags: directory.filter.selectedTags,
      sortBy: directory.filter.sortBy,
      sortOrder: directory.filter.sortOrder,
      viewMode: directory.filter.viewMode
    })
  },

  // Loading state
  setIsLoading: loading => set({ isLoading: loading }),

  // Selected item
  setSelectedItem: item => set({ selectedItem: item }),
  setSelectedFiles: files => set({ selectedFiles: files }),
  setShowDetailsPanel: show => set({ showDetailsPanel: show }),

  // New files notification
  setHasNewFiles: (hasNew, count) =>
    set({
      hasNewFiles: hasNew,
      newFilesCount: hasNew ? (count !== undefined ? count : get().newFilesCount) : 0,
      newAnalyzedPaths: hasNew ? get().newAnalyzedPaths : new Set<string>()
    }),
  incrementNewFilesCount: items => {
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
  }
}))
