import { describe, it, expect, vi, beforeEach } from 'vitest'
import { safeClipboard } from '../safe-clipboard'
import * as electron from 'electron'
import { pathToFileURL } from 'node:url'
import * as path from 'node:path'

vi.mock('electron', () => {
  return {
    clipboard: {
      writeText: vi.fn(),
      readText: vi.fn(),
      write: vi.fn(),
      writeBuffer: vi.fn()
    },
    ClipboardItem: undefined
  }
})

describe('safeClipboard 跨版本平滑适配层', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(electron as any).ClipboardItem = undefined
  })

  it('支持 Electron 32 同步返回的 writeText', async () => {
    vi.mocked(electron.clipboard.writeText).mockReturnValue(undefined as any)
    await expect(safeClipboard.writeText('hello world')).resolves.toBeUndefined()
    expect(electron.clipboard.writeText).toHaveBeenCalledWith('hello world')
  })

  it('支持 Electron 45 异步返回 Promise 的 writeText', async () => {
    vi.mocked(electron.clipboard.writeText).mockResolvedValue(undefined as never)
    await expect(safeClipboard.writeText('hello async')).resolves.toBeUndefined()
    expect(electron.clipboard.writeText).toHaveBeenCalledWith('hello async')
  })

  it('支持 Electron 32 同步返回的 readText', async () => {
    vi.mocked(electron.clipboard.readText).mockReturnValue('sync text' as any)
    const text = await safeClipboard.readText()
    expect(text).toBe('sync text')
    expect(electron.clipboard.readText).toHaveBeenCalled()
  })

  it('支持 Electron 45 异步返回 Promise 的 readText', async () => {
    vi.mocked(electron.clipboard.readText).mockResolvedValue('async text' as never)
    const text = await safeClipboard.readText()
    expect(text).toBe('async text')
    expect(electron.clipboard.readText).toHaveBeenCalled()
  })

  describe('writeFiles 复制文件到剪贴板', () => {
    it('在 Electron 45 下自动使用 ClipboardItem 封装 text/uri-list', async () => {
      class MockClipboardItem {
        items: Record<string, any>
        constructor(items: Record<string, any>) {
          this.items = items
        }
      }
      ;(electron as any).ClipboardItem = MockClipboardItem
      vi.mocked(electron.clipboard.write).mockResolvedValue(undefined as never)

      const filePath = path.resolve('test-file.txt')
      const expectedUri = pathToFileURL(filePath).href

      await safeClipboard.writeFiles([filePath])

      expect(electron.clipboard.write).toHaveBeenCalledTimes(1)
      const callArg = vi.mocked(electron.clipboard.write).mock.calls[0][0] as any[]
      expect(Array.isArray(callArg)).toBe(true)
      expect(callArg[0]).toBeInstanceOf(MockClipboardItem)
      expect(callArg[0].items['text/uri-list']).toBe(expectedUri)
      expect(callArg[0].items['text/plain']).toBe(filePath)
    })

    it('在 Electron 32 下回退使用 writeBuffer 和旧版 filenames 写入', async () => {
      ;(electron as any).ClipboardItem = undefined
      vi.mocked(electron.clipboard.write).mockReturnValue(undefined as any)

      const filePath = path.resolve('test-file.txt')
      const expectedUri = pathToFileURL(filePath).href

      await safeClipboard.writeFiles([filePath])

      expect(electron.clipboard.writeBuffer).toHaveBeenCalledWith(
        'text/uri-list',
        Buffer.from(expectedUri)
      )
      expect(electron.clipboard.write).toHaveBeenCalledWith({
        text: filePath,
        filenames: [filePath]
      })
    })

    it('空路径列表安全跳过', async () => {
      await safeClipboard.writeFiles([])
      expect(electron.clipboard.write).not.toHaveBeenCalled()
    })
  })

  describe('write 通用自适应写入', () => {
    it('在 Electron 45 下将旧版对象自动转换为 ClipboardItem 数组', async () => {
      class MockClipboardItem {
        items: Record<string, any>
        constructor(items: Record<string, any>) {
          this.items = items
        }
      }
      ;(electron as any).ClipboardItem = MockClipboardItem
      vi.mocked(electron.clipboard.write).mockResolvedValue(undefined as never)

      await safeClipboard.write({ text: 'sample', html: '<b>sample</b>' })

      expect(electron.clipboard.write).toHaveBeenCalledTimes(1)
      const callArg = vi.mocked(electron.clipboard.write).mock.calls[0][0] as any[]
      expect(Array.isArray(callArg)).toBe(true)
      expect(callArg[0].items['text/plain']).toBe('sample')
      expect(callArg[0].items['text/html']).toBe('<b>sample</b>')
    })

    it('在 Electron 32 下直接透传旧版对象', async () => {
      ;(electron as any).ClipboardItem = undefined
      vi.mocked(electron.clipboard.write).mockReturnValue(undefined as any)

      await safeClipboard.write({ text: 'legacy sample' })

      expect(electron.clipboard.write).toHaveBeenCalledWith({ text: 'legacy sample' })
    })
  })
})
