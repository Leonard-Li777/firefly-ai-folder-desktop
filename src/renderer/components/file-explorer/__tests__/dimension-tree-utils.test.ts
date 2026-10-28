import { describe, it, expect } from 'vitest'
import {
  nestGroupTags,
  makeTagKey,
  parseTagKey,
  buildDimensionTree,
  getVisibleAndHiddenTags,
  getSelectedTagsFromSet,
  getAllKeys,
  migrateTagKeysAcrossScale,
  dimensionNodeKey,
  DimensionChildTagsMap
} from '../dimension-tree-utils'
import { DimensionGroup, DimensionTag } from '@firefly/types'

describe('dimension-tree-utils - 内容标签与多级深度穿透测试', () => {
  const contentGroup: DimensionGroup = {
    id: 28,
    name: '内容标签',
    level: 0,
    tags: [],
    code: 'builtin.content_tags',
    isMultiSelect: false,
    metadata: { isPanDimension: true, source: 'builtin' }
  }

  const sampleTags: DimensionTag[] = [
    {
      dimensionId: 28,
      dimensionCode: 'builtin.content_tags',
      dimensionName: '内容标签',
      tagValue: '建筑空间',
      code: 'builtin.cat.architecture',
      viaParentCode: 'builtin.content_tags',
      level: 1,
      fileCount: 10,
      isMultiSelect: false,
      order: 9999
    },
    {
      dimensionId: 28,
      dimensionCode: 'builtin.content_tags',
      dimensionName: '内容标签',
      tagValue: '文化场馆',
      code: 'builtin.cat.cultural_venue',
      viaParentCode: 'builtin.cat.architecture',
      level: 2,
      fileCount: 5,
      isMultiSelect: false,
      order: 9999
    },
    {
      dimensionId: 28,
      dimensionCode: 'builtin.content_tags',
      dimensionName: '内容标签',
      tagValue: '博物馆',
      code: 'omw.museum',
      viaParentCode: 'builtin.cat.cultural_venue',
      level: 3,
      fileCount: 3,
      isMultiSelect: false,
      order: 9999
    }
  ]

  it('深度刻度 10 时：完整级联展开建筑空间 ➔ 文化场馆 ➔ 博物馆', () => {
    const { directTags, childTagsMap } = nestGroupTags(contentGroup, sampleTags, 0, 10)

    // Level 1: 直属标签只有建筑空间
    expect(directTags.length).toBe(1)
    expect(directTags[0].tagValue).toBe('建筑空间')

    // Level 2: 建筑空间下有文化场馆
    const l1Children = childTagsMap.get('建筑空间')
    expect(l1Children).toBeDefined()
    expect(l1Children!.length).toBe(1)
    const l2Node = l1Children![0]
    expect(l2Node.name).toBe('建筑空间')
    expect(l2Node.tags.length).toBe(1)
    expect(l2Node.tags[0].tagValue).toBe('文化场馆')

    // Level 3: 文化场馆下有博物馆
    expect(l2Node.childTags).toBeDefined()
    const l2Children = l2Node.childTags!.get('文化场馆')
    expect(l2Children).toBeDefined()
    expect(l2Children!.length).toBe(1)
    const l3Node = l2Children![0]
    expect(l3Node.name).toBe('文化场馆')
    expect(l3Node.tags[0].tagValue).toBe('博物馆')
  })

  it('深度刻度 4 时：博物馆穿透提升到文化场馆节点下', () => {
    const { directTags, childTagsMap } = nestGroupTags(contentGroup, sampleTags, 0, 4)

    expect(directTags.length).toBe(1)
    expect(directTags[0].tagValue).toBe('建筑空间')

    const l1Children = childTagsMap.get('建筑空间')
    expect(l1Children).toBeDefined()
    const l1Node = l1Children![0]
    expect(l1Node.name).toBe('建筑空间')

    // 在深度 4 下：文化场馆展开为二级节点 (视觉深度 3)
    expect(l1Node.childTags).toBeDefined()
    const l2Children = l1Node.childTags!.get('文化场馆')
    expect(l2Children).toBeDefined()
    const l2Node = l2Children![0]
    expect(l2Node.name).toBe('文化场馆')

    // 达到深度 4 限制，博物馆穿透提升挂载在文化场馆节点中 (视觉深度 4)
    expect(l2Node.childTags).toBeUndefined()
    expect(l2Node.tags.some(t => t.tagValue === '博物馆')).toBe(true)
  })

  it('深度刻度 3 时：文化场馆与博物馆穿透提升到建筑空间下', () => {
    const { directTags, childTagsMap } = nestGroupTags(contentGroup, sampleTags, 0, 3)

    expect(directTags.length).toBe(1)
    expect(directTags[0].tagValue).toBe('建筑空间')

    const l1Children = childTagsMap.get('建筑空间')
    expect(l1Children).toBeDefined()
    const l1Node = l1Children![0]
    expect(l1Node.name).toBe('建筑空间')

    // 达到深度 3 限制，文化场馆与博物馆均穿透提升挂载在建筑空间节点中 (视觉深度 3)
    expect(l1Node.childTags).toBeUndefined()
    expect(l1Node.tags.some(t => t.tagValue === '文化场馆')).toBe(true)
    expect(l1Node.tags.some(t => t.tagValue === '博物馆')).toBe(true)
  })

  it('深度刻度 2 时：文化场馆与博物馆全量穿透提升平铺在 directTags 中，无展开子节点，总深度严格为 2', () => {
    const { directTags, childTagsMap } = nestGroupTags(contentGroup, sampleTags, 0, 2)

    // 根维度 Header (视觉深度 1)，直属标签层 (视觉深度 2)
    // 刻度 2 时直属层即为最大深度，深层后代全量提升平铺在 directTags 中，不展开
    expect(directTags.length).toBe(3)
    expect(directTags.map(t => t.tagValue)).toEqual(['建筑空间', '文化场馆', '博物馆'])
    expect(childTagsMap.size).toBe(0)
  })
})

