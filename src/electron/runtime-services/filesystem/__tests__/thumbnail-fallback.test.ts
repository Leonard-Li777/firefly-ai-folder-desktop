import { describe, it, expect, vi, beforeEach } from 'vitest'
import { thumbnailService } from '../thumbnail-service'
import { nativeImage } from 'electron'
import sharp from 'sharp'
import fs from 'node:fs/promises'

// Mock Electron nativeImage
vi.mock('electron', () => ({
  nativeImage: {
    createFromPath: vi.fn(),
    createThumbnailFromPath: undefined // 模拟 Linux/某些版本缺失该方法
  },
  app: {
    isPackaged: false,
    getPath: vi.fn().mockReturnValue('/tmp'),
    getAppPath: vi.fn().mockReturnValue('/mock/app/path')
  }
}))

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
  return { default: sharpMock }
})

vi.mock('node:fs/promises', () => ({
  default: {
    access: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ size: 1000 })
  }
}))

describe('ThumbnailService Fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('当 nativeImage 方法缺失时，应使用 Sharp 作为回退', async () => {
    const options = {
      fileId: 'test-hash',
      filePath: 'test.jpg',
      smartName: 'test.jpg',
      workspaceDirectoryPath: '/mock/workspace'
    }

    const result = await thumbnailService.generateThumbnail(options)

    // 验证 Sharp 被调用
    expect(sharp).toHaveBeenCalledWith('test.jpg')
    expect(result.success).toBe(true)
    expect(result.method).toBe('sharp') // 更新为期待 'sharp' 而不是 'native'
  })
})
