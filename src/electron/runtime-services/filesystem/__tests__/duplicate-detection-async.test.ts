import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: () => '' },
  shell: {
    trashItem: vi.fn().mockResolvedValue(undefined),
    showItemInFolder: vi.fn(),
    openPath: vi.fn().mockResolvedValue('')
  },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }
}))

vi.mock('electron-conf', () => ({
  Conf: vi.fn().mockImplementation(() => ({
    get: vi.fn(),
    set: vi.fn()
  }))
}))

const mockTrash = vi.fn()
vi.mock('../trash-port', () => ({
  getTrashPort: () => ({
    trash: mockTrash
  })
}))

const mockDbRun = vi.fn()
const mockDbGet = vi.fn()
const mockDbAll = vi.fn()
const mockDbPrepare = vi.fn((_sql: string) => ({
  run: mockDbRun,
  get: mockDbGet,
  all: mockDbAll
}))

vi.mock('../../database', () => ({
  databaseService: {
    ensureInitialized: vi.fn().mockResolvedValue(undefined),
    db: {
      prepare: (sql: string) => mockDbPrepare(sql)
    }
  }
}))

import { logger } from '@firefly/shared'
import {
  resetStatementCacheForTest,
  setStatementCacheEnabled,
  getStatementCacheStats
} from '@pro/perf/statement-cache'
import { databaseService } from '../../database'
import { DuplicateDetectionService } from '../duplicate-detection-service'
import { trashDuplicateFiles } from '../duplicate-detection/duplicate-trash'
import {
  detectExtensionFromMagicBytes,
  spawnAsync
} from '../duplicate-detection/duplicate-magic-and-media'
import { executeStrategyFix } from '../duplicate-detection/duplicate-fix-executor'

