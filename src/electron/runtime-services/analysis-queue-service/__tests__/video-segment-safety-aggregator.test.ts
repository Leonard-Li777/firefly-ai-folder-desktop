import Database from 'better-sqlite3'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { CANONICAL_NAMES, DIMENSION_CODES, concept } from '@firefly/shared'
import { GENESIS_V1_SCHEMA } from '../../database/database'
import { compressJson, decompressJson } from '../../../utils/text-compressor'

vi.mock('@firefly/core-engine', async importOriginal => {
  const actual = await importOriginal<typeof import('@firefly/core-engine')>()
  return {
    ...actual,
    preResolveControlledCandidates: vi.fn().mockResolvedValue(0)
  }
})

import { resolveControlledTagCode } from '@firefly/core-engine'
import { aggregateVideoSegmentSafetyAfterCompletion } from '../file-processor/video-segment-safety-aggregator'

function createInMemoryDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(GENESIS_V1_SCHEMA)
  return db
}

function seedVideoFile(
  db: Database.Database,
  opts: {
    fileFingerprint: string
    exif?: Record<string, any>
    ratingUserOverride?: string | null
    segments: Array<{
      segmentIndex: number
      status: string
      startPtsSec: number
      endPtsSec: number
    }>
  }
) {
  db.prepare(
    `INSERT INTO files (file_fingerprint, size, extension, file_group, rating_user_override)
     VALUES (?, 102400, '.mp4', 'video', ?)`
  ).run(opts.fileFingerprint, opts.ratingUserOverride ?? null)

  db.prepare(`INSERT INTO file_contents (file_fingerprint, exif) VALUES (?, ?)`).run(
    opts.fileFingerprint,
    compressJson(opts.exif ?? {})
  )

  const insertSeg = db.prepare(
    `INSERT INTO file_video_segments (
       id, file_id, segment_index, start_pts_sec, end_pts_sec, status, params_hash, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'test_hash', 1000, 1000)`
  )
  for (const s of opts.segments) {
    insertSeg.run(
      `${opts.fileFingerprint}:${s.segmentIndex}`,
      opts.fileFingerprint,
      s.segmentIndex,
      s.startPtsSec,
      s.endPtsSec,
      s.status
    )
  }
}

function readTagCodes(db: Database.Database, fileFingerprint: string): string[] {
  const rows = db
    .prepare('SELECT tag_code FROM file_tag_relations WHERE file_fingerprint = ?')
    .all(fileFingerprint) as Array<{ tag_code: string }>
  return rows.map(r => r.tag_code)
}

function readExif(db: Database.Database, fileFingerprint: string): Record<string, any> {
  const row = db
    .prepare('SELECT exif FROM file_contents WHERE file_fingerprint = ?')
    .get(fileFingerprint) as { exif?: unknown } | undefined
  return (decompressJson(row?.exif as any) as Record<string, any>) || {}
}

