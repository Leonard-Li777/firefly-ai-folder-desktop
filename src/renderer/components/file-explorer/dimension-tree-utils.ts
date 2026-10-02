import { DimensionGroup, DimensionTag, SelectedTag } from '@firefly/types'
import { isPanDimension } from '@firefly/shared'
import { DimensionTreeNode } from './AnalyzedDirectory/types'

/**
 * 生成标签唯一 key（包含父标签标识以区分同名标签，V4 优先由 viaParentCode 驱动）
 */
export function makeTagKey(dimensionId: number, tagValue: string, parentTagValue?: string, viaParentCode?: string): string {
  const parentIdStr = viaParentCode ? `parentCode:${viaParentCode}` : (parentTagValue || '')
  return `${dimensionId}::${parentIdStr}::${tagValue}`
}

/**
 * 从 key 中解析出各部分
 */
export function parseTagKey(key: string) {
  const parts = key.split('::')
  const parentPart = parts[1] || ''
  const isParentCode = parentPart.startsWith('parentCode:')
  const viaParent = isParentCode ? parentPart.replace('parentCode:', '') : undefined
  return {
    dimensionId: parseInt(parts[0], 10),
    parentTagValue: isParentCode ? undefined : (parentPart || undefined),
    viaParentCode: viaParent,
    tagValue: parts.slice(2).join('::')
  }
}

/**
 * 顶层主干排序权重接口
 */
export interface SortWeightNode {
  id?: number | string
  code?: string
  name?: string
  tagValue?: string
  level?: number
  order?: number
  sort_order?: number
  fileCount?: number
  omwCount?: number
  tags?: Array<{ fileCount?: number; omwCount?: number; [key: string]: any }>
  meta?: any
  metadata?: any
  [key: string]: any
}

/**
 * 提取主干节点的三级权重元组：
 * 1. order: 内置顺序（升序优先，如 1 < 2 < 3）
 * 2. fileCount: 关联文件数（降序优先）
 * 3. omwCount: 语言学词频（降序优先）
 */
export function getTopLevelSortWeight(node: SortWeightNode): {
  hasOrder: boolean
  order: number
  fileCount: number
  omwCount: number
} {
  // 1. 内置 order 提取
  let orderVal: number | undefined = undefined

  // 1.1 直接属性
  if (typeof node.order === 'number' && Number.isFinite(node.order)) {
    orderVal = node.order
  } else if (typeof node.sort_order === 'number' && Number.isFinite(node.sort_order)) {
    orderVal = node.sort_order
  }

  // 1.2 meta 或 metadata 属性
  const metaObj =
    typeof node.meta === 'object' && node.meta !== null
      ? node.meta
      : typeof node.metadata === 'object' && node.metadata !== null
        ? node.metadata
        : typeof node.meta === 'string'
          ? (() => {
              try {
                return JSON.parse(node.meta)
              } catch {
                return null
              }
            })()
          : null

  if (orderVal === undefined && metaObj) {
    if (typeof metaObj.order === 'number' && Number.isFinite(metaObj.order)) {
      orderVal = metaObj.order
    } else if (typeof metaObj.sort_order === 'number' && Number.isFinite(metaObj.sort_order)) {
      orderVal = metaObj.sort_order
    }
  }

  // 1.3 针对老版本内置维度 ID (例如 id: 1 为文件类型) 且为 builtin 维度的回退支持
  if (
    orderVal === undefined &&
    typeof node.id === 'number' &&
    Number.isFinite(node.id) &&
    node.id > 0 &&
    (node.code?.startsWith('builtin.') ||
      metaObj?.source === 'builtin' ||
      node.code?.startsWith('dim.'))
  ) {
    orderVal = node.id
  }

  const hasOrder = orderVal !== undefined && Number.isFinite(orderVal)
  const order = hasOrder ? (orderVal as number) : Infinity

  // 2. fileCount 文件关联数提取（降序）
  let fileCount = 0
  if (typeof node.fileCount === 'number' && Number.isFinite(node.fileCount)) {
    fileCount = node.fileCount
  } else if (Array.isArray(node.tags) && node.tags.length > 0) {
    fileCount = node.tags.reduce((acc, t) => {
      const c = typeof t.fileCount === 'number' && Number.isFinite(t.fileCount) ? t.fileCount : 0
      return acc + c
    }, 0)
  }

  // 3. omwCount 词频提取（降序）
  let omwCount = 0
  if (typeof node.omwCount === 'number' && Number.isFinite(node.omwCount)) {
    omwCount = node.omwCount
  } else if (metaObj && typeof metaObj.count === 'number' && Number.isFinite(metaObj.count)) {
    omwCount = metaObj.count
  } else if (Array.isArray(node.tags) && node.tags.length > 0) {
    // 若组未直接标注词频，取其 tags 中的最高词频
    omwCount = node.tags.reduce((max, t) => {
      const tc =
        typeof t.omwCount === 'number' && Number.isFinite(t.omwCount)
          ? t.omwCount
          : t.meta && typeof t.meta.count === 'number' && Number.isFinite(t.meta.count)
            ? t.meta.count
            : 0
      return tc > max ? tc : max
    }, 0)
  }

  return {
    hasOrder,
    order,
    fileCount,
    omwCount
  }
}

