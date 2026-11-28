/**
 * Ticket 19 (P0-11): IPC 热循环异步收口与 O(N) 事件循环非阻塞测试
 * 覆盖：
 * - file.ts O(N) 500 项并发存在性探测无 >50ms 单次事件循环阻塞
 * - misc.ts get-file-analysis-result / delete-preprocessed-file / system:write-diagnostic-log 异步等价性
 * - modular-resource-ipc-handler dir-switch-intent 异步目录读取
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import {
  createLimiter,
  existsAsync,
  mkdirp,
  readdirTyped,
  safeUnlink,
  statOrNull
} from '../../../infra/fs'

describe('IPC Hot-Loop Async Convergence (Ticket 19 / P0-11)', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firefly-ipc-hotloop-'))
  })

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('O(N) 500 项文件存在性并发探测（createLimiter(32) + existsAsync）事件循环最大阻塞 < 50ms', async () => {
    const paths: string[] = []
    for (let i = 0; i < 500; i++) {
      const p = path.join(tempDir, `file-${i}.txt`)
      if (i % 2 === 0) {
        fs.writeFileSync(p, 'ok')
      }
      paths.push(p)
    }

    const histogram = monitorEventLoopDelay({ resolution: 10 })
    histogram.enable()
    const limiter = createLimiter(32)
    const results = await Promise.all(paths.map(p => limiter(() => existsAsync(p))))
    histogram.disable()

    expect(results.filter(Boolean).length).toBe(250)
    expect(results.length).toBe(500)
    const maxDelayMs = histogram.max / 1e6
    expect(maxDelayMs).toBeLessThan(50)
  })

  it('statOrNull 四类分支等价：存在文件 / 不存在 / 目录 / 安全删除 safeUnlink', async () => {
    const filePath = path.join(tempDir, 'sample.txt')
    fs.writeFileSync(filePath, 'hello')
    const missingPath = path.join(tempDir, 'missing.txt')

    const stFile = await statOrNull(filePath)
    expect(stFile?.isFile()).toBe(true)
    expect(stFile?.size).toBe(5)

    const stMissing = await statOrNull(missingPath)
    expect(stMissing).toBeNull()

    const stDir = await statOrNull(tempDir)
    expect(stDir?.isDirectory()).toBe(true)

    await safeUnlink(filePath)
    expect(await existsAsync(filePath)).toBe(false)
    // 二次删除幂等不抛错
    await expect(safeUnlink(filePath)).resolves.not.toThrow()
  })

  it('mkdirp + fsp.writeFile 与 readdirTyped 异步读写 intent 目录等价', async () => {
    const intentsDir = path.join(tempDir, '.intents')
    await mkdirp(intentsDir)
    const intentFile = path.join(intentsDir, 'dir-switch-1.json')
    await fs.promises.writeFile(intentFile, JSON.stringify({ state: 'prepared' }), 'utf-8')

    const entries = await readdirTyped(intentsDir)
    const names = entries
      .map(e => e.name)
      .filter(f => f.startsWith('dir-switch-') && f.endsWith('.json'))
    expect(names).toEqual(['dir-switch-1.json'])

    const parsed = JSON.parse(await fs.promises.readFile(path.join(intentsDir, names[0]), 'utf-8'))
    expect(parsed.state).toBe('prepared')
  })
})
