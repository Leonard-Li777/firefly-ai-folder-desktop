/**
 * 插件生命周期纯函数决策中枢 (deriveRunDecision)
 *
 * 遵循规格：plugin-lifecycle-developer-mode-and-archive-parser-spec.md §4.5
 * [G-04 铁律]：严禁以 holdReasons.length === 0 决定 shouldRun！
 * shouldRun 必须完全基于显式布尔逻辑计算，holdReasons 负责全量收集诊断原因，物理正交解耦。
 */

import type { ModuleAvailability as PluginAvailability } from '../database/dao/modular-resource-dao'

export type HoldReason = 'securityDelist' | 'devModeOff' | 'slotPreempted'

export interface RunContext {
  /** 纯读有效开发者模式（生产打包态且非 canary 强制熔断为 false） */
  devModeEffective: boolean
  /** 独占能力槽位是否已被其他运行中模块占用 */
  slotPreempted?: boolean
}

export interface RunDecision {
  /** 是否允许拉起或保持运行态 */
  shouldRun: boolean
  /** 全量收集的所有挂起/诊断原因（供日志与 UI 徽标展示） */
  holdReasons: HoldReason[]
  /** 优先级排序的主阻断文案提示 */
  blockReason?: string
}

/**
 * 纯函数：根据数据库事实与运行上下文计算运行态决策
 */
export function deriveRunDecision(
  row: {
    availability: PluginAvailability | string
    install_state: string
    delist_reason?: string | null
  },
  ctx: RunContext
): RunDecision {
  const holdReasons: HoldReason[] = []

  // 1. 全量收集所有命中的挂起诊断原因 (不短路，E-05 落地)
  if (row.delist_reason === 'security_violation') {
    holdReasons.push('securityDelist')
  }
  if (row.availability === 'draft' && !ctx.devModeEffective) {
    holdReasons.push('devModeOff')
  }
  if (ctx.slotPreempted) {
    holdReasons.push('slotPreempted')
  }

  // 2. 显式安全门禁判定 (安全门禁优先，严禁以 holdReasons.length === 0 作为依据，G-04 落地)
  const isSecurityBlocked = row.delist_reason === 'security_violation'
  const isComingSoon = row.availability === 'coming_soon'
  const isDraftBlocked = row.availability === 'draft' && !ctx.devModeEffective
  const isSlotBlocked = !!ctx.slotPreempted
  const isUserActive = row.install_state === 'active'

  const shouldRun =
    !isSecurityBlocked && !isComingSoon && !isDraftBlocked && !isSlotBlocked && isUserActive

  // 3. 优先级排序主阻断原因 (供 UI 呈现主提示文案)
  let blockReason: string | undefined
  if (isSecurityBlocked) {
    blockReason = '插件因安全违规已被官方停用'
  } else if (isComingSoon) {
    blockReason = '规划预热中，暂未就绪'
  } else if (isDraftBlocked) {
    blockReason = '开发者模式已关闭'
  } else if (isSlotBlocked) {
    blockReason = '独占能力槽位已被其他模块占用'
  } else if (!isUserActive) {
    blockReason = '用户未激活此插件'
  }

  return { shouldRun, holdReasons, blockReason }
}