/**
 * 顶层主干比较函数（严格执行三级动态权重排序）：
 * SortWeight = <builtin.meta.order (升序), file_count (降序), omw.meta.count (降序)>
 */
export function compareTopLevelNodes(a: SortWeightNode, b: SortWeightNode): number {
  const wA = getTopLevelSortWeight(a)
  const wB = getTopLevelSortWeight(b)

  // 优先级 1（最高）：builtin.meta.order 升序优先（如 1 < 2 < 3）
  if (wA.hasOrder && wB.hasOrder) {
    if (wA.order !== wB.order) {
      return wA.order - wB.order
    }
  } else if (wA.hasOrder) {
    return -1
  } else if (wB.hasOrder) {
    return 1
  }

  // 优先级 2：关联文件数 file_count 降序（越高越靠前）
  if (wB.fileCount !== wA.fileCount) {
    return wB.fileCount - wA.fileCount
  }

  // 优先级 3：语言学词频 omw.meta.count 降序（越大越靠前）
  if (wB.omwCount !== wA.omwCount) {
    return wB.omwCount - wA.omwCount
  }

  // 优先级 4（兜底）：按名称/代码稳定字母序升序排列
  const labelA = a.name || a.tagValue || a.code || String(a.id ?? '')
  const labelB = b.name || b.tagValue || b.code || String(b.id ?? '')
  return labelA.localeCompare(labelB)
}

/**
 * 顶层主干数组动态排序
 */
export function sortTopLevelDimensionNodes<T extends SortWeightNode>(nodes: T[]): T[] {
  return [...nodes].sort(compareTopLevelNodes)
}

/**
 * 递归将组内的扁平标签集合（带有 level 和 viaParentCode）拆解为多级树形结构
 */
