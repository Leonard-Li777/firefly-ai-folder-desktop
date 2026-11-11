/**
 * 统一语音中继调度门面 (VoiceSeamDispatcher)
 * apps/desktop/src/electron/runtime-services/ai/voice-seam-dispatcher.ts
 *
 * 核心职责 (Ticket 04 / PRD & Spec §4.2):
 * 1. 向上层业务暴露统一的标准语音接口: transcribe, synthesizeStream, synthesizeToWav
 * 2. 依据当前激活的 ASR/TTS 插件透明分派至 OmniClient (现役) 或未来 ai-engine
 * 3. 对接 Omni 48kHz WAV 输出时，内部自动剥离 44 字节 RIFF/WAV 头部，向上层吐出保真 48kHz 的纯 PCM 数据分片 (AudioChunk)
 * 4. 未激活对应槽位插件时，统一抛出强类型错误 VoiceSeamError('NO_ACTIVE_PLUGIN')
 * 5. 全链路支持 AbortSignal 取消语义
 */

import * as fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { v4 as uuidv4 } from 'uuid'
import { logger, LogCategory } from '@firefly/shared'
import { modularResourceService } from '../system/modular-resource-service'
import { omniClient } from '../../services/omni-client'
import { omniService } from '../system/omni-service'

/** 统一语音转录输出模型 */
export interface TranscriptionResult {
  text: string
  language: string
  durationSec: number
  segments?: Array<{
    startMs: number
    endMs: number
    text: string
  }>
}

/** 统一流式音频块输出模型 (无头部标准线性 PCM 分片) */
export interface AudioChunk {
  /** 流式分片统一固定为标准线性 PCM 格式，消除 WAV 头部歧义 */
  format: 'pcm_s16le'
  /** 采样率 (Omni Moss-TTS 恒为 48000Hz) */
  sampleRate: number
  /** 声道数 (固定 1: 单声道) */
  channels: number
  /** 原始 PCM 线性 16-bit 采样字节流 (无 RIFF 容器头部) */
  data: Uint8Array
  /** 是否为终止分片 */
  isLastChunk: boolean
}

/** 统一语音服务标准接口 */
export interface IVoiceSeamService {
  /** 语音转录 (支持文件路径或内存音频 Buffer) */
  transcribe(
    audio: string | Buffer,
    options?: { language?: string; signal?: AbortSignal }
  ): Promise<TranscriptionResult>

  /** 流式语音合成 (纯 PCM 流) */
  synthesizeStream(
    text: string,
    options?: { voiceId?: string; speed?: number; signal?: AbortSignal }
  ): AsyncIterable<AudioChunk>

  /** 非流式整段音频合成 (直接返回标准带头部的 WAV 格式) */
  synthesizeToWav(
    text: string,
    options?: { voiceId?: string; speed?: number }
  ): Promise<ArrayBuffer>
}

export type VoiceSeamErrorCode =
  | 'NO_ACTIVE_PLUGIN'
  | 'INFERENCE_FAILED'
  | 'ABORTED'
  | 'EMPTY_TEXT'
  | 'UNSUPPORTED_BACKEND'

export class VoiceSeamError extends Error {
  readonly code: VoiceSeamErrorCode

  constructor(code: VoiceSeamErrorCode, message?: string) {
    super(message || `VoiceSeam error: ${code}`)
    this.name = 'VoiceSeamError'
    this.code = code
  }
}

/**
 * 24kHz 单声道 16-bit PCM 线性插值升采样至 48kHz（点数加倍，保真平滑）
 */
export function upsamplePcm24kTo48k(pcm24k: Uint8Array): Uint8Array {
  const sampleCount = Math.floor(pcm24k.byteLength / 2)
  if (sampleCount === 0) return new Uint8Array(0)
  const inView = new DataView(pcm24k.buffer, pcm24k.byteOffset, pcm24k.byteLength)
  const outBytes = sampleCount * 4
  const outBuf = new Uint8Array(outBytes)
  const outView = new DataView(outBuf.buffer, outBuf.byteOffset, outBytes)

  for (let i = 0; i < sampleCount; i++) {
    const s0 = inView.getInt16(i * 2, true)
    const s1 = i + 1 < sampleCount ? inView.getInt16((i + 1) * 2, true) : s0
    const sMid = Math.round((s0 + s1) / 2)
    outView.setInt16(i * 4, s0, true)
    outView.setInt16(i * 4 + 2, sMid, true)
  }
  return outBuf
}

