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

const mockAddItems = vi.fn().mockResolvedValue(undefined)
const mockStartVideoBackfill = vi.fn()

vi.mock('../../analysis-queue-service', () => ({
  analysisQueueService: {
    addItems: (...args: any[]) => mockAddItems(...args),
    startVideoBackfill: (...args: any[]) => mockStartVideoBackfill(...args),
    notifyWorkspaceConfigChangedForBackfill: vi.fn()
  }
}))

// 精确扫描依赖工作区有效配置与会员权益缓存，单测中以固定基线替代，聚焦待补筛选口径
vi.mock('../workspace-analysis-context', () => ({
  resolveWorkspaceEffectiveConfig: vi.fn(async () => ({
    capabilities: { videoMaxAnalyzeSec: 300, videoVisualAnalysisEnabled: true },
    effectiveParams: { videoAnalyzeDurationSec: 300 },
    fields: { videoAnalyzeDurationSec: { desiredValue: 300 } }
  }))
}))

vi.mock('../../user-tier/user-tier-service', () => ({
  userTierService: { getCachedData: () => ({ computed_limits: null }) }
}))

import {
  scanRecoverableFilesLight,
  listRecoverableFilesPrecise,
  enqueueRecovery,
  clearRecoverableFiles
} from '../workspace-recovery-queue-service'
import { databaseService } from '../../database/database-service'
import { GENESIS_FILE_VIDEO_SEGMENTS_DDL } from '../../database/database'