export function nestGroupTags(
  group: DimensionGroup,
  tags: DimensionTag[],
  level: number,
  maxScaleDepth: number = 3
): { directTags: DimensionTag[]; childTagsMap: Map<string, DimensionTreeNode[]> } {
  const childTagsMap = new Map<string, DimensionTreeNode[]>()
  if (!tags || tags.length === 0) {
    return { directTags: [], childTagsMap }
  }

  // 1. 构建 code -> tag 与 tagValue -> tag 快速索引
  const tagByCode = new Map<string, DimensionTag>()
  const tagByName = new Map<string, DimensionTag>()
  const tagsByParent = new Map<string, DimensionTag[]>()

  for (const t of tags) {
    if (t.code) tagByCode.set(t.code, t)
    if (t.tagValue) tagByName.set(t.tagValue, t)
  }

  // 2. 根据 viaParentCode 归类子标签（双向登记父节点的 code 与 tagValue 索引）
  for (const t of tags) {
    const parentKey = t.viaParentCode
    if (!parentKey) continue
    const parentByCode = tagByCode.get(parentKey)
    const parentByName = tagByName.get(parentKey)
    const effectiveParent = parentByCode || parentByName
    if (effectiveParent) {
      const pKeys = new Set([parentKey, effectiveParent.code, effectiveParent.tagValue].filter(Boolean) as string[])
      for (const pk of pKeys) {
        const list = tagsByParent.get(pk) || []
        if (!list.includes(t)) {
          list.push(t)
          tagsByParent.set(pk, list)
        }
      }
    }
  }

  // 3. 确定当前层级的直属标签 (directTags)：
  // 顶层直属标签优先由 level === 1 或 viaParentCode === group.code 确定
  const directTags: DimensionTag[] = []
  for (const t of tags) {
    const parentKey = t.viaParentCode
    const isLevel1 = t.level === 1 || parentKey === group.code || (!parentKey && (!t.level || t.level <= 1))
    if (isLevel1) {
      directTags.push(t)
    }
  }

  // 若没有明确的 level 1 标签，兜底寻找最小 level 或无父级标签作为直属
  if (directTags.length === 0) {
    const minLevel = tags.reduce((min, t) => Math.min(min, t.level ?? 1), Infinity)
    for (const t of tags) {
      if ((t.level ?? 1) === minLevel) {
        directTags.push(t)
      }
    }
    if (directTags.length === 0) {
      directTags.push(...tags)
    }
  }

  // 递归收集任意父标签下的所有深层子孙标签（用于穿透提升，执行 Code 与名称双重去重）
  function getAllDescendantTags(startTag: DimensionTag): DimensionTag[] {
    const result: DimensionTag[] = []
    const visitedCodes = new Set<string>()
    const visitedNames = new Set<string>()

    function collectAll(curr: DimensionTag) {
      const keys = [curr.code, curr.tagValue].filter(Boolean) as string[]
      for (const k of keys) {
        const children = tagsByParent.get(k) || []
        for (const child of children) {
          const code = child.code || ''
          const name = child.tagValue || ''
          if (visitedCodes.has(code) || (name && visitedNames.has(name))) {
            continue
          }
          if (code === curr.code || (name && name === curr.tagValue)) {
            continue
          }
          if (code) visitedCodes.add(code)
          if (name) visitedNames.add(name)
          result.push(child)
          collectAll(child)
        }
      }
    }

    collectAll(startTag)
    return result
  }

  // 4. 递归根据 tagsByParent 构建深层多级子树（支持 ADR-0034 §4 刻度穿透提升）
  function buildChildNode(parentTag: DimensionTag, currentDepth: number): DimensionTreeNode | null {
    // 若当前层级深度达到或超过用户设定的刻度上限，则所有更深层子孙标签穿透提升（Pass-through Lift-up），
    // 汇聚挂载在当前刻度父级节点下，且该层不再向下生成更深层孙级节点 (ADR-0034 §4)
    if (currentDepth >= maxScaleDepth) {
      const descendants = getAllDescendantTags(parentTag)
      if (descendants.length === 0) return null

      // 双重去重，优先保留有命中文件的标签或叶子标签
      const seenLifted = new Set<string>()
      const liftedTags: DimensionTag[] = []
      for (const d of descendants) {
        const key = d.code || d.tagValue
        if (!seenLifted.has(key)) {
          seenLifted.add(key)
          liftedTags.push({
            ...d,
            viaParentCode: parentTag.code || parentTag.tagValue,
            level: currentDepth + 1
          })
        }
      }

      return {
        id: group.id * 10000 + currentDepth * 100 + (parentTag.order || 1),
        name: parentTag.tagValue,
        code: parentTag.code || `${group.code || group.id}.${parentTag.tagValue}`,
        level: currentDepth,
        tags: liftedTags,
        childTags: undefined,
        isMultiSelect: parentTag.isMultiSelect ?? false,
        metadata: group.metadata
      }
    }

    const directChildren: DimensionTag[] = []
    const seen = new Set<string>()

    const parentKeys = [parentTag.code, parentTag.tagValue].filter(Boolean) as string[]
    for (const pk of parentKeys) {
      const list = tagsByParent.get(pk) || []
      for (const ct of list) {
        const key = ct.code || ct.tagValue
        if (!seen.has(key) && key !== parentTag.code && key !== parentTag.tagValue) {
          seen.add(key)
          directChildren.push(ct)
        }
      }
    }

    if (directChildren.length === 0) return null

    const subChildTagsMap = new Map<string, DimensionTreeNode[]>()
    directChildren.forEach((childTag) => {
      const grandSub = buildChildNode(childTag, currentDepth + 1)
      if (grandSub) {
        subChildTagsMap.set(childTag.tagValue, [grandSub])
      }
    })

    return {
      id: group.id * 10000 + currentDepth * 100 + (parentTag.order || 1),
      name: parentTag.tagValue,
      code: parentTag.code || `${group.code || group.id}.${parentTag.tagValue}`,
      level: currentDepth,
      tags: directChildren,
      childTags: subChildTagsMap.size > 0 ? subChildTagsMap : undefined,
      isMultiSelect: parentTag.isMultiSelect ?? false,
      metadata: group.metadata
    }
  }

  directTags.forEach(parentTag => {
    const subNode = buildChildNode(parentTag, 1)
    if (subNode) {
      childTagsMap.set(parentTag.tagValue, [subNode])
    }
  })

  return { directTags, childTagsMap }
}