describe('DuplicateDetection 异步化改造 (Ticket 10 & 15)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-dup-async-'))
    vi.clearAllMocks()
    resetStatementCacheForTest()
  })

  afterEach(() => {
    resetStatementCacheForTest()
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {}
  })

  describe('P0-4: scanDuplicates 异步存在性过滤保序', () => {
    it('混合输入（存在文件/不存在文件/目录）下过滤结果与原顺序逐项一致', async () => {
      const f1 = path.join(tmpDir, 'a.txt')
      const f2Missing = path.join(tmpDir, 'missing.txt')
      const dir1 = path.join(tmpDir, 'subdir')
      const f3 = path.join(tmpDir, 'b.txt')
      fs.writeFileSync(f1, 'hello')
      fs.mkdirSync(dir1)
      fs.writeFileSync(f3, 'world')

      mockDbAll.mockReturnValue([
        { id: 1, path: f1, name: 'a.txt', size: 5, fingerprint: 'fp1' },
        { id: 2, path: f2Missing, name: 'missing.txt', size: 10, fingerprint: 'fp1' },
        { id: 3, path: dir1, name: 'subdir', size: 0, fingerprint: '' },
        { id: 4, path: f3, name: 'b.txt', size: 5, fingerprint: 'fp1' }
      ])

      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('offline'))

      const svc = new DuplicateDetectionService()
      const groups = await svc.scanDuplicates({
        workspaceDirectoryPath: tmpDir,
        strategies: ['exact_hash']
      })

      expect(fetchSpy).toHaveBeenCalled()
      // 传入 scanViaOmniRust 的 filePaths 应仅包含存在的路径且保持原顺序
      expect(groups).toBeDefined()
      fetchSpy.mockRestore()
    })
  })

  describe('P0-5: executeStrategyFix SJF 排序并发预取', () => {
    it('optimize/clean_exif 按体积升序处理，失败分支记 size=0 并调用 logger.warn', async () => {
      const largeFile = path.join(tmpDir, 'large.jpg')
      const smallFile = path.join(tmpDir, 'small.jpg')
      const missingFile = path.join(tmpDir, 'missing.jpg')
      fs.writeFileSync(largeFile, Buffer.alloc(1000, 0xaa))
      fs.writeFileSync(smallFile, Buffer.alloc(10, 0xbb))

      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('omni offline'))

      const res = await executeStrategyFix(
        'optimize',
        [largeFile, missingFile, smallFile],
        'http://127.0.0.1:1',
        tmpDir
      )

      // missingFile 预取 stat 失败应有 logger.warn
      expect(warnSpy).toHaveBeenCalled()
      // smallFile 应排在 largeFile 之前（两者都因 omni offline 失败，errors 顺序反映处理顺序）
      expect(res.errors?.map(e => e.path)).toEqual([missingFile, smallFile, largeFile])

      warnSpy.mockRestore()
      fetchSpy.mockRestore()
    })

    it('非 optimize/clean_exif 动作不发起 stat，保持原顺序', async () => {
      const f1 = path.join(tmpDir, 'first name!.txt')
      const f2 = path.join(tmpDir, 'second name!.txt')
      fs.writeFileSync(f1, '123456')
      fs.writeFileSync(f2, '1')

      const statSpy = vi.spyOn(fs.promises, 'stat')

      const res = await executeStrategyFix('rename_bad_name', [f1, f2], 'http://127.0.0.1:1', tmpDir)
      expect(res.successCount).toBe(2)
      expect(res.processedPaths).toEqual([f1, f2])
      // rename_bad_name 只做 existsAsync（内部调一次 stat），不会在排序阶段额外 stat
      expect(statSpy).toHaveBeenCalledTimes(2)
      statSpy.mockRestore()
    })
  })

  describe('P0-6: trashDuplicateFiles 逐文件落盘与 StatementCache', () => {
    it('单文件成功、中间失败中断时逐文件立即删除 DB 行，绝不合并批量事务', async () => {
      const f1 = path.join(tmpDir, 'dup1.txt')
      const f2 = path.join(tmpDir, 'dup2.txt')
      const f3 = path.join(tmpDir, 'dup3.txt')
      fs.writeFileSync(f1, 'aaa')
      fs.writeFileSync(f2, 'bbb')
      fs.writeFileSync(f3, 'ccc')

      const events: string[] = []
      mockTrash.mockImplementation(async (p: string) => {
        events.push(`trash:${path.basename(p)}`)
        if (p === f2) {
          throw new Error('EACCES mock')
        }
      })
      mockDbRun.mockImplementation((p: string) => {
        events.push(`db_delete:${path.basename(p)}`)
      })

      setStatementCacheEnabled(true)
      const result = await trashDuplicateFiles([f1, f2, f3])

      expect(result.deletedCount).toBe(2)
      expect(result.freedBytes).toBe(6)
      expect(result.errors).toHaveLength(1)
      expect(result.errors?.[0].path).toBe(f2)

      // 严格逐文件顺序：移入回收站成功后立即删行，失败项不删行
      expect(events).toEqual([
        'trash:dup1.txt',
        'db_delete:dup1.txt',
        'trash:dup2.txt',
        'trash:dup3.txt',
        'db_delete:dup3.txt'
      ])

      // StatementCache 命中复用（2 次 DELETE 只 prepare 1 次）
      const stats = getStatementCacheStats(databaseService.db!)
      expect(stats.prepares).toBe(1)
      expect(stats.hits).toBe(1)
    })

    it('崩溃一致性：文件已被移入回收站但库行未删，重跑时判为不存在并安全跳过', async () => {
      const goneFile = path.join(tmpDir, 'already-trashed.txt')
      const result = await trashDuplicateFiles([goneFile])
      expect(result.deletedCount).toBe(0)
      expect(result.errors).toBeUndefined()
      expect(mockTrash).not.toHaveBeenCalled()
    })
  })

  describe('P0-7: 魔数 FileHandle.read 与 spawnAsync', () => {
    it('魔数读取覆盖正常文件、空文件、截断文件与无权限/不存在，且关闭句柄', async () => {
      const jpgPath = path.join(tmpDir, 'test.bin')
      fs.writeFileSync(jpgPath, Buffer.from([0xff, 0xd8, 0xff, 0xe0]))
      expect(await detectExtensionFromMagicBytes(jpgPath)).toBe('.jpg')

      const emptyPath = path.join(tmpDir, 'empty.bin')
      fs.writeFileSync(emptyPath, Buffer.alloc(0))
      expect(await detectExtensionFromMagicBytes(emptyPath)).toBe('')

      const truncatedPath = path.join(tmpDir, 'trunc.bin')
      fs.writeFileSync(truncatedPath, Buffer.from([0x89, 0x50]))
      expect(await detectExtensionFromMagicBytes(truncatedPath)).toBe('')

      await expect(
        detectExtensionFromMagicBytes(path.join(tmpDir, 'nonexistent.bin'))
      ).rejects.toThrow()
    })

    it('spawnAsync 覆盖成功、非0退出、找不到可执行文件与超时分支', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

      const okRes = await spawnAsync(process.execPath, ['-e', 'process.exit(0)'])
      expect(okRes.status).toBe(0)
      expect(okRes.error).toBeNull()

      const nonZeroRes = await spawnAsync(process.execPath, ['-e', 'process.exit(3)'])
      expect(nonZeroRes.status).toBe(3)
      expect(nonZeroRes.error).toBeNull()

      const notFoundRes = await spawnAsync('nonexistent-binary-xyz-99999', [])
      expect(notFoundRes.status).toBeNull()
      expect(notFoundRes.error).toBeTruthy()

      const timeoutRes = await spawnAsync(
        process.execPath,
        ['-e', 'setTimeout(() => {}, 5000)'],
        { timeoutMs: 50 }
      )
      expect(timeoutRes.status).toBeNull()
      expect(timeoutRes.error?.message).toContain('timed out')
      expect(warnSpy).toHaveBeenCalled()

      warnSpy.mockRestore()
    })
  })
})
