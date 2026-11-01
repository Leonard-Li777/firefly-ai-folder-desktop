import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { copyTextToClipboard } from '../clipboard'

describe('copyTextToClipboard 渲染层通用安全封装', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('优先使用 window.electronAPI.utils.copyTextToClipboard', async () => {
    const copyMock = vi.fn().mockResolvedValue({ success: true })
    vi.stubGlobal('window', {
      electronAPI: {
        utils: {
          copyTextToClipboard: copyMock
        }
      }
    })

    const result = await copyTextToClipboard('test copy')
    expect(result).toBe(true)
    expect(copyMock).toHaveBeenCalledWith('test copy')
  })

  it('在 electronAPI 失败时自动降级到 navigator.clipboard', async () => {
    const copyMock = vi.fn().mockRejectedValue(new Error('IPC failed'))
    const navWriteMock = vi.fn().mockResolvedValue(undefined)

    vi.stubGlobal('window', {
      electronAPI: {
        utils: {
          copyTextToClipboard: copyMock
        }
      }
    })
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: navWriteMock
      }
    })

    const result = await copyTextToClipboard('test fallback')
    expect(result).toBe(true)
    expect(copyMock).toHaveBeenCalledWith('test fallback')
    expect(navWriteMock).toHaveBeenCalledWith('test fallback')
  })

  it('对非 string 类型的输入（如 null/数字）执行安全类型转换', async () => {
    const copyMock = vi.fn().mockResolvedValue({ success: true })
    vi.stubGlobal('window', {
      electronAPI: {
        utils: {
          copyTextToClipboard: copyMock
        }
      }
    })

    await copyTextToClipboard(12345 as any)
    expect(copyMock).toHaveBeenCalledWith('12345')

    await copyTextToClipboard(null as any)
    expect(copyMock).toHaveBeenCalledWith('')
  })
})
