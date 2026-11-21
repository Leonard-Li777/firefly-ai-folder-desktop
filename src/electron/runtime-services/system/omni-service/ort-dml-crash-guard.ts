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

/** 标记有效期：过期后允许重新尝试 DirectML（避免永久降级到 CPU）。 */
export const DML_CRASH_MARKER_TTL_MS = 24 * 60 * 60 * 1000

/** 判定子进程退出码是否为原生崩溃（非正常退出）。类型谓词：命中后调用方可收窄为 number。 */
export function isFatalNativeExitCode(code: number | null | undefined): code is number {
  if (typeof code !== 'number' || !Number.isFinite(code)) return false
  return FATAL_NATIVE_EXIT_CODES.has(code >>> 0)
}

/** 序列化崩溃标记（只记录检测时间）。 */
export function serializeDmlCrashMarker(now: number): string {
  return JSON.stringify({ detectedAt: now })
}

/**
 * 从标记文件原文判定「本次启动是否应强制 CPU」：
 * - 空 / 损坏 / 无有效时间戳 → false（不阻断 DirectML）；
 * - 合法且在 TTL 内 → true；
 * - 已过期或时钟回拨 → false（重新尝试 DirectML）。
 */
export function shouldForceCpuFromMarker(
  raw: string | null | undefined,
  now: number,
  ttlMs: number = DML_CRASH_MARKER_TTL_MS
): boolean {
  if (!raw) return false
  try {
    const parsed = JSON.parse(raw) as { detectedAt?: unknown }
    const detectedAt = Number(parsed?.detectedAt)
    if (!Number.isFinite(detectedAt) || detectedAt <= 0) return false
    const age = now - detectedAt
    return age >= 0 && age < ttlMs
  } catch {
    return false
  }
}
