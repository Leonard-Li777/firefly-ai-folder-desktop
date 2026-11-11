/**
 * M5-TTS 极速语音合成引擎与采样调度器 (M5-TTS Engine)
 * apps/desktop/src/electron/runtime-services/ai/m5-tts-engine.ts
 *
 * 遵循规格书 docs/specs/m5-tts-plugin-integration-spec.md §3.3, §3.4, §5.1, §5.2
 *
 * 核心设计原则:
 * 1. 音色与模型完全解耦 (KISS 原则): 通用展开图 + 纯数据面前缀提示码，代码零分支；
 * 2. M5HybridSampler 独立 LCG 随机数发生器，支持 Min/Max Frames 动态自适应防首字吞音与 EOS 防截断；
 * 3. 严格小端序 Int32 二进制音色码本切片加载与 4 字节对齐安全检查；
 * 4. 独立会话状态机，完整支持 ABORT_SYNTHESIS 与 SESSION_ABORTED 确认回执，杜绝孤儿会话。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { v4 as uuidv4 } from 'uuid'
import { logger, LogCategory } from '@firefly/shared'
import { modularResourceService } from '../system/modular-resource-service'

// ============================================================================
// 1. 通信协议与契约 (Spec §3.4)
// ============================================================================

export type M5EngineWorkerRequest =
  | {
      type: 'START_SYNTHESIS'
      sessionId: string
      text: string
      voiceId: string
      speed: number
      seed?: number
    }
  | {
      type: 'ABORT_SYNTHESIS'
      sessionId: string
    }

export type M5EngineWorkerEvent =
  | {
      type: 'CHUNK_READY'
      sessionId: string
      chunkIndex: number
      pcmData: Uint8Array
      sampleRate: 48000
    }
  | {
      type: 'SESSION_COMPLETE'
      sessionId: string
      totalFrames: number
    }
  | {
      type: 'SESSION_ABORTED'
      sessionId: string
      framesProduced: number
    }
  | {
      type: 'SESSION_ERROR'
      sessionId: string
      errorCode: string
      errorMessage: string
    }

export interface IM5WorkerSession {
  post(req: M5EngineWorkerRequest): void
  on(handler: (evt: M5EngineWorkerEvent) => void): void
  off(handler: (evt: M5EngineWorkerEvent) => void): void
  terminate(): void
}

// ============================================================================
// 2. 音色元数据与码本加载契约 (Spec §5.2.2)
// ============================================================================

export interface M5VoiceMeta {
  id: string
  displayName: string
  gender: 'female' | 'male' | 'child'
  lang: 'zh' | 'en' | 'multi' | string
  desc: string
  recommended: boolean
  promptTokenLength: number // 帧数 (每帧包含 16 个 RVQ 码本 token)
  promptCodesOffset: number // 字节偏移 (必须 4 字节对齐)
  sid?: number
}

export const RVQ_CODEBOOKS_PER_FRAME = 16
export const CODES_ELEM_SIZE = 4 // Int32 (4 字节)

/**
 * 契约：preset_voice_codes.bin 为小端序 (Little-Endian) Int32，
 * 按 [音色序][帧序][码本层 0..15] 紧凑排布无头部；
 * promptCodesOffset 单位为字节，必须 4 字节对齐；
 * 越界立即抛错阻断，防范静默读取脏音色。
 */
export function loadVoicePromptCodes(bin: ArrayBuffer, meta: M5VoiceMeta): Int32Array {
  const bytesNeeded = meta.promptTokenLength * RVQ_CODEBOOKS_PER_FRAME * CODES_ELEM_SIZE
  if (meta.promptCodesOffset % CODES_ELEM_SIZE !== 0) {
    throw new Error(`PROMPT_CODE_OFFSET_UNALIGNED: ${meta.promptCodesOffset}`)
  }
  if (meta.promptCodesOffset < 0 || meta.promptCodesOffset + bytesNeeded > bin.byteLength) {
    throw new Error(
      `PROMPT_CODE_RANGE_OUT_OF_BOUND: offset=${meta.promptCodesOffset}, needed=${bytesNeeded}, total=${bin.byteLength}`
    )
  }
  return new Int32Array(
    bin,
    meta.promptCodesOffset,
    meta.promptTokenLength * RVQ_CODEBOOKS_PER_FRAME
  )
}

// ============================================================================
// 3. M5 自适应混合采样器 (Spec §3.3)
// ============================================================================

export interface SamplingOptions {
  temperature?: number
  topK?: number
  minFrames?: number
  maxFrames?: number
}

export class M5HybridSampler {
  private rngState: number

  constructor(seed = 42) {
    this.rngState = seed >>> 0
  }

  /** 线性同余发生器 (LCG) 独立随机源，避免并发会话相互干扰 */
  private random(): number {
    this.rngState = (Math.imul(this.rngState, 1664525) + 1013904223) >>> 0
    return this.rngState / 4294967296
  }

  sampleC0(
    c0Logits: Float32Array,
    frameIndex: number,
    textLength: number,
    opts: SamplingOptions = {}
  ): number {
    const maxFrames = opts.maxFrames ?? 500
    // 1. 硬截断防护：达到上限强制触发 EOS (0)
    if (frameIndex >= maxFrames) {
      return 0
    }

    // 2. 短句保护：根据文本长度动态设定最小帧数，防首字吞音
    const minFrames = opts.minFrames ?? Math.max(3, Math.min(8, Math.ceil(textLength * 1.5)))
    const allowEOS = frameIndex >= minFrames

    const topK = opts.topK ?? 10
    const temp = opts.temperature ?? 0.9

    // 3. 屏蔽非合法状态的 EOS
    const logits = new Float32Array(c0Logits)
    if (!allowEOS && logits.length > 0) {
      logits[0] = -1e5
    }

    // 4. Top-K 截断与 Softmax 采样
    return this.execTopKSample(logits, topK, temp)
  }

  private execTopKSample(logits: Float32Array, k: number, temp: number): number {
    if (temp <= 0) {
      let maxVal = -Infinity
      let maxIdx = 0
      for (let i = 0; i < logits.length; i++) {
        if (logits[i] > maxVal) {
          maxVal = logits[i]
          maxIdx = i
        }
      }
      return maxIdx
    }

    const indices = Array.from({ length: logits.length }, (_, i) => i)
      .sort((a, b) => logits[b] - logits[a])
      .slice(0, Math.min(k, logits.length))

    let maxLogit = -Infinity
    for (const idx of indices) maxLogit = Math.max(maxLogit, logits[idx])

    let sumExp = 0
    const expVals = new Float32Array(indices.length)
    for (let i = 0; i < indices.length; i++) {
      expVals[i] = Math.exp((logits[indices[i]] - maxLogit) / temp)
      sumExp += expVals[i]
    }

    const r = this.random() * sumExp
    let acc = 0
    for (let i = 0; i < indices.length; i++) {
      acc += expVals[i]
      if (r <= acc) return indices[i]
    }
    return indices[0]
  }
}

// ============================================================================
// 4. M5 运行时架构演进 (Spec v2.0 + v1.11 SSOT)
// ============================================================================
// M5-TTS 原生 ONNX 推理已收归 apps/omni/omni-pro 原生微服务与 /api/audio/tts/chunk 统一承接，
// 严格杜绝生产欺诈性 Mock 交付 (AGENTS.md §2.9/§2.10)；流式分发与 24k->48k 归一化统一由
// VoiceSeamDispatcher.getInstance() 调度。
