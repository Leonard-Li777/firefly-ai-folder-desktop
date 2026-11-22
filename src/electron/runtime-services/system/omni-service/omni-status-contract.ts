import * as path from 'node:path'
import { isPathEqual } from '@firefly/shared'

/**
 * Omni Rust 服务端 SSE 推送的状态事件载荷（与 Rust `OmniStatusEvent` camelCase 100% 对齐）
 */
export interface OmniStatusEvent {
  status: 'starting' | 'ok' | 'stopping' | 'error' | string
  pid: number
  instanceId: string
  revision: number
  port: number
  version: string
  profile: string
  mrlDimension: number
  userDataDir?: string | null
  masterDbPath?: string | null
  targetVectorsDir?: string | null
}

/**
 * Rust 子进程 `stdout` 输出的 `<1ms` 冷启动快路径帧：`FIREFLY_READY:{...}`
 */
export interface FireflyReadyFrame {
  port: number
  pid: number
  instanceId: string
}

export interface OmniOriginCandidate {
  port?: number | null
  pid?: number | null
  userDataDir?: string | null
  masterDbPath?: string | null
  targetVectorsDir?: string | null
}

export interface OmniOriginExpected {
  expectedPort?: number | null
  expectedPid?: number | null
  userDataDir?: string | null
  masterDbPath?: string | null
  targetVectorsDir?: string | null
}

export interface OmniOriginCheckResult {
  ok: boolean
  reason?: string
  warning?: string
}

const FIREFLY_READY_PREFIX = 'FIREFLY_READY:'

/**
 * 校验并解析 Rust `OmniStatusEvent` JSON 字符串
 */
export function parseOmniStatusEvent(raw: string): OmniStatusEvent | null {
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  if (typeof parsed.status !== 'string' || !parsed.status) return null
  if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
    return null
  }
  if (typeof parsed.instanceId !== 'string' || !parsed.instanceId) return null
  if (typeof parsed.revision !== 'number' || !Number.isInteger(parsed.revision) || parsed.revision < 0) {
    return null
  }
  if (
    typeof parsed.port !== 'number' ||
    !Number.isInteger(parsed.port) ||
    parsed.port < 1 ||
    parsed.port > 65535
  ) {
    return null
  }
  if (typeof parsed.version !== 'string') return null
  if (typeof parsed.profile !== 'string') return null
  if (typeof parsed.mrlDimension !== 'number' || !Number.isInteger(parsed.mrlDimension)) {
    return null
  }

  return {
    status: parsed.status,
    pid: parsed.pid,
    instanceId: parsed.instanceId,
    revision: parsed.revision,
    port: parsed.port,
    version: parsed.version,
    profile: parsed.profile,
    mrlDimension: parsed.mrlDimension,
    userDataDir: typeof parsed.userDataDir === 'string' ? parsed.userDataDir : null,
    masterDbPath: typeof parsed.masterDbPath === 'string' ? parsed.masterDbPath : null,
    targetVectorsDir: typeof parsed.targetVectorsDir === 'string' ? parsed.targetVectorsDir : null
  }
}

/**
 * 解析单行 stdout 中的 `FIREFLY_READY:{"port":...,"pid":...,"instanceId":"..."}`
 */
export function parseFireflyReadyLine(line: string): FireflyReadyFrame | null {
  const idx = line.indexOf(FIREFLY_READY_PREFIX)
  if (idx === -1) return null
  const jsonPart = line.slice(idx + FIREFLY_READY_PREFIX.length).trim()
  if (!jsonPart) return null
  try {
    const parsed = JSON.parse(jsonPart)
    if (!parsed || typeof parsed !== 'object') return null
    const port = parsed.port
    const pid = parsed.pid
    const instanceId = parsed.instanceId
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      return null
    }
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
      return null
    }
    if (typeof instanceId !== 'string' || !instanceId) {
      return null
    }
    return { port, pid, instanceId }
  } catch {
    return null
  }
}

function normalizeRelativeSegment(baseDir: string, targetPath: string): string | null {
  const rel = path.relative(baseDir, targetPath)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return null
  }
  return process.platform === 'win32'
    ? rel.replace(/\\/g, '/').toLowerCase()
    : rel.replace(/\\/g, '/')
}

