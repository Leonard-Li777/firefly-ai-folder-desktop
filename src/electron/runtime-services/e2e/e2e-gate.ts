/**
 * E2E 沙箱门卫 (Ticket 01 §4.4/4.5)
 *
 * 职责：
 * 1. 单一收敛读取所有 FF_* 环境变量（`getE2EConfig` 单例）；
 * 2. 提供 `E2ERuntimeRoots` 接口与 `RuntimePathResolver` 类供全局沙箱路径解析；
 * 3. `assertE2ESandboxOrThrow` 执行完整路径守卫，严禁 E2E 模式在正式包或生产数据目录下运行；
 * 4. `FF_E2E_TOKEN` 仅在内存中持有，严禁传递给渲染进程、插件子进程或日志。
 *
 * @doc-anchor: docs/specs/desktop-full-flow-e2e-testing-spec.md#44-e2eruntimeroots-全局副作用隔离与垃圾箱沙箱
 * @doc-anchor: docs/specs/desktop-full-flow-e2e-testing-spec.md#45-e2e-环境注入契约与构建期物理剥离-packaging--dce-guard
 */

import fs from 'node:fs'
import path, { dirname, isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import crypto from 'node:crypto'
import { app } from 'electron'
import { isSubPath, isPathEqual } from '@firefly/shared'

// ---------------------------------------------------------------------------
// 错误类型
// ---------------------------------------------------------------------------

/**
 * E2E 专属错误，携带数字退出码（1~5）供上层 `process.exit` 使用：
 * - 1: 初始化失败
 * - 2: 用例注册违规
 * - 3: 路径安全守卫违规（严重，应立即终止）
 * - 4: 运行时路径解析前未初始化
 * - 5: 恢复决策降级（manual_recovery）
 */
export class DesktopE2EError extends Error {
  public readonly exitCode: 1 | 2 | 3 | 4 | 5

  constructor(exitCode: 1 | 2 | 3 | 4 | 5, message: string) {
    super(message)
    this.exitCode = exitCode
    this.name = 'DesktopE2EError'
  }
}

// ---------------------------------------------------------------------------
// E2ERuntimeRoots 接口与垃圾箱沙箱
// ---------------------------------------------------------------------------

/**
 * 全局沙箱根路径集合（Spec §4.4）
 * root = `${os.tmpdir()}/firefly-e2e-${runId}`
 */
export interface E2ERuntimeRoots {
  /** 本次测试运行唯一 ID */
  runId: string
  /** 沙箱根目录：os.tmpdir()/firefly-e2e-${runId} */
  root: string
  /** 沙箱 SQLite 数据库路径 */
  dbPath: string
  /** 沙箱用户数据目录（隔离 Electron app.getPath('userData')） */
  userDataDir: string
  /** 沙箱插件目录 */
  pluginDir: string
  /** 沙箱向量索引目录 */
  zvecIndexDir: string
  /** 沙箱缓存目录 */
  cacheDir: string
  /** 沙箱导出目录 */
  exportDir: string
  /** 沙箱日志目录 */
  logDir: string
  /** 专用沙箱 .trash 目录，严禁调用真实 shell.trashItem */
  trashDir: string
}

/**
 * 垃圾箱端口抽象（Spec §4.4）
 * E2E 模式下将文件移入沙箱 trashDir，严禁调用系统级 shell.trashItem
 */
export interface TrashPort {
  trash(filePath: string): Promise<string>
}

/**
 * 全局沙箱路径解析器（Spec §4.4）
 * 必须先调用 `initialize` 注入根路径，再通过 `resolve` 获取各作用域路径。
 */
export class RuntimePathResolver {
  private static roots: E2ERuntimeRoots | null = null

  static initialize(roots: E2ERuntimeRoots): void {
    RuntimePathResolver.roots = roots
  }

  static resolve(scope: keyof Omit<E2ERuntimeRoots, 'runId' | 'root'>): string {
    if (!RuntimePathResolver.roots) {
      throw new DesktopE2EError(
        4,
        'E2ERuntimeRoots 未初始化，请先调用 RuntimePathResolver.initialize()'
      )
    }
    return RuntimePathResolver.roots[scope]
  }
}

// ---------------------------------------------------------------------------
// E2EConfig 单例（唯一收敛读取所有 FF_* 环境变量）
// ---------------------------------------------------------------------------

/**
 * E2E 运行时配置（由 `getE2EConfig()` 解析，不可外部直接构造）
 */
export interface E2EConfig {
  /** 是否处于 E2E 测试模式 */
  isE2EMode: boolean
  /** 沙箱 DB 路径（优先 FF_DB_PATH，兼容 FIREFLY_DB_PATH） */
  dbPath: string
  /** Supabase 模式（E2E 模式下必须为 'mock'） */
  supabaseMode: string
  /** 会话级安全令牌（32 字节高熵随机，仅内存持有，严禁传入渲染进程/日志） */
  token: Buffer | null
  /** 测试失败时是否保留沙箱现场 */
  keepSandboxOnFail: boolean
  /** teardown 优雅等待毫秒数（默认 3000ms） */
  teardownGraceMs: number
}

let _e2eConfigCache: E2EConfig | null = null

/**
 * 获取 E2E 配置单例（Spec §4.5 规则 1）
 *
 * 所有 FF_* 环境变量读取必须 100% 经由此函数，
 * 业务运行时代码严禁分散读取 process.env.FF_*。
 */
export function getE2EConfig(): E2EConfig {
  if (_e2eConfigCache) return _e2eConfigCache

  const env = process.env
  const isE2EMode = env.FF_E2E_MODE === '1'

  // FF_E2E_TOKEN：解析为 Buffer，严禁 toString() 传出（Spec §4.5 规则 2/3）
  let token: Buffer | null = null
  if (isE2EMode && env.FF_E2E_TOKEN) {
    try {
      // Token 以 hex 字符串形式注入，decode 为 Buffer 后只做 timingSafeEqual 比较
      const decoded = Buffer.from(env.FF_E2E_TOKEN, 'hex')
      if (decoded.length === 32) {
        token = decoded
      }
    } catch {
      // 格式不合法时保持 null，会在 verifyToken 中被拒绝
    }
  }

  _e2eConfigCache = {
    isE2EMode,
    dbPath: env.FF_DB_PATH || env.FIREFLY_DB_PATH || '',
    supabaseMode: env.FF_SUPABASE_MODE || '',
    token,
    keepSandboxOnFail: env.FF_E2E_KEEP_SANDBOX_ON_FAIL === '1',
    teardownGraceMs: parseInt(env.FF_E2E_TEARDOWN_GRACE_MS || '3000', 10)
  }

  return _e2eConfigCache
}

/**
 * 判断当前是否处于 E2E 测试模式
 */
export function isE2EMode(): boolean {
  return getE2EConfig().isE2EMode
}

/**
 * 对外暴露的 Token 常量时间验证（Spec §4.5 规则 2）
 * 验证失败时严禁抛出错误内容泄露 token 值，直接返回 false。
 *
 * @param candidate 外部传入的候选 token hex 字符串
 */
export function verifyE2EToken(candidate: string): boolean {
  const cfg = getE2EConfig()
  if (!cfg.isE2EMode || !cfg.token) return false
  try {
    const candidateBuf = Buffer.from(candidate, 'hex')
    if (candidateBuf.length !== 32 || cfg.token.length !== 32) return false
    return crypto.timingSafeEqual(cfg.token, candidateBuf)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 路径守卫（Spec §4.5 assertE2ESandboxOrThrow 完整实现）
// ---------------------------------------------------------------------------

/**
 * 对可能尚不存在的文件路径执行 realpath 解析（消除 Windows 8.3 短路径及 .. 穿越）：
 * - 若路径自身存在，直接 realpathSync；
 * - 逐级向上递归查找第一个真实存在的祖先目录（直至盘符根目录），并执行 realpathSync；
 * - 若最终无法解析，安全回退到 path.resolve(targetPath)。
 */
function canonicalizeExistingParent(targetPath: string): string {
  const resolved = path.resolve(targetPath)
  let curr = resolved
  const segments: string[] = []
  while (true) {
    try {
      const canonicalAncestor = fs.realpathSync(curr)
      return segments.length > 0 ? join(canonicalAncestor, ...segments) : canonicalAncestor
    } catch {
      const parent = dirname(curr)
      if (parent === curr) break // 到达根目录仍不存在
      segments.unshift(path.basename(curr))
      curr = parent
    }
  }
  return resolved
}

/**
 * 重置配置缓存（仅供单元测试隔离使用）
 */
export function _resetE2EConfigForTesting(): void {
  _e2eConfigCache = null
}

/**
 * E2E 沙箱路径安全守卫（Spec §4.5）
 *
 * 在主进程启动阶段调用，严禁 E2E 模式在以下场景执行：
 * 1. 正式生产打包（app.isPackaged && !__FF_E2E__）
 * 2. FF_SUPABASE_MODE 不为 'mock'
 * 3. 沙箱 DB 路径为空或非绝对路径
 * 4. 沙箱 DB 路径等于 os.tmpdir() 根目录自身
 * 5. 沙箱 DB 路径不在 os.tmpdir() 子路径内
 * 6. 沙箱 DB 路径落入真实 appData 用户/生产数据目录
 *
 * 非 E2E 模式（FF_E2E_MODE !== '1'）时立即返回，不做任何检查。
 */
export function assertE2ESandboxOrThrow(env: NodeJS.ProcessEnv = process.env): void {
  if (env.FF_E2E_MODE !== '1') return

  // 规则 1：正式生产包严禁开启 E2E 模式（兼容非打包宏注入的测试环境防护）
  const isE2EBuild = typeof __FF_E2E__ !== 'undefined' ? Boolean(__FF_E2E__) : false
  if (app.isPackaged && !isE2EBuild) {
    throw new DesktopE2EError(3, '[E2E 致命错误] 正式生产发布包严禁开启 FF_E2E_MODE')
  }

  const fail = (msg: string): never => {
    throw new DesktopE2EError(3, `[E2E 致命错误] ${msg}`)
  }

  // 规则 2：Supabase 必须为 mock
  if (env.FF_SUPABASE_MODE !== 'mock') {
    fail('FF_SUPABASE_MODE 必须为 mock，严禁 E2E 模式访问真实 Supabase 服务')
  }

  // 规则 3：DB 路径非空且绝对路径
  const dbPath = env.FF_DB_PATH || env.FIREFLY_DB_PATH || ''
  if (!dbPath || !isAbsolute(dbPath)) {
    fail('FF_DB_PATH / FIREFLY_DB_PATH 必须为非空绝对路径')
  }

  const resolvedDbPath = canonicalizeExistingParent(dbPath)
  const resolvedTmpRoot = canonicalizeExistingParent(tmpdir())
  const resolvedAppData = canonicalizeExistingParent(app.getPath('appData'))

  // 规则 4：DB 路径严禁等于 tmpdir 根目录自身
  if (isPathEqual(resolvedTmpRoot, resolvedDbPath)) {
    fail('沙箱 DB 路径严禁等于 os.tmpdir() 根目录自身')
  }

  // 规则 5：DB 路径必须严格位于 tmpdir 子路径内
  if (!isSubPath(resolvedTmpRoot, resolvedDbPath)) {
    fail(`沙箱 DB 路径必须严格位于 os.tmpdir() 沙箱子路径内: ${resolvedDbPath}`)
  }

  // 规则 6：独立防御真实 appData 目录（规避 userData 被 E2ERuntimeRoots 重定向后的漏检）
  // 仅当 appData 本身不在 tmpdir 内时（正常情况），才检查 dbPath 是否落入 appData
  if (!isSubPath(resolvedTmpRoot, resolvedAppData) && isSubPath(resolvedAppData, resolvedDbPath)) {
    fail('沙箱 DB 路径严禁落入真实 appData 用户/生产数据目录')
  }
}

// ---------------------------------------------------------------------------
// 模块级全局声明（由 Vite define 注入，TypeScript 仅需声明避免类型错误）
// ---------------------------------------------------------------------------
declare const __FF_E2E__: boolean
