import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import '../../../../../../pro/tests/mocks/electron-mock'
import { concept } from '@firefly/shared'
import { tagTreeQueryDimensionTreeMixin } from '../tag-tree-query-dimension-tree'
import { tagTreeQueryFilterMixin } from '../tag-tree-query-filter'
import { omniService } from '../../../system/omni-service'
import {
  nestGroupTags,
  getSelectedTagsFromSet,
  makeTagKey,
  buildDimensionTree,
  migrateTagKeysAcrossScale
} from '../../../../../renderer/components/file-explorer/dimension-tree-utils'
import type { DimensionGroup, DimensionTag } from '@firefly/types'

const authorCode = concept('作者')
const geoCode = concept('地理位置')
const contentCode = concept('内容标签')

vi.mock('../../../system/omni-service', () => ({
  omniService: {
    clusterDocuments: vi.fn(),
    isReady: vi.fn(() => true)
  }
}))

vi.mock('../../../../config/config-orchestrator', () => ({
  ConfigOrchestrator: {
    getInstance: () => ({
      getValue: vi.fn(),
      getEmbeddingDim: () => 384
    })
  }
}))

describe('泛维度轴标签智能聚类层级化 (clusterPanDimensionTags)', () => {
  let context: any

  beforeEach(() => {
    vi.clearAllMocks()
    context = {
      ...tagTreeQueryDimensionTreeMixin,
      _omniChildrenMap: new Map<string, Set<string>>()
    }
  })

  it('规则 1：已经依靠 parentCodes 层级化的标签优先按 parentCodes 层级展示，保持结构不变', async () => {
    // 模拟内容标签泛维度（id: 28, code: builtin.content_tags）中已存在父子层级
    const group: DimensionGroup = {
      id: 28,
      name: '内容标签',
      code: 'builtin.content_tags',
      level: 0,
      tags: [
        {
          dimensionId: 28,
          dimensionCode: 'builtin.content_tags',
          dimensionName: '内容标签',
          tagValue: '文学艺术',
          fileCount: 5,
          level: 1,
          code: 'tag_lit',
          codePath: '/builtin.content_tags/tag_lit',
          viaParentCode: 'builtin.content_tags'
        },
        {
          dimensionId: 28,
          dimensionCode: 'builtin.content_tags',
          dimensionName: '内容标签',
          tagValue: '古典诗词',
          fileCount: 3,
          level: 2,
          code: 'tag_poem',
          codePath: '/builtin.content_tags/tag_lit/tag_poem',
          viaParentCode: 'tag_lit'
        },
        {
          dimensionId: 28,
          dimensionCode: 'builtin.content_tags',
          dimensionName: '内容标签',
          tagValue: '现当代散文',
          fileCount: 2,
          level: 2,
          code: 'tag_prose',
          codePath: '/builtin.content_tags/tag_lit/tag_prose',
          viaParentCode: 'tag_lit'
        }
      ]
    }

    const pathCountMap: Record<string, number> = {
      '/builtin.content_tags/tag_lit': 5,
      '/builtin.content_tags/tag_lit/tag_poem': 3,
      '/builtin.content_tags/tag_lit/tag_prose': 2
    }

    await context.clusterPanDimensionTags([group], pathCountMap)

    // 所有标签都属于已层级化标签，没有平铺孤儿标签，因此不产生多余聚类
    expect(omniService.clusterDocuments).not.toHaveBeenCalled()
    expect(group.tags.length).toBe(3)
    const lit = group.tags.find(t => t.code === 'tag_lit')!
    const poem = group.tags.find(t => t.code === 'tag_poem')!
    const prose = group.tags.find(t => t.code === 'tag_prose')!

    expect(lit.level).toBe(1)
    expect(lit.viaParentCode).toBe('builtin.content_tags')
    expect(poem.level).toBe(2)
    expect(poem.viaParentCode).toBe('tag_lit')
    expect(prose.level).toBe(2)
    expect(prose.viaParentCode).toBe('tag_lit')
  })

  it('规则 2：无法层级化的平铺标签参与聚类，聚类后形成子维度层级节点并更新 pathCountMap', async () => {
    // 模拟作者泛维度（id: 4, code: concept('作者')），标签全是平铺在根下的
    const group: DimensionGroup = {
      id: 4,
      name: '作者',
      code: authorCode,
      level: 0,
      tags: [
        {
          dimensionId: 4,
          dimensionCode: authorCode,
          dimensionName: '作者',
          tagValue: 'UI设计师小张',
          fileCount: 2,
          level: 1,
          code: 'author_ui_zhang',
          codePath: `/${authorCode}/author_ui_zhang`,
          viaParentCode: authorCode
        },
        {
          dimensionId: 4,
          dimensionCode: authorCode,
          dimensionName: '作者',
          tagValue: '平面设计专家李四',
          fileCount: 3,
          level: 1,
          code: 'author_graphic_li',
          codePath: `/${authorCode}/author_graphic_li`,
          viaParentCode: authorCode
        },
        {
          dimensionId: 4,
          dimensionCode: authorCode,
          dimensionName: '作者',
          tagValue: '后端开发工程师王五',
          fileCount: 4,
          level: 1,
          code: 'author_dev_wang',
          codePath: `/${authorCode}/author_dev_wang`,
          viaParentCode: authorCode
        },
        {
          dimensionId: 4,
          dimensionCode: authorCode,
          dimensionName: '作者',
          tagValue: '前端开发赵六',
          fileCount: 1,
          level: 1,
          code: 'author_dev_zhao',
          codePath: `/${authorCode}/author_dev_zhao`,
          viaParentCode: authorCode
        }
      ]
    }

    const pathCountMap: Record<string, number> = {
      [`/${authorCode}/author_ui_zhang`]: 2,
      [`/${authorCode}/author_graphic_li`]: 3,
      [`/${authorCode}/author_dev_wang`]: 4,
      [`/${authorCode}/author_dev_zhao`]: 1
    }

    // 模拟 Omni 聚类服务返回两个簇
    vi.mocked(omniService.clusterDocuments).mockResolvedValue({
      success: true,
      result: {
        durationMs: 12,
        clusters: [
          {
            folderName: '设计团队',
            path: ['设计团队'],
            fingerprints: ['author_ui_zhang', 'author_graphic_li']
          },
          {
            folderName: '研发工程',
            path: ['研发工程'],
            fingerprints: ['author_dev_wang', 'author_dev_zhao']
          }
        ]
      }
    } as any)

    await context.clusterPanDimensionTags([group], pathCountMap)

    expect(omniService.clusterDocuments).toHaveBeenCalledTimes(1)
    const callArgs = vi.mocked(omniService.clusterDocuments).mock.calls[0][0]
    expect(callArgs.documents.length).toBe(4)
    expect(callArgs.documents[0].preferEmbeddingText).toBe(true)

    // 聚类后应包含：2 个聚类父节点 + 4 个已聚类成员标签
    expect(group.tags.length).toBe(6)

    const clusterParents = group.tags.filter(t => t.meta?.isClusterNode === true)
    expect(clusterParents.length).toBe(2)

    const designCluster = clusterParents.find(t => t.tagValue === '设计团队')!
    expect(designCluster).toBeDefined()
    expect(designCluster.level).toBe(1)
    expect(designCluster.viaParentCode).toBe(authorCode)
    expect(designCluster.fileCount).toBe(5) // 2 + 3

    const devCluster = clusterParents.find(t => t.tagValue === '研发工程')!
    expect(devCluster).toBeDefined()
    expect(devCluster.level).toBe(1)
    expect(devCluster.viaParentCode).toBe(authorCode)
    expect(devCluster.fileCount).toBe(5) // 4 + 1

    // 验证子标签的 viaParentCode 指向聚类父节点且 level 变为 2
    const uiZhang = group.tags.find(t => t.code === 'author_ui_zhang')!
    expect(uiZhang.level).toBe(2)
    expect(uiZhang.viaParentCode).toBe(designCluster.code)

    const devWang = group.tags.find(t => t.code === 'author_dev_wang')!
    expect(devWang.level).toBe(2)
    expect(devWang.viaParentCode).toBe(devCluster.code)

    // 验证 pathCountMap 同步登记了聚类父节点的路径计数
    expect(pathCountMap[designCluster.codePath!]).toBe(5)
    expect(pathCountMap[devCluster.codePath!]).toBe(5)

    // 验证 _omniChildrenMap 登记了聚类父节点向成员标签的邻接关系
    expect(context._omniChildrenMap.has(designCluster.code!)).toBe(true)
    const designChildren = context._omniChildrenMap.get(designCluster.code!)!
    expect(designChildren.has('author_ui_zhang')).toBe(true)
    expect(designChildren.has('author_graphic_li')).toBe(true)
  })

  it('规则 3：混合场景——已层级化标签保持原样优先展示，平铺标签聚类后作为兄弟分类并存', async () => {
    const group: DimensionGroup = {
      id: 16,
      name: '地理位置',
      code: geoCode,
      level: 0,
      tags: [
        // 已层级化结构：中国 -> [北京, 上海]
        {
          dimensionId: 16,
          dimensionCode: geoCode,
          dimensionName: '地理位置',
          tagValue: '中国',
          fileCount: 10,
          level: 1,
          code: 'geo_china',
          codePath: `/${geoCode}/geo_china`,
          viaParentCode: geoCode
        },
        {
          dimensionId: 16,
          dimensionCode: geoCode,
          dimensionName: '地理位置',
          tagValue: '北京市',
          fileCount: 6,
          level: 2,
          code: 'geo_beijing',
          codePath: `/${geoCode}/geo_china/geo_beijing`,
          viaParentCode: 'geo_china'
        },
        {
          dimensionId: 16,
          dimensionCode: geoCode,
          dimensionName: '地理位置',
          tagValue: '上海市',
          fileCount: 4,
          level: 2,
          code: 'geo_shanghai',
          codePath: `/${geoCode}/geo_china/geo_shanghai`,
          viaParentCode: 'geo_china'
        },
        // 无法层级化的平铺标签：东京、大阪、京都
        {
          dimensionId: 16,
          dimensionCode: geoCode,
          dimensionName: '地理位置',
          tagValue: '日本东京',
          fileCount: 2,
          level: 1,
          code: 'geo_tokyo',
          codePath: `/${geoCode}/geo_tokyo`,
          viaParentCode: geoCode
        },
        {
          dimensionId: 16,
          dimensionCode: geoCode,
          dimensionName: '地理位置',
          tagValue: '日本大阪',
          fileCount: 1,
          level: 1,
          code: 'geo_osaka',
          codePath: `/${geoCode}/geo_osaka`,
          viaParentCode: geoCode
        }
      ]
    }

    vi.mocked(omniService.clusterDocuments).mockResolvedValue({
      success: true,
      result: {
        durationMs: 8,
        clusters: [
          {
            folderName: '日本关西与东京都',
            path: ['日本关西与东京都'],
            fingerprints: ['geo_tokyo', 'geo_osaka']
          }
        ]
      }
    } as any)

    await context.clusterPanDimensionTags([group])

    // 已层级化的中国节点及其子节点完全保留
    const china = group.tags.find(t => t.code === 'geo_china')!
    expect(china.level).toBe(1)
    expect(china.viaParentCode).toBe(geoCode)

    const beijing = group.tags.find(t => t.code === 'geo_beijing')!
    expect(beijing.level).toBe(2)
    expect(beijing.viaParentCode).toBe('geo_china')

    // 平铺标签被聚类为新簇
    const japanCluster = group.tags.find(t => t.tagValue === '日本关西与东京都')!
    expect(japanCluster).toBeDefined()
    expect(japanCluster.level).toBe(1)
    expect(japanCluster.viaParentCode).toBe(geoCode)

    const tokyo = group.tags.find(t => t.code === 'geo_tokyo')!
    expect(tokyo.level).toBe(2)
    expect(tokyo.viaParentCode).toBe(japanCluster.code)
  })

  it('规则 4：降级保障——当 Omni 服务不可用或聚类失败时，确定性词根聚类算法平滑兜底', async () => {
    // 模拟 Omni 挂掉或抛错
    vi.mocked(omniService.clusterDocuments).mockRejectedValue(new Error('Omni engine offline'))

    const group: DimensionGroup = {
      id: 28,
      name: '内容标签',
      code: 'builtin.content_tags',
      level: 0,
      tags: [
        {
          dimensionId: 28,
          dimensionCode: 'builtin.content_tags',
          dimensionName: '内容标签',
          tagValue: 'Vue开发',
          fileCount: 3,
          level: 1,
          code: 'tag_vue',
          viaParentCode: 'builtin.content_tags'
        },
        {
          dimensionId: 28,
          dimensionCode: 'builtin.content_tags',
          dimensionName: '内容标签',
          tagValue: 'React开发',
          fileCount: 2,
          level: 1,
          code: 'tag_react',
          viaParentCode: 'builtin.content_tags'
        },
        {
          dimensionId: 28,
          dimensionCode: 'builtin.content_tags',
          dimensionName: '内容标签',
          tagValue: '摄影作品',
          fileCount: 4,
          level: 1,
          code: 'tag_photo',
          viaParentCode: 'builtin.content_tags'
        },
        {
          dimensionId: 28,
          dimensionCode: 'builtin.content_tags',
          dimensionName: '内容标签',
          tagValue: '绘画作品',
          fileCount: 1,
          level: 1,
          code: 'tag_paint',
          viaParentCode: 'builtin.content_tags'
        }
      ]
    }

    await context.clusterPanDimensionTags([group])

    // 本地 fallback 应当根据 "开发" 与 "作品" 共同词根自动聚类出簇
    const clusterNodes = group.tags.filter(t => t.meta?.isClusterNode === true)
    expect(clusterNodes.length).toBeGreaterThanOrEqual(1)

    // 至少包含 "开发" 或 "作品" 词根相关的簇
    const hasDevOrArtCluster = clusterNodes.some(
      c => c.tagValue.includes('开发') || c.tagValue.includes('作品')
    )
    expect(hasDevOrArtCluster).toBe(true)

    // 簇内成员应被降为 level: 2
    const vueTag = group.tags.find(t => t.code === 'tag_vue')!
    expect(vueTag.level).toBe(2)
  })

  it('规则 5：边界防御——非泛维度轴绝不触发聚类，孤立单个标签不创建无意义单项簇', async () => {
    // 场景 A：非泛维度（如文件类型 id: 1）
    const fileTypeGroup: DimensionGroup = {
      id: 1,
      name: '文件类型',
      code: 'builtin.file_type',
      level: 0,
      metadata: { flag: { isPanDimension: false } },
      tags: [
        {
          dimensionId: 1,
          dimensionCode: 'builtin.file_type',
          dimensionName: '文件类型',
          tagValue: 'PDF文档',
          fileCount: 5,
          level: 1,
          code: 'tag_pdf',
          viaParentCode: 'builtin.file_type'
        },
        {
          dimensionId: 1,
          dimensionCode: 'builtin.file_type',
          dimensionName: '文件类型',
          tagValue: 'Word文档',
          fileCount: 3,
          level: 1,
          code: 'tag_word',
          viaParentCode: 'builtin.file_type'
        }
      ]
    }

    await context.clusterPanDimensionTags([fileTypeGroup])
    expect(fileTypeGroup.tags.length).toBe(2)
    expect(fileTypeGroup.tags.every(t => t.level === 1)).toBe(true)

    // 场景 B：泛维度但仅有 1 个平铺标签
    const singleTagPanGroup: DimensionGroup = {
      id: 4,
      name: '作者',
      code: authorCode,
      level: 0,
      tags: [
        {
          dimensionId: 4,
          dimensionCode: authorCode,
          dimensionName: '作者',
          tagValue: '独孤求败',
          fileCount: 1,
          level: 1,
          code: 'author_lone',
          viaParentCode: authorCode
        }
      ]
    }

    await context.clusterPanDimensionTags([singleTagPanGroup])
    expect(singleTagPanGroup.tags.length).toBe(1)
    expect(singleTagPanGroup.tags[0].level).toBe(1)
  })

  it('规则 6：完整联调——聚类后的标签数据与前端 nestGroupTags 无缝联动形成多级树形结构', async () => {
    const group: DimensionGroup = {
      id: 28,
      name: '内容标签',
      code: 'builtin.content_tags',
      level: 0,
      tags: [
        {
          dimensionId: 28,
          dimensionCode: 'builtin.content_tags',
          dimensionName: '内容标签',
          tagValue: 'UI设计',
          fileCount: 4,
          level: 1,
          code: 'tag_ui',
          codePath: '/builtin.content_tags/tag_ui',
          viaParentCode: 'builtin.content_tags'
        },
        {
          dimensionId: 28,
          dimensionCode: 'builtin.content_tags',
          dimensionName: '内容标签',
          tagValue: '网页设计',
          fileCount: 2,
          level: 1,
          code: 'tag_web',
          codePath: '/builtin.content_tags/tag_web',
          viaParentCode: 'builtin.content_tags'
        }
      ]
    }

    const pathCountMap: Record<string, number> = {
      '/builtin.content_tags/tag_ui': 4,
      '/builtin.content_tags/tag_web': 2
    }

    vi.mocked(omniService.clusterDocuments).mockResolvedValue({
      success: true,
      result: {
        durationMs: 5,
        clusters: [
          {
            folderName: '设计分类',
            path: ['设计分类'],
            fingerprints: ['tag_ui', 'tag_web']
          }
        ]
      }
    } as any)

    await context.clusterPanDimensionTags([group], pathCountMap)

    // 调用前端 nestGroupTags 还原树形结构
    const nested = nestGroupTags(group, group.tags, 0, 8, pathCountMap)

    // directTags 应当只包含顶层聚类分类节点，子标签应收拢入 childTagsMap
    expect(nested.directTags.length).toBe(1)
    const directCluster = nested.directTags[0]
    expect(directCluster.tagValue).toBe('设计分类')
    expect(directCluster.fileCount).toBe(6)

    // childTagsMap 中应登记设计分类的子节点（包含两个子标签）
    const children = nested.childTagsMap.get(directCluster.code!)
    expect(children).toBeDefined()
    expect(children!.length).toBe(1)
    const subNode = children![0]
    expect(subNode.tags).toBeDefined()
    expect(subNode.tags!.length).toBe(2)
    const childNames = subNode.tags!.map(c => c.tagValue)
    expect(childNames).toContain('UI设计')
    expect(childNames).toContain('网页设计')
    // 验证子标签文件计数保真
    const uiTag = subNode.tags!.find(c => c.tagValue === 'UI设计')!
    expect(uiTag.fileCount).toBe(4)
    const webTag = subNode.tags!.find(c => c.tagValue === '网页设计')!
    expect(webTag.fileCount).toBe(2)
  })

  it('规则 7：泛维度根别名/本体码匹配——支持知网本体码 hownet.000000043396.n 与自然语言名父级判定并触发聚类', async () => {
    // 模拟作者维度中，group.code 为 authorCode (hownet.000000043396.n)，而标签的 viaParentCode 分别为 hownet 码与自然语言 '作者'
    const group: DimensionGroup = {
      id: 4,
      name: '作者',
      code: authorCode,
      level: 0,
      tags: [
        {
          dimensionId: 4,
          dimensionCode: authorCode,
          dimensionName: '作者',
          tagValue: '高级前端张三',
          fileCount: 3,
          level: 1,
          code: 'author_frontend_zhang',
          codePath: `/${authorCode}/author_frontend_zhang`,
          viaParentCode: authorCode
        },
        {
          dimensionId: 4,
          dimensionCode: authorCode,
          dimensionName: '作者',
          tagValue: '资深前端李四',
          fileCount: 2,
          level: 1,
          code: 'author_frontend_li',
          codePath: `/${authorCode}/author_frontend_li`,
          viaParentCode: '作者'
        }
      ]
    }

    vi.mocked(omniService.clusterDocuments).mockRejectedValue(new Error('Omni offline'))
    await context.clusterPanDimensionTags([group])

    // 应正确将 hownet.000000043396.n 与 '作者' 识别为根自身，两标签顺利参与本地聚类并成簇
    const clusterNodes = group.tags.filter(t => t.meta?.isClusterNode === true)
    expect(clusterNodes.length).toBe(1)
    expect(clusterNodes[0].tagValue).toBe('前端')
    expect(clusterNodes[0].fileCount).toBe(5)
    expect(group.tags.find(t => t.code === 'author_frontend_zhang')!.level).toBe(2)
  })

  it('规则 8：全员共享词根时（如两个地名均含北京），fallbackClusterTags 不被 count < tags.length 误杀', async () => {
    vi.mocked(omniService.clusterDocuments).mockRejectedValue(new Error('Omni offline'))

    const group: DimensionGroup = {
      id: 16,
      name: '地理位置',
      code: geoCode,
      level: 0,
      tags: [
        {
          dimensionId: 16,
          dimensionCode: geoCode,
          dimensionName: '地理位置',
          tagValue: '北京朝阳',
          fileCount: 4,
          level: 1,
          code: 'geo_bj_cy',
          codePath: `/${geoCode}/geo_bj_cy`,
          viaParentCode: geoCode
        },
        {
          dimensionId: 16,
          dimensionCode: geoCode,
          dimensionName: '地理位置',
          tagValue: '北京海淀',
          fileCount: 3,
          level: 1,
          code: 'geo_bj_hd',
          codePath: `/${geoCode}/geo_bj_hd`,
          viaParentCode: geoCode
        }
      ]
    }

    await context.clusterPanDimensionTags([group])

    // 两个标签共享 '北京'（count=2, tags.length=2），顺利成簇
    const clusterNodes = group.tags.filter(t => t.meta?.isClusterNode === true)
    expect(clusterNodes.length).toBe(1)
    expect(clusterNodes[0].tagValue).toBe('北京')
    expect(clusterNodes[0].fileCount).toBe(7)
    expect(clusterNodes[0].viaParentCode).toBe(geoCode)

    const cyTag = group.tags.find(t => t.code === 'geo_bj_cy')!
    expect(cyTag.level).toBe(2)
    expect(cyTag.viaParentCode).toBe(clusterNodes[0].code)
  })

  it('规则 9：多选模式（getSelectedTagsFromSet）对聚类节点与成员节点 codePaths 集合完整透传保真', async () => {
    const group: DimensionGroup = {
      id: 28,
      name: '内容标签',
      code: 'builtin.content_tags',
      level: 0,
      tags: [
        {
          dimensionId: 28,
          dimensionCode: 'builtin.content_tags',
          dimensionName: '内容标签',
          tagValue: '海报设计',
          fileCount: 3,
          level: 1,
          code: 'tag_poster',
          codePath: '/builtin.content_tags/tag_poster',
          viaParentCode: 'builtin.content_tags'
        },
        {
          dimensionId: 28,
          dimensionCode: 'builtin.content_tags',
          dimensionName: '内容标签',
          tagValue: 'LOGO设计',
          fileCount: 2,
          level: 1,
          code: 'tag_logo',
          codePath: '/builtin.content_tags/tag_logo',
          viaParentCode: 'builtin.content_tags'
        }
      ]
    }

    vi.mocked(omniService.clusterDocuments).mockRejectedValue(new Error('Omni offline'))
    await context.clusterPanDimensionTags([group])

    const clusterParent = group.tags.find(t => t.meta?.isClusterNode === true)!
    expect(clusterParent).toBeDefined()
    expect(clusterParent.codePaths).toEqual([
      '/builtin.content_tags/tag_poster',
      '/builtin.content_tags/tag_logo'
    ])

    // 模拟多选点击聚类父节点
    const parentKey = makeTagKey(
      28,
      clusterParent.tagValue,
      undefined,
      clusterParent.viaParentCode,
      false,
      clusterParent.codePath
    )
    const selectedParent = getSelectedTagsFromSet(new Set([parentKey]), [group])
    expect(selectedParent.length).toBe(1)
    // 验证多选透传 codePaths 物理路径，杜绝被 drop 为 undefined
    expect(selectedParent[0].codePaths).toEqual([
      '/builtin.content_tags/tag_poster',
      '/builtin.content_tags/tag_logo'
    ])

    // 模拟多选点击簇内成员节点
    const memberTag = group.tags.find(t => t.code === 'tag_poster')!
    const memberKey = makeTagKey(
      28,
      memberTag.tagValue,
      undefined,
      memberTag.viaParentCode,
      false,
      memberTag.codePath
    )
    const selectedMember = getSelectedTagsFromSet(new Set([memberKey]), [group])
    expect(selectedMember.length).toBe(1)
    expect(selectedMember[0].codePaths).toEqual(['/builtin.content_tags/tag_poster'])
  })

  it('规则 10：后端筛选查询器（resolveTagCodePaths）过滤虚拟合成 .cluster_ 路径并安全回退展开', () => {
    const filterContext = {
      ...tagTreeQueryFilterMixin
    }

    // 场景 A：携带有效 codePaths 的聚类父节点（单选/多选）
    const tagWithRealPaths = {
      dimensionId: 4,
      tagValue: '研发团队',
      code: `${authorCode}.cluster_dev`,
      codePath: `/${authorCode}/${authorCode}.cluster_dev`,
      codePaths: [`/${authorCode}/author_a`, `/${authorCode}/author_b`]
    }
    const resolvedA = filterContext.resolveTagCodePaths(tagWithRealPaths)
    expect(resolvedA).toEqual([`/${authorCode}/author_a`, `/${authorCode}/author_b`])

    // 场景 B：仅携带合成 codePath 的聚类父节点（无真实物理路径）
    const tagWithSyntheticOnly = {
      dimensionId: 4,
      tagValue: '研发团队',
      code: `${authorCode}.cluster_dev`,
      codePath: `/${authorCode}/${authorCode}.cluster_dev`
    }
    const resolvedB = filterContext.resolveTagCodePaths(tagWithSyntheticOnly)
    // 必须过滤掉包含 .cluster_ 的合成路径，返回空数组以便 buildTagFilterSubClause 回退 resolveFilterTagCodes
    expect(resolvedB).toEqual([])
  })

  it('规则 11：标签树是通过 code_path 建立的（源自 parentCodes）——code_path 携带深层路径的标签不被误聚类，且前端 nestGroupTags 按 code_path 正确建树', async () => {
    // 模拟内容标签泛维度（id: 28, code: builtin.content_tags）
    // 存在由 code_path 建立的父子层级关系，即便 viaParentCode 缺省或回退至根节点
    const parentTag: DimensionTag = {
      dimensionId: 28,
      dimensionCode: 'builtin.content_tags',
      dimensionName: '内容标签',
      tagValue: '文学艺术',
      fileCount: 6,
      level: 1,
      code: 'tag_literature',
      codePath: '/builtin.content_tags/tag_literature',
      viaParentCode: 'builtin.content_tags'
    }

    const childTag: DimensionTag = {
      dimensionId: 28,
      dimensionCode: 'builtin.content_tags',
      dimensionName: '内容标签',
      tagValue: '古典诗词',
      fileCount: 4,
      level: 1, // 模拟未显式标深 level 的场景，但 codePath 携带深层结构
      code: 'tag_poetry',
      codePath: '/builtin.content_tags/tag_literature/tag_poetry',
      viaParentCode: undefined // 模拟 viaParentCode 缺省，依赖 codePath 建树
    }

    const flatTagA: DimensionTag = {
      dimensionId: 28,
      dimensionCode: 'builtin.content_tags',
      dimensionName: '内容标签',
      tagValue: '动漫壁纸A',
      fileCount: 2,
      level: 1,
      code: 'tag_anime_a',
      codePath: '/builtin.content_tags/tag_anime_a',
      viaParentCode: 'builtin.content_tags'
    }

    const flatTagB: DimensionTag = {
      dimensionId: 28,
      dimensionCode: 'builtin.content_tags',
      dimensionName: '内容标签',
      tagValue: '动漫壁纸B',
      fileCount: 3,
      level: 1,
      code: 'tag_anime_b',
      codePath: '/builtin.content_tags/tag_anime_b',
      viaParentCode: 'builtin.content_tags'
    }

    const group: DimensionGroup = {
      id: 28,
      name: '内容标签',
      code: 'builtin.content_tags',
      level: 0,
      tags: [parentTag, childTag, flatTagA, flatTagB]
    }

    // 1. 测试 clusterPanDimensionTags：应正确基于 code_path 识别 tag_literature 与 tag_poetry 属于已有层级树，不参与聚类；仅 flatTagA 与 flatTagB 聚类
    vi.mocked(omniService.clusterDocuments).mockRejectedValue(new Error('Omni offline'))
    await context.clusterPanDimensionTags([group])

    // tag_literature 与 tag_poetry 完好保留原有结构
    const lit = group.tags.find(t => t.code === 'tag_literature')!
    const poem = group.tags.find(t => t.code === 'tag_poetry')!
    expect(lit).toBeDefined()
    expect(poem).toBeDefined()
    expect(poem.codePath).toBe('/builtin.content_tags/tag_literature/tag_poetry')

    // flatTagA 与 flatTagB 被聚类为动漫壁纸簇
    const animeCluster = group.tags.find(t => t.meta?.isClusterNode === true)
    expect(animeCluster).toBeDefined()
    expect(animeCluster!.tagValue).toBe('动漫壁纸')

    // 2. 测试前端 nestGroupTags：通过 code_path 成功还原树形结构
    const nested = nestGroupTags(group, group.tags, 0)
    // 直属顶层标签应包含：文学艺术 (tag_literature) 与 聚类父节点 (动漫壁纸)
    const directCodes = nested.directTags.map(t => t.code)
    expect(directCodes).toContain('tag_literature')
    expect(directCodes).toContain(animeCluster!.code)
    // 古典诗词 (tag_poetry) 不应出现在 directTags 顶层（已被 code_path 深度识别为深层子孙）
    expect(directCodes).not.toContain('tag_poetry')

    // 在 childTagsMap 中，文学艺术节点下必须挂载古典诗词
    const litChildren =
      nested.childTagsMap.get('tag_literature') || nested.childTagsMap.get('文学艺术')
    expect(litChildren).toBeDefined()
    expect(litChildren!.length).toBe(1)
    const litSubNode = litChildren![0]
    expect(litSubNode.tags).toBeDefined()
    expect(litSubNode.tags!.some(c => c.tagValue === '古典诗词')).toBe(true)
  })

  it('规则 12：标签树的本体来源是 parentCodes——即便 codePath 扁平，携带有效 parentCodes 的标签也不会被误聚类且在前端正确建树', async () => {
    // 模拟作者维度（id: 4, code: authorCode 即 hownet.000000043396.n）
    // 存在由 parentCodes 声明的师承/流派父子层级关系，但此时 codePath 尚未展开（如新打标或平铺格式）
    const masterTag: DimensionTag = {
      dimensionId: 4,
      dimensionCode: authorCode,
      dimensionName: '作者',
      tagValue: '鲁迅研究会',
      fileCount: 8,
      level: 1,
      code: 'author_luxun_master',
      codePath: `/${authorCode}/author_luxun_master`,
      viaParentCode: authorCode,
      parentCodes: [authorCode]
    }

    const discipleTag: DimensionTag = {
      dimensionId: 4,
      dimensionCode: authorCode,
      dimensionName: '作者',
      tagValue: '周建人随笔',
      fileCount: 4,
      level: 1, // 模拟扁平 level，但 parentCodes 指向鲁迅研究会
      code: 'author_zhoujianren',
      codePath: `/${authorCode}/author_zhoujianren`, // 平铺 codePath (length === 2)
      viaParentCode: undefined,
      parentCodes: ['author_luxun_master'] // 源头来自于 parentCodes
    }

    const flatAuthorA: DimensionTag = {
      dimensionId: 4,
      dimensionCode: authorCode,
      dimensionName: '作者',
      tagValue: '现代诗歌甲',
      fileCount: 2,
      level: 1,
      code: 'author_poet_a',
      codePath: `/${authorCode}/author_poet_a`,
      viaParentCode: authorCode,
      parentCodes: [authorCode]
    }

    const flatAuthorB: DimensionTag = {
      dimensionId: 4,
      dimensionCode: authorCode,
      dimensionName: '作者',
      tagValue: '现代诗歌乙',
      fileCount: 3,
      level: 1,
      code: 'author_poet_b',
      codePath: `/${authorCode}/author_poet_b`,
      viaParentCode: authorCode,
      parentCodes: [authorCode]
    }

    const group: DimensionGroup = {
      id: 4,
      name: '作者',
      code: authorCode,
      level: 0,
      tags: [masterTag, discipleTag, flatAuthorA, flatAuthorB]
    }

    // 1. 测试聚类：discipleTag 依靠 parentCodes 识别为已有层级，零误聚类；flatAuthorA 与 flatAuthorB 参与聚类
    vi.mocked(omniService.clusterDocuments).mockRejectedValue(new Error('Omni offline'))
    await context.clusterPanDimensionTags([group])

    const master = group.tags.find(t => t.code === 'author_luxun_master')!
    const disciple = group.tags.find(t => t.code === 'author_zhoujianren')!
    expect(master).toBeDefined()
    expect(disciple).toBeDefined()
    // 验证弟子标签未被误放入聚类簇，保留原有独立身份
    expect(disciple.viaParentCode).toBeUndefined()
    expect(disciple.parentCodes).toEqual(['author_luxun_master'])

    // 验证聚类生成的 clusterCode 严禁包含 dim. 伪码，必须采用 authorCode 规范前缀
    const poetCluster = group.tags.find(t => t.meta?.isClusterNode === true)
    expect(poetCluster).toBeDefined()
    expect(poetCluster!.code).toContain(authorCode)
    expect(poetCluster!.code).not.toContain('dim.')
    expect(poetCluster!.codePath).toContain(`/${authorCode}/`)
    expect(poetCluster!.codePath).not.toContain('/dim.')

    // 2. 测试前端建树：nestGroupTags 依靠 parentCodes 成功将 disciple 挂在 master 下
    const nested = nestGroupTags(group, group.tags, 0)
    const directCodes = nested.directTags.map(t => t.code)
    // 鲁迅研究会与诗歌聚类父节点为顶层直属
    expect(directCodes).toContain('author_luxun_master')
    expect(directCodes).toContain(poetCluster!.code)
    // 周建人随笔绝不作为直属顶层标签泄漏
    expect(directCodes).not.toContain('author_zhoujianren')

    // 在 childTagsMap 中，鲁迅研究会下正确挂载周建人随笔
    const masterChildren =
      nested.childTagsMap.get('author_luxun_master') || nested.childTagsMap.get('鲁迅研究会')
    expect(masterChildren).toBeDefined()
    expect(masterChildren!.length).toBe(1)
    const subNode = masterChildren![0]
    expect(subNode.tags!.some(c => c.tagValue === '周建人随笔')).toBe(true)
  })

  it('规则 13：彻底拔除伪码 builtin.author，作者维度全系统标准受控码恒为知网权威码 concept("作者")', () => {
    expect(authorCode).toBe('hownet.000000043396.n')
    expect(authorCode).not.toBe('builtin.author')
    expect(authorCode.startsWith('hownet.')).toBe(true)

    // 严密校验资源文件与字典表，0 处活动 builtin.author 残留
    const canonicalPath = path.resolve(
      __dirname,
      '../../../../../../pro/packages/shared/resources/canonical-concept-names.json'
    )
    if (fs.existsSync(canonicalPath)) {
      const canonicalContent = fs.readFileSync(canonicalPath, 'utf-8')
      expect(canonicalContent).not.toContain('"builtin.author":')
    }

    const identityPath = path.resolve(
      __dirname,
      '../../../../../../build/presetResources/taxonomy/builtin-tag-identity.json'
    )
    if (fs.existsSync(identityPath)) {
      const identityContent = fs.readFileSync(identityPath, 'utf-8')
      expect(identityContent).not.toContain('"builtin.author"')
    }

    const historyMapPath = path.resolve(
      __dirname,
      '../../../../../../build/presetResources/taxonomy/historical-tag-code-map.json'
    )
    if (fs.existsSync(historyMapPath)) {
      const historyMap = JSON.parse(fs.readFileSync(historyMapPath, 'utf-8'))
      expect(historyMap['dim.4']).toBe('hownet.000000043396.n')
      expect(historyMap['dim.Author']).toBe('hownet.000000043396.n')
      expect(historyMap['dim.作者']).toBe('hownet.000000043396.n')
      for (const [_, targetCode] of Object.entries(historyMap)) {
        expect(targetCode).not.toBe('builtin.author')
      }
    }
  })

  it('规则 14：当 viaParentCode 指向组内父标签而 parentCodes 缺省时，标签不泄漏为顶层直属且不被重复显示', () => {
    const parentTag: DimensionTag = {
      dimensionId: 4,
      dimensionCode: authorCode,
      dimensionName: '作者',
      tagValue: '古典流派',
      fileCount: 10,
      level: 1,
      code: 'author_classical',
      codePath: `/${authorCode}/author_classical`,
      viaParentCode: authorCode
    }

    const childTag: DimensionTag = {
      dimensionId: 4,
      dimensionCode: authorCode,
      dimensionName: '作者',
      tagValue: '李白诗集',
      fileCount: 5,
      level: 1, // 模拟未设置深层 level
      code: 'author_libai',
      codePath: `/${authorCode}/author_libai`, // 模拟平铺单段路径
      viaParentCode: 'author_classical', // 指向组内父节点
      parentCodes: undefined // parentCodes 缺省
    }

    const group: DimensionGroup = {
      id: 4,
      name: '作者',
      code: authorCode,
      level: 0,
      tags: [parentTag, childTag]
    }

    const nested = nestGroupTags(group, group.tags, 0)
    // 顶层直属只能有 古典流派，绝不能包含 李白诗集
    expect(nested.directTags.map(t => t.code)).toEqual(['author_classical'])

    // 子树中 古典流派 下挂载 李白诗集
    const children = nested.childTagsMap.get('author_classical')
    expect(children).toBeDefined()
    expect(children!.length).toBe(1)
    expect(children![0].tags!.some(t => t.code === 'author_libai')).toBe(true)
  })

  it('规则 15：code_path 含有组内不存在的中间 synset 跃迁跳级时，正确沿祖先链反查组内父节点并保留树拓扑', () => {
    const rootTag: DimensionTag = {
      dimensionId: 28,
      dimensionCode: 'builtin.content_tags',
      dimensionName: '内容标签',
      tagValue: '游戏开发',
      fileCount: 15,
      level: 1,
      code: 'omw.gamedev',
      codePath: '/builtin.content_tags/omw.gamedev',
      viaParentCode: 'builtin.content_tags'
    }

    // 假设中间层 omw.intermediate_category 并不作为独立节点出现在 group.tags 中
    const deepLeafTag: DimensionTag = {
      dimensionId: 28,
      dimensionCode: 'builtin.content_tags',
      dimensionName: '内容标签',
      tagValue: '着色器编写',
      fileCount: 7,
      level: 3,
      code: 'omw.shader',
      codePath: '/builtin.content_tags/omw.gamedev/omw.intermediate_category/omw.shader',
      viaParentCode: 'omw.intermediate_category',
      parentCodes: ['omw.intermediate_category', 'omw.gamedev']
    }

    const group: DimensionGroup = {
      id: 28,
      name: '内容标签',
      code: 'builtin.content_tags',
      level: 0,
      tags: [rootTag, deepLeafTag]
    }

    const nested = nestGroupTags(group, group.tags, 0)
    // 顶层直属只有 游戏开发
    expect(nested.directTags.map(t => t.code)).toEqual(['omw.gamedev'])

    // 着色器编写 成功跨越组内缺失的 omw.intermediate_category，精准挂载到最近的组内祖先 游戏开发 下
    const children = nested.childTagsMap.get('omw.gamedev')
    expect(children).toBeDefined()
    expect(children!.length).toBe(1)
    expect(children![0].tags!.some(t => t.code === 'omw.shader')).toBe(true)
  })

  it('规则 16：父节点仅有 tagValue 无 code 时，子标签沿 codePath 跃迁反查能通过 tagByName 命中父节点', () => {
    const parentTagNoCode: DimensionTag = {
      dimensionId: 4,
      dimensionCode: authorCode,
      dimensionName: '作者',
      tagValue: '现代文人',
      fileCount: 12,
      level: 1,
      code: undefined, // 未设置受控码
      codePath: `/${authorCode}/现代文人`,
      viaParentCode: authorCode
    }

    const childTag: DimensionTag = {
      dimensionId: 4,
      dimensionCode: authorCode,
      dimensionName: '作者',
      tagValue: '野草散文',
      fileCount: 3,
      level: 3,
      code: 'author_yecao',
      // codePath 含有不存在于组内的中间分类 '散文诗集'，沿祖先反查 '现代文人'
      codePath: `/${authorCode}/现代文人/散文诗集/author_yecao`,
      viaParentCode: undefined
    }

    const group: DimensionGroup = {
      id: 4,
      name: '作者',
      code: authorCode,
      level: 0,
      tags: [parentTagNoCode, childTag]
    }

    const nested = nestGroupTags(group, group.tags, 0)
    expect(nested.directTags.map(t => t.tagValue)).toEqual(['现代文人'])
    const children = nested.childTagsMap.get('现代文人')
    expect(children).toBeDefined()
    expect(children!.length).toBe(1)
    expect(children![0].tags!.some(t => t.tagValue === '野草散文')).toBe(true)
  })

  it('规则 17：标签仅有 codePaths 数组而 codePath 为空时，正确识别深层子孙并不泄漏在顶层', () => {
    const parentTag: DimensionTag = {
      dimensionId: 28,
      dimensionCode: 'builtin.content_tags',
      dimensionName: '内容标签',
      tagValue: '前端框架',
      fileCount: 20,
      level: 1,
      code: 'tag_frontend',
      codePath: '/builtin.content_tags/tag_frontend',
      viaParentCode: 'builtin.content_tags'
    }

    const childTag: DimensionTag = {
      dimensionId: 28,
      dimensionCode: 'builtin.content_tags',
      dimensionName: '内容标签',
      tagValue: 'React生态',
      fileCount: 8,
      level: 2,
      code: 'tag_react',
      codePath: undefined,
      codePaths: ['/builtin.content_tags/tag_frontend/tag_react'],
      viaParentCode: undefined
    }

    const group: DimensionGroup = {
      id: 28,
      name: '内容标签',
      code: 'builtin.content_tags',
      level: 0,
      tags: [parentTag, childTag]
    }

    const nested = nestGroupTags(group, group.tags, 0)
    expect(nested.directTags.map(t => t.code)).toEqual(['tag_frontend'])
    const children = nested.childTagsMap.get('tag_frontend')
    expect(children).toBeDefined()
    expect(children![0].tags!.some(t => t.code === 'tag_react')).toBe(true)
  })

  it('规则 18：当标签携带明确的组内 viaParentCode 时，严禁受其多个本体 parentCodes 干扰产生多亲跨分支串扰', () => {
    const parentA: DimensionTag = {
      dimensionId: 4,
      dimensionCode: authorCode,
      dimensionName: '作者',
      tagValue: '浪漫主义流派',
      fileCount: 15,
      level: 1,
      code: 'author_romanticism',
      codePath: `/${authorCode}/author_romanticism`,
      viaParentCode: authorCode
    }

    const parentB: DimensionTag = {
      dimensionId: 4,
      dimensionCode: authorCode,
      dimensionName: '作者',
      tagValue: '现实主义流派',
      fileCount: 18,
      level: 1,
      code: 'author_realism',
      codePath: `/${authorCode}/author_realism`,
      viaParentCode: authorCode
    }

    // 雨果既属于浪漫主义也属于现实主义，但本次实例明确通过 viaParentCode 锁定了浪漫主义
    const hugoTag: DimensionTag = {
      dimensionId: 4,
      dimensionCode: authorCode,
      dimensionName: '作者',
      tagValue: '雨果作品',
      fileCount: 6,
      level: 2,
      code: 'author_hugo',
      viaParentCode: 'author_romanticism',
      parentCodes: ['author_realism', 'author_romanticism'] // 多亲声明
    }

    const group: DimensionGroup = {
      id: 4,
      name: '作者',
      code: authorCode,
      level: 0,
      tags: [parentA, parentB, hugoTag]
    }

    const nested = nestGroupTags(group, group.tags, 0)
    // 顶层只能是 parentA 和 parentB
    expect(nested.directTags.map(t => t.code).sort()).toEqual([
      'author_realism',
      'author_romanticism'
    ])

    // 雨果只能挂载在浪漫主义下，严禁多挂载到现实主义下
    const romanticChildren = nested.childTagsMap.get('author_romanticism')
    expect(romanticChildren).toBeDefined()
    expect(romanticChildren![0].tags!.some(t => t.code === 'author_hugo')).toBe(true)

    const realismChildren = nested.childTagsMap.get('author_realism')
    if (realismChildren) {
      expect(realismChildren[0].tags!.some(t => t.code === 'author_hugo')).toBe(false)
    }
  })

  it('规则 19：直属子标签 viaParentCode 为 group.name (如 "作者") 时，正确判定为 level 1 直属标签且不孤儿断联', () => {
    const directTagViaName: DimensionTag = {
      dimensionId: 4,
      dimensionCode: authorCode,
      dimensionName: '作者',
      tagValue: '莫言文集',
      fileCount: 7,
      code: 'author_moyan',
      viaParentCode: '作者' // 指向组名称而非受控码
    }

    const group: DimensionGroup = {
      id: 4,
      name: '作者',
      code: authorCode,
      level: 0,
      tags: [directTagViaName]
    }

    const nested = nestGroupTags(group, group.tags, 0)
    expect(nested.directTags.map(t => t.code)).toEqual(['author_moyan'])
  })

  it('规则 20：tagTreeQuery 同步更新 _omniChildrenMap 时，支持通过 parentCodes 与 codePath 注入父子穿透边', async () => {
    const parentTag: DimensionTag = {
      dimensionId: 28,
      dimensionCode: 'builtin.content_tags',
      dimensionName: '内容标签',
      tagValue: '人工智能',
      fileCount: 25,
      level: 1,
      code: 'tag_ai',
      codePath: '/builtin.content_tags/tag_ai',
      viaParentCode: 'builtin.content_tags'
    }

    const childByParentCodes: DimensionTag = {
      dimensionId: 28,
      dimensionCode: 'builtin.content_tags',
      dimensionName: '内容标签',
      tagValue: '深度学习',
      fileCount: 14,
      level: 2,
      code: 'tag_dl',
      codePath: '/builtin.content_tags/tag_dl',
      viaParentCode: undefined, // viaParentCode 缺省
      parentCodes: ['tag_ai']
    }

    const group: DimensionGroup = {
      id: 28,
      name: '内容标签',
      code: 'builtin.content_tags',
      level: 0,
      tags: [parentTag, childByParentCodes]
    }

    // 模拟 tag-tree-query-dimension-tree 中的邻接注入逻辑
    const codeToName = new Map<string, string>()
    for (const t of group.tags) {
      if (t.code && t.tagValue) codeToName.set(t.code, t.tagValue)
    }
    const omniChildrenMap = new Map<string, Set<string>>()
    for (const t of group.tags) {
      if (!t.code) continue
      const parentKeysSet = new Set<string>()
      if (
        t.viaParentCode &&
        t.viaParentCode !== t.code &&
        t.viaParentCode !== 'builtin.content_tags'
      ) {
        parentKeysSet.add(t.viaParentCode)
        const pName = codeToName.get(t.viaParentCode)
        if (pName) parentKeysSet.add(pName)
      }
      if (Array.isArray(t.parentCodes)) {
        for (const pc of t.parentCodes) {
          if (pc && pc !== t.code && pc !== 'builtin.content_tags') {
            parentKeysSet.add(pc)
            const pName = codeToName.get(pc)
            if (pName) parentKeysSet.add(pName)
          }
        }
      }
      for (const pk of parentKeysSet) {
        if (!omniChildrenMap.has(pk)) omniChildrenMap.set(pk, new Set())
        omniChildrenMap.get(pk)!.add(t.code)
        if (t.tagValue) omniChildrenMap.get(pk)!.add(t.tagValue)
      }
    }

    expect(omniChildrenMap.has('tag_ai')).toBe(true)
    expect(omniChildrenMap.get('tag_ai')!.has('tag_dl')).toBe(true)
    expect(omniChildrenMap.get('tag_ai')!.has('深度学习')).toBe(true)
    expect(omniChildrenMap.has('人工智能')).toBe(true)
    expect(omniChildrenMap.get('人工智能')!.has('tag_dl')).toBe(true)
  })

  it('规则 21：冷启动/离线兜底守护：当 omniService.isReady() 为 false 时，不阻塞等待冷启动，直接极速降级到本地确定性聚类 fallbackClusterTags (<5ms)，且不调用 omniService.clusterDocuments', async () => {
    // 模拟 Omni 未就绪态 (例如正在冷启动或不可用)
    vi.mocked(omniService.isReady).mockReturnValueOnce(false)

    const group: DimensionGroup = {
      id: 4,
      name: '作者',
      code: authorCode,
      level: 0,
      tags: [
        {
          dimensionId: 4,
          dimensionCode: authorCode,
          dimensionName: '作者',
          tagValue: 'UI设计小白',
          fileCount: 2,
          level: 1,
          code: 'author_ui_novice',
          viaParentCode: authorCode
        },
        {
          dimensionId: 4,
          dimensionCode: authorCode,
          dimensionName: '作者',
          tagValue: 'UI设计大师',
          fileCount: 3,
          level: 1,
          code: 'author_ui_master',
          viaParentCode: authorCode
        },
        {
          dimensionId: 4,
          dimensionCode: authorCode,
          dimensionName: '作者',
          tagValue: 'Python爬虫高手',
          fileCount: 5,
          level: 1,
          code: 'author_py_pro',
          viaParentCode: authorCode
        },
        {
          dimensionId: 4,
          dimensionCode: authorCode,
          dimensionName: '作者',
          tagValue: 'Python数据分析师',
          fileCount: 4,
          level: 1,
          code: 'author_py_analyst',
          viaParentCode: authorCode
        }
      ]
    }

    const start = Date.now()
    await context.clusterPanDimensionTags([group])
    const elapsed = Date.now() - start

    // 严禁调用 omniService.clusterDocuments，严禁被冷启动阻塞
    expect(omniService.clusterDocuments).not.toHaveBeenCalled()
    // 确定性本地聚类毫秒级极速完成 (<100ms)
    expect(elapsed).toBeLessThan(100)

    // 标签应按本地公共前缀/词根聚类形成聚类节点
    const clusterNodes = group.tags.filter(t => t.meta?.isClusterNode === true)
    expect(clusterNodes.length).toBeGreaterThan(0)
    // 成员标签挂载到了聚类节点下
    const memberTags = group.tags.filter(t => t.level === 2)
    expect(memberTags.length).toBe(4)
  })

  it('规则 22：内存指纹缓存：相同标签组二次请求命中指纹缓存，避免重复计算', async () => {
    // 模拟 Omni 已就绪，但只在第一次调用时被调用一次
    vi.mocked(omniService.isReady).mockReturnValue(true)
    vi.mocked(omniService.clusterDocuments).mockResolvedValueOnce({
      success: true,
      result: {
        clusters: [
          {
            clusterId: 1,
            fingerprints: ['author_cached_a', 'author_cached_b'],
            folderName: '测试缓存分类'
          }
        ]
      }
    } as any)

    const makeGroup = (): DimensionGroup => ({
      id: 4,
      name: '作者',
      code: authorCode,
      level: 0,
      tags: [
        {
          dimensionId: 4,
          dimensionCode: authorCode,
          dimensionName: '作者',
          tagValue: '前端专家甲',
          fileCount: 2,
          level: 1,
          code: 'author_cached_a',
          viaParentCode: authorCode
        },
        {
          dimensionId: 4,
          dimensionCode: authorCode,
          dimensionName: '作者',
          tagValue: '前端专家乙',
          fileCount: 3,
          level: 1,
          code: 'author_cached_b',
          viaParentCode: authorCode
        }
      ]
    })

    const group1 = makeGroup()
    await context.clusterPanDimensionTags([group1])
    expect(omniService.clusterDocuments).toHaveBeenCalledTimes(1)

    // 第二次调用相同的标签与数量，直接命中指纹缓存
    const group2 = makeGroup()
    await context.clusterPanDimensionTags([group2])
    // clusterDocuments 没有被再次调用，次数仍为 1
    expect(omniService.clusterDocuments).toHaveBeenCalledTimes(1)
    const clusterNodes = group2.tags.filter(t => t.meta?.isClusterNode === true)
    expect(clusterNodes.length).toBe(1)
    expect(clusterNodes[0].tagValue).toBe('测试缓存分类')
  })

  it('规则 23：前端刻度深度联动 (maxScaleDepth)：maxScaleDepth <= 2 时聚类节点透明穿透溶解直接平铺成员标签；maxScaleDepth >= 3 时聚类节点折叠成目录', () => {
    const clusterParent: DimensionTag = {
      dimensionId: 4,
      dimensionCode: authorCode,
      dimensionName: '作者',
      tagValue: 'UI设计',
      fileCount: 5,
      level: 1,
      code: `${authorCode}.cluster_uidesign`,
      codePath: `/${authorCode}/${authorCode}.cluster_uidesign`,
      viaParentCode: authorCode,
      meta: {
        isClusterNode: true
      }
    }

    const member1: DimensionTag = {
      dimensionId: 4,
      dimensionCode: authorCode,
      dimensionName: '作者',
      tagValue: 'UI小张',
      fileCount: 2,
      level: 2,
      code: 'author_ui_zhang',
      codePath: `/${authorCode}/${authorCode}.cluster_uidesign/author_ui_zhang`,
      viaParentCode: `${authorCode}.cluster_uidesign`
    }

    const member2: DimensionTag = {
      dimensionId: 4,
      dimensionCode: authorCode,
      dimensionName: '作者',
      tagValue: 'UI李四',
      fileCount: 3,
      level: 2,
      code: 'author_ui_li',
      codePath: `/${authorCode}/${authorCode}.cluster_uidesign/author_ui_li`,
      viaParentCode: `${authorCode}.cluster_uidesign`
    }

    const group: DimensionGroup = {
      id: 4,
      name: '作者',
      code: authorCode,
      level: 0,
      tags: [clusterParent, member1, member2]
    }

    // 场景 A: 用户设置刻度 depth = 2 (扁平化展示)，聚类父节点透明穿透溶解，仅展示 UI小张、UI李四
    const flatResult = nestGroupTags(group, group.tags, 0, 2)
    // 顶层直属标签中不包含聚类虚拟文件夹，且直接平铺两个原子标签
    expect(flatResult.directTags.some(t => t.meta?.isClusterNode)).toBe(false)
    expect(flatResult.directTags.map(t => t.tagValue).sort()).toEqual(['UI小张', 'UI李四'])
    // 扁平模式下无子树折叠
    expect(flatResult.childTagsMap.size).toBe(0)

    // 场景 B: 用户设置刻度 depth = 3 (层级化展示)，聚类父节点作为 level 1 折叠目录，原子标签挂在其子树下
    const hierarchicalResult = nestGroupTags(group, group.tags, 0, 3)
    expect(hierarchicalResult.directTags.length).toBe(1)
    expect(hierarchicalResult.directTags[0].tagValue).toBe('UI设计')
    expect(hierarchicalResult.directTags[0].code).toBe(`${authorCode}.cluster_uidesign`)
    // 子树 childTagsMap 中挂载了其两个子标签
    const children = hierarchicalResult.childTagsMap.get(`${authorCode}.cluster_uidesign`)
    expect(children).toBeDefined()
    expect(children![0].tags!.map(t => t.tagValue).sort()).toEqual(['UI小张', 'UI李四'])
  })

  it('规则 24：边界防御——平铺标签全为单字或无任何公共字符时，本地词根聚类安全兜底，不创建无意义单元素簇，保持原标签平铺展示且不报错', async () => {
    vi.mocked(omniService.isReady).mockReturnValueOnce(false)

    const group: DimensionGroup = {
      id: 4,
      name: '作者',
      code: authorCode,
      level: 0,
      tags: [
        {
          dimensionId: 4,
          dimensionCode: authorCode,
          dimensionName: '作者',
          tagValue: '张',
          fileCount: 1,
          level: 1,
          code: 'author_zhang',
          viaParentCode: authorCode
        },
        {
          dimensionId: 4,
          dimensionCode: authorCode,
          dimensionName: '作者',
          tagValue: '李',
          fileCount: 2,
          level: 1,
          code: 'author_li',
          viaParentCode: authorCode
        },
        {
          dimensionId: 4,
          dimensionCode: authorCode,
          dimensionName: '作者',
          tagValue: 'Alice',
          fileCount: 3,
          level: 1,
          code: 'author_alice',
          viaParentCode: authorCode
        },
        {
          dimensionId: 4,
          dimensionCode: authorCode,
          dimensionName: '作者',
          tagValue: 'Bob',
          fileCount: 4,
          level: 1,
          code: 'author_bob',
          viaParentCode: authorCode
        }
      ]
    }

    await context.clusterPanDimensionTags([group])

    // 无公共词根时，没有任何虚拟聚类父节点生成
    const clusterNodes = group.tags.filter(t => t.meta?.isClusterNode === true)
    expect(clusterNodes.length).toBe(0)
    // 所有标签保持原有平铺层级展示，绝不丢失数据
    expect(group.tags.length).toBe(4)
    expect(group.tags.every(t => t.level === 1)).toBe(true)
  })

  it('规则 25：高维跨刻度自愈恢复——多选模式下快速切换 maxScaleDepth（从 2 滑到 5 再滑回 2），被选中的聚类子标签键值在 migrateTagKeysAcrossScale 能够 100% 精确映射', () => {
    const clusterParent: DimensionTag = {
      dimensionId: 4,
      dimensionCode: authorCode,
      dimensionName: '作者',
      tagValue: 'UI设计',
      fileCount: 5,
      level: 1,
      code: `${authorCode}.cluster_uidesign`,
      codePath: `/${authorCode}/${authorCode}.cluster_uidesign`,
      viaParentCode: authorCode,
      meta: { isClusterNode: true }
    }
    const member1: DimensionTag = {
      dimensionId: 4,
      dimensionCode: authorCode,
      dimensionName: '作者',
      tagValue: 'UI小张',
      fileCount: 2,
      level: 2,
      code: 'author_ui_zhang',
      codePath: `/${authorCode}/${authorCode}.cluster_uidesign/author_ui_zhang`,
      viaParentCode: `${authorCode}.cluster_uidesign`
    }
    const member2: DimensionTag = {
      dimensionId: 4,
      dimensionCode: authorCode,
      dimensionName: '作者',
      tagValue: 'UI李四',
      fileCount: 3,
      level: 2,
      code: 'author_ui_li',
      codePath: `/${authorCode}/${authorCode}.cluster_uidesign/author_ui_li`,
      viaParentCode: `${authorCode}.cluster_uidesign`
    }
    const group: DimensionGroup = {
      id: 4,
      name: '作者',
      code: authorCode,
      level: 0,
      tags: [clusterParent, member1, member2]
    }

    // 1. 在 depth = 5 时构建可见树
    const visibleScale5 = buildDimensionTree([group], null, null, 0, 5)
    // 选中 UI小张
    const keyAtScale5 = makeTagKey(
      4,
      'UI小张',
      undefined,
      `${authorCode}.cluster_uidesign`,
      false,
      `/${authorCode}/${authorCode}.cluster_uidesign/author_ui_zhang`
    )
    const prevSelected = new Set([keyAtScale5])
    const prevStack = [keyAtScale5]

    // 2. 模拟用户将滑块滑动至 depth = 2
    const visibleScale2 = buildDimensionTree([group], null, null, 0, 2)
    const migResultTo2 = migrateTagKeysAcrossScale({
      prevSelected,
      prevStack,
      prevParentMap: new Map([[keyAtScale5, ['作者', 'UI设计', 'UI小张']]]),
      currentVisibleGroups: visibleScale2,
      masterDimensionGroups: [group]
    })

    expect(migResultTo2.migratedSelected.size).toBe(1)
    const keyAtScale2 = Array.from(migResultTo2.migratedSelected)[0]
    expect(keyAtScale2).toContain('liftCode:')
    expect(keyAtScale2).toContain('UI小张')

    // 3. 模拟用户将滑块再次滑回 depth = 5
    const migResultBackTo5 = migrateTagKeysAcrossScale({
      prevSelected: migResultTo2.migratedSelected,
      prevStack: migResultTo2.migratedStack,
      prevParentMap: migResultTo2.migratedParentMap,
      currentVisibleGroups: visibleScale5,
      masterDimensionGroups: [group]
    })

    expect(migResultBackTo5.migratedSelected.size).toBe(1)
    expect(migResultBackTo5.migratedSelected.has(keyAtScale5)).toBe(true)
  })

  it('规则 26：Omni 快速通道 _omniChildrenMap 自愈：当 context._omniChildrenMap 初始为 null 时，clusterSinglePanDimensionGroup 自动初始化 Map 并注册聚类穿透边', async () => {
    context._omniChildrenMap = null

    const group: DimensionGroup = {
      id: 4,
      name: '作者',
      code: authorCode,
      level: 0,
      tags: [
        {
          dimensionId: 4,
          dimensionCode: authorCode,
          dimensionName: '作者',
          tagValue: '前端张三',
          fileCount: 2,
          level: 1,
          code: 'author_fe_zhang',
          viaParentCode: authorCode
        },
        {
          dimensionId: 4,
          dimensionCode: authorCode,
          dimensionName: '作者',
          tagValue: '前端李四',
          fileCount: 3,
          level: 1,
          code: 'author_fe_li',
          viaParentCode: authorCode
        }
      ]
    }

    await context.clusterSinglePanDimensionGroup(group)

    // _omniChildrenMap 被自动初始化且非空
    expect(context._omniChildrenMap).not.toBeNull()
    const clusterParent = group.tags.find(t => t.meta?.isClusterNode === true)
    expect(clusterParent).toBeDefined()
    expect(context._omniChildrenMap.has(clusterParent!.code!)).toBe(true)
    const childrenSet = context._omniChildrenMap.get(clusterParent!.code!)!
    expect(childrenSet.has('author_fe_zhang')).toBe(true)
    expect(childrenSet.has('author_fe_li')).toBe(true)
  })

  it('规则 27：渐进式质量自愈：当首次离线落入 fallbackClusterTags 缓存后，Omni 服务就绪后重新查询能够突破降级缓存升级为 Omni HAC 聚类', async () => {
    // 第一次：Omni 未就绪，落入本地词根降级缓存
    vi.mocked(omniService.isReady).mockReturnValue(false)

    const makeGroup = (): DimensionGroup => ({
      id: 4,
      name: '作者',
      code: authorCode,
      level: 0,
      tags: [
        {
          dimensionId: 4,
          dimensionCode: authorCode,
          dimensionName: '作者',
          tagValue: '移动开发甲',
          fileCount: 2,
          level: 1,
          code: 'author_mobile_a',
          viaParentCode: authorCode
        },
        {
          dimensionId: 4,
          dimensionCode: authorCode,
          dimensionName: '作者',
          tagValue: '移动开发乙',
          fileCount: 3,
          level: 1,
          code: 'author_mobile_b',
          viaParentCode: authorCode
        }
      ]
    })

    const group1 = makeGroup()
    await context.clusterPanDimensionTags([group1])
    expect(omniService.clusterDocuments).not.toHaveBeenCalled()
    // 首次使用了本地词根分类
    const cluster1 = group1.tags.find(t => t.meta?.isClusterNode === true)
    expect(cluster1).toBeDefined()

    // 第二次：Omni 引擎启动就绪 (isReady = true)
    vi.mocked(omniService.isReady).mockReturnValue(true)
    vi.mocked(omniService.clusterDocuments).mockResolvedValueOnce({
      success: true,
      result: {
        clusters: [
          {
            clusterId: 101,
            fingerprints: ['author_mobile_a', 'author_mobile_b'],
            folderName: 'Omni智能移动专家'
          }
        ]
      }
    } as any)

    const group2 = makeGroup()
    await context.clusterPanDimensionTags([group2])
    // 成功突破本地 fallback 缓存，触发 Omni HAC 升级
    expect(omniService.clusterDocuments).toHaveBeenCalledTimes(1)
    const cluster2 = group2.tags.find(t => t.meta?.isClusterNode === true)
    expect(cluster2?.tagValue).toBe('Omni智能移动专家')
  })
})
