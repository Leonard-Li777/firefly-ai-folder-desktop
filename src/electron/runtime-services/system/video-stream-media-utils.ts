/**
 * 本地 HTTP 双路视频流式播放 — 媒体探测解析、SAR/DAR 四分支滤镜与 BigInt PTS/DTS 工具
 *
 * 纯函数集合，严格遵循 Frozen v1.7 Approved（§3.2 / §3.3）：
 * - time_base 与 start_pts 原始文本直转 BigInt（零浮点中间精度损失）
 * - SAR/DAR 四分支策略（优先流级 SAR，冲突 >2% 告警；SAR 缺失但 DAR 可信仍预缩放）
 * - CSV 严格 3 列 [pts,dts,flags] 解析，缺失/异常/pts!==dts/负偏移一律降级 transcode
 */

import { logger, LogCategory } from '@firefly/shared'

export type StreamMode = 'remux' | 'transcode'

export interface RationalTime {
  num: bigint
  den: bigint
}

/** 媒体探测元数据（跳过 attached_pic 封面流后的首个真实视频流） */
export interface VideoProbeMeta {
  /** 视频流原始整数起始 PTS（stream.start_pts 原始文本直转 BigInt，缺失为 null） */
  startPts: bigint | null
  /** 视频流有理数时间基准（如 "1/90000" 直转 BigInt，缺失/非法为 null） */
  timeBase: RationalTime | null
  /** 仅作日志展示与 transcode 车道参考的起始秒数 */
  startTimeSec: number
  /** 容器与视频流 start_time 绝对差是否超过 0.05s（超过则输入 -ss 原点不可信，强制 transcode） */
  startTimeOriginMismatch: boolean
  durationSec: number | null
  videoCodec: string | null
  audioCodec: string | null
  hasAudio: boolean
  width: number | null
  height: number | null
  pixFmt: string | null
  bitsPerRawSample: number | null
  videoProfile: string | null
  /** 采样像素宽高比 (如 "1:1", "16:15", "8:9")，解析异常为 null */
  sampleAspectRatio: string | null
  /** 显示宽高比 (如 "16:9", "4:3")，解析异常为 null */
  displayAspectRatio: string | null
  /** 0/90/180/270 为直角，其他非直角保留原始度数，null 表示解析异常（均强制 transcode） */
  rotationDeg: number | null
  /** ffprobe 绝对 stream.index，跳过封面流后的真实视频流 */
  videoStreamIndex: number | null
}

export const KEYFRAME_CSV_FLAGS_RE = /^[A-Za-z_.]+$/
const INTEGER_TEXT_RE = /^-?\d+$/
const POSITIVE_RATIO_RE = /^(\d+)[:/](\d+)$/
const START_TIME_MISMATCH_THRESHOLD_SEC = 0.05

/** 将正整数比值字符串（如 "1/90000"、"16:15"）无损解析为 BigInt 有理数 */
export function parsePositiveRatio(raw: unknown): RationalTime | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed || trimmed === 'N/A') return null
  const m = POSITIVE_RATIO_RE.exec(trimmed)
  if (!m) return null
  const num = BigInt(m[1])
  const den = BigInt(m[2])
  return num > 0n && den > 0n ? { num, den } : null
}

/** 将原始整数文本（如 "0"、"-3003"、"9007199254740993"）直转 BigInt，严禁经 Number */
export function parseBigIntStrict(raw: unknown): bigint | null {
  if (typeof raw === 'bigint') return raw
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!INTEGER_TEXT_RE.test(trimmed)) return null
  try {
    return BigInt(trimmed)
  } catch {
    return null
  }
}

export function normalizeRotation(raw: unknown): number | null {
  const num = Number(raw)
  if (!Number.isFinite(num)) return null
  let deg = Math.round(num) % 360
  if (deg < 0) deg += 360
  return deg
}

export function parseSideDataRotation(stream: any): number | null {
  const side = Array.isArray(stream?.side_data_list)
    ? stream.side_data_list.find((item: any) =>
        /display\s*matrix/i.test(String(item?.side_data_type ?? ''))
      )
    : null
  if (side && Number.isFinite(Number(side.rotation))) {
    // ffprobe 新版 side_data 的 rotation 为顺时针角度，统一取反为逆时针
    return normalizeRotation(-Number(side.rotation))
  }
  if (stream?.tags && stream.tags.rotate !== undefined) return normalizeRotation(stream.tags.rotate)
  return 0
}

/**
 * 严格快车道判定：仅当时间基准、起始 PTS、原点同源性、8-bit yuv420p H.264 与零旋转全部满足时走 remux
 */
