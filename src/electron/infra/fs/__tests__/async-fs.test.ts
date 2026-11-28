import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { logger } from '@firefly/shared'
import {
  statOrNull,
  statOrThrow,
  existsAsync,
  readdirTyped,
  mkdirp,
  safeUnlink,
  setDefaultStatErrorReporter
} from '../async-fs'
import { mapLimit } from '../concurrency'

let tmpDir = ''

beforeEach(async () => {
  setDefaultStatErrorReporter()
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ff-async-fs-'))
})

afterEach(async () => {
  setDefaultStatErrorReporter()
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

  it('stat 抛非「未命中」错误（EACCES）→ 返回 null，且仅回调传入的 onError（不走默认上报器）', async () => {
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    vi.spyOn(fsp, 'stat').mockRejectedValueOnce(denied)
    const onError = vi.fn()
    const defaultReporter = vi.fn()
    setDefaultStatErrorReporter(defaultReporter)

    const stat = await statOrNull(path.join(tmpDir, 'whatever'), onError)

    expect(stat).toBeNull()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]?.code).toBe('EACCES')
    expect(onError.mock.calls[0][1]).toBe(path.join(tmpDir, 'whatever'))
    expect(defaultReporter).not.toHaveBeenCalled()
  })

  it('裸调 statOrNull(p) 遇到 EACCES/EPERM → 默认走 @firefly/shared logger.warn 且返回 null', async () => {
    const denied = Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    vi.spyOn(fsp, 'stat').mockRejectedValueOnce(denied)
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const target = path.join(tmpDir, 'locked.txt')

    const stat = await statOrNull(target)

    expect(stat).toBeNull()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0][1])).toContain('EPERM')
    expect(String(warnSpy.mock.calls[0][1])).toContain(target)
  })

  it('ENOENT / ENOTDIR 正常未命中时默认上报器调用 0 次', async () => {
    const defaultReporter = vi.fn()
    setDefaultStatErrorReporter(defaultReporter)

    await expect(statOrNull(path.join(tmpDir, 'missing.txt'))).resolves.toBeNull()
    expect(defaultReporter).not.toHaveBeenCalled()
  })

  it('mapLimit(paths, 2, statOrNull) 与 Array.map 传入数字索引第 2 参时不抛 TypeError 且走默认上报器', async () => {
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    vi.spyOn(fsp, 'stat').mockRejectedValue(denied)
    const defaultReporter = vi.fn()
    setDefaultStatErrorReporter(defaultReporter)

    const paths = [path.join(tmpDir, 'p0.txt'), path.join(tmpDir, 'p1.txt')]

    const resultsFromMapLimit = await mapLimit(
      paths,
      2,
      statOrNull as unknown as (item: string, index: number) => Promise<Awaited<ReturnType<typeof statOrNull>>>
    )
    const resultsFromArrayMap = await Promise.all(
      paths.map(statOrNull as unknown as (item: string, index: number) => Promise<Awaited<ReturnType<typeof statOrNull>>>)
    )

    expect(resultsFromMapLimit).toEqual([null, null])
    expect(resultsFromArrayMap).toEqual([null, null])
    expect(defaultReporter).toHaveBeenCalledTimes(4)
  })

  it('onError 自身抛错时仍受隔离保护，绝不打破 INV-1 恒返回 null 契约', async () => {
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    vi.spyOn(fsp, 'stat').mockRejectedValueOnce(denied)
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const brokenOnError = vi.fn(() => {
      throw new Error('reporter crashed')
    })

    const stat = await statOrNull(path.join(tmpDir, 'crash.txt'), brokenOnError)

    expect(stat).toBeNull()
    expect(brokenOnError).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledTimes(1)
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

  it('第 2 参被误传数字索引且遇 EACCES 时不抛 TypeError，走默认上报器并返回 false', async () => {
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    vi.spyOn(fsp, 'stat').mockRejectedValueOnce(denied)
    const defaultReporter = vi.fn()
    setDefaultStatErrorReporter(defaultReporter)

    const exists = await (
      existsAsync as unknown as (p: string, index: number) => Promise<boolean>
    )(path.join(tmpDir, 'locked.txt'), 0)

    expect(exists).toBe(false)
    expect(defaultReporter).toHaveBeenCalledTimes(1)
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
