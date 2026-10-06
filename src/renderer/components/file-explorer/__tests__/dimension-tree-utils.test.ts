import { describe, it, expect } from 'vitest'
import {
  nestGroupTags,
  makeTagKey,
  parseTagKey,
  buildDimensionTree,
  getVisibleAndHiddenTags,
  getSelectedTagsFromSet
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

  it('深度刻度 2 时：博物馆穿透提升到文化场馆节点下', () => {
    const { directTags, childTagsMap } = nestGroupTags(contentGroup, sampleTags, 0, 2)

    expect(directTags.length).toBe(1)
    expect(directTags[0].tagValue).toBe('建筑空间')

    const l1Children = childTagsMap.get('建筑空间')
    expect(l1Children).toBeDefined()
    const l1Node = l1Children![0]
    expect(l1Node.name).toBe('建筑空间')

    // 在深度 2 下：文化场馆展开为二级节点
    expect(l1Node.childTags).toBeDefined()
    const l2Children = l1Node.childTags!.get('文化场馆')
    expect(l2Children).toBeDefined()
    const l2Node = l2Children![0]
    expect(l2Node.name).toBe('文化场馆')

    // 达到深度 2 限制，博物馆穿透提升挂载在文化场馆节点中
    expect(l2Node.childTags).toBeUndefined()
    expect(l2Node.tags.some(t => t.tagValue === '博物馆')).toBe(true)
  })

  it('深度刻度 1 时：文化场馆与博物馆穿透提升到建筑空间下', () => {
    const { directTags, childTagsMap } = nestGroupTags(contentGroup, sampleTags, 0, 1)

    expect(directTags.length).toBe(1)
    expect(directTags[0].tagValue).toBe('建筑空间')

    const l1Children = childTagsMap.get('建筑空间')
    expect(l1Children).toBeDefined()
    const l1Node = l1Children![0]
    expect(l1Node.name).toBe('建筑空间')

    // 达到深度 1 限制，文化场馆与博物馆均穿透提升挂载在建筑空间节点中
    expect(l1Node.childTags).toBeUndefined()
    expect(l1Node.tags.some(t => t.tagValue === '文化场馆')).toBe(true)
    expect(l1Node.tags.some(t => t.tagValue === '博物馆')).toBe(true)
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
})

