import type { MutableRefObject } from 'react'
import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { VirtualDirectory } from '@firefly/types'
import { useAnalyzedDirectoryStore } from '../../../../../stores/analyzed-directory-store'
import { useOrganizeStore } from '../../../../../stores/organize-store'

interface UseOrganizeEntryResetParams {
  organizeCapacityLimit: number
  setIsCapacityExceeded: (v: boolean) => void
  setCapacityExceededCount: (v: number) => void
  setShowCapacityLimitDialog: (v: boolean) => void
  setIncrementalVdId: (v: number | null) => void
  setIncrementalFiles: (v: any[]) => void
  setInitialDraftTree: (v: any[]) => void
  setCurrentVDir: (v: VirtualDirectory | null) => void
  loadFilesToOrganize: () => Promise<void>
  isSavedRef: MutableRefObject<boolean>
}

/**
 * 入场复位域：从已分析页面勾选带入时彻底清除 Keep-Alive 残留状态并复位整理流程。
 *
 * ⚠️ 该 effect 在原始单体 hook 中的定义顺序早于草稿恢复 effect，
 * 拆分后必须保持「容量域之后、候选域之前」的调用位置，以保证 effect 执行序不变。
 */
export function useOrganizeEntryReset({
  organizeCapacityLimit,
  setIsCapacityExceeded,
  setCapacityExceededCount,
  setShowCapacityLimitDialog,
  setIncrementalVdId,
  setIncrementalFiles,
  setInitialDraftTree,
  setCurrentVDir,
  loadFilesToOrganize,
  isSavedRef
}: UseOrganizeEntryResetParams) {
  const location = useLocation()
  const currentWorkspaceDirectory = useAnalyzedDirectoryStore(
    (s: any) => s.currentWorkspaceDirectory
  )
  const setStage = useOrganizeStore(s => s.setStage)
  const setFinalTree = useOrganizeStore(s => s.setFinalTree)
  const setDraftTree = useOrganizeStore(s => s.setDraftTree)

  // 挂载时自动恢复工作目录并拉取已分析文件；工作区变化时重新拉取
  const lastHandledStateKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (location.pathname !== '/organize') {
      setShowCapacityLimitDialog(false)
      lastHandledStateKeyRef.current = null
      return
    }
    loadFilesToOrganize()

    // 如果有勾选状态带入（从已分析页面跳转过来），彻底清除 Keep-Alive 旧状态并复位到选择整理模式
    const selectedFileIdsFromState = location.state?.selectedFileIds
    const hasSelectionState =
      (selectedFileIdsFromState &&
        Array.isArray(selectedFileIdsFromState) &&
        selectedFileIdsFromState.length > 0) ||
      ((location.state as any)?.selectedFilePaths?.length ?? 0) > 0

    const currentStateKey = hasSelectionState
      ? `${(selectedFileIdsFromState || []).join(',')}|${((location.state as any)?.selectedFilePaths || []).join(',')}`
      : null

    if (hasSelectionState && lastHandledStateKeyRef.current !== currentStateKey) {
      lastHandledStateKeyRef.current = currentStateKey
      console.log(
        '[Organize State] 从已分析页面带入勾选文件，重置 Keep-Alive 状态，文件数:',
        selectedFileIdsFromState?.length
      )
      // 彻底复位 organizeStore 全局状态（清除残留的 incremental-organize 模式，防止空增量列表截断待整理文件）
      useOrganizeStore.getState().resetOrganizeState()
      const requestedStage = location.state?.initialStage || 'root-mode-select'
      if (
        requestedStage === 'mode-select' &&
        selectedFileIdsFromState &&
        selectedFileIdsFromState.length > organizeCapacityLimit
      ) {
        setStage('root-mode-select')
        setIsCapacityExceeded(true)
        setCapacityExceededCount(selectedFileIdsFromState.length)
        setShowCapacityLimitDialog(true)
      } else {
        setStage(requestedStage)
      }
      setIncrementalVdId(null)
      setIncrementalFiles([])
      setCurrentVDir(null)
      setFinalTree([])
      setDraftTree([])
      setInitialDraftTree([])
      isSavedRef.current = false
      // 注意：不在此处调用 window.history.replaceState({}, '')，
      // 否则会抹掉 react-router 写入的 location.state，导致 selectedFileIdsFromState 丢失
      // （表现为进入整理页后待整理文件列表为空）
    }
  }, [
    currentWorkspaceDirectory?.id,
    currentWorkspaceDirectory?.path,
    location.pathname,
    location.state
  ])
}
