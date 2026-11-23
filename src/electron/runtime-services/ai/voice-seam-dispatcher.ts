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
  /** 底层音频无法解码出任何有效样本（用于与真静音区分，映射到 400 UNSUPPORTED_FILE_TYPE） */
  decodeFailed?: boolean
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

export interface SynthesizeOptions {
  voiceId?: string
  speed?: number
  signal?: AbortSignal
  /** 后续分句单块超时上限（ms，不传则不施加短超时） */
  chunkTimeoutMs?: number
  /** 首块超时上限（ms，含冷启动余量；缺省同 chunkTimeoutMs） */
  firstChunkTimeoutMs?: number
  /** 整请求总预算（ms），用于单块动态截断与注定超时块早停 */
  totalBudgetMs?: number
  /** 硬切句上限（码点数，默认 60） */
  maxChunkChars?: number
}

/** 统一语音服务标准接口 */
export interface IVoiceSeamService {
  /** 语音转录 (支持文件路径或内存音频 Buffer) */
  transcribe(
    audio: string | Buffer,
    options?: { language?: string; signal?: AbortSignal }
  ): Promise<TranscriptionResult>

  /** 流式语音合成 (纯 PCM 流) */
  synthesizeStream(text: string, options?: SynthesizeOptions): AsyncIterable<AudioChunk>

  /** 非流式整段音频合成 (直接返回标准带头部的 WAV 格式) */
  synthesizeToWav(text: string, options?: SynthesizeOptions): Promise<ArrayBuffer>
}

export type VoiceSeamErrorCode =
  | 'NO_ACTIVE_PLUGIN'
  | 'INFERENCE_FAILED'
  | 'ABORTED'
  | 'EMPTY_TEXT'
  | 'UNSUPPORTED_BACKEND'
  | 'ENGINE_UNAVAILABLE'
  | 'ENGINE_BUSY'
  | 'TIMEOUT'

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

/** 按 Unicode 码点计算字符数（与校验器同口径） */
export function countCodePoints(text: string): number {
  return Array.from(text).length
}

/**
 * 本地句子切分算法（标点切分 + <=maxChunkChars 码点硬折行 + 相邻短句贪心合并）
 * 保证无标点长串严格 <= maxChunkChars 码点，且硬切余段同样参与相邻合并，使块数 k <= floor(N/30) + 1
 */
export function splitTextIntoSentences(
  text: string,
  maxChunkChars = 60,
  mergeShort = false
): string[] {
  const trimmed = text ? text.trim() : ''
  if (!trimmed) return []
  const limit = Math.max(1, Math.floor(maxChunkChars))

  // 1. 按标点拆出自然句（保留标点附着在句尾）
  const rawParts = trimmed.split(/([。！？!?；;\n\r]+)/).filter(Boolean)
  const rawSentences: string[] = []
  let acc = ''
  for (let i = 0; i < rawParts.length; i++) {
    acc += rawParts[i]
    if (i % 2 === 1) {
      if (acc.trim()) rawSentences.push(acc.trim())
      acc = ''
    }
  }
  if (acc.trim()) rawSentences.push(acc.trim())
  if (rawSentences.length === 0) rawSentences.push(trimmed)

  // 2. 对超过 limit 码点的无标点长句硬折行（拆出的余段保留在序列中参与下一步贪心合并）
  const atomicPieces: string[] = []
  for (const s of rawSentences) {
    const cps = Array.from(s)
    if (cps.length <= limit) {
      atomicPieces.push(s)
    } else {
      for (let idx = 0; idx < cps.length; idx += limit) {
        const piece = cps.slice(idx, idx + limit).join('').trim()
        if (piece) atomicPieces.push(piece)
      }
    }
  }

  if (!mergeShort) {
    return atomicPieces
  }

  // 3. 相邻短句/余段贪心合并至 <= limit 码点
  const merged: string[] = []
  let current = ''
  let currentLen = 0
  for (const piece of atomicPieces) {
    const pieceLen = Array.from(piece).length
    if (!current) {
      current = piece
      currentLen = pieceLen
    } else if (currentLen + pieceLen <= limit) {
      current += piece
      currentLen += pieceLen
    } else {
      merged.push(current)
      current = piece
      currentLen = pieceLen
    }
  }
  if (current) merged.push(current)
  return merged
}

