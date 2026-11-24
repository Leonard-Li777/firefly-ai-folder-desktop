import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

const {
  mockSearchVectors,
  mockBatchEmbedText,
  mockGetEmbeddingProfile,
  mockGetClipTextHealth,
  mockEmbedClipText,
  mockGetCachedTierData,
  mockConfigState
} = vi.hoisted(() => ({
  mockSearchVectors: vi.fn(),
  mockBatchEmbedText: vi.fn(),
  mockGetEmbeddingProfile: vi.fn(),
  mockGetClipTextHealth: vi.fn(),
  mockEmbedClipText: vi.fn(),
  mockGetCachedTierData: vi.fn(),
  mockConfigState: { clipEnabled: false }
}))

vi.mock('../../../../services/omni-client', () => ({
  omniClient: {
    searchVectors: mockSearchVectors,
    getClipTextHealth: mockGetClipTextHealth,
    embedClipText: mockEmbedClipText,
    searchFastFs: vi.fn().mockResolvedValue(null),
    tokenizeText: vi.fn().mockResolvedValue([])
  },
  resolveQueryEncoderFilter: (profile: string) => (profile === 'gemma_unified' ? [4] : [0, 1])
}))

vi.mock('../../../system/omni-service', () => ({
  omniService: {
    batchEmbedText: mockBatchEmbedText,
    getEmbeddingProfile: mockGetEmbeddingProfile
  }
}))

vi.mock('../../../user-tier/user-tier-service', () => ({
  userTierService: {
    getCachedData: mockGetCachedTierData
  }
}))

vi.mock('../../../../config/config-orchestrator', () => ({
  ConfigOrchestrator: {
    getInstance: () => ({
      getValue: (key: string) => {
        if (key === 'DEFAULT_LANGUAGE') return 'zh-CN'
        if (key === 'AI_CLIP_TEXT_SEARCH_ENABLED') return mockConfigState.clipEnabled
        if (key === 'EMBEDDING_MRL_DIMENSION') return 768
        return undefined
      }
    })
  }
}))

import {
  HybridSearchArbiter,
  resolveSearchThresholds,
  SEARCH_SIMILARITY_THRESHOLD_DEFAULT,
  TEMPORAL_CHUNK_MIN_CONFIDENCE,
  TEMPORAL_CHUNK_MIN_PROMINENCE,
  MIN_GENERIC_VECTOR_SCORE,
  MIN_CLIP_VECTOR_SCORE
} from '../HybridSearchArbiter'

