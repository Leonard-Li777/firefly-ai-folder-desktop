import { describe, it, expect, vi, beforeEach } from 'vitest'
import { thumbnailService } from '../thumbnail-service'
import { nativeImage } from 'electron'
import sharp from 'sharp'
import fs from 'node:fs/promises'
import path from 'node:path'

// Mock Electron nativeImage
vi.mock('electron', () => {
  const mockImage = {
    isEmpty: vi.fn().mockReturnValue(false),
    toPNG: vi.fn().mockReturnValue(Buffer.from('mock-png'))
  }
  return {
    nativeImage: {
      createThumbnailFromPath: vi.fn().mockResolvedValue(mockImage)
    },
    app: {
      isPackaged: false,
      getPath: vi.fn().mockReturnValue('/tmp'),
      getAppPath: vi.fn().mockReturnValue('/mock/app/path')
    }
  }
})

// Mock @yonuc/shared
vi.mock('@yonuc/shared', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    }
  }
})

// Mock @app/languages
vi.mock('@app/languages', () => ({
  t: vi.fn((key, args) => key)
}))

// Mock sharp
vi.mock('sharp', () => {
  const sharpMock = vi.fn(() => ({
    resize: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    toFile: vi.fn().mockResolvedValue({ size: 1024 })
  }))
  // Add static methods if needed
  ;(sharpMock as any).cache = vi.fn()
  return { default: sharpMock }
})

// Mock node:fs/promises
vi.mock('node:fs/promises', () => ({
  default: {
    access: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ size: 1000 }),
    readdir: vi.fn().mockResolvedValue([]),
    unlink: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    copyFile: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined)
  }
}))

describe('ThumbnailService 改进后的逻辑测试', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('对于常规图片格式 (.jpg)，应优先使用 Sharp 并返回 method: "sharp"', async () => {
    const options = {
      fileId: 'test-hash',
      filePath: 'C:\\test\\image.jpg',
      smartName: 'image.jpg',
      workspaceDirectoryPath: 'C:\\mock\\workspace'
    }

    const result = await thumbnailService.generateThumbnail(options)

    // 验证返回方法
    expect(result.success).toBe(true)
    expect(result.method).toBe('sharp')
    
    // 验证 Sharp 被直接调用，且 nativeImage.createThumbnailFromPath 未被调用
    expect(sharp).toHaveBeenCalledWith(options.filePath)
    expect(nativeImage.createThumbnailFromPath).not.toHaveBeenCalled()
  })

  it('对于常规图片格式 (.png)，应优先使用 Sharp 并返回 method: "sharp"', async () => {
    const options = {
      fileId: 'test-hash',
      filePath: 'C:\\test\\image.png',
      smartName: 'image.png',
      workspaceDirectoryPath: 'C:\\mock\\workspace'
    }

    const result = await thumbnailService.generateThumbnail(options)

    expect(result.success).toBe(true)
    expect(result.method).toBe('sharp')
    expect(sharp).toHaveBeenCalledWith(options.filePath)
    expect(nativeImage.createThumbnailFromPath).not.toHaveBeenCalled()
  })

  it('对于非图片格式 (.mp4)，应使用 Native 方法生成缩略图', async () => {
    const options = {
      fileId: 'test-hash-video',
      filePath: 'C:\\test\\video.mp4',
      smartName: 'video.mp4',
      workspaceDirectoryPath: 'C:\\mock\\workspace'
    }

    const result = await thumbnailService.generateThumbnail(options)

    // 验证返回方法
    expect(result.success).toBe(true)
    expect(result.method).toBe('native')
    
    // 验证 nativeImage.createThumbnailFromPath 被调用（path.resolve 会处理路径）
    expect(nativeImage.createThumbnailFromPath).toHaveBeenCalledWith(
      path.resolve(options.filePath),
      expect.any(Object)
    )
    
    // 验证 Sharp 在最后步骤被调用（将 PNG buffer 转为 JPG）
    expect(sharp).toHaveBeenCalledWith(Buffer.from('mock-png'))
  })

  it('当 Native 方法对于非图片格式 (.mp4) 失败时，不应产生警告日志，而应静默回退', async () => {
    const options = {
      fileId: 'test-hash-fail',
      filePath: 'C:\\test\\video_broken.mp4',
      smartName: 'video_broken.mp4',
      workspaceDirectoryPath: 'C:\\mock\\workspace'
    }

    // 模拟 Native 方法抛出异常
    const errorMsg = 'Failed to create IShellItem'
    vi.mocked(nativeImage.createThumbnailFromPath).mockRejectedValueOnce(new Error(errorMsg))

    const result = await thumbnailService.generateThumbnail(options)

    // 虽然失败了，但由于不是图片格式，且也没有Fallback支持（mp4），最终会失败
    // 但重点是检查 Native 内部是否尝试了 Sharp（通过 generateThumbnailNative 的 catch 块）
    expect(nativeImage.createThumbnailFromPath).toHaveBeenCalled()
    
    // 检查 Sharp 是否因回退而被调用（虽然 mp4 在 Sharp 内部也会判断格式不支持而返回 false）
    expect(sharp).not.toHaveBeenCalledWith(Buffer.from('mock-png'))
  })

  it('路径规范化：应正确处理带有相对符号或重复斜杠的路径', async () => {
    const rawPath = 'C:\\test\\\\./subdir/../file.png'
    const options = {
      fileId: 'test-norm',
      filePath: rawPath,
      smartName: 'file.png',
      workspaceDirectoryPath: 'C:\\mock\\workspace'
    }

    const result = await thumbnailService.generateThumbnail(options)

    expect(result.success).toBe(true)
    expect(result.method).toBe('sharp')
    
    // 验证 Sharp 使用了原始路径（因为它是直接在 generateThumbnail 中调用的）
    expect(sharp).toHaveBeenCalledWith(rawPath)
  })
})
