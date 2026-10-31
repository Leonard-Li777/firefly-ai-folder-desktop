/**
 * 引擎崩溃自愈策略（desktop 侧对 firefly-ai-engine 宿主进程的非预期退出）
 *
 * 背景（2026-10-22 事故）：分析进行中引擎宿主进程以 `0xC0000005`（访问违例）崩溃，
 * `engine-bridge-service` 的 exit 处理器只做 `process=null + applyOffline()`，
 * 全无自愈能力 —— 队列里 166 个文件全部连接被拒，直到用户手动点开引擎面板
 * 才由 `openUI` 分支 `ensureRunning({force:true})` 拉起。
 *
 * 本策略把「要不要自愈、隔多久自愈、还能自愈几次」抽成纯函数，便于护栏锁定：
 *
 * - **只治愈一次**：崩溃后最多自动重启 1 次。第二次仍失败即放弃，
 *   把错误交回队列原有的 failed 处理路径 —— 该路径不会阻塞 stage 1/2 的
 *   CPU 分析（提取/元数据），只影响 AI 阶段，用户仍能拿到基础产物。
 * - **必须留间隔**：崩溃瞬间 GPU 显存、端口、文件句柄都还没释放，
 *   立即重启大概率复现同一崩溃条件，所以延迟必须显著大于 0（见 CRASH_HEAL_DELAY_MS）。
 * - **排除主动行为**：用户点「停止服务」、切换引擎、退出应用、开发态二进制热部署
 *   都会 kill 进程，这些退出不得触发自愈，否则会变成「点了停止又自己起来」。
 */

/** 崩溃后等待多久再自愈（毫秒）。取值需覆盖显存/端口释放窗口，且不短于一次探活周期 */
export const CRASH_HEAL_DELAY_MS = 8000

/** 同一崩溃窗口内最多自愈次数（治愈一次；再失败即放弃） */
export const CRASH_HEAL_MAX_ATTEMPTS = 1

/**
 * 我方主动 kill 后的抑制窗口（毫秒）。
 * `killOwnProcess()` 走 `taskkill /F`，子进程 exit 事件是异步到达的，
 * 用时间戳而非一次性布尔标志，避免「标志残留导致下一次真崩溃不自愈」。
 */
export const SELF_KILL_SUPPRESS_MS = 5000

export interface CrashHealInput {
  /** 距我方最近一次主动 kill 的毫秒数；null 表示从未主动 kill 过 */
  msSinceSelfKill: number | null
  /** 是否处于「检测到二进制更新 → 回收旧进程 → 加载新版本」流程 */
  deploying: boolean
  /** 本崩溃窗口内已消耗的自愈次数 */
  attempts: number
  /** 引擎是否仍应运行（AI_SERVICE_MODE 非 disabled / cloud） */
  shouldRun: boolean
}

export type CrashHealSkipReason =
  | 'self-kill'
  | 'deploying'
  | 'exhausted'
  | 'engine-disabled'

export type CrashHealDecision =
  | { heal: true; delayMs: number; nextAttempts: number }
  | { heal: false; reason: CrashHealSkipReason }

/**
 * 判定一次非预期退出是否应触发自愈。
 *
 * 判定顺序即优先级：主动行为（部署 / 我方 kill）先排除，再看配置意图，
 * 最后才消耗自愈配额 —— 保证「配置里已经关掉引擎」不会白耗一次机会。
 */
export function decideCrashHeal(input: CrashHealInput): CrashHealDecision {
  if (input.deploying) {
    return { heal: false, reason: 'deploying' }
  }
  if (input.msSinceSelfKill !== null && input.msSinceSelfKill < SELF_KILL_SUPPRESS_MS) {
    return { heal: false, reason: 'self-kill' }
  }
  if (!input.shouldRun) {
    return { heal: false, reason: 'engine-disabled' }
  }
  if (input.attempts >= CRASH_HEAL_MAX_ATTEMPTS) {
    return { heal: false, reason: 'exhausted' }
  }
  return { heal: true, delayMs: CRASH_HEAL_DELAY_MS, nextAttempts: input.attempts + 1 }
}
