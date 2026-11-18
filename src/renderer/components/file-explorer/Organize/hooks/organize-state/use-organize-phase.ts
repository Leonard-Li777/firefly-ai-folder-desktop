import type { MutableRefObject } from 'react'
import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { VirtualDirectory } from '@firefly/types'
import { LogCategory, logger } from '@firefly/shared'
import { useOrganizeStore } from '../../../../../stores/organize-store'
import { OrganizeMode } from '../../types'

interface UseOrganizePhaseParams {
  candidates: any[]
  selectedCandidate: any
  isCapacityExceeded: boolean
  currentVDir: VirtualDirectory | null
  setCurrentVDir: (v: VirtualDirectory | null) => void
  draft: any
  isSavedRef: MutableRefObject<boolean>
  setActiveGuidancePrompt: (v: string) => void
  setShowBackConfirm: (v: boolean) => void
  setCandidates: (v: any[]) => void
  setSelectedCandidate: (v: any) => void
  setDraft: (v: any) => void
  setDraftTree: (v: any[]) => void
  setFinalTree: (v: any[]) => void
  setIncrementalVdId: (v: number | null) => void
  setIncrementalFiles: (v: any[]) => void
  setInitialDraftTree: (v: any[]) => void
}

/**
 * 阶段导航域：模式选择、前进/后退、整理中返回确认、外部 AI 规划入口。
 */
