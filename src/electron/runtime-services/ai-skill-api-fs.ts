/**
 * 本地 Skill API 文件 I/O 守卫与语音错误穷尽映射表
 * apps/desktop/src/electron/runtime-services/ai-skill-api-fs.ts
 *
 * 与零 I/O 纯校验模块 ai-skill-api-validators.ts 职责分离：
 * - statRegularFile：校验存在性、常规文件（拒目录伪后缀）与体积上限；
 * - readBoundedUtf8File：单句柄 open + fstat + 有界读取 (maxBytes + 1) 防 TOCTOU 与大文件 OOM，并拒绝含 \0 二进制与非 UTF-8；
 * - VOICE_SEAM_HTTP_ERROR_MAP：satisfies Record<VoiceSeamErrorCode, ...> 编译期 8 码穷尽映射。
 */

import * as fs from 'node:fs/promises'
import type { VoiceSeamErrorCode } from './ai/voice-seam-dispatcher'

export type FsGuardError = {
  ok: false
  statusCode: 400
  error: 'FILE_NOT_FOUND' | 'INVALID_ARGUMENT' | 'UNSUPPORTED_FILE_TYPE'
  message: string
}

export type FsGuardResult<T> = { ok: true; value: T } | FsGuardError

/** 校验常规文件存在性与体积上限（目录伪后缀如 foo.png/ 返 400 INVALID_ARGUMENT，不存在返 400 FILE_NOT_FOUND） */
export async function statRegularFile(
  filePath: string,
  maxBytes?: number
): Promise<FsGuardResult<{ size: number }>> {
  let stat: Awaited<ReturnType<typeof fs.stat>>
  try {
    stat = await fs.stat(filePath)
  } catch {
    return {
      ok: false,
      statusCode: 400,
      error: 'FILE_NOT_FOUND',
      message: '目标本地文件不存在或无法访问'
    }
  }
  if (!stat.isFile()) {
    return {
      ok: false,
      statusCode: 400,
      error: 'INVALID_ARGUMENT',
      message: '目标路径不是普通文件（不支持目录或特殊设备文件）'
    }
  }
  if (typeof maxBytes === 'number' && stat.size > maxBytes) {
    const maxMb = maxBytes >= 1024 * 1024 ? `${Math.round(maxBytes / (1024 * 1024))}MB` : `${Math.round(maxBytes / 1024)}KB`
    return {
      ok: false,
      statusCode: 400,
      error: 'INVALID_ARGUMENT',
      message: `目标文件体积超过 ${maxMb} 上限`
    }
  }
  return { ok: true, value: { size: stat.size } }
}

/**
 * 单句柄有界 UTF-8 文本读取（open -> fstat -> 最多读取 maxBytes + 1 字节）
 * 彻底消除 stat -> readFile TOCTOU 竞态，并拒绝含 \0 的二进制文件与非 UTF-8 编码文本
 */
export async function readBoundedUtf8File(
  filePath: string,
  maxBytes: number
): Promise<FsGuardResult<string>> {
  let handle: fs.FileHandle | null = null
  try {
    handle = await fs.open(filePath, 'r')
  } catch (err: any) {
    // Windows 对目录调用 fs.open(..., 'r') 会直接抛出 EISDIR，需归类为 INVALID_ARGUMENT 而非 FILE_NOT_FOUND
    if (err?.code === 'EISDIR') {
      return {
        ok: false,
        statusCode: 400,
        error: 'INVALID_ARGUMENT',
        message: '目标路径不是普通文件'
      }
    }
    return {
      ok: false,
      statusCode: 400,
      error: 'FILE_NOT_FOUND',
      message: '目标文本文件不存在或无法读取'
    }
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) {
      return {
        ok: false,
        statusCode: 400,
        error: 'INVALID_ARGUMENT',
        message: '目标路径不是普通文件'
      }
    }
    if (stat.size > maxBytes) {
      return {
        ok: false,
        statusCode: 400,
        error: 'INVALID_ARGUMENT',
        message: `目标文本文件体积超过 ${Math.round(maxBytes / 1024)}KB 上限`
      }
    }
    const buf = Buffer.alloc(maxBytes + 1)
    let totalRead = 0
    while (totalRead < buf.byteLength) {
      const { bytesRead } = await handle.read(buf, totalRead, buf.byteLength - totalRead, totalRead)
      if (bytesRead === 0) break
      totalRead += bytesRead
    }
    if (totalRead > maxBytes) {
      return {
        ok: false,
        statusCode: 400,
        error: 'INVALID_ARGUMENT',
        message: `目标文本文件体积超过 ${Math.round(maxBytes / 1024)}KB 上限`
      }
    }
    const slice = buf.subarray(0, totalRead)
    if (slice.includes(0)) {
      return {
        ok: false,
        statusCode: 400,
        error: 'UNSUPPORTED_FILE_TYPE',
        message: '检测到二进制文件内容，仅支持 UTF-8 编码纯文本文件'
      }
    }
    try {
      const decoder = new TextDecoder('utf-8', { fatal: true })
      return { ok: true, value: decoder.decode(slice) }
    } catch {
      return {
        ok: false,
        statusCode: 400,
        error: 'UNSUPPORTED_FILE_TYPE',
        message: '文本解码失败，仅支持 UTF-8 编码纯文本文件'
      }
    }
  } finally {
    await handle.close().catch(() => {})
  }
}

export interface VoiceSeamHttpMapping {
  statusCode: number
  error: string
  retryable: boolean
  retryAfterSec?: number
  defaultMessage: string
}

/** 编译期 8 码穷尽映射表（严格隔离 503 瞬态与 500 确定性失败；TTS_BUDGET_EXCEEDED 严禁带 Retry-After） */
export const VOICE_SEAM_HTTP_ERROR_MAP: Readonly<
  Record<VoiceSeamErrorCode, Readonly<VoiceSeamHttpMapping>>
> = {
  EMPTY_TEXT: {
    statusCode: 400,
    error: 'INVALID_ARGUMENT',
    retryable: false,
    defaultMessage: '朗读文本不能为空'
  },
  NO_ACTIVE_PLUGIN: {
    statusCode: 400,
    error: 'PLUGIN_NOT_ACTIVE',
    retryable: false,
    defaultMessage: '语音功能需安装并启用对应插件'
  },
  ENGINE_BUSY: {
    statusCode: 503,
    error: 'ENGINE_BUSY',
    retryable: true,
    retryAfterSec: 10,
    defaultMessage: '语音引擎正被桌面端流式朗读占用，请稍后重试'
  },
  ENGINE_UNAVAILABLE: {
    statusCode: 503,
    error: 'ENGINE_UNAVAILABLE',
    retryable: true,
    retryAfterSec: 10,
    defaultMessage: '语音引擎暂不可用，请稍后重试'
  },
  TIMEOUT: {
    statusCode: 503,
    error: 'TTS_BUDGET_EXCEEDED',
    retryable: false,
    defaultMessage: '语音合成超出预算时间，请缩短文本后再试（原样重试无效）'
  },
  ABORTED: {
    statusCode: 503,
    error: 'REQUEST_ABORTED',
    retryable: false,
    defaultMessage: '服务停机或请求已中止'
  },
  INFERENCE_FAILED: {
    statusCode: 500,
    error: 'INFERENCE_FAILED',
    retryable: false,
    defaultMessage: '语音推理发生确定性失败'
  },
  UNSUPPORTED_BACKEND: {
    statusCode: 500,
    error: 'INFERENCE_FAILED',
    retryable: false,
    defaultMessage: '当前语音引擎后端暂不支持该请求'
  }
}
