/**
 * 同步 I/O 插桩层（`infra/fs/instrument.ts`，工单 IO-02）
 *
 * 定位：
 * - dev / harness **专用**能力，用于统计「存量直连」的同步调用（不只覆盖走 `infra/fs` 的新代码）。
 *   生产构建不加载本模块（入口侧只允许在 dev 分支动态导入），本模块自身再做一道 `NODE_ENV` 门禁兜底。
 * - 统计口径：调用点键取 `new Error().stack` 的**首个业务帧**（`file:line`），每个调用点累计
 *   `count` / `totalMs`；计时区间**不含取栈开销**（取栈之后才起表）。
 * - 延迟注入：同步调用以 `Atomics.wait` + 忙等补齐（Windows 定时器粒度 15.6ms 会把 5ms 量化成整节拍，
 *   故按节拍选择粗睡/忙等，保证注入时长误差可控）、异步调用用 `setTimeout` 延后（M0 默认 5ms/次），
 *   用于模拟网络盘；**注入不改变任何被包裹方法的返回值与错误对象**（INV-2）。
 *
 * 生效边界（必须知晓，否则会误判为漏统计）：
 * - monkey-patch 的是 `node:fs` / `node:child_process` 的**模块导出对象属性**，因此只对
 *   「调用时按属性取用」的形态生效——CJS 产物（`require('fs').existsSync(...)`，以及
 *   `import { existsSync } from 'fs'` 经 esbuild/tsc 编译后的 `fs_1.existsSync(...)`）天然满足。
 * - 原生 ESM 的静态命名绑定是**快照**，不受 patch 影响（Node 语义决定，非本层缺陷）；
 *   harness 跑在 CJS 主进程产物上，不受此限。
 * - 插桩自身任何异常都不得中断业务：patch 失败会 `logger.warn` 并回滚为「完全不插桩」，禁止静默降级。
 *
 * 与 `sync-allowlist.ts` 的边界：本模块只负责「观测」，不判断某调用点是否被豁免；豁免判定属于
 * ratchet 门禁（ticket 05）与 `sync-allowlist.ts`。本层调用点键保持**原生路径分隔符**，
 * 不做分隔符归一化（归一化只允许出现在登记表匹配层，见路径规范红线）。
 *
 * **导入纪律**：调用方必须直接按子路径 `import { ... } from '<electron>/infra/fs/instrument'` 导入，
 * **严禁**把本模块挂到 `infra/fs/index.ts` 的聚合导出上——一旦进入业务依赖图，生产构建就会把这个
 * dev-only 插桩层一起打包（ticket 02 验收要求「生产产物检索不到 instrument 导出与 patch 调用」）。
 */
import * as nodeChildProcess from 'node:child_process'
import * as nodeFs from 'node:fs'
import { performance } from 'node:perf_hooks'

/** 被插桩方法所属模块（`fs.promises` 单列，便于区分同步/异步通道） */
export type InstrumentedModule = 'fs' | 'fs.promises' | 'child_process'

/** 缺省注入延迟（M0 口径：5ms/次模拟网络盘）；纯计数场景显式传 `delayMs: 0` */
export const DEFAULT_INJECTED_DELAY_MS = 5

/** 无法解析到业务帧时的调用点键（不伪造 `file:line`，避免排行脚本把垃圾键当热点） */
export const UNATTRIBUTED_CALL_SITE = '<unattributed>'

/**
 * 日志通道。
 *
 * 缺省回落到 `console.warn`（带固定前缀）：本层可能被主进程**最早期**调用，刻意不 import
 * `@firefly/shared` 以免把重量级依赖拉进入口首批模块图；入口可注入既有 logger 实例。
 */
export interface SyncIoLoggerLike {
  warn(message: string, error?: unknown): void
}

/** 插桩参数 */
export interface SyncIoInstrumentationOptions {
  /** 注入延迟毫秒数（同步 `Atomics.wait` / 异步 `setTimeout`）；0 = 只计数不注入 */
  delayMs?: number
  /** 是否统计同步 `*Sync` 调用（默认 true） */
  countSync?: boolean
  /** 是否统计异步被包裹调用（默认 false；为 true 时额外承担取栈开销） */
  countAsync?: boolean
  /** 日志通道（缺省 `console.warn`） */
  logger?: SyncIoLoggerLike
  /** 强制启用，跳过 `NODE_ENV=production` 门禁（仅供 harness 显式声明） */
  force?: boolean
  /**
   * 仅单测 / 特种 harness 使用的目标覆盖：默认插桩真实的 `node:fs` 与 `node:child_process`。
   * 传自定义目标时只插桩传入对象，便于验证「patch 失败回滚」等失败路径。
   */
  targets?: Array<{ target: Record<string, unknown>; module: InstrumentedModule; label: string }>
}

