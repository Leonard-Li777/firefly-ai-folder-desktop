import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs, { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { writeFileAtomic, writeFileAtomicSync } from '../atomic-write'

let tmpDir = ''

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ff-atomic-write-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fsp.rm(tmpDir, { recursive: true, force: true })
})

async function listTmpArtifacts(dir: string): Promise<string[]> {
  const entries = await fsp.readdir(dir)
  return entries.filter(name => name.includes('.tmp.'))
}

describe('writeFileAtomic', () => {
  it('写入 UTF-8 文本与 Buffer 二进制内容与原生 writeFile 一致，且无临时文件残留', async () => {
    const textPath = path.join(tmpDir, 'config.json')
    const binPath = path.join(tmpDir, 'payload.bin')
    const jsonPayload = JSON.stringify({ hello: '世界', count: 42 }, null, 2)
    const binPayload = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x7f])

    await writeFileAtomic(textPath, jsonPayload)
    await writeFileAtomic(binPath, binPayload)

    await expect(fsp.readFile(textPath, 'utf8')).resolves.toBe(jsonPayload)
    await expect(fsp.readFile(binPath)).resolves.toEqual(binPayload)
    await expect(listTmpArtifacts(tmpDir)).resolves.toEqual([])
  })

  it('尊重 encoding 选项，并能原子覆盖既有目标文件', async () => {
    const targetPath = path.join(tmpDir, 'encoded.txt')
    await fsp.writeFile(targetPath, 'old-content', 'utf8')

    await writeFileAtomic(targetPath, 'café', { encoding: 'latin1' })

    const raw = await fsp.readFile(targetPath)
    expect(raw).toEqual(Buffer.from('café', 'latin1'))
  })

  it('临时文件落于目标文件同目录，默认调用 handle.sync()，opts.fsync=false 时跳过 sync()', async () => {
    const targetPath = path.join(tmpDir, 'perf-flags.json')
    const realOpen = fsp.open.bind(fsp)
    let openedTmpPath = ''
    let syncCallCount = 0

    vi.spyOn(fsp, 'open').mockImplementation(async (filePath, flags, mode) => {
      openedTmpPath = String(filePath)
      const handle = await realOpen(filePath, flags, mode)
      const realSync = handle.sync.bind(handle)
      handle.sync = async () => {
        syncCallCount += 1
        return await realSync()
      }
      return handle
    })

    await writeFileAtomic(targetPath, '{"v":1}')
    expect(path.dirname(openedTmpPath)).toBe(tmpDir)
    expect(path.basename(openedTmpPath)).toMatch(
      new RegExp(`^\\.perf-flags\\.json\\.tmp\\.${process.pid}\\.\\d+$`)
    )
    expect(syncCallCount).toBe(1)

    await writeFileAtomic(targetPath, '{"v":2}', { fsync: false })
    expect(syncCallCount).toBe(1)
    await expect(fsp.readFile(targetPath, 'utf8')).resolves.toBe('{"v":2}')
  })

  it('模拟 FileHandle.sync 抛错时清理同目录 .tmp.* 并保留原文件内容', async () => {
    const targetPath = path.join(tmpDir, 'state.json')
    await fsp.writeFile(targetPath, '{"stable":true}', 'utf8')

    const realOpen = fsp.open.bind(fsp)
    vi.spyOn(fsp, 'open').mockImplementation(async (filePath, flags, mode) => {
      const handle = await realOpen(filePath, flags, mode)
      handle.sync = async () => {
        throw Object.assign(new Error('disk io error during sync'), { code: 'EIO' })
      }
      return handle
    })

    await expect(writeFileAtomic(targetPath, '{"stable":false}')).rejects.toMatchObject({
      code: 'EIO'
    })
    await expect(fsp.readFile(targetPath, 'utf8')).resolves.toBe('{"stable":true}')
    await expect(listTmpArtifacts(tmpDir)).resolves.toEqual([])
  })

  it('模拟 rename 抛错（含跨卷 EXDEV）时清理同目录 .tmp.* 并原样上浮错误', async () => {
    const targetPath = path.join(tmpDir, 'runtime-pids.json')
    await fsp.writeFile(targetPath, '[100]', 'utf8')

    const exdev = Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' })
    vi.spyOn(fsp, 'rename').mockRejectedValueOnce(exdev)

    await expect(writeFileAtomic(targetPath, '[200]')).rejects.toMatchObject({ code: 'EXDEV' })
    await expect(fsp.readFile(targetPath, 'utf8')).resolves.toBe('[100]')
    await expect(listTmpArtifacts(tmpDir)).resolves.toEqual([])
  })

  it('目标目录不存在时直接抛 ENOENT（不自动创建目录，与原生 writeFile 一致）', async () => {
    const missingDirTarget = path.join(tmpDir, 'non-existent', 'file.json')

    await expect(writeFileAtomic(missingDirTarget, 'data')).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('并发调用 writeFileAtomic 写同一路径时按入队顺序串行落盘、无 EPERM 且无残留', async () => {
    const targetPath = path.join(tmpDir, 'concurrent.json')

    await Promise.all(
      Array.from({ length: 8 }, (_, idx) => writeFileAtomic(targetPath, `{"seq":${idx}}`))
    )

    const finalContent = await fsp.readFile(targetPath, 'utf8')
    expect(finalContent).toBe('{"seq":7}')
    await expect(listTmpArtifacts(tmpDir)).resolves.toEqual([])
  })

  it('win32 下 rename 遇瞬态 EPERM/EBUSY 时自动有界重试并成功落盘', async () => {
    const targetPath = path.join(tmpDir, 'retry-win32.json')
    const realRename = fsp.rename.bind(fsp)
    let renameAttempts = 0
    const origPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })

    try {
      vi.spyOn(fsp, 'rename').mockImplementation(async (oldPath, newPath) => {
        renameAttempts += 1
        if (renameAttempts <= 2) {
          throw Object.assign(new Error('transient lock'), { code: 'EPERM' })
        }
        return await realRename(oldPath, newPath)
      })

      await writeFileAtomic(targetPath, '{"retried":true}')
      expect(renameAttempts).toBe(3)
      await expect(fsp.readFile(targetPath, 'utf8')).resolves.toBe('{"retried":true}')
      await expect(listTmpArtifacts(tmpDir)).resolves.toEqual([])

      // EBUSY / EACCES 同样触发重试并最终成功
      renameAttempts = 0
      vi.spyOn(fsp, 'rename').mockImplementation(async (oldPath, newPath) => {
        renameAttempts += 1
        if (renameAttempts === 1) {
          throw Object.assign(new Error('busy'), { code: 'EBUSY' })
        }
        if (renameAttempts === 2) {
          throw Object.assign(new Error('access'), { code: 'EACCES' })
        }
        return await realRename(oldPath, newPath)
      })
      await writeFileAtomic(targetPath, '{"retried":2}')
      expect(renameAttempts).toBe(3)
      await expect(fsp.readFile(targetPath, 'utf8')).resolves.toBe('{"retried":2}')
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true })
    }
  })

  it('win32 下 rename 重试 4 次（总计 5 次）仍遇 EPERM 时停止重试、清理 .tmp.* 并上浮原错误', async () => {
    const targetPath = path.join(tmpDir, 'exhausted-win32.json')
    await fsp.writeFile(targetPath, '{"keep":true}', 'utf8')
    let renameAttempts = 0
    const origPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })

    try {
      vi.spyOn(fsp, 'rename').mockImplementation(async () => {
        renameAttempts += 1
        throw Object.assign(new Error('persistent lock'), { code: 'EPERM' })
      })

      await expect(writeFileAtomic(targetPath, '{"keep":false}')).rejects.toMatchObject({
        code: 'EPERM'
      })
      expect(renameAttempts).toBe(5)
      await expect(fsp.readFile(targetPath, 'utf8')).resolves.toBe('{"keep":true}')
      await expect(listTmpArtifacts(tmpDir)).resolves.toEqual([])
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true })
    }
  })

  it('非 win32 平台遇 EPERM 不重试（仅调用 1 次 rename 即失败并清理 .tmp.*）', async () => {
    const targetPath = path.join(tmpDir, 'non-win32.json')
    let renameAttempts = 0
    const origPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })

    try {
      vi.spyOn(fsp, 'rename').mockImplementation(async () => {
        renameAttempts += 1
        throw Object.assign(new Error('eperm on linux'), { code: 'EPERM' })
      })

      await expect(writeFileAtomic(targetPath, 'payload')).rejects.toMatchObject({ code: 'EPERM' })
      expect(renameAttempts).toBe(1)
      await expect(listTmpArtifacts(tmpDir)).resolves.toEqual([])
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true })
    }
  })

  it('空路径、目录尾斜杠或 ./.. 相对目录路径在入口直接拦截，不产生任何临时文件', async () => {
    const openSpy = vi.spyOn(fsp, 'open')
    await expect(writeFileAtomic('', 'data')).rejects.toMatchObject({ code: 'EINVAL' })
    await expect(writeFileAtomic('.', 'data')).rejects.toMatchObject({ code: 'EINVAL' })
    await expect(writeFileAtomic('..', 'data')).rejects.toMatchObject({ code: 'EINVAL' })
    await expect(writeFileAtomic(tmpDir + path.sep, 'data')).rejects.toMatchObject({
      code: 'EISDIR'
    })
    expect(() => writeFileAtomicSync('   ', 'data')).toThrow()
    expect(() => writeFileAtomicSync('.', 'data')).toThrow()
    expect(() => writeFileAtomicSync(tmpDir + '/', 'data')).toThrow()
    expect(openSpy).not.toHaveBeenCalled()
    await expect(listTmpArtifacts(tmpDir)).resolves.toEqual([])
  })

  it('open(wx) 遇 EEXIST 时自动递增 seq 重试，且即使全耗尽也不误删既有的外部 .tmp 文件', async () => {
    const targetPath = path.join(tmpDir, 'eexist-guard.json')
    const externalTmp = path.join(tmpDir, `.eexist-guard.json.tmp.${process.pid}.999999`)
    await fsp.writeFile(externalTmp, 'foreign-tmp', 'utf8')

    const realOpen = fsp.open.bind(fsp)
    let openAttempts = 0
    vi.spyOn(fsp, 'open').mockImplementation(async (filePath, flags, mode) => {
      openAttempts += 1
      if (openAttempts === 1) {
        throw Object.assign(new Error('already exists'), { code: 'EEXIST' })
      }
      return await realOpen(filePath, flags, mode)
    })

    await writeFileAtomic(targetPath, '{"recovered":true}')
    expect(openAttempts).toBe(2)
    await expect(fsp.readFile(targetPath, 'utf8')).resolves.toBe('{"recovered":true}')
    await expect(fsp.readFile(externalTmp, 'utf8')).resolves.toBe('foreign-tmp')

    // 若全部 EEXIST 耗尽：仅上浮 EEXIST，不触碰外部残留文件
    vi.spyOn(fsp, 'open').mockRejectedValue(
      Object.assign(new Error('already exists'), { code: 'EEXIST' })
    )
    await expect(writeFileAtomic(targetPath, '{"recovered":false}')).rejects.toMatchObject({
      code: 'EEXIST'
    })
    await expect(fsp.readFile(externalTmp, 'utf8')).resolves.toBe('foreign-tmp')
  })
})