describe('aggregateVideoSegmentSafetyAfterCompletion', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createInMemoryDb()
  })

  afterEach(() => {
    db.close()
  })

  it('单调上浮 R-18 与打码等级并联动保密标签，同时保留既有标签', async () => {
    const fp = 'fp_video_escalate_01'
    seedVideoFile(db, {
      fileFingerprint: fp,
      exif: {
        video: { duration_seconds: 240 },
        has_audio_stream: true,
        audio_truncated: false,
        nsfw_completeness: 'partial',
        mosaic_level: 0
      },
      segments: [
        { segmentIndex: 0, status: 'completed', startPtsSec: 0, endPtsSec: 90 },
        { segmentIndex: 1, status: 'completed', startPtsSec: 90, endPtsSec: 180 },
        { segmentIndex: 2, status: 'pending', startPtsSec: 180, endPtsSec: 240 }
      ]
    })

    // 预置一条既有的 AI 内容标签，验证增量写回不会误清既有标签
    const pathInsert = db
      .prepare(
        `INSERT INTO tag_paths (leaf_code, via_parent_code, code_path, depth)
         VALUES ('omw.12345678.n', ?, '/builtin.content_tags/omw.12345678.n', 2)`
      )
      .run(DIMENSION_CODES.CONTENT_TAGS)
    db.prepare(
      `INSERT INTO file_tag_relations (file_fingerprint, path_id, tag_code, confidence, source, tag_group, via_parent_code, created_at, updated_at)
       VALUES (?, ?, ?, 0.9, 'ai', 'ai', ?, 1000, 1000)`
    ).run(fp, pathInsert.lastInsertRowid, 'omw.12345678.n', DIMENSION_CODES.CONTENT_TAGS)

    const queueFtsSync = vi.fn()
    const res = await aggregateVideoSegmentSafetyAfterCompletion({
      db,
      fileFingerprint: fp,
      enableNsfwPerception: true,
      perception: {
        content_rating: 'r18',
        nsfw_tags: ['色情', 'R-18'],
        sensitive_types: ['色情'],
        mosaic_level: 2,
        nsfw_completeness: 'partial'
      },
      queueFtsSync
    })

    expect(res.escalatedRating).toBe('R-18')
    expect(res.escalatedMosaicLevel).toBe(2)
    expect(res.backfilledAllAges).toBe(false)
    expect(queueFtsSync).toHaveBeenCalledWith(fp)

    const exif = readExif(db, fp)
    expect(exif.content_rating).toBe('R-18')
    expect(exif.mosaic_level).toBe(2)
    expect(exif.mosaic_status).toBe('heavy')
    expect(exif.security_level).toBe('保密')

    const codes = readTagCodes(db, fp)
    expect(codes).toContain('omw.12345678.n')
    expect(codes).toContain(concept('R-18'))
    const securityRows = db
      .prepare(
        'SELECT tag_code FROM file_tag_relations WHERE file_fingerprint = ? AND via_parent_code = ?'
      )
      .all(fp, DIMENSION_CODES.SECURITY_LEVEL) as Array<{ tag_code: string }>
    expect(securityRows.length).toBe(1)
    if (resolveControlledTagCode('保密')) {
      expect(securityRows[0].tag_code).toBe(resolveControlledTagCode('保密'))
    }
    expect(codes).toContain(concept(CANONICAL_NAMES.HAS_MOSAIC))
    expect(codes).toContain(concept('色情'))
    expect(codes).not.toContain(concept('全年龄'))
  })

  it('尊重 files.rating_user_override：不覆写分级与安全等级，但仍允许打码等级单调上浮', async () => {
    const fp = 'fp_video_override_02'
    seedVideoFile(db, {
      fileFingerprint: fp,
      ratingUserOverride: 'pg13',
      exif: {
        video: { duration_seconds: 180 },
        content_rating: 'PG-13',
        mosaic_level: 0
      },
      segments: [
        { segmentIndex: 0, status: 'completed', startPtsSec: 0, endPtsSec: 90 },
        { segmentIndex: 1, status: 'completed', startPtsSec: 90, endPtsSec: 180 }
      ]
    })

    const res = await aggregateVideoSegmentSafetyAfterCompletion({
      db,
      fileFingerprint: fp,
      enableNsfwPerception: true,
      perception: {
        content_rating: 'r18g',
        nsfw_tags: ['血腥暴力', 'R-18G'],
        sensitive_types: ['血腥'],
        mosaic_level: 1,
        nsfw_completeness: 'partial'
      }
    })

    expect(res.escalatedRating).toBeUndefined()
    expect(res.escalatedMosaicLevel).toBe(1)

    const exif = readExif(db, fp)
    expect(exif.content_rating).toBe('PG-13')
    expect(exif.mosaic_level).toBe(1)

    const codes = readTagCodes(db, fp)
    expect(codes).not.toContain(concept('R-18G'))
    const securityRows = db
      .prepare(
        'SELECT tag_code FROM file_tag_relations WHERE file_fingerprint = ? AND via_parent_code = ?'
      )
      .all(fp, DIMENSION_CODES.SECURITY_LEVEL) as Array<{ tag_code: string }>
    expect(securityRows.length).toBe(0)
    expect(codes).toContain(concept(CANONICAL_NAMES.THIN_MOSAIC))
  })

  it('严格「全年龄」延迟补标门控：仅在全部切片完成、音轨未截断且插件未禁用时补标', async () => {
    // 场景 A：audio_truncated=true 即使全部分片完成也严禁签发「全年龄」
    const fpTruncAudio = 'fp_video_audio_trunc_03a'
    seedVideoFile(db, {
      fileFingerprint: fpTruncAudio,
      exif: {
        video: { duration_seconds: 180 },
        has_audio_stream: true,
        audio_truncated: true,
        nsfw_completeness: 'partial'
      },
      segments: [
        { segmentIndex: 0, status: 'completed', startPtsSec: 0, endPtsSec: 90 },
        { segmentIndex: 1, status: 'completed', startPtsSec: 90, endPtsSec: 180 }
      ]
    })

    const resA = await aggregateVideoSegmentSafetyAfterCompletion({
      db,
      fileFingerprint: fpTruncAudio,
      enableNsfwPerception: true,
      perception: { nsfw_completeness: 'partial' }
    })
    expect(resA.backfilledAllAges).toBe(false)
    expect(readExif(db, fpTruncAudio).content_rating).toBeUndefined()
    expect(readTagCodes(db, fpTruncAudio)).not.toContain(concept('全年龄'))

    // 场景 B：Stage 2 曾标记 nsfw_completeness='disabled' 时同样严禁后补「全年龄」
    const fpDisabled = 'fp_video_disabled_03b'
    seedVideoFile(db, {
      fileFingerprint: fpDisabled,
      exif: {
        video: { duration_seconds: 180 },
        has_audio_stream: false,
        nsfw_completeness: 'disabled'
      },
      segments: [
        { segmentIndex: 0, status: 'completed', startPtsSec: 0, endPtsSec: 90 },
        { segmentIndex: 1, status: 'completed', startPtsSec: 90, endPtsSec: 180 }
      ]
    })

    const resB = await aggregateVideoSegmentSafetyAfterCompletion({
      db,
      fileFingerprint: fpDisabled,
      enableNsfwPerception: true,
      perception: { nsfw_completeness: 'partial' }
    })
    expect(resB.backfilledAllAges).toBe(false)
    expect(readTagCodes(db, fpDisabled)).not.toContain(concept('全年龄'))

    // 场景 C：全切片完成 + 覆盖全片时长 + audio_truncated=false + 无风险 -> 补标「全年龄」并收口 complete
    const fpComplete = 'fp_video_complete_03c'
    seedVideoFile(db, {
      fileFingerprint: fpComplete,
      exif: {
        video: { duration_seconds: 180 },
        has_audio_stream: true,
        audio_truncated: false,
        nsfw_completeness: 'partial'
      },
      segments: [
        { segmentIndex: 0, status: 'completed', startPtsSec: 0, endPtsSec: 90 },
        { segmentIndex: 1, status: 'completed', startPtsSec: 90, endPtsSec: 180 }
      ]
    })

    const resC = await aggregateVideoSegmentSafetyAfterCompletion({
      db,
      fileFingerprint: fpComplete,
      enableNsfwPerception: true,
      perception: { nsfw_completeness: 'partial' }
    })
    expect(resC.backfilledAllAges).toBe(true)
    const exifC = readExif(db, fpComplete)
    expect(exifC.content_rating).toBe('全年龄')
    expect(exifC.nsfw_completeness).toBe('complete')
    expect(readTagCodes(db, fpComplete)).toContain(concept('全年龄'))

    // 场景 D：容器时长未知且无 video_truncated === false 确认时，绝不因 maxCompletedEndSec > 0 放行「全年龄」
    const fpUnknownDur = 'fp_video_unknown_dur_03d'
    seedVideoFile(db, {
      fileFingerprint: fpUnknownDur,
      exif: {
        has_audio_stream: false,
        nsfw_completeness: 'partial'
      },
      segments: [{ segmentIndex: 0, status: 'completed', startPtsSec: 0, endPtsSec: 90 }]
    })
    const resD = await aggregateVideoSegmentSafetyAfterCompletion({
      db,
      fileFingerprint: fpUnknownDur,
      enableNsfwPerception: true,
      perception: { nsfw_completeness: 'partial' }
    })
    expect(resD.backfilledAllAges).toBe(false)
    expect(readTagCodes(db, fpUnknownDur)).not.toContain(concept('全年龄'))

    // 场景 E：即使名义分段结束时间已达总长，只要首段/末段发生视觉内部截断（video_truncated=true），严禁补标「全年龄」
    const fpTruncVisual = 'fp_video_trunc_visual_03e'
    seedVideoFile(db, {
      fileFingerprint: fpTruncVisual,
      exif: {
        video: { duration_seconds: 180 },
        has_audio_stream: false,
        video_truncated: false,
        nsfw_completeness: 'partial'
      },
      segments: [
        { segmentIndex: 0, status: 'completed', startPtsSec: 0, endPtsSec: 90 },
        { segmentIndex: 1, status: 'completed', startPtsSec: 90, endPtsSec: 180 }
      ]
    })
    const resE = await aggregateVideoSegmentSafetyAfterCompletion({
      db,
      fileFingerprint: fpTruncVisual,
      enableNsfwPerception: true,
      perception: { nsfw_completeness: 'partial', video_truncated: true }
    })
    expect(resE.backfilledAllAges).toBe(false)
    expect(readExif(db, fpTruncVisual).video_truncated).toBe(true)
    expect(readTagCodes(db, fpTruncVisual)).not.toContain(concept('全年龄'))
  })

  it('敏感细分子标签增量落库与多类别父级严格隔离（避免同母类漏落与跨类错挂）', async () => {
    const fp = 'fp_video_subdiv_isolation_04'
    seedVideoFile(db, {
      fileFingerprint: fp,
      exif: {
        video: { duration_seconds: 180 },
        content_rating: 'R-15',
        sensitive_types: ['色情'],
        nsfw_tags: ['软色情'],
        nsfw_completeness: 'partial'
      },
      segments: [
        { segmentIndex: 0, status: 'completed', startPtsSec: 0, endPtsSec: 90 },
        { segmentIndex: 1, status: 'completed', startPtsSec: 90, endPtsSec: 180 }
      ]
    })

    // 前序切片已有「色情」，本切片增量检出同类的「露骨性行为」以及新增的「血腥/血腥暴力」
    const res = await aggregateVideoSegmentSafetyAfterCompletion({
      db,
      fileFingerprint: fp,
      enableNsfwPerception: true,
      perception: {
        content_rating: 'r18g',
        sensitive_types: ['色情', '血腥'],
        nsfw_tags: ['露骨性行为', '血腥暴力', 'R-18G'],
        nsfw_completeness: 'partial'
      },
      resolveControlledCode: lemma => (lemma === '血腥暴力' ? 'hownet.99990001.v' : undefined)
    })

    expect(res.escalatedRating).toBe('R-18G')
    const relRows = db
      .prepare(
        'SELECT tag_code, via_parent_code FROM file_tag_relations WHERE file_fingerprint = ?'
      )
      .all(fp) as Array<{ tag_code: string; via_parent_code: string }>

    const explicitSexRow = relRows.find(r => r.tag_code === concept('露骨性行为'))
    expect(explicitSexRow).toBeDefined()
    // TagReconciliationSaver 将从 `色情细分` 自动重锚至受控直系父级（如 `builtin.physiological_breakdown_of_desire`）或保留 `色情细分`，绝不误挂到 `血腥细分`
    expect([
      DIMENSION_CODES.PORN_SUBDIVISION,
      'builtin.physiological_breakdown_of_desire'
    ]).toContain(explicitSexRow?.via_parent_code)
    expect(relRows).toContainEqual({
      tag_code: 'hownet.99990001.v',
      via_parent_code: DIMENSION_CODES.BLOODY_SUBDIVISION
    })
    // 严禁跨类错挂
    expect(relRows).not.toContainEqual({
      tag_code: 'hownet.99990001.v',
      via_parent_code: DIMENSION_CODES.PORN_SUBDIVISION
    })
    expect(relRows).not.toContainEqual({
      tag_code: concept('露骨性行为'),
      via_parent_code: DIMENSION_CODES.BLOODY_SUBDIVISION
    })
  })
})
