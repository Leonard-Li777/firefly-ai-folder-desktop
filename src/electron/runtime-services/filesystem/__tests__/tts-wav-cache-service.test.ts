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

  it('路线 A: saveChunk 支持乱序写入、readChunk 独立读盘，集齐后自动触发 assembleFinalWav 并内嵌精确时间戳索引表', async () => {
    vi.spyOn(service, 'resolveWorkspaceForPath').mockResolvedValue(tempDir)

    const fakeFilePath = path.join(tempDir, 'sample_novel.txt')
    const totalChunks = 3

    // 模拟 3 句合成音频数据
    const pcmChunk0 = Buffer.alloc(48000)
    const pcmChunk1 = Buffer.alloc(24000)
    const pcmChunk2 = Buffer.alloc(48000)

    // 1. 模拟用户先合成了第 0 句并落盘
    const res0 = await service.saveChunk({
      filePath: fakeFilePath,
      fileFingerprint: 'novel_fp_001',
      fieldName: 'summary',
      displayName: '测试音色',
      voiceId: 'voice_1',
      sid: 101,
      speed: 1.0,
      chunkIndex: 0,
      totalChunks,
      chunkData: pcmChunk0
    })
    expect(res0).toBe(true)

    // 验证分片 0 已写入磁盘，可通过 readChunk 独立读出
    const readChunk0 = await service.readChunk({
      filePath: fakeFilePath,
      fileFingerprint: 'novel_fp_001',
      fieldName: 'summary',
      voiceId: 'voice_1',
      chunkIndex: 0
    })
    expect(readChunk0).not.toBeNull()
    expect(readChunk0!.length).toBeGreaterThanOrEqual(48000)

    // 验证尚未合成的分片 1 读出为 null
    const readChunk1Empty = await service.readChunk({
      filePath: fakeFilePath,
      fileFingerprint: 'novel_fp_001',
      fieldName: 'summary',
      voiceId: 'voice_1',
      chunkIndex: 1
    })
    expect(readChunk1Empty).toBeNull()

    // 2. 模拟用户跳播到第 2 句（乱序保存第 2 句）
    const res2 = await service.saveChunk({
      filePath: fakeFilePath,
      fileFingerprint: 'novel_fp_001',
      fieldName: 'summary',
      displayName: '测试音色',
      voiceId: 'voice_1',
      sid: 101,
      speed: 1.0,
      chunkIndex: 2,
      totalChunks,
      chunkData: pcmChunk2
    })
    expect(res2).toBe(true)

    // 检查此时仍未集齐（缺第 1 句），母带文件尚不存在
    const expectedMasterPath = await service.getCacheWavPath({
      filePath: fakeFilePath,
      fileFingerprint: 'novel_fp_001',
      fieldName: 'summary',
      displayName: '测试音色',
      voiceId: 'voice_1',
      speed: 1.0
    })
    expect(fs.existsSync(expectedMasterPath!)).toBe(false)

    // 3. 补齐第 1 句，集齐全部 3 个分片，应触发自动无损合并
    const res1 = await service.saveChunk({
      filePath: fakeFilePath,
      fileFingerprint: 'novel_fp_001',
      fieldName: 'summary',
      displayName: '测试音色',
      voiceId: 'voice_1',
      sid: 101,
      speed: 1.0,
      chunkIndex: 1,
      totalChunks,
      chunkData: pcmChunk1
    })
    expect(res1).toBe(true)

    // 4. 验证母带 WAV 已经由 assembleFinalWav 自动组装生成！
    expect(fs.existsSync(expectedMasterPath!)).toBe(true)

    // 5. 验证母带的元数据与内嵌的精确分片时间戳索引表 (TTSChunkCue[])
    const masterMeta = await service.readWavMetadata(expectedMasterPath!)
    expect(masterMeta).not.toBeNull()
    expect(masterMeta?.completed).toBe(true)
    expect(masterMeta?.total).toBe(3)
    expect(masterMeta?.done).toBe(3)
    expect(masterMeta?.chunks).toBeDefined()
    expect(masterMeta?.chunks?.length).toBe(3)

    // 验证各句的时间戳起止与时序连续性（严格递增）
    const chunks = masterMeta!.chunks!
    expect(chunks[0].index).toBe(0)
    expect(chunks[0].startTime).toBe(0)
    expect(chunks[0].duration).toBeGreaterThan(0)

    expect(chunks[1].index).toBe(1)
    expect(chunks[1].startTime).toBeCloseTo(chunks[0].duration, 2)
    expect(chunks[1].duration).toBeGreaterThan(0)

    expect(chunks[2].index).toBe(2)
    expect(chunks[2].startTime).toBeCloseTo(chunks[0].duration + chunks[1].duration, 2)
    expect(chunks[2].duration).toBeGreaterThan(0)

    // 6. 验证临时分片池目录已被自动清理
    const chunksDir = await service.getChunksDirPath({
      filePath: fakeFilePath,
      fileFingerprint: 'novel_fp_001',
      fieldName: 'summary',
      voiceId: 'voice_1'
    })
    expect(fs.existsSync(chunksDir!)).toBe(false)
  })
})

