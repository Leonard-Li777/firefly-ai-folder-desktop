import { describe, it, expect, beforeEach } from 'vitest'
import { M5FrameParser, M5_MAGIC_BYTES, MAX_PAYLOAD_LEN, MAX_STASH_BYTES } from '../m5-frame-parser'

function buildAudioFrame(
  seq: number,
  flags: number,
  charStart: number,
  charEnd: number,
  startSample: number,
  samples: number[]
): Buffer {
  const pcmBytes = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    pcmBytes.writeInt16LE(samples[i], i * 2)
  }

  const payloadLen = 20 + pcmBytes.length
  const header = Buffer.alloc(14)
  M5_MAGIC_BYTES.copy(header, 0)
  header.writeUInt8(0x01, 4) // AUDIO
  header.writeUInt8(flags, 5)
  header.writeUInt32LE(seq, 6)
  header.writeUInt32LE(payloadLen, 10)

  const meta = Buffer.alloc(20)
  meta.writeUInt32LE(charStart, 0)
  meta.writeUInt32LE(charEnd, 4)
  meta.writeBigUInt64LE(BigInt(startSample), 8)
  meta.writeUInt32LE(samples.length, 16)

  return Buffer.concat([header, meta, pcmBytes])
}

function buildEndFrame(
  seq: number,
  metaObj: { total_frames: number; total_samples: number; total_chars: number; elapsed_ms: number }
): Buffer {
  const jsonBuf = Buffer.from(JSON.stringify(metaObj), 'utf-8')
  const header = Buffer.alloc(14)
  M5_MAGIC_BYTES.copy(header, 0)
  header.writeUInt8(0x03, 4) // END
  header.writeUInt8(0x02, 5) // IS_LAST
  header.writeUInt32LE(seq, 6)
  header.writeUInt32LE(jsonBuf.length, 10)

  return Buffer.concat([header, jsonBuf])
}

describe('M5FrameParser 单元测试', () => {
  let parser: M5FrameParser

  beforeEach(() => {
    parser = new M5FrameParser()
  })

  it('单包 AUDIO 帧正常解析', () => {
    const frame = buildAudioFrame(1, 0x01, 0, 10, 0, [100, 200, -300])
    const res = parser.push(frame)
    expect(res).not.toBe('FATAL_DESYNC')
    if (res !== 'FATAL_DESYNC') {
      expect(res).toHaveLength(1)
      expect(res[0].type).toBe('AUDIO')
      if (res[0].type === 'AUDIO') {
        expect(res[0].payload.seq).toBe(1)
        expect(res[0].payload.isFirst).toBe(true)
        expect(res[0].payload.isLast).toBe(false)
        expect(res[0].payload.charStart).toBe(0)
        expect(res[0].payload.charEnd).toBe(10)
        expect(res[0].payload.startSample).toBe(0)
        expect(res[0].payload.sampleCount).toBe(3)
        const pcmArr = new Int16Array(res[0].payload.pcm)
        expect(Array.from(pcmArr)).toEqual([100, 200, -300])
      }
    }
  })

  it('粘包：两个 AUDIO 帧合并在一个网络包中到达', () => {
    const f1 = buildAudioFrame(1, 0x01, 0, 5, 0, [1, 2])
    const f2 = buildAudioFrame(2, 0x00, 5, 12, 2, [3, 4, 5])
    const combined = Buffer.concat([f1, f2])

    const res = parser.push(combined)
    expect(res).not.toBe('FATAL_DESYNC')
    if (res !== 'FATAL_DESYNC') {
      expect(res).toHaveLength(2)
      expect(res[0].type).toBe('AUDIO')
      expect(res[1].type).toBe('AUDIO')
    }
  })

  it('半包切片：跨包到达，分段集齐完整帧', () => {
    const full = buildAudioFrame(1, 0x01, 0, 5, 0, [10, 20, 30, 40])
    const part1 = full.subarray(0, 10) // 甚至不够 14B 帧头
    const part2 = full.subarray(10, 25) // 包含部分 payload
    const part3 = full.subarray(25) // 剩余尾部

    const r1 = parser.push(part1)
    expect(r1).toEqual([])

    const r2 = parser.push(part2)
    expect(r2).toEqual([])

    const r3 = parser.push(part3)
    expect(r3).not.toBe('FATAL_DESYNC')
    if (r3 !== 'FATAL_DESYNC') {
      expect(r3).toHaveLength(1)
      if (r3[0].type === 'AUDIO') {
        expect(r3[0].payload.seq).toBe(1)
        expect(r3[0].payload.sampleCount).toBe(4)
      }
    }
  })

  it('魔数跳跃定位：前置脏数据/垃圾字节自动丢弃并对齐', () => {
    const junk = Buffer.from([0x00, 0x11, 0x22, 0x33, 0xaa, 0xbb])
    const valid = buildAudioFrame(1, 0x01, 0, 3, 0, [42])
    const raw = Buffer.concat([junk, valid])

    const res = parser.push(raw)
    expect(res).not.toBe('FATAL_DESYNC')
    if (res !== 'FATAL_DESYNC') {
      expect(res).toHaveLength(1)
      if (res[0].type === 'AUDIO') {
        expect(res[0].payload.seq).toBe(1)
        expect(res[0].payload.sampleCount).toBe(1)
      }
    }
  })

  it('END 帧解析正确', () => {
    const endFrame = buildEndFrame(10, {
      total_frames: 48,
      total_samples: 92160,
      total_chars: 356,
      elapsed_ms: 3210
    })

    const res = parser.push(endFrame)
    expect(res).not.toBe('FATAL_DESYNC')
    if (res !== 'FATAL_DESYNC') {
      expect(res).toHaveLength(1)
      expect(res[0].type).toBe('END')
      if (res[0].type === 'END') {
        expect(res[0].meta.totalFrames).toBe(48)
        expect(res[0].meta.totalSamples).toBe(92160)
        expect(res[0].meta.totalChars).toBe(356)
        expect(res[0].meta.elapsedMs).toBe(3210)
      }
    }
  })

  it('逆向乱序 / 重复帧 seq 立即触发 FATAL_DESYNC', () => {
    const f1 = buildAudioFrame(5, 0x00, 0, 1, 0, [1])
    const f2 = buildAudioFrame(5, 0x00, 1, 2, 1, [2]) // 重复 seq=5
    parser.push(f1)
    const res = parser.push(f2)
    expect(res).toBe('FATAL_DESYNC')
  })

  it('32 位无符号模正向回绕允许 (0xFFFFFFFE -> 0x00000002)', () => {
    const f1 = buildAudioFrame(0xfffffffe, 0x00, 0, 1, 0, [1])
    const f2 = buildAudioFrame(0x00000002, 0x00, 1, 2, 1, [2]) // 正向跨越 4
    parser.push(f1)
    const res = parser.push(f2)
    expect(res).not.toBe('FATAL_DESYNC')
    if (res !== 'FATAL_DESYNC') {
      expect(res).toHaveLength(1)
    }
  })

  it('净荷长度超过 128KB 硬上限触发 FATAL_DESYNC', () => {
    const header = Buffer.alloc(14)
    M5_MAGIC_BYTES.copy(header, 0)
    header.writeUInt8(0x01, 4)
    header.writeUInt8(0x00, 5)
    header.writeUInt32LE(1, 6)
    header.writeUInt32LE(MAX_PAYLOAD_LEN + 1, 10) // 超过 128KB

    const res = parser.push(header)
    expect(res).toBe('FATAL_DESYNC')
  })
})
