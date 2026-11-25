import { describe, it, expect, vi, beforeEach } from 'vitest'
import { OmniClient } from '../omni-client'

// 模拟 omniService
// 注意：mock 路径必须与 omni-client.ts 中 import 的模块解析到同一文件，
// 故这里相对 __tests__ 目录写作 ../../runtime-services/system/omni-service。
vi.mock('../../runtime-services/system/omni-service', () => ({
  omniService: {
    isReady: vi.fn().mockReturnValue(true),
    ensureRunning: vi.fn().mockResolvedValue(true),
    // getTaxonomyTree 前置快速探活：未就绪时不得阻塞等待冷启动（见下方护栏用例）
    checkHealth: vi.fn().mockResolvedValue(true),
    start: vi.fn().mockResolvedValue(true),
    getBaseUrl: vi.fn().mockReturnValue('http://127.0.0.1:39281')
  }
}))

describe('OmniClient Taxonomy Tree API 契约测试', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    OmniClient.getInstance().clearTaxonomyTreeCache()
  })

  it('getTaxonomyTree 构造的 URL 查询参数中不得存在重复的 dbPath/db_path 别名冲突', async () => {
    let capturedUrl = ''
    global.fetch = vi.fn().mockImplementation((url: string) => {
      capturedUrl = url
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          locale: 'zh-CN',
          rootNodes: [{ code: 'builtin.file_type', name: '文件类型', children: [] }],
          totalNodes: 1
        })
      })
    })

    const client = OmniClient.getInstance()
    const testDbPath = 'C:\\test\\firefly.db'
    const res = await client.getTaxonomyTree('zh-CN', undefined, testDbPath, {
      workspaceId: 101,
      directoryPrefix: 'D:\\Music',
      includeFiles: true
    })

    expect(res).not.toBeNull()
    expect(res?.rootNodes).toHaveLength(1)

    // 解析发出的 URL
    const parsedUrl = new URL(capturedUrl)
    expect(parsedUrl.pathname).toBe('/api/v1/taxonomy/tree')

    const params = parsedUrl.searchParams
    // 验证 dbPath 存在且为唯一，严禁出现 db_path 导致 Rust Serde 报 duplicate field (HTTP 400)
    expect(params.get('dbPath')).toBe(testDbPath)
    expect(params.get('db_path')).toBeNull()

    // 验证其他参数统一为 camelCase
    expect(params.get('workspaceId')).toBe('101')
    expect(params.get('workspace_id')).toBeNull()

    expect(params.get('directoryPrefix')).toBe('D:\\Music')
    expect(params.get('directory_prefix')).toBeNull()

    expect(params.get('includeFiles')).toBe('true')
    expect(params.get('include_files')).toBeNull()

    // 验证参数键集合无任何重复项
    const keys = Array.from(params.keys())
    const uniqueKeys = new Set(keys)
    expect(keys.length).toBe(uniqueKeys.size)
  })

  it('并发多次调用 getTaxonomyTree 应自动合并在途请求 (Singleflight)，仅发起 1 次底层 HTTP 请求', async () => {
    const calledUrls: string[] = []
    global.fetch = vi.fn().mockImplementation((url: string) => {
      calledUrls.push(url)
      // 模拟 50ms 网络延迟
      return new Promise(resolve => {
        setTimeout(() => {
          resolve({
            ok: true,
            status: 200,
            json: async () => ({
              locale: 'zh-CN',
              rootNodes: [{ code: 'builtin.file_type', name: '文件类型', children: [] }],
              totalNodes: 1
            })
          })
        }, 50)
      })
    })

    const client = OmniClient.getInstance()
    // 模拟 8 个并发组件同时触发 getTaxonomyTree
    const promises = Array.from({ length: 8 }).map(() =>
      client.getTaxonomyTree('zh-CN', undefined, 'C:\\test\\firefly.db', {
        workspaceId: 101,
        directoryPrefix: 'D:\\Music'
      })
    )

    const results = await Promise.all(promises)

    // 8 个结果全部成功且内容一致
    expect(results).toHaveLength(8)
    for (const r of results) {
      expect(r?.rootNodes).toHaveLength(1)
      expect(r?.rootNodes[0].code).toBe('builtin.file_type')
    }

    // 关键断言：即使并发 8 次触发，由于 In-Flight Request Coalescing，底层 /api/v1/taxonomy/tree HTTP 请求严格只有 1 次
    const treeCalls = calledUrls.filter(u => u.includes('/api/v1/taxonomy/tree'))
    expect(treeCalls).toHaveLength(1)
  })

  it('Omni 未就绪时 getTaxonomyTree 不得阻塞等待冷启动：立即降级返回 null 并触发后台预热', async () => {
    const { omniService } = await import('../../runtime-services/system/omni-service')
    ;(omniService.checkHealth as any).mockResolvedValueOnce(false)

    let fetchCalled = false
    global.fetch = vi.fn().mockImplementation(() => {
      fetchCalled = true
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ locale: 'zh-CN', rootNodes: [], totalNodes: 0 })
      })
    })

    const client = OmniClient.getInstance()
    const res = await client.getTaxonomyTree('zh-CN', undefined, 'C:\\test\\firefly.db')

    // 降级返回空树，且未发起树请求（即未走 ensureRunning 的 40s 冷启动探活链路）
    expect(res).toBeNull()
    expect(fetchCalled).toBe(false)
    // 后台预热必须被触发，保证引擎就绪后受控维度树可被重取
    expect(omniService.start).toHaveBeenCalled()
  })
})