/** 单个方法的聚合样本 */
export interface SyncIoMethodTotal {
  module: InstrumentedModule
  method: string
  count: number
  totalMs: number
  maxMs: number
}

/** 单个调用点（`file:line`）的聚合样本 */
export interface SyncIoCallSiteSample {
  callSite: string
  count: number
  totalMs: number
  totalCallMs: number
  maxMs: number
  methods: SyncIoMethodTotal[]
}

/** 导出给 harness / 排行脚本消费的结构化结果（JSON 友好） */
export interface SyncIoReport {
  version: 1
  generatedAt: string
  pid: number
  enabled: boolean
  delayMs: number
  countSync: boolean
  countAsync: boolean
  instrumentationDisabledReason: string | null
  totals: {
    count: number
    totalMs: number
    totalCallMs: number
    maxMs: number
    distinctCallSites: number
  }
  byModule: Record<string, { count: number; totalMs: number; totalCallMs: number; maxMs: number }>
  callSites: SyncIoCallSiteSample[]
}

/** 插桩运行状态（供入口与 harness 显式判定，避免「以为开了其实没开」） */
export interface SyncIoInstrumentationStatus {
  enabled: boolean
  delayMs: number
  countSync: boolean
  countAsync: boolean
  patchedMethodCount: number
  disabledReason: string | null
}

interface ResolvedOptions {
  delayMs: number
  countSync: boolean
  countAsync: boolean
  logger: SyncIoLoggerLike
  targets: Array<{ target: Record<string, unknown>; module: InstrumentedModule; label: string }>
}

interface PatchRecord {
  target: Record<string, unknown>
  property: string
  descriptor: PropertyDescriptor
  label: string
}

interface MethodAccumulator {
  count: number
  totalMs: number
  totalCallMs: number
  maxMs: number
}

interface CallSiteAccumulator {
  callSite: string
  count: number
  totalMs: number
  totalCallMs: number
  maxMs: number
  methods: Map<string, MethodAccumulator>
}

const METHOD_KEY_SEPARATOR = '::'
const LOG_PREFIX = '[sync-io-instrument]'

/** 模块自身文件名标记：取栈时必须剔除，否则每个调用点都会归属到插桩层自己 */
const SELF_FILE_MARKERS = [
  '/infra/fs/instrument.ts',
  '\\infra\\fs\\instrument.ts',
  '/infra/fs/instrument.js',
  '\\infra\\fs\\instrument.js'
]

/** 归一到仓库内相对路径的锚点（多 worktree 的绝对路径前缀各不相同，靠该片段抹掉差异） */
const REPO_ANCHORS = ['apps/desktop/', 'apps\\desktop\\']

/** 异步回调式中「返回句柄/流、注入延迟只会改变事件时序」的构造类方法不参与延迟注入 */
const ASYNC_CALLBACK_EXCLUDED_PREFIXES = ['create', 'watch', 'unwatch']

/** 真实 `fs` 的异步回调 API 里不参与插桩的非 I/O 名称 */
const ASYNC_CALLBACK_EXCLUDED_NAMES = new Set(['promises', 'constants', 'Stats', 'Dirent'])

const callSites = new Map<string, CallSiteAccumulator>()
let totalCount = 0
let totalMs = 0
let totalCallMs = 0
let maxTotalMs = 0
let patches: PatchRecord[] = []
/** 嵌套函数（如 `fs.realpathSync.native`）的插桩标签：挂在包裹函数上，回滚随包裹函数一起消失 */
let nestedPatchLabels: string[] = []
let activeOptions: ResolvedOptions | null = null
let disabledReason: string | null = null

/**
 * 取内置模块的**真实导出对象**。
 *
 * 关键差异：CJS 产物里 `import * as fs from 'node:fs'` 编译成 `require('node:fs')`，拿到的就是可 patch
 * 的模块对象；而原生 ESM（单测运行时）里同一句拿到的是**冻结的命名空间对象**，其上属性
 * 不可重定义（`Cannot redefine property: accessSync`）。因此优先 `process.getBuiltinModule`
 * （Node ≥22.3 / Electron 45 提供，返回与 `require` 同一个对象，可 patch），失败再回落到静态导入，
 * 保证「CJS 产物（harness 与主进程）必然可 patch」这条主路径不受影响。
 */
function resolveBuiltinModule(
  moduleName: 'fs' | 'child_process',
  fallback: typeof nodeFs | typeof nodeChildProcess
): Record<string, unknown> {
  const getBuiltinModule = (
    process as unknown as { getBuiltinModule?: (id: string) => unknown }
  ).getBuiltinModule
  if (typeof getBuiltinModule === 'function') {
    try {
      const builtin = getBuiltinModule(moduleName)
      if (builtin && typeof builtin === 'object') return builtin as Record<string, unknown>
    } catch {
      // 老运行时不支持该入口：回落静态导入（CJS 产物下即模块导出对象）
    }
  }
  return fallback as unknown as Record<string, unknown>
}

