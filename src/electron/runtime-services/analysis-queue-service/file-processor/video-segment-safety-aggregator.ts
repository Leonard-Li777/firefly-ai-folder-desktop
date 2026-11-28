import {
  CANONICAL_NAMES,
  DIMENSION_CODES,
  FACT_TAG_CONFIDENCE,
  LogCategory,
  concept,
  getCanonicalConceptName,
  logger
} from '@firefly/shared'
import {
  TagReconciliationArbiter,
  preResolveControlledCandidates,
  resolveControlledTagCode
} from '@firefly/core-engine'
import type { OmniPerceptionResponse } from '../../system/omni-service/types'
import { compressJson, decompressJson } from '../../../utils/text-compressor'

export interface VideoSegmentSafetyAggregationInput {
  db: any
  fileFingerprint: string
  enableNsfwPerception: boolean
  perception: OmniPerceptionResponse | undefined
  language?: string
  resolveControlledCode?: (lemma: string) => string | undefined
  queueFtsSync?: (fileFingerprint: string) => void
}

export interface VideoSegmentSafetyAggregationResult {
  exifUpdated: boolean
  tagsUpdated: boolean
  escalatedRating?: string
  backfilledAllAges: boolean
  escalatedMosaicLevel?: number
}

interface RatingSpec {
  rank: number
  tagName: string
  tagCode: string
}

const RATING_SPECS: Record<string, RatingSpec> = {
  r18g: {
    rank: 5,
    tagName: getCanonicalConceptName(concept('R-18G')) || 'R-18G',
    tagCode: concept('R-18G')
  },
  r18: {
    rank: 4,
    tagName: getCanonicalConceptName(concept('R-18')) || 'R-18',
    tagCode: concept('R-18')
  },
  r15: {
    rank: 3,
    tagName: getCanonicalConceptName(concept('R-15')) || 'R-15',
    tagCode: concept('R-15')
  },
  pg13: {
    rank: 2,
    tagName: getCanonicalConceptName(concept('PG-13')) || 'PG-13',
    tagCode: concept('PG-13')
  },
  safe: {
    rank: 1,
    tagName: CANONICAL_NAMES.ALL_AGE,
    tagCode: concept('全年龄')
  }
}

const AUDIO_DURATION_TOLERANCE_SEC = 2.0
const VIDEO_TAIL_TOLERANCE_SEC = 2.0

function normalizeRatingSpec(raw: unknown, tags: string[] = []): RatingSpec | undefined {
  if (typeof raw === 'string' && raw.trim()) {
    const key = raw
      .trim()
      .toLowerCase()
      .replace(/[-_\s]/g, '')
    if (key === 'r18g') return RATING_SPECS.r18g
    if (key === 'r18') return RATING_SPECS.r18
    if (key === 'r15') return RATING_SPECS.r15
    if (key === 'pg13') return RATING_SPECS.pg13
    if (key === 'safe' || key === 'allages') return RATING_SPECS.safe
    const code = resolveControlledTagCode(raw.trim())
    if (code === RATING_SPECS.r18g.tagCode) return RATING_SPECS.r18g
    if (code === RATING_SPECS.r18.tagCode) return RATING_SPECS.r18
    if (code === RATING_SPECS.r15.tagCode) return RATING_SPECS.r15
    if (code === RATING_SPECS.pg13.tagCode) return RATING_SPECS.pg13
    if (code === RATING_SPECS.safe.tagCode) return RATING_SPECS.safe
  }

  let best: RatingSpec | undefined
  for (const tag of tags) {
    if (typeof tag !== 'string' || !tag.trim()) continue
    const spec = normalizeRatingSpec(tag, [])
    if (spec && (!best || spec.rank > best.rank)) {
      best = spec
    }
  }
  return best
}

function isSafeOrAllAgesToken(tag: string): boolean {
  const trimmed = tag.trim()
  if (!trimmed) return false
  const lower = trimmed.toLowerCase()
  if (lower === 'safe' || lower === 'all_ages' || lower === 'allages') return true
  const code = resolveControlledTagCode(trimmed)
  return (
    code === RATING_SPECS.safe.tagCode ||
    resolveControlledTagCode(trimmed) === resolveControlledTagCode('安全')
  )
}

