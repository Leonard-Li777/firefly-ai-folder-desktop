/**
 * R-27（W6）超大文件拆分片段，原 `.tmp-orig-dimension.ts` 的物理子模块。
 * 由原文件切片生成，保留全部既有实现与注释。
 */
import { DimensionGroup, DimensionTag, SelectedTag } from '@firefly/types'
import { isPanDimension } from '@firefly/shared'
import { DimensionTreeNode } from '../AnalyzedDirectory/types'
import { makeTagKey, dimensionNodeKey, parseTagKey } from './dimension-keys'
import {
  nestGroupTags,
  type TagParentIndex,
  buildTagParentIndex,
  collectDescendantTags,
  aggregateLiftedTags
} from './dimension-build'

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
      const children =
        childTags!.get(dimensionNodeKey(group.code || group.name, tag)) ||
        childTags!.get(tag.tagValue)
      if (
        children &&
        children.some(child => {
          function hasAnyPositiveDescendant(
            node: DimensionTreeNode,
            parentTagValue?: string
          ): boolean {
            let tagsToInspect = node.tags
            const effectiveParentValue = parentTagValue || tag.tagValue
            if (
              node.contextualTags &&
              effectiveParentValue &&
              node.contextualTags[effectiveParentValue]
            ) {
              const isL3Ext = /扩展名|Extension/i.test(node.name)
              if (!isL3Ext) {
                tagsToInspect = node.contextualTags[effectiveParentValue]
              }
            }
            if (tagsToInspect && tagsToInspect.some(t => t.fileCount > 0)) return true
            if (node.childTags instanceof Map) {
              for (const subList of node.childTags.values()) {
                if (subList.some(subNode => hasAnyPositiveDescendant(subNode, node.name)))
                  return true
              }
            }
            return false
          }
          return hasAnyPositiveDescendant(child, tag.tagValue)
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

  // 每个维度组惰性构建一次父子索引：聚合行还原必须与 nestGroupTags 同口径 (ADR-0034 §4)
  const groupIndexCache = new Map<number, TagParentIndex>()

  /**
   * 重建穿透提升聚合行：以 key 中的 viaParentCode 为提升容器，在其子树闭包内
   * 执行与 nestGroupTags 完全相同的「收集子孙 + 跨分支聚合」算法，
   * 从而多选拿到的 code / codePath / codePaths 与单选点击同一行时 100% 一致。
   */
  const buildLiftedAggregateRow = (
    group: DimensionGroup,
    containerKey: string,
    tagValue: string
  ): DimensionTag | undefined => {
    let index = groupIndexCache.get(group.id)
    if (!index) {
      index = buildTagParentIndex(group.tags || [], group)
      groupIndexCache.set(group.id, index)
    }
    const containerTag = index.tagByCode.get(containerKey) || index.tagByName.get(containerKey)
    if (!containerTag) return undefined
    const descendants = collectDescendantTags(containerTag, index)
    if (descendants.length === 0) return undefined
    const lifted = aggregateLiftedTags(descendants, containerTag, containerTag.level + 1)
    return lifted.find(t => t.tagValue === tagValue)
  }

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

    // 多父同名/同 Code 兄弟实例：优先用 key 携带的 codePath（分支消歧锚）精确匹配，
    // 其次 viaParentCode 消歧——避免取到兄弟分支的 codePath / namePath 造成跨介质误召回
    // （M-2 修复；语言细分等多父维度 viaParentCode 跨分支相同，必须 codePath 才能区分）
    const candidates = group.tags.filter(t => t.tagValue === tagValue)

    // 穿透提升聚合行 (liftCode 标记 key)：聚合行的 viaParentCode 已被重写为提升容器，
    // 可能与容器直系真实实例的 key 撞车，仅凭 viaParentCode 无法区分，故按 key 标记分流——
    // 聚合行走「容器子树同算法重建」，与单选点击同一行的 codePaths 完全一致 (ADR-0034 §4 / M-4)。
    const aggRow =
      parsed.isLifted && parsed.viaParentCode
        ? buildLiftedAggregateRow(group, parsed.viaParentCode, tagValue)
        : undefined

    const exactMatch = parsed.codePath
      ? candidates.find(t => t.codePath === parsed.codePath)
      : parsed.viaParentCode
        ? candidates.find(t => (t.viaParentCode || undefined) === parsed.viaParentCode)
        : undefined
    const tagItem = aggRow || exactMatch || candidates[0]

    const effectiveViaParent = parsed.viaParentCode || tagItem?.viaParentCode || undefined

    // 常规实例行严禁并集，否则 FileList 会跨分支召回污染树徽标 (AC-4)；
    // 仅当 key 声明了 viaParentCode 却既非聚合行、又无实例匹配（数据漂移/陈旧 key）
    // 时，才回退取全部分支物化路径并集，宁可多召回也不丢文件视野。
    // distinctPaths 仅在回退分支内惰性计算（正常 key 不做无谓的 Set 分配）。
    let codePaths: string[] | undefined
    if (aggRow) {
      // 判据取 length > 0 而非 > 1：正常数据下 codePaths[0] === codePath（经后端
      // resolveTagCodePaths 归一后 SQL 等价），且可堵住「首入列后代缺 codePath
      // 导致 codePaths=[p] 单元素」角例下多选退化为 code 并集、与单选排他口径分叉的缺口 (M-1)；
      // 空数组仍回退 codePath，语义不变。
      codePaths = aggRow.codePaths && aggRow.codePaths.length > 0 ? aggRow.codePaths : undefined
    } else if (parsed.viaParentCode && !exactMatch) {
      const distinctPaths = [
        ...new Set(candidates.map(t => t.codePath).filter((p): p is string => !!p))
      ]
      codePaths = distinctPaths.length > 1 ? distinctPaths : undefined
    } else if (tagItem?.codePaths && tagItem.codePaths.length > 0) {
      // 聚类节点或携带物化路径集合的节点，多选必须透传保真 (ADR-0034 §4)
      codePaths = tagItem.codePaths
    }

    results.push({
      dimensionId,
      dimensionName: group.name,
      tagValue,
      code: tagItem?.code,
      codePath: tagItem?.codePath,
      namePath: tagItem?.namePath,
      ...(codePaths ? { codePaths } : {}),
      viaParentCode: effectiveViaParent,
      level: tagItem?.level ?? tagObj?.level ?? 0,
      ...(parentTagValue ? { parentTagValue } : {}),
      ...(parsed.hostScopeCode ? { hostScopeCode: parsed.hostScopeCode } : {}),
      ...(ancestorChain && ancestorChain.length > 0 ? { ancestorChain } : {})
    })
  }

  return results
}

/**
 * 获取当前节点实际应当展示的标签集合。
 * 当节点存在 contextualTags 且当前非扩展名维度时，实际展示的是上下文标签而非 node.tags。
 */
export function resolveTagsToUse(node: DimensionTreeNode, parentTagValue?: string): DimensionTag[] {
  let tagsToUse = node.tags
  if (parentTagValue && node.contextualTags && node.contextualTags[parentTagValue]) {
    const isL3Ext = /扩展名|Extension/i.test(node.name)
    if (!isL3Ext) {
      tagsToUse = node.contextualTags[parentTagValue]
    }
  }
  return tagsToUse
}

/**
 * 递归收集树中所有「可被勾选」的标签 key。
 * 约束（必须与渲染层一致）：
 * 1. 标签集合取自 resolveTagsToUse（含 contextualTags 场景）；
 * 2. 跳过 fileCount === 0 的禁用标签（渲染层 checkbox 处于 disabled，无法勾选）；
 * 3. 跳过折叠维度组内的标签（渲染层未渲染，勾选后用户看不到任何反馈）。
 */
export function getAllKeys(
  nodes: DimensionTreeNode[],
  parentTag?: string,
  chain: string[] = [],
  collapsedDimensionGroups?: Set<number>
): { key: string; ancestorChain: string[] }[] {
  const keys: { key: string; ancestorChain: string[] }[] = []
  nodes.forEach(node => {
    // 折叠的维度组不渲染其标签，不应计入全选范围
    if (node.level === 0 && collapsedDimensionGroups?.has(node.id)) return

    const tagsToUse = resolveTagsToUse(node, parentTag)
    const visitedChildKeys = new Set<string>()
    tagsToUse.forEach(tag => {
      if (tag.fileCount === 0) return
      const key = makeTagKey(
        tag.dimensionId,
        tag.tagValue,
        parentTag,
        tag.viaParentCode ?? undefined,
        tag.isLifted === true,
        tag.codePath
      )
      const currentChain = [...chain, tag.tagValue]
      keys.push({ key, ancestorChain: currentChain })

      if (node.childTags) {
        const nodeKey = dimensionNodeKey(node.code || node.name, tag)
        const childNodes = node.childTags.get(nodeKey)
        if (childNodes && childNodes.length > 0) {
          visitedChildKeys.add(nodeKey)
          keys.push(...getAllKeys(childNodes, tag.tagValue, currentChain, collapsedDimensionGroups))
        }
      }
    })

    if (node.childTags) {
      for (const [childKey, childNodes] of node.childTags) {
        if (!visitedChildKeys.has(childKey)) {
          const fallbackTag = childKey.includes('::') ? childKey.split('::').pop()! : childKey
          keys.push(
            ...getAllKeys(
              childNodes,
              fallbackTag,
              [...chain, fallbackTag],
              collapsedDimensionGroups
            )
          )
        }
      }
    }
  })
  return keys
}

export interface ScaleMigrationParams {
  prevSelected: Set<string>
  prevStack: string[]
  prevParentMap: Map<string, string[]>
  currentVisibleGroups: DimensionTreeNode[]
  masterDimensionGroups: DimensionGroup[]
}

export interface ScaleMigrationResult {
  migratedSelected: Set<string>
  migratedStack: string[]
  migratedParentMap: Map<string, string[]>
  hasChanged: boolean
}

/**
 * 跨刻度滑块投影自愈迁移器 (纯函数，零副作用)
 * 核心公理：全覆盖不变式 (Full-Coverage Invariant，B-1 彻底闭环)
 * 1. 提升聚合 ➔ 实例展开 (1:N): 自动映射为展开后的所有对应实例行，并保持真实物理祖先链；
 * 2. 实例展开 ➔ 提升折叠 (N:1): 当且仅当该容器下的所有展开实例行全部被勾选时，才收敛为聚合行；
 *    若仅为部分选中 (Partial Selection)，严禁扩增为聚合行，严格保留原实例 key 作为深层保留态！
 * 3. 物理死标签过滤: 仅清理在底层 masterDimensionGroups 中已被物理删除的孤儿 key。
 */
export function migrateTagKeysAcrossScale(params: ScaleMigrationParams): ScaleMigrationResult {
  const { prevSelected, prevStack, prevParentMap, currentVisibleGroups, masterDimensionGroups } =
    params

  if (prevSelected.size === 0) {
    return {
      migratedSelected: new Set(),
      migratedStack: [],
      migratedParentMap: new Map(),
      hasChanged: false
    }
  }

  // 1. 收集当前可见树中所有可被勾选的项
  const visibleItems = getAllKeys(currentVisibleGroups)
  const visibleItemMap = new Map<string, { key: string; ancestorChain: string[] }>()
  for (const item of visibleItems) {
    visibleItemMap.set(item.key, item)
  }

  // 2. 构建底层 master 维度组与索引
  const masterGroupMap = new Map<number, DimensionGroup>()
  const masterIndexMap = new Map<number, TagParentIndex>()
  for (const g of masterDimensionGroups) {
    masterGroupMap.set(g.id, g)
    masterIndexMap.set(g.id, buildTagParentIndex(g.tags || [], g))
  }

  // 3. 构建当前可见树中聚合行与展开实例行的高速索引
  const visibleLiftedByKey = new Map<string, { key: string; ancestorChain: string[] }>()
  const visibleInstancesByContainerAndValue = new Map<
    string,
    Array<{ key: string; ancestorChain: string[] }>
  >()

  for (const item of visibleItems) {
    const parsed = parseTagKey(item.key)
    if (parsed.isLifted && parsed.viaParentCode) {
      visibleLiftedByKey.set(
        `${parsed.dimensionId}::${parsed.viaParentCode}::${parsed.tagValue}`,
        item
      )
    } else if (!parsed.isLifted) {
      const masterIndex = masterIndexMap.get(parsed.dimensionId)
      // 遍历 item.ancestorChain 中的每个祖先（排除末尾自身标签值）
      const ancestors = item.ancestorChain.slice(0, -1)
      for (const ancName of ancestors) {
        const ancObj = masterIndex?.tagByName.get(ancName) || masterIndex?.tagByCode.get(ancName)
        const containerKeys = new Set<string>([ancName])
        if (ancObj?.code) containerKeys.add(ancObj.code)
        if (ancObj?.tagValue) containerKeys.add(ancObj.tagValue)

        for (const cKey of containerKeys) {
          const mapKey = `${parsed.dimensionId}::${cKey}::${parsed.tagValue}`
          let list = visibleInstancesByContainerAndValue.get(mapKey)
          if (!list) {
            list = []
            visibleInstancesByContainerAndValue.set(mapKey, list)
          }
          if (!list.some(i => i.key === item.key)) {
            list.push(item)
          }
        }
      }
    }
  }

  const migratedSelected = new Set<string>()
  const migratedStack: string[] = []
  const migratedParentMap = new Map<string, string[]>()
  let hasChanged = false

  const collapsedHandledInstanceKeys = new Set<string>()
  const handledPrevKeys = new Set<string>()

  for (const oldKey of prevStack) {
    if (!prevSelected.has(oldKey)) continue
    handledPrevKeys.add(oldKey)
    if (collapsedHandledInstanceKeys.has(oldKey)) {
      hasChanged = true
      continue
    }

    const parsed = parseTagKey(oldKey)
    const masterGroup = masterGroupMap.get(parsed.dimensionId)
    const masterIndex = masterIndexMap.get(parsed.dimensionId)

    // ─── 规则 1: 在当前可见树中直接命中有效 key ───
    if (visibleItemMap.has(oldKey)) {
      migratedSelected.add(oldKey)
      migratedStack.push(oldKey)
      migratedParentMap.set(oldKey, visibleItemMap.get(oldKey)!.ancestorChain)
      continue
    }

    // ─── 规则 2: 旧 key 是提升聚合行，当前树中不可视（树展开了，1:N 自愈） ───
    if (parsed.isLifted && parsed.viaParentCode && masterGroup && masterIndex) {
      const containerKey = parsed.viaParentCode
      const containerTag =
        masterIndex.tagByCode.get(containerKey) || masterIndex.tagByName.get(containerKey)
      if (containerTag) {
        const mapKey = `${parsed.dimensionId}::${containerKey}::${parsed.tagValue}`
        const visibleInstances = visibleInstancesByContainerAndValue.get(mapKey) || []

        if (visibleInstances.length > 0) {
          hasChanged = true
          for (const inst of visibleInstances) {
            if (!migratedSelected.has(inst.key)) {
              migratedSelected.add(inst.key)
              migratedStack.push(inst.key)
              migratedParentMap.set(inst.key, inst.ancestorChain)
            }
          }
          continue
        }
      }
    }

    // ─── 规则 3: 旧 key 是普通实例行，当前树中不可视（可能被折叠提升了，N:1 全覆盖收敛） ───
    if (!parsed.isLifted && masterGroup && masterIndex) {
      let handledByFullCoverageCollapse = false
      for (const [mapKey, liftedItem] of visibleLiftedByKey.entries()) {
        const [dimStr, containerKey, val] = mapKey.split('::')
        if (parseInt(dimStr, 10) !== parsed.dimensionId || val !== parsed.tagValue) continue

        const containerTag =
          masterIndex.tagByCode.get(containerKey) || masterIndex.tagByName.get(containerKey)
        if (!containerTag) continue

        const descendants = collectDescendantTags(containerTag, masterIndex)
        const siblingInstances = descendants.filter(d => d.tagValue === parsed.tagValue)
        if (siblingInstances.length === 0) continue

        const isBelongToContainer = siblingInstances.some(
          d => (d.viaParentCode || undefined) === parsed.viaParentCode
        )
        if (!isBelongToContainer) continue

        // 【全覆盖不变式校验 (Full-Coverage Invariant)】
        const allSiblingKeysInPrevSelected = siblingInstances.every(sib => {
          for (const k of prevSelected) {
            const p = parseTagKey(k)
            if (p.dimensionId === parsed.dimensionId && p.tagValue === sib.tagValue) {
              if (!p.isLifted && (p.viaParentCode === sib.viaParentCode || !sib.viaParentCode)) {
                return true
              }
            }
          }
          return false
        })

        if (allSiblingKeysInPrevSelected) {
          hasChanged = true
          handledByFullCoverageCollapse = true
          if (!migratedSelected.has(liftedItem.key)) {
            migratedSelected.add(liftedItem.key)
            migratedStack.push(liftedItem.key)
            migratedParentMap.set(liftedItem.key, liftedItem.ancestorChain)
          }
          for (const k of prevSelected) {
            const p = parseTagKey(k)
            if (
              p.dimensionId === parsed.dimensionId &&
              p.tagValue === parsed.tagValue &&
              !p.isLifted &&
              siblingInstances.some(sib => (sib.viaParentCode || undefined) === p.viaParentCode)
            ) {
              collapsedHandledInstanceKeys.add(k)
              handledPrevKeys.add(k)
            }
          }
          break
        }
      }

      if (handledByFullCoverageCollapse) {
        continue
      }

      // 【部分勾选守卫 (Partial Selection Invariant)】
      const physicalExists = masterGroup.tags?.some(t => t.tagValue === parsed.tagValue)
      if (physicalExists) {
        migratedSelected.add(oldKey)
        migratedStack.push(oldKey)
        if (prevParentMap.has(oldKey)) {
          migratedParentMap.set(oldKey, prevParentMap.get(oldKey)!)
        }
        continue
      }
    }

    // ─── 规则 4: 物理死标签过滤 ───
    hasChanged = true
  }

  for (const oldKey of prevSelected) {
    if (handledPrevKeys.has(oldKey) || collapsedHandledInstanceKeys.has(oldKey)) continue
    if (!migratedSelected.has(oldKey)) {
      const parsed = parseTagKey(oldKey)
      const masterGroup = masterGroupMap.get(parsed.dimensionId)
      if (masterGroup?.tags?.some(t => t.tagValue === parsed.tagValue)) {
        migratedSelected.add(oldKey)
        migratedStack.push(oldKey)
        if (prevParentMap.has(oldKey)) {
          migratedParentMap.set(oldKey, prevParentMap.get(oldKey)!)
        }
      }
    }
  }

  return {
    migratedSelected,
    migratedStack,
    migratedParentMap,
    hasChanged: hasChanged || migratedSelected.size !== prevSelected.size
  }
}