export function useOrganizePhase({
  candidates,
  selectedCandidate,
  isCapacityExceeded,
  currentVDir,
  setCurrentVDir,
  draft,
  isSavedRef,
  setActiveGuidancePrompt,
  setShowBackConfirm,
  setCandidates,
  setSelectedCandidate,
  setDraft,
  setDraftTree,
  setFinalTree,
  setIncrementalVdId,
  setIncrementalFiles,
  setInitialDraftTree
}: UseOrganizePhaseParams) {
  const [searchParams] = useSearchParams()
  const vdIdParam = searchParams.get('vdId')

  const stage = useOrganizeStore(s => s.stage)
  const setStage = useOrganizeStore(s => s.setStage)
  const organizeMode = useOrganizeStore(s => s.organizeMode)
  const setOrganizeMode = useOrganizeStore(s => s.setOrganizeMode)
  const draftTree = useOrganizeStore(s => s.draftTree)
  const finalTree = useOrganizeStore(s => s.finalTree)

  // ─── 选择模式后进入候选方案 ────────────────────────────────────────────────
  const handleModeSelect = useCallback(
    (mode: OrganizeMode) => {
      setOrganizeMode(mode)
      setActiveGuidancePrompt('') // 切换模式时清空指导提示词
      if (mode === 'incremental-organize') {
        return
      }
      // 点击快速/精细整理开启全新任务时，彻底重置旧任务残留的草稿与树状态
      setCurrentVDir(null)
      setDraft(null)
      setIncrementalVdId(null)
      setIncrementalFiles([])
      setDraftTree([])
      setInitialDraftTree([])
      setFinalTree([])
      setCandidates([]) // 清空候选方案，触发重新生成
      setSelectedCandidate(null)
      isSavedRef.current = false
      if (mode === 'smart-clustering') {
        setStage('smart-clustering')
      } else if (mode === 'external-ai') {
        setStage('external-ai')
      } else if (mode === 'custom-tree') {
        setStage('custom-tree')
      } else if (mode === 'workflow-preset') {
        // 工作流预置目录树模式由 Organize/index.tsx 的 handleSelectWorkflowPreset 专门处理填入并直达 structure
        return
      } else {
        setStage('candidates')
      }
    },
    [setCurrentVDir, setDraft, setDraftTree, setFinalTree, setIncrementalFiles, setIncrementalVdId, setInitialDraftTree, setOrganizeMode, setSelectedCandidate, setStage]
  )

  // ─── 切换至外部 AI 规划模式 ──────────────────────────────────────────────
  const handleSwitchToExternalAi = useCallback(() => {
    setOrganizeMode('external-ai')
    setStage('external-ai')
  }, [setOrganizeMode, setStage])

  const canGoBack = useMemo(() => {
    if (stage === 'mode-select') return false

    const actionParam = searchParams.get('action')
    const modeParam = searchParams.get('mode')
    const isDirectDone = Boolean(
      stage === 'done' &&
      ((vdIdParam && actionParam !== 'regenerate' && modeParam !== 'incremental-organize') ||
        (currentVDir &&
          currentVDir.source !== 'draft' &&
          organizeMode !== 'fine-organize'))
    )

    const result = !isDirectDone && stage !== 'root-mode-select'

    return result
  }, [stage, vdIdParam, searchParams, currentVDir, organizeMode])

  // ─── 返回处理 ─────────────────────────────────────────────────────────────
  const handleBack = useCallback(() => {
    if (!canGoBack) return
    if (stage === 'organizing') {
      setShowBackConfirm(true)
      return
    }
    if (
      stage === 'batch-rename' ||
      stage === 'batch-tag' ||
      stage === 'batch-duplicate' ||
      stage === 'mode-select'
    ) {
      setStage('root-mode-select')
      return
    }
    if (stage === 'candidates') {
      setStage('mode-select')
      return
    }
    if (stage === 'external-ai') {
      setStage('mode-select')
      return
    }
    if (stage === 'custom-tree') {
      if (draft?.source === 'external-ai' || organizeMode === 'external-ai') {
        setStage('external-ai')
      } else {
        setStage('mode-select')
      }
      return
    }

    const isVDirOrDraft = Boolean(currentVDir?.id || organizeMode === 'incremental-organize')

    if (stage === 'structure') {
      if (
        organizeMode === 'workflow-preset' ||
        draft?.source === 'workflow-preset'
      ) {
        setStage('mode-select')
        return
      }
      if (organizeMode === 'custom-tree' || draft?.source === 'custom-tree' || draft?.source === 'user-defined') {
        setStage('custom-tree')
        return
      }
      if (draft?.source === 'external-ai') {
        setStage('custom-tree')
        return
      }
      if (isVDirOrDraft) {
        setIncrementalVdId(null)
        setIncrementalFiles([])
        setStage('mode-select')
      } else {
        setStage('candidates')
      }
      return
    }

    if (stage === 'done') {
      if (isVDirOrDraft) {
        setIncrementalVdId(null)
        setIncrementalFiles([])
        setStage('mode-select')
      } else {
        setStage('structure')
      }
      return
    }
  }, [canGoBack, stage, organizeMode, searchParams, vdIdParam, currentVDir, draft])

  const canForward = useMemo(() => {
    if (isCapacityExceeded) return false
    if (stage === 'mode-select') {
      if (organizeMode === 'fine-organize') {
        return candidates.length > 0
      } else {
        return draftTree.length > 0
      }
    }
    if (stage === 'candidates') {
      return draftTree.length > 0 && !!selectedCandidate
    }
    if (stage === 'structure') {
      return finalTree.length > 0
    }
    return false
  }, [stage, organizeMode, candidates, draftTree, selectedCandidate, finalTree])

  const handleForward = useCallback(() => {
    if (!canForward) return
    if (stage === 'mode-select') {
      if (organizeMode === 'fine-organize') {
        setStage('candidates')
      } else {
        setStage('structure')
      }
      return
    }
    if (stage === 'candidates') {
      setStage('structure')
      return
    }
    if (stage === 'structure') {
      setStage('done')
      return
    }
  }, [stage, canForward, organizeMode])

  const handleBackConfirm = useCallback(async () => {
    setShowBackConfirm(false)
    if (currentVDir?.id) {
      try {
        await window.electronAPI!.virtualDirectory.endReorganize(currentVDir.id)
      } catch (_) {
        /* ignore error */
      }
    }
    setStage('structure')
  }, [currentVDir?.id])

  return {
    handleModeSelect,
    handleSwitchToExternalAi,
    canGoBack,
    handleBack,
    canForward,
    handleForward,
    handleBackConfirm
  }
}
