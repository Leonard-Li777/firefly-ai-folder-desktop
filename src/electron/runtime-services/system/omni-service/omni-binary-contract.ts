/**
 * firefly-omni 二进制 CLI 契约预检（Binary Contract Gate）
 *
 * 背景（2026-11-26 事故形态）：安装包与开发集成目录可能残留旧版 `firefly-omni`
 * （v0.1.8 的 `serve` 只认 `-a/--addr`），而宿主已按 v0.1.9 契约下发
 * `--db-path / --pack-path / --vectors-path`。旧构件在 clap 解析阶段直接以退出码 2 自杀，
 * 宿主只能看到「子进程在就绪前退出」，随后重试多达 10 次并静默放弃；
 * 用户侧表现为检索式引擎整体不可用且日志里只有 `unexpected argument '--db-path' found`。
 *
 * 因此在 spawn 之前先以只读方式执行一次 `serve --help`，把「二进制是否支持宿主必需选项」
 * 变成确定性前置判定：
 * - `compatible`：放行启动；
 * - `incompatible`：明确报错并进入冷却，绝不再靠拉起试错；
 * - `probe_failed`：探针本身无法执行（权限/杀软/测试桩），不阻断，但由调用方显式记录原因。
 *
 * 全部为纯函数 + 一个可注入执行器的探针，便于单测。
 */

import * as childProcess from 'node:child_process'

/** 宿主拉起 `serve` 时依赖的 CLI 引导选项（缺即判定构件过旧/错版，严禁放行） */
export const REQUIRED_SERVE_OPTIONS = ['--bootstrap'] as const

/** 探针帮助文本保留上限（仅用于诊断与缓存，防止超大输出常驻内存） */
const HELP_TEXT_MAX_CHARS = 4_000

export type ServeContractStatus = 'compatible' | 'incompatible' | 'probe_failed'

export interface ServeContractProbeResult {
  status: ServeContractStatus
  /** 已裁剪的帮助文本（用于展示实际支持的用法） */
  helpText: string
  /** 缺失的必需选项（status = incompatible 时非空） */
  missingOptions: string[]
  /** 探针无法执行的原因（status = probe_failed 时非空） */
  probeError: string | null
}

/**
 * 从单行帮助文本中提取选项名，只接受「行首就是选项定义」的形态。
 *
 * clap 长帮助（`serve --help`）中每行形如：
 *   `  -a, --addr <ADDR>`
 *   `      --db-path <DB_PATH>`
 *   `      --embedding-profile <EMBEDDING_PROFILE>`
 * 短帮助会把说明与 `[default: ...]` 挤在同一行：
 *   `  -h, --help         Print help`
 *
 * 关键：描述行（如「向量存储目录 vectors/ 路径（缺省时自动对齐 --db-path 父目录下的 vectors/）」）
 * 并不以 `--flag` 开头，因此绝不会把描述文本误判成能力位。
 */
function extractOptionName(rawLine: string): string | null {
  let rest = rawLine.trim()
  const shortPrefix = /^-[A-Za-z0-9],\s+/.exec(rest)
  if (shortPrefix) {
    rest = rest.slice(shortPrefix[0].length)
  }
  const flagMatch = /^(--[a-z0-9][a-z0-9-]*)/.exec(rest)
  if (!flagMatch) return null
  const flag = flagMatch[1]
  let tail = rest.slice(flag.length)
  // 可选取值占位符 <VAL>
  const valueMatch = /^\s+<[^>]+>/.exec(tail)
  if (valueMatch) {
    tail = tail.slice(valueMatch[0].length)
  }
  // 余下内容只可是空白，或以两列以上空白起始的行内说明
  if (tail.trim() === '') return flag
  if (/^[ \t]{2,}/.test(tail)) return flag
  return null
}

/** 裁剪帮助文本，防止超大输出常驻内存 */
function limitHelpText(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > HELP_TEXT_MAX_CHARS ? trimmed.slice(0, HELP_TEXT_MAX_CHARS) : trimmed
}

/** 解析 `serve --help` 输出中全部选项定义（去重，保持出现顺序） */
export function parseServeHelpOptions(helpText: string): string[] {
  if (!helpText) return []
  const options: string[] = []
  const seen = new Set<string>()
  for (const rawLine of helpText.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const option = extractOptionName(line)
    if (!option || seen.has(option)) continue
    seen.add(option)
    options.push(option)
  }
  return options
}

/** 计算缺失的必需选项（空数组表示契约满足） */
export function collectMissingServeOptions(
  helpText: string,
  required: readonly string[] = REQUIRED_SERVE_OPTIONS
): string[] {
  const supported = new Set(parseServeHelpOptions(helpText))
  return required.filter(option => !supported.has(option))
}