describe('dimension-tree-utils - 穿透提升跨分支同 Code 聚合 (ADR-0034 §4 / M-4)', () => {
  const liftGroup: DimensionGroup = {
    id: 28,
    name: '内容标签',
    level: 0,
    tags: [],
    code: 'builtin.content_tags',
    isMultiSelect: false,
    metadata: { isPanDimension: true, source: 'builtin' }
  }

  // 多分支同 Code 结构：甲 → (乙一, 乙二) → 交叉(builtin.x 两个分支实例)
  const pJia = '/builtin.content_tags/builtin.a'
  const pYi1 = `${pJia}/builtin.b1`
  const pYi2 = `${pJia}/builtin.b2`
  const pCross1 = `${pYi1}/builtin.x`
  const pCross2 = `${pYi2}/builtin.x`

  const multiBranchTags: DimensionTag[] = [
    {
      dimensionId: 28,
      dimensionCode: 'builtin.content_tags',
      dimensionName: '内容标签',
      tagValue: '甲',
      code: 'builtin.a',
      viaParentCode: 'builtin.content_tags',
      level: 1,
      fileCount: 8,
      codePath: pJia,
      namePath: '/内容标签/甲',
      isMultiSelect: false,
      order: 9999
    },
    {
      dimensionId: 28,
      dimensionCode: 'builtin.content_tags',
      dimensionName: '内容标签',
      tagValue: '乙一',
      code: 'builtin.b1',
      viaParentCode: 'builtin.a',
      level: 2,
      fileCount: 8,
      codePath: pYi1,
      namePath: '/内容标签/甲/乙一',
      isMultiSelect: false,
      order: 9999
    },
    {
      dimensionId: 28,
      dimensionCode: 'builtin.content_tags',
      dimensionName: '内容标签',
      tagValue: '乙二',
      code: 'builtin.b2',
      viaParentCode: 'builtin.a',
      level: 2,
      fileCount: 8,
      codePath: pYi2,
      namePath: '/内容标签/甲/乙二',
      isMultiSelect: false,
      order: 9999
    },
    {
      dimensionId: 28,
      dimensionCode: 'builtin.content_tags',
      dimensionName: '内容标签',
      tagValue: '交叉',
      code: 'builtin.x',
      viaParentCode: 'builtin.b1',
      level: 3,
      fileCount: 8,
      codePath: pCross1,
      namePath: '/内容标签/甲/乙一/交叉',
      isMultiSelect: false,
      order: 9999
    },
    {
      dimensionId: 28,
      dimensionCode: 'builtin.content_tags',
      dimensionName: '内容标签',
      tagValue: '交叉',
      code: 'builtin.x',
      viaParentCode: 'builtin.b2',
      level: 3,
      fileCount: 8,
      codePath: pCross2,
      namePath: '/内容标签/甲/乙二/交叉',
      isMultiSelect: false,
      order: 9999
    }
  ]

  it('刻度 3 时：跨分支同 Code 提升聚合为单行，fileCount 去重且保留全部分支 codePaths', () => {
    const { directTags, childTagsMap } = nestGroupTags(liftGroup, multiBranchTags, 0, 3)

    expect(directTags.length).toBe(1)
    const l1Node = childTagsMap.get('甲')![0]

    // 提升后仅保留一行「交叉」，另一分支实例被合并去重
    const crossTags = l1Node.tags.filter(t => t.tagValue === '交叉')
    expect(crossTags.length).toBe(1)

    const merged = crossTags[0]
    // 聚合路径集合必须完整覆盖两个分支，确保文件视野零丢失
    expect(merged.codePaths).toEqual([pCross1, pCross2])
    // 主路径保留首分支，供单值 codePath 消费方降级使用
    expect(merged.codePath).toBe(pCross1)
    // 同 Code 计数为全局口径：合并按去重语义取最大值，严禁相加虚高徽标
    expect(merged.fileCount).toBe(8)
    // 提升标签挂载到容器父级 (穿透提升 viaParentCode 重写)
    expect(merged.viaParentCode).toBe('builtin.a')
    expect(merged.level).toBe(3)

    // 兄弟分支标签同样提升且路径完整保留（聚合顺序不作为断言口径）
    expect(new Set(l1Node.tags.map(t => t.tagValue))).toEqual(new Set(['乙一', '乙二', '交叉']))
    expect(l1Node.tags.find(t => t.tagValue === '乙一')!.codePath).toBe(pYi1)
    expect(l1Node.tags.find(t => t.tagValue === '乙二')!.codePath).toBe(pYi2)
    // 刻度 3 下不再生成更深节点
    expect(l1Node.childTags).toBeUndefined()
  })

  it('刻度 2 时：跨分支深层后代全量提升平铺在 directTags 中，总深度为 2', () => {
    const { directTags, childTagsMap } = nestGroupTags(liftGroup, multiBranchTags, 0, 2)

    // 直属层已达最大深度 2，甲/乙一/乙二/交叉全部平铺在 directTags 中
    expect(childTagsMap.size).toBe(0)
    expect(new Set(directTags.map(t => t.tagValue))).toEqual(new Set(['甲', '乙一', '乙二', '交叉']))
  })

  it('刻度 10 时：未触发提升，两个分支实例各自独立保留（不跨层误聚合）', () => {
    const { childTagsMap } = nestGroupTags(liftGroup, multiBranchTags, 0, 10)
    const l1Node = childTagsMap.get('甲')![0]

    // 未达刻度上限：乙一 / 乙二 仍为常规分支，不聚合
    expect(l1Node.tags.map(t => t.tagValue)).toEqual(['乙一', '乙二'])

    // 乙一 分支下的「交叉」保留自身物化路径，未被跨分支合并
    const yi1Node = l1Node.childTags!.get('乙一')![0]
    expect(yi1Node.tags.some(t => t.tagValue === '交叉' && t.codePath === pCross1)).toBe(true)
    expect(yi1Node.tags.find(t => t.tagValue === '交叉')!.codePaths).toBeUndefined()

    // 乙二 分支下的「交叉」同样独立保留
    const yi2Node = l1Node.childTags!.get('乙二')![0]
    expect(yi2Node.tags.some(t => t.tagValue === '交叉' && t.codePath === pCross2)).toBe(true)
  })

  it('多父 DAG 回环：提升遍历按对象身份防环终止，且不重复提升起始标签', () => {
    const cycleTags: DimensionTag[] = [
      {
        dimensionId: 28,
        dimensionCode: 'builtin.content_tags',
        dimensionName: '内容标签',
        tagValue: '环一',
        code: 'builtin.loop1',
        viaParentCode: 'builtin.content_tags',
        level: 1,
        fileCount: 2,
        codePath: '/builtin.content_tags/builtin.loop1',
        namePath: '/内容标签/环一',
        isMultiSelect: false,
        order: 9999
      },
      {
        dimensionId: 28,
        dimensionCode: 'builtin.content_tags',
        dimensionName: '内容标签',
        tagValue: '环二',
        code: 'builtin.loop2',
        viaParentCode: 'builtin.loop1',
        level: 2,
        fileCount: 2,
        codePath: '/builtin.content_tags/builtin.loop1/builtin.loop2',
        namePath: '/内容标签/环一/环二',
        isMultiSelect: false,
        order: 9999
      },
      {
        // 脏数据/多父 DAG 极端场景：环二 反向挂载回 环一，形成 loop1 → loop2 → loop1 回环
        dimensionId: 28,
        dimensionCode: 'builtin.content_tags',
        dimensionName: '内容标签',
        tagValue: '环一',
        code: 'builtin.loop1',
        viaParentCode: 'builtin.loop2',
        level: 3,
        fileCount: 2,
        codePath: '/builtin.content_tags/builtin.loop1/builtin.loop2/builtin.loop1',
        namePath: '/内容标签/环一/环二/环一',
        isMultiSelect: false,
        order: 9999
      }
    ]

    const { directTags, childTagsMap } = nestGroupTags(liftGroup, cycleTags, 0, 3)

    expect(directTags.length).toBe(1)
    const l1Node = childTagsMap.get('环一')![0]
    // 防环遍历终止，且起始标签自身不被重复提升为子行
    expect(l1Node.tags.map(t => t.tagValue)).toEqual(['环二'])
  })
})

describe('dimension-tree-utils - makeTagKey & parseTagKey', () => {
  it('正确生成和解析无父标签 key', () => {
    const key = makeTagKey(1, '图片')
    expect(key).toBe('1::::图片')
    const parsed = parseTagKey(key)
    expect(parsed.dimensionId).toBe(1)
    expect(parsed.parentTagValue).toBeUndefined()
    expect(parsed.viaParentCode).toBeUndefined()
    expect(parsed.tagValue).toBe('图片')
  })

  it('正确生成和解析含父标签值 key', () => {
    const key = makeTagKey(28, '建筑空间', '内容标签')
    expect(key).toBe('28::内容标签::建筑空间')
    const parsed = parseTagKey(key)
    expect(parsed.dimensionId).toBe(28)
    expect(parsed.parentTagValue).toBe('内容标签')
    expect(parsed.viaParentCode).toBeUndefined()
    expect(parsed.tagValue).toBe('建筑空间')
  })

  it('正确生成和解析含 viaParentCode key', () => {
    const key = makeTagKey(28, '文化场馆', undefined, 'builtin.cat.architecture')
    expect(key).toBe('28::parentCode:builtin.cat.architecture::文化场馆')
    const parsed = parseTagKey(key)
    expect(parsed.dimensionId).toBe(28)
    expect(parsed.parentTagValue).toBeUndefined()
    expect(parsed.viaParentCode).toBe('builtin.cat.architecture')
    expect(parsed.tagValue).toBe('文化场馆')
    expect(parsed.isLifted).toBe(false)
  })

  it('穿透提升聚合行 key 打 liftCode 标记，解析后可与直系实例行区分 (ADR-0034 §4 / M-4)', () => {
    const liftedKey = makeTagKey(7, '无码', undefined, 'builtin.image', true)
    expect(liftedKey).toBe('7::liftCode:builtin.image::无码')
    const parsed = parseTagKey(liftedKey)
    expect(parsed.isLifted).toBe(true)
    expect(parsed.viaParentCode).toBe('builtin.image')
    expect(parsed.tagValue).toBe('无码')
    expect(parsed.parentTagValue).toBeUndefined()

    // 常规实例行 key 保持 parentCode 前缀，两者不得互相误判
    const instanceKey = makeTagKey(7, '无码', undefined, 'builtin.image')
    expect(parseTagKey(instanceKey).isLifted).toBe(false)
  })

  it('多父维度同名叶子跨分支：key 第 4 段携带 codePath 分支消歧，不同分支 key 不同', () => {
    const docPath = '/builtin.file_type/omw.03234306.n/builtin.doc_categories/builtin.language_sub/omw.pt'
    const ebookPath = '/builtin.file_type/omw.03234306.n/builtin.ebook_categories/builtin.language_sub/omw.pt'
    const docKey = makeTagKey(120, '葡萄牙语', undefined, undefined, false, docPath)
    const ebookKey = makeTagKey(120, '葡萄牙语', undefined, undefined, false, ebookPath)

    // 四元组（dimensionId/tagValue/parentTagValue/viaParentCode）跨分支全同，仅 codePath 不同
    expect(docKey).not.toBe(ebookKey)
    expect(docKey).toBe(`120::::葡萄牙语::path:${docPath}`)

    const parsedDoc = parseTagKey(docKey)
    expect(parsedDoc.tagValue).toBe('葡萄牙语')
    expect(parsedDoc.codePath).toBe(docPath)
    expect(parseTagKey(ebookKey).codePath).toBe(ebookPath)
  })

  it('无 codePath（聚合行/旧存档）时 key 与历史三段格式逐字节一致（localStorage 兼容）', () => {
    expect(makeTagKey(28, '建筑空间', '内容标签', undefined, false, undefined)).toBe('28::内容标签::建筑空间')
    expect(makeTagKey(28, '建筑空间', '内容标签', undefined, false, '   ')).toBe('28::内容标签::建筑空间')
    // 旧格式 key 解析不产生 codePath，getSelectedTagsFromSet 的 viaParentCode 兜底路径不受影响
    const parsed = parseTagKey('28::内容标签::建筑空间')
    expect(parsed.codePath).toBeUndefined()
    expect(parsed.tagValue).toBe('建筑空间')
  })
})

