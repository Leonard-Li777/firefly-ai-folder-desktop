import { describe, it, expect, vi, beforeEach } from 'vitest'
import '../../../../../../pro/tests/mocks/electron-mock'
import { TagTreeQuery } from '../TagTreeQuery'
import { omniClient } from '../../../../services/omni-client'

vi.mock('../../../../services/omni-client', () => ({
  omniClient: {
    clearTaxonomyTreeCache: vi.fn(),
    getTaxonomyTree: vi.fn()
  }
}))

vi.mock('@runtime/database/database-service', () => ({
  databaseService: {
    resolveTagDisplayNames: vi.fn((codes: string[]) => {
      const map: Record<string, string> = {}
      for (const c of codes) {
        if (c === 'omw.02378347.s') map[c] = '同步'
        if (c === 'omw.00447472.s') map[c] = '同步'
        if (c === 'builtin.content_tags') map[c] = '内容标签'
      }
      return map
    })
  }
}))

describe('TagTreeQuery: 严格遵从受控 Code 徽标统计，杜绝同名同形异义词串扰 (PRD-0058 / ADR-0053)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('两个具有相同中文展示名但不同受控 code 的节点，文件计数必须按 code 隔离，不得因同名虚标', async () => {
    // 模拟 Omni 受控分类树：在内容标签下挂载两个不同 code 但中文名均为「同步」的节点
    // 节点 1: 数据同步 (omw.02378347.s)
    // 节点 2: 动作伴随/临近 (omw.00447472.s)
    const mockOmniTree = {
      rootNodes: [
        {
          code: 'builtin.content_tags',
          name: '内容标签',
          children: [
            {
              code: 'omw.02378347.s',
              name: '同步',
              sortOrder: 1,
              children: []
            },
            {
              code: 'omw.00447472.s',
              name: '同步',
              sortOrder: 2,
              children: []
            }
          ]
        }
      ]
    }
    vi.mocked(omniClient.getTaxonomyTree).mockResolvedValue(mockOmniTree as any)

    // 模拟数据库关系：
    // - omw.02378347.s 命中 2 个文件 (fp_cloud_1, fp_cloud_2)
    // - omw.00447472.s 命中 1 个文件 (fp_calligraphy_3)
    const mockDb: any = {
      name: ':memory:',
      function: vi.fn(),
      prepare: vi.fn((sql: string) => {
        if (sql.includes('FROM file_tags_private')) {
          return {
            all: () => []
          }
        }
        if (sql.includes('FROM file_tag_relations')) {
          return {
            all: () => [
              {
                tag_code: 'omw.02378347.s',
                via_parent_code: 'builtin.content_tags',
                file_fingerprint: 'fp_cloud_1'
              },
              {
                tag_code: 'omw.02378347.s',
                via_parent_code: 'builtin.content_tags',
                file_fingerprint: 'fp_cloud_2'
              },
              {
                tag_code: 'omw.00447472.s',
                via_parent_code: 'builtin.content_tags',
                file_fingerprint: 'fp_calligraphy_3'
              }
            ]
          }
        }
        return {
          all: () => [],
          get: () => null
        }
      })
    }

    const query = new TagTreeQuery(mockDb)
    const res = await query.getDimensionGroups({ language: 'zh-CN' })

    const contentGroup = res.groups.find(g => g.code === 'builtin.content_tags')
    expect(contentGroup).toBeDefined()

    // 找到两个「同步」节点
    const syncNode1 = contentGroup?.tags.find(t => t.code === 'omw.02378347.s')
    const syncNode2 = contentGroup?.tags.find(t => t.code === 'omw.00447472.s')

    expect(syncNode1).toBeDefined()
    expect(syncNode2).toBeDefined()

    // 关键断言：
    // 过去因为 tagNameFilesMap.get('同步') 把 3 个文件混在一起，两个节点的 fileCount 都会被虚报为 3！
    // 修复后：严格按受控 code 隔离，Node 1 命中 2，Node 2 命中 1
    expect(syncNode1?.fileCount).toBe(2)
    expect(syncNode2?.fileCount).toBe(1)
  })
})