/** 区分 TimeoutError 与主动 AbortError，避免整请求超时被吞成 ABORTED */
function throwIfSignalAborted(signal?: AbortSignal, abortMsg = '语音合成已中止'): void {
  if (!signal?.aborted) return
  if ((signal.reason as any)?.name === 'TimeoutError') {
    throw new VoiceSeamError('TIMEOUT', '语音合成超出预算时间限制')
  }
  throw new VoiceSeamError('ABORTED', abortMsg)
}

/** 将 omniClient 抛出的底层错误精准转译为 VoiceSeamError */
function translateOmniTtsError(err: unknown, signal?: AbortSignal): VoiceSeamError {
  if (err instanceof VoiceSeamError) return err
  const msg = err instanceof Error ? err.message : String(err)
  if (msg === 'ENGINE_BUSY_STREAMING') {
    return new VoiceSeamError('ENGINE_BUSY', 'TTS 引擎正被桌面朗读流式会话占用')
  }
  if (msg === 'ENGINE_UNAVAILABLE') {
    return new VoiceSeamError('ENGINE_UNAVAILABLE', 'TTS 语音引擎暂不可用')
  }
  if (
    msg === 'TIMEOUT' ||
    (err as any)?.name === 'TimeoutError' ||
    (signal?.reason as any)?.name === 'TimeoutError'
  ) {
    return new VoiceSeamError('TIMEOUT', '语音合成超出预算时间限制')
  }
  if (msg === 'ABORTED' || (err as any)?.name === 'AbortError' || signal?.aborted) {
    return new VoiceSeamError('ABORTED', '语音合成已中止')
  }
  return new VoiceSeamError('INFERENCE_FAILED', msg || 'TTS 分句合成推理失败')
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

        // 严格读取音频真实时长 audio_duration_sec（严禁用推理耗时 duration_ms 顶替）
        const hasValidDuration =
          typeof res.audio_duration_sec === 'number' &&
          Number.isFinite(res.audio_duration_sec) &&
          res.audio_duration_sec >= 0
        const durationSec = hasValidDuration ? res.audio_duration_sec! : 0
        const text = res.transcript || ''
        // 区分「底层无法解码出有效音频样本」与「真实静音（audio_duration_sec > 0 但 transcript 为空）」
        const decodeFailed = !text && (!hasValidDuration || durationSec <= 0)
        // 旧版 Omni 偏斜（transcript 非空但缺失 audio_duration_sec）显式上报 warn，禁止静默降级
        if (text && (!hasValidDuration || durationSec <= 0)) {
          logger.warn(
            LogCategory.SYSTEM,
            '[VoiceSeamDispatcher] 转录文本非空但缺失有效 audio_duration_sec，降级返回空 segments'
          )
        }
        const segments =
          text && durationSec > 0
            ? [{ startMs: 0, endMs: Math.max(1, Math.round(durationSec * 1000)), text }]
            : []

        return {
          text,
          language: res.language || options?.language || 'zh',
          durationSec,
          segments,
          ...(decodeFailed ? { decodeFailed: true } : {})
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
    options?: SynthesizeOptions
  ): AsyncIterable<AudioChunk> {
    const trimmed = text ? text.trim() : ''
    if (!trimmed) {
      throw new VoiceSeamError('EMPTY_TEXT', '朗读文本为空')
    }

    const activeModule = modularResourceService.getActiveModuleBySlot('voice_tts')
    if (!activeModule) {
      throw new VoiceSeamError('NO_ACTIVE_PLUGIN', '未激活 TTS 语音合成插件')
    }

    throwIfSignalAborted(options?.signal)

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
      if (err instanceof VoiceSeamError) throw err
      throwIfSignalAborted(options?.signal)
      logger.error(LogCategory.SYSTEM, `[VoiceSeamDispatcher] 合成失败 (${activeModule.id}):`, err)
      throw translateOmniTtsError(err, options?.signal)
    }
  }

  private async *dispatchOmniTTS(
    text: string,
    options?: SynthesizeOptions
  ): AsyncIterable<AudioChunk> {
    const maxChunkChars = options?.maxChunkChars ?? 60
    // 优先请求 Omni 智能分句，失败或空时显式 warn 并降级到本地切分（严禁空 catch 静默降级）
    let chunks: string[] = []
    try {
      const splitRes = await omniClient.splitTTSChunks(
        text,
        { maxChunkChars },
        options?.signal
      )
      if (splitRes && splitRes.chunks && splitRes.chunks.length > 0) {
        // 对 Omni 返回分片再做一次上限校验，防止无标点长串超限
        chunks = splitRes.chunks.every(c => countCodePoints(c) <= maxChunkChars)
          ? splitRes.chunks
          : splitTextIntoSentences(text, maxChunkChars, true)
      }
    } catch (err) {
      logger.warn(
        LogCategory.SYSTEM,
        '[VoiceSeamDispatcher] Omni splitTTSChunks 失败，降级本地分句:',
        err instanceof Error ? err.message : String(err)
      )
    }

    if (chunks.length === 0) {
      chunks = splitTextIntoSentences(text, maxChunkChars, true)
    }

    if (chunks.length === 0) {
      return
    }

    const voiceId = options?.voiceId || 'default'
    const speed = options?.speed || 1.0
    const startTimeMs = Date.now()
    const totalBudgetMs = options?.totalBudgetMs

    for (let i = 0; i < chunks.length; i++) {
      throwIfSignalAborted(options?.signal)

      const chunkText = chunks[i]
      let effectiveTimeoutMs: number | undefined =
        i === 0 ? (options?.firstChunkTimeoutMs ?? options?.chunkTimeoutMs) : options?.chunkTimeoutMs

      if (typeof totalBudgetMs === 'number' && Number.isFinite(totalBudgetMs) && totalBudgetMs > 0) {
        const remainingMs = totalBudgetMs - (Date.now() - startTimeMs)
        // 进入下一分句前若剩余总预算低于注定超时下界（codePoints * 240ms + 2000ms），立即早停不空烧 CPU
        const minRequiredMs = countCodePoints(chunkText) * 240 + 2000
        if (remainingMs <= 0 || (i > 0 && remainingMs < minRequiredMs)) {
          throw new VoiceSeamError('TIMEOUT', '语音合成超出总预算时间限制')
        }
        effectiveTimeoutMs =
          typeof effectiveTimeoutMs === 'number'
            ? Math.min(effectiveTimeoutMs, remainingMs)
            : remainingMs
      }

      let chunkRes: Awaited<ReturnType<typeof omniClient.synthesizeTTSChunk>>
      try {
        chunkRes = await omniClient.synthesizeTTSChunk(
          chunkText,
          voiceId,
          speed,
          undefined,
          options?.signal,
          effectiveTimeoutMs
        )
      } catch (err) {
        throw translateOmniTtsError(err, options?.signal)
      }

      throwIfSignalAborted(options?.signal)

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
    options?: SynthesizeOptions
  ): Promise<ArrayBuffer> {
    throwIfSignalAborted(options?.signal)
    const pcmChunks: Uint8Array[] = []
    for await (const chunk of this.synthesizeStream(text, options)) {
      pcmChunks.push(chunk.data)
    }

    throwIfSignalAborted(options?.signal)

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
