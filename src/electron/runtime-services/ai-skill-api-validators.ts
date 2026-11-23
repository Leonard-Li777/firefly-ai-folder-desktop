/**
 * 本地 Skill API 零 I/O 纯校验器、统一约束常量表与单一事实源路由模块
 * apps/desktop/src/electron/runtime-services/ai-skill-api-validators.ts
 *
 * 严格遵循 docs/specs/skill-api-hardening-and-contract-calibration-spec.md (v1.4)：
 * - 纯函数零 I/O，严禁在模块内执行 fs / HTTP / IPC 副作用；
 * - 复用 @firefly/shared 跨端扩展名单一事实源，消除局部后缀表漂移；
 * - 单一常量源 SKILL_API_CONSTRAINTS 同时驱动校验器、/api/capabilities 能力条目 constraints 与单测。
 */

import * as path from 'node:path'
import {
  AUDIO_EXTENSIONS,
  CATEGORY_EXT_MAP,
  CODE_EXTENSIONS,
  EBOOK_EXTENSIONS,
  FileCategory,
  VIDEO_EXTENSIONS,
  isDecodableImage
} from '@firefly/shared'

/** 按 Unicode 码点计算字符数（零外部依赖，供校验器与分句器同口径使用） */
export function countCodePoints(text: string): number {
  return Array.from(text).length
}

/** 单一事实源：本地 Skill API 全部端点限额与超时预算常量表 */
export const SKILL_API_CONSTRAINTS = {
  search: {
    defaultMinScore: 0.55,
    wideRecallMinScore: 0.35,
    minScoreRange: [0, 1] as readonly [number, number],
    defaultLimit: 20,
    maxLimit: 50,
    maxResultWindow: 200
  },
  tts: {
    maxTextChars: 150,
    maxFileBytes: 64 * 1024, // 65536
    maxChunkChars: 60,
    chunkTimeoutMs: 40_000,
    firstChunkTimeoutMs: 60_000,
    requestTimeoutMs: 120_000,
    maxConcurrent: 1,
    speedRange: [0.5, 2.0] as readonly [number, number],
    // 物理成本模型基线常量（用于 estimateTtsCostMs 与 TC-HARD-10 算术门禁）
    secPerChar: 0.24,
    rtfWorst: 2.0,
    coldStartMs: 20_000,
    chunkOverheadMs: 2_000
  },
  ocr: {
    maxDocumentBytes: 50 * 1024 * 1024 // 52428800
  },
  asr: {
    maxFileBytes: 512 * 1024 * 1024, // 536870912
    timestamps: 'span_only' as const
  },
  sensitive: {
    maxFileBytes: 50 * 1024 * 1024 // 52428800
  },
  organize: {
    maxNameChars: 128,
    maxStrategyChars: 2500,
    maxPerspectiveChars: 500
  }
} as const

export type ValidationFailure = {
  ok: false
  statusCode: 400
  error: 'INVALID_ARGUMENT' | 'UNSUPPORTED_FILE_TYPE'
  message: string
}

export type ValidationResult<T> = { ok: true; value: T } | ValidationFailure

/** 统一 TTS 成本模型函数（入口限额、启动门禁与 TC-HARD-10 算术单测共用） */
export function estimateTtsCostMs(chunks: readonly string[]): number {
  const { secPerChar, rtfWorst, coldStartMs, chunkOverheadMs } = SKILL_API_CONSTRAINTS.tts
  let total = coldStartMs
  for (const chunk of chunks) {
    total += countCodePoints(chunk) * secPerChar * 1000 * rtfWorst + chunkOverheadMs
  }
  return Math.round(total)
}

/** 原语 1：统一非对象 JSON Body 守卫（覆盖全部 POST 端点，拦截 null / 数组 / 原始值） */
export function requireObjectBody(body: unknown): ValidationResult<Record<string, any>> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return {
      ok: false,
      statusCode: 400,
      error: 'INVALID_ARGUMENT',
      message: '请求体必须为 JSON 对象'
    }
  }
  return { ok: true, value: body as Record<string, any> }
}

