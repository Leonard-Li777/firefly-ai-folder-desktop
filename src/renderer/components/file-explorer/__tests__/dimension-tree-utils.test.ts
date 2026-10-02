import { describe, it, expect } from 'vitest'
import { nestGroupTags } from '../dimension-tree-utils'
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
