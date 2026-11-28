/**
 * Startup Gates —— 启动就绪门闸纯 Promise 协调器（核心层，工单 TM-W2 / B6）
 *
 * 定位（启动性能计划 §6.3）：放 `src/electron/main/` 核心层保障开源 / 专业版门闸同源正确性
 * （D-07：门闸等待语义不属于 Pro 优化，严禁下沉 pro/ 造成两套构建行为分裂）。
 *
 * 三条硬契约（B6）：
 * 1. 每个门闸统一返回 `Promise<GateSettlement>`（`{ ok: true, bypassed? } | { ok: false, reason }`）；
 * 2. **绝不永久挂起**：上游初始化 catch 分支必须调用 `settleGateFailed(name, err)`，
 *    所有 `await gate(name)` 的下游立即唤醒并按各自原有容错契约降级（不套一刀切超时包装）；
 * 3. **回退开关直通**：`FF_STARTUP_EARLY_WINDOW = 0`（perf-flags `startup.earlyWindow = false`）时，
 *    `initStartupGates({ bypassAll: true })` 使全部门闸在注册时刻立即 resolve `{ ok: true, bypassed: true }`。
 *
 * 首次 settle 生效（first-settle-wins）：门闸一旦落地不可翻转，防止运行期状态振荡。
 * 本工单（W2）只建骨架与单测；W3 启动分层改造时在 bootstrap 期以 perf-flags 快照调用
 * `initStartupGates`，并由各上游初始化链接线 settle。
 */
import { logger, LogCategory } from '@firefly/shared'

export type StartupGateName =
  | 'dbReady'
  | 'reaperDone'
  | 'cloudReady'
  | 'licenseConfirmed'
  | 'phaseAGate'

export type GateSettlement = { ok: true; bypassed?: boolean } | { ok: false; reason: string }

export const STARTUP_GATE_NAMES: readonly StartupGateName[] = [
  'dbReady',
  'reaperDone',
  'cloudReady',
  'licenseConfirmed',
  'phaseAGate'
]

const LOG_PREFIX = '[StartupGates]'

interface GateEntry {
  promise: Promise<GateSettlement>
  settle: (settlement: GateSettlement) => void
  settlement: GateSettlement | null
}

let gates: Map<StartupGateName, GateEntry> | null = null
let gatesInitialized = false

function createEntry(): GateEntry {
  let settle!: (settlement: GateSettlement) => void
  const promise = new Promise<GateSettlement>(resolve => {
    settle = resolve
  })
  return { promise, settle, settlement: null }
}

function ensureGates(): Map<StartupGateName, GateEntry> {
  if (!gates) {
    gates = new Map(STARTUP_GATE_NAMES.map(name => [name, createEntry()]))
  }
  return gates
}

function settleOnce(name: StartupGateName, settlement: GateSettlement): void {
  const entry = ensureGates().get(name)!
  if (entry.settlement !== null) return
  entry.settlement = settlement
  entry.settle(settlement)
}

/**
 * 启动注册入口（幂等）：`bypassAll = true` 时全部**未落地**门闸立即直通 resolve；
 * 已落地门闸保持原结果（first-settle-wins，严禁运行期翻转）。
 */
export function initStartupGates(options: { bypassAll?: boolean } = {}): void {
  gatesInitialized = true
  ensureGates()
  if (options.bypassAll !== true) return
  for (const name of STARTUP_GATE_NAMES) {
    settleOnce(name, { ok: true, bypassed: true })
  }
}

export function isStartupGatesInitialized(): boolean {
  return gatesInitialized
}

/** 等待门闸落地（永不 reject；失败以 `{ ok: false, reason }` 结构化返回） */
export function gate(name: StartupGateName): Promise<GateSettlement> {
  return ensureGates().get(name)!.promise
}

/** 上游初始化成功落地 */
export function settleGateOk(name: StartupGateName): void {
  settleOnce(name, { ok: true })
}

/** 上游初始化失败落地：立即唤醒全部等待方，warn 上报，绝不让 IPC 永挂 */
export function settleGateFailed(name: StartupGateName, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error)
  logger.warn(LogCategory.MAIN, `${LOG_PREFIX} 门闸失败落地: ${name} — ${reason}`, error)
  settleOnce(name, { ok: false, reason })
}

/** 门闸是否已落地（成功或失败均算落地） */
export function isGateSettled(name: StartupGateName): boolean {
  return (gates?.get(name)?.settlement ?? null) !== null
}

/**
 * 轻量诊断（P2 phaseGuard）：未就绪被提前同步调用时仅打一行 warn 暴露隐患，
 * 严禁抛错阻断业务、严禁引入 phase 状态机。
 */
export function assertPhaseReady(name: StartupGateName, caller: string): void {
  if (!isGateSettled(name)) {
    logger.warn(LogCategory.MAIN, `${LOG_PREFIX} ${caller} 在门闸 ${name} 未就绪时被提前调用`)
  }
}

/** 仅供单测：重置全部门闸状态 */
export function resetStartupGatesForTesting(): void {
  gates = null
  gatesInitialized = false
}