/**
 * 递归构建维度树（支持基于 triggerTags 的细粒度层级与顶层主干开放准入，以及 maxScaleDepth 穿透提升）
 */
export function buildDimensionTree(
  dimensionGroups: DimensionGroup[],
  parentId: number | null = null,
  parentTag: string | null = null,
  level = 0,
  maxScaleDepth: number = 3
): DimensionTreeNode[] {
  // 预构建 parentId → groups 查找表和 hasChildren 集合，消除 O(n²)
  const map = new Map<number | null, DimensionGroup[]>()
  const childrenSet = new Set<number>()
  dimensionGroups.forEach(g => {
    // 开放准入：凡无父级依赖、无触发条件，或声明为根层级的组均进入顶层候选池
    const isTopLevel =
      (!g.triggerConditions || g.triggerConditions.length === 0) &&
      (!g.parentDimensionIds || g.parentDimensionIds.length === 0)

    if (isTopLevel || g.level === 0) {
      const list = map.get(null) || []
      list.push(g)
      map.set(null, list)
    }
    if (g.parentDimensionIds && g.parentDimensionIds.length > 0) {
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
        // 1. 拆解该维度组内部标签的父子多级关系 (viaParentCode / level / maxScaleDepth)
        const { directTags, childTagsMap } = nestGroupTags(group, group.tags || [], lvl, maxScaleDepth)

        // 2. 关联外部细分维度组 (基于 triggerConditions / parentDimensionIds)
        const hasChildren = childrenSet.has(group.id)
        if (hasChildren) {
          directTags.forEach(tag => {
            const externalChildren = recurse(group.id, tag.tagValue, lvl + 1)
            if (externalChildren.length > 0) {
              const existing = childTagsMap.get(tag.tagValue) || []
              childTagsMap.set(tag.tagValue, [...existing, ...externalChildren])
            }
          })
        }

        return {
          ...group,
          level: lvl,
          tags: directTags,
          childTags: childTagsMap.size > 0 ? childTagsMap : undefined
        } as DimensionTreeNode
      })
      .filter((group, idx, arr) => {
        // 根级同名/同Code去重：相同名称或Code的维度组仅保留第一个主干维度，彻底杜绝根级重复
        if (lvl === 0) {
          if (group.name) {
            const firstIdxByName = arr.findIndex(g => g.name === group.name)
            if (firstIdxByName !== -1 && firstIdxByName !== idx) {
              return false
            }
          }
          if (group.code) {
            const firstIdxByCode = arr.findIndex(g => g.code === group.code)
            if (firstIdxByCode !== -1 && firstIdxByCode !== idx) {
              return false
            }
          }
        }
        return true
      })
      .sort((a, b) => {
        if (lvl === 0) {
          // 第一层主干节点：严格执行三级动态权重排序
          return compareTopLevelNodes(a, b)
        }
        if (a.level !== b.level) return a.level - b.level
        return a.id - b.id
      })
  }

  return recurse(parentId, parentTag, level)
}

