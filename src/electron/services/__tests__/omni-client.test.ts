import { describe, it, expect, vi, beforeEach } from 'vitest'
import { OmniClient } from '../omni-client'

// 模拟 omniService
vi.mock('../runtime-services/system/omni-service', () => ({
  omniService: {
    ensureRunning: vi.fn().mockResolvedValue(true),
    getBaseUrl: vi.fn().mockReturnValue('http://127.0.0.1:39281')
  }
}))

describe('OmniClient Taxonomy Tree API 契约测试', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
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
})
