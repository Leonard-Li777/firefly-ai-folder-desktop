import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  NATIVE_IMAGE_EXTENSIONS,
  toSafeFileUrl,
  isParentPath,
  resolveThumbnailUrl
} from '../thumbnail-url-utils'

// 隔离全局 store：跨工作区串扰防护的兜底分支会读取当前工作区
const mockGetState = vi.fn()
vi.mock('../../../../stores/virtual-directory-store', () => ({
  useVirtualDirectoryStore: {
    getState: () => mockGetState()
  }
}))

describe('toSafeFileUrl', () => {
  it('将 Windows 绝对路径编码为安全的 file:/// URL', () => {
    expect(toSafeFileUrl('G:\\person\\h\\av\\10.jpg')).toBe('file:///G:/person/h/av/10.jpg')
  })

  it('编码中文、空格、方括号等特殊字符，防止 ERR_FILE_NOT_FOUND', () => {
    expect(toSafeFileUrl('G:\\person\\h\\av\\[图片]ai 26.8mb tool & analysis.png')).toBe(
      'file:///G:/person/h/av/%5B%E5%9B%BE%E7%89%87%5Dai%2026.8mb%20tool%20%26%20analysis.png'
    )
  })

  it('已是 file:// 开头的 URL 原样返回', () => {
    const url = 'file:///G:/a/b.png'
    expect(toSafeFileUrl(url)).toBe(url)
  })

  it('空值返回空字符串', () => {
    expect(toSafeFileUrl('')).toBe('')
  })
})

describe('isParentPath', () => {
  beforeEach(() => {
    mockGetState.mockReturnValue({ currentWorkspaceDirectory: null })
  })

  it('统一斜杠并忽略大小写判断父子关系', () => {
    expect(isParentPath('G:\\person\\h', 'G:/Person/H/AV/10.jpg')).toBe(true)
    expect(isParentPath('G:\\person\\h', 'G:\\person\\other\\10.jpg')).toBe(false)
    expect(isParentPath('G:\\person\\h', 'G:\\person\\h')).toBe(true)
  })
})

describe('resolveThumbnailUrl', () => {
  beforeEach(() => {
    mockGetState.mockReturnValue({ currentWorkspaceDirectory: null })
  })

  it('原生图片且 thumb 为空时，直接以原图绝对路径直显', () => {
    const result = resolveThumbnailUrl('', 'G:\\person\\h\\av\\10.jpg', 'G:\\person\\h\\av')
    expect(result).toBe('file:///G:/person/h/av/10.jpg')
  })

  it('thumb 只是图片自身文件名时，采信 filePath 原文而非错误拼接', () => {
    const result = resolveThumbnailUrl('10.jpg', 'G:\\person\\h\\av\\10.jpg', 'G:\\person\\h\\av')
    expect(result).toBe('file:///G:/person/h/av/10.jpg')
  })

  it('绝对缩略图路径直接编码返回', () => {
    const result = resolveThumbnailUrl(
      'G:\\person\\h\\av\\.thumbnail\\frame.webp',
      'G:\\person\\h\\av\\video.mp4',
      'G:\\person\\h\\av'
    )
    expect(result).toBe('file:///G:/person/h/av/.thumbnail/frame.webp')
  })

  it('相对缩略图路径基于合法工作区拼接', () => {
    const result = resolveThumbnailUrl(
      '.VirtualDirectory/.thumbnail/frame.webp',
      'G:\\person\\h\\av\\video.mp4',
      'G:\\person\\h\\av'
    )
    expect(result).toBe('file:///G:/person/h/av/.VirtualDirectory/.thumbnail/frame.webp')
  })

  it('跨工作区串扰：workspaceDirectoryPath 与文件不归属时，绝不使用错误工作区拼接', () => {
    mockGetState.mockReturnValue({ currentWorkspaceDirectory: null })
    const result = resolveThumbnailUrl(
      '.VirtualDirectory/.thumbnail/frame.webp',
      'G:\\person\\h\\av\\video.mp4',
      'D:\\wrong\\workspace'
    )
    // 错误工作区被拒绝；从 filePath 自身推导工作区 G:/person/h/av
    expect(result).toBe('file:///G:/person/h/av/.VirtualDirectory/.thumbnail/frame.webp')
    expect(result).not.toContain('wrong')
  })

  it('无法推导工作区但文件为图片时，平滑降级使用原图', () => {
    // 纯文件名无任何目录分隔符，推导不出工作区，此时降级为原图直显
    const result = resolveThumbnailUrl('.thumbnail/frame.webp', '10.jpg', null)
    expect(result).toBe('file:///10.jpg')
  })

  it('非图片且无任何可用缩略图信息时返回空', () => {
    expect(resolveThumbnailUrl(null, 'G:\\av\\doc.pdf', null)).toBe('')
  })

  it('NATIVE_IMAGE_EXTENSIONS 覆盖常见网页原生图片格式', () => {
    expect(NATIVE_IMAGE_EXTENSIONS.has('jpg')).toBe(true)
    expect(NATIVE_IMAGE_EXTENSIONS.has('png')).toBe(true)
    expect(NATIVE_IMAGE_EXTENSIONS.has('webp')).toBe(true)
    expect(NATIVE_IMAGE_EXTENSIONS.has('pdf')).toBe(false)
  })
})