/** `node:fs` 的真实模块导出对象（patch / 报告写入的唯一寻址对象） */
const fsModule = resolveBuiltinModule('fs', nodeFs)
/** `node:child_process` 的真实模块导出对象 */
const childProcessModule = resolveBuiltinModule('child_process', nodeChildProcess)

/**
 * 原生 `writeFileSync` 快照：导出报告时**不能**再走被 patch 过的 `fs`（否则报告写入自身会被计数）。
 * 模块求值期（patch 之前）取一次即可。
 */
const rawWriteFileSync = fsModule.writeFileSync as typeof nodeFs.writeFileSync

/** `Atomics.wait` 复用同一块 4 字节共享内存，避免每次注入都新建缓冲 */
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4))

/**
 * Windows 系统定时器粒度（15.6ms）实测阈值。
 *
 * 实测事实（Windows / Node 22）：`Atomics.wait(5)` 实际阻塞 **15.7ms**、`Atomics.wait(10)` 为 15.3ms，
 * 即小于一个时钟节拍的等待会被量化成整节拍；若直接照字面「5ms 用 Atomics.wait」，验收口径
 * 「totalMs ≈ count × 注入延迟，误差 < 5%」必然失败（误差 > 200%）。
 * 因此采用「粗睡 + 忙等补齐」：延迟 ≥ 一个节拍时先用 Atomics.wait 让出 CPU 粗睡，剩余时间
 * （含量化误差）用忙等补齐；小于一个节拍时直接忙等。注入时长精度由此稳定在 0.2ms 级。
 */
const SLEEP_QUANTUM_MS = 16

/** 忙等到指定绝对时刻（`performance.now()` 时间轴），用于补齐注入延迟的剩余部分 */
function spinUntil(deadlineAt: number): void {
  while (performance.now() < deadlineAt) {
    // 空转补齐：注入延迟的精度优先于这段 CPU 占用（仅 dev / harness 生效）
  }
}

/**
 * 同步阻塞指定毫秒数（模拟网络盘）。
 *
 * 精确度优先：先按 `SLEEP_QUANTUM_MS` 判断能否用 `Atomics.wait` 粗睡（≥ 一个节拍才用，避免被量化成
 * 整节拍），再用忙等把总时长补齐到目标值。该实现不改变被调用方法的任何语义。
 */
function sleepSync(delayMs: number): void {
  if (delayMs <= 0) return
  const startedAt = performance.now()
  const deadlineAt = startedAt + delayMs
  if (delayMs >= SLEEP_QUANTUM_MS) {
    try {
      Atomics.wait(SLEEP_BUFFER, 0, 0, delayMs - SLEEP_QUANTUM_MS)
    } catch {
      // 运行时不支持行内共享内存：直接落到忙等补齐
    }
  }
  spinUntil(deadlineAt)
}

