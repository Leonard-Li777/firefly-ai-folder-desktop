/**
 * 工作区策略「覆盖项补丁通道」Hook（检索式引擎 / 文件内容萃取两个 Tab 共用）
 *
 * 职责：维护乐观 overrides、500ms 防抖补丁累积、在途请求登记与已确认图层，
 * 保证「异步刷新带回的旧 workspace_config 快照」永远不会把用户刚刚拖动/修改的值覆盖回旧值（闪回根因）。
 *
 * 图层模型（按 seq 升序叠加）：最新快照 overrides → 已确认但快照尚未观测到的补丁(acked) → 在途补丁(inFlight) → 待发补丁(pending)。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BaseAIConfig,
  TechnicalEngineParameters,
  WorkspaceDirectory,
  parseWorkspaceConfig
} from '@firefly/types'
import {
  submitWorkspacePolicyMutation,
  getMutationErrorText
} from '../../../lib/workspace-policy/workspace-ai-client'
import { toast } from '../../common/Toast'
import { t } from '@app/languages'

/** 已确认补丁在快照尚未观测到时的最长保留时间（毫秒），避免服务端改写值后永久粘滞 */
const ACKED_LAYER_TTL_MS = 10_000

/** 待提交的补丁累积（带所属工作区戳，切换工作区时旧补丁仍以旧 id 落盘） */
export interface PendingPolicyPatch {
  patch: Partial<TechnicalEngineParameters>
  restore: Set<keyof TechnicalEngineParameters>
  workspaceId: number
}

/** 将补丁叠加到 overrides：先删除 restore 键，再写入 patch 键 */
export function applyPendingPatchToOverrides(
  base: Partial<TechnicalEngineParameters>,
  pending: Pick<PendingPolicyPatch, 'patch' | 'restore'>
): Partial<TechnicalEngineParameters> {
  const next = { ...base }
  for (const key of pending.restore) {
    delete next[key]
  }
  return { ...next, ...pending.patch }
}

function readSnapshotOverrides(
  workspaceConfig: WorkspaceDirectory['workspace_config']
): Partial<TechnicalEngineParameters> {
  const fresh = parseWorkspaceConfig(workspaceConfig)
  return fresh.status === 'ready' && fresh.overrides ? { ...fresh.overrides } : {}
}

/** 快照是否已观测到该补丁的效果（patch 键值全等且 restore 键已不存在） */
function isPatchObserved(
  snapshot: Partial<TechnicalEngineParameters>,
  pending: PendingPolicyPatch
): boolean {
  const patchOk = (
    Object.entries(pending.patch) as Array<[keyof TechnicalEngineParameters, unknown]>
  ).every(([key, val]) => snapshot[key] === val)
  const restoreOk = Array.from(pending.restore).every(key => snapshot[key] === undefined)
  return patchOk && restoreOk
}

export interface UseWorkspacePolicyPatchChannelOptions {
  workspaceId: number | null | undefined
  workspaceConfig: WorkspaceDirectory['workspace_config']
  baseDerived: BaseAIConfig
  isActive: boolean
  onConfigSaved?: () => void
  /** 日志前缀（组件名） */
  logTag: string
}

