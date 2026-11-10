import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock modular-resource-service
const mockActiveModules: Record<string, any> = {}
vi.mock('../../system/modular-resource-service', () => ({
  modularResourceService: {
    getActiveModuleBySlot: vi.fn((slot: string) => mockActiveModules[slot] ?? null)
  }
}))

// Mock omniService
const mockTranscribeAudio = vi.fn()
vi.mock('../../system/omni-service', () => ({
  omniService: {
    transcribeAudio: (...args: any[]) => mockTranscribeAudio(...args)
  }
}))

// Mock omniClient
const mockSynthesizeTTSChunk = vi.fn()
const mockSplitTTSChunks = vi.fn()
vi.mock('../../../services/omni-client', () => ({
  omniClient: {
    synthesizeTTSChunk: (...args: any[]) => mockSynthesizeTTSChunk(...args),
    splitTTSChunks: (...args: any[]) => mockSplitTTSChunks(...args)
  }
}))

import {
  VoiceSeamDispatcher,
  VoiceSeamError,
  stripWavHeader,
  createWavFromPcm,
  splitTextIntoSentences,
  voiceSeamDispatcher
} from '../voice-seam-dispatcher'
import { M5HybridSampler, loadVoicePromptCodes, type M5VoiceMeta } from '../m5-tts-engine'