const STACK_FRAME_RE = /^\s*at\s+(?:(.*?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/

interface ParsedStackFrame {
  file: string
  line: number
}

/** 解析单行栈帧；解析失败返回 null（不猜） */
function parseStackFrame(line: string): ParsedStackFrame | null {
  const match = STACK_FRAME_RE.exec(line)
  if (!match) return null
  return { file: match[2], line: Number(match[3]) }
}

/**
 * 剔除「非业务帧」：Node 内部帧、Electron js2c、第三方依赖（含 vitest / vite-node 等测试运行时）、
 * 以及插桩层自身。
 *
 * 依赖目录一律不算业务帧：`vite-node` 在测试里会同步读源码映射，若不剔除会让「调用点排行」被
 * 测试运行时的噪声占满（实测 `execSync` 用例即被 `vite-node/dist/source-map.mjs` 抢占归属）。
 */
function isBusinessFrame(file: string): boolean {
  if (!file) return false
  if (file.startsWith('<') || file === 'native') return false
  if (file.startsWith('node:')) return false
  const lower = file.toLowerCase()
  if (lower.includes('electron/js2c')) return false
  if (lower.includes('/node_modules/') || lower.includes('\\node_modules\\')) return false
  return !SELF_FILE_MARKERS.some(marker => file.includes(marker))
}

/** 抹掉栈里的加载器路径痕迹并尽量切成仓库内相对路径（仅用于展示/排行键，不参与路径比较） */
function normalizeCallSiteFile(file: string): string {
  let candidate = file.trim()
  if (candidate.startsWith('file://')) candidate = candidate.slice('file://'.length)
  if (candidate.startsWith('/@fs/')) candidate = candidate.slice('/@fs/'.length)
  // 栈帧里的路径可能带百分号编码（目录名含空格时呈现为 `%20`），还原成可读路径
  if (candidate.includes('%')) {
    try {
      candidate = decodeURIComponent(candidate)
    } catch {
      // 非法编码保持原样，不影响归属正确性
    }
  }
  // `file:///D:/x` 去掉 `file://` 后残留前导斜杠，Windows 盘符路径还原为 `D:/x`
  if (/^\/[A-Za-z]:\//.test(candidate)) candidate = candidate.slice(1)
  let anchorIndex = -1
  for (const anchor of REPO_ANCHORS) {
    const index = candidate.indexOf(anchor)
    if (index >= 0 && (anchorIndex < 0 || index < anchorIndex)) anchorIndex = index
  }
  return anchorIndex > 0 ? candidate.slice(anchorIndex) : candidate
}

/**
 * 取调用点键：`file:line`。
 *
 * `boundary` 传包裹函数本身——`Error.captureStackTrace(holder, boundary)` 会剔除 boundary 及
 * 其之上（更靠近调用点）的所有帧，因此首个幸存帧就是真实业务调用方。取栈失败不抛错：
 * 退化为 `UNATTRIBUTED_CALL_SITE`，仍计入耗时统计（观测缺失不得变成业务中断）。
 */
function captureCallSite(boundary: Function): string {
  try {
    const holder: { stack?: string } = {}
    Error.captureStackTrace(holder, boundary)
    const stack = holder.stack
    if (!stack) return UNATTRIBUTED_CALL_SITE
    const lines = stack.split('\n')
    for (let index = 1; index < lines.length; index += 1) {
      const frame = parseStackFrame(lines[index])
      if (!frame) continue
      if (!isBusinessFrame(frame.file)) continue
      return `${normalizeCallSiteFile(frame.file)}:${frame.line}`
    }
    return UNATTRIBUTED_CALL_SITE
  } catch {
    return UNATTRIBUTED_CALL_SITE
  }
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000
}

/**
 * 记录一次调用。
 *
 * `totalSpanMs` 是「含注入延迟」的观测跨度（验收口径要求 `totalMs ≈ count × 注入延迟`）；
 * 扣掉 `injectedDelayMs` 得到 `totalCallMs`（真实调用耗时）。两者同时保留：
 * 排行看 `totalMs`（阻塞事件循环的真实代价），核对插桩精度看 `totalCallMs`。
 */
function recordCall(
  moduleName: InstrumentedModule,
  method: string,
  callSite: string,
  totalSpanMs: number,
  injectedDelayMs: number
): void {
  const span = totalSpanMs > 0 ? totalSpanMs : 0
  const callMs = injectedDelayMs > 0 ? Math.max(0, span - injectedDelayMs) : span

  let site = callSites.get(callSite)
  if (!site) {
    site = { callSite, count: 0, totalMs: 0, totalCallMs: 0, maxMs: 0, methods: new Map() }
    callSites.set(callSite, site)
  }
  const methodKey = `${moduleName}${METHOD_KEY_SEPARATOR}${method}`
  let methodAcc = site.methods.get(methodKey)
  if (!methodAcc) {
    methodAcc = { count: 0, totalMs: 0, totalCallMs: 0, maxMs: 0 }
    site.methods.set(methodKey, methodAcc)
  }

  site.count += 1
  site.totalMs += span
  site.totalCallMs += callMs
  site.maxMs = Math.max(site.maxMs, span)
  methodAcc.count += 1
  methodAcc.totalMs += span
  methodAcc.totalCallMs += callMs
  methodAcc.maxMs = Math.max(methodAcc.maxMs, span)

  totalCount += 1
  totalMs += span
  totalCallMs += callMs
  maxTotalMs = Math.max(maxTotalMs, span)
}

/** 重置累计统计（保留插桩状态；harness 逐场景采样时使用） */
export function resetSyncIoStats(): void {
  callSites.clear()
  totalCount = 0
  totalMs = 0
  totalCallMs = 0
  maxTotalMs = 0
}

function resolveOptions(options: SyncIoInstrumentationOptions): ResolvedOptions {
  return {
    delayMs: Math.max(0, options.delayMs ?? DEFAULT_INJECTED_DELAY_MS),
    countSync: options.countSync ?? true,
    countAsync: options.countAsync ?? false,
    logger: options.logger ?? {
      warn: (message: string, error?: unknown) => {
        console.warn(message, error)
      }
    },
    targets: options.targets ?? [
      { target: fsModule, module: 'fs', label: 'fs' },
      { target: childProcessModule, module: 'child_process', label: 'child_process' }
    ]
  }
}

/**
 * 环境门禁。
 *
 * 优先级：显式 `force` ➔ `FF_SYNC_IO_INSTRUMENT=1/0` ➔ `NODE_ENV === 'production'`。
 * 生产构建禁止加载本模块（入口侧约束），本门禁是第二道兜底，防止误把插桩带进生产。
 */
function evaluateEnvironmentGate(force: boolean): { allowed: boolean; reason: string | null } {
  if (force) return { allowed: true, reason: null }
  const explicit = process.env.FF_SYNC_IO_INSTRUMENT
  if (explicit === '0') return { allowed: false, reason: 'env-disabled' }
  if (explicit === '1') return { allowed: true, reason: null }
  if (process.env.NODE_ENV === 'production') return { allowed: false, reason: 'production-build' }
  return { allowed: true, reason: null }
}

function definePatch(
  target: Record<string, unknown>,
  property: string,
  descriptor: PropertyDescriptor,
  wrapper: Function,
  label: string,
  collected: PatchRecord[]
): void {
  Object.defineProperty(target, property, {
    value: wrapper,
    writable: true,
    enumerable: descriptor.enumerable ?? true,
    configurable: true
  })
  collected.push({ target, property, descriptor, label })
}

/**
 * 包裹同步方法：取栈（不计时）→ 注入延迟 → 调用原方法。
 * 返回值与抛出的错误对象原样透传，`finally` 只做记录（INV-2：错误语义等价）。
 */
function createSyncWrapper(
  moduleName: InstrumentedModule,
  methodLabel: string,
  original: Function,
  options: ResolvedOptions
): Function {
  const wrapper = function syncIoWrapper(this: unknown, ...args: unknown[]): unknown {
    let callSite = UNATTRIBUTED_CALL_SITE
    let startedAt = performance.now()
    if (options.countSync) {
      callSite = captureCallSite(syncIoWrapper)
      // 取栈开销不计入耗时：取栈之后再起表
      startedAt = performance.now()
    }
    if (options.delayMs > 0) sleepSync(options.delayMs)
    try {
      return Reflect.apply(original, this, args)
    } finally {
      if (options.countSync) {
        const endedAt = performance.now()
        recordCall(moduleName, methodLabel, callSite, endedAt - startedAt, options.delayMs)
      }
    }
  }
  return wrapper
}

/**
 * 给包裹函数补上原函数自带的嵌套函数属性（如 `fs.realpathSync.native`）。
 *
 * 只装饰**包裹函数**、绝不改动原函数对象：`fs.realpathSync.native(...)` 取到的是包裹函数上的
 * `native`，而原函数的 `native` 保持原样，回滚时把模块属性还原为原函数即可彻底还原。
 */
function decorateNestedSyncFunctions(
  wrapper: Function,
  original: Function,
  moduleName: InstrumentedModule,
  methodLabel: string,
  options: ResolvedOptions
): void {
  for (const nestedName of Object.getOwnPropertyNames(original)) {
    if (nestedName === 'length' || nestedName === 'name' || nestedName === 'prototype') continue
    const nested = (original as unknown as Record<string, unknown>)[nestedName]
    if (typeof nested !== 'function') continue
    const nestedWrapper = createSyncWrapper(
      moduleName,
      `${methodLabel}.${nestedName}`,
      nested as Function,
      options
    )
    Object.defineProperty(wrapper, nestedName, {
      value: nestedWrapper,
      writable: true,
      enumerable: false,
      configurable: true
    })
    nestedPatchLabels.push(`${moduleName}.${methodLabel}.${nestedName}`)
  }
}

/** 包裹模块导出对象上的全部 `*Sync` 方法 */
function patchSyncMethods(
  target: Record<string, unknown>,
  moduleName: InstrumentedModule,
  options: ResolvedOptions,
  collected: PatchRecord[]
): void {
  for (const property of Object.getOwnPropertyNames(target)) {
    if (!property.endsWith('Sync')) continue
    const descriptor = Object.getOwnPropertyDescriptor(target, property)
    if (!descriptor || typeof descriptor.value !== 'function') continue
    const original = descriptor.value as Function
    const wrapper = createSyncWrapper(moduleName, property, original, options)
    decorateNestedSyncFunctions(wrapper, original, moduleName, property, options)
    definePatch(target, property, descriptor, wrapper, `${moduleName}.${property}`, collected)
  }
}

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

/** 在 Promise 落定后再等 `delayMs`，值与错误对象原样透传（错误语义等价） */
function delayPromise(promise: Promise<unknown>, delayMs: number): Promise<unknown> {
  return promise.then(
    value =>
      new Promise(resolve => {
        setTimeout(() => resolve(value), delayMs)
      }),
    error =>
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(error), delayMs)
      })
  )
}

