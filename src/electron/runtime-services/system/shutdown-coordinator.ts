/**
 * 关停编排器 (ShutdownCoordinator) — P0-6 · 四步关停握手失败语义表
 *
 * 父级规范: docs/specs/auto-update-dual-track-spec.md §2.7.2 / §2.7.3
 * 关联工单: 03-lifecycle-shutdown-and-file-lock-defense.md (AC 3.1)
 *           07-shutdown-coordinator-failure-semantics.md
 *
 * 为什么需要它:
 *   历史实现在 quitAndInstall 中用多个 try/catch 包裹四步关停，其中 omni/llama 的 stop
 *   是「空 catch」——吞掉异常后继续 quitAndInstall，导致：
 *     ① omni 若仍持有 resources/bin 句柄 → NSIS 覆盖安装报 "Error opening file for writing"；
 *     ② 失败无任何日志，现场不可诊断（违反 AGENTS.md 系统不变量 3「禁止静默降级」）。
 *
 * 失败语义表 (§2.7.3，逐项可单测):
 *   ┌────────────────────────┬──────────────────────┬───────────────────────────┐
 *   │ 步骤                    │ 失败类型              │ 处置                        │
 *   ├────────────────────────┼──────────────────────┼───────────────────────────┤
 *   │ WAL checkpoint          │ busy(有活跃写者,非抛) │ busy_timeout 重试一次 →     │
 *   │                         │                      │ 仍 busy 则 warn + 继续       │
 *   │ WAL checkpoint          │ 抛异常               │ 阻断 (非预期错误须上浮)      │
 *   │ omniService.stop()      │ 失败/超时            │ 阻断 (持有 resources/bin 句柄)│
 *   │ llamaServerService.stop │ 失败/超时            │ 阻断 (持有引擎端口句柄)      │
 *   │ libreOfficeDaemon 停机  │ 失败                 │ warn + 继续 (非关键)         │
 *   │ ProcessReaper.cleanup() │ 部分残留             │ warn + 继续 (安装器查杀兜底) │
 *   │ 所有步骤                │ 超时                 │ 各步独立超时; app.exit(0) 仅 │
 *   │                         │                      │ 编排器整体超时兜底           │
 *   └────────────────────────┴──────────────────────┴───────────────────────────┘
 *
 * 阻断 vs 继续: 阻断 = 不调用 quitAndInstall()，置为可重试状态；继续 = 记录告警后推进下一步。
 *
 * @doc-anchor: docs/specs/auto-update-dual-track-spec.md §2.7.3
 */
import { logger, LogCategory } from '@firefly/shared'

/** 单步超时上限 (P1-14: 以有界超时替代裸 sleep 魔数) */
export const STEP_TIMEOUT_MS = 5000

/** WAL checkpoint busy 重试一次的上限 */
const WAL_BUSY_RETRY_MS = 2000

/** 整体编排超时兜底上限 (超过则 app.exit(0)，不触发 before-quit/will-quit) */
export const ORCHESTRATION_TIMEOUT_MS = 15_000

/** 关停步骤名 */
export type ShutdownStepName =
  | 'checkpointWal'
  | 'stopOmni'
  | 'stopLlamaServer'
  | 'stopLibreOffice'
  | 'reapProcesses'

/** 单步执行结果 */
export interface ShutdownStepResult {
  step: ShutdownStepName
  ok: boolean
  /** 阻断=true 时，编排器应中止后续步骤并不调用 quitAndInstall */
  blocking: boolean
  reason?: string
}

/** 注入给编排器的关停能力 (由组合根 initialization.ts 在 initialize() 阶段注入) */
export interface ShutdownCapabilities {
  /** SQLite WAL checkpoint；返回 busy=true 表示有活跃写者(非抛错)；抛错=非预期错误 */
  checkpointWal: () => Promise<{ busy: boolean }>
  /** omni 停机（清除 restartTimeout 并置位停止标记，阻断自愈看门狗 scheduleRestart） */
  stopOmni: () => Promise<void>
  /** llama 推理引擎停机 */
  stopLlamaServer: () => Promise<void>
  /** libreoffice 常驻守护进程停机（非关键） */
  stopLibreOffice: () => Promise<void>
  /** ProcessReaper 兜底清扫（按 PID+exePath 双重校验） */
  reapProcesses: () => Promise<void>
}

export interface ShutdownOutcome {
  /** 是否所有阻断步骤均成功、可安全调用 quitAndInstall */
  canProceed: boolean
  results: ShutdownStepResult[]
  /** 阻断步骤名（供 UI 显示可重试状态） */
  blockedBy: ShutdownStepName[]
}