describe('dimension-tree-utils - buildDimensionTree', () => {
  const mockGroups: DimensionGroup[] = [
    {
      id: 1,
      name: '文件格式',
      code: 'builtin.format',
      level: 0,
      tags: [
        { dimensionId: 1, dimensionCode: 'builtin.format', dimensionName: '文件格式', tagValue: 'PNG', fileCount: 5, isMultiSelect: false }
      ],
      isMultiSelect: false
    },
    {
      id: 2,
      name: '子格式',
      code: 'builtin.subformat',
      level: 1,
      parentDimensionIds: [1],
      triggerConditions: [
        { parentDimension: '文件格式', triggerTags: ['PNG'] }
      ],
      tags: [
        { dimensionId: 2, dimensionCode: 'builtin.subformat', dimensionName: '子格式', tagValue: 'APNG', fileCount: 2, isMultiSelect: false }
      ],
      isMultiSelect: false
    },
    {
      id: 3,
      name: '文件格式', // 同名根级组，应被去重
      code: 'builtin.format_dup',
      level: 0,
      tags: [],
      isMultiSelect: false
    }
  ]

  it('构建多层级维度树并自动去重根级同名维度', () => {
    const tree = buildDimensionTree(mockGroups)
    // 根级应只有 1 个文件格式（id: 1），id: 3 同名被去重
    expect(tree.length).toBe(1)
    expect(tree[0].id).toBe(1)
    expect(tree[0].tags.length).toBe(1)
    expect(tree[0].childTags).toBeDefined()

    const pngChildren = tree[0].childTags!.get('PNG')
    expect(pngChildren).toBeDefined()
    expect(pngChildren!.length).toBe(1)
    expect(pngChildren![0].id).toBe(2)
  })
})

describe('dimension-tree-utils - getVisibleAndHiddenTags', () => {
  const group: DimensionGroup = {
    id: 10,
    name: '测试维度',
    code: 'builtin.test',
    level: 0,
    tags: [
      { dimensionId: 10, dimensionCode: 'builtin.test', dimensionName: '测试维度', tagValue: '有文件', fileCount: 8, isMultiSelect: false },
      { dimensionId: 10, dimensionCode: 'builtin.test', dimensionName: '测试维度', tagValue: '无文件', fileCount: 0, isMultiSelect: false }
    ],
    isMultiSelect: false
  }

  it('默认过滤 fileCount === 0 的标签到 hiddenTags', () => {
    const { visibleTags, hiddenTags, tagsToShow } = getVisibleAndHiddenTags(group, false)
    expect(visibleTags.length).toBe(1)
    expect(visibleTags[0].tagValue).toBe('有文件')
    expect(hiddenTags.length).toBe(1)
    expect(hiddenTags[0].tagValue).toBe('无文件')
    expect(tagsToShow.length).toBe(1)
  })

  it('showEmptyTags 为 true 时展示全量标签', () => {
    const { tagsToShow } = getVisibleAndHiddenTags(group, true)
    expect(tagsToShow.length).toBe(2)
  })
})