/**
 * 包裹 `fs.promises` 全部方法：只在 `delayMs > 0 || countAsync` 时启用。
 *
 * 返回 Promise 的方法在落定后注入延迟；返回非 Promise 的（理论上不存在）原样返回，
 * 不对形态不符的返回值做任何包装，避免把「非承诺返回值」变成 Promise。
 */
function patchPromiseMethods(options: ResolvedOptions, collected: PatchRecord[]): void {
  const promisesApi = fsModule.promises as Record<string, unknown> | undefined
  if (!promisesApi) return

  for (const property of Object.getOwnPropertyNames(promisesApi)) {
    if (property === 'constructor') continue
    const descriptor = Object.getOwnPropertyDescriptor(promisesApi, property)
    if (!descriptor || typeof descriptor.value !== 'function') continue
    const original = descriptor.value as Function

    const wrapper = function promiseIoWrapper(this: unknown, ...args: unknown[]): unknown {
      let callSite = UNATTRIBUTED_CALL_SITE
      let startedAt = performance.now()
      if (options.countAsync) {
        callSite = captureCallSite(promiseIoWrapper)
        startedAt = performance.now()
      }
      let result: unknown
      try {
        result = Reflect.apply(original, this, args)
      } catch (error) {
        if (options.countAsync) {
          recordCall('fs.promises', property, callSite, performance.now() - startedAt, 0)
        }
        throw error
      }
      if (!isThenable(result)) return result

      const delayed = options.delayMs > 0 ? delayPromise(result, options.delayMs) : result
      if (!options.countAsync) return delayed

      return delayed.then(
        value => {
          recordCall(
            'fs.promises',
            property,
            callSite,
            performance.now() - startedAt,
            options.delayMs
          )
          return value
        },
        error => {
          recordCall(
            'fs.promises',
            property,
            callSite,
            performance.now() - startedAt,
            options.delayMs
          )
          throw error
        }
      )
    }
    definePatch(promisesApi, property, descriptor, wrapper, `fs.promises.${property}`, collected)
  }
}