function resolveSubtagMapping(
  tagName: string,
  tagCode: string | undefined
): { rootCode: string; dimName: string; parentCategoryName: string } | null {
  const codeOrName = tagCode || tagName
  if (
    codeOrName === concept('露骨性行为') ||
    codeOrName === concept('软色情') ||
    tagName === '露骨性行为' ||
    tagName === '软色情'
  ) {
    return {
      rootCode: DIMENSION_CODES.PORN_SUBDIVISION,
      dimName: getCanonicalConceptName(DIMENSION_CODES.PORN_SUBDIVISION) || '色情细分',
      parentCategoryName: getCanonicalConceptName(concept('色情')) || '色情'
    }
  }
  if (tagName === '血腥暴力' || codeOrName === resolveControlledTagCode('血腥暴力')) {
    return {
      rootCode: DIMENSION_CODES.BLOODY_SUBDIVISION,
      dimName: getCanonicalConceptName(DIMENSION_CODES.BLOODY_SUBDIVISION) || '血腥细分',
      parentCategoryName: getCanonicalConceptName(concept('血腥')) || '血腥'
    }
  }
  if (tagName === '涉政违规' || codeOrName === resolveControlledTagCode('涉政违规')) {
    return {
      rootCode: DIMENSION_CODES.POLITICAL_SUBDIVISION,
      dimName: getCanonicalConceptName(DIMENSION_CODES.POLITICAL_SUBDIVISION) || '涉政细分',
      parentCategoryName: getCanonicalConceptName(concept('涉政')) || '涉政'
    }
  }
  if (tagName === '违法违规' || codeOrName === resolveControlledTagCode('违法违规')) {
    return {
      rootCode: DIMENSION_CODES.VIOLATION_SUBDIVISION,
      dimName: getCanonicalConceptName(DIMENSION_CODES.VIOLATION_SUBDIVISION) || '违规细分',
      parentCategoryName: getCanonicalConceptName(concept('违规')) || '违规'
    }
  }
  return null
}

function parseExifObject(rawExif: unknown): Record<string, any> {
  if (!rawExif) return {}
  if (ArrayBuffer.isView(rawExif)) {
    const buf = Buffer.isBuffer(rawExif)
      ? rawExif
      : Buffer.from(rawExif.buffer, rawExif.byteOffset, rawExif.byteLength)
    const decompressed = decompressJson(buf)
    if (decompressed && typeof decompressed === 'object') {
      return { ...(decompressed as Record<string, any>) }
    }
    return {}
  }
  if (rawExif instanceof ArrayBuffer) {
    const decompressed = decompressJson(Buffer.from(rawExif))
    if (decompressed && typeof decompressed === 'object') {
      return { ...(decompressed as Record<string, any>) }
    }
    return {}
  }
  if (typeof rawExif === 'object') {
    return { ...(rawExif as Record<string, any>) }
  }
  const decompressed = decompressJson(rawExif as any)
  if (decompressed && typeof decompressed === 'object') {
    return { ...(decompressed as Record<string, any>) }
  }
  if (typeof rawExif === 'string') {
    try {
      const parsed = JSON.parse(rawExif)
      if (parsed && typeof parsed === 'object') return { ...parsed }
    } catch {
      // 非 JSON 字符串忽略，返回空对象
    }
  }
  return {}
}

function resolveProbedVideoDurationSec(exif: Record<string, any>): number | null {
  const candidates = [
    exif?.video?.duration_seconds,
    exif?.video?.duration,
    exif?.duration_seconds,
    exif?.duration
  ]
  for (const val of candidates) {
    if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
      return val
    }
  }
  return null
}

function isAudioCoverageCompleteForBackfill(exif: Record<string, any>): boolean {
  if (exif.has_audio_stream === false) return true
  if (exif.audio_truncated === false) return true
  if (exif.audio_truncated === true) return false

  // 兼容仅落了总时长与已分析时长字段的场景
  if (
    typeof exif.audio_total_duration_sec === 'number' &&
    Number.isFinite(exif.audio_total_duration_sec) &&
    typeof exif.audio_analyzed_duration_sec === 'number' &&
    Number.isFinite(exif.audio_analyzed_duration_sec)
  ) {
    return (
      exif.audio_analyzed_duration_sec + AUDIO_DURATION_TOLERANCE_SEC >=
      exif.audio_total_duration_sec
    )
  }

  return false
}