/** 有界执行：超时即视为该步失败，绝不无限悬挂 */
async function withTimeout<T>(label: string, ms: number, fn: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超时(${ms}ms)`)), ms)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 执行四步关停握手，逐项落地 §2.7.3 失败语义表。
 * 任何一步失败均 logger 显式上报，空 catch 一律消除。
 */
export async function runShutdownSequence(
  caps: ShutdownCapabilities,
  stepTimeoutMs: number = STEP_TIMEOUT_MS
): Promise<ShutdownOutcome> {
  const results: ShutdownStepResult[] = []

  // ── 第 1 步: WAL checkpoint ─────────────────────────────────────────
  // busy → busy_timeout 重试一次 → 仍 busy 则 warn + 继续 (WAL 崩溃安全)
  // 抛异常 → 阻断 (非预期错误须上浮；未 checkpoint 即替换 .db 可能丢 WAL 尾部)
  {
    const step: ShutdownStepName = 'checkpointWal'
    try {
      const first = await withTimeout(`${step}#1`, stepTimeoutMs, () => caps.checkpointWal())
      if (!first.busy) {
        results.push({ step, ok: true, blocking: false })
      } else {
        logger.warn(LogCategory.SYSTEM, `[ShutdownCoordinator] WAL checkpoint busy，busy_timeout 重试一次...`)
        await new Promise(r => setTimeout(r, WAL_BUSY_RETRY_MS))
        const second = await withTimeout(`${step}#2`, stepTimeoutMs, () => caps.checkpointWal())
        if (second.busy) {
          logger.warn(
            LogCategory.SYSTEM,
            `[ShutdownCoordinator] WAL checkpoint 重试仍 busy，WAL 崩溃安全，继续关停`
          )
          results.push({ step, ok: true, blocking: false, reason: 'busy-after-retry' })
        } else {
          results.push({ step, ok: true, blocking: false, reason: 'busy-recovered' })
        }
      }
    } catch (err: any) {
      logger.error(LogCategory.SYSTEM, `[ShutdownCoordinator] WAL checkpoint 抛异常，阻断安装:`, err?.message)
      results.push({ step, ok: false, blocking: true, reason: err?.message })
    }
  }

  // 若第 1 步阻断，直接返回，不继续后续步骤
  if (results.some(r => r.blocking)) {
    return {
      canProceed: false,
      results,
      blockedBy: results.filter(r => r.blocking).map(r => r.step)
    }
  }

  // ── 第 2 步: 业务服务显式停机（阻断自愈看门狗）──────────────────────
  // omni: 失败/超时 → 阻断 (持有 resources/bin 句柄)
  {
    const step: ShutdownStepName = 'stopOmni'
    try {
      await withTimeout(step, stepTimeoutMs, () => caps.stopOmni())
      results.push({ step, ok: true, blocking: false })
    } catch (err: any) {
      logger.error(
        LogCategory.SYSTEM,
        `[ShutdownCoordinator] omniService.stop() 失败/超时，阻断安装(UI 可重试):`,
        err?.message
      )
      results.push({ step, ok: false, blocking: true, reason: err?.message })
    }
  }

  // llama: 失败/超时 → 阻断 (持有引擎端口句柄)
  {
    const step: ShutdownStepName = 'stopLlamaServer'
    try {
      await withTimeout(step, stepTimeoutMs, () => caps.stopLlamaServer())
      results.push({ step, ok: true, blocking: false })
    } catch (err: any) {
      logger.error(
        LogCategory.SYSTEM,
        `[ShutdownCoordinator] llamaServerService.stop() 失败/超时，阻断安装:`,
        err?.message
      )
      results.push({ step, ok: false, blocking: true, reason: err?.message })
    }
  }

  // libreoffice: 非关键 → warn + 继续
  {
    const step: ShutdownStepName = 'stopLibreOffice'
    try {
      await withTimeout(step, stepTimeoutMs, () => caps.stopLibreOffice())
      results.push({ step, ok: true, blocking: false })
    } catch (err: any) {
      logger.warn(LogCategory.SYSTEM, `[ShutdownCoordinator] libreoffice 停机失败(非关键，继续):`, err?.message)
      results.push({ step, ok: true, blocking: false, reason: err?.message })
    }
  }

  // 若第 2 步有阻断，直接返回（不执行清扫与安装）
  if (results.some(r => r.blocking)) {
    return {
      canProceed: false,
      results,
      blockedBy: results.filter(r => r.blocking).map(r => r.step)
    }
  }

  // ── 第 3 步: ProcessReaper 兜底清扫 ─────────────────────────────────
  // 部分残留 → warn + 继续 (NSIS 安装器 customInit 查杀兜底)
  {
    const step: ShutdownStepName = 'reapProcesses'
    try {
      await withTimeout(step, stepTimeoutMs, () => caps.reapProcesses())
      results.push({ step, ok: true, blocking: false })
    } catch (err: any) {
      logger.warn(LogCategory.SYSTEM, `[ShutdownCoordinator] ProcessReaper 清扫警告(继续，安装器兜底):`, err?.message)
      results.push({ step, ok: true, blocking: false, reason: err?.message })
    }
  }

  return {
    canProceed: true,
    results,
    blockedBy: []
  }
}

/** 整体编排超时兜底 (P0-6: app.exit(0) 仅兜底，不触发 before-quit/will-quit) */
export async function runShutdownSequenceWithOverallTimeout(
  caps: ShutdownCapabilities,
  orchestration: () => Promise<ShutdownOutcome>,
  timeoutMs: number = ORCHESTRATION_TIMEOUT_MS
): Promise<ShutdownOutcome> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      orchestration(),
      new Promise<ShutdownOutcome>((resolve) => {
        timer = setTimeout(() => {
          logger.error(
            LogCategory.SYSTEM,
            `[ShutdownCoordinator] 关停编排整体超时(${timeoutMs}ms)，app.exit(0) 兜底(不触发 before-quit)`
          )
          resolve({
            canProceed: false,
            results: [{ step: 'reapProcesses', ok: false, blocking: true, reason: 'orchestration-timeout' }],
            blockedBy: ['reapProcesses']
          })
        }, timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