/**
 * 过滤函数：获取可见与不可见标签
 * 支持多种重载调用签名：
 * 1. (group, showEmptyTags, panDimensionIds, childTags)
 * 2. (group, showEmptyTags, childTags)
 * 3. (group, childTags)
 */
export function getVisibleAndHiddenTags(
  group: DimensionGroup,
  showEmptyTagsOrChildTags?: boolean | Map<string, DimensionTreeNode[]>,
  panDimensionIdsOrChildTags?: number[] | Map<string, DimensionTreeNode[]>,
  maybeChildTags?: Map<string, DimensionTreeNode[]>
) {
  let showEmptyTags = false
  let panDimensionIds: number[] = []
  let childTags: Map<string, DimensionTreeNode[]> | undefined

  if (typeof showEmptyTagsOrChildTags === 'boolean') {
    showEmptyTags = showEmptyTagsOrChildTags
    if (Array.isArray(panDimensionIdsOrChildTags)) {
      panDimensionIds = panDimensionIdsOrChildTags
      childTags = maybeChildTags
    } else if (panDimensionIdsOrChildTags instanceof Map) {
      childTags = panDimensionIdsOrChildTags
    }
  } else if (showEmptyTagsOrChildTags instanceof Map) {
    childTags = showEmptyTagsOrChildTags
  }

  let visibleTags = (group.tags || []).filter((tag: DimensionTag) => tag.fileCount > 0)
  const hiddenTags = (group.tags || []).filter((tag: DimensionTag) => tag.fileCount === 0)

  if (childTags instanceof Map) {
    hiddenTags.forEach(tag => {
      const children = childTags!.get(tag.tagValue)
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

  const isPan = panDimensionIds.includes(group.id) || isPanDimension(group)
  if (isPan) {
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

  const results: SelectedTag[] = []
  for (const key of selectedTagsSet) {
    const parsed = parseTagKey(key)
    const { dimensionId, tagValue, parentTagValue: keyParentTagValue } = parsed
    const group = groupMap.get(dimensionId)
    // 若维度不存在，或该维度下无此标签，视为陈旧/无效标签直接过滤
    if (!group) continue
    const tagObj = tagObjMap.get(`${dimensionId}::${tagValue}`)
    if (!tagObj && !group.tags.some(t => t.tagValue === tagValue)) continue

    const ancestorChain = parentTagMap?.get(key)
    const parentTagValue =
      keyParentTagValue ||
      (ancestorChain && ancestorChain.length > 1
        ? ancestorChain[ancestorChain.length - 2]
        : undefined)

    const tagItem = group.tags.find(t => t.tagValue === tagValue)

    const effectiveViaParent =
      parsed.viaParentCode || tagItem?.viaParentCode || undefined

    results.push({
      dimensionId,
      dimensionName: group.name,
      tagValue,
      code: tagItem?.code,
      viaParentCode: effectiveViaParent,
      level: tagObj?.level || 0,
      ...(parentTagValue ? { parentTagValue } : {}),
      ...(ancestorChain && ancestorChain.length > 0 ? { ancestorChain } : {})
    })
  }

  return results
}
