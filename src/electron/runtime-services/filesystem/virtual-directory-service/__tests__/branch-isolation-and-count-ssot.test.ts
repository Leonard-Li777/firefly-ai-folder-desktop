import { describe, it, expect, vi, beforeEach } from 'vitest'
import '../../../../../../pro/tests/mocks/electron-mock'
import { normalizeCodePath, TagTreeQuery } from '../TagTreeQuery'
import { SelectedTag } from '@firefly/types'
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
        if (c === 'omw.06368628.n') map[c] = '科幻'
        if (c === 'omw.03833065.n') map[c] = '小说'
        if (c === 'builtin.file_type') map[c] = '文件类型'
        if (c === 'hownet.000000207706.n') map[c] = '电子书'
        if (c === 'omw.00543233.n') map[c] = '音频'
        if (c === 'builtin.theme') map[c] = '题材'
        if (c === 'omw.06912865.n') map[c] = '英文'
        if (c === 'builtin.document') map[c] = '文档'
        if (c === 'builtin.language_segmentation') map[c] = '语言细分'
      }
      return map
    })
  }
}))

describe('TagTreeQuery - 路径归一化与排他前缀查询测试 (SSOT)', () => {
  it('normalizeCodePath 能够正确处理各种首尾斜杠与反斜杠', () => {
    expect(normalizeCodePath('')).toBe('')
    expect(normalizeCodePath('   ')).toBe('')
    expect(normalizeCodePath('/builtin.file_type/builtin.document/')).toBe('/builtin.file_type/builtin.document')
    expect(normalizeCodePath('builtin.file_type/builtin.document')).toBe('/builtin.file_type/builtin.document')
    expect(normalizeCodePath('\\builtin.file_type\\builtin.document\\')).toBe('/builtin.file_type/builtin.document')
    expect(normalizeCodePath('///builtin.file_type///builtin.document///')).toBe('/builtin.file_type/builtin.document')
  })

  it('buildTagFilterSubClause 收紧为严格左前缀匹配，无 LIKE %/tail 通配', () => {
    const query = new (TagTreeQuery as any)({} as any)
    const tag: SelectedTag = {
      dimensionId: 11,
      dimensionName: '语言细分',
      tagValue: '英文',
      code: 'omw.06912865.n',
      codePath: '/builtin.file_type/builtin.document/builtin.language_segmentation/omw.06912865.n',
      level: 2
    }

    const params: any[] = []
    const clause = (query as any).buildTagFilterSubClause(tag, params)

    expect(clause).toBeDefined()
    // 关键断言：绝对严禁出现 LIKE ('%/' || ?) 后缀模糊通配（消除跨介质误召回）
    expect(clause).not.toContain('%/')
    // 关键断言：必须且仅包含排他左前缀匹配
    expect(clause).toBe("((ftr.code_path = ? OR ftr.code_path LIKE (? || '/%') ESCAPE '\\'))")
    expect(params.length).toBe(2)
    expect(params[0]).toBe('/builtin.file_type/builtin.document/builtin.language_segmentation/omw.06912865.n')
    // LIKE 前缀匹配转义下划线防通配
    expect(params[1]).toBe('/builtin.file\\_type/builtin.document/builtin.language\\_segmentation/omw.06912865.n')
  })

  it('Fail-Closed 铁律：跨介质多宿主维度（如题材）既无 codePath 又无 hostScopeCode 时强制返回 1 = 0 阻断全库泛查', () => {
    const query = new (TagTreeQuery as any)({} as any)
    const sciFiTag: SelectedTag = {
      dimensionId: 25,
      dimensionName: '题材',
      dimensionCode: 'builtin.theme',
      tagValue: '科幻',
      code: 'omw.06368628.n',
      level: 3
      // 故意缺失 codePath 与 hostScopeCode
    }

    const params: any[] = []
    const clause = (query as any).buildTagFilterSubClause(sciFiTag, params)

    // 关键断言：绝对严禁返回全库泛查 SQL，必须 Fail-Closed 返回 1 = 0 阻断
    expect(clause).toBe('1 = 0')
    // 关键断言 (AGENTS.md §2.9)：params 必须保持为空，严禁残留占位符失配绑定参数
    expect(params.length).toBe(0)
  })

  it('降级宿主约束：多宿主维度缺失 codePath 但携带受控 hostScopeCode 时追加严格宿主共现约束', () => {
    const query = new (TagTreeQuery as any)({} as any)
    const sciFiTag: SelectedTag = {
      dimensionId: 25,
      dimensionName: '题材',
      dimensionCode: 'builtin.theme',
      tagValue: '科幻',
      code: 'omw.06368628.n',
      hostScopeCode: 'hownet.000000207706.n', // 电子书受控码
      level: 3
    }

    const params: any[] = []
    const clause = (query as any).buildTagFilterSubClause(sciFiTag, params)

    expect(clause).toBeDefined()
    expect(clause).toContain('ftr.tag_code IN (')
    expect(clause).toContain('ftr_host.tag_code = ? OR ftr_host.code_path LIKE')
    expect(params).toContain('hownet.000000207706.n')
  })

  it('TagTreeQuery.getDimensionGroups: 音频包含科幻时，电子书下的科幻绝不继承音频物理路径或虚高计数，开启剪枝时干净剔除', async () => {
    // 模拟 Omni 树：文件类型下包含电子书与音频，电子书下有小说 -> 题材 -> 科幻
    const mockOmniTree = {
      rootNodes: [
        {
          code: 'builtin.file_type',
          name: '文件类型',
          sortOrder: 1,
          children: [
            {
              code: 'hownet.000000207706.n',
              name: '电子书',
              sortOrder: 1,
              children: [
                {
                  code: 'omw.03833065.n',
                  name: '小说',
                  sortOrder: 1,
                  children: [
                    {
                      code: 'builtin.theme',
                      name: '题材',
                      sortOrder: 1,
                      children: [
                        {
                          code: 'omw.06368628.n',
                          name: '科幻',
                          sortOrder: 1,
                          children: []
                        }
                      ]
                    }
                  ]
                }
              ]
            },
            {
              code: 'omw.00543233.n',
              name: '音频',
              sortOrder: 2,
              children: []
            }
          ]
        }
      ]
    }
    vi.mocked(omniClient.getTaxonomyTree).mockResolvedValue(mockOmniTree as any)

    // 模拟数据库关系：只有音频文件 hit 科幻 (audio.wav)
    const mockDb: any = {
      name: ':memory:',
      function: vi.fn(),
      prepare: vi.fn((sql: string) => {
        if (sql.includes('FROM file_tags_private')) {
          return { all: () => [] }
        }
        if (sql.includes('FROM file_tag_relations')) {
          return {
            all: () => [
              {
                tag_code: 'omw.00543233.n',
                via_parent_code: 'builtin.file_type',
                file_fingerprint: 'fp_audio_1',
                code_path: '/builtin.file_type/omw.00543233.n'
              },
              {
                tag_code: 'omw.06368628.n',
                via_parent_code: 'builtin.theme',
                file_fingerprint: 'fp_audio_1',
                code_path: '/builtin.file_type/omw.00543233.n/builtin.theme/omw.06368628.n'
              }
            ]
          }
        }
        return { all: () => [], get: () => null }
      })
    }

    const query = new TagTreeQuery(mockDb)

    // 1. 未开启剪枝：电子书下的科幻计数必须严格为 0，且 codePath 必须归属于电子书，绝不能是音频路径
    const resNoPrune = await query.getDimensionGroups({ removeEmptyTags: false, language: 'zh-CN' })
    const ftGroupNoPrune = resNoPrune.groups.find(g => g.code === 'builtin.file_type')
    expect(ftGroupNoPrune).toBeDefined()

    const sciFiInEbook = ftGroupNoPrune!.tags.find(
      t => t.code === 'omw.06368628.n' && t.codePath?.includes('hownet.000000207706.n')
    )
    expect(sciFiInEbook).toBeDefined()
    // 关键断言：计数为 0，绝非音频的 1 或 11
    expect(sciFiInEbook!.fileCount).toBe(0)
    // 关键断言：路径绝不能包含音频受控码
    expect(sciFiInEbook!.codePath).not.toContain('omw.00543233.n')
    expect(sciFiInEbook!.codePath).toBe('/builtin.file_type/hownet.000000207706.n/omw.03833065.n/builtin.theme/omw.06368628.n')

    // 2. 开启剪枝 (removeEmptyTags: true)：电子书下的科幻为 0 计数，必须直接被剔除
    const resPrune = await query.getDimensionGroups({ removeEmptyTags: true, language: 'zh-CN' })
    const ftGroupPrune = resPrune.groups.find(g => g.code === 'builtin.file_type')
    expect(ftGroupPrune).toBeDefined()
    const sciFiPruned = ftGroupPrune!.tags.find(
      t => t.code === 'omw.06368628.n' && t.codePath?.includes('hownet.000000207706.n')
    )
    expect(sciFiPruned).toBeUndefined()
  })

  it('TagTreeQuery.getDimensionGroups: 跨介质同名标签（如文档英文 vs 电子书英文）计数与路径绝对隔离', async () => {
    const mockOmniTree = {
      rootNodes: [
        {
          code: 'builtin.file_type',
          name: '文件类型',
          sortOrder: 1,
          children: [
            {
              code: 'builtin.document',
              name: '文档',
              sortOrder: 1,
              children: [
                {
                  code: 'builtin.language_segmentation',
                  name: '语言细分',
                  sortOrder: 1,
                  children: [
                    {
                      code: 'omw.06912865.n',
                      name: '英文',
                      sortOrder: 1,
                      children: []
                    }
                  ]
                }
              ]
            },
            {
              code: 'hownet.000000207706.n',
              name: '电子书',
              sortOrder: 2,
              children: [
                {
                  code: 'builtin.language_segmentation',
                  name: '语言细分',
                  sortOrder: 1,
                  children: [
                    {
                      code: 'omw.06912865.n',
                      name: '英文',
                      sortOrder: 1,
                      children: []
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    }
    vi.mocked(omniClient.getTaxonomyTree).mockResolvedValue(mockOmniTree as any)

    const mockDb: any = {
      name: ':memory:',
      function: vi.fn(),
      prepare: vi.fn((sql: string) => {
        if (sql.includes('FROM file_tags_private')) {
          return { all: () => [] }
        }
        if (sql.includes('FROM file_tag_relations')) {
          return {
            all: () => [
              {
                tag_code: 'omw.06912865.n',
                via_parent_code: 'builtin.language_segmentation',
                file_fingerprint: 'fp_doc_1',
                code_path: '/builtin.file_type/builtin.document/builtin.language_segmentation/omw.06912865.n'
              },
              {
                tag_code: 'omw.06912865.n',
                via_parent_code: 'builtin.language_segmentation',
                file_fingerprint: 'fp_ebook_1',
                code_path: '/builtin.file_type/hownet.000000207706.n/builtin.language_segmentation/omw.06912865.n'
              }
            ]
          }
        }
        return { all: () => [], get: () => null }
      })
    }

    const query = new TagTreeQuery(mockDb)
    const res = await query.getDimensionGroups({ removeEmptyTags: false, language: 'zh-CN' })
    const ftGroup = res.groups.find(g => g.code === 'builtin.file_type')
    expect(ftGroup).toBeDefined()

    const docEnglish = ftGroup!.tags.find(
      t => t.code === 'omw.06912865.n' && t.codePath?.includes('builtin.document')
    )
    const ebookEnglish = ftGroup!.tags.find(
      t => t.code === 'omw.06912865.n' && t.codePath?.includes('hownet.000000207706.n')
    )

    expect(docEnglish).toBeDefined()
    expect(ebookEnglish).toBeDefined()

    // 关键断言：计数各为 1，绝非全库总数 2
    expect(docEnglish!.fileCount).toBe(1)
    expect(ebookEnglish!.fileCount).toBe(1)

    // 关键断言：物化路径严格分立
    expect(docEnglish!.codePath).toBe('/builtin.file_type/builtin.document/builtin.language_segmentation/omw.06912865.n')
    expect(ebookEnglish!.codePath).toBe('/builtin.file_type/hownet.000000207706.n/builtin.language_segmentation/omw.06912865.n')
  })

  it('AC-6 / P0-3: 某分支剪枝 (removeEmptyTags: true) 不得提前认领 assignedCodes 导致在有效命中分支中消失', async () => {
    vi.mocked(omniClient.getTaxonomyTree).mockResolvedValue(null as any)

    // 模拟场景：
    // 标签 "omw.shared_tag" 同时属于两个维度：'builtin.theme' 和 'builtin.style'；
    // 在 'builtin.theme' 下该标签没有文件 (count = 0)；
    // 但在 'builtin.style' 下真实有 1 个文件命中！
    const mockDb: any = {
      name: ':memory:',
      function: vi.fn(),
      prepare: vi.fn((sql: string) => {
        if (sql.includes('FROM file_tags_private')) {
          return {
            all: () => [
              {
                id: 1,
                code: 'builtin.theme',
                name: '题材',
                parent_codes: '[]',
                level: 0,
                meta: '{}'
              },
              {
                id: 2,
                code: 'builtin.style',
                name: '风格',
                parent_codes: '[]',
                level: 0,
                meta: '{}'
              },
              {
                id: 101,
                code: 'omw.shared_tag',
                name: '共享标签',
                parent_codes: JSON.stringify(['builtin.theme', 'builtin.style']),
                level: 1,
                meta: '{}'
              }
            ]
          }
        }
        if (sql.includes('FROM file_tag_relations')) {
          return {
            all: () => [
              // 该文件仅在风格维度拥有该标签
              {
                tag_code: 'omw.shared_tag',
                via_parent_code: 'builtin.style',
                file_fingerprint: 'fp_style_1',
                code_path: '/builtin.style/omw.shared_tag'
              }
            ]
          }
        }
        return { all: () => [], get: () => null }
      })
    }

    const query = new TagTreeQuery(mockDb)
    // 开启剪枝
    const res = await query.getDimensionGroups({ removeEmptyTags: true, language: 'zh-CN' })

    // 在题材分支下，由于 count 为 0，该标签被安全剪枝，整组也因全空被安全剔除
    const themeGroup = res.groups.find(g => g.code === 'builtin.theme')
    const themeTag = themeGroup?.tags.find(t => t.code === 'omw.shared_tag')
    expect(themeTag).toBeUndefined()

    // 关键断言 P0-3：在风格分支下，该标签必须正常产出（因为真实有 1 个文件命中），
    // 绝不能因为在题材分支被剪枝就提前被 assignedCodes 霸占导致在有效分支失踪！
    const styleGroup = res.groups.find(g => g.code === 'builtin.style')
    expect(styleGroup).toBeDefined()
    const styleTag = styleGroup!.tags.find(t => t.code === 'omw.shared_tag')
    expect(styleTag).toBeDefined()
    expect(styleTag!.fileCount).toBe(1)
    expect(styleTag!.codePath).toBe('/builtin.style/omw.shared_tag')
  })
})
