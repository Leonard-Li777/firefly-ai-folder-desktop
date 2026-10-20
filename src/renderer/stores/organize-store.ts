import { create } from 'zustand'
import { VirtualDirectoryNode, VirtualDirectory } from '@firefly/types'

export type Stage =
  | 'root-mode-select'
  | 'batch-rename'
  | 'batch-tag'
  | 'batch-duplicate'
  | 'mode-select'
  | 'smart-clustering'
  | 'candidates'
  | 'external-ai'
  | 'custom-tree'
  | 'structure'
  | 'organizing'
  | 'done'
export type OrganizeMode =
  | 'smart-clustering'
  | 'identity-blueprint'
  | 'fast-organize'
  | 'fine-organize'
  | 'custom-tree'
  | 'incremental-organize'
  | 'external-ai'
  | undefined

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

export type OrganizeBranch = 'organize' | 'batch-rename' | 'batch-tag' | 'batch-duplicate'

interface OrganizeStoreState {
  stage: Stage
  activeBranch: OrganizeBranch
  visitedStages: Stage[]
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

  // ─── 身份蓝图 Stage 4 Done 双滑块与重塑状态 ───────────────────────────
  rawMatches: Record<number | string, Array<{ path: string; score: number }>>
  filesMap: Record<number | string, any>
  userPinnedFileMap: Map<number | string, string[]>
  thresholdScore: number
  maxCandidatesPerFile: number

  setStage: (stage: Stage) => void
  setActiveBranch: (branch: OrganizeBranch) => void
  addVisitedStage: (stage: Stage) => void

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
  setRawMatches: (matches: Record<number | string, Array<{ path: string; score: number }>>) => void
  setFilesMap: (map: Record<number | string, any>) => void
  setUserPinnedFileMap: (
    mapOrUpdater:
      | Map<number | string, string[]>
      | ((prev: Map<number | string, string[]>) => Map<number | string, string[]>)
  ) => void
  setThresholdScore: (y: number) => void
  setMaxCandidatesPerFile: (n: number) => void
  resetOrganizeState: () => void
}

const initialOptions: OrganizeOptions = {
  allowCreateNew: false,
  skipEmptyDirs: false,
  deduplicateFiles: true,
  flattenToRoot: false
}

export const useOrganizeStore = create<OrganizeStoreState>(set => ({
  stage: 'root-mode-select',
  activeBranch: 'organize',
  visitedStages: ['root-mode-select'],
  organizeMode: undefined,
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

  rawMatches: {},
  filesMap: {},
  userPinnedFileMap: new Map(),
  thresholdScore: 0.4,
  maxCandidatesPerFile: 1,

  setStage: stage =>
    set(state => {
      let branch = state.activeBranch || 'organize'
      if (stage === 'batch-rename') {
        branch = 'batch-rename'
      } else if (stage === 'batch-tag') {
        branch = 'batch-tag'
      } else if (stage === 'batch-duplicate') {
        branch = 'batch-duplicate'
      } else if (
        stage === 'mode-select' ||
        stage === 'candidates' ||
        stage === 'custom-tree' ||
        stage === 'external-ai' ||
        stage === 'smart-clustering' ||
        stage === 'structure' ||
        stage === 'organizing' ||
        stage === 'done'
      ) {
        branch = 'organize'
      }

      const prevVisited = state.visitedStages || ['root-mode-select']
      const newVisited = prevVisited.includes(stage)
        ? prevVisited
        : [...prevVisited, stage]

      return {
        stage,
        activeBranch: branch,
        visitedStages: newVisited
      }
    }),

  setActiveBranch: activeBranch =>
    set(state => {
      const stage = activeBranch === 'organize' ? (state.stage === 'batch-duplicate' || state.stage === 'batch-rename' || state.stage === 'batch-tag' ? 'root-mode-select' : state.stage) : activeBranch
      const prevVisited = state.visitedStages || ['root-mode-select']
      const newVisited = prevVisited.includes(stage) ? prevVisited : [...prevVisited, stage]
      return {
        activeBranch,
        stage,
        visitedStages: newVisited
      }
    }),
  addVisitedStage: stage =>
    set(state => ({
      visitedStages: (state.visitedStages || []).includes(stage)
        ? state.visitedStages
        : [...(state.visitedStages || []), stage]
    })),

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

  setRawMatches: rawMatches => set({ rawMatches }),
  setFilesMap: filesMap => set({ filesMap }),
  setUserPinnedFileMap: mapOrUpdater =>
    set(state => ({
      userPinnedFileMap:
        typeof mapOrUpdater === 'function'
          ? mapOrUpdater(state.userPinnedFileMap)
          : mapOrUpdater
    })),
  setThresholdScore: thresholdScore => set({ thresholdScore }),
  setMaxCandidatesPerFile: maxCandidatesPerFile => set({ maxCandidatesPerFile }),

  resetOrganizeState: () =>
    set({
      stage: 'root-mode-select',
      activeBranch: 'organize',
      visitedStages: ['root-mode-select'],
      organizeMode: undefined,
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
      rawMatches: {},
      filesMap: {},
      userPinnedFileMap: new Map(),
      thresholdScore: 0.4,
      maxCandidatesPerFile: 1
    })
}))
