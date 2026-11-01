import { describe, it, expect, vi, beforeEach } from 'vitest'
import { safeClipboard } from '../safe-clipboard'
import { clipboard } from 'electron'

vi.mock('electron', () => ({
  clipboard: {
    writeText: vi.fn(),
    readText: vi.fn(),
    write: vi.fn()
  }
}))

describe('safeClipboard 跨版本平滑适配层', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('支持 Electron 32 同步返回的 writeText', async () => {
    vi.mocked(clipboard.writeText).mockReturnValue(undefined as any)
    await expect(safeClipboard.writeText('hello world')).resolves.toBeUndefined()
    expect(clipboard.writeText).toHaveBeenCalledWith('hello world')
  })

  it('支持 Electron 45 异步返回 Promise 的 writeText', async () => {
    vi.mocked(clipboard.writeText).mockResolvedValue(undefined as never)
    await expect(safeClipboard.writeText('hello async')).resolves.toBeUndefined()
    expect(clipboard.writeText).toHaveBeenCalledWith('hello async')
  })

  it('支持 Electron 32 同步返回的 readText', async () => {
    vi.mocked(clipboard.readText).mockReturnValue('sync text' as any)
    const text = await safeClipboard.readText()
    expect(text).toBe('sync text')
    expect(clipboard.readText).toHaveBeenCalled()
  })

  it('支持 Electron 45 异步返回 Promise 的 readText', async () => {
    vi.mocked(clipboard.readText).mockResolvedValue('async text' as never)
    const text = await safeClipboard.readText()
    expect(text).toBe('async text')
    expect(clipboard.readText).toHaveBeenCalled()
  })

  it('支持同步与异步 safeClipboard.write 数据写入', async () => {
    vi.mocked(clipboard.write).mockReturnValue(undefined as any)
    await expect(
      safeClipboard.write({ text: 'sample', bookmark: 'bookmark' })
    ).resolves.toBeUndefined()
    expect(clipboard.write).toHaveBeenCalledWith({ text: 'sample', bookmark: 'bookmark' })
  })
})
