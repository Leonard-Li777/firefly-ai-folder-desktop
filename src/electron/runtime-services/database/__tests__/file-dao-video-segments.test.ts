import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'

vi.mock('electron', () => {
  const electronMock = {
    app: {
      getPath: vi.fn(() => 'C:\\test'),
      getName: vi.fn(() => 'firefly'),
      isPackaged: false
    },
    ipcMain: { handle: vi.fn() },
    BrowserWindow: { getAllWindows: vi.fn(() => []) },
    shell: { showItemInFolder: vi.fn() }
  }
  return {
    ...electronMock,
    default: electronMock
  }
})

vi.mock('electron-conf', () => ({
  Conf: class {
    get() {
      return {}
    }
    set() {}
  }
}))

import { FileDao } from '../dao/file-dao'

describe('FileDao Video Segments 读时派生与原子状态机测试 (FIN-01 / FIN-02 / FIN-05 / FIN-06)', () => {
  let db: Database.Database
  let fileDao: FileDao

  beforeEach(() => {
    db = new Database(':memory:')
    // 创建基础关联表与视频切片表
    db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        file_fingerprint TEXT PRIMARY KEY,
        name TEXT,
        path TEXT,
        size INTEGER,
        extension TEXT
      );

      CREATE TABLE IF NOT EXISTS file_video_segments (
        id TEXT PRIMARY KEY,
        file_id TEXT NOT NULL,
        segment_index INTEGER NOT NULL,
        start_pts_sec REAL NOT NULL,
        end_pts_sec REAL NOT NULL,
        frame_count INTEGER NOT NULL DEFAULT 0,
        visual_embedded_count INTEGER NOT NULL DEFAULT 0,
        asr_transcript_chars INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        params_hash TEXT NOT NULL,
        error_message TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(file_id, segment_index),
        FOREIGN KEY (file_id) REFERENCES files(file_fingerprint) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_fvs_file_status ON file_video_segments(file_id, status);
      CREATE INDEX IF NOT EXISTS idx_fvs_status_start ON file_video_segments(status, start_pts_sec);
    `)

    // 插入测试文件
    db.prepare(
      'INSERT INTO files (file_fingerprint, name, path, size, extension) VALUES (?, ?, ?, ?, ?)'
    ).run('file_video_1', 'movie.mp4', 'D:/movie.mp4', 1024000, 'mp4')

    fileDao = new FileDao(db)
  })

  afterEach(() => {
    db.close()
  })

  it('1. 单条原子 CAS 认领成功流转为 processing 并递增 attempt_count', () => {
    fileDao.upsertVideoSegment({
      id: 'file_video_1_seg_0',
      fileId: 'file_video_1',
      segmentIndex: 0,
      startPtsSec: 0,
      endPtsSec: 300,
      paramsHash: 'hash_v1',
      status: 'pending'
    })

    const claimed = fileDao.markVideoSegmentProcessing('file_video_1', 0)
    expect(claimed).toBe(true)

    const segs = fileDao.getVideoSegments('file_video_1')
    expect(segs.length).toBe(1)
    expect(segs[0].status).toBe('processing')
    expect(segs[0].attempt_count).toBe(1)

    // 重复认领同一 processing 切片必须被 CAS 拦截拒绝
    const doubleClaim = fileDao.markVideoSegmentProcessing('file_video_1', 0)
    expect(doubleClaim).toBe(false)
  })

  it('2. 失败回写与毒药熔断闭环 (attempt_count >= 3 自动熔断为 failed)', () => {
    fileDao.upsertVideoSegment({
      id: 'file_video_1_seg_1',
      fileId: 'file_video_1',
      segmentIndex: 1,
      startPtsSec: 300,
      endPtsSec: 600,
      paramsHash: 'hash_v1',
      status: 'pending'
    })

    // 第 1 次认领与失败回写 -> 回退为 pending
    expect(fileDao.markVideoSegmentProcessing('file_video_1', 1)).toBe(true)
    fileDao.markVideoSegmentFailedOrPending('file_video_1', 1, 'decode_err_1')
    let seg = fileDao.getVideoSegments('file_video_1')[0]
    expect(seg.status).toBe('pending')
    expect(seg.attempt_count).toBe(1)

    // 第 2 次认领与失败回写 -> 回退为 pending
    expect(fileDao.markVideoSegmentProcessing('file_video_1', 1)).toBe(true)
    fileDao.markVideoSegmentFailedOrPending('file_video_1', 1, 'decode_err_2')
    seg = fileDao.getVideoSegments('file_video_1')[0]
    expect(seg.status).toBe('pending')
    expect(seg.attempt_count).toBe(2)

    // 第 3 次认领与失败回写 -> 触发毒药熔断 failed
    expect(fileDao.markVideoSegmentProcessing('file_video_1', 1)).toBe(true)
    fileDao.markVideoSegmentFailedOrPending('file_video_1', 1, 'decode_err_3')
    seg = fileDao.getVideoSegments('file_video_1')[0]
    expect(seg.status).toBe('failed')
    expect(seg.attempt_count).toBe(3)
    expect(seg.error_message).toBe('decode_err_3')

    // 熔断后无法再被认领
    expect(fileDao.markVideoSegmentProcessing('file_video_1', 1)).toBe(false)
  })

  it('3. 正常优雅回滚不扣减毒药重试配额 (FIN-09)', () => {
    fileDao.upsertVideoSegment({
      id: 'file_video_1_seg_2',
      fileId: 'file_video_1',
      segmentIndex: 2,
      startPtsSec: 600,
      endPtsSec: 900,
      paramsHash: 'hash_v1',
      status: 'pending'
    })

    expect(fileDao.markVideoSegmentProcessing('file_video_1', 2)).toBe(true)
    let seg = fileDao.getVideoSegments('file_video_1')[0]
    expect(seg.status).toBe('processing')
    expect(seg.attempt_count).toBe(1)

    // 优雅回滚
    fileDao.rollbackVideoSegmentProcessing('file_video_1', 2)
    seg = fileDao.getVideoSegments('file_video_1')[0]
    expect(seg.status).toBe('pending')
    expect(seg.attempt_count).toBe(0)
  })

  it('4. getVideoCoverageStatsBatch 批量计算视频切片覆盖度 (FIN-05 / FIN-06)', () => {
    // 为 file_video_1 插入 3 个切片：0 completed, 1 completed, 2 pending
    fileDao.upsertVideoSegment({
      id: 'file_video_1_seg_0',
      fileId: 'file_video_1',
      segmentIndex: 0,
      startPtsSec: 0,
      endPtsSec: 300,
      paramsHash: 'hash_v1',
      status: 'pending'
    })
    fileDao.markVideoSegmentCompleted('file_video_1', 0, {
      frameCount: 100,
      visualEmbeddedCount: 100,
      asrTranscriptChars: 50
    })

    fileDao.upsertVideoSegment({
      id: 'file_video_1_seg_1',
      fileId: 'file_video_1',
      segmentIndex: 1,
      startPtsSec: 300,
      endPtsSec: 600,
      paramsHash: 'hash_v1',
      status: 'pending'
    })
    fileDao.markVideoSegmentCompleted('file_video_1', 1, {
      frameCount: 100,
      visualEmbeddedCount: 100,
      asrTranscriptChars: 0
    })

    fileDao.upsertVideoSegment({
      id: 'file_video_1_seg_2',
      fileId: 'file_video_1',
      segmentIndex: 2,
      startPtsSec: 600,
      endPtsSec: 720,
      paramsHash: 'hash_v1',
      status: 'pending'
    })

    const statsMap = fileDao.getVideoCoverageStatsBatch(['file_video_1', 'non_existing'])
    const stats1 = statsMap.get('file_video_1')

    expect(stats1).toBeDefined()
    expect(stats1?.total_duration_sec).toBe(720)
    expect(stats1?.completed_duration_sec).toBe(600)
    expect(stats1?.has_failed_segments).toBe(false)
    expect(stats1?.is_fully_covered).toBe(false)

    // 补全第 2 片 completed
    fileDao.markVideoSegmentCompleted('file_video_1', 2, {
      frameCount: 40,
      visualEmbeddedCount: 40,
      asrTranscriptChars: 0
    })
    const fullyCoveredStats = fileDao
      .getVideoCoverageStatsBatch(['file_video_1'])
      .get('file_video_1')
    expect(fullyCoveredStats?.completed_duration_sec).toBe(720)
    expect(fullyCoveredStats?.is_fully_covered).toBe(true)
  })
})
