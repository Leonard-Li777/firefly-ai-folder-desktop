// @vitest-environment node
/**
 * Ticket 04 (Spec §3.3):
 * ConfigDbManager 双出口防空表死锁、订阅即拉取、单飞去重、语言代际防覆盖、负缓存隔离与有界退避测试
 */
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  const electronMock = {
    app: {
      isReady: vi.fn(() => true),
      getPath: vi.fn(() => process.cwd()),
      getAppPath: vi.fn(() => process.cwd()),
      getVersion: vi.fn(() => '2.2.0'),
      on: vi.fn(),
      whenReady: vi.fn(async () => true)
    },
    BrowserWindow: {
      getAllWindows: vi.fn(() => []),
      getFocusedWindow: vi.fn(() => null)
    },
    ipcMain: {
      handle: vi.fn(),
      on: vi.fn(),
      removeHandler: vi.fn(),
      removeAllListeners: vi.fn()
    },
    powerMonitor: {
      on: vi.fn(),
      off: vi.fn(),
      removeListener: vi.fn(),
      isOnBatteryPower: vi.fn(() => false)
    },
    shell: {
      openExternal: vi.fn(),
      openPath: vi.fn()
    },
    net: {
      request: vi.fn(),
      isOnline: vi.fn(() => true)
    },
    nativeImage: {
      createFromPath: vi.fn(() => ({ toDataURL: vi.fn(() => ''), isEmpty: vi.fn(() => false) }))
    },
    safeStorage: {
      isEncryptionAvailable: vi.fn(() => false),
      encryptString: vi.fn((s: string) => Buffer.from(s)),
      decryptString: vi.fn((b: Buffer) => b.toString())
    },
    dialog: { showSaveDialog: vi.fn(), showMessageBox: vi.fn() }
  }
  return {
    __esModule: true,
    ...electronMock,
    default: electronMock
  }
})

vi.mock('electron-conf', () => ({
  Conf: vi.fn().mockImplementation(() => ({
    get: vi.fn(),
    set: vi.fn()
  }))
}))

vi.mock('@firefly/server', () => ({
  WORKSPACE_CONSTANTS: {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_ANON_KEY: 'anon-key'
  },
  cloudAnalysisService: {
    setSupabaseClient: vi.fn(),
    setIdentityProvider: vi.fn(),
    initialize: vi.fn(async () => {})
  }
}))

import { GENESIS_V1_SCHEMA } from '../../database/database'
import { databaseService } from '../../database/database-service'
import { ConfigDbManager } from '../config-db-manager'
import { omniClient } from '../../../services/omni-client'
import { omniService } from '../../system/omni-service'
import { logger } from '@firefly/shared'

