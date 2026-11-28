/**
 * Ticket 28 (P2-3): ResourceIoDispatcher (扩展 bundle-extractor-worker) 与 TombstoneGC INV-7 单元测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { logger } from '@firefly/shared'
import { ResourceIoDispatcher } from '../bundle-extractor-dispatcher'
import { TombstoneGCService } from '../tombstone-gc'

describe('Ticket 28 (P2-3): 扩展 bundle-extractor-worker 与 TombstoneGC 扫描', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firefly-p2-3-'))
    ResourceIoDispatcher.resetStatsForTesting()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('Worker 失败时 logger.warn + 显式递增 fallbackCount 并回退 inProcessExecuteResourceIoOp 完成 MOVE_DIR / COMPUTE_PATH_BYTES / REMOVE_DIR', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const srcDir = path.join(tempDir, 'src_mod')
    const destDir = path.join(tempDir, 'dest_mod')
    fs.mkdirSync(srcDir, { recursive: true })
    fs.writeFileSync(path.join(srcDir, 'model.bin'), Buffer.alloc(1024, 9))

    const bytesRes = await ResourceIoDispatcher.run(
      { type: 'COMPUTE_PATH_BYTES', targetPath: srcDir },
      { forceWorkerFailureForTest: true }
    )
    expect(bytesRes.bytes).toBe(1024)
    expect(ResourceIoDispatcher.getStats().fallbackCount).toBe(1)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('回退主进程异步 inProcessExecuteResourceIoOp')
    )

    await ResourceIoDispatcher.run(
      { type: 'MOVE_DIR', sourcePath: srcDir, targetPath: destDir },
      { forceWorkerFailureForTest: true }
    )
    expect(fs.existsSync(srcDir)).toBe(false)
    expect(fs.existsSync(path.join(destDir, 'model.bin'))).toBe(true)

    await ResourceIoDispatcher.run(
      { type: 'REMOVE_DIR', targetPath: destDir },
      { forceWorkerFailureForTest: true }
    )
    expect(fs.existsSync(destDir)).toBe(false)
    expect(ResourceIoDispatcher.getStats().fallbackCount).toBe(3)
  })

  it('TombstoneGCService.getPendingDeletions 使用一次目录读取 + Set 判定，准确过滤已清理目录', () => {
    const gc = new TombstoneGCService()
    const aliveDir = path.join(tempDir, '.deleting-alive')
    const goneDir = path.join(tempDir, '.deleting-gone')
    fs.mkdirSync(aliveDir, { recursive: true })
    fs.mkdirSync(goneDir, { recursive: true })

    gc.registerPendingDeletion(aliveDir, 'EBUSY')
    gc.registerPendingDeletion(goneDir, 'EBUSY')
    fs.rmSync(goneDir, { recursive: true, force: true })

    const pending = gc.getPendingDeletions()
    expect(pending.map(p => p.path)).toEqual([path.normalize(aliveDir)])
    expect(gc.hasPendingDeletions()).toBe(true)
  })
})