const STRICT_POS_INT_RE = /^[1-9]\d*$/
const STRICT_NON_NEG_INT_RE = /^(0|[1-9]\d*)$/
const STRICT_FLOAT_RE = /^\d+(\.\d+)?$/

/** 原语 2a：严格正整数/非负安全整数查询参数解析（拒绝空串、科学计数法、十六进制、浮点与越界值） */
export function parseStrictInt(
  raw: unknown,
  options: {
    name: string
    min: number
    max?: number
    defaultValue?: number
    required?: boolean
  }
): ValidationResult<number> {
  if (raw === undefined) {
    if (options.required || options.defaultValue === undefined) {
      return {
        ok: false,
        statusCode: 400,
        error: 'INVALID_ARGUMENT',
        message: `缺少必填整数参数: ${options.name}`
      }
    }
    return { ok: true, value: options.defaultValue }
  }
  const str = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : ''
  const re = options.min >= 1 ? STRICT_POS_INT_RE : STRICT_NON_NEG_INT_RE
  if (!str || !re.test(str)) {
    return {
      ok: false,
      statusCode: 400,
      error: 'INVALID_ARGUMENT',
      message: `参数 ${options.name} 必须为合法整数`
    }
  }
  const num = Number(str)
  if (
    !Number.isSafeInteger(num) ||
    num < options.min ||
    (options.max !== undefined && num > options.max)
  ) {
    const rangeDesc =
      options.max !== undefined ? `[${options.min}, ${options.max}]` : `>= ${options.min}`
    return {
      ok: false,
      statusCode: 400,
      error: 'INVALID_ARGUMENT',
      message: `参数 ${options.name} 超出允许范围 ${rangeDesc}`
    }
  }
  return { ok: true, value: num }
}

/** 原语 2b：严格非负浮点查询参数解析（仅接受十进制数字，拒绝空串、0x1、1e-1 等） */
export function parseQueryFloat(
  raw: unknown,
  options: {
    name: string
    min: number
    max: number
    defaultValue?: number
  }
): ValidationResult<number> {
  if (raw === undefined) {
    if (options.defaultValue === undefined) {
      return {
        ok: false,
        statusCode: 400,
        error: 'INVALID_ARGUMENT',
        message: `缺少必填数值参数: ${options.name}`
      }
    }
    return { ok: true, value: options.defaultValue }
  }
  let num: number
  if (typeof raw === 'number') {
    num = raw
  } else if (typeof raw === 'string') {
    const str = raw.trim()
    if (!str || !STRICT_FLOAT_RE.test(str)) {
      return {
        ok: false,
        statusCode: 400,
        error: 'INVALID_ARGUMENT',
        message: `参数 ${options.name} 必须为合法数值`
      }
    }
    num = Number(str)
  } else {
    return {
      ok: false,
      statusCode: 400,
      error: 'INVALID_ARGUMENT',
      message: `参数 ${options.name} 必须为合法数值`
    }
  }
  if (!Number.isFinite(num) || num < options.min || num > options.max) {
    return {
      ok: false,
      statusCode: 400,
      error: 'INVALID_ARGUMENT',
      message: `参数 ${options.name} 必须位于 [${options.min}, ${options.max}] 区间内`
    }
  }
  return { ok: true, value: num }
}

// ─── 跨端扩展名单一事实源组合（均带点小写） ───

const OCR_DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  ...(CATEGORY_EXT_MAP[FileCategory.DOCUMENT] || []),
  ...(CATEGORY_EXT_MAP[FileCategory.TEXT] || []),
  ...EBOOK_EXTENSIONS,
  ...CODE_EXTENSIONS,
  '.log'
])

const TRANSCRIBE_MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  ...AUDIO_EXTENSIONS,
  ...VIDEO_EXTENSIONS
])