describe('WorkspaceRecoveryQueueService Bug Diagnosis', () => {
  let db: any

  beforeEach(() => {
    vi.clearAllMocks()
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')

    db.exec(`
      CREATE TABLE files (
        file_fingerprint TEXT PRIMARY KEY,
        smart_name TEXT,
        size INTEGER NOT NULL DEFAULT 0,
        extension TEXT NOT NULL
      );

      CREATE TABLE workspace_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_fingerprint TEXT,
        workspace_id INTEGER NOT NULL,
        directory_id INTEGER NOT NULL,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        file_size INTEGER NOT NULL DEFAULT 0,
        thumbnail_path TEXT,
        meta TEXT NOT NULL DEFAULT '{}',
        is_analyzed BOOLEAN NOT NULL DEFAULT 1,
        FOREIGN KEY (file_fingerprint) REFERENCES files(file_fingerprint) ON DELETE CASCADE
      );

      CREATE TABLE file_contents (
        file_fingerprint TEXT PRIMARY KEY,
        content BLOB,
        ocr BLOB,
        lrc BLOB,
        asr BLOB,
        analysis_stats TEXT,
        FOREIGN KEY (file_fingerprint) REFERENCES files(file_fingerprint) ON DELETE CASCADE
      );

      ${GENESIS_FILE_VIDEO_SEGMENTS_DDL}
    `)
    ;(databaseService as any)._db = db
  })

  it('Bug-01: scanRecoverableFilesLight 应该能识别视频文件的 ASR 缺失缺口，而不是直接忽略', () => {
    // 插入一个视频文件，无 ASR / content
    db.prepare(
      'INSERT INTO files (file_fingerprint, smart_name, size, extension) VALUES (?, ?, ?, ?)'
    ).run('fp_video_no_asr', 'movie.mp4', 50000000, '.mp4')
    db.prepare(
      'INSERT INTO workspace_files (id, file_fingerprint, workspace_id, directory_id, path, name, file_size) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(501, 'fp_video_no_asr', 1, 10, 'G:/person/H/AV/movie.mp4', 'movie.mp4', 50000000)

    db.prepare('INSERT INTO file_contents (file_fingerprint) VALUES (?)').run('fp_video_no_asr')

    const items = scanRecoverableFilesLight(db, 1)

    // 核心断言：scanRecoverableFilesLight 必须能够检测出缺少 ASR，从而与 checkBasicDataCompleteness 保持一致
    expect(items).toHaveLength(1)
    expect(items[0].workspaceFileId).toBe(501)
    expect(items[0].missingReasons).toContain('missing_audio_transcript')
  })

  it('Bug-02: enqueueRecovery 指定单个视频文件 ID 补全时，不应返回 queued: 0', async () => {
    db.prepare(
      'INSERT INTO files (file_fingerprint, smart_name, size, extension) VALUES (?, ?, ?, ?)'
    ).run('fp_video_no_asr', 'movie.mp4', 50000000, '.mp4')
    db.prepare(
      'INSERT INTO workspace_files (id, file_fingerprint, workspace_id, directory_id, path, name, file_size) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(501, 'fp_video_no_asr', 1, 10, 'G:/person/H/AV/movie.mp4', 'movie.mp4', 50000000)
    db.prepare('INSERT INTO file_contents (file_fingerprint) VALUES (?)').run('fp_video_no_asr')

    const res = await enqueueRecovery(1, [501])

    // 用户现象：toast 提示「已将 0 个文件加入分析队列补全内容」
    // 期望：应该成功将这 1 个文件加入队列
    expect(res.success).toBe(true)
    expect(res.queued).toBe(1)
    expect(mockAddItems).toHaveBeenCalledTimes(1)
  })

  it('Bug-03: clearRecoverableFiles 未传 ids 全量清除时，不能遗漏视频文件的缺口', () => {
    db.prepare(
      'INSERT INTO files (file_fingerprint, smart_name, size, extension) VALUES (?, ?, ?, ?)'
    ).run('fp_video_no_asr', 'movie.mp4', 50000000, '.mp4')
    db.prepare(
      'INSERT INTO workspace_files (id, file_fingerprint, workspace_id, directory_id, path, name, file_size) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(501, 'fp_video_no_asr', 1, 10, 'G:/person/H/AV/movie.mp4', 'movie.mp4', 50000000)
    db.prepare('INSERT INTO file_contents (file_fingerprint) VALUES (?)').run('fp_video_no_asr')

    // 用户在页面上清空待补列表
    const res = clearRecoverableFiles(1)
    expect(res.success).toBe(true)
    expect(res.cleared).toBe(1)

    // 清除后，该文件的 meta.recovery_cleared 必须为 true
    const row = db.prepare('SELECT meta FROM workspace_files WHERE id = ?').get(501) as {
      meta: string
    }
    const meta = JSON.parse(row.meta)
    expect(meta.recovery_cleared).toBe(true)
  })

  it('Bug-04: 无指纹（尚未首次分析）的新入库文件不得进入待补清单', async () => {
    // 模拟「移除工作目录后重新添加」：文件监听全量同步插入 24 行，
    // file_fingerprint 为空、is_analyzed = 0，此时任何内容/OCR/转录都尚未产生
    db.prepare(
      'INSERT INTO workspace_files (id, file_fingerprint, workspace_id, directory_id, path, name, file_size, is_analyzed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(601, null, 2, 20, 'G:/person/H/AV/01凯蒂夫人1.avi', '01凯蒂夫人1.avi', 700000000, 0)

    // 横幅轻量计数不得把它算作待补
    const lightItems = scanRecoverableFilesLight(db, 2)
    expect(lightItems).toHaveLength(0)

    // 设置页精确清单（此前 no_fingerprint 会被当成「内容补全」缺口）同样不得列出
    const precise = await listRecoverableFilesPrecise(2)
    expect(precise.success).toBe(true)
    expect(precise.items).toHaveLength(0)

    // 全量清除也不应误碰该行
    const clearRes = clearRecoverableFiles(2)
    expect(clearRes.success).toBe(true)
    expect(clearRes.cleared).toBe(0)
  })

  it('Bug-05: 已有指纹但基础数据不完整的文件仍必须保留在待补清单（防过滤过度）', () => {
    db.prepare(
      'INSERT INTO files (file_fingerprint, smart_name, size, extension) VALUES (?, ?, ?, ?)'
    ).run('fp_video_no_asr', 'movie.mp4', 50000000, '.mp4')
    db.prepare(
      'INSERT INTO workspace_files (id, file_fingerprint, workspace_id, directory_id, path, name, file_size, is_analyzed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(602, 'fp_video_no_asr', 2, 20, 'G:/person/H/AV/movie.mp4', 'movie.mp4', 50000000, 1)
    db.prepare('INSERT INTO file_contents (file_fingerprint) VALUES (?)').run('fp_video_no_asr')

    const lightItems = scanRecoverableFilesLight(db, 2)
    expect(lightItems.map(it => it.workspaceFileId)).toContain(602)
  })
})
