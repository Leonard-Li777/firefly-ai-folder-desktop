import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GENESIS_V1_SCHEMA } from '../../database/database'
import { QueueDao } from '../../database/dao/queue-dao'
import { VisualTaggerStateDao } from '../../database/dao/visual-tagger-state-dao'
import { OmniPerceptionHttpError } from '../../system/omni-service/types'
import { classifyVisualPerceptionError, isTransientInfraError } from '../file-processor/analysis-error-classifier'
import { executeSingleVideoSegment } from '../file-processor/video-segment-executor'
import { VideoSegmentBackfillWorker } from '../video-segment-backfill-worker'
import {
  isVisualMediaExtensionOrPath,
  VisualTaggerCoordinator
} from '../visual-tagger-coordinator'

function seedTestQueueAndSegments(db: Database.Database): void {
  db.exec(GENESIS_V1_SCHEMA)
  db.prepare(
    `INSERT INTO files (file_fingerprint, extension) VALUES ('fp_img_1', '.jpg'), ('fp_img_2', '.png'), ('fp_bad_1', '.jpg'), ('fp_vid_1', '.mp4')`
  ).run()
  db.prepare(
    `INSERT INTO analysis_queue (id, item_id, item_type, task_type, status, progress, priority, retry_count)
     VALUES (1, 101, 'file', 'analysis', 'analyzing', 10, 10, 0),
            (2, 102, 'file', 'analysis', 'analyzing', 10, 10, 0),
            (3, 103, 'file', 'analysis', 'analyzing', 10, 10, 0)`
  ).run()
  const now = Date.now()
  db.prepare(
    `INSERT INTO file_video_segments (id, file_id, segment_index, start_pts_sec, end_pts_sec, status, params_hash, created_at, updated_at)
     VALUES ('seg-0', 'fp_vid_1', 0, 0, 180, 'completed', 'p1', ?, ?),
            ('seg-1', 'fp_vid_1', 1, 180, 360, 'pending', 'p1', ?, ?)`
  ).run(now, now, now, now)
}

