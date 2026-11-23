import {
  PANEL_IDS,
  PanelId,
  LayoutKey,
  LayoutDefinition
} from './types'

/** 分割手柄计算厚度 */
export const HANDLE_SIZE = 16

/** 回展安全滞回缓冲 (px) */
export const HYSTERESIS_THRESHOLD = 16

/** 面板基准最小尺寸约束 */
export const PANEL_MIN_SIZE: Record<PanelId, { w: number; h: number }> = {
  [PANEL_IDS.LIST]: { w: 360, h: 200 },
  [PANEL_IDS.PREVIEW]: { w: 280, h: 200 },
  [PANEL_IDS.DETAILS]: { w: 280, h: 200 }
}

/** 恒定两级树槽位参数推导配置 */
export interface LayoutProjection {
  primaryDirection: 'horizontal' | 'vertical'
  companionDirection: 'horizontal' | 'vertical'
  collapsed: {
    companion: boolean
    preview: boolean
    details: boolean
  }
}

/** 判定两个 Set 是否完全等价 */
export function areSetsEqual<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a.size !== b.size) return false
  for (const item of a) {
    if (!b.has(item)) return false
  }
  return true
}

/**
 * 槽位参数推导全函数：任何输入不抛错，保证 list 恒可见
 * 严格清洗：visible ∩ layout.panels \ unavailablePanels ∪ {list}
 */
export function resolveLayoutProjection(
  layout: LayoutDefinition,
  visiblePanels: ReadonlySet<PanelId> | PanelId[],
  unavailablePanels?: ReadonlySet<PanelId> | PanelId[]
): LayoutProjection {
  const visibleSet = visiblePanels instanceof Set ? visiblePanels : new Set(visiblePanels)
  const unavailableSet =
    unavailablePanels instanceof Set
      ? unavailablePanels
      : unavailablePanels
        ? new Set(unavailablePanels)
        : null

  const effective = new Set<PanelId>()
  effective.add(PANEL_IDS.LIST)

  for (const p of visibleSet) {
    if (layout.panels.includes(p) && (!unavailableSet || !unavailableSet.has(p))) {
      effective.add(p)
    }
  }

  const hasPreview = effective.has(PANEL_IDS.PREVIEW)
  const hasDetails = effective.has(PANEL_IDS.DETAILS)
  const hasCompanion = hasPreview || hasDetails

  return {
    primaryDirection: layout.primaryDirection,
    companionDirection: layout.companionDirection,
    collapsed: {
      companion: !hasCompanion,
      preview: !hasPreview,
      details: !hasDetails
    }
  }
}

/** 计算当前布局在指定可见与折叠状态下的最小空间需求 */
export function computeRequiredSizes(
  layout: LayoutDefinition,
  visiblePanels: ReadonlySet<PanelId>,
  collapsedPanels: ReadonlySet<PanelId>
): { reqW: number; reqH: number } {
  const hasPreview =
    visiblePanels.has(PANEL_IDS.PREVIEW) && !collapsedPanels.has(PANEL_IDS.PREVIEW)
  const hasDetails =
    visiblePanels.has(PANEL_IDS.DETAILS) && !collapsedPanels.has(PANEL_IDS.DETAILS)
  const hasCompanion = hasPreview || hasDetails

  // 1. 计算伴随面板区所需尺寸
  let companionW = 0
  let companionH = 0

  if (hasCompanion) {
    const prevW = hasPreview ? PANEL_MIN_SIZE.preview.w : 0
    const prevH = hasPreview ? PANEL_MIN_SIZE.preview.h : 0
    const detW = hasDetails ? PANEL_MIN_SIZE.details.w : 0
    const detH = hasDetails ? PANEL_MIN_SIZE.details.h : 0
    const hasBoth = hasPreview && hasDetails

    if (layout.companionDirection === 'horizontal') {
      companionW = prevW + detW + (hasBoth ? HANDLE_SIZE : 0)
      companionH = Math.max(prevH, detH)
    } else {
      companionW = Math.max(prevW, detW)
      companionH = prevH + detH + (hasBoth ? HANDLE_SIZE : 0)
    }
  }

  // 2. 计算外层总需求
  const listW = PANEL_MIN_SIZE.list.w
  const listH = PANEL_MIN_SIZE.list.h

  let reqW = 0
  let reqH = 0

  if (layout.primaryDirection === 'horizontal') {
    reqW = listW + (hasCompanion ? companionW + HANDLE_SIZE : 0)
    reqH = Math.max(listH, hasCompanion ? companionH : 0)
  } else {
    reqW = Math.max(listW, hasCompanion ? companionW : 0)
    reqH = listH + (hasCompanion ? companionH + HANDLE_SIZE : 0)
  }

  return { reqW, reqH }
}

/** 计算尺寸赤字 */
function computeDeficits(
  containerWidth: number,
  containerHeight: number,
  layout: LayoutDefinition,
  visiblePanels: ReadonlySet<PanelId>,
  collapsedPanels: ReadonlySet<PanelId>
): { deficitW: number; deficitH: number } {
  const { reqW, reqH } = computeRequiredSizes(layout, visiblePanels, collapsedPanels)
  return {
    deficitW: Math.max(0, reqW - containerWidth),
    deficitH: Math.max(0, reqH - containerHeight)
  }
}

