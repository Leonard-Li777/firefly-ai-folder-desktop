/**
 * M5-TTS 纯流式统一单帧协议解析器 (M5SF Parser)
 * 严格对齐 docs/specs/m5-tts-pure-streaming-session-spec.md v1.7.2 §3.4 / §4.1
 */

export const M5_MAGIC_BYTES = Buffer.from([0x4d, 0x35, 0x53, 0x54]) // 固定字节序列 'M5ST'
export const MAX_PAYLOAD_LEN = 16 * 1024 * 1024 // 16MB 净荷硬上限（完美覆盖整句与大段高质量无损 PCM，杜绝 128KB 误杀脱节）
export const MAX_STASH_BYTES = 64 * 1024 * 1024 // 半包暂存区 64MB 硬上限

export interface StreamChunkPayload {
  sessionId: string
  seq: number
  pcm: ArrayBuffer // 独立安全隔离拷贝，严禁共享 Node 8KB Buffer 池
  charStart: number
  charEnd: number
  startSample: number // 全局绝对采样起点 SSOT
  sampleCount: number
  isFirst: boolean
  isLast: boolean
}

export interface StreamEndMeta {
  totalFrames: number
  totalSamples: number
  totalChars: number
  elapsedMs: number
}

export interface StreamErrorMeta {
  code: string
  message: string
}

export type ParsedFrame =
  | { type: 'AUDIO'; payload: StreamChunkPayload }
  | { type: 'END'; meta: StreamEndMeta }
  | { type: 'ERROR'; meta: StreamErrorMeta }

export class M5FrameParser {
  private buffer: Buffer = Buffer.alloc(0)
  private lastSeq?: number

  /**
   * 推入新收到的网络二进制数据切片
   * 返回解析得到的帧序列；若检测到不可逆的破坏或缓冲区溢出，返回 'FATAL_DESYNC'
   */
  public push(chunk: Buffer): ParsedFrame[] | 'FATAL_DESYNC' {
    this.buffer = Buffer.concat([this.buffer, chunk])
    if (this.buffer.length > MAX_STASH_BYTES) {
      return 'FATAL_DESYNC'
    }

    const frames: ParsedFrame[] = []

    while (this.buffer.length >= 14) {
      // 1. 魔数跳跃定位 (消除 O(N^2) 裁剪开销)
      const magicIdx = this.buffer.indexOf(M5_MAGIC_BYTES)
      if (magicIdx === -1) {
        // 保留最后 3 字节，防止魔数被跨包切断
        this.buffer = this.buffer.subarray(Math.max(0, this.buffer.length - 3))
        break
      }
      if (magicIdx > 0) {
        this.buffer = this.buffer.subarray(magicIdx)
        if (this.buffer.length < 14) {
          break
        }
      }

      const frameType = this.buffer.readUInt8(4)
      const flags = this.buffer.readUInt8(5)
      const seqId = this.buffer.readUInt32LE(6)
      const payloadLen = this.buffer.readUInt32LE(10)

      if (payloadLen > MAX_PAYLOAD_LEN) {
        return 'FATAL_DESYNC'
      }
      if (this.buffer.length < 14 + payloadLen) {
        // 半包未集齐，等待后续网络数据包到达
        break
      }

      // 序列号回绕安全校验 (32位无符号模正向判定)
      if (this.lastSeq !== undefined) {
        const diff = (seqId - this.lastSeq) >>> 0
        if (diff === 0 || diff > 0x80000000) {
          // 判定为重复帧或非法的逆向乱序
          return 'FATAL_DESYNC'
        }
      }
      this.lastSeq = seqId

      const rawPayload = this.buffer.subarray(14, 14 + payloadLen)

      if (frameType === 0x01) {
        // 0x01 AUDIO 帧
        if (payloadLen < 20) {
          return 'FATAL_DESYNC'
        }
        const charStart = rawPayload.readUInt32LE(0)
        const charEnd = rawPayload.readUInt32LE(4)
        const startSample = Number(rawPayload.readBigUInt64LE(8))
        const sampleCount = rawPayload.readUInt32LE(16)
        const pcmBytes = rawPayload.subarray(20)

        if (pcmBytes.length !== sampleCount * 2) {
          return 'FATAL_DESYNC'
        }

        // 独立 ArrayBuffer 隔离安全拷贝，严禁共享 Node 8KB Buffer 池
        const safePcm = new ArrayBuffer(pcmBytes.length)
        new Uint8Array(safePcm).set(pcmBytes)

        frames.push({
          type: 'AUDIO',
          payload: {
            sessionId: '',
            seq: seqId,
            pcm: safePcm,
            charStart,
            charEnd,
            startSample,
            sampleCount,
            isFirst: (flags & 0x01) !== 0,
            isLast: (flags & 0x02) !== 0
          }
        })
      } else if (frameType === 0x03) {
        // 0x03 END 帧
        try {
          const jsonStr = rawPayload.toString('utf-8')
          const metaObj = JSON.parse(jsonStr)
          frames.push({
            type: 'END',
            meta: {
              totalFrames: metaObj.total_frames ?? 0,
              totalSamples: metaObj.total_samples ?? 0,
              totalChars: metaObj.total_chars ?? 0,
              elapsedMs: metaObj.elapsed_ms ?? 0
            }
          })
        } catch {
          return 'FATAL_DESYNC'
        }
      } else if (frameType === 0x04) {
        // 0x04 ERROR 帧
        try {
          const jsonStr = rawPayload.toString('utf-8')
          const errObj = JSON.parse(jsonStr)
          frames.push({
            type: 'ERROR',
            meta: {
              code: errObj.code || 'UNKNOWN_ERROR',
              message: errObj.message || 'Stream engine internal error'
            }
          })
        } catch {
          return 'FATAL_DESYNC'
        }
      } else {
        // 未知帧类型
        return 'FATAL_DESYNC'
      }

      this.buffer = this.buffer.subarray(14 + payloadLen)
    }

    return frames
  }

  /**
   * 重置解析器内部状态
   */
  public reset(): void {
    this.buffer = Buffer.alloc(0)
    this.lastSeq = undefined
  }
}