export function isRemuxable(meta: VideoProbeMeta): boolean {
  if (meta.videoStreamIndex === null) return false
  if (meta.timeBase === null || meta.startPts === null) return false
  if (meta.startTimeOriginMismatch) return false
  if (meta.rotationDeg !== 0) return false
  if (meta.pixFmt !== 'yuv420p') return false
  if (meta.bitsPerRawSample !== null && meta.bitsPerRawSample !== 8) return false
  if (meta.videoCodec !== 'h264' && meta.videoCodec !== 'avc1') return false
  if (/high\s*10|\b(10|12)\b|4:2:2|4:4:4/i.test(meta.videoProfile ?? '')) return false
  return true
}

/**
 * 显式旋转 + SAR/DAR 四分支预归一化与偶数缩放滤镜（R12-02）：
 * 1. SAR 有效且 1:1 -> 跳过预缩放
 * 2. SAR 有效且非 1:1 -> 优先采信流级 SAR 推导 DAR（与容器 DAR 偏差 >2% 记告警）
 * 3. SAR 缺失但 width/height 与 DAR 均有效且不一致 -> 按容器 DAR 预缩放
 * 4. SAR 与 DAR 均缺失 -> 告警并按假设方形像素降级
 */
export function buildVideoFilter(meta: VideoProbeMeta): string {
  let preSquare = ''
  const sar = parsePositiveRatio(meta.sampleAspectRatio)
  const darFromMeta = parsePositiveRatio(meta.displayAspectRatio)
  const hasDims =
    meta.width !== null && meta.height !== null && meta.width > 0 && meta.height > 0

  let targetDar: RationalTime | null = null
  if (sar && sar.num !== sar.den) {
    const sarDerivedDar = hasDims
      ? { num: BigInt(meta.width!) * sar.num, den: BigInt(meta.height!) * sar.den }
      : null
    if (sarDerivedDar && darFromMeta) {
      const ratioA = Number(sarDerivedDar.num) / Number(sarDerivedDar.den)
      const ratioB = Number(darFromMeta.num) / Number(darFromMeta.den)
      if (ratioB > 0 && Math.abs(ratioA - ratioB) / ratioB > 0.02) {
        logger.warn(LogCategory.MAIN, '[视频流] 流级 SAR 与容器 DAR 存在冲突，按优先级采信流级 SAR')
      }
    }
    targetDar = sarDerivedDar ?? darFromMeta
  } else if (!sar && darFromMeta && hasDims) {
    if (darFromMeta.num * BigInt(meta.height!) !== darFromMeta.den * BigInt(meta.width!)) {
      targetDar = darFromMeta
    }
  } else if (!sar && !darFromMeta) {
    logger.warn(LogCategory.MAIN, '[视频流] SAR/DAR 均不可用，按假设方形像素降级')
  }

  if (targetDar) {
    preSquare = `scale=w=trunc(ih*${targetDar.num.toString()}/${targetDar.den.toString()}/2)*2:h=trunc(ih/2)*2,setsar=1,`
  }

  let rot = ''
  const deg = meta.rotationDeg
  if (deg === 90) rot = 'transpose=1,'
  else if (deg === 270) rot = 'transpose=2,'
  else if (deg === 180) rot = 'hflip,vflip,'
  else if (deg != null && deg !== 0) {
    const rad = `${deg}*PI/180`
    // 几何外接展开：W'=|W*cos|+|H*sin|, H'=|W*sin|+|H*cos|，展开画布杜绝四角裁剪
    rot = `rotate=${rad}:ow=rotw(${rad}):oh=roth(${rad}):c=black,`
  }

  // 先旋转再按长边 <= 1280 偶数缩放；逗号必须转义，因为 argv 不经过 shell
  return `${preSquare}${rot}scale=w=if(gte(iw\\,ih)\\,trunc(min(1280\\,iw)/2)*2\\,-2):h=if(gte(iw\\,ih)\\,-2\\,trunc(min(1280\\,ih)/2)*2),setsar=1`
}

/** 纯 BigInt 微秒转 6 位小数定点数秒字符串（用于 FFmpeg -ss，零浮点转换） */
export function formatMicrosToSecStr(micros: bigint): string {
  const safe = micros < 0n ? 0n : micros
  const whole = safe / 1_000_000n
  const frac = safe % 1_000_000n
  return `${whole.toString()}.${frac.toString().padStart(6, '0')}`
}

/** 常规非负秒数格式化为 6 位小数定点数（用于 transcode 车道） */
export function formatSecToFixed6(sec: number): string {
  const safe = Number.isFinite(sec) && sec > 0 ? sec : 0
  return safe.toFixed(6)
}

