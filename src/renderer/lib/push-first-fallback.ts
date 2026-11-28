/**
 * push 优先 + 启动未就绪受控退避兜底控制器（TM-W2 / J-02）
 *
 * 治理目标：状态展示类消费方（Footer / 引擎设置页 / App 启动兜底）废除常驻周期轮询，
 * 改为订阅主进程 push；仅在「推通道尚未就绪 / 启动未就绪 / 极端断连窗口」按受控退避
 * 策略兜底拉取，状态就绪后立即停表（引擎静止空闲 0 定时器唤醒）。
 *
 * 行为契约：
 * 1. `start()` 立即拉取一次；未就绪则按 initialDelayMs * factor^n 指数退避（封顶 maxDelayMs）；
 * 2. 拉取就绪（pull 返回 true）或 `notifyReady()`（push 到达）后：
 *    - push 可用：彻底停表，后续状态全部由 push 驱动；
 *    - push 不可用（旧 preload / 测试降级）：切换为唯一 degradedIntervalMs 兜底轮询，
 *      且仅在 `document.visibilityState === 'visible'` 时真正拉取（治理计划 §5.4 / EQ-6，
 *      严禁把副屏未聚焦 blur 判为隐藏）；
 * 3. `notifyDisconnected()`：push 可用时的极端断连窗口，重新进入退避兜底链；
 * 4. `dispose()`：清空全部定时器并锁定栅栏，之后一切调用为空操作。
 *
 * 本模块为纯 TS（不依赖 React / Electron），供渲染层多处复用与单测直覆盖。
 */
import { AIServiceStatus } from '@firefly/types'

export interface PushFirstFallbackOptions {
  /** 兜底拉取：返回 true 表示状态已就绪（可停表 / 转降级兜底） */
  pull: () => Promise<boolean>
  /** 主进程 push 通道是否可用（可用时就绪后彻底停表） */
  pushAvailable: boolean
  /** 首次退避间隔（默认 1000ms） */
  initialDelayMs?: number
  /** 退避间隔封顶（默认 30000ms） */
  maxDelayMs?: number
  /** 退避倍数（默认 2） */
  factor?: number
  /** push 不可用时的唯一兜底轮询周期（默认 30000ms，仅可见时拉取） */
  degradedIntervalMs?: number
  /** 可见性判定注入（默认 document.visibilityState === 'visible'；单测确定性用） */
  isVisible?: () => boolean
}

export interface PushFirstFallbackHandle {
  /** 启动兜底链：立即拉取一次，未就绪进入指数退避 */
  start(): void
  /** push 到达或外部确认就绪：停退避表（push 不可用时转唯一降级兜底） */
  notifyReady(): void
  /** 极端断连窗口：push 可用时重新进入退避兜底链 */
  notifyDisconnected(): void
  /** 释放全部定时器并锁定关停栅栏 */
  dispose(): void
  /** 当前是否存在活跃定时器（观测与单测断言用） */
  hasActiveTimer(): boolean
}

const DEFAULT_INITIAL_DELAY_MS = 1000
const DEFAULT_MAX_DELAY_MS = 30000
const DEFAULT_FACTOR = 2
const DEFAULT_DEGRADED_INTERVAL_MS = 30000

function defaultIsVisible(): boolean {
  if (typeof document === 'undefined') return true
  return document.visibilityState === 'visible'
}

export function createPushFirstFallback(
  options: PushFirstFallbackOptions
): PushFirstFallbackHandle {
  const initialDelayMs = Math.max(1, options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS)
  const maxDelayMs = Math.max(initialDelayMs, options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS)
  const factor = Math.max(1, options.factor ?? DEFAULT_FACTOR)
  const degradedIntervalMs = Math.max(1, options.degradedIntervalMs ?? DEFAULT_DEGRADED_INTERVAL_MS)
  const isVisible = options.isVisible ?? defaultIsVisible

  let disposed = false
  let pulling = false
  let attempt = 0
  let backoffTimer: ReturnType<typeof setTimeout> | null = null
  let degradedTimer: ReturnType<typeof setInterval> | null = null

  const clearBackoff = (): void => {
    if (backoffTimer !== null) {
      clearTimeout(backoffTimer)
      backoffTimer = null
    }
  }

  const clearDegraded = (): void => {
    if (degradedTimer !== null) {
      clearInterval(degradedTimer)
      degradedTimer = null
    }
  }

  /** 就绪收口：push 可用彻底停表；不可用转唯一可见时兜底轮询 */
  const settle = (): void => {
    clearBackoff()
    attempt = 0
    if (disposed || options.pushAvailable) return
    if (degradedTimer !== null) return
    degradedTimer = setInterval(() => {
      if (disposed || !isVisible()) return
      void runPull()
    }, degradedIntervalMs)
  }

  const scheduleBackoff = (): void => {
    if (disposed) return
    clearBackoff()
    const delay = Math.min(initialDelayMs * Math.pow(factor, attempt), maxDelayMs)
    attempt += 1
    backoffTimer = setTimeout(() => {
      backoffTimer = null
      void runPull()
    }, delay)
  }

  const runPull = async (): Promise<void> => {
    if (disposed || pulling) return
    pulling = true
    try {
      const ready = await options.pull()
      if (disposed) return
      if (ready) {
        settle()
      } else {
        scheduleBackoff()
      }
    } catch {
      // pull 内部负责显式上报失败原因；此处仅推进退避，绝不静默吞掉后就绪
      if (!disposed) scheduleBackoff()
    } finally {
      pulling = false
    }
  }

  return {
    start() {
      if (disposed) return
      attempt = 0
      void runPull()
    },
    notifyReady() {
      if (disposed) return
      settle()
    },
    notifyDisconnected() {
      if (disposed || !options.pushAvailable) return
      clearDegraded()
      attempt = 0
      scheduleBackoff()
    },
    dispose() {
      if (disposed) return
      disposed = true
      clearBackoff()
      clearDegraded()
    },
    hasActiveTimer() {
      return backoffTimer !== null || degradedTimer !== null
    }
  }
}

/**
 * AI 服务状态是否已到达「真实终态」（就绪 / 推理中 / 真实异常 / 真实停止）。
 * 过渡态（初始化 / 配置 / 加载 / 连接 / 重启 / 等待）与未初始化仍需启动兜底退避。
 * 供 App.tsx 启动兜底与 push 停表判定共用，严禁各处私造状态白名单。
 */
export function isSettledAIStatus(status: string | null | undefined): boolean {
  return (
    status === AIServiceStatus.IDLE ||
    status === AIServiceStatus.PROCESSING ||
    status === AIServiceStatus.ERROR ||
    status === AIServiceStatus.STOPPED
  )
}