export function useWorkspacePolicyPatchChannel({
  workspaceId,
  workspaceConfig,
  baseDerived,
  isActive,
  onConfigSaved,
  logTag
}: UseWorkspacePolicyPatchChannelOptions) {
  const [overrides, setOverrides] = useState<Partial<TechnicalEngineParameters>>(() =>
    readSnapshotOverrides(workspaceConfig)
  )
  const [isSaving, setIsSaving] = useState(false)

  const workspaceIdRef = useRef(workspaceId)
  workspaceIdRef.current = workspaceId
  const workspaceConfigRef = useRef(workspaceConfig)
  workspaceConfigRef.current = workspaceConfig
  const baseDerivedRef = useRef(baseDerived)
  baseDerivedRef.current = baseDerived
  const onConfigSavedRef = useRef(onConfigSaved)
  onConfigSavedRef.current = onConfigSaved
  const overridesRef = useRef(overrides)
  overridesRef.current = overrides

  const prevWorkspaceIdRef = useRef(workspaceId)
  const pendingPatchRef = useRef<PendingPolicyPatch | null>(null)
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null)
  const seqRef = useRef(0)
  const inFlightRef = useRef<Map<number, { seq: number; pending: PendingPolicyPatch }>>(new Map())
  const ackedRef = useRef<Array<{ seq: number; pending: PendingPolicyPatch; ackedAt: number }>>([])

  /** 以最新快照为底，按 seq 升序叠加 acked / inFlight 层，最后叠加待发补丁 */
  const recomputeOverrides = useCallback((): Partial<TechnicalEngineParameters> => {
    const currentId = workspaceIdRef.current
    const layers = [
      ...ackedRef.current.map(l => ({ seq: l.seq, pending: l.pending })),
      ...Array.from(inFlightRef.current.values())
    ]
      .filter(l => l.pending.workspaceId === currentId)
      .sort((a, b) => a.seq - b.seq)
    let next = readSnapshotOverrides(workspaceConfigRef.current)
    for (const layer of layers) {
      next = applyPendingPatchToOverrides(next, layer.pending)
    }
    const pending = pendingPatchRef.current
    if (pending !== null && pending.workspaceId === currentId) {
      next = applyPendingPatchToOverrides(next, pending)
    }
    return next
  }, [])

  /** 通过统一补丁通道提交（严禁整份拼装 WorkspaceConfigReady 直写） */
  const persistMutation = useCallback(
    async (pending: PendingPolicyPatch, failText?: string) => {
      if (!pending.workspaceId) return
      const restoreKeys = Array.from(pending.restore)
      const hasPatch = Object.keys(pending.patch).length > 0
      if (!hasPatch && restoreKeys.length === 0) return
      const seq = ++seqRef.current
      inFlightRef.current.set(seq, { seq, pending })
      const isCurrent = () => pending.workspaceId === workspaceIdRef.current
      if (isCurrent()) setIsSaving(true)
      let succeeded = false
      try {
        const res = await submitWorkspacePolicyMutation(pending.workspaceId, {
          ...(hasPatch ? { overridePatch: pending.patch } : {}),
          ...(restoreKeys.length > 0 ? { restoreOverrideFields: restoreKeys } : {})
        })
        if (res.success) {
          succeeded = true
        } else {
          toast.error(getMutationErrorText(res, failText ?? t('保存失败')))
        }
      } catch (err: unknown) {
        console.error(`[${logTag}] 提交配置补丁异常:`, err)
        toast.error(failText ?? t('保存失败'))
      }
      inFlightRef.current.delete(seq)
      if (succeeded && isCurrent()) {
        // 已确认但快照可能尚未推进：保留图层，防止慢速旧刷新把滑块拉回旧值
        ackedRef.current.push({ seq, pending, ackedAt: Date.now() })
      }
      if (succeeded) {
        onConfigSavedRef.current?.()
      }
      if (isCurrent()) {
        setIsSaving(inFlightRef.current.size > 0)
        // 失败：以快照 + 剩余图层重算，回滚乐观值（严禁永久显示未落盘的假成功值）
        if (!succeeded) setOverrides(recomputeOverrides())
      }
    },
    [logTag, recomputeOverrides]
  )

  const flushPending = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
    const pending = pendingPatchRef.current
    if (pending !== null) {
      pendingPatchRef.current = null
      void persistMutation(pending)
    }
  }, [persistMutation])

  // 外部快照同步：切换工作区才清空全部状态；同一工作区刷新时保留乐观图层，旧快照不得覆盖在途修改
  useEffect(() => {
    const switched = prevWorkspaceIdRef.current !== workspaceId
    prevWorkspaceIdRef.current = workspaceId
    if (switched) {
      // 旧工作区的待发补丁带旧 id 先行落盘，再整体复位
      flushPending()
      inFlightRef.current.clear()
      ackedRef.current = []
      setIsSaving(false)
    } else {
      const snapshot = readSnapshotOverrides(workspaceConfig)
      const now = Date.now()
      ackedRef.current = ackedRef.current.filter(
        l => !isPatchObserved(snapshot, l.pending) && now - l.ackedAt <= ACKED_LAYER_TTL_MS
      )
    }
    setOverrides(recomputeOverrides())
  }, [workspaceId, workspaceConfig, flushPending, recomputeOverrides])

  // 切 Tab (isActive 变为 false) 或卸载时立即 flush 未落盘数据，杜绝并发覆盖竞态
  useEffect(() => {
    if (!isActive) flushPending()
  }, [isActive, flushPending])

  useEffect(() => {
    return () => flushPending()
  }, [flushPending])

  const effectiveParams: BaseAIConfig = useMemo(
    () => ({ ...baseDerived, ...overrides }),
    [baseDerived, overrides]
  )

  const takePending = useCallback((): PendingPolicyPatch => {
    const wid = workspaceIdRef.current ?? 0
    const existing = pendingPatchRef.current
    if (existing !== null && existing.workspaceId === wid) return existing
    return { patch: {}, restore: new Set(), workspaceId: wid }
  }, [])

  // 修改单个参数：等值回退——设值与当前基线（工作流默认/系统默认）一致时精确 delete 覆盖键算回默认态，
  // 仅值 ≠ 基线的显式覆盖写入补丁保留 user_custom，500ms 防抖提交
  const handleParamChange = useCallback(
    <K extends keyof TechnicalEngineParameters>(key: K, val: TechnicalEngineParameters[K]) => {
      const baselineVal = (baseDerivedRef.current as Partial<TechnicalEngineParameters>)[key]
      if (val === baselineVal) {
        // 等值回退：本地覆盖字典同步删除该键，effectiveParams 自动回落基线（值相同）
        setOverrides(prev => {
          if (prev[key] === undefined) return prev
          const next = { ...prev }
          delete next[key]
          return next
        })
      } else {
        setOverrides(prev => ({ ...prev, [key]: val }))
      }
      const pending = takePending()
      if (val === baselineVal) {
        delete pending.patch[key]
        pending.restore.add(key)
      } else {
        pending.patch = { ...pending.patch, [key]: val }
        pending.restore.delete(key)
      }
      pendingPatchRef.current = pending
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = setTimeout(flushPending, 500)
    },
    [flushPending, takePending]
  )

  /** 恢复单个字段默认：先冲刷防抖队列（patch 先落盘、restore 后到删键胜出）→ 乐观删键 → 走统一在途登记通道 */
  const restoreField = useCallback(
    (fieldKey: keyof TechnicalEngineParameters) => {
      const wid = workspaceIdRef.current
      if (wid == null) return
      flushPending()
      setOverrides(prev => {
        if (prev[fieldKey] === undefined) return prev
        const next = { ...prev }
        delete next[fieldKey]
        return next
      })
      void persistMutation(
        { patch: {}, restore: new Set([fieldKey]), workspaceId: wid },
        t('恢复默认失败')
      )
    },
    [flushPending, persistMutation]
  )

  /** 恢复默认：仅对传入管辖键中已覆盖者发送 restoreOverrideFields（严禁传 null） */
  const resetKeys = useCallback(
    (keys: ReadonlyArray<keyof TechnicalEngineParameters>) => {
      const pending = takePending()
      for (const key of keys.filter(k => overridesRef.current[k] !== undefined)) {
        pending.restore.add(key)
        delete pending.patch[key]
      }
      pendingPatchRef.current = pending
      setOverrides(prev => {
        const next = { ...prev }
        for (const key of keys) delete next[key]
        return next
      })
      flushPending()
    },
    [flushPending, takePending]
  )

  return {
    overrides,
    effectiveParams,
    isSaving,
    handleParamChange,
    flushPending,
    restoreField,
    resetKeys
  }
}
