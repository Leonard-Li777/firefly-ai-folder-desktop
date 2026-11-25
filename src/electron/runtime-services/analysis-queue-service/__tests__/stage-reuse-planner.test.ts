import { describe, expect, it, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/mock-user-data'),
    getAppPath: vi.fn(() => process.cwd()),
    getVersion: vi.fn(() => '1.0.0'),
    isPackaged: false
  }
}))

vi.mock('electron-conf', () => ({
  Conf: class MockConf {
    private _store: Record<string, any> = {}
    get(key: string, def?: any) {
      return this._store[key] ?? def
    }
    set(key: string, val: any) {
      this._store[key] = val
    }
  }
}))

const mockGetVectors = vi.fn()

vi.mock('../../../services/omni-client', () => ({
  omniClient: {
    getVectors: (...args: any[]) => mockGetVectors(...args)
  }
}))

vi.mock('../../../config/config-orchestrator', () => ({
  ConfigOrchestrator: {
    getInstance: () => ({
      getValue: (key: string) => {
        if (key === 'AI_EMBEDDING_PROFILE') return 'gemma_unified'
        if (key === 'EMBEDDING_MRL_DIMENSION') return 512
        return undefined
      }
    })
  }
}))

import {
  StageReusePlanner,
  bumpRetagEpoch,
  bumpRetagEpochIfNoActiveTask,
  validateRetagEpochStrict
} from '../file-processor/stage-reuse-planner'
import { compressText } from '../../../utils/text-compressor'
import { GENESIS_FILE_VIDEO_SEGMENTS_DDL } from '../../database/database'
import { computeVideoVisualParamsHash } from '@firefly/shared'

function createMemoryDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE files (
      file_fingerprint TEXT PRIMARY KEY,
      smart_name TEXT,
      size INTEGER NOT NULL DEFAULT 0,
      extension TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE workspace_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_fingerprint TEXT REFERENCES files(file_fingerprint) ON DELETE SET NULL,
      workspace_id INTEGER NOT NULL,
      directory_id INTEGER NOT NULL DEFAULT 1,
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      thumbnail_path TEXT,
      is_analyzed BOOLEAN NOT NULL DEFAULT 0,
      meta TEXT NOT NULL DEFAULT '{}',
      UNIQUE(workspace_id, path)
    );
    CREATE TABLE file_contents (
      file_fingerprint TEXT PRIMARY KEY REFERENCES files(file_fingerprint) ON DELETE CASCADE,
      content BLOB,
      ocr BLOB,
      lrc BLOB,
      asr BLOB,
      exif BLOB,
      analysis_stats TEXT,
      meta TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE analysis_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER,
      item_type TEXT NOT NULL DEFAULT 'file',
      task_type TEXT NOT NULL DEFAULT 'analysis',
      status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE TABLE file_video_chunks (
      file_fingerprint TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      sampling_interval_seconds REAL,
      start_sec REAL,
      end_sec REAL
    );
    CREATE TABLE file_tag_relations (
      file_fingerprint TEXT NOT NULL,
      tag_code TEXT NOT NULL,
      via_parent_code TEXT NOT NULL DEFAULT '',
      path_id INTEGER NOT NULL DEFAULT 1,
      tag_group TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (file_fingerprint, tag_code, via_parent_code)
    );
    ${GENESIS_FILE_VIDEO_SEGMENTS_DDL}
  `)
  return db
}

function makeEffectiveConfig(overrides: Partial<any> = {}): any {
  return {
    effectiveParams: {
      analysisMode: 'full',
      reuseBasicAnalysisData: true,
      enableImageOcr: true,
      ocrModelSize: 'tiny',
      enableOfficeCover: false,
      videoFrameQuotaMax: 30,
      videoSoftTokenBudget: 140,
      videoCutSensitivity: 'medium',
      videoAsrDurationSec: 60,
      audioAnalysisDurationSec: 60,
      ...overrides.effectiveParams
    },
    capabilities: {
      videoVisualAnalysisEnabled: true,
      nsfwEffectivelyEnabled: true,
      asrEffectivelyEnabled: false,
      ...overrides.capabilities
    }
  }
}

describe('StageReusePlanner & Monotonic Retag Epoch (Spec §2.2 / §3.2)', () => {
  let db: any

  beforeEach(() => {
    vi.clearAllMocks()
    db = createMemoryDb()
  })

  it('planBatch 单批合并 [fp, fp:tc0] 探活并正确产出 reuse_cpu_refresh_ai 与能力失效原因', async () => {
    db.prepare(
      `INSERT INTO files (file_fingerprint, extension) VALUES ('fp-doc', '.md'), ('fp-img', '.png'), ('fp-vid', '.mp4')`
    ).run()
    db.prepare(
      `INSERT INTO workspace_files (id, file_fingerprint, workspace_id, path, name, thumbnail_path, is_analyzed)
       VALUES
         (1, 'fp-doc', 10, 'D:/ws/a.md', 'a.md', NULL, 1),
         (2, 'fp-img', 10, 'D:/ws/b.png', 'b.png', 'thumb/b.webp', 1),
         (3, 'fp-vid', 10, 'D:/ws/c.mp4', 'c.mp4', 'thumb/c.webp', 1)`
    ).run()

    const docBlob = compressText('这是一份完整的长文档内容正文')
    db.prepare(
      `INSERT INTO file_contents (file_fingerprint, content, analysis_stats) VALUES (?, ?, ?)`
    ).run(
      'fp-doc',
      docBlob,
      JSON.stringify({
        analysis_stage: 2,
        appliedCapabilities: {
          ocrSize: 'tiny',
          asrApplied: false,
          officeCoverApplied: false,
          analysisStage: 2,
          embeddingProfile: 'gemma_unified'
        }
      })
    )
    db.prepare(
      `INSERT INTO file_contents (file_fingerprint, content, analysis_stats) VALUES (?, ?, ?)`
    ).run(
      'fp-img',
      docBlob,
      JSON.stringify({
        analysis_stage: 2,
        appliedCapabilities: {
          ocrSize: 'tiny',
          asrApplied: false,
          officeCoverApplied: false,
          analysisStage: 2,
          visualTagsApplied: true,
          nsfwApplied: true,
          embeddingProfile: 'gemma_unified'
        }
      })
    )
    db.prepare(
      `INSERT INTO file_contents (file_fingerprint, content, analysis_stats) VALUES (?, ?, ?)`
    ).run(
      'fp-vid',
      docBlob,
      JSON.stringify({
        analysis_stage: 2,
        appliedCapabilities: {
          ocrSize: 'tiny',
          asrApplied: false,
          officeCoverApplied: false,
          analysisStage: 2,
          visualTagsApplied: true,
          nsfwApplied: true,
          embeddingProfile: 'gemma_unified'
        }
      })
    )
    db.prepare(`INSERT INTO file_video_chunks VALUES ('fp-vid', 0, 1.0, 0, 4)`).run()
    const paramsHash = computeVideoVisualParamsHash(30, 140, 'medium')
    const nowIso = new Date().toISOString()
    db.prepare(
      `INSERT INTO file_video_segments (id, file_id, segment_index, start_pts_sec, end_pts_sec, frame_count, visual_embedded_count, status, params_hash, error_message, created_at, updated_at)
       VALUES ('fp-vid_seg_0', 'fp-vid', 0, 0, 300, 10, 10, 'completed', ?, 'analysis_degraded: timeout', ?, ?)`
    ).run(paramsHash, nowIso, nowIso)

    mockGetVectors.mockResolvedValue({
      vectors: [
        { fileFingerprint: 'fp-doc:tc0', vector: [0.1], encoderId: 4 },
        { fileFingerprint: 'fp-img', vector: [0.1], encoderId: 4 },
        { fileFingerprint: 'fp-vid:c0', vector: [0.1], encoderId: 4 }
      ],
      count: 3
    })

    const items: any[] = [
      { id: 101, workspaceId: 10, path: 'D:/ws/a.md', name: 'a.md', forceReanalyze: true },
      { id: 102, workspaceId: 10, path: 'D:/ws/b.png', name: 'b.png', forceReanalyze: true },
      { id: 103, workspaceId: 10, path: 'D:/ws/c.mp4', name: 'c.mp4' }
    ]

    // fp-img 请求 small OCR（高于已记录 tiny），触发能力失效
    const decisions = await StageReusePlanner.planBatch(
      db,
      10,
      items,
      makeEffectiveConfig({ effectiveParams: { ocrModelSize: 'small' } })
    )

    expect(mockGetVectors).toHaveBeenCalledTimes(1)
    const sentKeys = mockGetVectors.mock.calls[0][0] as string[]
    expect(sentKeys).toContain('fp-doc:tc0')
    expect(sentKeys).toContain('fp-doc')
    expect(sentKeys).toContain('fp-img')
    expect(sentKeys).toContain('fp-vid:c0')

    const dDoc = decisions.get(101)!
    expect(dDoc.action).toBe('reuse_cpu_refresh_ai')
    expect(dDoc.skipCpu).toBe(true)
    expect(dDoc.clearableTagGroups).toEqual(['ai'])
    expect(dDoc.preservedTagGroups).toEqual(['fact', 'fused', 'visual', 'user'])

    const dImg = decisions.get(102)!
    expect(dImg.action).toBe('fresh_cpu_and_ai')
    expect(dImg.missingReasons).toContain('ocr_model_upgraded')

    // seg_0 含 error_message 'analysis_degraded'，即使 completed 也必须判 incomplete_video_segments
    const dVid = decisions.get(103)!
    expect(dVid.action).toBe('fresh_cpu_and_ai')
    expect(dVid.missingReasons).toContain('incomplete_video_segments')
  })

  it('纯 UPDATE ... RETURNING 单调高水位防 ABA、坏 JSON/非对象根恢复与 0 行语义', () => {
    db.prepare(`INSERT INTO files (file_fingerprint, extension) VALUES ('fp-aba', '.txt')`).run()
    db.prepare(
      `INSERT INTO workspace_files (id, file_fingerprint, workspace_id, path, name) VALUES (1, 'fp-aba', 1, 'D:/a.txt', 'a.txt')`
    ).run()

    // 1. file_contents 未建行：返回 0 且严禁建出残行
    expect(bumpRetagEpoch(db, 'fp-aba')).toBe(0)
    expect(validateRetagEpochStrict(db, 'fp-aba', 0)).toBe(false)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM file_contents`).get().n).toBe(0)

    // 2. 正常对象 JSON：保留 appliedCapabilities 并单调递增
    db.prepare(`INSERT INTO file_contents (file_fingerprint, analysis_stats) VALUES (?, ?)`).run(
      'fp-aba',
      JSON.stringify({ retag_epoch: 1, appliedCapabilities: { ocrSize: 'tiny', asrApplied: true } })
    )
    const ep1 = bumpRetagEpoch(db, 'fp-aba')
    expect(ep1).toBeGreaterThan(1)
    const rowAfterEp1 = JSON.parse(
      db.prepare(`SELECT analysis_stats FROM file_contents WHERE file_fingerprint = 'fp-aba'`).get()
        .analysis_stats
    )
    expect(rowAfterEp1.appliedCapabilities).toEqual({ ocrSize: 'tiny', asrApplied: true })
    expect(validateRetagEpochStrict(db, 'fp-aba', ep1)).toBe(true)

    // 3. 损坏/非对象根 ('[]') 恢复至 processEpochFloor：恒大于历史 expectedEpoch (ep1)
    db.prepare(
      `UPDATE file_contents SET analysis_stats = '[]' WHERE file_fingerprint = 'fp-aba'`
    ).run()
    const ep2 = bumpRetagEpoch(db, 'fp-aba')
    expect(ep2).toBeGreaterThan(ep1)
    expect(validateRetagEpochStrict(db, 'fp-aba', ep1)).toBe(false)
    expect(validateRetagEpochStrict(db, 'fp-aba', ep2)).toBe(true)

    // 4. 存在另一活跃队列任务时不触发全局 bump（不误伤并发工作区 B）
    db.prepare(
      `INSERT INTO analysis_queue (id, item_id, item_type, status) VALUES (99, 1, 'file', 'analyzing')`
    ).run()
    expect(bumpRetagEpochIfNoActiveTask(db, 'fp-aba')).toBe(0)
    expect(validateRetagEpochStrict(db, 'fp-aba', ep2)).toBe(true)

    // 无活跃队列任务时触发 bump，作废旧 epoch
    db.prepare(`UPDATE analysis_queue SET status = 'completed' WHERE id = 99`).run()
    const ep3 = bumpRetagEpochIfNoActiveTask(db, 'fp-aba')
    expect(ep3).toBeGreaterThan(ep2)
    expect(validateRetagEpochStrict(db, 'fp-aba', ep2)).toBe(false)

    // 5. 全仓删光 workspace_files 引用后校验失败
    db.prepare(`DELETE FROM workspace_files WHERE file_fingerprint = 'fp-aba'`).run()
    expect(validateRetagEpochStrict(db, 'fp-aba', ep3)).toBe(false)
  })
})