/** 回调式异步 API 是否参与插桩（排除返回句柄/流的构造类方法与非 I/O 成员） */
function shouldInstrumentCallbackApi(name: string): boolean {
  if (name.endsWith('Sync')) return false
  if (ASYNC_CALLBACK_EXCLUDED_NAMES.has(name)) return false
  return !ASYNC_CALLBACK_EXCLUDED_PREFIXES.some(prefix => name.startsWith(prefix))
}

/**
 * 包裹 `fs` 的回调式异步 API：只处理「最后一个参数是函数」的调用形态。
 *
 * 延迟注入放在**回调触发之前**（`setTimeout`），原方法的返回值（通常为 `undefined`）原样返回；
 * 回调收到的参数与错误对象不做改写。`create*` / `watch*` 这类返回句柄/流的方法不参与，
 * 因为延后它们的回调改变的是事件时序而非「单次 I/O 延迟」，会污染 harness 口径。
 */
function patchCallbackMethods(options: ResolvedOptions, collected: PatchRecord[]): void {
  const fsTarget = fsModule
  for (const property of Object.getOwnPropertyNames(fsTarget)) {
    if (!shouldInstrumentCallbackApi(property)) continue
    const descriptor = Object.getOwnPropertyDescriptor(fsTarget, property)
    if (!descriptor || typeof descriptor.value !== 'function') continue
    const original = descriptor.value as Function

    const wrapper = function callbackIoWrapper(this: unknown, ...args: unknown[]): unknown {
      const delayMs = options.delayMs
      const lastIndex = args.length - 1
      const callback = lastIndex >= 0 ? args[lastIndex] : undefined
      const hasCallback = typeof callback === 'function'
      let callSite = UNATTRIBUTED_CALL_SITE
      let startedAt = performance.now()
      if (options.countAsync && hasCallback) {
        callSite = captureCallSite(callbackIoWrapper)
        startedAt = performance.now()
      }

      if (hasCallback) {
        const originalCallback = callback as Function
        args[lastIndex] = function instrumentedFanoutCallback(
          this: unknown,
          ...callbackArgs: unknown[]
        ): void {
          if (options.countAsync) {
            // 回调触发时操作已完成；注入延迟发生在回调之后，故 span 需补上 delayMs 才是「含注入」总耗时
            const operationSpanMs = performance.now() - startedAt
            recordCall('fs', property, callSite, operationSpanMs + delayMs, delayMs)
          }
          if (delayMs > 0) {
            setTimeout(() => Reflect.apply(originalCallback, undefined, callbackArgs), delayMs)
            return
          }
          Reflect.apply(originalCallback, undefined, callbackArgs)
        }
      }

      try {
        return Reflect.apply(original, this, args)
      } catch (error) {
        if (options.countAsync && hasCallback) {
          recordCall('fs', property, callSite, performance.now() - startedAt, 0)
        }
        throw error
      }
    }
    definePatch(fsTarget, property, descriptor, wrapper, `fs.${property}`, collected)
  }
}

