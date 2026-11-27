import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { statOrNull, statOrThrow, existsAsync, readdirTyped, mkdirp, safeUnlink } from '../async-fs'

let tmpDir = ''

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ff-async-fs-'))
})

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('statOrNull —— INV-1 四类输入分支契约', () => {
  it('存在文件 → 返回 Stats，且 isFile 为真', async () => {
    const filePath = path.join(tmpDir, 'a.txt')
    await fsp.writeFile(filePath, 'x')

    const stat = await statOrNull(filePath)

    expect(stat).not.toBeNull()
    expect(stat?.isFile()).toBe(true)
  })

  it('不存在 → 返回 null，且不触发 onError（ENOENT 属正常未命中）', async () => {
    const onError = vi.fn()

    const stat = await statOrNull(path.join(tmpDir, 'missing.txt'), onError)

    expect(stat).toBeNull()
    expect(onError).not.toHaveBeenCalled()
  })

  it('路径是目录 → 返回目录 Stats，由调用方自行分流（不在本层偷改语义）', async () => {
    const dirPath = path.join(tmpDir, 'sub')
    await fsp.mkdir(dirPath)

    const stat = await statOrNull(dirPath)

    expect(stat).not.toBeNull()
    expect(stat?.isDirectory()).toBe(true)
  })

  it('路径经过非目录（ENOTDIR）→ 返回 null，同样不触发 onError', async () => {
    const filePath = path.join(tmpDir, 'a.txt')
    await fsp.writeFile(filePath, 'x')
    const onError = vi.fn()

    const stat = await statOrNull(path.join(filePath, 'child.txt'), onError)

    expect(stat).toBeNull()
    expect(onError).not.toHaveBeenCalled()
  })

  it('stat 抛非「未命中」错误（EACCES）→ 返回 null，并回调 onError 交调用方 logger.warn（禁止静默降级）', async () => {
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    vi.spyOn(fsp, 'stat').mockRejectedValueOnce(denied)
    const onError = vi.fn()

    const stat = await statOrNull(path.join(tmpDir, 'whatever'), onError)

    expect(stat).toBeNull()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]?.code).toBe('EACCES')
    expect(onError.mock.calls[0][1]).toBe(path.join(tmpDir, 'whatever'))
  })

  it('跟随符号链接语义（与 existsSync 一致，禁止 lstat）', async () => {
    const target = path.join(tmpDir, 'target.txt')
    const link = path.join(tmpDir, 'link.txt')
    await fsp.writeFile(target, 'x')
    try {
      await fsp.symlink(target, link)
    } catch {
      // Windows 无符号链接权限的机器上跳过（不改判定契约，只跳过夹具）
      return
    }

    const stat = await statOrNull(link)

    expect(stat?.isFile()).toBe(true)
  })
})

describe('statOrThrow —— 保留原来「抛错进 catch」的分支', () => {
  it('存在文件返回 Stats', async () => {
    const filePath = path.join(tmpDir, 'b.txt')
    await fsp.writeFile(filePath, 'x')

    const stat = await statOrThrow(filePath)

    expect(stat.isFile()).toBe(true)
  })

  it('不存在时仍抛 ENOENT，不被吞成 null', async () => {
    await expect(statOrThrow(path.join(tmpDir, 'nope.txt'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })
})

describe('existsAsync', () => {
  it('存在 → true，不存在 → false', async () => {
    const filePath = path.join(tmpDir, 'c.txt')
    await fsp.writeFile(filePath, 'x')

    await expect(existsAsync(filePath)).resolves.toBe(true)
    await expect(existsAsync(path.join(tmpDir, 'none.txt'))).resolves.toBe(false)
  })
})

describe('readdirTyped', () => {
  it('一次调用即拿到文件与目录类型', async () => {
    await fsp.writeFile(path.join(tmpDir, 'file.txt'), 'x')
    await fsp.mkdir(path.join(tmpDir, 'folder'))

    const entries = await readdirTyped(tmpDir)
    const byName = new Map(entries.map(entry => [entry.name, entry]))

    expect(byName.get('file.txt')?.isFile()).toBe(true)
    expect(byName.get('folder')?.isDirectory()).toBe(true)
  })

  it('目录不存在时抛出原错误', async () => {
    await expect(readdirTyped(path.join(tmpDir, 'missing-dir'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })
})

describe('mkdirp', () => {
  it('递归创建且幂等（第二次调用不抛 EEXIST）', async () => {
    const nested = path.join(tmpDir, 'a', 'b', 'c')

    await mkdirp(nested)
    await expect(mkdirp(nested)).resolves.toBeUndefined()

    const stat = await fsp.stat(nested)
    expect(stat.isDirectory()).toBe(true)
  })
})

describe('safeUnlink', () => {
  it('删除已存在文件 → true，且文件确实消失', async () => {
    const filePath = path.join(tmpDir, 'd.txt')
    await fsp.writeFile(filePath, 'x')

    await expect(safeUnlink(filePath)).resolves.toBe(true)
    await expect(existsAsync(filePath)).resolves.toBe(false)
  })

  it('目标不存在 → false（等价于 existsSync 先判的语义）', async () => {
    await expect(safeUnlink(path.join(tmpDir, 'absent.txt'))).resolves.toBe(false)
  })

  it('目标是目录 → 上浮原错误，不静默当成功', async () => {
    const dirPath = path.join(tmpDir, 'dir-target')
    await fsp.mkdir(dirPath)

    await expect(safeUnlink(dirPath)).rejects.toBeTruthy()
  })
})