describe('Ticket 04: ConfigDbManager 空库自愈补译、单飞、代际围栏与有界退避', () => {
  let db: Database.Database

  function countAliases(locale: string): number {
    const row = db
      .prepare('SELECT COUNT(*) AS cnt FROM tag_aliases WHERE locale = ?')
      .get(locale) as { cnt: number }
    return row.cnt
  }

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(GENESIS_V1_SCHEMA)
    vi.spyOn(databaseService, 'db', 'get').mockReturnValue(db as any)
    vi.spyOn(databaseService, 'rebuildDebugTagViewsForLanguage').mockImplementation(() => {})
    const mgr = ConfigDbManager.getInstance()
    mgr.clearTaxonomyRetryTimer()
    mgr.clearUnresolvableCodeCache()
    ;(mgr as any).currentLanguage = 'zh-CN'
    ;(mgr as any).initialized = false
  })

  afterEach(() => {
    vi.useRealTimers()
    ConfigDbManager.getInstance().clearTaxonomyRetryTimer()
    vi.restoreAllMocks()
    if (db && db.open) {
      db.close()
    }
  })

  it('omniClient.getTaxonomyAliases 透传 { timeoutMs, retries, bypassEnsureRunning } 并在 503 MODULE_NOT_INSTALLED 时立即停试', async () => {
    const ensureSpy = vi.spyOn(omniService, 'ensureRunning').mockResolvedValue(true)
    vi.spyOn(omniService, 'getBaseUrl').mockReturnValue('http://127.0.0.1:38299')
    const fetchSpy = vi.spyOn(omniService, 'omniFetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: 'MODULE_NOT_INSTALLED' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        })
    )

    const coldRows = await omniClient.getTaxonomyAliases('zh-CN', {
      source: 'dimension,tag',
      timeoutMs: 3000,
      retries: 0,
      bypassEnsureRunning: true
    })

    expect(coldRows).toBeNull()
    expect(ensureSpy).not.toHaveBeenCalled()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ kind: 'call', timeoutMs: 3000 })
    expect(omniClient.getLastTaxonomyAliasesError()).toMatchObject({
      status: 503,
      errorCode: 'MODULE_NOT_INSTALLED'
    })

    // 即使 retries=2，遇到 503 MODULE_NOT_INSTALLED 也只请求 1 次即提前停试
    fetchSpy.mockClear()
    const nonRetried = await omniClient.getTaxonomyAliases('en-US', {
      source: 'dimension,tag',
      retries: 2,
      bypassEnsureRunning: true
    })
    expect(nonRetried).toBeNull()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('null 绝不入负缓存可再次恢复；Array 缺码入 unresolvableCodeCache 并打首次 warn', async () => {
    const warnSpy = vi.spyOn(logger, 'warn')
    const getSpy = vi
      .spyOn(omniClient, 'getTaxonomyAliases')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce([
        { tag_code: 'omw.00001740-n', lemma: '动物', is_canonical: 1, n: 1, count: 5 }
      ])
      .mockResolvedValueOnce([
        { tag_code: 'omw.00001740-n', lemma: '动物', is_canonical: 1, n: 1, count: 5 }
      ])

    const mgr = ConfigDbManager.getInstance()

    // 1. 首次 Omni 未就绪返回 null：仅 warn，绝不将 missing codes 加入负缓存
    await mgr.ensureCodesHydrated(db, ['omw.00001740-n', 'omw.99999999-n'], 'zh-CN', {
      timeoutMs: 3000,
      retries: 0,
      bypassEnsureRunning: true
    })
    expect(countAliases('zh-CN')).toBe(0)
    expect(warnSpy).toHaveBeenCalled()

    // 2. Omni 上线后二次调用：同一批 code 未被负缓存屏蔽，重新发起请求并成功入库；
    //    其中未被 Omni 返回的 omw.99999999-n 进入负缓存并记首次 warn
    warnSpy.mockClear()
    await mgr.ensureCodesHydrated(db, ['omw.00001740-n', 'omw.99999999-n'], 'zh-CN', {
      timeoutMs: 3000,
      retries: 0,
      bypassEnsureRunning: true
    })
    expect(getSpy).toHaveBeenCalledTimes(2)
    expect(countAliases('zh-CN')).toBe(1)
    expect(warnSpy).toHaveBeenCalledTimes(1)

    // 3. 第三次只查询已知无解码 omw.99999999-n：命中负缓存跳过网络请求，且不再重复 warn
    warnSpy.mockClear()
    await mgr.ensureCodesHydrated(db, ['omw.99999999-n'], 'zh-CN', {
      timeoutMs: 3000,
      retries: 0,
      bypassEnsureRunning: true
    })
    expect(getSpy).toHaveBeenCalledTimes(2)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('inFlightSeedPromises 同语种并发单飞去重 & 冷启动透传 bypassEnsureRunning 参数', async () => {
    let resolveDeferred!: (rows: any[]) => void
    const deferred = new Promise<any[]>(resolve => {
      resolveDeferred = resolve
    })
    const getSpy = vi.spyOn(omniClient, 'getTaxonomyAliases').mockReturnValue(deferred)

    const mgr = ConfigDbManager.getInstance()
    const p1 = mgr.seedTagAliasesLangTable(db, 'zh-CN')
    const p2 = mgr.seedTagAliasesLangTable(db, 'zh-CN')
    expect(getSpy).toHaveBeenCalledTimes(1)
    expect(getSpy).toHaveBeenCalledWith('zh-CN', {
      source: 'dimension,tag',
      timeoutMs: 3000,
      retries: 0,
      bypassEnsureRunning: true
    })

    resolveDeferred([
      { tag_code: 'builtin.document', lemma: '文档', is_canonical: 1, n: 1, count: 1 }
    ])
    await Promise.all([p1, p2])
    expect(countAliases('zh-CN')).toBe(1)
  })

  it('taxonomySeedEpoch 防旧语言异步回灌覆盖切换后的新语言', async () => {
    let resolveEn!: (rows: any[]) => void
    const enDeferred = new Promise<any[]>(resolve => {
      resolveEn = resolve
    })

    const getSpy = vi
      .spyOn(omniClient, 'getTaxonomyAliases')
      .mockImplementation(async locale => {
        if (locale === 'en-US') return enDeferred
        return [{ tag_code: 'builtin.document', lemma: 'ドキュメント', is_canonical: 1, n: 1, count: 1 }]
      })

    const mgr = ConfigDbManager.getInstance()
    vi.spyOn(mgr, 'loadFromJson').mockImplementation(() => {})
    vi.spyOn(mgr as any, 'preloadFileDimensions').mockResolvedValue(undefined)
    vi.spyOn(mgr as any, 'broadcastConfigUpdate').mockImplementation(() => {})

    // 1. 发起 en-US 慢请求（epoch 停留在切换前）
    const enTask = mgr.seedTagAliasesLangTable(db, 'en-US')

    // 2. 尚未返回时用户切换语言至 ja-JP（递增 taxonomySeedEpoch）
    await mgr.initialize('ja-JP', true)
    await vi.waitFor(() => {
      expect(countAliases('ja-JP')).toBe(1)
    })

    // 3. 迟到的 en-US 响应到达，被 epoch 围栏丢弃，绝不污染数据库
    resolveEn([
      { tag_code: 'builtin.document', lemma: 'Document', is_canonical: 1, n: 1, count: 1 }
    ])
    await enTask

    expect(countAliases('en-US')).toBe(0)
    expect(countAliases('ja-JP')).toBe(1)
    expect(getSpy).toHaveBeenCalled()
  })

  it('后台有界退避重试按 1s/4s/16s 最多重试 3 次，且遇 503 MODULE_NOT_INSTALLED 立即停止重试', async () => {
    vi.useFakeTimers()
    const mgr = ConfigDbManager.getInstance()

    // 子场景 A：非 503 缺模的瞬时失败（null），严格 1 initial + 3 retries（1s / 4s / 16s）= 4 次
    vi.spyOn(omniClient, 'getLastTaxonomyAliasesError').mockReturnValue(null)
    const getSpy = vi.spyOn(omniClient, 'getTaxonomyAliases').mockResolvedValue(null)

    await mgr.seedTagAliasesWithBoundedRetry(db, 'zh-CN')
    expect(getSpy).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(999)
    expect(getSpy).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1) // +1000ms -> 重试 #1
    expect(getSpy).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(3999)
    expect(getSpy).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1) // +4000ms -> 重试 #2
    expect(getSpy).toHaveBeenCalledTimes(3)

    await vi.advanceTimersByTimeAsync(15999)
    expect(getSpy).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1) // +16000ms -> 重试 #3
    expect(getSpy).toHaveBeenCalledTimes(4)

    // 超过第 3 次后不再有第 4 次退避重试
    await vi.advanceTimersByTimeAsync(60_000)
    expect(getSpy).toHaveBeenCalledTimes(4)

    // 子场景 B：遇到 503 MODULE_NOT_INSTALLED，首次即停止重试（不调度 1s/4s/16s）
    getSpy.mockClear()
    vi.spyOn(omniClient, 'getLastTaxonomyAliasesError').mockReturnValue({
      status: 503,
      errorCode: 'MODULE_NOT_INSTALLED',
      at: Date.now()
    })
    await mgr.seedTagAliasesWithBoundedRetry(db, 'en-US')
    expect(getSpy).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(getSpy).toHaveBeenCalledTimes(1)
  })

  it('initialization.ts registerConfigDbTaxonomySelfHeal: 订阅 onInstanceChanged(无代际过滤) 且 ensureRunning 后立即 pull 补灌空表', async () => {
    let instanceChangedCb: ((gen: number) => void) | undefined
    vi.spyOn(omniService, 'onInstanceChanged').mockImplementation(cb => {
      instanceChangedCb = cb
      return () => {}
    })
    const ensureSpy = vi.spyOn(omniService, 'ensureRunning').mockResolvedValue(true)

    const getSpy = vi
      .spyOn(omniClient, 'getTaxonomyAliases')
      .mockResolvedValueOnce([
        { tag_code: 'builtin.image', lemma: '图片', is_canonical: 1, n: 1, count: 2 }
      ])
      .mockResolvedValueOnce([
        { tag_code: 'builtin.image', lemma: 'Image', is_canonical: 1, n: 1, count: 2 }
      ])

    const { registerConfigDbTaxonomySelfHeal } = await import('../../../main/initialization')

    // 1. Pull 通路：绑定订阅后即使 Omni 早前已完成启动，await ensureRunning() 仍立即 pull 检查并灌表
    await registerConfigDbTaxonomySelfHeal()
    expect(ensureSpy).toHaveBeenCalledTimes(1)
    expect(countAliases('zh-CN')).toBe(1)

    // 2. Push 通路：切换空库并触发无代际过滤的 onInstanceChanged（即便是较小的 gen=1 也必须响应）
    db.prepare('DELETE FROM tag_aliases').run()
    expect(countAliases('zh-CN')).toBe(0)
    expect(instanceChangedCb).toBeDefined()

    instanceChangedCb!(1)
    await vi.waitFor(() => {
      expect(countAliases('zh-CN')).toBe(1)
    })
    expect(getSpy).toHaveBeenCalledTimes(2)
  })
})