/** 校验非空本地绝对路径（零 I/O） */
export function validateAbsoluteLocalPath(
  raw: unknown,
  fieldName = 'filePath'
): ValidationResult<string> {
  if (typeof raw !== 'string') {
    return {
      ok: false,
      statusCode: 400,
      error: 'INVALID_ARGUMENT',
      message: `参数 ${fieldName} 必须为非空字符串`
    }
  }
  const trimmed = raw.trim()
  if (!trimmed || !path.isAbsolute(trimmed)) {
    return {
      ok: false,
      statusCode: 400,
      error: 'INVALID_ARGUMENT',
      message: `参数 ${fieldName} 必须为有效的本地绝对路径`
    }
  }
  return { ok: true, value: trimmed }
}

/** 原语 3a：OCR 文件类型零 I/O 白名单校验 + 单一事实源路由（取代局部 detectMediaType） */
export function validateOcrFilePath(
  filePath: string
): ValidationResult<{ route: 'image' | 'document'; ext: string }> {
  const pathCheck = validateAbsoluteLocalPath(filePath)
  if (!pathCheck.ok) return pathCheck
  const ext = path.extname(pathCheck.value).toLowerCase()
  if (!ext) {
    return {
      ok: false,
      statusCode: 400,
      error: 'UNSUPPORTED_FILE_TYPE',
      message: '不支持无扩展名文件进行文字提取'
    }
  }
  if (isDecodableImage(pathCheck.value)) {
    return { ok: true, value: { route: 'image', ext } }
  }
  if (OCR_DOCUMENT_EXTENSIONS.has(ext)) {
    return { ok: true, value: { route: 'document', ext } }
  }
  return {
    ok: false,
    statusCode: 400,
    error: 'UNSUPPORTED_FILE_TYPE',
    message: `不支持的文件类型 (${ext})，文字提取仅支持可解码图片与文档/文本文件`
  }
}

/** 原语 3b：ASR 音视频文件类型零 I/O 白名单校验 */
export function validateTranscribeFilePath(filePath: string): ValidationResult<{ ext: string }> {
  const pathCheck = validateAbsoluteLocalPath(filePath)
  if (!pathCheck.ok) return pathCheck
  const ext = path.extname(pathCheck.value).toLowerCase()
  if (!ext || !TRANSCRIBE_MEDIA_EXTENSIONS.has(ext)) {
    return {
      ok: false,
      statusCode: 400,
      error: 'UNSUPPORTED_FILE_TYPE',
      message: `不支持的文件类型 (${ext || '无后缀'})，语音转写仅支持音频与视频文件`
    }
  }
  return { ok: true, value: { ext } }
}

/** 图像 Base64 魔数白名单（PNG / JPEG / WEBP / GIF / BMP / TIFF） */
export function hasKnownImageMagic(buf: Buffer): boolean {
  if (buf.byteLength < 4) return false
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true
  // GIF: 47 49 46 38
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return true
  // BMP: 42 4D
  if (buf[0] === 0x42 && buf[1] === 0x4d) return true
  // WEBP: RIFF....WEBP
  if (
    buf.byteLength >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return true
  }
  // TIFF: II*\0 or MM\0*
  if (
    (buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) ||
    (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a)
  ) {
    return true
  }
  return false
}

/** 音频 Base64 已知非音频魔数拒绝（PNG / JPEG / GIF / PDF / ZIP / 纯文本 JSON/HTML） */
export function hasKnownNonAudioMagic(buf: Buffer): boolean {
  if (buf.byteLength < 4) return true
  if (hasKnownImageMagic(buf)) return true
  // PDF: %PDF
  if (buf.toString('ascii', 0, 4) === '%PDF') return true
  // ZIP / DOCX / XLSX: PK\x03\x04
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return true
  // 明显纯文本前缀（非二进制音频容器）：全部可打印 ASCII / UTF-8 空白且以 { [ < 开头
  const first = buf[0]
  if (first === 0x7b || first === 0x5b || first === 0x3c) {
    const sample = buf.subarray(0, Math.min(64, buf.byteLength))
    const allPrintable = sample.every(
      b => b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e)
    )
    if (allPrintable) return true
  }
  return false
}