/**
 * 从 WAV buffer 剥离头部并自适应归一化为 48000Hz PCM
 */
export function extractPcmNormalized48k(buffer: ArrayBuffer): Uint8Array {
  if (buffer.byteLength < 44) {
    return new Uint8Array(buffer)
  }
  const view = new DataView(buffer)
  let sampleRate = 48000
  if (view.getUint32(0, false) === 0x52494646 && view.getUint32(8, false) === 0x57415645) {
    sampleRate = view.getUint32(24, true)
  }
  const rawPcm = stripWavHeader(buffer)
  if (sampleRate === 24000) {
    return upsamplePcm24kTo48k(rawPcm)
  }
  return rawPcm
}

/**
 * 剥离标准 RIFF/WAV 头（44 字节或定位 data 子块）
 * 返回保真的 PCM 纯采样字节
 */
export function stripWavHeader(buffer: ArrayBuffer): Uint8Array {
  if (buffer.byteLength < 44) {
    return new Uint8Array(buffer)
  }
  const view = new DataView(buffer)
  // 'RIFF' (0x52494646) and 'WAVE' (0x57415645)
  if (view.getUint32(0, false) === 0x52494646 && view.getUint32(8, false) === 0x57415645) {
    // 标准 44 字节头部：Subchunk2ID 位于 36 为 'data' (0x64617461)
    if (view.getUint32(36, false) === 0x64617461) {
      return new Uint8Array(buffer.slice(44))
    }
    // 动态扫描 RIFF chunk 链查找 'data'
    let offset = 12
    while (offset + 8 <= buffer.byteLength) {
      const chunkId = view.getUint32(offset, false)
      const chunkSize = view.getUint32(offset + 4, true)
      if (chunkId === 0x64617461) {
        return new Uint8Array(buffer.slice(offset + 8))
      }
      offset += 8 + chunkSize
    }
    // 兜底剥离 44 字节
    return new Uint8Array(buffer.slice(44))
  }
  return new Uint8Array(buffer)
}

/**
 * 拼装标准 44 字节 RIFF/WAV 容器头部并封装为 ArrayBuffer
 */
export function createWavFromPcm(
  pcmData: Uint8Array,
  sampleRate: number = 48000,
  numChannels: number = 1,
  bitsPerSample: number = 16
): ArrayBuffer {
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8
  const blockAlign = (numChannels * bitsPerSample) / 8
  const buffer = new ArrayBuffer(44 + pcmData.byteLength)
  const view = new DataView(buffer)

  // "RIFF"
  view.setUint32(0, 0x52494646, false)
  // chunk size (36 + data size)
  view.setUint32(4, 36 + pcmData.byteLength, true)
  // "WAVE"
  view.setUint32(8, 0x57415645, false)
  // "fmt "
  view.setUint32(12, 0x666d7420, false)
  // subchunk1 size (16 for PCM)
  view.setUint32(16, 16, true)
  // audio format (1 = PCM)
  view.setUint16(20, 1, true)
  // num channels
  view.setUint16(22, numChannels, true)
  // sample rate
  view.setUint32(24, sampleRate, true)
  // byte rate
  view.setUint32(28, byteRate, true)
  // block align
  view.setUint16(32, blockAlign, true)
  // bits per sample
  view.setUint16(34, bitsPerSample, true)
  // "data"
  view.setUint32(36, 0x64617461, false)
  // data size
  view.setUint32(40, pcmData.byteLength, true)

  // 写入 PCM 采样数据
  new Uint8Array(buffer, 44).set(pcmData)
  return buffer
}

/**
 * 本地句子切分算法（标点切分与最大字数兜底）
 */