export interface KeyframeSearchResult {
  packetPts: bigint
  relativeStreamMicros: bigint
  inputSeekSecStr: string
  actualStartSec: number
}

/**
 * 解析 ffprobe `-show_entries packet=pts,dts,flags -of csv=p=0` 输出（R11-03 / R12-04）：
 * - 严格 3 列 [pts,dts,flags]；含引号、列数不符、空字段、N/A 或 flags 不匹配正则均丢弃该行
 * - 仅接受 flags 含 K 且 packetPts === packetDts 的非负相对偏移锚点
 * - 负 packetPts 或负 relativeStreamMicros 严禁钳制为 0，直接跳过（无合法锚点则返回 null 降级 transcode）
 */
export function selectKeyframeFromCsv(
  csvStdout: string,
  streamStartPts: bigint,
  timeBase: RationalTime,
  targetMicros: bigint
): KeyframeSearchResult | null {
  let bestPts: bigint | null = null
  let bestRelMicros: bigint | null = null

  for (const rawLine of csvStdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.includes('"') || line.includes("'")) continue
    const cols = line.split(',')
    if (cols.length !== 3) continue
    const ptsRaw = cols[0].trim()
    const dtsRaw = cols[1].trim()
    const flagsRaw = cols[2].trim()
    if (!ptsRaw || !dtsRaw || !flagsRaw) continue
    if (!KEYFRAME_CSV_FLAGS_RE.test(flagsRaw) || !flagsRaw.includes('K')) continue

    const packetPts = parseBigIntStrict(ptsRaw)
    const packetDts = parseBigIntStrict(dtsRaw)
    if (packetPts === null || packetDts === null) continue
    // 唯一锚点规则：仅接受 PTS 与 DTS 一致的关键帧（Open-GOP 重排首帧跳过并由上层安全降级 transcode）
    if (packetPts !== packetDts) continue
    // 负 packetPts 存在预滚动偏置，严禁钳制为 0 继续 remux
    if (packetPts < 0n) continue

    const relativeStreamMicros =
      ((packetPts - streamStartPts) * timeBase.num * 1_000_000n) / timeBase.den
    if (relativeStreamMicros < 0n || relativeStreamMicros > targetMicros) continue

    if (bestRelMicros === null || relativeStreamMicros > bestRelMicros) {
      bestRelMicros = relativeStreamMicros
      bestPts = packetPts
    }
  }

  if (bestPts === null || bestRelMicros === null) return null
  return {
    packetPts: bestPts,
    relativeStreamMicros: bestRelMicros,
    inputSeekSecStr: formatMicrosToSecStr(bestRelMicros),
    actualStartSec: Number(bestRelMicros) / 1_000_000
  }
}

/**
 * 从 ffprobe 原始 JSON 文本中提取 videoStream 的原始字符串字段（防 JSON.parse 丢失大整数 start_pts 精度）
 */
export function extractRawStartPtsByStreamIndex(
  jsonText: string,
  videoStreamIndex: number
): bigint | null {
  // 匹配包含目标 index 的 stream 对象中的 start_pts 原始数字或字符串字面量
  const streamBlocks = jsonText.split(/"index"\s*:\s*/)
  for (let i = 1; i < streamBlocks.length; i++) {
    const block = streamBlocks[i]
    const idxMatch = /^(\d+)/.exec(block)
    if (!idxMatch || Number(idxMatch[1]) !== videoStreamIndex) continue
    const ptsMatch = /"start_pts"\s*:\s*"?(-?\d+)"?/.exec(block)
    if (ptsMatch) return parseBigIntStrict(ptsMatch[1])
  }
  return null
}

/** 计算容器 format.start_time 与视频流 stream.start_time 是否存在显著原点偏差（>0.05s） */
export function hasStartTimeOriginMismatch(
  formatStartRaw: unknown,
  streamStartRaw: unknown
): boolean {
  const fmt = Number(formatStartRaw)
  const stm = Number(streamStartRaw)
  if (!Number.isFinite(fmt) || !Number.isFinite(stm)) return false
  return Math.abs(fmt - stm) > START_TIME_MISMATCH_THRESHOLD_SEC
}

/** 对日志中的绝对路径进行脱敏替换，避免泄漏用户本地路径 */
export function maskPathsInStderr(text: string, filePath: string): string {
  if (!text) return ''
  let out = text
  if (filePath) {
    out = out.split(filePath).join('<masked-path>')
  }
  // 兜底替换 Windows 盘符路径与 POSIX 绝对路径
  out = out.replace(/[A-Za-z]:\\[^\s"'<>|]+/g, '<masked-path>')
  return out
}