/** TTS 零 I/O 入参校验（在获取并发槽之前执行，确保繁忙态非法入参仍稳定返 400） */
export function validateSynthesizePreFlight(body: Record<string, any>): ValidationResult<{
  mode: 'text' | 'filePath'
  text?: string
  filePath?: string
  voiceId?: string
  speed?: number
  responseFormat: 'file' | 'base64'
}> {
  const hasTextField = body.text !== undefined && body.text !== null
  const hasFileField = body.filePath !== undefined && body.filePath !== null

  if (hasTextField && typeof body.text !== 'string') {
    return { ok: false, statusCode: 400, error: 'INVALID_ARGUMENT', message: 'text 必须为字符串' }
  }
  if (hasFileField && typeof body.filePath !== 'string') {
    return {
      ok: false,
      statusCode: 400,
      error: 'INVALID_ARGUMENT',
      message: 'filePath 必须为字符串'
    }
  }

  const trimmedText = typeof body.text === 'string' ? body.text.trim() : ''
  const trimmedPath = typeof body.filePath === 'string' ? body.filePath.trim() : ''

  if (trimmedText && trimmedPath) {
    return {
      ok: false,
      statusCode: 400,
      error: 'INVALID_ARGUMENT',
      message: 'text 与 filePath 只能二选一，不可同时提供'
    }
  }
  if (!trimmedText && !trimmedPath) {
    return {
      ok: false,
      statusCode: 400,
      error: 'INVALID_ARGUMENT',
      message: '至少需要提供非空 text 或 filePath 之一'
    }
  }

  if (trimmedText) {
    const len = countCodePoints(trimmedText)
    if (len > SKILL_API_CONSTRAINTS.tts.maxTextChars) {
      return {
        ok: false,
        statusCode: 400,
        error: 'INVALID_ARGUMENT',
        message: `单次语音合成文本不得超过 ${SKILL_API_CONSTRAINTS.tts.maxTextChars} 字，请按句切分后串行调用`
      }
    }
  } else {
    const pathCheck = validateAbsoluteLocalPath(trimmedPath)
    if (!pathCheck.ok) return pathCheck
  }

  // responseFormat：仅 undefined 默认 'file'，其余严格枚举
  let responseFormat: 'file' | 'base64' = 'file'
  if (body.responseFormat !== undefined) {
    if (body.responseFormat !== 'file' && body.responseFormat !== 'base64') {
      return {
        ok: false,
        statusCode: 400,
        error: 'INVALID_ARGUMENT',
        message: 'responseFormat 仅支持 file 或 base64'
      }
    }
    responseFormat = body.responseFormat
  }

  // speed：可选，[0.5, 2.0]
  let speed: number | undefined
  if (body.speed !== undefined) {
    const [minSpeed, maxSpeed] = SKILL_API_CONSTRAINTS.tts.speedRange
    const speedRes = parseQueryFloat(body.speed, { name: 'speed', min: minSpeed, max: maxSpeed })
    if (!speedRes.ok) return speedRes
    speed = speedRes.value
  }

  const voiceId =
    typeof body.voiceId === 'string' && body.voiceId.trim() ? body.voiceId.trim() : undefined

  return {
    ok: true,
    value: {
      mode: trimmedText ? 'text' : 'filePath',
      text: trimmedText || undefined,
      filePath: trimmedPath || undefined,
      voiceId,
      speed,
      responseFormat
    }
  }
}

const VALID_URL_ENCODED_RE = /^(?:[^%]|%[0-9A-Fa-f]{2})*$/
const HAS_PERCENT_HEX_RE = /%[0-9A-Fa-f]{2}/
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const FORBIDDEN_NAME_PATH_RE = /[/\\]|\.\./

/** 正则门控 URL 解码：仅当整串为合法 %XX 编码且含 %XX 时解码一次，防误杀含 "50%" 或 "%E0" 的目录树文本 */
export function decodeIfStrictlyUrlEncoded(str: string): string {
  if (HAS_PERCENT_HEX_RE.test(str) && VALID_URL_ENCODED_RE.test(str)) {
    try {
      return decodeURIComponent(str)
    } catch {
      return str
    }
  }
  return str
}