/** 判定移除某面板是否能实质降低当前短缺轴的赤字 */
function wouldReduceDeficit(
  panel: PanelId,
  deficitW: number,
  deficitH: number,
  layout: LayoutDefinition,
  visiblePanels: ReadonlySet<PanelId>,
  currentCollapsed: ReadonlySet<PanelId>,
  containerWidth: number,
  containerHeight: number
): boolean {
  const testCollapsed = new Set(currentCollapsed)
  testCollapsed.add(panel)
  const { reqW: newReqW, reqH: newReqH } = computeRequiredSizes(
    layout,
    visiblePanels,
    testCollapsed
  )
  const newDeficitW = Math.max(0, newReqW - containerWidth)
  const newDeficitH = Math.max(0, newReqH - containerHeight)

  return (
    (deficitW > 0 && newDeficitW < deficitW) ||
    (deficitH > 0 && newDeficitH < deficitH)
  )
}

/**
 * 纯函数：根据视口尺寸、布局定义、可见意图与上一帧折叠记忆，
 * 确定性推导出当前渲染层应执行瞬态折叠的面板集合（内容置 null）。
 *
 * @param containerWidth  容器实时宽度 (px)
 * @param containerHeight 容器实时高度 (px)
 * @param layout          当前布局预设定义
 * @param visiblePanels   用户当前意图展开的面板集合 (Set)
 * @param prevCollapsed   上一帧瞬态折叠的面板集合 (用于滞回判定)
 * @param hysteresis      回展安全滞回缓冲 (默认 16px)
 * @param unavailablePanels 业务不可用面板集合 (不入记忆、不参与回展)
 * @returns 需瞬态折叠的面板集合 Set<PanelId>
 */
export function resolveEffectiveCollapse(
  containerWidth: number,
  containerHeight: number,
  layout: LayoutDefinition,
  visiblePanels: ReadonlySet<PanelId>,
  prevCollapsed: ReadonlySet<PanelId> = new Set(),
  hysteresis: number = HYSTERESIS_THRESHOLD,
  unavailablePanels?: ReadonlySet<PanelId>
): Set<PanelId> {
  // 业务不可用面板（如 VirtualDirectory 未选中目录时的 details）隔离排除
  const effectiveVisible = new Set<PanelId>()
  for (const p of visiblePanels) {
    if (!unavailablePanels || !unavailablePanels.has(p)) {
      effectiveVisible.add(p)
    }
  }

  // 初始折叠集仅继承有效且未标记为不可用的上一帧折叠面板
  const effectiveCollapsed = new Set<PanelId>()
  for (const p of prevCollapsed) {
    if (effectiveVisible.has(p)) {
      effectiveCollapsed.add(p)
    }
  }

  // -------------------------------------------------------------------
  // A. 回展检查 (Upsizing with Hysteresis)：视口放大时，逆序受控完全收敛回展
  // -------------------------------------------------------------------
  if (effectiveCollapsed.size > 0) {
    // 回展顺序严格为折叠顺序的逆序：preview (高优先级) 优先于 details (低优先级)
    const restoreQueue: PanelId[] = [PANEL_IDS.PREVIEW, PANEL_IDS.DETAILS].filter(p =>
      effectiveCollapsed.has(p)
    )
    for (const panel of restoreQueue) {
      const candidateCollapsed = new Set(effectiveCollapsed)
      candidateCollapsed.delete(panel)
      const { reqW, reqH } = computeRequiredSizes(layout, effectiveVisible, candidateCollapsed)
      // 必须同时在双轴满足：可用空间 >= 所需最小尺寸 + 滞回缓冲 (16px)
      if (containerWidth >= reqW + hysteresis && containerHeight >= reqH + hysteresis) {
        effectiveCollapsed.delete(panel)
        // 单次回调完全收敛：同次调用中以更新后的 candidateCollapsed 继续评估后续面板
      }
    }
  }

  // -------------------------------------------------------------------
  // B. 消赤折叠检查 (Downsizing with Tie-Breaking)：视口不足时定向消赤
  // -------------------------------------------------------------------
  let { deficitW, deficitH } = computeDeficits(
    containerWidth,
    containerHeight,
    layout,
    effectiveVisible,
    effectiveCollapsed
  )

  const foldableCandidates: PanelId[] = [PANEL_IDS.DETAILS, PANEL_IDS.PREVIEW].filter(
    p => effectiveVisible.has(p) && !effectiveCollapsed.has(p)
  )

  while ((deficitW > 0 || deficitH > 0) && foldableCandidates.length > 0) {
    // 步骤 1：优先寻找移除后能实质降低当前短缺轴尺寸赤字的候选面板
    let targetIndex = foldableCandidates.findIndex(p =>
      wouldReduceDeficit(
        p,
        deficitW,
        deficitH,
        layout,
        effectiveVisible,
        effectiveCollapsed,
        containerWidth,
        containerHeight
      )
    )

    // 步骤 2：若无单个候选能降低赤字（例如 tri 在正交轴上的等 min 僵局 max(280, 280)），
    // 则回退至按固定优先级折叠当前候选队列中最低优先级的面板（details -> preview）以破局
    if (targetIndex === -1) {
      targetIndex = 0 // 首项即为最低优先级的 details
    }

    const [target] = foldableCandidates.splice(targetIndex, 1)
    effectiveCollapsed.add(target)
    ;({ deficitW, deficitH } = computeDeficits(
      containerWidth,
      containerHeight,
      layout,
      effectiveVisible,
      effectiveCollapsed
    ))
  }

  // 步骤 3：若所有伴随面板折完依然存在赤字（例如视口 < list.w 360px）：
  // 终止循环，list 独占全部可用容器空间，由容器 overflow 裁切，绝不折叠 list，绝不写盘。
  return effectiveCollapsed
}
