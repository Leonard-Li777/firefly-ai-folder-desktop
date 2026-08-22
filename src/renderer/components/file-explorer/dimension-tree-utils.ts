import { DimensionGroup, DimensionTag, SelectedTag } from '@firefly/types'
import { DimensionTreeNode } from './AnalyzedDirectory/types'

/**
 * 生成标签唯一 key（包含父标签路径以区分同名标签）
 */
export function makeTagKey(dimensionId: number, tagValue: string, parentTagValue?: string): string {
  return `${dimensionId}::${parentTagValue || ''}::${tagValue}`
}

/**
 * 从 key 中解析出各部分
 */
export function parseTagKey(key: string) {
  const parts = key.split('::')
  return {
    dimensionId: parseInt(parts[0], 10),
    parentTagValue: parts[1] || undefined,
    tagValue: parts.slice(2).join('::')
  }
}

/**
 * 递归构建维度树（支持基于 triggerTags 的细粒度层级）
 */
export function buildDimensionTree(
  dimensionGroups: DimensionGroup[],
  parentId: number | null = null,
  parentTag: string | null = null,
  level = 0
): DimensionTreeNode[] {
  // 预构建 parentId → groups 查找表和 hasChildren 集合，消除 O(n²)
  const map = new Map<number | null, DimensionGroup[]>()
  const childrenSet = new Set<number>()
  dimensionGroups.forEach(g => {
    if (!g.triggerConditions || g.triggerConditions.length === 0) {
      const list = map.get(null) || []
      list.push(g)
      map.set(null, list)
    }
    if (g.parentDimensionIds) {
      g.parentDimensionIds.forEach(pid => {
        const list = map.get(pid) || []
        list.push(g)
        map.set(pid, list)
        childrenSet.add(pid)
      })
    }
  })

  const recurse = (
    pId: number | null = null,
    pTag: string | null = null,
    lvl = 0
  ): DimensionTreeNode[] => {
    const currentLevelGroups = (map.get(pId) || []).filter(group => {
      if (pTag && group.triggerConditions) {
        const parentDimension = dimensionGroups.find(g => g.id === pId)
        if (!parentDimension) return false

        const matchingCondition = group.triggerConditions.find(
          tc => tc.parentDimension === parentDimension.name
        )
        if (matchingCondition) {
          return matchingCondition.triggerTags?.includes(pTag)
        }
      }
      return true
    })

    return currentLevelGroups
      .map(group => {
        const hasChildren = childrenSet.has(group.id)

        let childTags: Map<string, DimensionTreeNode[]> | undefined
        if (hasChildren) {
          childTags = new Map()
          group.tags.forEach(tag => {
            const children = recurse(group.id, tag.tagValue, lvl + 1)
            if (children.length > 0) {
              childTags!.set(tag.tagValue, children)
            }
          })
        }

        return {
          ...group,
          level: lvl,
          childTags
        } as DimensionTreeNode
      })
      .sort((a, b) => {
        if (a.id === 28) return 1
        if (b.id === 28) return -1
        return a.level - b.level
      })
  }

  return recurse(parentId, parentTag, level)
}

/**
 * 过滤函数：获取可见与不可见标签
 */
export function getVisibleAndHiddenTags(
  group: DimensionGroup,
  showEmptyTags: boolean,
  panDimensionIds: number[],
  childTags?: Map<string, DimensionTreeNode[]>
) {
  let visibleTags = group.tags.filter((tag: DimensionTag) => tag.fileCount > 0)
  const hiddenTags = group.tags.filter((tag: DimensionTag) => tag.fileCount === 0)

  if (childTags) {
    hiddenTags.forEach(tag => {
      const children = childTags.get(tag.tagValue)
      if (
        children &&
        children.some(child => {
          let childTagsToInspect = child.tags
          if (child.contextualTags && child.contextualTags[tag.tagValue]) {
            const isL3Ext = /扩展名|Extension/i.test(child.name)
            if (!isL3Ext) {
              childTagsToInspect = child.contextualTags[tag.tagValue]
            }
          }
          return childTagsToInspect && childTagsToInspect.some(t => t.fileCount > 0)
        })
      ) {
        visibleTags.push(tag)
      }
    })
  }

  if (panDimensionIds.includes(group.id)) {
    visibleTags = visibleTags.sort((a, b) => b.fileCount - a.fileCount)
  }

  const tagsToShow = showEmptyTags ? group.tags : visibleTags

  return {
    visibleTags,
    hiddenTags,
    tagsToShow
  }
}

/**
 * 辅助函数：将 Set 格式的 tag 键转为 SelectedTag 对象数组
 */
export function getSelectedTagsFromSet(
  selectedTagsSet: Set<string>,
  dimensionGroups: DimensionGroup[],
  parentTagMap?: Map<string, string[]>
): SelectedTag[] {
  // 构建维度组与标签的快速 Lookup Map，避免每个 key 都执行 find 遍历
  const groupMap = new Map<number, DimensionGroup>()
  const tagObjMap = new Map<string, { level: number }>()

  dimensionGroups.forEach(g => {
    groupMap.set(g.id, g)
    g.tags.forEach(t => {
      tagObjMap.set(`${g.id}::${t.tagValue}`, t)
    })
  })

  return Array.from(selectedTagsSet).map(key => {
    const parsed = parseTagKey(key)
    const { dimensionId, tagValue, parentTagValue: keyParentTagValue } = parsed
    const group = groupMap.get(dimensionId)
    const tagObj = tagObjMap.get(`${dimensionId}::${tagValue}`)
    const ancestorChain = parentTagMap?.get(key)
    const parentTagValue =
      keyParentTagValue ||
      (ancestorChain && ancestorChain.length > 1
        ? ancestorChain[ancestorChain.length - 2]
        : undefined)
    return {
      dimensionId,
      dimensionName: group?.name || '',
      tagValue,
      level: tagObj?.level || 0,
      ...(parentTagValue ? { parentTagValue } : {}),
      ...(ancestorChain && ancestorChain.length > 0 ? { ancestorChain } : {})
    }
  })
}