function restorePatches(records: PatchRecord[]): void {
  for (const record of records) {
    try {
      Object.defineProperty(record.target, record.property, record.descriptor)
    } catch (error) {
      // 还原失败必须可见（否则会留下半插桩状态），但仍不中断业务
      console.warn(`${LOG_PREFIX} 还原原生方法失败: ${record.label}`, error)
    }
  }
}

/**
 * 启用插桩。
 *
 * 顺序：环境门禁 ➔ 逐方法 patch（失败即全量回滚）➔ 记录状态。
 * 返回 `false` 表示**未插桩**（生产门禁或 patch 失败），调用方须据此判定，不得假定已生效。
 */
export function enableSyncIoInstrumentation(
  options: SyncIoInstrumentationOptions = {}
): boolean {
  const resolved = resolveOptions(options)
  const gate = evaluateEnvironmentGate(options.force === true)
  if (!gate.allowed) {
    disabledReason = gate.reason
    return false
  }

  // 重复启用按新参数重建（统计累计不清零，便于同一场景内调整参数）
  if (activeOptions) {
    const previousDelay = activeOptions.delayMs
    disableSyncIoInstrumentation({ preserveReason: true })
    resolved.delayMs = Math.max(0, options.delayMs ?? previousDelay)
  }

  const collected: PatchRecord[] = []
  const isRealFsTarget = resolved.targets.some(
    targetSpec => targetSpec.module === 'fs' && targetSpec.label === 'fs'
  )
  try {
    for (const targetSpec of resolved.targets) {
      patchSyncMethods(targetSpec.target, targetSpec.module, resolved, collected)
    }
    if (resolved.delayMs > 0 || resolved.countAsync) {
      patchPromiseMethods(resolved, collected)
      // 回调式异步 API 只存在于真实 `fs` 目标上；自定义目标不做猜测
      if (isRealFsTarget) patchCallbackMethods(resolved, collected)
    }
    if (collected.length === 0) {
      throw new Error('未匹配到任何可插桩的方法（fs / child_process 的 *Sync 均为空）')
    }
  } catch (error) {
    // 半途失败必须整体回滚，否则会留下「部分方法被包、部分没包」的不可解释统计
    restorePatches(collected)
    nestedPatchLabels = []
    activeOptions = null
    patches = []
    disabledReason = `patch-failed: ${(error as Error)?.message ?? String(error)}`
    resolved.logger.warn(
      `${LOG_PREFIX} 插桩失败，已回滚为不插桩（业务逻辑不受影响）: ${disabledReason}`,
      error
    )
    return false
  }

  patches = collected
  activeOptions = resolved
  disabledReason = null
  return true
}

/**
 * 停用插桩并还原全部原生方法。
 *
 * 还原后 `fs.existsSync === 原生函数`（身份级还原），因此 dev 关闭插桩时**零额外开销**。
 * 默认保留已采集统计（停注入后仍可导出本轮报告）；需要清零请显式调用 `resetSyncIoStats()`。
 */
export function disableSyncIoInstrumentation(
  options: { resetStats?: boolean; preserveReason?: boolean } = {}
): void {
  restorePatches(patches)
  patches = []
  nestedPatchLabels = []
  activeOptions = null
  if (!options.preserveReason) disabledReason = null
  if (options.resetStats) resetSyncIoStats()
}

/** 当前是否处于已插桩状态 */
export function isSyncIoInstrumentationEnabled(): boolean {
  return activeOptions !== null
}

/** 已插桩方法清单（形如 `fs.existsSync`、`fs.realpathSync.native`、`child_process.execSync`） */
export function listInstrumentedMethods(): string[] {
  return [...patches.map(record => record.label), ...nestedPatchLabels].sort()
}

/** 插桩状态快照（含未启用原因，便于入口显式上报） */
export function getSyncIoInstrumentationStatus(): SyncIoInstrumentationStatus {
  return {
    enabled: activeOptions !== null,
    delayMs: activeOptions?.delayMs ?? 0,
    countSync: activeOptions?.countSync ?? false,
    countAsync: activeOptions?.countAsync ?? false,
    patchedMethodCount: patches.length + nestedPatchLabels.length,
    disabledReason
  }
}

function toCallSiteSample(accumulator: CallSiteAccumulator): SyncIoCallSiteSample {
  const methods: SyncIoMethodTotal[] = []
  for (const [methodKey, methodAcc] of accumulator.methods) {
    const separatorIndex = methodKey.lastIndexOf(METHOD_KEY_SEPARATOR)
    methods.push({
      module: methodKey.slice(0, separatorIndex) as InstrumentedModule,
      method: methodKey.slice(separatorIndex + METHOD_KEY_SEPARATOR.length),
      count: methodAcc.count,
      totalMs: roundMs(methodAcc.totalMs),
      maxMs: roundMs(methodAcc.maxMs)
    })
  }
  methods.sort((left, right) => right.totalMs - left.totalMs)
  return {
    callSite: accumulator.callSite,
    count: accumulator.count,
    totalMs: roundMs(accumulator.totalMs),
    totalCallMs: roundMs(accumulator.totalCallMs),
    maxMs: roundMs(accumulator.maxMs),
    methods
  }
}

