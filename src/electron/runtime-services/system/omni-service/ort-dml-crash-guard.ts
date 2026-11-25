/**
 * DirectML 原生崩溃守卫（ORT-DML Crash Guard）
 *
 * 背景：gemma 视觉塔经 DirectML EP 推理时，驱动/EP 的原生异常（并发 Run、OOM、驱动 AV）
 * 会以 C++ 异常穿出 Rust FFI 边界，进程被直接 abort（Windows 退出码 0xC0000409 等）。
 * 此时 `session.run` 的 Err 兜底与 `catch_unwind` 都来不及执行，整段视频的切片/向量
 * 全部丢失，用户侧只看到「分析完成但搜不到切片」。
 *
 * 因此：桌面端在检测到这类原生崩溃后，把「下次拉起 Omni 时禁用 DirectML」这一结论
 * 持久化到主库同级标记文件；`start()` 读取后下发 `OMNI_DISABLE_DML=1`，由 Omni 在
 * 启动期置位全局 DML 降级闸，改用纯 CPU 视觉塔，保证同一视频重试能真正产出切片。
 *
 * 全部为纯函数，便于单测；文件读写由调用方负责。
 */

/**
 * Windows 原生致命退出码（Node 可能给出有符号/无符号两种形态，统一按无符号比较）。
 * - 0xC0000409 STATUS_STACK_BUFFER_OVERRUN / STATUS_FATAL_APP_EXIT（abort）
 * - 0xC0000005 STATUS_ACCESS_VIOLATION
 * - 0xC00000FD STATUS_STACK_OVERFLOW
 * - 0x80000003 STATUS_BREAKPOINT
 */
const FATAL_NATIVE_EXIT_CODES: ReadonlySet<number> = new Set([
  0xc0000409, 0xc0000005, 0xc00000fd, 0x80000003
])

/** 标记有效期（双击确认后）：过期后允许重新尝试 DirectML（避免永久降级到 CPU）。 */
export const DML_CRASH_MARKER_TTL_MS = 24 * 60 * 60 * 1000
/** 首次原生崩溃的短 TTL 保护（30 分钟），防止偶发误封 24 小时。 */
export const DML_CRASH_FIRST_STRIKE_TTL_MS = 30 * 60 * 1000
/** 滑动窗口上限（24 小时）：距上次检测超过该窗口自动清零 strikes。 */
export const DML_CRASH_STRIKE_WINDOW_MS = 24 * 60 * 60 * 1000

const FATAL_NATIVE_SIGNALS: ReadonlySet<string> = new Set([
  'SIGABRT',
  'SIGSEGV',
  'SIGILL',
  'SIGBUS',
  'SIGFPE'
])

export type OmniCrashCategory =
  | 'intentional_kill'
  | 'rust_oom'
  | 'dml_native_crash'
  | 'unknown_or_cpu_crash'

export interface OmniCrashContext {
  /** 是否为当前桌面端托管 spawn 的子进程（复用外部进程无托管 stderr 与退出码，一律保守不写 GPU 封禁） */
  managedChild: boolean
  /** 本次启动是否启用了 DirectML（OMNI_DISABLE_DML=1 时为 false） */
  dmlEnabled: boolean
  /** 是否属于主动终止/重启（对应 per-launch ctx.intentionalKill） */
  wasIntentionalKill: boolean
  exitCode: number | null | undefined
  signal: NodeJS.Signals | null | undefined
  /** 子进程 stderr 尾段（已合并无换行残段 stderrPartial） */
  stderrTail: string
}

export interface DmlCrashMarker {
  firstDetectedAt: number
  lastDetectedAt: number
  strikes: number
  exitCode: number
}

/** 判定子进程退出码是否为原生崩溃（非正常退出）。类型谓词：命中后调用方可收窄为 number。 */
export function isFatalNativeExitCode(code: number | null | undefined): code is number {
  if (typeof code !== 'number' || !Number.isFinite(code)) return false
  return FATAL_NATIVE_EXIT_CODES.has(code >>> 0)
}

/**
 * 识别 Rust 分配器 OOM 特征（std::alloc::handle_alloc_error / 自定义 alloc-hook 指纹）。
 * Windows 下 Rust OOM 会经 abort/__fastfail 产生 0xC0000409，必须先于 DML 归因排除。
 */
export function isRustOomStderr(stderrTail: string | null | undefined): boolean {
  if (!stderrTail) return false
  return (
    /memory allocation of \d+ bytes failed/i.test(stderrTail) ||
    /handle_alloc_error/i.test(stderrTail) ||
    /\[RUST_OOM\]/i.test(stderrTail) ||
    /omni_rust_oom/i.test(stderrTail)
  )
}

/**
 * 四分类纯函数崩溃归因器（仅在 child.on('close') 管道排空后调用，基于 per-launch LaunchContext 证据）。
 */