describe('writeFileAtomicSync（进程退出同步路径专用）', () => {
  it('同步写入并覆盖目标文件，且同目录无临时文件残余', async () => {
    const targetPath = path.join(tmpDir, 'exit-pids.json')
    writeFileAtomicSync(targetPath, '{"pids":[1,2]}')
    expect(fs.readFileSync(targetPath, 'utf8')).toBe('{"pids":[1,2]}')

    writeFileAtomicSync(targetPath, Buffer.from('final-exit'), { fsync: false })
    expect(fs.readFileSync(targetPath, 'utf8')).toBe('final-exit')
    await expect(listTmpArtifacts(tmpDir)).resolves.toEqual([])
  })

  it('模拟 fsyncSync / renameSync 抛错时清理同目录 .tmp.* 并保留旧文件', async () => {
    const targetPath = path.join(tmpDir, 'exit-state.json')
    fs.writeFileSync(targetPath, '{"ok":1}', 'utf8')

    vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('sync failed'), { code: 'EIO' })
    })
    expect(() => writeFileAtomicSync(targetPath, '{"ok":2}')).toThrow('sync failed')
    expect(fs.readFileSync(targetPath, 'utf8')).toBe('{"ok":1}')
    await expect(listTmpArtifacts(tmpDir)).resolves.toEqual([])

    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('rename denied'), { code: 'EPERM' })
    })
    expect(() => writeFileAtomicSync(targetPath, '{"ok":3}')).toThrow('rename denied')
    expect(fs.readFileSync(targetPath, 'utf8')).toBe('{"ok":1}')
    await expect(listTmpArtifacts(tmpDir)).resolves.toEqual([])
  })
})
