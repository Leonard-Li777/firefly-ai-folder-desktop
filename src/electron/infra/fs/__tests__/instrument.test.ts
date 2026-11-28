import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_INJECTED_DELAY_MS,
  buildSyncIoReport,
  disableSyncIoInstrumentation,
  enableSyncIoInstrumentation,
  exportSyncIoReportToJson,
  formatSyncIoRanking,
  getSyncIoInstrumentationStatus,
  isSyncIoInstrumentationEnabled,
  listInstrumentedMethods,
  resetSyncIoStats,
  writeSyncIoReportToFile
} from '../instrument'

/**
 * 测试口径说明：
 * - 本文件用 `createRequire` 取 `node:fs` / `node:child_process` 的**模块导出对象**，再在调用时按属性取用，
 *   这与 CJS 产物（`require('fs').existsSync(...)`、`import { existsSync } from 'fs'` 编译后的
 *   `fs_1.existsSync(...)`）完全同构；原生 ESM 静态绑定是快照、不受 patch 影响，无法用于本用例。
 * - 用例自身搭夹具一律走 ESM 快照导入（`writeFileSync` 等），不会污染被测调用点的统计。
 */
const requireNode = createRequire(import.meta.url)

interface LoggerSpy {
  warnings: string[]
  warn: (message: string, error?: unknown) => void
}

function createLoggerSpy(): LoggerSpy {
  const warnings: string[] = []
  return {
    warnings,
    warn: (message: string) => {
      warnings.push(message)
    }
  }
}

function requireFs(): typeof import('node:fs') {
  return requireNode('node:fs') as typeof import('node:fs')
}

function requireChildProcess(): typeof import('node:child_process') {
  return requireNode('node:child_process') as typeof import('node:child_process')
}

function captureThrow(action: () => unknown): { name: string; code?: string; message: string } {
  try {
    action()
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    return { name: err.name, code: err.code, message: err.message }
  }
  throw new Error('预期抛错但没有抛出')
}

let workDir = ''
let logger: LoggerSpy

beforeEach(() => {
  disableSyncIoInstrumentation({ resetStats: true, preserveReason: true })
  resetSyncIoStats()
  workDir = mkdtempSync(join(tmpdir(), 'ff-sync-io-instrument-'))
  logger = createLoggerSpy()
})

afterEach(() => {
  disableSyncIoInstrumentation({ resetStats: true, preserveReason: true })
  rmSync(workDir, { recursive: true, force: true })
})

describe('插桩生效范围', () => {
  it('默认注入延迟为 5ms（M0 口径），*Sync 与 child_process 全量被包裹', () => {
    expect(DEFAULT_INJECTED_DELAY_MS).toBe(5)
    expect(enableSyncIoInstrumentation({ delayMs: 0, logger })).toBe(true)

    const methods = listInstrumentedMethods()
    expect(methods).toContain('fs.existsSync')
    expect(methods).toContain('fs.statSync')
    expect(methods).toContain('fs.readdirSync')
    expect(methods).toContain('fs.realpathSync.native')
    expect(methods).toContain('child_process.execSync')
    expect(methods).toContain('child_process.spawnSync')
    expect(isSyncIoInstrumentationEnabled()).toBe(true)
  })

  it('三种调用形态均被计数（fs 属性取用 / 具名解构 / child_process.execSync）', () => {
    const fixture = join(workDir, 'payload.txt')
    const missing = join(workDir, 'missing.txt')
    writeFileSync(fixture, 'payload', 'utf8')

    const fsApi = requireFs()
    const childProcessApi = requireChildProcess()
    expect(enableSyncIoInstrumentation({ delayMs: 0, countSync: true, logger })).toBe(true)

    // ① `import * as fs` 的 CJS 等价形态：调用时按属性取用
    expect(fsApi.existsSync(fixture)).toBe(true)
    // ② 具名导入的 CJS 等价形态：解构发生在 patch 之后
    const { existsSync } = fsApi
    expect(existsSync(missing)).toBe(false)
    // ③ child_process 同步方法
    const stdout = childProcessApi.execSync('node --version', { encoding: 'utf8' })
    expect(stdout.trim().startsWith('v')).toBe(true)

    const report = buildSyncIoReport()
    expect(report.byModule.fs?.count).toBeGreaterThanOrEqual(2)
    expect(report.byModule.child_process?.count).toBeGreaterThanOrEqual(1)

    const methodLabels = report.callSites.flatMap(site =>
      site.methods.map(method => `${method.module}.${method.method}`)
    )
    expect(methodLabels).toContain('fs.existsSync')
    expect(methodLabels).toContain('child_process.execSync')

    // 归属必须是业务帧 `file:line`：本测试文件自身的调用必须被归属到 `instrument.test.ts:<行号>`
    const callSites = report.callSites.map(site => site.callSite)
    expect(callSites.length).toBeGreaterThan(0)
    expect(callSites.some(callSite => /instrument\.test\.ts:\d+$/.test(callSite))).toBe(true)
    for (const callSite of callSites) {
      // 严禁落回插桩层自身或第三方依赖帧；无业务帧时只允许显式 <unattributed>
      expect(callSite).not.toMatch(/infra\/fs\/instrument/)
      expect(callSite).not.toMatch(/node_modules/)
    }
  })

  it('repeat enable 不清空已有统计（同一场景内改参数不丢数据）', () => {
    const fixture = join(workDir, 'again.txt')
    writeFileSync(fixture, 'x', 'utf8')
    const fsApi = requireFs()

    expect(enableSyncIoInstrumentation({ delayMs: 0, logger })).toBe(true)
    fsApi.existsSync(fixture)
    expect(buildSyncIoReport().totals.count).toBe(1)

    expect(enableSyncIoInstrumentation({ delayMs: 0, logger })).toBe(true)
    fsApi.existsSync(fixture)
    expect(buildSyncIoReport().totals.count).toBe(2)
  })
})