describe('dimension-tree-utils - getSelectedTagsFromSet', () => {
  const groups: DimensionGroup[] = [
    {
      id: 1,
      name: '类型',
      code: 'builtin.type',
      level: 0,
      tags: [
        { dimensionId: 1, dimensionCode: 'builtin.type', dimensionName: '类型', tagValue: '图片', code: 'builtin.image', fileCount: 10, isMultiSelect: false }
      ],
      isMultiSelect: false
    }
  ]

  it('将 Set<string> key 正确转换为 SelectedTag 列表', () => {
    const key = makeTagKey(1, '图片')
    const keySet = new Set([key, '999::::幽灵标签'])

    const result = getSelectedTagsFromSet(keySet, groups)
    expect(result.length).toBe(1)
    expect(result[0].dimensionId).toBe(1)
    expect(result[0].dimensionName).toBe('类型')
    expect(result[0].tagValue).toBe('图片')
    expect(result[0].code).toBe('builtin.image')
  })

  it('通过 parentTagMap 还原 ancestorChain 与 parentTagValue', () => {
    const key = makeTagKey(1, '图片')
    const keySet = new Set([key])
    const parentTagMap = new Map<string, string[]>([[key, ['素材', '图片']]])

    const result = getSelectedTagsFromSet(keySet, groups, parentTagMap)
    expect(result.length).toBe(1)
    expect(result[0].parentTagValue).toBe('素材')
    expect(result[0].ancestorChain).toEqual(['素材', '图片'])
  })

  it('完整透传 codePath 与 namePath（M-2 修复）', () => {
    const groupsWithPaths: DimensionGroup[] = [
      {
        id: 1,
        name: '类型',
        code: 'builtin.type',
        level: 0,
        tags: [
          {
            dimensionId: 1,
            dimensionCode: 'builtin.type',
            dimensionName: '类型',
            tagValue: '图片',
            code: 'builtin.image',
            level: 1,
            fileCount: 10,
            codePath: '/builtin.file_type/builtin.image',
            namePath: '/文件类型/图片',
            isMultiSelect: false
          }
        ],
        isMultiSelect: false
      }
    ]

    const result = getSelectedTagsFromSet(new Set([makeTagKey(1, '图片')]), groupsWithPaths)
    expect(result.length).toBe(1)
    expect(result[0].codePath).toBe('/builtin.file_type/builtin.image')
    expect(result[0].namePath).toBe('/文件类型/图片')
  })

  it('多父同名实例按 key 的 viaParentCode 精确消歧，取命中分支的物化路径', () => {
    const multiParentGroups: DimensionGroup[] = [
      {
        id: 7,
        name: '打码程度',
        code: 'builtin.censorship',
        level: 0,
        tags: [
          {
            dimensionId: 7,
            dimensionCode: 'builtin.censorship',
            dimensionName: '打码程度',
            tagValue: '无码',
            code: 'builtin.uncensored',
            viaParentCode: 'builtin.image',
            level: 2,
            fileCount: 7,
            codePath: '/builtin.file_type/builtin.image/builtin.uncensored',
            namePath: '/文件类型/图片/无码',
            isMultiSelect: false
          },
          {
            dimensionId: 7,
            dimensionCode: 'builtin.censorship',
            dimensionName: '打码程度',
            tagValue: '无码',
            code: 'builtin.uncensored',
            viaParentCode: 'builtin.video',
            level: 2,
            fileCount: 5,
            codePath: '/builtin.file_type/builtin.video/builtin.uncensored',
            namePath: '/文件类型/视频/无码',
            isMultiSelect: false
          }
        ],
        isMultiSelect: false
      }
    ]

    const videoKey = makeTagKey(7, '无码', undefined, 'builtin.video')
    const result = getSelectedTagsFromSet(new Set([videoKey]), multiParentGroups)
    expect(result.length).toBe(1)
    expect(result[0].codePath).toBe('/builtin.file_type/builtin.video/builtin.uncensored')
    expect(result[0].namePath).toBe('/文件类型/视频/无码')
    // 精确命中单分支时严禁并集，否则 FileList 会跨分支召回污染徽标
    expect(result[0].codePaths).toBeUndefined()
  })

  it('穿透提升聚合行（viaParentCode 无实例匹配）回退为全部分支 codePaths 并集', () => {
    const liftedGroups: DimensionGroup[] = [
      {
        id: 7,
        name: '打码程度',
        code: 'builtin.censorship',
        level: 0,
        tags: [
          {
            dimensionId: 7,
            dimensionCode: 'builtin.censorship',
            dimensionName: '打码程度',
            tagValue: '无码',
            code: 'builtin.uncensored',
            viaParentCode: 'builtin.image',
            level: 2,
            fileCount: 7,
            codePath: '/builtin.file_type/builtin.image/builtin.uncensored',
            namePath: '/文件类型/图片/无码',
            isMultiSelect: false
          },
          {
            dimensionId: 7,
            dimensionCode: 'builtin.censorship',
            dimensionName: '打码程度',
            tagValue: '无码',
            code: 'builtin.uncensored',
            viaParentCode: 'builtin.video',
            level: 2,
            fileCount: 5,
            codePath: '/builtin.file_type/builtin.video/builtin.uncensored',
            namePath: '/文件类型/视频/无码',
            isMultiSelect: false
          }
        ],
        isMultiSelect: false
      }
    ]

    // 提升行的 viaParentCode 被重写为容器父级，原始分支中无任何实例与之匹配
    const liftedKey = makeTagKey(7, '无码', undefined, 'builtin.file_type')
    const result = getSelectedTagsFromSet(new Set([liftedKey]), liftedGroups)
    expect(result.length).toBe(1)
    expect(result[0].codePaths).toEqual([
      '/builtin.file_type/builtin.image/builtin.uncensored',
      '/builtin.file_type/builtin.video/builtin.uncensored'
    ])
    // 主路径保留首个实例，供单值消费方降级
    expect(result[0].codePath).toBe('/builtin.file_type/builtin.image/builtin.uncensored')
  })

  // High-1 回归：聚合行 viaParentCode 重写后可能与容器直系真实实例的 key 撞车，
  // 必须按 liftCode 标记分流，否则多选会漏掉深层分支的文件视野
  it('liftCode 聚合行 key：即使组内存在同 viaParentCode 直系实例，也按容器子树取全分支并集', () => {
    const directP = '/builtin.file_type/builtin.image/builtin.uncensored'
    const deepP = '/builtin.file_type/builtin.image/builtin.manga/builtin.uncensored'
    const collideGroups: DimensionGroup[] = [
      {
        id: 7,
        name: '打码程度',
        code: 'builtin.censorship',
        level: 0,
        tags: [
          {
            dimensionId: 7,
            dimensionCode: 'builtin.censorship',
            dimensionName: '打码程度',
            tagValue: '图片',
            code: 'builtin.image',
            level: 1,
            fileCount: 12,
            codePath: '/builtin.file_type/builtin.image',
            namePath: '/文件类型/图片',
            isMultiSelect: false
          },
          {
            dimensionId: 7,
            dimensionCode: 'builtin.censorship',
            dimensionName: '打码程度',
            tagValue: '漫画',
            code: 'builtin.manga',
            viaParentCode: 'builtin.image',
            level: 2,
            fileCount: 6,
            codePath: '/builtin.file_type/builtin.image/builtin.manga',
            namePath: '/文件类型/图片/漫画',
            isMultiSelect: false
          },
          {
            // 直系实例：viaParentCode 与聚合行重写后的值相同（撞车场景）
            dimensionId: 7,
            dimensionCode: 'builtin.censorship',
            dimensionName: '打码程度',
            tagValue: '无码',
            code: 'builtin.uncensored',
            viaParentCode: 'builtin.image',
            level: 2,
            fileCount: 6,
            codePath: directP,
            namePath: '/文件类型/图片/无码',
            isMultiSelect: false
          },
          {
            // 深层实例：挂在漫画分支下
            dimensionId: 7,
            dimensionCode: 'builtin.censorship',
            dimensionName: '打码程度',
            tagValue: '无码',
            code: 'builtin.uncensored',
            viaParentCode: 'builtin.manga',
            level: 3,
            fileCount: 6,
            codePath: deepP,
            namePath: '/文件类型/图片/漫画/无码',
            isMultiSelect: false
          }
        ],
        isMultiSelect: false
      }
    ]

    // 聚合行 key（liftCode）→ 容器子树闭包内全分支并集，与单选点击同一行一致
    const liftedKey = makeTagKey(7, '无码', undefined, 'builtin.image', true)
    const liftedResult = getSelectedTagsFromSet(new Set([liftedKey]), collideGroups)
    expect(liftedResult.length).toBe(1)
    expect(new Set(liftedResult[0].codePaths)).toEqual(new Set([directP, deepP]))
    expect(liftedResult[0].viaParentCode).toBe('builtin.image')

    // 与单选口径对齐：nestGroupTags 在刻度 3 下重建的聚合行必须给出同一组路径
    const { childTagsMap } = nestGroupTags(collideGroups[0], collideGroups[0].tags, 0, 3)
    const liftedNode = childTagsMap.get('图片')![0]
    const aggRow = liftedNode.tags.find(t => t.tagValue === '无码')!
    expect(new Set(aggRow.codePaths)).toEqual(new Set(liftedResult[0].codePaths))
    expect(liftedResult[0].code).toBe(aggRow.code)
    expect(liftedResult[0].codePath).toBe(aggRow.codePath)
    expect(liftedResult[0].namePath).toBe(aggRow.namePath)

    // 常规实例行 key（parentCode）仍走精确消歧，严禁并集污染徽标 (AC-4)
    const instanceKey = makeTagKey(7, '无码', undefined, 'builtin.image')
    const instanceResult = getSelectedTagsFromSet(new Set([instanceKey]), collideGroups)
    expect(instanceResult[0].codePath).toBe(directP)
    expect(instanceResult[0].codePaths).toBeUndefined()
  })

  // M-1 回归：提升聚合行只有单一物化路径（codePaths 单元素）时，多选也必须保留 codePaths，
  // 否则后端回退 code 并集口径，与单选的 codePath 排他口径分叉（单/多选视野不再一致）
  it('liftCode 聚合行单元素 codePaths：length=1 时多选仍保留 codePaths，与单选排他口径一致', () => {
    const singleP = '/builtin.file_type/builtin.image/builtin.uncensored'
    const singleGroups: DimensionGroup[] = [
      {
        id: 7,
        name: '打码程度',
        code: 'builtin.censorship',
        level: 0,
        tags: [
          {
            dimensionId: 7,
            dimensionCode: 'builtin.censorship',
            dimensionName: '打码程度',
            tagValue: '图片',
            code: 'builtin.image',
            level: 1,
            fileCount: 12,
            codePath: '/builtin.file_type/builtin.image',
            namePath: '/文件类型/图片',
            isMultiSelect: false
          },
          {
            // 容器直系唯一实例：提升聚合后 codePaths 仅 1 个元素
            dimensionId: 7,
            dimensionCode: 'builtin.censorship',
            dimensionName: '打码程度',
            tagValue: '无码',
            code: 'builtin.uncensored',
            viaParentCode: 'builtin.image',
            level: 2,
            fileCount: 7,
            codePath: singleP,
            namePath: '/文件类型/图片/无码',
            isMultiSelect: false
          }
        ],
        isMultiSelect: false
      }
    ]

    const liftedKey = makeTagKey(7, '无码', undefined, 'builtin.image', true)
    const result = getSelectedTagsFromSet(new Set([liftedKey]), singleGroups)
    expect(result.length).toBe(1)
    expect(result[0].codePaths).toEqual([singleP])

    // 与单选同口径：nestGroupTags 在刻度 3 下重建的聚合行给出同一组路径
    const { childTagsMap } = nestGroupTags(singleGroups[0], singleGroups[0].tags, 0, 3)
    const aggRow = childTagsMap.get('图片')![0].tags.find(t => t.tagValue === '无码')!
    expect(aggRow.codePaths).toEqual([singleP])
    expect(result[0].codePaths).toEqual(aggRow.codePaths)
    expect(result[0].codePath).toBe(aggRow.codePath)
  })
})


