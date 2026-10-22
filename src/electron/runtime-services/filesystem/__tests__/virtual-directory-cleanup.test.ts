import fs from 'node:fs'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => 'C:\\test'),
    getName: vi.fn(() => 'firefly'),
    isPackaged: false
  },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) }
}))

import { cleanupVirtualDirectoryOnDelete } from '../virtual-directory-cleanup'

/**
 * 源码契约护栏：删除工作目录时 .VirtualDirectory 的清理链路。
 *
 * 背景（2026-10-21 日志复现）：删除工作区时先物理删 `.VirtualDirectory`、之后才清分析队列，
 * 在途的缩略图任务仍握着 `.VirtualDirectory/.thumbnail` 写入句柄，导致 `fs.rm` 撞 EBUSY
 * (errno -4082)；而失败被 catch 后只 warn、IPC 照常返回 success:true，界面弹「已删除」，
 * 磁盘上的缓存目录却原样留存，用户毫无察觉。更糟的是删完后 4 分钟目录被在途任务重建。
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const handlerSource = readFileSync(
  path.resolve(here, '..', '..', 'ipc', 'settings-ipc-handler.ts'),
  'utf-8'
)
const queueSource = readFileSync(
  path.resolve(here, '..', '..', 'analysis-queue-service', 'analysis-queue-service.ts'),
  'utf-8'
)

/** 构造 Windows 上典型的占用错误 */
function makeBusyError(): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(
    'EBUSY: resource busy or locked, rmdir ... \\.VirtualDirectory'
  )
  err.code = 'EBUSY'
  err.errno = -4082
  return err
}

describe('cleanupVirtualDirectoryOnDelete 清理契约', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('AC1: 目录本就不存在时判定为已清理，且不发起任何删除动作', async () => {
    const rmSpy = vi.spyOn(fs.promises, 'rm').mockResolvedValue(undefined)
    vi.spyOn(fs, 'existsSync').mockReturnValue(false)

    await expect(cleanupVirtualDirectoryOnDelete('D:\\ws')).resolves.toBe(true)
    expect(rmSpy).not.toHaveBeenCalled()
  })

  it('AC2: 一次删除成功且删后复核不存在的，判定清理干净', async () => {
    const rmSpy = vi.spyOn(fs.promises, 'rm').mockResolvedValue(undefined)
    vi.spyOn(fs, 'existsSync')
      .mockReturnValueOnce(true) // 删除前：目录存在
      .mockReturnValueOnce(false) // 删除后复核：已消失

    await expect(cleanupVirtualDirectoryOnDelete('D:\\ws')).resolves.toBe(true)
    expect(rmSpy).toHaveBeenCalledTimes(1)
    expect(rmSpy).toHaveBeenCalledWith(
      path.join('D:\\ws', '.VirtualDirectory'),
      expect.objectContaining({ recursive: true })
    )
  })

  it('AC3: 首次撞 EBUSY 时退避重试，句柄释放后仍能清理成功', async () => {
    const rmSpy = vi
      .spyOn(fs.promises, 'rm')
      .mockRejectedValueOnce(makeBusyError())
      .mockResolvedValue(undefined)
    vi.spyOn(fs, 'existsSync')
      .mockReturnValueOnce(true)
      .mockReturnValue(false)

    await expect(cleanupVirtualDirectoryOnDelete('D:\\ws')).resolves.toBe(true)
    expect(rmSpy).toHaveBeenCalledTimes(2)
  })

  it(
    'AC4: 持续占用导致清理失败时必须返回 false，严禁静默当作成功',
    async () => {
      const rmSpy = vi.spyOn(fs.promises, 'rm').mockRejectedValue(makeBusyError())
      vi.spyOn(fs, 'existsSync').mockReturnValue(true)

      await expect(cleanupVirtualDirectoryOnDelete('D:\\ws')).resolves.toBe(false)
      // 必须真的退避重试过，而不是失败一次就放弃
      expect(rmSpy.mock.calls.length).toBeGreaterThan(1)
    },
    20000
  )

  it(
    'AC5: fs.rm 假成功（调用返回但目录仍在）不得被判定为清理干净',
    async () => {
      const rmSpy = vi.spyOn(fs.promises, 'rm').mockResolvedValue(undefined)
      vi.spyOn(fs, 'existsSync').mockReturnValue(true)

      await expect(cleanupVirtualDirectoryOnDelete('D:\\ws')).resolves.toBe(false)
      expect(rmSpy.mock.calls.length).toBeGreaterThan(1)
    },
    20000
  )
})

describe('删除工作目录链路顺序护栏', () => {
  it('必须先中止该目录的分析任务，再物理删除 .VirtualDirectory', () => {
    const abortIdx = handlerSource.indexOf('abortAndDeleteItemsByDirectory(directoryPath)')
    const cleanupIdx = handlerSource.indexOf('await cleanupVirtualDirectoryOnDelete(directoryPath)')

    expect(abortIdx).toBeGreaterThan(-1)
    expect(cleanupIdx).toBeGreaterThan(-1)
    expect(abortIdx).toBeLessThan(cleanupIdx)
  })

  it('不得回退为「先删目录、后清队列」的旧顺序（会让 fs.rm 撞 EBUSY 或目录被重建）', () => {
    expect(handlerSource).not.toMatch(/analysisQueueService\.deleteItemsByDirectory/)
  })

  it('清理失败必须回传 warning，禁止只 warn 后返回 success', () => {
    expect(handlerSource).toMatch(/!virtualDirectoryCleaned/)
    expect(handlerSource).toMatch(/warning:\s*t\(/)
  })

  it('分析队列必须提供按目录中止在途任务的能力', () => {
    expect(queueSource).toMatch(/async abortAndDeleteItemsByDirectory\(/)
  })
})