export function splitTextIntoSentences(text: string): string[] {
  if (!text || !text.trim()) return []
  const rawParts = text.split(/([。！？!?；;\n\r]+)/).filter(Boolean)
  const chunks: string[] = []
  let current = ''
  for (let i = 0; i < rawParts.length; i++) {
    current += rawParts[i]
    if (i % 2 === 1 || current.length >= 50) {
      if (current.trim()) chunks.push(current.trim())
      current = ''
    }
  }
  if (current.trim()) {
    chunks.push(current.trim())
  }
  return chunks.length > 0 ? chunks : [text.trim()]
}

export class VoiceSeamDispatcher implements IVoiceSeamService {
  private static instance: VoiceSeamDispatcher

  private constructor() {}

  public static getInstance(): VoiceSeamDispatcher {
    if (!VoiceSeamDispatcher.instance) {
      VoiceSeamDispatcher.instance = new VoiceSeamDispatcher()
    }
    return VoiceSeamDispatcher.instance
  }

  /**
   * 语音转录 (统一调度)
   */
  public async transcribe(
    audio: string | Buffer,
    options?: { language?: string; signal?: AbortSignal }
  ): Promise<TranscriptionResult> {
    const activeModule = modularResourceService.getActiveModuleBySlot('voice_asr')
    if (!activeModule) {
      throw new VoiceSeamError('NO_ACTIVE_PLUGIN', '未激活 ASR 语音识别插件')
    }

    if (options?.signal?.aborted) {
      throw new VoiceSeamError('ABORTED', '转录操作已中止')
    }

    if (activeModule.backend_type === 'omni_onnx') {
      let targetPath: string
      let isTempFile = false

      if (Buffer.isBuffer(audio)) {
        targetPath = path.join(os.tmpdir(), `ff_asr_${Date.now()}_${uuidv4()}.wav`)
        await fsPromises.writeFile(targetPath, audio)
        isTempFile = true
      } else {
        targetPath = audio
      }

      try {
        const res = await omniService.transcribeAudio(targetPath, {
          language: options?.language,
          signal: options?.signal
        })

        if (options?.signal?.aborted) {
          throw new VoiceSeamError('ABORTED', '转录操作已中止')
        }

        if (!res) {
          throw new VoiceSeamError('INFERENCE_FAILED', 'Omni 语音转录推理失败')
        }

        return {
          text: res.transcript || '',
          language: res.language || options?.language || 'zh',
          durationSec: (res.duration_ms || 0) / 1000,
          segments: undefined
        }
      } catch (err) {
        if (err instanceof VoiceSeamError) throw err
        if (options?.signal?.aborted || (err as any)?.name === 'AbortError') {
          throw new VoiceSeamError('ABORTED', '转录操作已中止')
        }
        throw new VoiceSeamError('INFERENCE_FAILED', (err as any)?.message || '转录推理异常')
      } finally {
        if (isTempFile && fs.existsSync(targetPath)) {
          try {
            await fsPromises.unlink(targetPath)
          } catch (e) {
            logger.warn(LogCategory.SYSTEM, '[VoiceSeamDispatcher] 临时音频文件清理失败:', e)
          }
        }
      }
    } else if (activeModule.backend_type === 'ai_engine') {
      throw new VoiceSeamError('INFERENCE_FAILED', 'ai_engine ASR 后端网关尚未接入')
    } else {
      throw new VoiceSeamError(
        'INFERENCE_FAILED',
        `不支持的 ASR 后端类型: ${activeModule.backend_type}`
      )
    }
  }