describe('耗时统计精度', () => {
  it('totalMs 与人为注入 N×count 的误差 < 5%', () => {
    const fixture = join(workDir, 'timed.txt')
    writeFileSync(fixture, 'x', 'utf8')
    const fsApi = requireFs()

    const delayMs = 10
    const count = 25
    expect(enableSyncIoInstrumentation({ delayMs, countSync: true, logger })).toBe(true)
    resetSyncIoStats()

    for (let index = 0; index < count; index += 1) {
      fsApi.existsSync(fixture)
    }

    const report = buildSyncIoReport()
    const expectedTotalMs = delayMs * count
    expect(report.totals.count).toBe(count)
    expect(Math.abs(report.totals.totalMs - expectedTotalMs) / expectedTotalMs).toBeLessThan(0.05)
    // 真实调用耗时远小于注入延迟：totalCallMs 单独可读，排行核对时不至于把注入延迟当业务耗时
    expect(report.totals.totalCallMs).toBeLessThan(expectedTotalMs / 10)
  })

  it('调用点按 totalMs 降序（排行可直接消费）', () => {
    const fixture = join(workDir, 'rank.txt')
    writeFileSync(fixture, 'x', 'utf8')
    const fsApi = requireFs()

    expect(enableSyncIoInstrumentation({ delayMs: 0, logger })).toBe(true)
    fsApi.existsSync(join(workDir, 'absent-a.txt'))
    for (let index = 0; index < 5; index += 1) {
      fsApi.existsSync(fixture)
    }

    const report = buildSyncIoReport()
    const totals = report.callSites.map(site => site.totalMs)
    const sorted = [...totals].sort((left, right) => right - left)
    expect(totals).toEqual(sorted)
    expect(report.callSites[0].count).toBeGreaterThanOrEqual(5)
  })
})

