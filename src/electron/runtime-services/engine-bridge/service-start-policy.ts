/**
 * Tier 2 推理服务「是否可用 / 是否该触发启动」判定策略（2026-10-30 事故）
 *
 * 事故：desktop 重启后 firefly-ai-engine 宿主进程是新的，HTTP `/api/engine/status`
 * 立刻可响应（status=`stopped`），但推理服务从未启动 ⇒ 引擎侧 `target_port` 为 `None`
 * ⇒ 所有 `/v1/*` 被反代拒绝为 503「AI engine is starting」，持续 87 分钟直到用户
 * 手动打开引擎面板。
 *
 * 根因是判定口径把「宿主 HTTP 可响应」当成了「推理服务可用」。本模块把正确口径
 * 固化为纯函数：
 * 1. `isServiceUsableStatus`：只有 `ready` / `processing` / `starting` 才算可用；
 * 2. `shouldTriggerServiceStartAt`：`stopped` 必须拉起（带节流），`error` 只允许显式重试。
 *
 * 与 `crash-heal-policy.ts` 同样单独成文件的原因：`engine-bridge-service.ts` 顶层
 * `import { app } from 'electron'`，在 vitest（Node 环境）下无法加载，判定逻辑留在
 * 该文件里就只能靠读源码正则护栏，无法用真值表覆盖。**禁止**把这些函数搬回服务文件。
 */

/**
 * 推理服务「可用」的进程状态集合。
 *
 * - `ready` / `processing`：模型已加载，可直接服务请求；
 * - `starting`：模型加载中，**视为可用**——此时重复触发启动只会让引擎侧
 *   `operation_lock` 排队堆积，且 `start_engine_service` 在 `Starting` 态会直接返回
 *   成功而不切换模型（虚假成功），故绝不能再发启动请求。
 *
 * `stopped`（宿主在线但推理服务从未启动）与 `error`（启动失败）都不在集合内。
 */
const SERVICE_USABLE_STATUSES: ReadonlySet<string> = new Set(['ready', 'processing', 'starting'])

/**
 * 唯一允许「隐式触发一次 startService」的进程状态。
 *
 * 只认 `stopped`：`error` 意味着启动失败已落库（`ProcessStatus::Failed`），
 * 隐式重试会形成「每轮分析重试一次启动」的风暴；其恢复只能由显式路径
 * （`ensureMode()` / 用户点启动）发起。
 */
const SERVICE_TRIGGERABLE_STATUS = 'stopped'

/**
 * 隐式启动的最小间隔（毫秒）。
 *
 * 防的是 `stopped` 态下的高频探活风暴，以及「启动耗时较长但状态尚未切入 `starting`」
 * 的窄窗口内重复触发。`doStart`（新进程拉起）与 `force:true`（用户手动点击）
 * 都会清零/穿透该时间戳，不影响正常恢复与交互响应速度。
 */
export const IMPLICIT_START_MIN_INTERVAL_MS = 30_000

/**
 * 推理服务是否可用（纯函数）。
 *
 * **严禁**用「`/api/engine/status` 可响应」替代本判定。
 */
export function isServiceUsableStatus(status?: string | null): boolean {
  return typeof status === 'string' && SERVICE_USABLE_STATUSES.has(status)
}

/**
 * 是否应触发一次 `startService()`（纯函数）。
 *
 * - `stopped`：宿主在线但推理服务从未启动 —— 必须拉起（`explicit` 穿透节流）；
 * - `error`：启动失败已落库，仅 `explicit`（用户点启动 / 新进程拉起）可重试；
 * - 其它：无需触发。
 */
export function shouldTriggerServiceStartAt(params: {
  status?: string | null
  now: number
  lastImplicitStartAt: number
  explicit: boolean
}): boolean {
  const { status, now, lastImplicitStartAt, explicit } = params
  if (status === SERVICE_TRIGGERABLE_STATUS) {
    return explicit || now - lastImplicitStartAt >= IMPLICIT_START_MIN_INTERVAL_MS
  }
  // 显式意图允许对「启动失败」重试：引擎侧守卫只拦 Running|Starting，Failed 可重入。
  // 否则用户点「启动」既不重试也不报错，按钮永久失效。
  return explicit && status === 'error'
}