describe('VoiceSeamDispatcher (Ticket 04) 语音中继调度与 PCM 流式测试', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete mockActiveModules['voice_asr']
    delete mockActiveModules['voice_tts']
  })

  describe('WAV 编解码与分句辅助函数', () => {
    it('createWavFromPcm 生成合法 44 字节头部且能被 stripWavHeader 完美还原', () => {
      const originalPcm = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
      const wavBuffer = createWavFromPcm(originalPcm, 48000, 1, 16)

      expect(wavBuffer.byteLength).toBe(44 + 8)
      const view = new DataView(wavBuffer)
      // "RIFF"
      expect(view.getUint32(0, false)).toBe(0x52494646)
      // "WAVE"
      expect(view.getUint32(8, false)).toBe(0x57415645)
      // sampleRate 48000
      expect(view.getUint32(24, true)).toBe(48000)
      // numChannels 1
      expect(view.getUint16(22, true)).toBe(1)

      const recoveredPcm = stripWavHeader(wavBuffer)
      expect(recoveredPcm).toEqual(originalPcm)
    })

    it('stripWavHeader 对小于 44 字节或非 WAV 格式原样返回', () => {
      const raw = new Uint8Array([10, 20, 30])
      expect(stripWavHeader(raw.buffer)).toEqual(raw)

      const fakeHeader = new Uint8Array(44)
      expect(stripWavHeader(fakeHeader.buffer)).toEqual(fakeHeader)
    })

    it('splitTextIntoSentences 按标点合理切分句子', () => {
      expect(splitTextIntoSentences('')).toEqual([])
      const parts = splitTextIntoSentences('你好！今天天气真好。我们去散步吧？')
      expect(parts.length).toBe(3)
      expect(parts[0]).toBe('你好！')
      expect(parts[1]).toBe('今天天气真好。')
      expect(parts[2]).toBe('我们去散步吧？')
    })
  })

  describe('transcribe (语音转录)', () => {
    it('未激活 ASR 插件时抛出强类型 VoiceSeamError(NO_ACTIVE_PLUGIN)', async () => {
      await expect(voiceSeamDispatcher.transcribe('C:/dummy/audio.wav')).rejects.toThrow(
        VoiceSeamError
      )

      try {
        await voiceSeamDispatcher.transcribe('C:/dummy/audio.wav')
      } catch (err: any) {
        expect(err.code).toBe('NO_ACTIVE_PLUGIN')
      }
    })

    it('激活 ASR 插件后支持文件路径入参并返回规范化 TranscriptionResult', async () => {
      mockActiveModules['voice_asr'] = {
        id: 'asr_sensevoice_onnx',
        capability_slot: 'voice_asr',
        backend_type: 'omni_onnx'
      }

      mockTranscribeAudio.mockResolvedValueOnce({
        file_path: 'C:/test/sample.wav',
        transcript: '你好世界',
        events: [],
        language: 'zh',
        duration_ms: 1500
      })

      const res = await voiceSeamDispatcher.transcribe('C:/test/sample.wav', {
        language: 'zh'
      })

      expect(res).toEqual({
        text: '你好世界',
        language: 'zh',
        durationSec: 1.5,
        segments: undefined
      })
      expect(mockTranscribeAudio).toHaveBeenCalledWith(
        'C:/test/sample.wav',
        expect.objectContaining({ language: 'zh' })
      )
    })

    it('传入内存 Buffer 时安全创建临时文件、调用转录并在 finally 中删除临时文件', async () => {
      mockActiveModules['voice_asr'] = {
        id: 'asr_sensevoice_onnx',
        capability_slot: 'voice_asr',
        backend_type: 'omni_onnx'
      }

      let capturedTmpPath = ''
      mockTranscribeAudio.mockImplementationOnce(async (tmpPath: string) => {
        capturedTmpPath = tmpPath
        return {
          file_path: tmpPath,
          transcript: '内存转录测试',
          events: [],
          language: 'zh',
          duration_ms: 2000
        }
      })

      const audioBuffer = Buffer.from('RIFF....mock_audio_content')
      const res = await voiceSeamDispatcher.transcribe(audioBuffer)

      expect(res.text).toBe('内存转录测试')
      expect(capturedTmpPath).toContain('ff_asr_')
    })

    it('传入已 aborted 的 AbortSignal 时立即中止并抛出 ABORTED', async () => {
      mockActiveModules['voice_asr'] = {
        id: 'asr_sensevoice_onnx',
        capability_slot: 'voice_asr',
        backend_type: 'omni_onnx'
      }

      const controller = new AbortController()
      controller.abort()

      await expect(
        voiceSeamDispatcher.transcribe('C:/test/sample.wav', { signal: controller.signal })
      ).rejects.toThrow(VoiceSeamError)

      try {
        await voiceSeamDispatcher.transcribe('C:/test/sample.wav', { signal: controller.signal })
      } catch (err: any) {
        expect(err.code).toBe('ABORTED')
      }
    })
  })

  describe('synthesizeStream 与 synthesizeToWav (流式与整段合成)', () => {
    it('未激活 TTS 插件时抛出强类型 VoiceSeamError(NO_ACTIVE_PLUGIN)', async () => {
      const generator = voiceSeamDispatcher.synthesizeStream('测试文本')
      await expect(generator.next()).rejects.toThrow(VoiceSeamError)

      try {
        const gen2 = voiceSeamDispatcher.synthesizeStream('测试文本')
        await gen2.next()
      } catch (err: any) {
        expect(err.code).toBe('NO_ACTIVE_PLUGIN')
      }
    })

    it('激活 TTS 插件后流式输出纯 PCM 且 sampleRate 恒为 48000', async () => {
      mockActiveModules['voice_tts'] = {
        id: 'tts_moss_onnx',
        capability_slot: 'voice_tts',
        backend_type: 'omni_onnx'
      }

      // Mock Omni 分句返回 2 句
      mockSplitTTSChunks.mockResolvedValueOnce({
        chunks: ['第一句。', '第二句！'],
        totalChunks: 2,
        totalChars: 8
      })

      const rawPcm1 = new Uint8Array([1, 2, 3, 4])
      const rawPcm2 = new Uint8Array([5, 6, 7, 8])
      const wav1 = createWavFromPcm(rawPcm1, 48000, 1, 16)
      const wav2 = createWavFromPcm(rawPcm2, 48000, 1, 16)

      mockSynthesizeTTSChunk
        .mockResolvedValueOnce({ buffer: wav1, hitCap: false, steps: 100 })
        .mockResolvedValueOnce({ buffer: wav2, hitCap: false, steps: 120 })

      const chunks: any[] = []
      for await (const chunk of voiceSeamDispatcher.synthesizeStream('第一句。第二句！')) {
        chunks.push(chunk)
      }

      expect(chunks.length).toBe(2)

      expect(chunks[0].format).toBe('pcm_s16le')
      expect(chunks[0].sampleRate).toBe(48000)
      expect(chunks[0].channels).toBe(1)
      expect(chunks[0].data).toEqual(rawPcm1)
      expect(chunks[0].isLastChunk).toBe(false)

      expect(chunks[1].format).toBe('pcm_s16le')
      expect(chunks[1].sampleRate).toBe(48000)
      expect(chunks[1].channels).toBe(1)
      expect(chunks[1].data).toEqual(rawPcm2)
      expect(chunks[1].isLastChunk).toBe(true)
    })

    it('synthesizeToWav 拼合流式 PCM 并产出标准 WAV ArrayBuffer', async () => {
      mockActiveModules['voice_tts'] = {
        id: 'tts_moss_onnx',
        capability_slot: 'voice_tts',
        backend_type: 'omni_onnx'
      }

      mockSplitTTSChunks.mockResolvedValueOnce({
        chunks: ['整句。'],
        totalChunks: 1,
        totalChars: 3
      })

      const rawPcm = new Uint8Array([10, 20, 30, 40])
      const wav = createWavFromPcm(rawPcm, 48000, 1, 16)
      mockSynthesizeTTSChunk.mockResolvedValueOnce({ buffer: wav, hitCap: false, steps: 50 })

      const fullWav = await voiceSeamDispatcher.synthesizeToWav('整句。')
      expect(fullWav.byteLength).toBe(44 + 4)
      const recovered = stripWavHeader(fullWav)
      expect(recovered).toEqual(rawPcm)
    })

    it('synthesizeStream 传入空文本或空白字符时立即抛出 EMPTY_TEXT 错误', async () => {
      mockActiveModules['voice_tts'] = {
        id: 'tts_m5_onnx',
        capability_slot: 'voice_tts',
        backend_type: 'omni_onnx'
      }

      const emptyGen = voiceSeamDispatcher.synthesizeStream('   ')
      await expect(emptyGen.next()).rejects.toThrow(VoiceSeamError)

      try {
        const g2 = voiceSeamDispatcher.synthesizeStream('')
        await g2.next()
      } catch (err: any) {
        expect(err.code).toBe('EMPTY_TEXT')
      }
    })

    it('激活 tts_m5_onnx 后流式生成标准 48000Hz PCM 分片', async () => {
      mockActiveModules['voice_tts'] = {
        id: 'tts_m5_onnx',
        capability_slot: 'voice_tts',
        backend_type: 'omni_onnx'
      }

      const chunks: any[] = []
      for await (const chunk of voiceSeamDispatcher.synthesizeStream('测试 M5 极速语音合成')) {
        chunks.push(chunk)
      }

      expect(chunks.length).toBeGreaterThan(0)
      expect(chunks[0].format).toBe('pcm_s16le')
      expect(chunks[0].sampleRate).toBe(48000)
      expect(chunks[0].channels).toBe(1)
      expect(chunks[0].data.byteLength).toBeGreaterThan(0)
    })

    it('激活 tts_m5_onnx 时传入已中止的 AbortSignal 抛出 ABORTED', async () => {
      mockActiveModules['voice_tts'] = {
        id: 'tts_m5_onnx',
        capability_slot: 'voice_tts',
        backend_type: 'omni_onnx'
      }

      const controller = new AbortController()
      controller.abort()

      const gen = voiceSeamDispatcher.synthesizeStream('测试即刻中止', {
        signal: controller.signal
      })
      await expect(gen.next()).rejects.toThrow(VoiceSeamError)

      try {
        const g2 = voiceSeamDispatcher.synthesizeStream('测试即刻中止', {
          signal: controller.signal
        })
        await g2.next()
      } catch (err: any) {
        expect(err.code).toBe('ABORTED')
      }
    })
  })

  describe('M5HybridSampler 与音色二进制码本契约 (Spec §3.3 & §5.2)', () => {
    it('loadVoicePromptCodes 强制 4 字节对齐且越界立即阻断', () => {
      const buffer = new ArrayBuffer(1024)
      const mockMeta: M5VoiceMeta = {
        id: 'huoshan_zhumei',
        displayName: '火山朱美',
        gender: 'female',
        lang: 'zh',
        desc: '自然女声',
        recommended: true,
        promptTokenLength: 10, // 10 帧 * 16 层 * 4 字节 = 640 字节
        promptCodesOffset: 3 // 非 4 字节对齐
      }

      expect(() => loadVoicePromptCodes(buffer, mockMeta)).toThrow('PROMPT_CODE_OFFSET_UNALIGNED')

      // 越界测试
      const outOfBoundMeta: M5VoiceMeta = {
        ...mockMeta,
        promptCodesOffset: 500 // 500 + 640 = 1140 > 1024
      }
      expect(() => loadVoicePromptCodes(buffer, outOfBoundMeta)).toThrow(
        'PROMPT_CODE_RANGE_OUT_OF_BOUND'
      )

      // 合法加载
      const validMeta: M5VoiceMeta = {
        ...mockMeta,
        promptCodesOffset: 64 // 64 + 640 = 704 <= 1024
      }
      const codes = loadVoicePromptCodes(buffer, validMeta)
      expect(codes.length).toBe(10 * 16)
      expect(codes instanceof Int32Array).toBe(true)
    })

    it('M5HybridSampler 达到 maxFrames 强制返回 0 (EOS)', () => {
      const sampler = new M5HybridSampler(12345)
      const logits = new Float32Array([1.0, 5.0, 3.0, 2.0])
      // frameIndex = 100 >= maxFrames (100)
      const token = sampler.sampleC0(logits, 100, 10, { maxFrames: 100 })
      expect(token).toBe(0)
    })

    it('M5HybridSampler 在 frameIndex < minFrames 时屏蔽 EOS (0)', () => {
      const sampler = new M5HybridSampler(12345)
      // 让 EOS (索引 0) 的 logit 极大
      const logits = new Float32Array([100.0, 1.0, 1.0])
      // 文本长度 10，minFrames >= 15，当前 frameIndex = 2 < minFrames
      // temperature <= 0 贪心采样，若未屏蔽应选 0，屏蔽后应选 1
      const token = sampler.sampleC0(logits, 2, 10, { temperature: 0, minFrames: 15 })
      expect(token).toBe(1)
    })

    it('M5HybridSampler 贪心采样在允许 EOS 时正确选中最大值', () => {
      const sampler = new M5HybridSampler(12345)
      const logits = new Float32Array([1.0, 10.0, 2.0])
      const token = sampler.sampleC0(logits, 20, 10, { temperature: 0, minFrames: 5 })
      expect(token).toBe(1)
    })
  })
})