describe('延迟注入不改变语义（INV-2）', () => {
  it('同步返回值与抛错对象在注入前后完全一致', () => {
    const fixture = join(workDir, 'semantics.txt')
    const missing = join(workDir, 'absent.txt')
    writeFileSync(fixture, 'hello', 'utf8')
    const fsApi = requireFs()

    const baseline = {
      hit: fsApi.existsSync(fixture),
      miss: fsApi.existsSync(missing),
      content: fsApi.readFileSync(fixture, 'utf8'),
      error: captureThrow(() => fsApi.readFileSync(missing, 'utf8'))
    }

    expect(enableSyncIoInstrumentation({ delayMs: 5, countSync: true, logger })).toBe(true)

    const instrumented = {
      hit: fsApi.existsSync(fixture),
      miss: fsApi.existsSync(missing),
      content: fsApi.readFileSync(fixture, 'utf8'),
      error: captureThrow(() => fsApi.readFileSync(missing, 'utf8'))
    }

    expect(instrumented.hit).toBe(baseline.hit)
    expect(instrumented.miss).toBe(baseline.miss)
    expect(instrumented.content).toBe(baseline.content)
    expect(instrumented.error.name).toBe(baseline.error.name)
    expect(instrumented.error.code).toBe(baseline.error.code)
    expect(instrumented.error.message).toBe(baseline.error.message)
  })

  it('child_process 返回值与编码行为在注入前后一致', () => {
    const childProcessApi = requireChildProcess()
    const baseline = childProcessApi.execSync('node --version', { encoding: 'utf8' }).trim()
    expect(enableSyncIoInstrumentation({ delayMs: 5, logger })).toBe(true)
    const instrumented = childProcessApi.execSync('node --version', { encoding: 'utf8' }).trim()
    expect(instrumented).toBe(baseline)
  })

  it('fs.promises 异步延迟注入后值与错误仍原样透传', async () => {
    const fixture = join(workDir, 'async.txt')
    const missing = join(workDir, 'async-missing.txt')
    writeFileSync(fixture, 'async-payload', 'utf8')
    const fsApi = requireFs()

    const baseline = await fsApi.promises.readFile(fixture, 'utf8')
    expect(enableSyncIoInstrumentation({ delayMs: 5, countAsync: true, logger })).toBe(true)

    await expect(fsApi.promises.readFile(fixture, 'utf8')).resolves.toBe(baseline)
    await expect(fsApi.promises.readFile(missing, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    const report = buildSyncIoReport()
    expect(report.byModule['fs.promises']?.count).toBeGreaterThanOrEqual(2)
  })

  it('回调式异步 API 延迟注入只在回调触发前生效，返回类型不变', async () => {
    const fixture = join(workDir, 'callback.txt')
    writeFileSync(fixture, 'callback-payload', 'utf8')
    const fsApi = requireFs()

    expect(enableSyncIoInstrumentation({ delayMs: 5, countAsync: true, logger })).toBe(true)

    const result = await new Promise<{ error: NodeJS.ErrnoException | null; data: string }>(
      resolve => {
        const returnValue = fsApi.readFile(fixture, 'utf8', (error, data) => {
          resolve({ error, data: String(data) })
        })
        // 回调式 API 的返回值语义不能被包装成 Promise / 句柄
        expect(returnValue).toBeUndefined()
      }
    )

    expect(result.error).toBeNull()
    expect(result.data).toBe('callback-payload')
    expect(buildSyncIoReport().byModule.fs?.count).toBeGreaterThanOrEqual(1)
  })
})

describe('停用与降级', () => {
  it('停用后身份级还原原生方法（dev 关闭插桩零额外开销）', () => {
    const fsApi = requireFs()
    const childProcessApi = requireChildProcess()
    const nativeExists = fsApi.existsSync
    const nativeExec = childProcessApi.execSync

    expect(enableSyncIoInstrumentation({ delayMs: 0, logger })).toBe(true)
    expect(fsApi.existsSync).not.toBe(nativeExists)
    expect(childProcessApi.execSync).not.toBe(nativeExec)

    disableSyncIoInstrumentation()

    expect(fsApi.existsSync).toBe(nativeExists)
    expect(childProcessApi.execSync).toBe(nativeExec)
    expect(isSyncIoInstrumentationEnabled()).toBe(false)
  })

  it('停用后不再累计统计（还原即零开销）', () => {
    const fsApi = requireFs()
    expect(enableSyncIoInstrumentation({ delayMs: 0, logger })).toBe(true)
    fsApi.existsSync(workDir)
    const beforeDisable = buildSyncIoReport().totals.count

    disableSyncIoInstrumentation()
    for (let index = 0; index < 3; index += 1) {
      fsApi.existsSync(workDir)
    }

    expect(buildSyncIoReport().totals.count).toBe(beforeDisable)
  })

  it('patch 失败必须 warn 并回滚为不插桩（禁止静默降级）', () => {
    let defined = false
    const fakeTarget = new Proxy(
      { existsSync: () => true } as Record<string, unknown>,
      {
        defineProperty() {
          defined = true
          throw new Error('模拟 defineProperty 拒绝')
        }
      }
    )

    const ok = enableSyncIoInstrumentation({
      delayMs: 0,
      logger,
      targets: [{ target: fakeTarget, module: 'fs', label: 'fake-fs' }]
    })

    expect(defined).toBe(true)
    expect(ok).toBe(false)
    expect(logger.warnings).toHaveLength(1)
    expect(logger.warnings[0]).toContain('插桩失败')

    const status = getSyncIoInstrumentationStatus()
    expect(status.enabled).toBe(false)
    expect(status.patchedMethodCount).toBe(0)
    expect(status.disabledReason).toContain('patch-failed')

    // 业务侧继续可用（未留下半插桩状态）
    expect((fakeTarget.existsSync as () => boolean)()).toBe(true)
  })

  it('生产门禁默认拒绝，force 与显式环境开关可覆盖', () => {
    const fsApi = requireFs()
    const nativeExists = fsApi.existsSync
    const originalNodeEnv = process.env.NODE_ENV
    const originalSwitch = process.env.FF_SYNC_IO_INSTRUMENT
    try {
      process.env.NODE_ENV = 'production'
      delete process.env.FF_SYNC_IO_INSTRUMENT

      expect(enableSyncIoInstrumentation({ delayMs: 0, logger })).toBe(false)
      expect(getSyncIoInstrumentationStatus().disabledReason).toBe('production-build')
      expect(fsApi.existsSync).toBe(nativeExists)

      expect(enableSyncIoInstrumentation({ delayMs: 0, force: true, logger })).toBe(true)
      disableSyncIoInstrumentation()

      process.env.FF_SYNC_IO_INSTRUMENT = '0'
      expect(enableSyncIoInstrumentation({ delayMs: 0, logger })).toBe(false)
      expect(getSyncIoInstrumentationStatus().disabledReason).toBe('env-disabled')

      process.env.FF_SYNC_IO_INSTRUMENT = '1'
      expect(enableSyncIoInstrumentation({ delayMs: 0, logger })).toBe(true)
    } finally {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = originalNodeEnv
      if (originalSwitch === undefined) delete process.env.FF_SYNC_IO_INSTRUMENT
      else process.env.FF_SYNC_IO_INSTRUMENT = originalSwitch
    }
  })
})

describe('报告导出', () => {
  it('JSON 报告含 totals / byModule / callSites，落盘文件可解析且写入自身不被计数', () => {
    const fsApi = requireFs()
    const fixture = join(workDir, 'report.txt')
    writeFileSync(fixture, 'x', 'utf8')

    expect(enableSyncIoInstrumentation({ delayMs: 0, logger })).toBe(true)
    fsApi.existsSync(fixture)

    const report = buildSyncIoReport()
    expect(report.version).toBe(1)
    expect(report.enabled).toBe(true)
    expect(report.totals.count).toBe(1)
    expect(report.callSites[0].callSite).toMatch(/instrument\.test\.ts:\d+$/)
    expect(JSON.parse(exportSyncIoReportToJson(report)).totals.count).toBe(1)

    const reportPath = join(workDir, 'sync-io-report.json')
    writeSyncIoReportToFile(reportPath, report)

    const persisted = JSON.parse(readFileSync(reportPath, 'utf8')) as {
      totals: { count: number }
      callSites: Array<{ callSite: string }>
    }
    expect(persisted.totals.count).toBe(1)
    expect(persisted.callSites[0].callSite).toMatch(/instrument\.test\.ts:\d+$/)

    // 写报告动作走原生快照，不产生额外调用点
    expect(buildSyncIoReport().totals.count).toBe(1)
  })

  it('人类可读排行包含调用点与累计耗时', () => {
    const fsApi = requireFs()
    expect(enableSyncIoInstrumentation({ delayMs: 0, logger })).toBe(true)
    fsApi.existsSync(workDir)

    const ranking = formatSyncIoRanking(buildSyncIoReport(), 5)
    expect(ranking).toContain('同步 I/O 排行')
    expect(ranking).toContain('instrument.test.ts:')
    expect(ranking).toContain('fs.existsSync')
  })
})
