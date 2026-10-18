import { describe, it, expect, beforeEach } from 'vitest'
import { useVirtualDirectoryStore } from '../virtual-directory-store'
import type { DimensionGroup } from '@firefly/types'

const CONTENT_TAGS_CODE = 'builtin.content_tags'

/**
 * 构造 TagTreeQuery 注入路径（S0-c 修正后）产出的内容标签维度组：
 * - 组级 / 标签级 isMultiSelect 均为 true
 * - 「海报」为一级节点，「海报设计」挂在其下（二级），另有「插画」为一级兄弟
 */
const buildContentGroup = (isMultiSelect: boolean): DimensionGroup =>
  ({
    id: 28,
    name: '内容标签',
    level: 0,
    code: CONTENT_TAGS_CODE,
    order: 9999,
    isMultiSelect,
    meta: { source: 'builtin', order: 9999, isMultiSelect },
    metadata: { isPanDimension: true, source: 'builtin', order: 9999, isMultiSelect },
    tags: [
      {
        dimensionId: 28,
        dimensionCode: CONTENT_TAGS_CODE,
        dimensionName: '内容标签',
        tagValue: '海报',
        fileCount: 2,
        level: 1,
        code: '_ext.haibao',
        codePath: `/${CONTENT_TAGS_CODE}/_ext.haibao`,
        namePath: `/内容标签/海报`,
        viaParentCode: CONTENT_TAGS_CODE,
        isMultiSelect,
        order: 9999
      },
      {
        dimensionId: 28,
        dimensionCode: CONTENT_TAGS_CODE,
        dimensionName: '内容标签',
        tagValue: '海报设计',
        fileCount: 1,
        level: 2,
        code: '_ext.haibao_sheji',
        codePath: `/${CONTENT_TAGS_CODE}/_ext.haibao/_ext.haibao_sheji`,
        namePath: `/内容标签/海报/海报设计`,
        viaParentCode: '_ext.haibao',
        isMultiSelect,
        order: 9999
      },
      {
        dimensionId: 28,
        dimensionCode: CONTENT_TAGS_CODE,
        dimensionName: '内容标签',
        tagValue: '海报排版',
        fileCount: 1,
        level: 2,
        code: '_ext.haibao_paiban',
        codePath: `/${CONTENT_TAGS_CODE}/_ext.haibao/_ext.haibao_paiban`,
        namePath: `/内容标签/海报/海报排版`,
        viaParentCode: '_ext.haibao',
        isMultiSelect,
        order: 9999
      },
      {
        dimensionId: 28,
        dimensionCode: CONTENT_TAGS_CODE,
        dimensionName: '内容标签',
        tagValue: '插画',
        fileCount: 1,
        level: 1,
        code: '_ext.chahua',
        codePath: `/${CONTENT_TAGS_CODE}/_ext.chahua`,
        namePath: `/内容标签/插画`,
        viaParentCode: CONTENT_TAGS_CODE,
        isMultiSelect,
        order: 9999
      }
    ]
  }) as unknown as DimensionGroup

const selectedOf = () => Array.from(useVirtualDirectoryStore.getState().selectedTagCodes)

describe('S0-c 护栏（U6）：内容标签在虚拟树中同父两标签可共存', () => {
  beforeEach(() => {
    // setCurrentWorkspaceDirectory(null) 会重置选中态
    useVirtualDirectoryStore.getState().setCurrentWorkspaceDirectory(null)
    useVirtualDirectoryStore.getState().setDimensionGroups([])
  })

  it('修正后（isMultiSelect: true）：一级兄弟与二级同父节点均可共存', () => {
    const store = useVirtualDirectoryStore.getState()
    store.setDimensionGroups([buildContentGroup(true)])

    // 一级兄弟（父节点 = 内容标签维度根，根 isMultiSelect 来自组级）
    store.selectTag('_ext.haibao')
    store.selectTag('_ext.chahua')
    expect(selectedOf().sort()).toEqual(['_ext.chahua', '_ext.haibao'])

    // 二级同父（父节点 = 「海报」，其 isMultiSelect 来自标签级）
    store.selectTag('_ext.haibao_sheji')
    store.selectTag('_ext.haibao_paiban')
    expect(selectedOf()).toContain('_ext.haibao')
    expect(selectedOf()).toContain('_ext.haibao_sheji')
    expect(selectedOf()).toContain('_ext.haibao_paiban')
  })

  it('反向对照（isMultiSelect: false，即 S0-c 修正前）：同父第二个选择会原子化反选第一个', () => {
    const store = useVirtualDirectoryStore.getState()
    store.setDimensionGroups([buildContentGroup(false)])

    store.selectTag('_ext.haibao')
    store.selectTag('_ext.chahua')
    // 旧行为：一级兄弟被互斥清掉，只剩后选中的
    expect(selectedOf()).toEqual(['_ext.chahua'])

    useVirtualDirectoryStore.getState().setCurrentWorkspaceDirectory(null)
    useVirtualDirectoryStore.getState().setDimensionGroups([buildContentGroup(false)])
    const store2 = useVirtualDirectoryStore.getState()
    store2.selectTag('_ext.haibao_sheji')
    store2.selectTag('_ext.haibao_paiban')
    // 旧行为：二级同父兄弟也互斥
    expect(selectedOf()).toEqual(['_ext.haibao_paiban'])
  })
})