/** 整理草案 apply-plan 严格校验（name 剥成对引号 + 禁路径字符；strategy 不剥引号、保留 "50%"） */
export function validateApplyPlanBody(body: unknown): ValidationResult<{
  name: string
  strategy: string
  perspective: string
}> {
  const objRes = requireObjectBody(body)
  if (!objRes.ok) return objRes
  const raw = objRes.value

  if (typeof raw.name !== 'string') {
    return {
      ok: false,
      statusCode: 400,
      error: 'INVALID_ARGUMENT',
      message: '缺少必填字符串字段: name'
    }
  }
  if (typeof raw.strategy !== 'string') {
    return {
      ok: false,
      statusCode: 400,
      error: 'INVALID_ARGUMENT',
      message: '缺少必填字符串字段: strategy'
    }
  }
  if (
    raw.perspective !== undefined &&
    raw.perspective !== null &&
    typeof raw.perspective !== 'string'
  ) {
    return {
      ok: false,
      statusCode: 400,
      error: 'INVALID_ARGUMENT',
      message: '可选字段 perspective 必须为字符串'
    }
  }

  // name：正则门控解码 -> 仅剥离首尾成对引号 -> trim
  let name = decodeIfStrictlyUrlEncoded(raw.name).trim()
  if (
    (name.startsWith('"') && name.endsWith('"')) ||
    (name.startsWith("'") && name.endsWith("'"))
  ) {
    name = name.slice(1, -1).trim()
  }
  const nameLen = countCodePoints(name)
  if (nameLen === 0 || nameLen > SKILL_API_CONSTRAINTS.organize.maxNameChars) {
    return {
      ok: false,
      statusCode: 400,
      error: 'INVALID_ARGUMENT',
      message: `name 长度须在 1~${SKILL_API_CONSTRAINTS.organize.maxNameChars} 字符之间`
    }
  }
  if (FORBIDDEN_NAME_PATH_RE.test(name) || CONTROL_CHAR_RE.test(name)) {
    return {
      ok: false,
      statusCode: 400,
      error: 'INVALID_ARGUMENT',
      message: 'name 包含非法路径字符或控制字符'
    }
  }

  // strategy：正则门控解码（不剥引号，原样保留 "占比 50%" / "%E0"）
  const strategy = decodeIfStrictlyUrlEncoded(raw.strategy).trim()
  const strategyLen = countCodePoints(strategy)
  if (strategyLen === 0 || strategyLen > SKILL_API_CONSTRAINTS.organize.maxStrategyChars) {
    return {
      ok: false,
      statusCode: 400,
      error: 'INVALID_ARGUMENT',
      message: `strategy 长度须在 1~${SKILL_API_CONSTRAINTS.organize.maxStrategyChars} 字符之间`
    }
  }

  const perspective =
    typeof raw.perspective === 'string' ? decodeIfStrictlyUrlEncoded(raw.perspective).trim() : ''
  if (countCodePoints(perspective) > SKILL_API_CONSTRAINTS.organize.maxPerspectiveChars) {
    return {
      ok: false,
      statusCode: 400,
      error: 'INVALID_ARGUMENT',
      message: `perspective 长度不得超过 ${SKILL_API_CONSTRAINTS.organize.maxPerspectiveChars} 字符`
    }
  }

  return { ok: true, value: { name, strategy, perspective } }
}

/** 防漂移兜底检查：精确下推后若仍有 semantic/video_chunk 低于 minScore，剔除并标记漂移供外层 warn + degraded */
export function assertSearchDtosMinScore<
  T extends { score: number; matchType: 'exact' | 'fuzzy' | 'semantic' | 'unanalyzed' | 'video_chunk' }
>(items: T[], minScore: number): { items: T[]; driftedCount: number } {
  const kept: T[] = []
  let driftedCount = 0
  for (const item of items) {
    if (item.matchType === 'semantic' || item.matchType === 'video_chunk') {
      if (!Number.isFinite(item.score) || item.score < minScore) {
        driftedCount++
        continue
      }
    }
    kept.push(item)
  }
  return { items: kept, driftedCount }
}