/**
 * 在单个后台视频切片（k >= 1）完成向量持久化并标记 completed 后，
 * 对文件主记录与标签树执行单调安全聚合与全量完备「全年龄」延迟补标 (Spec §3.2 / §4)：
 * 1. 打码等级（mosaic_level）单调取 max 并更新薄码/有码事实标签；
 * 2. NSFW 风险分级与敏感标签单调上浮（严格尊重 files.rating_user_override）；
 * 3. 当且仅当全部切片完成、视频无未扫描尾部、音轨完成全量 ASR（或无音轨）且插件未禁用时，
 *    补签发 `全年龄` (`builtin.all_ages`) 并将 `nsfw_completeness` 置为 `'complete'`。
 */
export async function aggregateVideoSegmentSafetyAfterCompletion(
  input: VideoSegmentSafetyAggregationInput
): Promise<VideoSegmentSafetyAggregationResult> {
  const emptyResult: VideoSegmentSafetyAggregationResult = {
    exifUpdated: false,
    tagsUpdated: false,
    backfilledAllAges: false
  }

  const { db, fileFingerprint, enableNsfwPerception, perception, language = 'zh-CN' } = input
  if (!db || typeof db.prepare !== 'function' || !fileFingerprint) {
    return emptyResult
  }

  // 兼容单测中的轻量 mock db（未实现 .get / SQL 表时安全退出，不阻断切片主流程）
  let fileRow: { rating_user_override?: string | number | boolean | null } | undefined
  let contentRow: { exif?: unknown } | undefined
  let segmentRows: Array<{ status?: string; end_pts_sec?: number }> = []
  try {
    const fileStmt = db.prepare('SELECT rating_user_override FROM files WHERE file_fingerprint = ?')
    const contentStmt = db.prepare('SELECT exif FROM file_contents WHERE file_fingerprint = ?')
    const segStmt = db.prepare(
      'SELECT status, end_pts_sec FROM file_video_segments WHERE file_id = ?'
    )
    if (
      typeof fileStmt?.get !== 'function' ||
      typeof contentStmt?.get !== 'function' ||
      typeof segStmt?.all !== 'function'
    ) {
      return emptyResult
    }
    fileRow = fileStmt.get(fileFingerprint) as
      | { rating_user_override?: string | number | boolean | null }
      | undefined
    contentRow = contentStmt.get(fileFingerprint) as { exif?: unknown } | undefined
    segmentRows =
      (segStmt.all(fileFingerprint) as Array<{ status?: string; end_pts_sec?: number }>) || []
  } catch (err) {
    logger.debug(
      LogCategory.ANALYSIS_QUEUE,
      `[视频补全安全聚合] 读取数据库状态跳过 (file=${fileFingerprint}):`,
      err
    )
    return emptyResult
  }

  if (!fileRow) {
    return emptyResult
  }

  const rawOverride =
    typeof fileRow.rating_user_override === 'string'
      ? fileRow.rating_user_override.trim()
      : fileRow.rating_user_override
  const hasUserRatingOverride =
    Boolean(rawOverride) && rawOverride !== '0' && rawOverride !== 'false'
  const exif = parseExifObject(contentRow?.exif)
  let exifUpdated = false
  let escalatedRating: string | undefined
  let escalatedMosaicLevel: number | undefined
  let backfilledAllAges = false

  const groundTruthTags: Array<{
    tagName: string
    confidence: number
    tagCode?: string
    code?: string
    viaParentCode?: string
    viaParentName?: string
    parentCodes?: string[]
    group: 'fact'
  }> = []

  // 待前置回源的动态词列表（确保 preResolve 先执行，再查 resolveTagCode）
  let pendingMosaicTagName: string | undefined
  let pendingSecurityConfName: string | undefined
  let pendingSensCategories: string[] = []
  let pendingSubTags: string[] = []

  // 1. 马赛克/打码等级单调上浮（无视 NSFW 插件开关，视觉实体缺陷恒做单调聚合）
  const incomingMosaicLevel =
    typeof perception?.mosaic_level === 'number' && Number.isFinite(perception.mosaic_level)
      ? perception.mosaic_level
      : 0
  const existingMosaicLevel =
    typeof exif.mosaic_level === 'number' && Number.isFinite(exif.mosaic_level)
      ? exif.mosaic_level
      : 0

  if (incomingMosaicLevel > existingMosaicLevel && incomingMosaicLevel >= 1) {
    exif.mosaic_level = incomingMosaicLevel
    exif.has_mosaic = true
    exif.mosaic_status = incomingMosaicLevel >= 2 ? 'heavy' : 'thin'
    exifUpdated = true
    escalatedMosaicLevel = incomingMosaicLevel

    pendingMosaicTagName =
      incomingMosaicLevel >= 2 ? CANONICAL_NAMES.HAS_MOSAIC : CANONICAL_NAMES.THIN_MOSAIC
  }

  // 2. NSFW 风险单调上浮与延迟「全年龄」补标（仅在启用 NSFW 感知且引擎未返回 disabled 时）
  const pluginAllowsNsfw =
    enableNsfwPerception !== false && perception?.nsfw_completeness !== 'disabled'

  const existingNsfwTags = Array.isArray(exif.nsfw_tags)
    ? exif.nsfw_tags.filter(
        (t: unknown): t is string => typeof t === 'string' && !isSafeOrAllAgesToken(t)
      )
    : []
  const existingSensitiveTypes = Array.isArray(exif.sensitive_types)
    ? exif.sensitive_types.filter(
        (t: unknown): t is string => typeof t === 'string' && Boolean(t.trim())
      )
    : []
  const existingRatingSpec = normalizeRatingSpec(exif.content_rating, existingNsfwTags)
  let currentRatingRank = existingRatingSpec?.rank ?? 0

  if (pluginAllowsNsfw && perception) {
    const incomingRawNsfwTags = Array.isArray(perception.nsfw_tags)
      ? perception.nsfw_tags.filter(
          (t): t is string => typeof t === 'string' && Boolean(t.trim()) && !isSafeOrAllAgesToken(t)
        )
      : []
    const incomingSensitiveTypes = Array.isArray(perception.sensitive_types)
      ? perception.sensitive_types.filter(
          (t): t is string => typeof t === 'string' && Boolean(t.trim())
        )
      : []

    const incomingRatingSpec = normalizeRatingSpec(perception.content_rating, incomingRawNsfwTags)
    const incomingRiskSpec =
      incomingRatingSpec && incomingRatingSpec.rank >= 2 ? incomingRatingSpec : undefined

    const newSensitiveTypes = incomingSensitiveTypes.filter(
      st => !existingSensitiveTypes.includes(st)
    )
    const newNsfwTags = incomingRawNsfwTags.filter(t => !existingNsfwTags.includes(t))

    if (newSensitiveTypes.length > 0) {
      exif.sensitive_types = [...existingSensitiveTypes, ...newSensitiveTypes]
      exifUpdated = true
    }
    if (newNsfwTags.length > 0) {
      exif.nsfw_tags = [...existingNsfwTags, ...newNsfwTags]
      exifUpdated = true
    }

    // 分级单调上浮（绝不覆盖用户显式手选分级 files.rating_user_override）
    if (!hasUserRatingOverride && incomingRiskSpec && incomingRiskSpec.rank > currentRatingRank) {
      currentRatingRank = incomingRiskSpec.rank
      exif.content_rating = incomingRiskSpec.tagName
      exifUpdated = true
      escalatedRating = incomingRiskSpec.tagName

      const ratingDimName = getCanonicalConceptName(DIMENSION_CODES.CONTENT_RATING) || '内容分级'
      groundTruthTags.push({
        tagName: incomingRiskSpec.tagName,
        confidence: FACT_TAG_CONFIDENCE,
        code: incomingRiskSpec.tagCode,
        tagCode: incomingRiskSpec.tagCode,
        viaParentCode: DIMENSION_CODES.CONTENT_RATING,
        viaParentName: ratingDimName,
        parentCodes: [DIMENSION_CODES.CONTENT_RATING],
        group: 'fact'
      })
    }

    const totalSensitiveTypes = Array.isArray(exif.sensitive_types) ? exif.sensitive_types : []
    const effectiveRisk = (incomingRiskSpec?.rank ?? 0) >= 4 || totalSensitiveTypes.length > 0

    if (!hasUserRatingOverride && effectiveRisk) {
      pendingSecurityConfName = '保密'
      pendingSensCategories = newSensitiveTypes
      pendingSubTags = newNsfwTags
    }

    if (perception.video_truncated === true && exif.video_truncated !== true) {
      exif.video_truncated = true
      exifUpdated = true
    }

    // 3. 尾片全部完成后的完备「全年龄」延迟补标：
    // 必须同时满足：
    // - 无用户手选覆写
    // - 首段/当前未曾标记 nsfw_completeness = 'disabled'
    // - 任何片段均未发生视觉预算/看门狗内部截断（exif.video_truncated !== true && perception.video_truncated !== true）
    // - file_video_segments 全量切片均已 completed 且覆盖到 probedVideoDuration（无预算外截断尾段）
    // - 音轨完成全量 ASR（audio_truncated === false）或确认无音频流（has_audio_stream === false）
    // - 整个视频未命中任何风险分级（PG-13 / R-15 / R-18 / R-18G）或敏感类型
    const hasAnySegments = segmentRows.length > 0
    const allSegmentsCompleted =
      hasAnySegments && segmentRows.every(row => row.status === 'completed')
    const maxCompletedEndSec = segmentRows.reduce((max, row) => {
      const val =
        typeof row.end_pts_sec === 'number' && Number.isFinite(row.end_pts_sec)
          ? row.end_pts_sec
          : 0
      return Math.max(max, val)
    }, 0)
    const probedVideoDurationSec = resolveProbedVideoDurationSec(exif)
    const noVisualTruncation = exif.video_truncated !== true && perception.video_truncated !== true
    const visualTailCovered =
      noVisualTruncation &&
      (probedVideoDurationSec === null
        ? exif.video_truncated === false
        : maxCompletedEndSec + VIDEO_TAIL_TOLERANCE_SEC >= probedVideoDurationSec)
    const audioComplete = isAudioCoverageCompleteForBackfill(exif)
    const stage0NotDisabled = exif.nsfw_completeness !== 'disabled'
    const noRiskDetected =
      currentRatingRank < 2 &&
      (!Array.isArray(exif.sensitive_types) || exif.sensitive_types.length === 0)

    if (
      !hasUserRatingOverride &&
      stage0NotDisabled &&
      allSegmentsCompleted &&
      visualTailCovered &&
      audioComplete &&
      noRiskDetected
    ) {
      if (
        exif.content_rating !== CANONICAL_NAMES.ALL_AGE ||
        exif.nsfw_completeness !== 'complete'
      ) {
        exif.content_rating = CANONICAL_NAMES.ALL_AGE
        exif.nsfw_completeness = 'complete'
        exifUpdated = true
        backfilledAllAges = true
      }
      groundTruthTags.push({
        tagName: CANONICAL_NAMES.ALL_AGE,
        confidence: FACT_TAG_CONFIDENCE,
        code: RATING_SPECS.safe.tagCode,
        tagCode: RATING_SPECS.safe.tagCode,
        viaParentCode: DIMENSION_CODES.CONTENT_RATING,
        viaParentName: getCanonicalConceptName(DIMENSION_CODES.CONTENT_RATING) || '内容分级',
        parentCodes: [DIMENSION_CODES.CONTENT_RATING],
        group: 'fact'
      })
    } else if (
      allSegmentsCompleted &&
      visualTailCovered &&
      audioComplete &&
      stage0NotDisabled &&
      exif.nsfw_completeness !== 'complete'
    ) {
      // 已完备但命中了 R-15/R-18/R-18G 风险时，同样将完备态同步收口为 complete（保留风险分级，不落全年龄）
      exif.nsfw_completeness = 'complete'
      exifUpdated = true
    }
  }

  // 在解析具体受控码与细分归属前，先批量执行 preResolveControlledCandidates，
  // 避免 `血腥暴力`/`涉政违规`/`违法违规`/`保密` 因未在 AOT 而被静默丢失。
  const preResolveBatch = Array.from(
    new Set(
      [
        pendingMosaicTagName,
        pendingSecurityConfName,
        ...pendingSensCategories,
        ...pendingSubTags,
        ...groundTruthTags.map(t => t.tagName)
      ].filter((w): w is string => Boolean(w && w.trim()))
    )
  )
  if (preResolveBatch.length > 0) {
    try {
      await preResolveControlledCandidates(preResolveBatch, language)
    } catch (err) {
      logger.warn(
        LogCategory.ANALYSIS_QUEUE,
        `[视频补全安全聚合] 前置受控词回源降级 (file=${fileFingerprint}):`,
        err
      )
    }
  }

  const resolveCode = (lemma: string): string | undefined =>
    input.resolveControlledCode?.(lemma) || resolveControlledTagCode(lemma)

  if (pendingMosaicTagName) {
    const mosaicDimName = getCanonicalConceptName(DIMENSION_CODES.MOSAIC_LEVEL) || '打码程度'
    const mosaicCode = resolveCode(pendingMosaicTagName) || concept(pendingMosaicTagName as any)
    groundTruthTags.push({
      tagName: pendingMosaicTagName,
      confidence: FACT_TAG_CONFIDENCE,
      code: mosaicCode,
      tagCode: mosaicCode,
      viaParentCode: DIMENSION_CODES.MOSAIC_LEVEL,
      viaParentName: mosaicDimName,
      parentCodes: [DIMENSION_CODES.MOSAIC_LEVEL],
      group: 'fact'
    })
  }

  if (pendingSecurityConfName) {
    const confCode = resolveCode(pendingSecurityConfName)
    const confName =
      (confCode ? getCanonicalConceptName(confCode) : undefined) || pendingSecurityConfName
    if (exif.security_level !== confName) {
      exif.security_level = confName
      exifUpdated = true
    }
    groundTruthTags.push({
      tagName: confName,
      confidence: FACT_TAG_CONFIDENCE,
      code: confCode,
      tagCode: confCode,
      viaParentCode: DIMENSION_CODES.SECURITY_LEVEL,
      viaParentName: getCanonicalConceptName(DIMENSION_CODES.SECURITY_LEVEL) || '安全等级',
      parentCodes: [DIMENSION_CODES.SECURITY_LEVEL],
      group: 'fact'
    })
  }

  if (pendingSensCategories.length > 0) {
    const sensDimName = getCanonicalConceptName(DIMENSION_CODES.SENSITIVE_CONTENT) || '敏感内容'
    for (const cat of pendingSensCategories) {
      const catCode = resolveCode(cat)
      groundTruthTags.push({
        tagName: cat,
        confidence: FACT_TAG_CONFIDENCE,
        code: catCode,
        tagCode: catCode,
        viaParentCode: DIMENSION_CODES.SENSITIVE_CONTENT,
        viaParentName: sensDimName,
        parentCodes: [DIMENSION_CODES.SENSITIVE_CONTENT],
        group: 'fact'
      })
    }
  }

  // 独立按 subTag 自身语义映射到对应细分子维度（即使母类此前切片已落库也能独立增量落库，且严禁跨类错挂）
  if (pendingSubTags.length > 0) {
    for (const subTag of pendingSubTags) {
      const subCode = resolveCode(subTag)
      const mapping = resolveSubtagMapping(subTag, subCode)
      if (!mapping) continue
      // 若子标签对应母类此前尚未记录进 exif.sensitive_types，顺带补齐母类事实关联
      const knownCats = Array.isArray(exif.sensitive_types) ? exif.sensitive_types : []
      if (!knownCats.includes(mapping.parentCategoryName)) {
        exif.sensitive_types = [...knownCats, mapping.parentCategoryName]
        exifUpdated = true
        const catCode = resolveCode(mapping.parentCategoryName)
        groundTruthTags.push({
          tagName: mapping.parentCategoryName,
          confidence: FACT_TAG_CONFIDENCE,
          code: catCode,
          tagCode: catCode,
          viaParentCode: DIMENSION_CODES.SENSITIVE_CONTENT,
          viaParentName: getCanonicalConceptName(DIMENSION_CODES.SENSITIVE_CONTENT) || '敏感内容',
          parentCodes: [DIMENSION_CODES.SENSITIVE_CONTENT],
          group: 'fact'
        })
      }
      groundTruthTags.push({
        tagName: subTag,
        confidence: FACT_TAG_CONFIDENCE,
        code: subCode,
        tagCode: subCode,
        viaParentCode: mapping.rootCode,
        viaParentName: mapping.dimName,
        parentCodes: [mapping.rootCode],
        group: 'fact'
      })
    }
  }

  if (exifUpdated) {
    const compressed = compressJson(exif)
    const updStmt = db.prepare('UPDATE file_contents SET exif = ? WHERE file_fingerprint = ?')
    const updRes = updStmt.run(compressed, fileFingerprint)
    if (!updRes || updRes.changes === 0) {
      db.prepare('INSERT OR IGNORE INTO file_contents (file_fingerprint, exif) VALUES (?, ?)').run(
        fileFingerprint,
        compressed
      )
    }
  }

  let tagsUpdated = false
  if (groundTruthTags.length > 0) {
    TagReconciliationArbiter.reconcileAndSave({
      db,
      fileFingerprint,
      groundTruthTags,
      clearTagGroups: [],
      language,
      resolveControlledCode: input.resolveControlledCode
    })
    tagsUpdated = true
    input.queueFtsSync?.(fileFingerprint)
  }

  return {
    exifUpdated,
    tagsUpdated,
    escalatedRating,
    backfilledAllAges,
    escalatedMosaicLevel
  }
}