export function classifyOmniCrash(ctx: OmniCrashContext): OmniCrashCategory {
  if (ctx.wasIntentionalKill) {
    return 'intentional_kill'
  }
  if (isRustOomStderr(ctx.stderrTail)) {
    return 'rust_oom'
  }
  if (!ctx.managedChild || !ctx.dmlEnabled) {
    return 'unknown_or_cpu_crash'
  }
  const hasFatalCode = isFatalNativeExitCode(ctx.exitCode)
  const hasFatalSignal = typeof ctx.signal === 'string' && FATAL_NATIVE_SIGNALS.has(ctx.signal)
  if (hasFatalCode || hasFatalSignal) {
    return 'dml_native_crash'
  }
  return 'unknown_or_cpu_crash'
}

/** 判定本次崩溃是否应持久化 DirectML 崩溃标记。 */
export function shouldPersistDmlCrashMarker(ctx: OmniCrashContext): boolean {
  return classifyOmniCrash(ctx) === 'dml_native_crash'
}

/** 解析磁盘上的崩溃标记（同时兼容历史 `{ detectedAt }` 单字段格式）。 */
export function parseDmlCrashMarker(raw: string | null | undefined): DmlCrashMarker | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return null

    if (parsed.lastDetectedAt !== undefined) {
      const firstDetectedAt = Number(parsed.firstDetectedAt)
      const lastDetectedAt = Number(parsed.lastDetectedAt)
      const strikes = Number(parsed.strikes)
      const exitCode = Number(parsed.exitCode ?? 0)
      if (
        !Number.isFinite(firstDetectedAt) ||
        firstDetectedAt <= 0 ||
        !Number.isFinite(lastDetectedAt) ||
        lastDetectedAt <= 0 ||
        !Number.isFinite(strikes) ||
        strikes < 1 ||
        !Number.isFinite(exitCode)
      ) {
        return null
      }
      return {
        firstDetectedAt,
        lastDetectedAt,
        strikes: Math.floor(strikes),
        exitCode
      }
    }

    // 兼容历史单字段格式 `{ detectedAt }`
    const detectedAt = Number(parsed.detectedAt)
    if (!Number.isFinite(detectedAt) || detectedAt <= 0) return null
    return {
      firstDetectedAt: detectedAt,
      lastDetectedAt: detectedAt,
      strikes: 2,
      exitCode: 0
    }
  } catch {
    return null
  }
}

/**
 * 基于滑动窗口计算下一次落盘的崩溃标记：
 * - 若距上次崩溃 `<= 24h` 且未发生时钟回拨，沿用 `firstDetectedAt` 并递增 `strikes`；
 * - 若超过 24h 或无有效旧标记，自动清零 `strikes` 重置为首击（1）。
 */
export function computeNextDmlCrashMarker(
  prevRaw: string | null | undefined,
  now: number,
  exitCode: number
): DmlCrashMarker {
  const prev = parseDmlCrashMarker(prevRaw)
  if (prev) {
    const sinceLast = now - prev.lastDetectedAt
    if (sinceLast >= 0 && sinceLast <= DML_CRASH_STRIKE_WINDOW_MS) {
      return {
        firstDetectedAt: prev.firstDetectedAt,
        lastDetectedAt: now,
        strikes: prev.strikes + 1,
        exitCode
      }
    }
  }
  return {
    firstDetectedAt: now,
    lastDetectedAt: now,
    strikes: 1,
    exitCode
  }
}

/** 序列化崩溃标记（支持新结构体 DmlCrashMarker，并兼容旧单数字签名）。 */
export function serializeDmlCrashMarker(marker: DmlCrashMarker | number): string {
  if (typeof marker === 'number') {
    return JSON.stringify({
      firstDetectedAt: marker,
      lastDetectedAt: marker,
      strikes: 1,
      exitCode: 0
    })
  }
  return JSON.stringify({
    firstDetectedAt: marker.firstDetectedAt,
    lastDetectedAt: marker.lastDetectedAt,
    strikes: marker.strikes,
    exitCode: marker.exitCode
  })
}

/**
 * 从标记文件原文判定「本次启动是否应强制 CPU」：
 * - 空 / 损坏 / 无有效时间戳 / 时钟回拨 → false（不阻断 DirectML）；
 * - 统一按 `lastDetectedAt` 滑动窗口判定：
 *   - 距上次检测超过 24h → false（自动过期清零）；
 *   - 否则到期点为 `lastDetectedAt + (strikes >= 2 ? 24h : 30min)`（支持调用方显式覆写 ttlMs）。
 */
export function shouldForceCpuFromMarker(
  raw: string | null | undefined,
  now: number,
  ttlMs?: number
): boolean {
  const marker = parseDmlCrashMarker(raw)
  if (!marker) return false
  const age = now - marker.lastDetectedAt
  if (age < 0 || age > DML_CRASH_STRIKE_WINDOW_MS) {
    return false
  }
  const effectiveTtl =
    ttlMs ?? (marker.strikes >= 2 ? DML_CRASH_MARKER_TTL_MS : DML_CRASH_FIRST_STRIKE_TTL_MS)
  return age < effectiveTtl
}