/** 读取某调用点的累计样本（未命中返回 undefined；harness 单点核对用） */
export function getSyncIoCallSiteSample(callSite: string): SyncIoCallSiteSample | undefined {
  const accumulator = callSites.get(callSite)
  return accumulator ? toCallSiteSample(accumulator) : undefined
}

/** 构建结构化报告（调用点按 `totalMs` 降序，直接可做排行） */
export function buildSyncIoReport(): SyncIoReport {
  const moduleTotals = new Map<
    string,
    { count: number; totalMs: number; totalCallMs: number; maxMs: number }
  >()
  const samples: SyncIoCallSiteSample[] = []

  for (const accumulator of callSites.values()) {
    samples.push(toCallSiteSample(accumulator))
    for (const [methodKey, methodAcc] of accumulator.methods) {
      const separatorIndex = methodKey.lastIndexOf(METHOD_KEY_SEPARATOR)
      const moduleName = methodKey.slice(0, separatorIndex)
      const moduleTotal = moduleTotals.get(moduleName) ?? {
        count: 0,
        totalMs: 0,
        totalCallMs: 0,
        maxMs: 0
      }
      moduleTotal.count += methodAcc.count
      moduleTotal.totalMs += methodAcc.totalMs
      moduleTotal.totalCallMs += methodAcc.totalCallMs
      moduleTotal.maxMs = Math.max(moduleTotal.maxMs, methodAcc.maxMs)
      moduleTotals.set(moduleName, moduleTotal)
    }
  }

  samples.sort((left, right) =>
    right.totalMs === left.totalMs ? right.count - left.count : right.totalMs - left.totalMs
  )

  const byModule: Record<
    string,
    { count: number; totalMs: number; totalCallMs: number; maxMs: number }
  > = {}
  for (const [moduleName, moduleTotal] of moduleTotals) {
    byModule[moduleName] = {
      count: moduleTotal.count,
      totalMs: roundMs(moduleTotal.totalMs),
      totalCallMs: roundMs(moduleTotal.totalCallMs),
      maxMs: roundMs(moduleTotal.maxMs)
    }
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    pid: process.pid,
    enabled: activeOptions !== null,
    delayMs: activeOptions?.delayMs ?? 0,
    countSync: activeOptions?.countSync ?? false,
    countAsync: activeOptions?.countAsync ?? false,
    instrumentationDisabledReason: disabledReason,
    totals: {
      count: totalCount,
      totalMs: roundMs(totalMs),
      totalCallMs: roundMs(totalCallMs),
      maxMs: roundMs(maxTotalMs),
      distinctCallSites: callSites.size
    },
    byModule,
    callSites: samples
  }
}

/** 报告转 JSON 字符串（harness 直接落盘或经 stdout 传给采集端） */
export function exportSyncIoReportToJson(report: SyncIoReport = buildSyncIoReport()): string {
  return `${JSON.stringify(report, null, 2)}\n`
}

/**
 * 把报告写成 JSON 文件。
 *
 * 走模块求值期快照的原生 `writeFileSync`，避免「写报告」这个动作本身被插桩计数（否则排行里
 * 会凭空出现一条插桩层自己的调用点）。
 */
export function writeSyncIoReportToFile(
  filePath: string,
  report: SyncIoReport = buildSyncIoReport()
): void {
  rawWriteFileSync(filePath, exportSyncIoReportToJson(report), 'utf8')
}

/** 生成人类可读的调用点排行（M0 热点排行的人工速览；结构化消费请用 `buildSyncIoReport`） */
export function formatSyncIoRanking(report: SyncIoReport = buildSyncIoReport(), limit = 20): string {
  const lines: string[] = []
  lines.push(
    `同步 I/O 排行（count=${report.totals.count}，totalMs=${report.totals.totalMs.toFixed(1)}，` +
      `delayMs=${report.delayMs}，调用点=${report.totals.distinctCallSites}）`
  )
  const top = report.callSites.slice(0, Math.max(0, limit))
  top.forEach((sample, index) => {
    const methods = sample.methods
      .map(method => `${method.module}.${method.method}×${method.count}`)
      .slice(0, 3)
      .join('、')
    lines.push(
      `${String(index + 1).padStart(2, ' ')}. ${sample.totalMs.toFixed(1)}ms ` +
        `(${sample.count} 次，max ${sample.maxMs.toFixed(1)}ms) ${sample.callSite}` +
        (methods ? ` 〔${methods}〕` : '')
    )
  })
  return lines.join('\n')
}
