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

import { FileDao } from '../../database/dao/file-dao'
import { GENESIS_FILE_VIDEO_SEGMENTS_DDL } from '../../database/database'

describe('FileDao Video Backfill Methods (Spec §3.5)', () => {
  let db: any
  let fileDao: FileDao

  beforeEach(() => {
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
        is_analyzed BOOLEAN NOT NULL DEFAULT 0,
        FOREIGN KEY (file_fingerprint) REFERENCES files(file_fingerprint) ON DELETE CASCADE
      );

      ${GENESIS_FILE_VIDEO_SEGMENTS_DDL}
    `)

    db.prepare('INSERT INTO files (file_fingerprint, smart_name, size, extension) VALUES (?, ?, ?, ?)').run(
      'fp_vid_1',
      'long_video.mp4',
      10000000,
      '.mp4'
    )
    db.prepare(
      'INSERT INTO workspace_files (file_fingerprint, workspace_id, directory_id, path, name) VALUES (?, ?, ?, ?, ?)'
    ).run('fp_vid_1', 1, 10, 'D:/videos/long_video.mp4', 'long_video.mp4')

    fileDao = new FileDao(db)
  })

  it('1. getWorkspaceIdsWithPendingVideoSegments 仅识别存在 k>=1 pending 且 seg_0 completed 的工作区', () => {
    // 尚未插入 seg_0 -> 应为空
    expect(fileDao.getWorkspaceIdsWithPendingVideoSegments()).toEqual([])

    // 插入 seg_0 为 pending, seg_1 为 pending -> 仍为空 (seg_0 尚未 completed)
    fileDao.upsertVideoSegment({
      id: 'fp_vid_1_seg_0',
      fileId: 'fp_vid_1',
      segmentIndex: 0,
      startPtsSec: 0,
      endPtsSec: 300,
      paramsHash: 'v1_hash',
      status: 'pending'
    })
    fileDao.upsertVideoSegment({
      id: 'fp_vid_1_seg_1',
      fileId: 'fp_vid_1',
      segmentIndex: 1,
      startPtsSec: 300,
      endPtsSec: 600,
      paramsHash: 'v1_hash',
      status: 'pending'
    })
    expect(fileDao.getWorkspaceIdsWithPendingVideoSegments()).toEqual([])

    // 完成 seg_0 -> 成功识别到 workspaceId: 1
    fileDao.markVideoSegmentCompleted('fp_vid_1', 0, {
      frameCount: 60,
      visualEmbeddedCount: 60,
      asrTranscriptChars: 100
    })
    expect(fileDao.getWorkspaceIdsWithPendingVideoSegments()).toEqual([1])
  })

  it('2. getPendingVideoSegmentsForWorkspace 严格限定 maxStartPtsSec 且按顺序返回', () => {
    fileDao.upsertVideoSegment({
      id: 'fp_vid_1_seg_0',
      fileId: 'fp_vid_1',
      segmentIndex: 0,
      startPtsSec: 0,
      endPtsSec: 300,
      paramsHash: 'v1_hash',
      status: 'completed'
    })
    fileDao.upsertVideoSegment({
      id: 'fp_vid_1_seg_1',
      fileId: 'fp_vid_1',
      segmentIndex: 1,
      startPtsSec: 300,
      endPtsSec: 600,
      paramsHash: 'v1_hash',
      status: 'pending'
    })
    fileDao.upsertVideoSegment({
      id: 'fp_vid_1_seg_2',
      fileId: 'fp_vid_1',
      segmentIndex: 2,
      startPtsSec: 600,
      endPtsSec: 900,
      paramsHash: 'v1_hash',
      status: 'pending'
    })

    // 限制在 600 秒以内（即只包含 start_pts_sec < 600 的切片）
    const segs = fileDao.getPendingVideoSegmentsForWorkspace(1, 600)
    expect(segs.length).toBe(1)
    expect(segs[0].segmentIndex).toBe(1)
    expect(segs[0].fileFingerprint).toBe('fp_vid_1')

    // 扩大到 1200 秒
    const segs2 = fileDao.getPendingVideoSegmentsForWorkspace(1, 1200)
    expect(segs2.length).toBe(2)
    expect(segs2.map(s => s.segmentIndex)).toEqual([1, 2])
  })

  it('3. getWorkspacePendingBackfillVideos 正确聚合待补列表，且仅当有 pending/failed 时返回', () => {
    fileDao.upsertVideoSegment({
      id: 'fp_vid_1_seg_0',
      fileId: 'fp_vid_1',
      segmentIndex: 0,
      startPtsSec: 0,
      endPtsSec: 300,
      paramsHash: 'v1_hash',
      status: 'completed'
    })
    fileDao.upsertVideoSegment({
      id: 'fp_vid_1_seg_1',
      fileId: 'fp_vid_1',
      segmentIndex: 1,
      startPtsSec: 300,
      endPtsSec: 600,
      paramsHash: 'v1_hash',
      status: 'pending'
    })

    const list = fileDao.getWorkspacePendingBackfillVideos(1, 1800)
    expect(list.length).toBe(1)
    expect(list[0].fileFingerprint).toBe('fp_vid_1')
    expect(list[0].completedSlices).toBe(1)
    expect(list[0].totalSlices).toBe(2)
    expect(list[0].failedSlices).toBe(0)

    // 将 seg_1 完成后，actionableSlices 归零，不应再出现在待补列表中
    fileDao.markVideoSegmentCompleted('fp_vid_1', 1, {
      frameCount: 60,
      visualEmbeddedCount: 60,
      asrTranscriptChars: 100
    })
    const list2 = fileDao.getWorkspacePendingBackfillVideos(1, 1800)
    expect(list2.length).toBe(0)
  })

  it('4. resetFailedVideoSegmentsForWorkspace 仅复位上限内 failed 的 k>=1 切片', () => {
    fileDao.upsertVideoSegment({
      id: 'fp_vid_1_seg_0',
      fileId: 'fp_vid_1',
      segmentIndex: 0,
      startPtsSec: 0,
      endPtsSec: 300,
      paramsHash: 'v1_hash',
      status: 'completed'
    })
    fileDao.upsertVideoSegment({
      id: 'fp_vid_1_seg_1',
      fileId: 'fp_vid_1',
      segmentIndex: 1,
      startPtsSec: 300,
      endPtsSec: 600,
      paramsHash: 'v1_hash',
      status: 'failed'
    })
    fileDao.upsertVideoSegment({
      id: 'fp_vid_1_seg_2',
      fileId: 'fp_vid_1',
      segmentIndex: 2,
      startPtsSec: 600,
      endPtsSec: 900,
      paramsHash: 'v1_hash',
      status: 'failed'
    })

    // 仅复位 600 秒内的切片
    const resetCount = fileDao.resetFailedVideoSegmentsForWorkspace(1, 600)
    expect(resetCount).toBe(1)

    const segs = fileDao.getVideoSegments('fp_vid_1')
    expect(segs.find(s => s.segment_index === 1)?.status).toBe('pending')
    expect(segs.find(s => s.segment_index === 2)?.status).toBe('failed')
  })

  it('5. resetUpgradedVideoSegmentsForWorkspace 根据 isReusableFn 重置升档失效的切片', () => {
    fileDao.upsertVideoSegment({
      id: 'fp_vid_1_seg_0',
      fileId: 'fp_vid_1',
      segmentIndex: 0,
      startPtsSec: 0,
      endPtsSec: 300,
      paramsHash: 'v1_hash',
      status: 'completed'
    })
    fileDao.upsertVideoSegment({
      id: 'fp_vid_1_seg_1',
      fileId: 'fp_vid_1',
      segmentIndex: 1,
      startPtsSec: 300,
      endPtsSec: 600,
      paramsHash: 'v1_hash',
      status: 'completed'
    })

    const resetCount = fileDao.resetUpgradedVideoSegmentsForWorkspace(
      1,
      1800,
      'v2_hash',
      (seg, expected) => seg.params_hash === expected
    )
    expect(resetCount).toBe(1)

    const segs = fileDao.getVideoSegments('fp_vid_1')
    expect(segs.find(s => s.segment_index === 1)?.status).toBe('pending')
    // seg_0 属于主队列首次切片，不在 resetUpgradedVideoSegmentsForWorkspace 范围内
    expect(segs.find(s => s.segment_index === 0)?.status).toBe('completed')
  })
})