describe('migrateTagKeysAcrossScale 跨刻度自愈与全覆盖不变式测试', () => {
  const directP = '/builtin.file_type/builtin.image/builtin.uncensored'
  const deepP = '/builtin.file_type/builtin.image/builtin.manga/builtin.uncensored'

  const collideGroups: DimensionGroup[] = [
    {
      id: 7,
      name: '打码程度',
      code: 'builtin.censorship',
      level: 0,
      tags: [
        {
          dimensionId: 7,
          dimensionCode: 'builtin.censorship',
          dimensionName: '打码程度',
          tagValue: '图片',
          code: 'builtin.image',
          level: 1,
          fileCount: 12,
          codePath: '/builtin.file_type/builtin.image',
          namePath: '/文件类型/图片',
          isMultiSelect: false
        },
        {
          dimensionId: 7,
          dimensionCode: 'builtin.censorship',
          dimensionName: '打码程度',
          tagValue: '漫画',
          code: 'builtin.manga',
          viaParentCode: 'builtin.image',
          level: 2,
          fileCount: 6,
          codePath: '/builtin.file_type/builtin.image/builtin.manga',
          namePath: '/文件类型/图片/漫画',
          isMultiSelect: false
        },
        {
          dimensionId: 7,
          dimensionCode: 'builtin.censorship',
          dimensionName: '打码程度',
          tagValue: '无码',
          code: 'builtin.uncensored',
          viaParentCode: 'builtin.image',
          level: 2,
          fileCount: 6,
          codePath: directP,
          namePath: '/文件类型/图片/无码',
          isMultiSelect: false
        },
        {
          dimensionId: 7,
          dimensionCode: 'builtin.censorship',
          dimensionName: '打码程度',
          tagValue: '无码',
          code: 'builtin.uncensored',
          viaParentCode: 'builtin.manga',
          level: 3,
          fileCount: 6,
          codePath: deepP,
          namePath: '/文件类型/图片/漫画/无码',
          isMultiSelect: false
        }
      ],
      isMultiSelect: false
    }
  ]

  it('AC-1: 刻度 3 提升聚合行 ➔ 刻度 5 展开为多实例行 (1:N 自愈)', () => {
    // 刻度 3: 树折叠，无码被提升聚合
    const scale3Tree = buildDimensionTree(collideGroups, null, null, 0, 3)
    const liftedKey = makeTagKey(7, '无码', undefined, 'builtin.image', true)

    // 刻度 5: 树完全展开为多实例行
    const scale5Tree = buildDimensionTree(collideGroups, null, null, 0, 5)

    const result = migrateTagKeysAcrossScale({
      prevSelected: new Set([liftedKey]),
      prevStack: [liftedKey],
      prevParentMap: new Map([[liftedKey, ['图片']]]),
      currentVisibleGroups: scale5Tree,
      masterDimensionGroups: collideGroups
    })

    // 带 codePath 的行 key 生成第 4 段 `path:` 分支消歧段（多父同名叶子勾选串选修复）
    const directInstanceKey = makeTagKey(7, '无码', undefined, 'builtin.image', false, directP)
    const deepInstanceKey = makeTagKey(7, '无码', undefined, 'builtin.manga', false, deepP)

    expect(result.hasChanged).toBe(true)
    expect(result.migratedSelected.has(directInstanceKey)).toBe(true)
    expect(result.migratedSelected.has(deepInstanceKey)).toBe(true)
    expect(result.migratedSelected.has(liftedKey)).toBe(false)
    expect(result.migratedSelected.size).toBe(2)
    expect(result.migratedStack).toContain(directInstanceKey)
    expect(result.migratedStack).toContain(deepInstanceKey)
  })

  it('AC-2: 刻度 4 全量勾选实例 ➔ 刻度 3 折叠收敛为聚合行 (N:1 全覆盖收敛)', () => {
    const scale3Tree = buildDimensionTree(collideGroups, null, null, 0, 3)

    const directInstanceKey = makeTagKey(7, '无码', undefined, 'builtin.image', false, directP)
    const deepInstanceKey = makeTagKey(7, '无码', undefined, 'builtin.manga', false, deepP)
    // 聚合行 codePath 保留最深分支主路径（nestGroupTags 聚合语义），key 第 4 段随之
    const liftedKey = makeTagKey(7, '无码', undefined, 'builtin.image', true, deepP)

    const result = migrateTagKeysAcrossScale({
      prevSelected: new Set([directInstanceKey, deepInstanceKey]),
      prevStack: [directInstanceKey, deepInstanceKey],
      prevParentMap: new Map([
        [directInstanceKey, ['图片']],
        [deepInstanceKey, ['图片', '漫画']]
      ]),
      currentVisibleGroups: scale3Tree,
      masterDimensionGroups: collideGroups
    })

    expect(result.hasChanged).toBe(true)
    expect(result.migratedSelected.size).toBe(1)
    expect(result.migratedSelected.has(liftedKey)).toBe(true)
    expect(result.migratedStack).toEqual([liftedKey])
    expect(result.migratedParentMap.has(liftedKey)).toBe(true)
  })

  it('AC-2b: 多容器同名实例并发全覆盖折叠 (严防跨容器实例吞噬)', () => {
    // 两个独立容器：图片 (builtin.image) 和 视频 (builtin.video)
    // 容器 1 (图片) 下有漫画和直系两个无码实例；
    // 容器 2 (视频) 下有短视频下的一个无码实例。
    const multiContainerGroups: DimensionGroup[] = [
      {
        id: 7,
        name: '打码程度',
        code: 'builtin.censorship',
        level: 0,
        tags: [
          {
            dimensionId: 7,
            dimensionCode: 'builtin.censorship',
            dimensionName: '打码程度',
            tagValue: '图片',
            code: 'builtin.image',
            level: 1,
            fileCount: 12,
            codePath: '/builtin.file_type/builtin.image',
            namePath: '/文件类型/图片',
            isMultiSelect: false
          },
          {
            dimensionId: 7,
            dimensionCode: 'builtin.censorship',
            dimensionName: '打码程度',
            tagValue: '漫画',
            code: 'builtin.manga',
            viaParentCode: 'builtin.image',
            level: 2,
            fileCount: 6,
            codePath: '/builtin.file_type/builtin.image/builtin.manga',
            namePath: '/文件类型/图片/漫画',
            isMultiSelect: false
          },
          {
            dimensionId: 7,
            dimensionCode: 'builtin.censorship',
            dimensionName: '打码程度',
            tagValue: '无码',
            code: 'builtin.uncensored',
            viaParentCode: 'builtin.image',
            level: 2,
            fileCount: 6,
            codePath: directP,
            namePath: '/文件类型/图片/无码',
            isMultiSelect: false
          },
          {
            dimensionId: 7,
            dimensionCode: 'builtin.censorship',
            dimensionName: '打码程度',
            tagValue: '无码',
            code: 'builtin.uncensored',
            viaParentCode: 'builtin.manga',
            level: 3,
            fileCount: 6,
            codePath: deepP,
            namePath: '/文件类型/图片/漫画/无码',
            isMultiSelect: false
          },
          {
            dimensionId: 7,
            dimensionCode: 'builtin.censorship',
            dimensionName: '打码程度',
            tagValue: '视频',
            code: 'builtin.video',
            level: 1,
            fileCount: 8,
            codePath: '/builtin.file_type/builtin.video',
            namePath: '/文件类型/视频',
            isMultiSelect: false
          },
          {
            dimensionId: 7,
            dimensionCode: 'builtin.censorship',
            dimensionName: '打码程度',
            tagValue: '短视频',
            code: 'builtin.short_video',
            viaParentCode: 'builtin.video',
            level: 2,
            fileCount: 8,
            codePath: '/builtin.file_type/builtin.video/builtin.short_video',
            namePath: '/文件类型/视频/短视频',
            isMultiSelect: false
          },
          {
            dimensionId: 7,
            dimensionCode: 'builtin.censorship',
            dimensionName: '打码程度',
            tagValue: '无码',
            code: 'builtin.uncensored',
            viaParentCode: 'builtin.short_video',
            level: 3,
            fileCount: 8,
            codePath: '/builtin.file_type/builtin.video/builtin.short_video/builtin.uncensored',
            namePath: '/文件类型/视频/短视频/无码',
            isMultiSelect: false
          }
        ],
        isMultiSelect: false
      }
    ]

    const scale3Tree = buildDimensionTree(multiContainerGroups, null, null, 0, 3)

    // 用户在展开态同时选中了：图片下的直系无码、图片漫画下的无码、以及视频短视频下的无码
    const imageDirectKey = makeTagKey(7, '无码', undefined, 'builtin.image', false, directP)
    const imageDeepKey = makeTagKey(7, '无码', undefined, 'builtin.manga', false, deepP)
    const videoDeepKey = makeTagKey(
      7,
      '无码',
      undefined,
      'builtin.short_video',
      false,
      '/builtin.file_type/builtin.video/builtin.short_video/builtin.uncensored'
    )

    // 聚合行 codePath 保留最深分支主路径，key 第 4 段随之
    const imageLiftedKey = makeTagKey(7, '无码', undefined, 'builtin.image', true, deepP)
    const videoLiftedKey = makeTagKey(
      7,
      '无码',
      undefined,
      'builtin.video',
      true,
      '/builtin.file_type/builtin.video/builtin.short_video/builtin.uncensored'
    )

    const result = migrateTagKeysAcrossScale({
      prevSelected: new Set([imageDirectKey, imageDeepKey, videoDeepKey]),
      prevStack: [imageDirectKey, imageDeepKey, videoDeepKey],
      prevParentMap: new Map([
        [imageDirectKey, ['图片']],
        [imageDeepKey, ['图片', '漫画']],
        [videoDeepKey, ['视频', '短视频']]
      ]),
      currentVisibleGroups: scale3Tree,
      masterDimensionGroups: multiContainerGroups
    })

    expect(result.hasChanged).toBe(true)
    // 两个容器的聚合行必须独立并存，绝不能因为同名而互相吞噬！
    expect(result.migratedSelected.has(imageLiftedKey)).toBe(true)
    expect(result.migratedSelected.has(videoLiftedKey)).toBe(true)
    expect(result.migratedSelected.size).toBe(2)
    expect(result.migratedStack).toContain(imageLiftedKey)
    expect(result.migratedStack).toContain(videoLiftedKey)
  })

  it('AC-3: 部分选中严禁越界扩增 (Full-Coverage Invariant 核心门控)', () => {
    const scale3Tree = buildDimensionTree(collideGroups, null, null, 0, 3)
    const scale5Tree = buildDimensionTree(collideGroups, null, null, 0, 5)

    // 用户在完全展开态仅选中了漫画分支下的无码，未选中图片直系下的无码
    const deepInstanceKey = makeTagKey(7, '无码', undefined, 'builtin.manga', false)
    const liftedKey = makeTagKey(7, '无码', undefined, 'builtin.image', true)

    const collapseResult = migrateTagKeysAcrossScale({
      prevSelected: new Set([deepInstanceKey]),
      prevStack: [deepInstanceKey],
      prevParentMap: new Map([[deepInstanceKey, ['图片', '漫画']]]),
      currentVisibleGroups: scale3Tree,
      masterDimensionGroups: collideGroups
    })

    // 严禁晋升聚合行！绝不可包含 liftedKey (否则范围越界扩增为全部分支)
    expect(collapseResult.migratedSelected.has(liftedKey)).toBe(false)
    // 严格保留原深层实例 key 作为深层保留态
    expect(collapseResult.migratedSelected.has(deepInstanceKey)).toBe(true)
    expect(collapseResult.migratedSelected.size).toBe(1)

    // 再次从刻度 3 拖回完全展开态
    const expandResult = migrateTagKeysAcrossScale({
      prevSelected: collapseResult.migratedSelected,
      prevStack: collapseResult.migratedStack,
      prevParentMap: collapseResult.migratedParentMap,
      currentVisibleGroups: scale5Tree,
      masterDimensionGroups: collideGroups
    })

    // 依然精准且仅有深层实例行被选中，零扩散零越界
    expect(expandResult.migratedSelected.has(deepInstanceKey)).toBe(true)
    expect(expandResult.migratedSelected.size).toBe(1)
  })

  it('AC-4: 物理死标签/孤儿标签过滤', () => {
    const scale3Tree = buildDimensionTree(collideGroups, null, null, 0, 3)
    const orphanKey = makeTagKey(999, '已彻底删除的死标签', undefined, 'non_existent')

    const result = migrateTagKeysAcrossScale({
      prevSelected: new Set([orphanKey]),
      prevStack: [orphanKey],
      prevParentMap: new Map([[orphanKey, ['未知']]]),
      currentVisibleGroups: scale3Tree,
      masterDimensionGroups: collideGroups
    })

    expect(result.hasChanged).toBe(true)
    expect(result.migratedSelected.size).toBe(0)
    expect(result.migratedStack.length).toBe(0)
  })

  it('AC-5: 显式 isLifted 契约验证：聚合行打标与 key 生成', () => {
    const scale3Tree = buildDimensionTree(collideGroups, null, null, 0, 3)
    const { childTags } = scale3Tree[0]
    expect(childTags).toBeDefined()

    const l1Children = childTags!.get('图片')!
    const liftedNode = l1Children[0]
    const liftedTag = liftedNode.tags.find(t => t.tagValue === '无码')!

    // 验证 aggregateLiftedTags 显式打上了 isLifted: true
    expect(liftedTag.isLifted).toBe(true)

    // 验证 getAllKeys 会根据 tag.isLifted === true 正确生成 liftCode 键
    // （聚合行 codePath 保留最深分支主路径，key 第 4 段为 deepP 的 path: 消歧段）
    const allKeys = getAllKeys(scale3Tree)
    const liftedKeyItem = allKeys.find(
      item => item.key.includes('liftCode:builtin.image') && item.key.includes('::无码::path:')
    )
    expect(liftedKeyItem).toBeDefined()
    expect(liftedKeyItem!.key).toBe(makeTagKey(7, '无码', undefined, 'builtin.image', true, deepP))
  })

  it('AC-6: 刻度 2 树形态验证：全量标签平铺在顶层直属 tags 中，childTags 完全为 undefined，总深度严格为 2', () => {
    const scale2Tree = buildDimensionTree(collideGroups, null, null, 0, 2)
    expect(scale2Tree.length).toBe(1)
    const rootNode = scale2Tree[0]

    // 刻度 2 下：直属层已达最大视觉深度 2，深层标签全量提升平铺在 tags 中
    expect(rootNode.childTags).toBeUndefined()
    expect(rootNode.tags.map(t => t.tagValue)).toEqual(['图片', '漫画', '无码'])
  })

  it('AC-7 (用户场景): 刻度 2 外部细分维度与标签全量平铺提升至根维度：文件类型 ➔ 文档、语言细分、中文', () => {
    const fileTypeGroups: DimensionGroup[] = [
      {
        id: 1,
        name: '文件类型',
        code: 'builtin.file_type',
        level: 0,
        tags: [
          {
            dimensionId: 1,
            dimensionCode: 'builtin.file_type',
            dimensionName: '文件类型',
            tagValue: '文档',
            code: 'omw.document',
            fileCount: 15,
            isMultiSelect: false
          }
        ],
        isMultiSelect: false
      },
      {
        id: 11,
        name: '语言细分',
        code: 'builtin.language_segmentation',
        level: 1,
        parentDimensionIds: [1],
        triggerConditions: [
          { parentDimension: '文件类型', triggerTags: ['文档'] }
        ],
        tags: [
          {
            dimensionId: 11,
            dimensionCode: 'builtin.language_segmentation',
            dimensionName: '语言细分',
            tagValue: '中文',
            code: 'omw.chinese',
            fileCount: 10,
            isMultiSelect: false
          }
        ],
        isMultiSelect: false
      }
    ]

    // 1. 当刻度为 2 时：
    // 整棵树最大深度严格为 2，外部细分维度本身及其标签平铺提升至根维度直接展示
    const treeScale2 = buildDimensionTree(fileTypeGroups, null, null, 0, 2)
    expect(treeScale2.length).toBe(1)
    const rootNode = treeScale2[0]

    expect(rootNode.name).toBe('文件类型')
    expect(rootNode.childTags).toBeUndefined()
    // 平铺显示的树仅包含：文件类型/文档、文件类型/语言细分、文件类型/中文
    expect(rootNode.tags.map(t => t.tagValue)).toEqual(['文档', '语言细分', '中文'])
    expect(rootNode.tags.find(t => t.tagValue === '语言细分')!.isLifted).toBe(true)
    expect(rootNode.tags.find(t => t.tagValue === '中文')!.isLifted).toBe(true)

    // 2. 当刻度为 3 时：
    // 允许深度展开，文档作为直属标签，下挂外部细分维度「语言细分」及其标签「中文」
    const treeScale3 = buildDimensionTree(fileTypeGroups, null, null, 0, 3)
    expect(treeScale3.length).toBe(1)
    const rootNode3 = treeScale3[0]

    expect(rootNode3.tags.map(t => t.tagValue)).toEqual(['文档'])
    expect(rootNode3.childTags).toBeDefined()
    const docChildren = rootNode3.childTags!.get('文档')
    expect(docChildren).toBeDefined()
    expect(docChildren!.length).toBe(1)
    expect(docChildren![0].name).toBe('语言细分')
    expect(docChildren![0].tags.map(t => t.tagValue)).toEqual(['中文'])
  })

  it('AC-3: 前端跨层级重影物理消除 (深层具象优先，顶层同名/同Code重影被剔除)', () => {
    const group: DimensionGroup = {
      id: 28,
      name: '内容标签',
      code: 'builtin.content_tags',
      level: 0,
      tags: [],
      isMultiSelect: false
    }

    const tags: DimensionTag[] = [
      // 顶层直接子标签（历史浅层记录）
      {
        dimensionId: 28,
        dimensionCode: 'builtin.content_tags',
        dimensionName: '内容标签',
        tagValue: '要求',
        code: 'omw.00754942.v',
        viaParentCode: 'builtin.content_tags',
        level: 1,
        fileCount: 1,
        isMultiSelect: false
      },
      // 另一个合法的顶层标签（确保 directTags 过滤后依然有其他标签）
      {
        dimensionId: 28,
        dimensionCode: 'builtin.content_tags',
        dimensionName: '内容标签',
        tagValue: '传递',
        code: 'omw.00742320.v',
        viaParentCode: 'builtin.content_tags',
        level: 1,
        fileCount: 5,
        isMultiSelect: false
      },
      // 中间层节点：拜托
      {
        dimensionId: 28,
        dimensionCode: 'builtin.content_tags',
        dimensionName: '内容标签',
        tagValue: '拜托',
        code: 'omw.00752764.v',
        viaParentCode: 'omw.00742320.v',
        level: 2,
        fileCount: 3,
        isMultiSelect: false
      },
      // 深层子节点：要求（挂在拜托之下）
      {
        dimensionId: 28,
        dimensionCode: 'builtin.content_tags',
        dimensionName: '内容标签',
        tagValue: '要求',
        code: 'omw.00754942.v',
        viaParentCode: 'omw.00752764.v',
        level: 3,
        fileCount: 2,
        isMultiSelect: false
      }
    ]

    const { directTags, childTagsMap } = nestGroupTags(group, tags, 0, 6)

    // 1. 顶层 directTags 中已剔除「要求」，仅保留「传递」
    expect(directTags.map(t => t.tagValue)).toEqual(['传递'])
    expect(directTags.some(t => t.code === 'omw.00754942.v')).toBe(false)

    // 2. 「传递」展开后其 tags 包含「拜托」
    const transmitSubs = childTagsMap.get('传递')
    expect(transmitSubs).toBeDefined()
    expect(transmitSubs![0].tags.some(t => t.tagValue === '拜托')).toBe(true)

    // 3. 「拜托」下级节点包含深层具象的「要求」
    const begSubs = transmitSubs![0].childTags?.get('拜托')
    expect(begSubs).toBeDefined()
    expect(begSubs![0].tags.some(t => t.tagValue === '要求' && t.code === 'omw.00754942.v')).toBe(true)
  })

  it('AC-8 (Spec G9 / PRD-0058): 跨容器同码不同父与同名不同码隔离性，dimensionNodeKey 杜绝覆盖与合并', () => {
    // 1. 同码不同父：同一标签「漫画」(omw.06780678.n) 分别出现在「图片分类」与「电子书细分」下
    // 分别挂接不同的外部子维度（画面风格 vs 题材），断言互不覆盖、各自精准查出
    const mangaTagImg = {
      dimensionId: 1,
      dimensionCode: 'builtin.image',
      dimensionName: '图片分类',
      tagValue: '漫画',
      code: 'omw.06780678.n',
      fileCount: 10,
      isMultiSelect: false
    }
    const mangaTagEbook = {
      dimensionId: 2,
      dimensionCode: 'builtin.e_book_segmentation',
      dimensionName: '电子书细分',
      tagValue: '漫画',
      code: 'omw.06780678.n',
      fileCount: 5,
      isMultiSelect: false
    }

    const multiDomainGroups: DimensionGroup[] = [
      {
        id: 1,
        name: '图片分类',
        code: 'builtin.image',
        level: 0,
        tags: [mangaTagImg],
        isMultiSelect: false
      },
      {
        id: 2,
        name: '电子书细分',
        code: 'builtin.e_book_segmentation',
        level: 0,
        tags: [mangaTagEbook],
        isMultiSelect: false
      },
      {
        id: 121,
        name: '画面风格',
        code: 'builtin.art_style',
        level: 1,
        parentDimensionIds: [1],
        triggerConditions: [
          { parentDimension: '图片分类', triggerTags: ['漫画'] }
        ],
        tags: [
          {
            dimensionId: 121,
            dimensionCode: 'builtin.art_style',
            dimensionName: '画面风格',
            tagValue: '黑白',
            code: 'omw.monochrome',
            fileCount: 10,
            isMultiSelect: false
          }
        ],
        isMultiSelect: false
      },
      {
        id: 122,
        name: '题材',
        code: 'builtin.theme',
        level: 1,
        parentDimensionIds: [2],
        triggerConditions: [
          { parentDimension: '电子书细分', triggerTags: ['漫画'] }
        ],
        tags: [
          {
            dimensionId: 122,
            dimensionCode: 'builtin.theme',
            dimensionName: '题材',
            tagValue: '热血',
            code: 'omw.action',
            fileCount: 5,
            isMultiSelect: false
          }
        ],
        isMultiSelect: false
      }
    ]

    const tree = buildDimensionTree(multiDomainGroups, null, null, 0, 4)
    expect(tree.length).toBe(2)

    const imgRoot = tree.find(n => n.name === '图片分类')!
    expect(imgRoot).toBeDefined()
    expect(imgRoot.childTags).toBeDefined()
    // 图片分类下的漫画触发的是「画面风格」
    const imgMangaChildren = imgRoot.childTags!.get(dimensionNodeKey(imgRoot.code || imgRoot.name, mangaTagImg))
    expect(imgMangaChildren).toBeDefined()
    expect(imgMangaChildren!.length).toBe(1)
    expect(imgMangaChildren![0].name).toBe('画面风格')

    const ebookRoot = tree.find(n => n.name === '电子书细分')!
    expect(ebookRoot).toBeDefined()
    expect(ebookRoot.childTags).toBeDefined()
    // 电子书细分下的漫画触发的是「题材」
    const ebookMangaChildren = ebookRoot.childTags!.get(dimensionNodeKey(ebookRoot.code || ebookRoot.name, mangaTagEbook))
    expect(ebookMangaChildren).toBeDefined()
    expect(ebookMangaChildren!.length).toBe(1)
    expect(ebookMangaChildren![0].name).toBe('题材')

    // 核心断言：同码不同父互不覆盖、互不窜挂
    expect(imgRoot.childTags!.get(dimensionNodeKey(ebookRoot.code || ebookRoot.name, mangaTagEbook))).toBeUndefined()
    expect(ebookRoot.childTags!.get(dimensionNodeKey(imgRoot.code || imgRoot.name, mangaTagImg))).toBeUndefined()

    // 2. 同名不同码：同容器下两个展示名均为「小说」但机器码分别为 omw.06367879.n 与 omw.03833065.n
    const novelA = { tagValue: '小说', code: 'omw.06367879.n' }
    const novelB = { tagValue: '小说', code: 'omw.03833065.n' }
    const parentKey = 'builtin.e_book_segmentation'
    const keyA = dimensionNodeKey(parentKey, novelA)
    const keyB = dimensionNodeKey(parentKey, novelB)

    expect(keyA).toBe('builtin.e_book_segmentation::omw.06367879.n')
    expect(keyB).toBe('builtin.e_book_segmentation::omw.03833065.n')
    expect(keyA).not.toBe(keyB)

    // 在 DimensionChildTagsMap 中各存各的，互不覆盖
    const childMap = new DimensionChildTagsMap()
    childMap.set(keyA, [{ id: 101, name: '题材A', tags: [] } as any])
    childMap.set(keyB, [{ id: 102, name: '题材B', tags: [] } as any])

    expect(childMap.get(keyA)![0].name).toBe('题材A')
    expect(childMap.get(keyB)![0].name).toBe('题材B')
  })

  it('重现用户 Bug：多选模式下，文档下的德语和电子书下的德语被联动勾选', () => {
    const fileTypeGroups = [
      {
        id: 1,
        name: '文件类型',
        code: 'builtin.file_type',
        level: 0,
        tags: [
          {
            dimensionId: 1,
            dimensionCode: 'builtin.file_type',
            dimensionName: '文件类型',
            tagValue: '文档',
            code: 'omw.document',
            fileCount: 15,
            isMultiSelect: false
          },
          {
            dimensionId: 1,
            dimensionCode: 'builtin.file_type',
            dimensionName: '文件类型',
            tagValue: '电子书',
            code: 'omw.ebook',
            fileCount: 12,
            isMultiSelect: false
          }
        ],
        isMultiSelect: false
      },
      {
        id: 11,
        name: '语言细分',
        code: 'builtin.language_segmentation',
        level: 1,
        parentDimensionIds: [1],
        triggerConditions: [
          { parentDimension: '文件类型', triggerTags: ['文档', '电子书'] }
        ],
        tags: [
          {
            dimensionId: 11,
            dimensionCode: 'builtin.language_segmentation',
            dimensionName: '语言细分',
            tagValue: '德语',
            code: 'omw.german',
            fileCount: 5,
            viaParentCode: 'builtin.language_segmentation',
            isMultiSelect: false
          }
        ],
        isMultiSelect: false
      }
    ];

    const tree = buildDimensionTree(fileTypeGroups, null, null, 0, 3);
    const docLangDim = tree[0].childTags.get('文档')[0];
    const ebookLangDim = tree[0].childTags.get('电子书')[0];

    const docGerman = docLangDim.tags.find(t => t.tagValue === '德语');
    const ebookGerman = ebookLangDim.tags.find(t => t.tagValue === '德语');

    const docKey = makeTagKey(
      docGerman.dimensionId,
      docGerman.tagValue,
      '文档',
      docGerman.viaParentCode,
      docGerman.isLifted === true,
      docGerman.codePath
    );

    const ebookKey = makeTagKey(
      ebookGerman.dimensionId,
      ebookGerman.tagValue,
      '电子书',
      ebookGerman.viaParentCode,
      ebookGerman.isLifted === true,
      ebookGerman.codePath
    );

    console.log('Doc German Key:', docKey);
    console.log('Ebook German Key:', ebookKey);

    expect(docKey).not.toBe(ebookKey);
  });

  it('多选模式受控宿主码消歧：使用 hostScopeCode (如 omw.document) 免疫多语言切换，且正确透传至 SelectedTag', () => {
    const docKey = makeTagKey(
      11,
      '德语',
      '文档',
      'builtin.language_segmentation',
      false,
      undefined,
      'omw.document'
    )
    const ebookKey = makeTagKey(
      11,
      '德语',
      '电子书',
      'builtin.language_segmentation',
      false,
      undefined,
      'omw.ebook'
    )

    expect(docKey).toBe('11::parentCode:builtin.language_segmentation@omw.document::德语')
    expect(ebookKey).toBe('11::parentCode:builtin.language_segmentation@omw.ebook::德语')
    expect(docKey).not.toBe(ebookKey)

    const parsed = parseTagKey(docKey)
    expect(parsed.hostScopeCode).toBe('omw.document')
    expect(parsed.parentTagValue).toBe('omw.document')

    const dummyGroups: DimensionGroup[] = [
      {
        id: 11,
        name: '语言细分',
        code: 'builtin.language_segmentation',
        level: 1,
        tags: [
          {
            dimensionId: 11,
            tagValue: '德语',
            code: 'omw.german',
            viaParentCode: 'builtin.language_segmentation',
            fileCount: 3
          }
        ]
      }
    ]

    const selectedList = getSelectedTagsFromSet(new Set([docKey]), dummyGroups)
    expect(selectedList.length).toBe(1)
    expect(selectedList[0].tagValue).toBe('德语')
    expect(selectedList[0].hostScopeCode).toBe('omw.document')
  })
});

