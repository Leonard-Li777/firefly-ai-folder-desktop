/**
 * Ticket 22 (P1-3): ModuleSizeCalculator 与 module-size-worker 单元测试
 * 覆盖：lstat 语义（不跟随 symlink）、mtime 指纹缓存命中/失效、Worker 失败异步回退与 logger.warn
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { READY_MARKER_FILENAME, logger } from '@firefly/shared'
import { ModuleSizeCalculator } from '../module-size-calculator'
import { calculateSharedModulesBytes } from '../workers/module-size-worker'

describe('ModuleSizeCalculator & module-size-worker (Ticket 22 / P1-3)', () => {
  let tempRoot: string
  let sharedDir: string

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'firefly-mod-size-'))
    sharedDir = path.join(tempRoot, '_shared')
    fs.mkdirSync(sharedDir, { recursive: true })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  function createReadyModule(modId: string, payloadBytes: number): string {
    const modDir = path.join(sharedDir, modId)
    fs.mkdirSync(modDir, { recursive: true })
    const markerPath = path.join(modDir, READY_MARKER_FILENAME)
    fs.writeFileSync(markerPath, JSON.stringify({ ready: true }))
    const weightsPath = path.join(modDir, 'weights.bin')
    fs.writeFileSync(weightsPath, Buffer.alloc(payloadBytes, 1))
    // 跳过 .part / .deleting-* 临时条目
    fs.writeFileSync(path.join(modDir, 'temp.part'), Buffer.alloc(999, 2))
    fs.mkdirSync(path.join(modDir, '.deleting-old'), { recursive: true })
    fs.writeFileSync(path.join(modDir, '.deleting-old', 'old.bin'), Buffer.alloc(888, 3))
    return modDir
  }

  it('统计已就绪模块真实字节数并跳过临时目录/文件与未就绪目录', async () => {
    createReadyModule('mod-a', 1024)
    // 未就绪目录（无 ready marker）不应计入
    const unreadyDir = path.join(sharedDir, 'mod-unready')
    fs.mkdirSync(unreadyDir, { recursive: true })
    fs.writeFileSync(path.join(unreadyDir, 'partial.bin'), Buffer.alloc(4096, 4))

    const expectedMarkerSize = fs.statSync(
      path.join(sharedDir, 'mod-a', READY_MARKER_FILENAME)
    ).size
    const calculator = new ModuleSizeCalculator(async (dir, mods) =>
      calculateSharedModulesBytes(dir, mods)
    )

    const bytes = await calculator.calculateUsedBytes(tempRoot)
    expect(bytes).toBe(1024 + expectedMarkerSize)
  })

  it('严格遵循 lstat 语义：不跟随目录/文件符号链接倍数统计', async () => {
    const modDir = createReadyModule('mod-sym', 512)
    const externalFile = path.join(tempRoot, 'outside.bin')
    fs.writeFileSync(externalFile, Buffer.alloc(8192, 5))

    let symlinkCreated = false
    try {
      fs.symlinkSync(externalFile, path.join(modDir, 'link.bin'), 'file')
      symlinkCreated = true
    } catch {
      // Windows 无管理员/开发者模式权限时可能禁止创建符号链接，跳过断言
    }

    if (symlinkCreated) {
      const markerSize = fs.statSync(path.join(modDir, READY_MARKER_FILENAME)).size
      const res = await calculateSharedModulesBytes(sharedDir, ['mod-sym'])
      expect(res['mod-sym']).toBe(512 + markerSize)
    }
  })

  it('未变动时命中缓存（Worker 派发次数不增长），目录变动或 invalidate 后重算新值', async () => {
    const modDir = createReadyModule('mod-cache', 1000)
    const markerSize = fs.statSync(path.join(modDir, READY_MARKER_FILENAME)).size

    const calculator = new ModuleSizeCalculator(async (dir, mods) =>
      calculateSharedModulesBytes(dir, mods)
    )

    const first = await calculator.calculateUsedBytes(tempRoot)
    expect(first).toBe(1000 + markerSize)
    expect(calculator.getStats().workerDispatchCount).toBe(1)

    // 第二次未变动应直接命中缓存
    const second = await calculator.calculateUsedBytes(tempRoot)
    expect(second).toBe(1000 + markerSize)
    expect(calculator.getStats().workerDispatchCount).toBe(1)
    expect(calculator.getStats().cacheHitCount).toBe(1)

    // 新增文件 + 更新目录 mtime（模拟模块替换/扩容）
    fs.writeFileSync(path.join(modDir, 'extra.bin'), Buffer.alloc(500, 7))
    const futureTime = new Date(Date.now() + 5000)
    fs.utimesSync(modDir, futureTime, futureTime)

    const third = await calculator.calculateUsedBytes(tempRoot)
    expect(third).toBe(1500 + markerSize)
    expect(calculator.getStats().workerDispatchCount).toBe(2)

    // 显式 invalidate 后应再次重算
    calculator.invalidate('mod-cache')
    const fourth = await calculator.calculateUsedBytes(tempRoot)
    expect(fourth).toBe(1500 + markerSize)
    expect(calculator.getStats().workerDispatchCount).toBe(3)
  })

  it('Worker 不可用或抛错时 logger.warn 并回退主进程异步统计（禁止返回 0 冒充）', async () => {
    const modDir = createReadyModule('mod-fallback', 2048)
    const markerSize = fs.statSync(path.join(modDir, READY_MARKER_FILENAME)).size
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    const failingCalculator = new ModuleSizeCalculator(async () => {
      throw new Error('simulated worker crash')
    })

    const bytes = await failingCalculator.calculateUsedBytes(tempRoot)
    expect(bytes).toBe(2048 + markerSize)
    expect(failingCalculator.getStats().fallbackCount).toBe(1)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('回退主进程异步统计')
    )
  })
})