function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_fingerprint TEXT UNIQUE NOT NULL,
      smart_name TEXT,
      description TEXT,
      author TEXT,
      language TEXT,
      file_group TEXT
    );
    CREATE TABLE workspace_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_fingerprint TEXT NOT NULL,
      workspace_id INTEGER NOT NULL DEFAULT 1,
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      is_analyzed INTEGER DEFAULT 1,
      is_ignored INTEGER DEFAULT 0
    );
    CREATE TABLE file_video_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_fingerprint TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      start_sec REAL NOT NULL,
      end_sec REAL NOT NULL,
      rep_pts_sec REAL,
      meta TEXT
    );
    CREATE VIRTUAL TABLE files_meta_fts USING fts5(
      name,
      smart_name,
      tags,
      description,
      tokenize='trigram'
    );
    CREATE VIRTUAL TABLE files_pinyin_fts USING fts5(
      name_pinyin,
      smart_name_pinyin,
      tags_pinyin,
      description_pinyin,
      tokenize='trigram'
    );
    CREATE VIRTUAL TABLE files_body_fts USING fts5(
      content,
      multimodal_content,
      ocr,
      asr,
      lrc,
      tokenize='trigram'
    );
  `)
  return db
}

function seedVideo(
  db: Database.Database,
  fp: string,
  name: string,
  chunks: Array<{ idx: number; start: number; end: number }>,
  metaFtsText?: { description?: string; tags?: string }
) {
  const info = db
    .prepare(`INSERT INTO files (file_fingerprint, smart_name, description) VALUES (?, ?, ?)`)
    .run(fp, name, metaFtsText?.description ?? '')
  db.prepare(
    `INSERT INTO workspace_files (file_fingerprint, workspace_id, path, name, is_analyzed, is_ignored) VALUES (?, 1, ?, ?, 1, 0)`
  ).run(fp, `C:\\videos\\${name}`, name)
  db.prepare(
    `INSERT INTO files_meta_fts (rowid, name, smart_name, tags, description) VALUES (?, ?, ?, ?, ?)`
  ).run(info.lastInsertRowid, name, name, metaFtsText?.tags ?? '', metaFtsText?.description ?? '')
  const insertChunk = db.prepare(
    `INSERT INTO file_video_chunks (file_fingerprint, chunk_index, start_sec, end_sec, rep_pts_sec, meta) VALUES (?, ?, ?, ?, ?, '{}')`
  )
  for (const c of chunks) {
    insertChunk.run(fp, c.idx, c.start, c.end, c.start + 1)
  }
}

describe('resolveSearchThresholds (多通道阈值联动与动态显著性)', () => {
  it('缺省与非法输入回退默认标定值', () => {
    for (const bad of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = resolveSearchThresholds(bad)
      expect(r.userThreshold).toBe(SEARCH_SIMILARITY_THRESHOLD_DEFAULT)
      expect(r.chunkConfidence).toBe(TEMPORAL_CHUNK_MIN_CONFIDENCE)
      expect(r.genericVector).toBe(MIN_GENERIC_VECTOR_SCORE)
      expect(r.clipVector).toBe(MIN_CLIP_VECTOR_SCORE)
      expect(r.chunkProminence).toBe(TEMPORAL_CHUNK_MIN_PROMINENCE)
      expect(r.omniVectorPushdown).toBe(0.3)
    }
  })

  it('exactMinScore=true 时跳过 [0.25, 0.60] 钳制与分通道偏移，全通道严格等于调用方 minScore', () => {
    for (const v of [0, 0.2, 0.55, 0.9]) {
      const r = resolveSearchThresholds(v, { exactMinScore: true })
      expect(r.userThreshold).toBe(v)
      expect(r.genericVector).toBe(v)
      expect(r.chunkConfidence).toBe(v)
      expect(r.clipVector).toBe(v)
      expect(r.omniVectorPushdown).toBe(v)
      expect(r.chunkProminence).toBe(TEMPORAL_CHUNK_MIN_PROMINENCE)
    }
    // 桌面端缺省模式不受影响
    expect(resolveSearchThresholds(0.55).genericVector).toBe(0.5)
    expect(resolveSearchThresholds(0.55).clipVector).toBe(0.58)
  })

  it('调低至 25% 与 30% 时按比例放宽各通道与显著性门禁', () => {
    const low25 = resolveSearchThresholds(0.25)
    expect(low25).toEqual({
      userThreshold: 0.25,
      genericVector: 0.2,
      chunkConfidence: 0.25,
      chunkProminence: 0,
      clipVector: 0.28,
      omniVectorPushdown: 0.2
    })

    const low30 = resolveSearchThresholds(0.3)
    expect(low30).toEqual({
      userThreshold: 0.3,
      genericVector: 0.25,
      chunkConfidence: 0.3,
      chunkProminence: 0.0075,
      clipVector: 0.33,
      omniVectorPushdown: 0.25
    })
  })

  it('调高至 50% 时收紧各通道并维持默认显著性门禁 0.015', () => {
    const high50 = resolveSearchThresholds(0.5)
    expect(high50).toEqual({
      userThreshold: 0.5,
      genericVector: 0.45,
      chunkConfidence: 0.5,
      chunkProminence: 0.015,
      clipVector: 0.53,
      omniVectorPushdown: 0.45
    })
  })

  it('越界输入正确钳制至 [0.25, 0.60]', () => {
    expect(resolveSearchThresholds(0.01).userThreshold).toBe(0.25)
    expect(resolveSearchThresholds(0.99).userThreshold).toBe(0.6)
    expect(resolveSearchThresholds(0.99).genericVector).toBe(0.55)
    expect(resolveSearchThresholds(0.99).clipVector).toBe(0.63)
  })
})

describe('HybridSearchArbiter 视频切片召回门禁一致性与相似度滑块联动', () => {
  let db: Database.Database

  beforeEach(() => {
    vi.clearAllMocks()
    mockConfigState.clipEnabled = false
    db = createTestDb()
    mockGetEmbeddingProfile.mockResolvedValue('gemma_unified')
    mockBatchEmbedText.mockResolvedValue({ vectors: [[0.1, 0.2, 0.3]] })
    mockGetCachedTierData.mockReturnValue({
      computed_limits: { video_max_duration_seconds: 600 }
    })
  })

  it('默认 35% 下：纯切片灰区视频(<0.35)被彻底拦截，仅达标切片视频、整文件语义兜底视频与字面命中视频允许召回', async () => {
    // 1. 达标切片视频（最高 0.3529 >= 0.35 且 prom=0.027 >= 0.015）
    seedVideo(db, 'fp-pass-chunk', 'video-pass.mp4', [
      { idx: 1, start: 10, end: 18 },
      { idx: 2, start: 40, end: 48 },
      { idx: 3, start: 80, end: 88 }
    ])
    // 2. 纯切片灰区幽灵视频（最高 0.3377 < 0.35，无字面、无整文件向量）
    seedVideo(db, 'fp-ghost-gray', 'video-ghost.mp4', [
      { idx: 1, start: 10, end: 18 },
      { idx: 2, start: 40, end: 48 },
      { idx: 3, start: 80, end: 88 }
    ])
    // 3. 整文件语义向量兜底视频（切片 0.32 未达标，但整文件向量 0.42 >= 0.30）
    seedVideo(db, 'fp-whole-fallback', 'video-whole.mp4', [
      { idx: 1, start: 10, end: 18 },
      { idx: 2, start: 40, end: 48 },
      { idx: 3, start: 80, end: 88 }
    ])
    // 4. 字面命中兜底视频（切片 0.31 未达标，但标题/描述包含“双人舞”）
    seedVideo(
      db,
      'fp-literal-fallback',
      'video-literal.mp4',
      [
        { idx: 1, start: 10, end: 18 },
        { idx: 2, start: 40, end: 48 },
        { idx: 3, start: 80, end: 88 }
      ],
      { description: '户外双人舞纪实画面' }
    )

    mockSearchVectors.mockResolvedValue({
      matches: [
        // fp-pass-chunk: max 0.3529, mean 0.3259, prom 0.0270 -> PASS
        { fileFingerprint: 'fp-pass-chunk:c1', score: 0.3529 },
        { fileFingerprint: 'fp-pass-chunk:c2', score: 0.3124 },
        { fileFingerprint: 'fp-pass-chunk:c3', score: 0.3124 },
        // fp-ghost-gray: max 0.3377 < 0.35 -> REJECTED (no whole, no literal)
        { fileFingerprint: 'fp-ghost-gray:c1', score: 0.3377 },
        { fileFingerprint: 'fp-ghost-gray:c2', score: 0.305 },
        { fileFingerprint: 'fp-ghost-gray:c3', score: 0.305 },
        // fp-whole-fallback: chunks fail (<0.35), whole vector 0.42 >= 0.30 -> KEEP with whole score
        { fileFingerprint: 'fp-whole-fallback', score: 0.42 },
        { fileFingerprint: 'fp-whole-fallback:c1', score: 0.32 },
        { fileFingerprint: 'fp-whole-fallback:c2', score: 0.31 },
        { fileFingerprint: 'fp-whole-fallback:c3', score: 0.31 },
        // fp-literal-fallback: chunks fail, no whole vector, FTS matches "两人" -> KEEP via FTS
        { fileFingerprint: 'fp-literal-fallback:c1', score: 0.31 },
        { fileFingerprint: 'fp-literal-fallback:c2', score: 0.305 },
        { fileFingerprint: 'fp-literal-fallback:c3', score: 0.305 }
      ]
    })

    const arbiter = new HybridSearchArbiter(db, {
      networkSignals: true,
      enablePinyinReconcileTimer: false
    })
    const pool = await arbiter.searchHybrid({
      keyword: '双人舞',
      whereClauses: ['wf.workspace_id = ?'],
      queryParams: [1],
      queryEmbedding: [0.1, 0.2, 0.3]
    })

    const byFp = new Map(pool.candidates.map(c => [c.fileFingerprint, c]))

    // 幽灵视频被彻底拦截
    expect(byFp.has('fp-ghost-gray')).toBe(false)

    // 达标切片视频正常召回且携带切片
    const passVideo = byFp.get('fp-pass-chunk')
    expect(passVideo).toBeDefined()
    expect(passVideo?.matchedChunks?.length).toBeGreaterThan(0)
    expect(passVideo?.matchedChunks?.[0].chunkIndex).toBe(1)

    // 整文件语义兜底视频保留且 vecScore 为整文件分 0.42、无切片
    const wholeVideo = byFp.get('fp-whole-fallback')
    expect(wholeVideo).toBeDefined()
    expect(wholeVideo?.vecScore).toBe(0.42)
    expect(wholeVideo?.matchedChunks).toBeUndefined()

    // 字面命中视频保留（via FTS），无切片且不继承被否决的切片分
    const literalVideo = byFp.get('fp-literal-fallback')
    expect(literalVideo).toBeDefined()
    expect(literalVideo?.hasLiteral).toBe(true)
    expect(literalVideo?.matchedChunks).toBeUndefined()
    expect(literalVideo?.vecScore).toBeUndefined()
  })

  it('将滑块调低至 30% 时：0.3377 与低显著性 0.3200 (prom=0.0093 >= 0.0075) 均放行并展示切片', async () => {
    seedVideo(db, 'fp-gray-high-prom', 'video-a.mp4', [
      { idx: 1, start: 10, end: 18 },
      { idx: 2, start: 40, end: 48 },
      { idx: 3, start: 80, end: 88 }
    ])
    seedVideo(db, 'fp-gray-low-prom', 'video-b.mp4', [
      { idx: 1, start: 10, end: 18 },
      { idx: 2, start: 40, end: 48 },
      { idx: 3, start: 80, end: 88 }
    ])

    mockSearchVectors.mockResolvedValue({
      matches: [
        // max=0.3377, mean=0.3159, prom=0.0218
        { fileFingerprint: 'fp-gray-high-prom:c1', score: 0.3377 },
        { fileFingerprint: 'fp-gray-high-prom:c2', score: 0.305 },
        { fileFingerprint: 'fp-gray-high-prom:c3', score: 0.305 },
        // max=0.3200, mean=0.3107, prom=0.0093 (默认 0.015 拦截，30% 下 0.0075 放行)
        { fileFingerprint: 'fp-gray-low-prom:c1', score: 0.32 },
        { fileFingerprint: 'fp-gray-low-prom:c2', score: 0.306 },
        { fileFingerprint: 'fp-gray-low-prom:c3', score: 0.306 }
      ]
    })

    const arbiter = new HybridSearchArbiter(db, {
      networkSignals: true,
      enablePinyinReconcileTimer: false
    })
    const pool = await arbiter.searchHybrid({
      keyword: '两人',
      whereClauses: ['wf.workspace_id = ?'],
      queryParams: [1],
      queryEmbedding: [0.1, 0.2, 0.3],
      similarityThreshold: 0.3
    })

    // 验证 Omni 下推阈值联动降低为 0.25
    expect(mockSearchVectors).toHaveBeenCalledWith(
      [0.1, 0.2, 0.3],
      expect.any(Number),
      expect.objectContaining({ threshold: 0.25 })
    )

    const byFp = new Map(pool.candidates.map(c => [c.fileFingerprint, c]))
    expect(byFp.get('fp-gray-high-prom')?.matchedChunks?.length).toBeGreaterThan(0)
    expect(byFp.get('fp-gray-low-prom')?.matchedChunks?.length).toBeGreaterThan(0)
  })

  it('将滑块调高至 45% 时：通用整文件向量门限同步收紧至 0.40，拦截 0.38 低分纯向量命中', async () => {
    seedVideo(db, 'fp-doc-mid', 'doc-mid.mp4', [])
    seedVideo(db, 'fp-doc-high', 'doc-high.mp4', [])

    mockSearchVectors.mockResolvedValue({
      matches: [
        { fileFingerprint: 'fp-doc-mid', score: 0.38 },
        { fileFingerprint: 'fp-doc-high', score: 0.46 }
      ]
    })

    const arbiter = new HybridSearchArbiter(db, {
      networkSignals: true,
      enablePinyinReconcileTimer: false
    })
    const pool = await arbiter.searchHybrid({
      keyword: '两人',
      whereClauses: ['wf.workspace_id = ?'],
      queryParams: [1],
      queryEmbedding: [0.1, 0.2, 0.3],
      similarityThreshold: 0.45
    })

    expect(mockSearchVectors).toHaveBeenCalledWith(
      [0.1, 0.2, 0.3],
      expect.any(Number),
      expect.objectContaining({ threshold: 0.4 })
    )

    const fps = pool.candidates.map(c => c.fileFingerprint)
    expect(fps).toContain('fp-doc-high')
    expect(fps).not.toContain('fp-doc-mid')
  })

  it('CLIP 通道联动：自定义 similarityThreshold=0.45 时下推 threshold=0.48，且融合层 hasClip 同步使用 0.48 拦截低分项', async () => {
    mockConfigState.clipEnabled = true
    mockGetEmbeddingProfile.mockResolvedValue('classic_light')
    mockGetClipTextHealth.mockResolvedValue({
      available: true,
      imageEncoder: 'chinese_clip',
      textModelReady: true,
      vocabReady: true,
      textOutputVerified: true
    })
    const clipVec = new Array(512).fill(0.05)
    mockEmbedClipText.mockResolvedValue({
      ok: true,
      status: 200,
      vector: clipVec,
      dim: 512,
      encoderId: 2
    })

    seedVideo(db, 'fp-clip-pass', 'clip-pass.jpg', [])
    seedVideo(db, 'fp-clip-low', 'clip-low.jpg', [])

    // 区分文本向量路（encoderFilter=[0,1]）与 CLIP 路（encoderFilter=[2]）
    mockSearchVectors.mockImplementation(async (_vec: number[], _topK: number, opts: any) => {
      if (Array.isArray(opts?.encoderFilter) && opts.encoderFilter.includes(2)) {
        // 故意返回一条低于 0.48 的项（0.42）与一条高于 0.48 的项（0.52），同时验证下推与融合层双闸
        return {
          matches: [
            { fileFingerprint: 'fp-clip-pass', score: 0.52 },
            { fileFingerprint: 'fp-clip-low', score: 0.42 }
          ]
        }
      }
      return { matches: [] }
    })

    const arbiter = new HybridSearchArbiter(db, {
      networkSignals: true,
      enablePinyinReconcileTimer: false
    })

    // 第一次调用预热 CLIP 文本塔，使第二次进入热态并入 Phase 2 直接校验 hasClip 融合判定
    const warmPool = await arbiter.searchHybrid({
      keyword: '两人',
      whereClauses: ['wf.workspace_id = ?'],
      queryParams: [1],
      queryEmbedding: [0.1, 0.2, 0.3],
      similarityThreshold: 0.45
    })
    if (warmPool.pendingClip) {
      await warmPool.pendingClip
    }

    mockSearchVectors.mockClear()
    const hotPool = await arbiter.searchHybrid({
      keyword: '两人',
      whereClauses: ['wf.workspace_id = ?'],
      queryParams: [1],
      queryEmbedding: [0.1, 0.2, 0.3],
      similarityThreshold: 0.45
    })

    // 验证 CLIP 通道下推 threshold = 0.48（0.38 + (0.45 - 0.35)）
    expect(mockSearchVectors).toHaveBeenCalledWith(
      clipVec,
      expect.any(Number),
      expect.objectContaining({
        encoderFilter: [2],
        threshold: 0.48
      })
    )

    // 验证融合层 hasClip 同步使用 0.48：0.52 保留，0.42（虽高于默认 0.38 但低于 0.48）被拦截
    const byFp = new Map(hotPool.candidates.map(c => [c.fileFingerprint, c]))
    expect(byFp.get('fp-clip-pass')?.clipScore).toBe(0.52)
    expect(byFp.has('fp-clip-low')).toBe(false)
  })

  it('P0-1: exactMinScore 下 omniVectorPushdown 取 Math.min(exact, exactVideo)，防止切片在 Omni 侧被提前剪枝', () => {
    // 当 minScore=0.55, videoMinScore=0.45 时，omniVectorPushdown 必须为 0.45（放行候选至切片最低门限）
    const t1 = resolveSearchThresholds(0.55, { exactMinScore: true, videoMinScore: 0.45 })
    expect(t1.genericVector).toBe(0.55)
    expect(t1.chunkConfidence).toBe(0.45)
    expect(t1.omniVectorPushdown).toBe(0.45)

    // 当未指定 videoMinScore 时，二者同为 0.55
    const t2 = resolveSearchThresholds(0.55, { exactMinScore: true })
    expect(t2.genericVector).toBe(0.55)
    expect(t2.chunkConfidence).toBe(0.55)
    expect(t2.omniVectorPushdown).toBe(0.55)

    // 当用户显式提高 videoMinScore=0.60, minScore=0.55 时，omniVectorPushdown 为 0.55
    const t3 = resolveSearchThresholds(0.55, { exactMinScore: true, videoMinScore: 0.6 })
    expect(t3.genericVector).toBe(0.55)
    expect(t3.chunkConfidence).toBe(0.6)
    expect(t3.omniVectorPushdown).toBe(0.55)
  })

  it('P0-2: 短视频 (1~2 个切片) 显著性与绝对门限拦截平铺乱码背景噪声，杜绝无条件短路穿透', async () => {
    // 种子视频：一个 1 切片短视频（纯乱码平铺分 0.46），一个 2 切片短视频（纯平铺分 0.46, 0.455，落差 0.005 < 0.015）
    // 一个 2 切片真实高光短视频（0.52, 0.46，落差 0.06 >= 0.015）
    seedVideo(db, 'fp-flat-1chunk', 'flat-1.mp4', [{ idx: 1, start: 0, end: 10 }])
    seedVideo(db, 'fp-flat-2chunk', 'flat-2.mp4', [
      { idx: 1, start: 0, end: 10 },
      { idx: 2, start: 10, end: 20 }
    ])
    seedVideo(db, 'fp-peak-2chunk', 'peak-2.mp4', [
      { idx: 1, start: 0, end: 10 },
      { idx: 2, start: 10, end: 20 }
    ])

    mockSearchVectors.mockResolvedValue({
      matches: [
        { fileFingerprint: 'fp-flat-1chunk:c1', score: 0.46 },
        { fileFingerprint: 'fp-flat-2chunk:c1', score: 0.46 },
        { fileFingerprint: 'fp-flat-2chunk:c2', score: 0.455 },
        { fileFingerprint: 'fp-peak-2chunk:c1', score: 0.52 },
        { fileFingerprint: 'fp-peak-2chunk:c2', score: 0.46 }
      ]
    })

    const arbiter = new HybridSearchArbiter(db, {
      networkSignals: true,
      enablePinyinReconcileTimer: false
    })

    const pool = await arbiter.searchHybrid({
      keyword: 'zzzqqqxxx',
      whereClauses: ['wf.workspace_id = ?'],
      queryParams: [1],
      queryEmbedding: [0.1, 0.2, 0.3],
      similarityThreshold: 0.55,
      exactMinScore: true,
      videoMinScore: 0.45
    })

    const byFp = new Map(pool.candidates.map(c => [c.fileFingerprint, c]))

    // 1 切片短视频：0.46 < 0.52 绝对置信度，且无整文件高分，被拦截
    expect(byFp.get('fp-flat-1chunk')?.matchedChunks?.length ?? 0).toBe(0)
    expect(byFp.has('fp-flat-1chunk')).toBe(false)

    // 2 切片短视频：无波峰显著性落差 (0.005 < 0.015)，被拦截
    expect(byFp.get('fp-flat-2chunk')?.matchedChunks?.length ?? 0).toBe(0)
    expect(byFp.has('fp-flat-2chunk')).toBe(false)

    // 2 切片真实高光：显著落差 (0.06 >= 0.015)，保留高光切片
    expect(byFp.get('fp-peak-2chunk')?.matchedChunks?.length).toBeGreaterThan(0)
    expect(byFp.get('fp-peak-2chunk')?.matchedChunks?.[0].similarity).toBe(0.52)
  })
})