  /**
   * 流式语音合成 (纯 PCM 流，48kHz S16LE 单声道)
   */
  public async *synthesizeStream(
    text: string,
    options?: { voiceId?: string; speed?: number; signal?: AbortSignal }
  ): AsyncIterable<AudioChunk> {
    const trimmed = text ? text.trim() : ''
    if (!trimmed) {
      throw new VoiceSeamError('EMPTY_TEXT', '朗读文本为空')
    }

    const activeModule = modularResourceService.getActiveModuleBySlot('voice_tts')
    if (!activeModule) {
      throw new VoiceSeamError('NO_ACTIVE_PLUGIN', '未激活 TTS 语音合成插件')
    }

    if (options?.signal?.aborted) {
      throw new VoiceSeamError('ABORTED', '语音合成已中止')
    }

    try {
      if (
        activeModule.id === 'tts_m5_onnx' ||
        activeModule.id === 'tts_moss_onnx' ||
        activeModule.backend_type === 'omni_onnx'
      ) {
        yield* this.dispatchOmniTTS(trimmed, options)
      } else if (activeModule.backend_type === 'ai_engine') {
        throw new VoiceSeamError('INFERENCE_FAILED', 'ai_engine TTS 后端网关尚未接入')
      } else {
        throw new VoiceSeamError('UNSUPPORTED_BACKEND', `不支持的 TTS 模块: ${activeModule.id}`)
      }
    } catch (err) {
      if (options?.signal?.aborted) return
      if (err instanceof VoiceSeamError) throw err
      logger.error(LogCategory.SYSTEM, `[VoiceSeamDispatcher] 合成失败 (${activeModule.id}):`, err)
      throw err
    }
  }

  private async *dispatchOmniTTS(
    text: string,
    options?: { voiceId?: string; speed?: number; signal?: AbortSignal }
  ): AsyncIterable<AudioChunk> {
    // 优先请求 Omni 智能分句，失败或空时降级到本地切分
    let chunks: string[] = []
    try {
      const splitRes = await omniClient.splitTTSChunks(text, undefined, options?.signal)
      if (splitRes && splitRes.chunks && splitRes.chunks.length > 0) {
        chunks = splitRes.chunks
      }
    } catch {}

    if (chunks.length === 0) {
      chunks = splitTextIntoSentences(text)
    }

    if (chunks.length === 0) {
      return
    }

    const voiceId = options?.voiceId || 'default'
    const speed = options?.speed || 1.0

    for (let i = 0; i < chunks.length; i++) {
      if (options?.signal?.aborted) {
        throw new VoiceSeamError('ABORTED', '语音合成已中止')
      }

      const chunkText = chunks[i]
      const chunkRes = await omniClient.synthesizeTTSChunk(
        chunkText,
        voiceId,
        speed,
        undefined,
        options?.signal
      )

      if (options?.signal?.aborted) {
        throw new VoiceSeamError('ABORTED', '语音合成已中止')
      }

      if (!chunkRes || !chunkRes.buffer) {
        throw new VoiceSeamError(
          'INFERENCE_FAILED',
          `TTS 分句合成失败: "${chunkText.slice(0, 20)}"`
        )
      }

      // 剥离 WAV 容器头并统一归一化为保真 48kHz PCM（M5 原生 24kHz 自适应升采样至 48kHz）
      const pcmData = extractPcmNormalized48k(chunkRes.buffer)

      yield {
        format: 'pcm_s16le',
        sampleRate: 48000,
        channels: 1,
        data: pcmData,
        isLastChunk: i === chunks.length - 1
      }
    }
  }

  /**
   * 非流式整段音频合成 (标准 WAV 封装)
   */
  public async synthesizeToWav(
    text: string,
    options?: { voiceId?: string; speed?: number }
  ): Promise<ArrayBuffer> {
    const pcmChunks: Uint8Array[] = []
    for await (const chunk of this.synthesizeStream(text, options)) {
      pcmChunks.push(chunk.data)
    }

    if (pcmChunks.length === 0) {
      return createWavFromPcm(new Uint8Array(0), 48000, 1, 16)
    }

    const totalLength = pcmChunks.reduce((acc, c) => acc + c.byteLength, 0)
    const mergedPcm = new Uint8Array(totalLength)
    let offset = 0
    for (const c of pcmChunks) {
      mergedPcm.set(c, offset)
      offset += c.byteLength
    }

    return createWavFromPcm(mergedPcm, 48000, 1, 16)
  }
}

export const voiceSeamDispatcher = VoiceSeamDispatcher.getInstance()