describe('Ticket 09: 409 状态机对账、N=3 视觉熔断、422 隔离与单事务代际重投', () => {
  let db: Database.Database
  let dao: VisualTaggerStateDao

  beforeEach(() => {
    db = new Database(':memory:')
    seedTestQueueAndSegments(db)
    dao = new VisualTaggerStateDao(db)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    db.close()
  })

  it('HTTP 全状态码确定性分流：422/409/500 ASSET_* 绝不判为瞬态，429/408/503 判为瞬态', () => {
    const err422 = new OmniPerceptionHttpError({
      status: 422,
      code: 'INPUT_REJECTED',
      message: 'bad image'
    })
    const err409 = new OmniPerceptionHttpError({
      status: 409,
      code: 'ENGINE_NOT_READY',
      reason: 'visual_vocab_stale',
      encoderId: 2,
      message: 'stale'
    })
    const err500 = new OmniPerceptionHttpError({
      status: 500,
      code: 'ASSET_MISSING',
      encoderId: 2,
      message: 'missing'
    })
    const err429 = new OmniPerceptionHttpError({
      status: 429,
      code: 'HTTP_429',
      message: 'too many requests'
    })
    const err413 = new OmniPerceptionHttpError({
      status: 413,
      code: 'HTTP_413',
      message: 'payload too large'
    })

    expect(isTransientInfraError(err422)).toBe(false)
    expect(isTransientInfraError(err409)).toBe(false)
    expect(isTransientInfraError(err500)).toBe(false)
    expect(isTransientInfraError(err429)).toBe(true)

    expect(classifyVisualPerceptionError(err422)?.kind).toBe('input_rejected_422')
    expect(classifyVisualPerceptionError(err409)?.kind).toBe('reconcile_409')
    expect(classifyVisualPerceptionError(err500)?.kind).toBe('asset_failure_500')
    expect(classifyVisualPerceptionError(err413)?.kind).toBe('unexpected_http')
  })

  it('409 对账状态机：先本地复验零联网自愈，app_update_needed 与发布契约缺陷直落终态', async () => {
    let now = 1_000_000
    const coordinator = new VisualTaggerCoordinator({ nowFn: () => now })

    // 1. 本地复验通过 ➔ 零联网直接 recovered
    let downloadCalled = false
    const okRes = await coordinator.handleEngineNotReady409({
      resourceId: 'chinese-clip',
      expectedFingerprint: 'fp-a',
      localVerifyAndHealFn: async () => ({ ok: true }),
      downloadAndReconcileFn: async () => {
        downloadCalled = true
        return { ok: true }
      }
    })
    expect(okRes.outcome).toBe('recovered')
    expect(downloadCalled).toBe(false)

    // 2. app_update_needed ➔ 直接 needs_app_update
    const appUpd = await coordinator.handleEngineNotReady409({
      resourceId: 'chinese-clip',
      expectedFingerprint: 'fp-a',
      reason: 'app_update_needed',
      localVerifyAndHealFn: async () => ({ ok: false }),
      downloadAndReconcileFn: async () => ({ ok: false })
    })
    expect(appUpd).toEqual({ outcome: 'terminal', failureCode: 'needs_app_update' })

    // 3. 磁盘与 catalog 一致但 Omni 仍拒 ➔ 发布契约缺陷直落终态
    const defectRes = await coordinator.handleEngineNotReady409({
      resourceId: 'chinese-clip',
      expectedFingerprint: 'fp-defect',
      localVerifyAndHealFn: async () => ({ ok: false, diskMatchesCatalog: true }),
      downloadAndReconcileFn: async () => ({ ok: true })
    })
    expect(defectRes).toEqual({ outcome: 'terminal', failureCode: 'needs_plugin_update' })

    // 4. 3 次短退避耗尽（1m / 10m / 60m）+ 手动清冷却
    const attempt1 = await coordinator.handleEngineNotReady409({
      resourceId: 'chinese-clip',
      expectedFingerprint: 'fp-dl',
      localVerifyAndHealFn: async () => ({ ok: false, diskMatchesCatalog: false }),
      downloadAndReconcileFn: async () => ({ ok: false, error: 'net fail' })
    })
    expect(attempt1.outcome).toBe('pending_reconcile')
    now += 61_000
    const attempt2 = await coordinator.handleEngineNotReady409({
      resourceId: 'chinese-clip',
      expectedFingerprint: 'fp-dl',
      localVerifyAndHealFn: async () => ({ ok: false }),
      downloadAndReconcileFn: async () => ({ ok: false, error: 'net fail' })
    })
    expect(attempt2.outcome).toBe('pending_reconcile')
    now += 601_000
    const attempt3 = await coordinator.handleEngineNotReady409({
      resourceId: 'chinese-clip',
      expectedFingerprint: 'fp-dl',
      localVerifyAndHealFn: async () => ({ ok: false }),
      downloadAndReconcileFn: async () => ({ ok: false, error: 'net fail' })
    })
    expect(attempt3).toEqual({ outcome: 'terminal', failureCode: 'needs_plugin_update' })
    coordinator.clearReconcileCooldown('chinese-clip')
    expect(coordinator.getReconcileState('chinese-clip', 'fp-dl')).toBeNull()
  })

  it('连续 3 次 ASSET_MISSING 单事务落库并触发 N=3 视觉熔断；422 不计熔断；generation 递增精确重投', () => {
    const coordinator = new VisualTaggerCoordinator()

    // 422 坏图不改 visual_tagger_state，也不计熔断
    const r422 = dao.recordQueueVisualFailureTx({
      queueId: 3,
      errorMessage: 'bad img',
      failureCode: 'INPUT_REJECTED',
      encoderId: 2,
      markStateNonOk: false
    })
    expect(r422.failureGeneration).toBe(0)
    expect(dao.getState(2)).toBeNull()
    expect(coordinator.isVisualBreakerTripped()).toBe(false)

    // 连续 3 次 ASSET_MISSING
    for (let i = 0; i < 3; i++) {
      const qid = i === 0 ? 1 : 2
      const { failureGeneration } = dao.recordQueueVisualFailureTx({
        queueId: qid,
        errorMessage: 'AI 标签不可用',
        failureCode: 'ASSET_MISSING',
        encoderId: 2,
        expectedFingerprint: 'sha-zh-1',
        markStateNonOk: true
      })
      coordinator.recordAssetFailureForBreaker(2, failureGeneration)
    }
    expect(dao.getState(2)?.last_status).toBe('non_ok')
    expect(coordinator.isVisualBreakerTripped()).toBe(true)

    // 过滤规则：图片/视频受阻，纯文档与音频放行
    expect(isVisualMediaExtensionOrPath('D:/a/photo.jpg', '.jpg')).toBe(true)
    expect(isVisualMediaExtensionOrPath('D:/a/movie.mp4', '.mp4')).toBe(true)
    expect(isVisualMediaExtensionOrPath('D:/a/spec.pdf', '.pdf')).toBe(false)
    expect(isVisualMediaExtensionOrPath('D:/a/song.mp3', '.mp3')).toBe(false)

    // 同版重装恢复：generation 递增 0 -> 1；encoder_id=3 与 422 绝不误重投
    const obs = dao.observeTaggerHealthyOrFingerprintChangedTx(2, 'sha-zh-1')
    expect(obs.bumped).toBe(true)
    expect(obs.currentGeneration).toBe(1)

    const mismatchEncoderRequeued = dao.requeueEligibleFailedItemsTx({
      activeEncoderId: 3,
      currentGeneration: 1
    })
    expect(mismatchEncoderRequeued.requeuedQueueCount).toBe(0)

    const matchedRequeued = dao.requeueEligibleFailedItemsTx({
      activeEncoderId: 2,
      currentGeneration: 1
    })
    expect(matchedRequeued.requeuedQueueCount).toBe(2)

    const row3 = db
      .prepare('SELECT status, failure_code FROM analysis_queue WHERE id = 3')
      .get() as { status: string; failure_code: string }
    expect(row3.status).toBe('failed')
    expect(row3.failure_code).toBe('INPUT_REJECTED')
  })

  it('k>=1 宏观切片 422 仅独立标 failed 绝不计入熔断，VideoSegmentBackfillWorker 随视觉熔断暂停与恢复', async () => {
    const backfill = new VideoSegmentBackfillWorker({
      hasMainQueuePendingOrRunning: () => false,
      emitSnapshotUpdate: () => {},
      resolveWorkspaceContext: async () => null,
      getWorkspaceIdsWithPendingVideoSegments: () => [],
      getPendingVideoSegmentsForWorkspace: () => [],
      getWorkspacePendingBackfillVideos: () => [],
      getVideoSegments: () => []
    })

    await backfill.pauseByVisualBreaker()
    expect(backfill.getSnapshot().userPaused).toBe(true)
    expect(backfill.scheduleStart('should_block')).toBe(false)

    backfill.resumeFromVisualBreaker()
    expect(backfill.getSnapshot().userPaused).toBe(false)

    const segRes = await executeSingleVideoSegment({
      segment: {
        fileFingerprint: 'fp_vid_1',
        filePath: 'C:/不存在但先走mock/video.mp4',
        segmentIndex: 1,
        startPtsSec: 180,
        endPtsSec: 360
      },
      effectiveLimitSec: 600,
      paramsHash: 'p1',
      perceptionParams: {},
      deps: {
        db,
        existsSync: () => true,
        databaseService: {
          markVideoSegmentProcessing: () => true,
          markVideoSegmentCompleted: vi.fn(),
          markVideoSegmentFailedOrPending: vi.fn(),
          recordVideoSegmentVisualFailureTx: args => dao.recordVideoSegmentVisualFailureTx(args),
          rollbackVideoSegmentProcessing: vi.fn(),
          replaceVideoChunksInRange: vi.fn(),
          markVideoChunksVectorSaved: vi.fn(),
          saveFileVectors: vi.fn(),
          cleanupOrphanedVideoChunks: vi.fn()
        } as any,
        anydocService: {
          perceive: async () => {
            throw new OmniPerceptionHttpError({
              status: 422,
              code: 'INPUT_REJECTED',
              message: 'all frames corrupt in slice 1'
            })
          }
        },
        omniClient: { deleteVectors: vi.fn() }
      }
    })

    expect(segRes.outcome).toBe('failed')
    expect(segRes.reason).toBe('INPUT_REJECTED')
    const seg0 = db
      .prepare(`SELECT status FROM file_video_segments WHERE file_id = 'fp_vid_1' AND segment_index = 0`)
      .get() as { status: string }
    const seg1 = db
      .prepare(`SELECT status, failure_code FROM file_video_segments WHERE file_id = 'fp_vid_1' AND segment_index = 1`)
      .get() as { status: string; failure_code: string }
    expect(seg0.status).toBe('completed')
    expect(seg1.status).toBe('failed')
    expect(seg1.failure_code).toBe('INPUT_REJECTED')
  })

  it('QueueDao.incrementRetryCountSync 原子递增 retry_count，409 协调器未传 firstSeenAtMs 仍自动触发 90m 兜底', async () => {
    const queueDao = new QueueDao(db)
    expect(queueDao.incrementRetryCountSync(1)).toBe(1)
    expect(queueDao.incrementRetryCountSync(1)).toBe(2)

    let now = 10_000_000
    const coordinator = new VisualTaggerCoordinator({ nowFn: () => now })
    const r1 = await coordinator.handleEngineNotReady409({
      resourceId: 'chinese-clip',
      expectedFingerprint: 'fp-auto-90m',
      localVerifyAndHealFn: async () => ({ ok: false }),
      downloadAndReconcileFn: async () => ({ ok: false, error: 'network error' })
    })
    expect(r1.outcome).toBe('pending_reconcile')
    expect(coordinator.getNextVisualReconcileRetryAt()).toBe(now + 60_000)

    // 推进 91 分钟且不传 firstSeenAtMs，仍触发兜底终态
    now += 91 * 60_000
    const r2 = await coordinator.handleEngineNotReady409({
      resourceId: 'chinese-clip',
      expectedFingerprint: 'fp-auto-90m',
      localVerifyAndHealFn: async () => ({ ok: false }),
      downloadAndReconcileFn: async () => ({ ok: false })
    })
    expect(r2).toEqual({ outcome: 'terminal', failureCode: 'needs_plugin_update' })
  })

  it('R2 fixes: appVersion 升级递增 generation 并重投 needs_app_update；video-segment-executor 正确处理 409/429', async () => {
    // 1. M1: appVersion 变化触发 generation 递增并解封 needs_app_update
    const initObs = dao.observeTaggerHealthyOrFingerprintChangedTx(2, 'fp-v1', '1.0.0')
    expect(initObs.currentGeneration).toBe(1)
    expect(initObs.appVersionChanged).toBe(false)

    dao.recordQueueVisualFailureTx({
      queueId: 1,
      errorMessage: '请更新客户端版本',
      failureCode: 'needs_app_update',
      encoderId: 2,
      markStateNonOk: false
    })
    // 同版本启动不递增、不误重投
    const sameVer = dao.observeTaggerHealthyOrFingerprintChangedTx(2, 'fp-v1', '1.0.0')
    expect(sameVer.bumped).toBe(false)
    expect(sameVer.appVersionChanged).toBe(false)

    // 升级版本 1.0.0 -> 1.1.0：appVersionChanged=true，generation 1 -> 2 并允许重投 needs_app_update
    const upgraded = dao.observeTaggerHealthyOrFingerprintChangedTx(2, 'fp-v1', '1.1.0')
    expect(upgraded.bumped).toBe(true)
    expect(upgraded.appVersionChanged).toBe(true)
    expect(upgraded.currentGeneration).toBe(2)

    const requeued = dao.requeueEligibleFailedItemsTx({
      activeEncoderId: 2,
      currentGeneration: 2,
      includeNeedsAppUpdate: true
    })
    expect(requeued.requeuedQueueCount).toBe(1)

    // 2. H4: video-segment-executor 对 409 app_update_needed 落终态、对 429 走退避重投
    const { executeSingleVideoSegment } = await import('../file-processor/video-segment-executor')
    const { OmniPerceptionHttpError } = await import('../../system/omni-service/types')
    const terminalCalls: Array<Record<string, any>> = []
    const retryCalls: Array<string> = []
    const fakeDeps: any = {
      db: {},
      existsSync: () => true,
      databaseService: {
        markVideoSegmentProcessing: () => true,
        markVideoSegmentCompleted: () => {},
        markVideoSegmentFailedOrPending: (_fid: string, _seg: number, reason: string) => {
          retryCalls.push(reason)
        },
        recordVideoSegmentVisualFailureTx: (params: any) => {
          terminalCalls.push(params)
          return { failureGeneration: 2 }
        },
        rollbackVideoSegmentProcessing: () => {},
        replaceVideoChunksInRange: () => {},
        getFileByPath: () => null,
        upsertVideoTags: () => {}
      },
      anydocService: {
        perceive: async () => {
          throw new OmniPerceptionHttpError({
            status: 409,
            code: 'ENGINE_NOT_READY',
            reason: 'app_update_needed',
            encoderId: 2,
            message: 'needs app update'
          })
        }
      },
      omniClient: { deleteVectors: async () => {} }
    }
    const segBase = {
      fileFingerprint: 'fp-vid-1',
      filePath: 'C:/tmp/sample.mp4',
      segmentIndex: 0,
      startPtsSec: 0,
      endPtsSec: 10
    }
    const res409 = await executeSingleVideoSegment({
      segment: segBase,
      effectiveLimitSec: 30,
      paramsHash: 'h1',
      perceptionParams: {},
      deps: fakeDeps
    })
    expect(res409).toMatchObject({ outcome: 'failed', reason: 'needs_app_update' })
    expect(terminalCalls[0]).toMatchObject({
      failureCode: 'needs_app_update',
      markStateNonOk: false
    })

    fakeDeps.anydocService.perceive = async () => {
      throw new OmniPerceptionHttpError({
        status: 429,
        code: 'RATE_LIMITED',
        reason: 'TOO_MANY_REQUESTS',
        encoderId: 2,
        message: 'rate limit'
      })
    }
    const res429 = await executeSingleVideoSegment({
      segment: segBase,
      effectiveLimitSec: 30,
      paramsHash: 'h1',
      perceptionParams: {},
      deps: fakeDeps
    })
    expect(res429.outcome).toBe('failed')
    expect(retryCalls.length).toBe(1)

    // 3. R3 [M-1]: 老行 last_app_version=NULL 遇新 appVersion 且存在 needs_app_update 时解锁重投
    db.prepare(
      `UPDATE visual_tagger_state
       SET last_status = 'ok', generation = 5, last_app_version = NULL
       WHERE encoder_id = 2`
    ).run()
    dao.recordQueueVisualFailureTx({
      queueId: 1,
      errorMessage: '请更新应用',
      failureCode: 'needs_app_update',
      encoderId: 2,
      markStateNonOk: false
    })
    const nullVerUpgrade = dao.observeTaggerHealthyOrFingerprintChangedTx(2, 'fp-v1', '1.2.0')
    expect(nullVerUpgrade.appVersionChanged).toBe(true)
    expect(nullVerUpgrade.currentGeneration).toBe(6)
    const afterNullUpgrade = dao.requeueEligibleFailedItemsTx({
      activeEncoderId: 2,
      currentGeneration: 6,
      includeNeedsAppUpdate: true
    })
    expect(afterNullUpgrade.requeuedQueueCount).toBe(1)

    // 4. R4 [M-B]: downloadAndReconcileFn 抛异常时 handleEngineNotReady409 不应直接 reject，必须推进 attempts/冷却
    let mNow = 50_000_000
    const mCoord = new VisualTaggerCoordinator({ nowFn: () => mNow })
    const dlErrOutcome = await mCoord.handleEngineNotReady409({
      resourceId: 'chinese-clip',
      expectedFingerprint: 'fp-dl-throw',
      localVerifyAndHealFn: async () => ({ ok: false }),
      downloadAndReconcileFn: async () => {
        throw new Error('network ECONNRESET')
      }
    })
    expect(dlErrOutcome.outcome).toBe('pending_reconcile')
    expect(mCoord.getReconcileState('chinese-clip', 'fp-dl-throw')?.attempts).toBe(1)
    expect(mCoord.getNextVisualReconcileRetryAt()).toBe(mNow + 60_000)
  })
})
