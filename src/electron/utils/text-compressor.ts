/**
 * 文本与元数据透明无损压缩工具（ADR-0038 / Task #683）
 * apps/desktop/src/electron/utils/text-compressor.ts
 *
 * 职责：
 * 1. 提供单行文本/JSON 对象的同步无损压缩（基于 Node.js 24 原生 node:zlib）
 * 2. 头部携带 1 字节算法魔数（0x00: RAW UTF-8, 0x01: Zlib Deflate）
 * 3. 具备短文本旁路机制（< 64 字节直接保留明文，防止压缩后反向膨胀）
 * 4. 具备防御性降级解码（对历史未压缩 string/Buffer 透明透传）
 * 5. 纯同步执行，可安全嵌入 SQLite 自定义函数与触发器
 */

import { deflateSync, inflateSync } from 'node:zlib'

/** 编码格式标识 */
const enum CompressionFormat {
  /** 原始明文 UTF-8（短文本或不可压缩文本） */
  RAW_UTF8 = 0x00,
  /** Zlib Deflate 压缩 */
  ZLIB_DEFLATE = 0x01
}

/** 触发压缩的最小字节长度阈值（低于此长度压缩后通常体积更大） */
const COMPRESSION_THRESHOLD_BYTES = 64

/**
 * 将文本字符串压缩为带格式头的 Buffer (BLOB)
 * @param text 待压缩字符串
 * @returns 压缩后的 Buffer；若输入为 null/undefined 则返回 null
 */
export function compressText(text: string | null | undefined): Buffer | null {
  if (text === null || text === undefined) {
    return null
  }
  if (typeof text !== 'string') {
    text = String(text)
  }
  if (text.length === 0) {
    // 空字符串：使用 1 字节 RAW 头
    return Buffer.from([CompressionFormat.RAW_UTF8])
  }

  const rawBuffer = Buffer.from(text, 'utf-8')

  // 1) 短文本旁路：小于阈值直接前置 0x00
  if (rawBuffer.length < COMPRESSION_THRESHOLD_BYTES) {
    const out = Buffer.allocUnsafe(1 + rawBuffer.length)
    out[0] = CompressionFormat.RAW_UTF8
    rawBuffer.copy(out, 1)
    return out
  }

  // 2) Zlib Deflate 压缩
  try {
    const compressed = deflateSync(rawBuffer, { level: 6 })
    // 如果压缩后体积反而大于或等于原始文本，退回 RAW
    if (compressed.length >= rawBuffer.length) {
      const out = Buffer.allocUnsafe(1 + rawBuffer.length)
      out[0] = CompressionFormat.RAW_UTF8
      rawBuffer.copy(out, 1)
      return out
    }

    const out = Buffer.allocUnsafe(1 + compressed.length)
    out[0] = CompressionFormat.ZLIB_DEFLATE
    compressed.copy(out, 1)
    return out
  } catch {
    // 压缩异常时安全降级为 RAW
    const out = Buffer.allocUnsafe(1 + rawBuffer.length)
    out[0] = CompressionFormat.RAW_UTF8
    rawBuffer.copy(out, 1)
    return out
  }
}

/**
 * 将 Buffer 或兼容数据解压为原始字符串
 * @param data 数据库读出的 Buffer/string/null/undefined
 * @returns 还原后的 UTF-8 字符串；空输入返回 ''
 */
export function decompressText(data: Buffer | string | null | undefined): string {
  if (data === null || data === undefined) {
    return ''
  }

  // 1) 兼容历史存量或测试直接注入的纯 string
  if (typeof data === 'string') {
    return data
  }

  if (!Buffer.isBuffer(data)) {
    return String(data)
  }

  if (data.length === 0) {
    return ''
  }

  const format = data[0]
  const payload = data.subarray(1)

  switch (format) {
    case CompressionFormat.RAW_UTF8:
      return payload.toString('utf-8')

    case CompressionFormat.ZLIB_DEFLATE:
      try {
        return inflateSync(payload).toString('utf-8')
      } catch {
        // 解压失败时尝试作为原始 Buffer 容错输出
        return payload.toString('utf-8')
      }

    default:
      // 容错：可能为未带头部头的直接 zlib 字节流或裸 UTF-8
      try {
        return inflateSync(data).toString('utf-8')
      } catch {
        return data.toString('utf-8')
      }
  }
}

/**
 * 压缩 JSON 对象为 Buffer (BLOB)
 */
export function compressJson<T>(obj: T | null | undefined): Buffer | null {
  if (obj === null || obj === undefined) {
    return null
  }
  try {
    const jsonStr = typeof obj === 'string' ? obj : JSON.stringify(obj)
    return compressText(jsonStr)
  } catch {
    return null
  }
}

/**
 * 从 Buffer (BLOB) 解压并解析为 JSON 对象
 */
export function decompressJson<T>(data: Buffer | string | null | undefined): T | undefined {
  if (data === null || data === undefined) {
    return undefined
  }
  const text = decompressText(data)
  if (!text || text.trim().length === 0) {
    return undefined
  }
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}