/** 组装面向用户与日志的确定性诊断（大白话优先，技术细节随后） */
export function buildServeContractMismatchDetail(params: {
  exePath: string
  missingOptions: readonly string[]
  helpText: string
}): string {
  const usageLine =
    params.helpText
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(line => line.startsWith('Usage:')) ?? 'Usage: （组件没有任何用法输出）'
  return [
    '检索式引擎组件版本过旧，引擎未启动（已阻止无效重启）',
    '',
    `组件路径：${params.exePath}`,
    `缺失的启动参数：${params.missingOptions.join('、')}`,
    `组件实际支持的用法：${usageLine}`,
    '',
    '处理方式：',
    '1. 开发环境：运行 pnpm omni:deploy（重新编译并把新二进制同步到集成目录）；',
    '2. 安装版：重新安装或修复安装本应用，使随包组件与程序版本一致。',
    '',
    '本应用不会自动下载该组件；组件更新完成后约 1 分钟内自动恢复。'
  ].join('\n')
}

interface ServeHelpExecResult {
  stdout: string
  stderr: string
}

/** 默认执行器：只读执行 `<exe> serve --help`（绝不抛出以外的副作用） */
function runServeHelp(exePath: string, timeoutMs: number): Promise<ServeHelpExecResult> {
  return new Promise<ServeHelpExecResult>((resolve, reject) => {
    const execFileFn = (childProcess as { execFile?: typeof childProcess.execFile }).execFile
    if (typeof execFileFn !== 'function') {
      reject(new Error('execFile 不可用（受限运行环境或测试桩）'))
      return
    }
    execFileFn(
      exePath,
      ['serve', '--help'],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => {
        if (err) {
          // 把部分输出挂在错误对象上，供上层按内容判定（clap 对异常组合可能以非零码退出）
          const enriched = err as Error & { stdout?: string; stderr?: string }
          enriched.stdout = typeof stdout === 'string' ? stdout : String(stdout ?? '')
          enriched.stderr = typeof stderr === 'string' ? stderr : String(stderr ?? '')
          reject(enriched)
          return
        }
        resolve({
          stdout: typeof stdout === 'string' ? stdout : String(stdout ?? ''),
          stderr: typeof stderr === 'string' ? stderr : String(stderr ?? '')
        })
      }
    )
  })
}

/**
 * 探针入口：判定目标二进制是否满足宿主 CLI 契约。
 *
 * @param deps.run 可注入执行器（单测用），缺省走真实 `serve --help`
 */
export async function probeServeContract(
  exePath: string,
  deps: { timeoutMs?: number; run?: (exePath: string) => Promise<ServeHelpExecResult> } = {}
): Promise<ServeContractProbeResult> {
  const timeoutMs = deps.timeoutMs ?? 3_000
  const run = deps.run ?? ((target: string) => runServeHelp(target, timeoutMs))
  try {
    const result = await run(exePath)
    const helpText = limitHelpText(`${result.stdout}\n${result.stderr}`)
    if (!helpText) {
      return { status: 'probe_failed', helpText: '', missingOptions: [], probeError: '探针未返回任何用法输出' }
    }
    const missingOptions = collectMissingServeOptions(helpText)
    if (missingOptions.length > 0) {
      return { status: 'incompatible', helpText, missingOptions, probeError: null }
    }
    return { status: 'compatible', helpText, missingOptions: [], probeError: null }
  } catch (err: unknown) {
    const enriched = err as Error & { stdout?: string; stderr?: string }
    const helpText = limitHelpText(`${enriched?.stdout ?? ''}\n${enriched?.stderr ?? ''}`)
    const missingOptions = helpText ? collectMissingServeOptions(helpText) : []
    if (missingOptions.length > 0) {
      // 非零退出但输出了完整用法 ⇒ 仍可确定性判定为旧构件
      return { status: 'incompatible', helpText, missingOptions, probeError: null }
    }
    return {
      status: 'probe_failed',
      helpText,
      missingOptions: [],
      probeError: enriched?.message || String(err)
    }
  }
}

/**
 * 契约结论缓存：以「路径 + 二进制签名(mtime:size)」为键，二进制被覆盖后自动失效。
 * 仅保存少量候选（多候选路径检索 + 热更新重启），超限按插入顺序淘汰最旧项。
 */
export class ServeContractCache {
  private readonly entries = new Map<string, ServeContractProbeResult>()

  constructor(private readonly maxEntries: number = 8) {}

  get(key: string): ServeContractProbeResult | undefined {
    return this.entries.get(key)
  }

  /** 清空缓存（二进制被替换、或单测间隔离状态时使用） */
  clear(): void {
    this.entries.clear()
  }

  set(key: string, result: ServeContractProbeResult): void {
    if (this.entries.has(key)) {
      this.entries.delete(key)
    }
    this.entries.set(key, result)
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }
}