function isSameBasename(a: string, b: string): boolean {
  const baseA = path.basename(a.replace(/[\\/]+$/, ''))
  const baseB = path.basename(b.replace(/[\\/]+$/, ''))
  if (!baseA || !baseB) return false
  return process.platform === 'win32'
    ? baseA.toLowerCase() === baseB.toLowerCase()
    : baseA === baseB
}

/**
 * 跨 Worktree 同源身份强制校验（防串库与 PID 复用）：
 * - 校验 port 与 pid（若指定预期值）；
 * - 校验 userDataDir、masterDbPath、targetVectorsDir 与本实例通过 isPathEqual 同源；
 * - 若绝对路径因跨盘符整体迁移失配，允许以 basename(userDataDir) + 相对子路径做二次校验并返回 warning。
 */
export function verifyOmniSameOrigin(
  candidate: OmniOriginCandidate,
  expected: OmniOriginExpected
): OmniOriginCheckResult {
  if (
    typeof expected.expectedPort === 'number' &&
    typeof candidate.port === 'number' &&
    candidate.port !== expected.expectedPort
  ) {
    return {
      ok: false,
      reason: `端口不匹配: expected=${expected.expectedPort}, actual=${candidate.port}`
    }
  }

  if (
    typeof expected.expectedPid === 'number' &&
    typeof candidate.pid === 'number' &&
    candidate.pid !== expected.expectedPid
  ) {
    return {
      ok: false,
      reason: `PID 不匹配: expected=${expected.expectedPid}, actual=${candidate.pid}`
    }
  }

  let migratedWarning: string | undefined

  if (expected.userDataDir && candidate.userDataDir) {
    if (!isPathEqual(candidate.userDataDir, expected.userDataDir)) {
      // 允许跨盘符目录整体迁移的二次校验：仅当 basename 相同且无相反证据时标记 warning
      if (isSameBasename(candidate.userDataDir, expected.userDataDir)) {
        migratedWarning = `userDataDir 绝对路径失配但目录名一致（疑似跨盘符迁移）: expected="${expected.userDataDir}", actual="${candidate.userDataDir}"`
      } else {
        return {
          ok: false,
          reason: `userDataDir 不同源: expected="${expected.userDataDir}", actual="${candidate.userDataDir}"`
        }
      }
    }
  }

  if (expected.targetVectorsDir) {
    if (!candidate.targetVectorsDir) {
      return {
        ok: false,
        reason: `候选实例未透出 targetVectorsDir，当前期望 "${expected.targetVectorsDir}"`
      }
    }
    if (!isPathEqual(candidate.targetVectorsDir, expected.targetVectorsDir)) {
      const canFallbackRelative =
        Boolean(migratedWarning) &&
        Boolean(expected.userDataDir) &&
        Boolean(candidate.userDataDir) &&
        normalizeRelativeSegment(expected.userDataDir!, expected.targetVectorsDir) !== null &&
        normalizeRelativeSegment(expected.userDataDir!, expected.targetVectorsDir) ===
          normalizeRelativeSegment(candidate.userDataDir!, candidate.targetVectorsDir)
      if (!canFallbackRelative) {
        return {
          ok: false,
          reason: `targetVectorsDir 不同源: expected="${expected.targetVectorsDir}", actual="${candidate.targetVectorsDir}"`
        }
      }
    }
  }

  if (expected.masterDbPath && candidate.masterDbPath) {
    if (!isPathEqual(candidate.masterDbPath, expected.masterDbPath)) {
      const canFallbackRelative =
        Boolean(migratedWarning) &&
        Boolean(expected.userDataDir) &&
        Boolean(candidate.userDataDir) &&
        normalizeRelativeSegment(expected.userDataDir!, expected.masterDbPath) !== null &&
        normalizeRelativeSegment(expected.userDataDir!, expected.masterDbPath) ===
          normalizeRelativeSegment(candidate.userDataDir!, candidate.masterDbPath)
      if (!canFallbackRelative) {
        return {
          ok: false,
          reason: `masterDbPath 不同源: expected="${expected.masterDbPath}", actual="${candidate.masterDbPath}"`
        }
      }
    }
  }

  return migratedWarning ? { ok: true, warning: migratedWarning } : { ok: true }
}
