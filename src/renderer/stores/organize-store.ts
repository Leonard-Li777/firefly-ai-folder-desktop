import { create } from 'zustand'
import { VirtualDirectoryNode, VirtualDirectory } from '@firefly/types'

export type Stage = 'mode-select' | 'candidates' | 'structure' | 'organizing' | 'done'
export type OrganizeMode = 'fast-organize' | 'fine-organize' | 'incremental-organize' | undefined

export interface OrganizeOptions {
  allowCreateNew: boolean
  skipEmptyDirs: boolean
  deduplicateFiles: boolean
  flattenToRoot: boolean
  flattenDirectories?: boolean
}

export interface ProgressInfo {
  current: number
  total: number
  message: string
}

interface OrganizeStoreState {
  stage: Stage
  organizeMode: OrganizeMode
  selectedVDirId: number | null
  currentVDir: VirtualDirectory | null

  draftTree: VirtualDirectoryNode[]
  draft: {
    name: string
    strategy: string
    source: any
    perspective?: string
    rationale?: string
    description?: string
  } | null

  progressInfo: ProgressInfo
  isPaused: boolean
  finalTree: VirtualDirectoryNode[]

  unmatchedCount: number
  hasRescueFailed: boolean
  options: OrganizeOptions

  setStage: (stage: Stage) => void

  setOrganizeMode: (mode: OrganizeMode) => void
  setSelectedVDirId: (id: number | null) => void
  setCurrentVDir: (vdir: VirtualDirectory | null) => void
  setDraftTree: (
    tree: VirtualDirectoryNode[] | ((prev: VirtualDirectoryNode[]) => VirtualDirectoryNode[])
  ) => void
  setDraft: (
    draft: {
      name: string
      strategy: string
      source: any
      perspective?: string
      rationale?: string
      description?: string
    } | null
  ) => void
  setProgressInfo: (info: ProgressInfo) => void
  setIsPaused: (paused: boolean) => void
  setFinalTree: (
    tree: VirtualDirectoryNode[] | ((prev: VirtualDirectoryNode[]) => VirtualDirectoryNode[])
  ) => void
  setUnmatchedCount: (count: number) => void
  setHasRescueFailed: (failed: boolean) => void
  setOptions: (options: OrganizeOptions | ((prev: OrganizeOptions) => OrganizeOptions)) => void
  resetOrganizeState: () => void
}

const initialOptions: OrganizeOptions = {
  allowCreateNew: false,
  skipEmptyDirs: false,
  deduplicateFiles: true,
  flattenToRoot: false
}

export const useOrganizeStore = create<OrganizeStoreState>(set => ({
  stage: 'mode-select',
  organizeMode: 'fast-organize',
  selectedVDirId: null,
  currentVDir: null,

  draftTree: [],
  draft: null,

  progressInfo: { current: 0, total: 0, message: '' },
  isPaused: false,
  finalTree: [],

  unmatchedCount: 0,
  hasRescueFailed: false,
  options: initialOptions,

  setStage: stage => set({ stage }),
  setOrganizeMode: organizeMode => set({ organizeMode }),
  setSelectedVDirId: selectedVDirId => set({ selectedVDirId }),
  setCurrentVDir: currentVDir => set({ currentVDir }),

  setDraftTree: tree =>
    set(state => ({
      draftTree: typeof tree === 'function' ? tree(state.draftTree) : tree
    })),
  setDraft: draft => set({ draft }),

  setProgressInfo: progressInfo => set({ progressInfo }),
  setIsPaused: isPaused => set({ isPaused }),

  setFinalTree: tree =>
    set(state => ({
      finalTree: typeof tree === 'function' ? tree(state.finalTree) : tree
    })),

  setUnmatchedCount: unmatchedCount => set({ unmatchedCount }),
  setHasRescueFailed: hasRescueFailed => set({ hasRescueFailed }),

  setOptions: options =>
    set(state => ({
      options: typeof options === 'function' ? options(state.options) : options
    })),

  resetOrganizeState: () =>
    set({
      stage: 'mode-select',
      organizeMode: 'fast-organize',
      selectedVDirId: null,
      currentVDir: null,
      draftTree: [],
      draft: null,
      progressInfo: { current: 0, total: 0, message: '' },
      isPaused: false,
      finalTree: [],
      unmatchedCount: 0,
      hasRescueFailed: false,
      options: initialOptions // initialOptions 中 skipEmptyDirs 已是 false
    })
}))