describe('OmniClient searchFastFs API 契约测试', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('Omni 未就绪时 searchFastFs 立即返回 null，触发后台预热且不发起 fetch', async () => {
    const { omniService } = await import('../../runtime-services/system/omni-service')
    ;(omniService.isReady as any).mockReturnValue(false)

    let fetchCalled = false
    global.fetch = vi.fn().mockImplementation(() => {
      fetchCalled = true
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ items: [], count: 0, durationMs: 1 })
      })
    })

    const client = OmniClient.getInstance()
    const res = await client.searchFastFs('D:\\workspace', 'test', 50)

    expect(res).toBeNull()
    expect(fetchCalled).toBe(false)
    expect(omniService.ensureRunning).toHaveBeenCalled()
  })

  it('Omni 已就绪时 searchFastFs 成功直通发起 fetch (bypassEnsureRunning: true) 并在短超时内返回结果', async () => {
    const { omniService } = await import('../../runtime-services/system/omni-service')
    ;(omniService.isReady as any).mockReturnValue(true)

    let capturedUrl = ''
    global.fetch = vi.fn().mockImplementation((url: string) => {
      capturedUrl = url
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          items: [{ path: 'D:\\workspace\\test.txt', name: 'test.txt', score: 100 }],
          count: 1,
          durationMs: 5
        })
      })
    })

    const client = OmniClient.getInstance()
    const res = await client.searchFastFs('D:\\workspace', 'test', 50)

    expect(res).not.toBeNull()
    expect(res?.items).toHaveLength(1)
    expect(res?.items[0].name).toBe('test.txt')

    const parsedUrl = new URL(capturedUrl)
    expect(parsedUrl.pathname).toBe('/api/v1/search/fs')
    expect(parsedUrl.searchParams.get('dir')).toBe('D:\\workspace')
    expect(parsedUrl.searchParams.get('q')).toBe('test')
    expect(parsedUrl.searchParams.get('limit')).toBe('50')
  })

  describe('tagText 6 态权威映射契约测试', () => {
    const basePayload = {
      fileFingerprint: 'fp-retag-1',
      text: '科技论文报告摘要',
      allowNewTags: true,
      excludeNames: [],
      sourceKind: 'document' as const,
      mediaKind: 'document' as const
    }

    it('支持 6 态权威优先级映射（success_with_tags / authoritative_empty / no_replacement / degraded / failed / aborted）', async () => {
      const client = OmniClient.getInstance()

      // 1. aborted (signal 预先中止)
      const ac = new AbortController()
      ac.abort('user-cancel')
      expect(await client.tagText(basePayload, 5000, ac.signal)).toEqual({
        ok: false,
        status: 'aborted',
        items: []
      })

      // 2. failed (HTTP 500)
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        headers: new Headers()
      })
      expect(await client.tagText(basePayload, 5000)).toEqual({
        ok: false,
        status: 'failed',
        items: []
      })

      // 3. degraded (x-omni-tag-degraded 缺失或为 true)
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({
          'x-omni-tag-degraded': 'true',
          'x-omni-tag-gate-evaluated': 'false'
        }),
        json: async () => [{ code: 'omw.1', name: '科技' }]
      })
      expect(await client.tagText(basePayload, 5000)).toEqual({
        ok: false,
        status: 'degraded',
        items: [{ code: 'omw.1', name: '科技' }]
      })

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => []
      })
      expect(await client.tagText(basePayload, 5000)).toEqual({
        ok: false,
        status: 'degraded',
        items: []
      })

      // 4. no_replacement (Gate-Evaluated=false 或 allowNewTags=false)
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({
          'x-omni-tag-degraded': 'false',
          'x-omni-tag-gate-evaluated': 'false'
        }),
        json: async () => [{ code: 'omw.1', name: '科技' }]
      })
      expect(await client.tagText(basePayload, 5000)).toEqual({
        ok: false,
        status: 'no_replacement',
        items: [{ code: 'omw.1', name: '科技' }]
      })

      // 5. success_with_tags
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({
          'x-omni-tag-degraded': 'false',
          'x-omni-tag-gate-evaluated': 'true'
        }),
        json: async () => [{ code: '_ext.1', name: '深度学习' }]
      })
      expect(await client.tagText(basePayload, 5000)).toEqual({
        ok: true,
        status: 'success_with_tags',
        items: [{ code: '_ext.1', name: '深度学习' }]
      })

      // 6. authoritative_empty
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({
          'x-omni-tag-degraded': 'false',
          'x-omni-tag-gate-evaluated': 'true'
        }),
        json: async () => []
      })
      expect(await client.tagText(basePayload, 5000)).toEqual({
        ok: true,
        status: 'authoritative_empty',
        items: []
      })
    })
  })
})
