import { logger, LogCategory } from '@firefly/shared'
import { modularResourceService } from '../system/modular-resource-service'
import type { TTSWavMetadata } from './tts-wav-cache-service'

/** 将 meta 元数据注入或更新至 WAV Buffer 尾部，确保 RIFF 格式完全合规且自包含 */
export function injectOrUpdateMetaChunk(wavBuffer: Buffer, meta: TTSWavMetadata): Buffer {
  if (
    wavBuffer.length < 44 ||
    wavBuffer.toString('ascii', 0, 4) !== 'RIFF' ||
    wavBuffer.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    return wavBuffer
  }

  const keptChunks: Buffer[] = []
  let offset = 12
  while (offset + 8 <= wavBuffer.length) {
    const chunkId = wavBuffer.toString('ascii', offset, offset + 4)
    const chunkSize = wavBuffer.readUInt32LE(offset + 4)
    const chunkTotalLen = 8 + chunkSize + (chunkSize % 2)
    const chunkEnd = Math.min(offset + chunkTotalLen, wavBuffer.length)

    if (chunkId !== 'meta') {
      keptChunks.push(wavBuffer.subarray(offset, chunkEnd))
    }
    offset = chunkEnd
  }

  const metaJsonBuffer = Buffer.from(JSON.stringify(meta), 'utf-8')
  const metaChunkSize = metaJsonBuffer.length
  const metaPadding = metaChunkSize % 2 !== 0 ? 1 : 0

  const metaHeader = Buffer.alloc(8)
  metaHeader.write('meta', 0)
  metaHeader.writeUInt32LE(metaChunkSize, 4)

  const finalBuffer = Buffer.concat([
    wavBuffer.subarray(0, 12),
    ...keptChunks,
    metaHeader,
    metaJsonBuffer,
    ...(metaPadding ? [Buffer.alloc(1, 0)] : [])
  ])
  finalBuffer.writeUInt32LE(finalBuffer.length - 8, 4)
  return finalBuffer
}

/** 将分句 PCM 数据包装为标准 44 字节 WAV 容器 */
export function wrapPcmAsWav(
  pcmData: Buffer,
  numChannels = 1,
  sampleRate = 24000,
  bitsPerSample = 16
): Buffer {
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8)
  const blockAlign = numChannels * (bitsPerSample / 8)
  const dataSize = pcmData.length
  const riffSize = 36 + dataSize

  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(riffSize, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(numChannels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)

  return Buffer.concat([header, pcmData])
}

/** 严格解包并归一化 WAV Buffer（剥离多层假头，恢复最内层声学规格） */
export function unwrapWavBuffer(
  inputBuffer: Buffer,
  defaultVoiceId?: string | number
): {
  wavBuffer: Buffer
  rawPcm: Buffer
  numChannels: number
  sampleRate: number
  bitsPerSample: number
} {
  let cur = inputBuffer
  while (
    cur.length >= 88 &&
    cur.toString('ascii', 0, 4) === 'RIFF' &&
    cur.toString('ascii', 8, 12) === 'WAVE' &&
    cur.toString('ascii', 44, 48) === 'RIFF' &&
    cur.toString('ascii', 52, 56) === 'WAVE'
  ) {
    logger.debug(
      LogCategory.FILE_PROCESSOR,
      `[TTS缓存服务] 检测并剥离嵌套外层假 WAV 头 (外层大小: ${cur.length} 字节)`
    )
    cur = cur.subarray(44)
  }

  if (
    cur.length >= 44 &&
    cur.toString('ascii', 0, 4) === 'RIFF' &&
    cur.toString('ascii', 8, 12) === 'WAVE'
  ) {
    return {
      wavBuffer: cur,
      rawPcm: cur.subarray(44),
      numChannels: cur.readUInt16LE(22),
      sampleRate: cur.readUInt32LE(24),
      bitsPerSample: cur.readUInt16LE(34)
    }
  }

  const safeVoiceStr = String(defaultVoiceId || '')
  const isM5 =
    safeVoiceStr.includes('m5') ||
    safeVoiceStr.includes('azure_') ||
    safeVoiceStr.startsWith('preset_') ||
    modularResourceService.getActiveModuleBySlot('voice_tts')?.id === 'tts_m5_onnx'
  const numChannels = isM5 ? 1 : 2
  const sampleRate = isM5 ? 24000 : 48000
  const bitsPerSample = 16

  return {
    wavBuffer: wrapPcmAsWav(cur, numChannels, sampleRate, bitsPerSample),
    rawPcm: cur,
    numChannels,
    sampleRate,
    bitsPerSample
  }
}

/** 计算 WAV Buffer 物理发音时长（秒） */
export function calculateWavDuration(wavBuffer: Buffer): number {
  if (wavBuffer.length < 44) return 0
  const unwrap = unwrapWavBuffer(wavBuffer)
  const bytesPerSec = unwrap.sampleRate * unwrap.numChannels * (unwrap.bitsPerSample / 8)
  return bytesPerSec > 0 ? unwrap.rawPcm.length / bytesPerSec : 0
}