describe('PRD-0058 / Branch Dimension Node Isolation & Count SSOT - 跨分支同名叶子节点隔离与徽标计数一致性测试', () => {
  it('AC-1 & AC-3: buildDimensionTree 补齐中间维度码，并通过 pathCountMap 回填各分支独立精确计数', () => {
    // 构造文件类型根维度组（文档 vs 电子书）
    const fileTypeGroup: DimensionGroup = {
      id: 1,
      name: '文件类型',
      code: 'builtin.file_type',
      level: 0,
      tags: [
        {
          dimensionId: 1,
          dimensionCode: 'builtin.file_type',
          dimensionName: '文件类型',
          tagValue: '文档',
          code: 'builtin.document',
          codePath: '/builtin.file_type/builtin.document',
          namePath: '/文件类型/文档',
          level: 1,
          fileCount: 1
        },
        {
          dimensionId: 1,
          dimensionCode: 'builtin.file_type',
          dimensionName: '文件类型',
          tagValue: '电子书',
          code: 'builtin.e_book',
          codePath: '/builtin.file_type/builtin.e_book',
          namePath: '/文件类型/电子书',
          level: 1,
          fileCount: 1
        }
      ]
    }

    // 构造外部细分维度组（语言细分 -> 英文，全局 count 为 3）
    const langGroup: DimensionGroup = {
      id: 11,
      name: '语言细分',
      code: 'builtin.language_segmentation',
      level: 1,
      parentDimensionIds: [1],
      tags: [
        {
          dimensionId: 11,
          dimensionCode: 'builtin.language_segmentation',
          dimensionName: '语言细分',
          tagValue: '英文',
          code: 'omw.06912865.n',
          viaParentCode: 'builtin.language_segmentation',
          level: 1,
          fileCount: 3 // 后端全局粗汇总值
        }
      ]
    }

    // 后端下发的各分支前缀精准命中计数映射（SSOT）
    const pathCountMap: Record<string, number> = {
      '/builtin.file_type/builtin.document': 1,
      '/builtin.file_type/builtin.document/builtin.language_segmentation': 1,
      '/builtin.file_type/builtin.document/builtin.language_segmentation/omw.06912865.n': 1,
      '/builtin.file_type/builtin.e_book': 1,
      '/builtin.file_type/builtin.e_book/builtin.language_segmentation': 1,
      '/builtin.file_type/builtin.e_book/builtin.language_segmentation/omw.06912865.n': 1
    }

    const tree = buildDimensionTree([fileTypeGroup, langGroup], null, null, 0, 7, pathCountMap)
    expect(tree.length).toBe(1)
    const ftNode = tree[0]
    expect(ftNode.childTags).toBeDefined()

    // 1. 文档分支下的语言细分
    const docChildren = ftNode.childTags!.get('builtin.file_type::builtin.document')
    expect(docChildren).toBeDefined()
    expect(docChildren!.length).toBe(1)
    const docLangDim = docChildren![0]
    expect(docLangDim.tags.length).toBe(1)
    const docEnglish = docLangDim.tags[0]
    expect(docEnglish.codePath).toBe('/builtin.file_type/builtin.document/builtin.language_segmentation/omw.06912865.n')
    expect(docEnglish.namePath).toBe('/文件类型/文档/语言细分/英文')
    expect(docEnglish.hostScopeCode).toBe('builtin.document')
    // 关键断言：徽标计数不再是全局污染的 3，而是通过 pathCountMap 精准回填的 1！
    expect(docEnglish.fileCount).toBe(1)

    // 2. 电子书分支下的语言细分
    const ebookChildren = ftNode.childTags!.get('builtin.file_type::builtin.e_book')
    expect(ebookChildren).toBeDefined()
    expect(ebookChildren!.length).toBe(1)
    const ebookLangDim = ebookChildren![0]
    expect(ebookLangDim.tags.length).toBe(1)
    const ebookEnglish = ebookLangDim.tags[0]
    expect(ebookEnglish.codePath).toBe('/builtin.file_type/builtin.e_book/builtin.language_segmentation/omw.06912865.n')
    expect(ebookEnglish.namePath).toBe('/文件类型/电子书/语言细分/英文')
    expect(ebookEnglish.hostScopeCode).toBe('builtin.e_book')
    // 关键断言：电子书分支下的徽标也是精准的 1！
    expect(ebookEnglish.fileCount).toBe(1)

    // 3. 两分支下的节点互斥消歧断言
    expect(docEnglish.codePath).not.toBe(ebookEnglish.codePath)
    expect(docEnglish.hostScopeCode).not.toBe(ebookEnglish.hostScopeCode)

    const docKey = makeTagKey(
      docEnglish.dimensionId,
      docEnglish.tagValue,
      undefined,
      docEnglish.viaParentCode || undefined,
      false,
      docEnglish.codePath,
      docEnglish.hostScopeCode
    )
    const ebookKey = makeTagKey(
      ebookEnglish.dimensionId,
      ebookEnglish.tagValue,
      undefined,
      ebookEnglish.viaParentCode || undefined,
      false,
      ebookEnglish.codePath,
      ebookEnglish.hostScopeCode
    )
    expect(docKey).not.toBe(ebookKey)
    expect(docKey).toContain(docEnglish.codePath!)
    expect(ebookKey).toContain(ebookEnglish.codePath!)
  })

  it('ISS-03 & 细节 1: 提升行 makeTagKey 保留 hostScopeCode 且 parseTagKey 逆向提取对称', () => {
    // 提升行无 codePath 时生成 key
    const liftedKey = makeTagKey(
      11,
      '英文',
      undefined,
      'builtin.language_segmentation',
      true, // isLifted
      undefined,
      'builtin.document' // hostScopeCode
    )
    expect(liftedKey).toBe('11::liftCode:builtin.language_segmentation@builtin.document::英文')

    const parsed = parseTagKey(liftedKey)
    expect(parsed.dimensionId).toBe(11)
    expect(parsed.isLifted).toBe(true)
    expect(parsed.viaParentCode).toBe('builtin.language_segmentation')
    expect(parsed.hostScopeCode).toBe('builtin.document')
    expect(parsed.tagValue).toBe('英文')
  })

  it('ISS-03 & 细节 2: 刻度收缩提升聚合行取父分支前缀去重并集计数', () => {
    const fileTypeGroup: DimensionGroup = {
      id: 1,
      name: '文件类型',
      code: 'builtin.file_type',
      level: 0,
      tags: [
        {
          dimensionId: 1,
          dimensionCode: 'builtin.file_type',
          dimensionName: '文件类型',
          tagValue: '文档',
          code: 'builtin.document',
          codePath: '/builtin.file_type/builtin.document',
          namePath: '/文件类型/文档',
          level: 1,
          fileCount: 2
        }
      ]
    }

    const langGroup: DimensionGroup = {
      id: 11,
      name: '语言细分',
      code: 'builtin.language_segmentation',
      level: 1,
      parentDimensionIds: [1],
      tags: [
        {
          dimensionId: 11,
          dimensionCode: 'builtin.language_segmentation',
          dimensionName: '语言细分',
          tagValue: '英文',
          code: 'omw.06912865.n',
          viaParentCode: 'builtin.language_segmentation',
          level: 1,
          fileCount: 2
        },
        {
          dimensionId: 11,
          dimensionCode: 'builtin.language_segmentation',
          dimensionName: '语言细分',
          tagValue: '中文',
          code: 'omw.06912866.n',
          viaParentCode: 'builtin.language_segmentation',
          level: 1,
          fileCount: 2
        }
      ]
    }

    // 假设同一个文件同时有中英文，父分支去重后只有 2 个文件（而非 2+2=4）
    const pathCountMap: Record<string, number> = {
      '/builtin.file_type/builtin.document': 2,
      '/builtin.file_type/builtin.document/builtin.language_segmentation': 2,
      '/builtin.file_type/builtin.document/builtin.language_segmentation/omw.06912865.n': 2,
      '/builtin.file_type/builtin.document/builtin.language_segmentation/omw.06912866.n': 2
    }

    // 设置 maxScaleDepth = 2，强制外部子维度提升平铺
    const tree = buildDimensionTree([fileTypeGroup, langGroup], null, null, 0, 2, pathCountMap)
    expect(tree.length).toBe(1)
    const ftNode = tree[0]
    // 提升后的标签直接平铺在 tags 中
    const liftedDimTag = ftNode.tags.find(t => t.tagValue === '语言细分')
    expect(liftedDimTag).toBeDefined()
    expect(liftedDimTag!.isLifted).toBe(true)
    expect(liftedDimTag!.codePath).toBe('/builtin.file_type/builtin.document/builtin.language_segmentation')
    // 关键断言：提升聚合行的计数取父分支去重后的 2（而非累加的 4）！
    expect(liftedDimTag!.fileCount).toBe(2)
  })
});
