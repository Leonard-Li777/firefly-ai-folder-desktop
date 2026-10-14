import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

vi.mock('electron', () => ({
  shell: {
    showItemInFolder: vi.fn()
  },
  app: {
    getPath: vi.fn().mockReturnValue('C:\\test'),
    getName: vi.fn().mockReturnValue('firefly')
  }
}))

vi.mock('electron-conf', () => ({
  Conf: class {
    get() { return {} }
    set() {}
  }
}))

import { TTSWavCacheService } from '../tts-wav-cache-service'

describe('TTSWavCacheService 单元测试', () => {
  let service: TTSWavCacheService
  let tempDir: string

  beforeEach(() => {
    service = new TTSWavCacheService()
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-cache-test-'))
  })

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // 忽略清理临时目录错误
    }
  })

  it('generateCacheFileName 应生成符合标准母带规范的文件名', () => {
    const fileName1 = service.generateCacheFileName('abc12345', 'summary', 1.0, 44)
    expect(fileName1).toBe('abc12345_summary_1x_44.wav')

    const fileName2 = service.generateCacheFileName('fp987654', 'multimodalContent', 1.25, 0)
    expect(fileName2).toBe('fp987654_multimodalContent_1.25x_0.wav')

    // 预览/试听音色：无文件指纹干扰，统一以 preview_ 开头
    const fileNamePreview = service.generateCacheFileName('preview', '我的音色', 1.0, 'custom_12345')
    expect(fileNamePreview).toBe('preview_我的音色_1x_custom_12345.wav')

    const fileNamePreviewSpeed = service.generateCacheFileName('preview', 'Donald Trump', 1.5, 'donald_trump')
    expect(fileNamePreviewSpeed).toBe('preview_Donald_Trump_1.5x_donald_trump.wav')
  })

  it('appendWavChunk 与 readWavMetadata: 支持单句创建与元数据解析', async () => {
    const testWavPath = path.join(tempDir, 'test_output.wav')

    // 模拟 1 秒钟 24kHz 16-bit Mono PCM 数据 (48000 字节)
    const mockPcm = Buffer.alloc(4800)

    const appendSuccess = await service.appendWavChunk({
      wavPath: testWavPath,
      chunkData: mockPcm,
      chunkIndex: 0,
      totalChunks: 2,
      sid: 44,
      speed: 1.0,
      fileFingerprint: 'test_fp',
      fieldName: 'summary'
    })

    expect(appendSuccess).toBe(true)
    expect(fs.existsSync(testWavPath)).toBe(true)

    // 读取并验证元数据
    const meta = await service.readWavMetadata(testWavPath)
    expect(meta).not.toBeNull()
    expect(meta?.completed).toBe(false)
    expect(meta?.total).toBe(2)
    expect(meta?.done).toBe(1)
    expect(meta?.sid).toBe(44)
    expect(meta?.speed).toBe(1.0)
    expect(meta?.fingerprint).toBe('test_fp')
    expect(meta?.fieldName).toBe('summary')
  })

  it('appendWavChunk 增量断点追加写入至完成 (completed: true)', async () => {
    const testWavPath = path.join(tempDir, 'test_resumable.wav')

    // 第 1 句写入
    await service.appendWavChunk({
      wavPath: testWavPath,
      chunkData: Buffer.alloc(2400),
      chunkIndex: 0,
      totalChunks: 2,
      sid: 44,
      speed: 1.25,
      fileFingerprint: 'resumable_fp',
      fieldName: 'ocr'
    })

    let meta = await service.readWavMetadata(testWavPath)
    expect(meta?.completed).toBe(false)
    expect(meta?.done).toBe(1)

    // 第 2 句增量追加
    await service.appendWavChunk({
      wavPath: testWavPath,
      chunkData: Buffer.alloc(2400),
      chunkIndex: 1,
      totalChunks: 2,
      sid: 44,
      speed: 1.25,
      fileFingerprint: 'resumable_fp',
      fieldName: 'ocr'
    })

    meta = await service.readWavMetadata(testWavPath)
    expect(meta?.completed).toBe(true)
    expect(meta?.done).toBe(2)
    expect(meta?.total).toBe(2)

    // 验证 readWavFile 返回完整数据
    const fullBuffer = await service.readWavFile(testWavPath)
    expect(fullBuffer).not.toBeNull()
    expect(fullBuffer!.byteLength).toBeGreaterThan(4800)
  })

  it('readWavMetadata 对于不存在或损坏的文件应优雅返回 null', async () => {
    const notExist = await service.readWavMetadata(path.join(tempDir, 'not_found.wav'))
    expect(notExist).toBeNull()

    const corruptedPath = path.join(tempDir, 'corrupted.wav')
    fs.writeFileSync(corruptedPath, Buffer.from('NOT_A_VALID_RIFF_HEADER'))
    const corruptedMeta = await service.readWavMetadata(corruptedPath)
    expect(corruptedMeta).toBeNull()
  })
})
