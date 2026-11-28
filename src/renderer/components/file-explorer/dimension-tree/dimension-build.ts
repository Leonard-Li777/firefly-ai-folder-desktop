/**
 * R-27（W6）超大文件拆分片段，原 `.tmp-orig-dimension.ts` 的物理子模块。
 * 由原文件切片生成，保留全部既有实现与注释。
 */
import { DimensionGroup, DimensionTag } from '@firefly/types'
import { DimensionTreeNode } from '../AnalyzedDirectory/types'
import {
  normalizeCodePath,
  resolveDimensionCode,
  isRootDimensionCodeOrName,
  DimensionChildTagsMap,
  dimensionNodeKey,
  compareTopLevelNodes
} from './dimension-keys'

/**
 * 标签父子索引（code/tagValue 双键登记）。
 * 穿透提升（单选聚合行）与多选聚合还原必须共用同一份索引口径，否则两模式视野会分叉。
 */
export interface TagParentIndex {
  tagByCode: Map<string, DimensionTag>
  tagByName: Map<string, DimensionTag>
  tagsByParent: Map<string, DimensionTag[]>
}

/**
 * 构建标签父子索引：根据 code_path（主要建树依据）与 parentCodes / viaParentCode（本体来源）归类子标签，
 * 优先精确按 Code 登记父子关系，杜绝跨异码同名标签错误广播子树
 * （标签树是通过 code_path 建立的，源头来自于 parentCodes）
 */
/** 供 select 子模块复用的索引构建入口 */
export function buildTagParentIndex(tags: DimensionTag[], group?: DimensionGroup): TagParentIndex {
  // 1. 构建 code -> tag 与 tagValue -> tag 快速索引
  const tagByCode = new Map<string, DimensionTag>()
  const tagByName = new Map<string, DimensionTag>()
  const tagsByParent = new Map<string, DimensionTag[]>()

  for (const t of tags) {
    if (t.code) tagByCode.set(t.code, t)
    if (t.tagValue) tagByName.set(t.tagValue, t)
  }

  // 2. 根据 code_path（主要）与 parentCodes / viaParentCode（来源）归类子标签（机器码精确匹配优先）
  for (const t of tags) {
    const parentCandidates = new Set<string>()

    // A. 标签树是通过 code_path 建立的：优先从 code_path / codePaths 沿祖先链反向寻找最邻近且存在于组内的父标签（支持跳级段与完整树形还原）
    const effectiveCodePath =
      t.codePath || (t.codePaths && t.codePaths.length > 0 ? t.codePaths[0] : '')
    const segs = effectiveCodePath ? effectiveCodePath.split('/').filter(Boolean) : []
    if (segs.length > 2) {
      for (let i = segs.length - 2; i >= 1; i--) {
        const segCode = segs[i]
        if (tagByCode.has(segCode) || tagByName.has(segCode)) {
          parentCandidates.add(segCode)
          break
        }
      }
    }

    // B. 不过来源是 parentCodes：若从 code_path 中未匹配到组内父标签，则从 viaParentCode 与 parentCodes 寻找
    const rootTarget = group || { id: t.dimensionId, code: t.dimensionCode, name: t.dimensionName }
    const rootCode = segs.length > 0 ? segs[0] : resolveDimensionCode(rootTarget)
    const isRoot = (p?: string | null) => isRootDimensionCodeOrName(rootTarget, p) || p === rootCode

    if (parentCandidates.size === 0) {
      // B.1 优先精确使用当前实例锁定的 viaParentCode
      if (
        t.viaParentCode &&
        !isRoot(t.viaParentCode) &&
        (tagByCode.has(t.viaParentCode) || tagByName.has(t.viaParentCode))
      ) {
        parentCandidates.add(t.viaParentCode)
      }

      // B.2 若 viaParentCode 未在组内命中有效父级，再从 parentCodes 中拾取首个命中组内的父节点，防止跨分支多亲串扰 (Issue 3)
      if (parentCandidates.size === 0 && Array.isArray(t.parentCodes) && t.parentCodes.length > 0) {
        for (const p of t.parentCodes) {
          if (p && !isRoot(p) && (tagByCode.has(p) || tagByName.has(p))) {
            parentCandidates.add(p)
            break
          }
        }
      }
    }

    // C. 兜底保持父子链：若组内仍未找到匹配的父节点实体，记录直接父段或原始 viaParentCode / parentCodes 兜底
    if (parentCandidates.size === 0) {
      if (segs.length > 2) {
        parentCandidates.add(segs[segs.length - 2])
      } else if (t.viaParentCode && !isRoot(t.viaParentCode)) {
        parentCandidates.add(t.viaParentCode)
      } else if (Array.isArray(t.parentCodes) && t.parentCodes.length > 0) {
        const p = t.parentCodes.find(pc => pc && !isRoot(pc))
        if (p) parentCandidates.add(p)
      }
    }

    for (const parentKey of parentCandidates) {
      if (!parentKey) continue

      // 优先精确按 Code 查找父节点
      const parentByCode = tagByCode.get(parentKey)
      if (parentByCode) {
        // 父子关系是由确切机器码绑定的，严格仅在 parentKey 和 parentByCode.code 上登记，
        // 严禁向 parentByCode.tagValue（自然语言名称）广播，防止同名异码节点错误继承子树
        const pKeys = new Set([parentKey, parentByCode.code].filter(Boolean) as string[])
        for (const pk of pKeys) {
          const list = tagsByParent.get(pk) || []
          if (!list.includes(t)) {
            list.push(t)
            tagsByParent.set(pk, list)
          }
        }
      } else {
        // 仅在按 Code 找不到父节点时，说明 parentKey 可能是自然语言展示名，尝试按 tagByName 兜底查找
        const parentByName = tagByName.get(parentKey)
        if (parentByName) {
          const pKeys = new Set(
            [parentKey, parentByName.code, parentByName.tagValue].filter(Boolean) as string[]
          )
          for (const pk of pKeys) {
            const list = tagsByParent.get(pk) || []
            if (!list.includes(t)) {
              list.push(t)
              tagsByParent.set(pk, list)
            }
          }
        } else {
          // 如果都未找到映射实体，直接以原始 parentKey 登记
          const list = tagsByParent.get(parentKey) || []
          if (!list.includes(t)) {
            list.push(t)
            tagsByParent.set(parentKey, list)
          }
        }
      }
    }
  }

  return { tagByCode, tagByName, tagsByParent }
}

/**
 * 递归收集任意父标签下的所有深层子孙标签（用于穿透提升）：
 * 按对象身份防环遍历多父 DAG，保留同 Code/同名的全部分支实例，
 * 合并去重延后至提升聚合阶段完成，确保跨分支物化路径集合 codePaths 零丢失
 */
export function collectDescendantTags(
  startTag: DimensionTag,
  index: TagParentIndex
): DimensionTag[] {
  const result: DimensionTag[] = []
  // 已访问实例集合：多父 DAG 中同一实例可能被多条分支同时到达，按对象身份去环保证终止
  const visited = new Set<DimensionTag>([startTag])
  const containerPrefixes = [startTag.codePath, ...(startTag.codePaths || [])].filter(
    Boolean
  ) as string[]
  const containerHost = startTag.hostScopeCode || (startTag.level === 1 ? startTag.code : undefined)

  function collectAll(curr: DimensionTag) {
    // 优先以机器码查找直接子节点，缺失机器码时才以 tagValue 兜底
    const keys = curr.code ? [curr.code] : ([curr.tagValue].filter(Boolean) as string[])
    for (const k of keys) {
      const children = index.tagsByParent.get(k) || []
      for (const child of children) {
        if (visited.has(child)) continue
        // 跨宿主/跨介质边界前缀约束 (P0-2)：
        // 若起始容器与子标签均具有物化路径，子标签路径必须落在起始容器路径前缀下；
        // 严禁将兄弟容器（如影视）下的子标签实例收集到当前容器（如图片）下
        if (containerPrefixes.length > 0 && child.codePath) {
          const belongsToContainer = containerPrefixes.some(
            prefix => child.codePath === prefix || child.codePath!.startsWith(prefix + '/')
          )
          if (!belongsToContainer) continue
        }
        if (containerHost && child.hostScopeCode && containerHost !== child.hostScopeCode) {
          continue
        }

        // 起始标签自身被反向挂载（脏数据回环）时不重复提升为自身子行；
        // 仅按「同一身份」判定（同 code，或双方均缺失 code 时才回退比同名），不误伤同名异码标签
        const isSameIdentity = child.code
          ? child.code === startTag.code
          : !startTag.code && child.tagValue === startTag.tagValue
        if (isSameIdentity) continue
        visited.add(child)
        result.push(child)
        collectAll(child)
      }
    }
  }

  collectAll(startTag)
  return result
}

/**
 * 跨分支同名/同 Code 提升聚合 (ADR-0034 §4 / M-4)：
 * 同一提升容器内不同分支命中同名或同 Code 时合并为单行——
 * 1. fileCount 在提供 pathCountMap 时按属于该容器的各分支路径命中求和（由 collectDescendantTags 保证同容器隔离）；
 *    无 pathCountMap 时按全局去重语义取 Math.max；
 * 2. 保留全部分支的物化路径集合 codePaths，确保点击提升标签后 FileList 文件视野零丢失；
 * 3. codePath 保留首分支主路径，供单值消费方降级使用。
 * @param containerTag 提升容器（真实父/逻辑父）标签，聚合行 viaParentCode 指回它
 * @param containerLevel 聚合行挂载层级（提升容器行深度 + 1）
 */
export function aggregateLiftedTags(
  descendants: DimensionTag[],
  containerTag: DimensionTag,
  containerLevel: number,
  pathCountMap?: Record<string, number>,
  removeEmptyTags = false
): DimensionTag[] {
  const liftedTags: DimensionTag[] = []
  const liftedByCode = new Map<string, DimensionTag>()
  const liftedByName = new Map<string, DimensionTag>()
  const effectiveHost = containerTag.hostScopeCode || containerTag.code || undefined
  const hasPathIndex = pathCountMap ? Object.keys(pathCountMap).length > 0 : false

  for (const d of descendants) {
    const existing =
      (d.code ? liftedByCode.get(d.code) : undefined) ||
      (d.tagValue ? liftedByName.get(d.tagValue) : undefined)
    if (!existing) {
      let initCount = d.fileCount
      if (d.codePath && pathCountMap) {
        if (pathCountMap[d.codePath] !== undefined) {
          initCount = pathCountMap[d.codePath]
        } else if (hasPathIndex) {
          initCount = 0
        }
      }

      const merged: DimensionTag = {
        ...d,
        viaParentCode: containerTag.code || containerTag.tagValue,
        hostScopeCode: effectiveHost,
        level: containerLevel,
        fileCount: initCount,
        codePaths: d.codePath ? [d.codePath] : [],
        isLifted: true
      }
      liftedTags.push(merged)
      if (d.code) liftedByCode.set(d.code, merged)
      if (d.tagValue) liftedByName.set(d.tagValue, merged)
      continue
    }
    if (d.codePath && !(existing.codePaths || []).includes(d.codePath)) {
      existing.codePaths = [...(existing.codePaths || []), d.codePath]
    }
    if (pathCountMap) {
      existing.fileCount = (existing.codePaths || []).reduce(
        (sum, p) => sum + (pathCountMap[p] ?? 0),
        0
      )
    } else {
      existing.fileCount = Math.max(existing.fileCount, d.fileCount)
    }
    if (d.code && !liftedByCode.has(d.code)) liftedByCode.set(d.code, existing)
    if (d.tagValue && !liftedByName.has(d.tagValue)) liftedByName.set(d.tagValue, existing)
  }

  if (removeEmptyTags) {
    return liftedTags.filter(t => t.fileCount > 0)
  }
  return liftedTags
}

/**
 * 递归将组内的扁平标签集合（带有 level 和 viaParentCode）拆解为多级树形结构
 */
export function nestGroupTags(
  group: DimensionGroup,
  tags: DimensionTag[],
  level: number,
  maxScaleDepth: number = 8,
  pathCountMap?: Record<string, number>,
  removeEmptyTags = false
): { directTags: DimensionTag[]; childTagsMap: DimensionChildTagsMap } {
  const childTagsMap = new DimensionChildTagsMap()
  if (!tags || tags.length === 0) {
    return { directTags: [], childTagsMap }
  }
  const hasPathIndex = pathCountMap ? Object.keys(pathCountMap).length > 0 : false

  // 1-2. 构建 code/name 双键父子索引（与多选聚合还原共用同一口径）
  const index = buildTagParentIndex(tags, group)
  const { tagsByParent } = index

  // 3. 确定当前层级的直属候选标签 (rawDirectTags)：
  // 契约：标签树是通过 code_path 建立的，源头来自于 parentCodes。
  // 路径深度 > 2 的节点或 parentCodes / viaParentCode 指向组内有效父节点的标签为深层子孙，绝不能作为顶层直属标签
  const rawDirectTags: DimensionTag[] = []
  const isRootParent = (p?: string | null) => isRootDimensionCodeOrName(group, p)

  for (const t of tags) {
    const parentKey = t.viaParentCode
    const effectiveCodePath =
      t.codePath || (t.codePaths && t.codePaths.length > 0 ? t.codePaths[0] : '')
    const segs = effectiveCodePath ? effectiveCodePath.split('/').filter(Boolean) : []
    const isDeepByPath = segs.length > 2
    const hasParentByParentCodes =
      Array.isArray(t.parentCodes) &&
      t.parentCodes.some(
        p => p && !isRootParent(p) && (index.tagByCode.has(p) || index.tagByName.has(p))
      )
    const hasParentByVia = Boolean(
      parentKey &&
      !isRootParent(parentKey) &&
      (index.tagByCode.has(parentKey) || index.tagByName.has(parentKey))
    )
    const hasParentInGroup = hasParentByParentCodes || hasParentByVia

    const isLevel1 =
      !isDeepByPath &&
      !hasParentInGroup &&
      (t.level === undefined || t.level <= 1) &&
      (t.level === 1 ||
        isRootParent(parentKey) ||
        !parentKey ||
        (segs.length === 2 && isRootParent(segs[0])))
    if (isLevel1) {
      rawDirectTags.push(t)
    }
  }

  // 若没有明确的 level 1 标签，兜底寻找最小 level 或无父级标签作为直属
  if (rawDirectTags.length === 0) {
    const minLevel = tags.reduce((min, t) => Math.min(min, t.level ?? 1), Infinity)
    for (const t of tags) {
      if ((t.level ?? 1) === minLevel) {
        rawDirectTags.push(t)
      }
    }
    if (rawDirectTags.length === 0) {
      rawDirectTags.push(...tags)
    }
  }

  // 同级直属标签同名归并去重：
  // 当同级下出现展示名相同（例如 builtin.source_code 与 hownet.000000194528.n 均为"源代码"）时，
  // 归并为单节点，优先保留具有有效子树结构或更具权威受控代码的节点，并合并 fileCount 与物化路径
  const directTagsMap = new Map<string, DimensionTag>()
  for (const t of rawDirectTags) {
    const key = t.tagValue || t.code || ''
    if (!key) {
      directTagsMap.set(String(Math.random()), t)
      continue
    }
    const existing = directTagsMap.get(key)
    if (!existing) {
      directTagsMap.set(key, { ...t })
      continue
    }

    // 冲突消歧与合并决策：
    // 1. 判断谁拥有有效子标签（在 tagsByParent 中登记了子项）
    const existingHasChildren = (tagsByParent.get(existing.code || '')?.length ?? 0) > 0
    const currentHasChildren = (tagsByParent.get(t.code || '')?.length ?? 0) > 0

    // 2. 谁作为主节点保留（带子树者优先，避免子树断连）
    let primary = existing
    let secondary = t
    if (!existingHasChildren && currentHasChildren) {
      primary = t
      secondary = existing
    }

    // 3. 合并 fileCount 与物化路径
    const mergedFileCount = Math.max(primary.fileCount, secondary.fileCount)
    const mergedCodePaths = Array.from(
      new Set([
        ...(primary.codePaths || (primary.codePath ? [primary.codePath] : [])),
        ...(secondary.codePaths || (secondary.codePath ? [secondary.codePath] : []))
      ])
    )

    directTagsMap.set(key, {
      ...primary,
      fileCount: mergedFileCount,
      codePaths: mergedCodePaths.length > 0 ? mergedCodePaths : undefined
    })
  }
  const directTags: DimensionTag[] = Array.from(directTagsMap.values())

  // 基础视觉深度：根级 (level === 0) 的直属标签视觉深度为 2
  const baseVisualDepth = level + 2

  // 4. 当 baseVisualDepth >= maxScaleDepth 时 (例如 maxScaleDepth <= 2)：
  // 当前直属标签层已达最大允许视觉深度，所有更深层子孙标签全量穿透提升平铺到 directTags 中，且不再生成 childTagsMap
  if (baseVisualDepth >= maxScaleDepth) {
    // 逐一直属标签作为提升容器聚合并平铺：同一深层标签若来自不同顶层容器
    // （如「图片」与「视频」下各自的「无码」），必须各自保留一行并绑定所属容器，
    // 严禁跨容器合并为单行或把容器降级为维度根（否则 liftCode 无法回溯容器子树）。
    const containers = [...directTags]
    for (const containerTag of containers) {
      const descendants = collectDescendantTags(containerTag, index)
      if (descendants.length === 0) continue

      const liftedTags = aggregateLiftedTags(
        descendants,
        containerTag,
        baseVisualDepth,
        pathCountMap,
        removeEmptyTags
      )
      for (const lt of liftedTags) {
        const isContainerSelf = lt.code
          ? lt.code === containerTag.code
          : !containerTag.code && lt.tagValue === containerTag.tagValue
        if (!isContainerSelf) directTags.push(lt)
      }
    }

    // 刻度联动深度守卫 (depth <= 2 扁平化展示)：
    // 当刻度深度压缩至顶级直属层 (baseVisualDepth >= maxScaleDepth，即 maxScaleDepth <= 2) 时，
    // 聚类父节点 (isClusterNode: true) 作为合成的虚拟分组容器，必须透明溶解 (dissolve)，
    // 仅保留其内部真实的成员标签平铺展示，杜绝合成目录与子标签并列重复呈现。
    const finalFlatDirectTags = directTags.filter(
      t => !(t.meta?.isClusterNode === true || t.code?.includes('.cluster_'))
    )
    return {
      directTags: finalFlatDirectTags.length > 0 ? finalFlatDirectTags : directTags,
      childTagsMap
    }
  }

  // 5. 当 baseVisualDepth < maxScaleDepth 时：
  // 递归根据 tagsByParent 构建深层多级子树（支持 ADR-0034 §4 刻度穿透提升）
  function buildChildNode(
    parentTag: DimensionTag,
    currentVisualDepth: number
  ): DimensionTreeNode | null {
    // 若当前层级视觉深度达到或超过用户设定的刻度上限，则所有更深层子孙标签穿透提升（Pass-through Lift-up），
    // 汇聚挂载在当前刻度父级节点下，且该层不再向下生成更深层孙级节点 (ADR-0034 §4)
    if (currentVisualDepth >= maxScaleDepth) {
      const descendants = collectDescendantTags(parentTag, index)
      if (descendants.length === 0) return null

      // 跨分支同名/同 Code 提升聚合 (ADR-0034 §4 / M-4)，聚合口径见 aggregateLiftedTags 注释
      const liftedTags: DimensionTag[] = aggregateLiftedTags(
        descendants,
        parentTag,
        currentVisualDepth,
        pathCountMap,
        removeEmptyTags
      )

      if (removeEmptyTags && liftedTags.length === 0) return null

      // 过滤深层提升中被平铺的合成聚类容器节点，仅保留真实成员标签
      const cleanLiftedTags = liftedTags.filter(
        t => !(t.meta?.isClusterNode === true || t.code?.includes('.cluster_'))
      )

      return {
        id: group.id * 10000 + currentVisualDepth * 100 + (parentTag.order || 1),
        name: parentTag.tagValue,
        code: parentTag.code || `${resolveDimensionCode(group)}.${parentTag.tagValue}`,
        level: currentVisualDepth - 1,
        tags: cleanLiftedTags.length > 0 ? cleanLiftedTags : liftedTags,
        childTags: undefined,
        isMultiSelect: parentTag.isMultiSelect ?? false,
        metadata: group.metadata
      }
    }

    const directChildren: DimensionTag[] = []
    const seen = new Set<string>()

    // 优先按 parentTag.code 精确查找子节点，仅缺失 code 时才以 tagValue 兜底
    const parentKeys = parentTag.code
      ? [parentTag.code]
      : ([parentTag.tagValue].filter(Boolean) as string[])
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

    const specializedChildren: DimensionTag[] = []
    const subChildTagsMap = new DimensionChildTagsMap()

    const parentCodePath =
      parentTag.codePath ||
      (parentTag.code ? normalizeCodePath(`/${resolveDimensionCode(group)}/${parentTag.code}`) : '')
    const parentNamePath = parentTag.namePath || `/${group.name}/${parentTag.tagValue}`
    const effectiveHost =
      parentTag.hostScopeCode ||
      (parentTag.level === 1 ? parentTag.code : undefined) ||
      parentTag.code ||
      undefined

    for (const childTag of directChildren) {
      const tagCodeSeg = childTag.code || childTag.tagValue
      // 路径合法性与分支继承 (PRD-0058 / ISS-08)：
      // 1. 若 childTag.codePath 已经合法地处于 parentCodePath 前缀下（可能因本体中间跳级或路径压缩含有更多段），
      //    必须优先保留其权威路径，防止自拼路径丢失中间段而在 pathCountMap 中查空断流；
      // 2. 若 childTag.codePath 缺失，或属于跨分支脏路径（不以 parentCodePath 为前缀），
      //    则沿当前父分支重新物化纠偏为 parentCodePath + '/' + tagCodeSeg。
      const isConsistentWithParent = Boolean(
        parentCodePath &&
        childTag.codePath &&
        (childTag.codePath === parentCodePath || childTag.codePath.startsWith(parentCodePath + '/'))
      )

      const branchCodePath = isConsistentWithParent
        ? childTag.codePath
        : parentCodePath
          ? normalizeCodePath(`${parentCodePath}/${tagCodeSeg}`)
          : childTag.codePath

      const branchNamePath =
        isConsistentWithParent && childTag.namePath
          ? childTag.namePath
          : parentNamePath
            ? `${parentNamePath}/${childTag.tagValue}`
            : childTag.namePath

      let branchFileCount = childTag.fileCount
      if (branchCodePath && pathCountMap) {
        if (pathCountMap[branchCodePath] !== undefined) {
          branchFileCount = pathCountMap[branchCodePath]
        } else if (hasPathIndex) {
          branchFileCount = 0
        }
      }

      const specializedChild: DimensionTag = {
        ...childTag,
        codePath: branchCodePath,
        namePath: branchNamePath,
        hostScopeCode: effectiveHost,
        fileCount: branchFileCount
      }

      const grandSub = buildChildNode(specializedChild, currentVisualDepth + 1)
      const hasGrandDescendants = Boolean(
        grandSub &&
        ((grandSub.tags && grandSub.tags.length > 0) ||
          (grandSub.childTags && grandSub.childTags.size > 0))
      )

      if (removeEmptyTags && branchFileCount === 0 && !hasGrandDescendants) {
        continue
      }

      specializedChildren.push(specializedChild)

      if (grandSub) {
        const parentKey = parentTag.code || parentTag.tagValue
        const key = dimensionNodeKey(parentKey, specializedChild)
        const aliases = [specializedChild.tagValue, `${parentKey}::${specializedChild.tagValue}`]
        subChildTagsMap.set(key, [grandSub], aliases)
      }
    }

    if (removeEmptyTags && specializedChildren.length === 0) {
      return null
    }

    return {
      id: group.id * 10000 + currentVisualDepth * 100 + (parentTag.order || 1),
      name: parentTag.tagValue,
      code: parentTag.code || `${resolveDimensionCode(group)}.${parentTag.tagValue}`,
      level: currentVisualDepth - 1,
      tags: specializedChildren,
      childTags: subChildTagsMap.size > 0 ? subChildTagsMap : undefined,
      isMultiSelect: parentTag.isMultiSelect ?? false,
      metadata: group.metadata
    }
  }

  directTags.forEach(parentTag => {
    if (level === 0 && !parentTag.hostScopeCode) {
      parentTag.hostScopeCode = parentTag.code || undefined
    }
    if (!parentTag.codePath && parentTag.code) {
      parentTag.codePath = normalizeCodePath(`/${resolveDimensionCode(group)}/${parentTag.code}`)
    }
    // 直属标签所在层为 baseVisualDepth，其展开的子节点所在视觉深度为 baseVisualDepth + 1 (即 3)
    const subNode = buildChildNode(parentTag, baseVisualDepth + 1)
    if (subNode) {
      const parentKey = group.code || group.name
      const key = dimensionNodeKey(parentKey, parentTag)
      const aliases = [parentTag.tagValue, `${parentKey}::${parentTag.tagValue}`]
      childTagsMap.set(key, [subNode], aliases)
    }
  })

  // 跨层级同标签单一出现守卫（深层具象胜出，Spec v2.0 模块三）：
  // 若某标签在深层子树中已经存在（例如 Level 5 链条中的「要求」），则从顶层直属标签 directTags 中滤除，
  // 杜绝同一维度下同名/同 Code 标签在根下一级与深层分支同时重复呈现
  let finalDirectTags = directTags
  if (childTagsMap.size > 0) {
    const deepTagKeys = new Set<string>()
    function collectDeepKeys(node: DimensionTreeNode) {
      if (node.tags) {
        for (const t of node.tags) {
          if (t.code) deepTagKeys.add(t.code)
          if (t.tagValue) deepTagKeys.add(t.tagValue)
        }
      }
      if (node.childTags) {
        for (const subList of node.childTags.values()) {
          for (const sub of subList) {
            collectDeepKeys(sub)
          }
        }
      }
    }
    for (const subNodes of childTagsMap.values()) {
      for (const node of subNodes) {
        collectDeepKeys(node)
      }
    }

    const filteredDirectTags = directTags.filter(t => {
      const hasDeep =
        (t.code && deepTagKeys.has(t.code)) || (t.tagValue && deepTagKeys.has(t.tagValue))
      return !hasDeep
    })
    if (filteredDirectTags.length > 0 || directTags.length === 0) {
      finalDirectTags = filteredDirectTags
    }
  }

  return { directTags: finalDirectTags, childTagsMap }
}

/**
 * 递归构建维度树（支持基于 triggerTags 的细粒度层级与顶层主干开放准入，以及 maxScaleDepth 穿透提升）
 */
/**
 * 递归分支特化整棵维度子树 (Spec v2.0 §3.3 / TASK-01)
 *
 * 核心职责：
 * 1. 递归遍历深层维度与标签，为每个 childTag 注入真实的物理物化路径 branchCodePath（如 /builtin.file_type/.../builtin.theme/omw.06368628.n）；
 * 2. 注入受控 hostScopeCode（顶层介质大类受控码，如 hownet.000000207706.n 电子书）；
 * 3. 绝缘幽灵计数：严格查表 pathCountMap[branchCodePath] ?? 0，未命中时强制为 0，绝对严禁回退借用全局 childTag.fileCount；
 * 4. 环路与深度熔断：通过 visitedDimCodes 检测同链维度重复，超过 12 层或检测到环路立即断开 childTags；
 * 5. 零计数短路剪枝：在 removeEmptyTags: true 且当前 branchFileCount === 0 时，跳过深层递归，降低内存分配开销；
 * 6. 精确在当前 childTag 作用域内按 dimensionNodeKey 提取并特化其下属 childTags。
 */
export function specializeDimensionSubtree(
  node: DimensionTreeNode,
  parentCodePath: string,
  parentNamePath: string,
  hostScopeCode: string = '',
  pathCountMap?: Record<string, number>,
  visitedDimCodes: ReadonlySet<string> = new Set(),
  depth = 0,
  removeEmptyTags = false
): DimensionTreeNode {
  const segDimCode = resolveDimensionCode(node)

  // 环路与深度熔断保护 (ISS-03)
  if (depth > 12 || visitedDimCodes.has(segDimCode)) {
    return { ...node, childTags: undefined }
  }
  const nextVisited = new Set(visitedDimCodes).add(segDimCode)
  const nextChildTags = new DimensionChildTagsMap()

  const specializedTags = (node.tags || []).map(childTag => {
    // 空节点 codePath 派生强保底 (ISS-04)
    const tagCodeSeg = childTag.code || childTag.tagValue
    const branchCodePath = parentCodePath
      ? normalizeCodePath(`${parentCodePath}/${segDimCode}/${tagCodeSeg}`)
      : childTag.codePath
    const branchNamePath = parentNamePath
      ? `${parentNamePath}/${node.name}/${childTag.tagValue}`
      : childTag.namePath

    // 绝缘幽灵计数回退：未命中分支强制为 0 (PLAN-SEC-02 / ISS-08)
    const branchFileCount =
      branchCodePath && pathCountMap ? (pathCountMap[branchCodePath] ?? 0) : childTag.fileCount

    // 短路剪枝：开启隐藏空标签且当前分支计数为 0 时跳过深层递归 (ISS-03)
    const shouldPruneSubTree = removeEmptyTags && branchFileCount === 0

    // 精确在当前 childTag 作用域内匹配并递归其挂载的 childTags (ISS-02)
    if (!shouldPruneSubTree && node.childTags) {
      const parentKey = node.code || node.name
      const nodeKey = dimensionNodeKey(parentKey, childTag)
      const subNodes = node.childTags.get(nodeKey) || node.childTags.get(childTag.tagValue)

      if (subNodes && subNodes.length > 0) {
        const specializedSubNodes = subNodes
          .map(sub =>
            specializeDimensionSubtree(
              sub,
              branchCodePath || '',
              branchNamePath || '',
              hostScopeCode,
              pathCountMap,
              nextVisited,
              depth + 1,
              removeEmptyTags
            )
          )
          .filter(sub => {
            if (!removeEmptyTags) return true
            const hasTags = sub.tags && sub.tags.some(t => t.fileCount > 0)
            const hasChild = sub.childTags && sub.childTags.size > 0
            return Boolean(hasTags || hasChild)
          })

        if (specializedSubNodes.length > 0) {
          const aliases = [childTag.tagValue, `${parentKey}::${childTag.tagValue}`]
          nextChildTags.set(nodeKey, specializedSubNodes, aliases)
        }
      }
    }

    return {
      ...childTag,
      codePath: branchCodePath,
      namePath: branchNamePath,
      fileCount: branchFileCount,
      hostScopeCode
    }
  })

  const finalTags = removeEmptyTags
    ? specializedTags.filter(t => {
        if (t.fileCount > 0) return true
        const parentKey = node.code || node.name
        const nodeKey = dimensionNodeKey(parentKey, t)
        return nextChildTags.has(nodeKey) || nextChildTags.has(t.tagValue)
      })
    : specializedTags

  return {
    ...node,
    tags: finalTags,
    childTags: nextChildTags.size > 0 ? nextChildTags : undefined
  }
}

export function buildDimensionTree(
  dimensionGroups: DimensionGroup[],
  parentId: number | null = null,
  parentTag: string | null = null,
  level = 0,
  maxScaleDepth: number = 8,
  pathCountMap?: Record<string, number>,
  removeEmptyTags = false
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
    lvl = 0,
    parentTagObj?: DimensionTag
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
        const { directTags, childTagsMap } = nestGroupTags(
          group,
          group.tags || [],
          lvl,
          maxScaleDepth,
          pathCountMap,
          removeEmptyTags
        )

        const hasPathIndex = pathCountMap ? Object.keys(pathCountMap).length > 0 : false
        const finalDirectTags =
          lvl === 0
            ? directTags.map(t => {
                const rootPath =
                  t.codePath ||
                  (t.code ? normalizeCodePath(`/${resolveDimensionCode(group)}/${t.code}`) : '')
                let rootFileCount = t.fileCount
                if (rootPath && pathCountMap) {
                  if (pathCountMap[rootPath] !== undefined) {
                    rootFileCount = pathCountMap[rootPath]
                  } else if (hasPathIndex) {
                    rootFileCount = 0
                  }
                }
                return {
                  ...t,
                  codePath: rootPath || t.codePath,
                  fileCount: rootFileCount,
                  hostScopeCode:
                    t.hostScopeCode || (t.level === 1 ? t.code : undefined) || t.code || undefined
                }
              })
            : [...directTags]

        // 2. 关联外部细分维度组 (基于 triggerConditions / parentDimensionIds)
        const hasChildren = childrenSet.has(group.id)
        const baseVisualDepth = lvl + 2

        if (hasChildren) {
          if (baseVisualDepth >= maxScaleDepth) {
            // 当前层已达最大允许视觉深度 (如 maxScaleDepth <= 2)：
            // 外部细分维度及其标签严禁挂在深层 childTagsMap，必须穿透提升平铺在当前直属 directTags 列表中
            const initialDirectTags = [...finalDirectTags]
            const liftedDimTagsMap = new Map<string, DimensionTag>()
            const liftedLeafTagsMap = new Map<string, DimensionTag>()

            initialDirectTags.forEach(tag => {
              const externalChildren = recurse(group.id, tag.tagValue, lvl + 1, tag)
              if (externalChildren.length > 0) {
                const parentCodePath =
                  tag.codePath || (tag.code ? `/${resolveDimensionCode(group)}/${tag.code}` : '')
                const parentNamePath = tag.namePath || `/${group.name}/${tag.tagValue}`
                const hostScopeCode = tag.hostScopeCode || tag.code || undefined

                // 递归收集外部子维度及其深层所有标签
                function collectExtTreeTags(
                  nodes: DimensionTreeNode[],
                  curParentCodePath: string,
                  curParentNamePath: string
                ) {
                  for (const extNode of nodes) {
                    const segDimCode = resolveDimensionCode(extNode)
                    const parentBranchPrefix = curParentCodePath
                      ? normalizeCodePath(`${curParentCodePath}/${segDimCode}`)
                      : ''

                    // 2.1 外部子维度自身提升为标签项 (如 '语言细分')
                    const extDimKey = `${resolveDimensionCode(group)}::${extNode.code || extNode.id}`
                    const existingDim = liftedDimTagsMap.get(extDimKey)
                    const liftGroupCount =
                      parentBranchPrefix &&
                      pathCountMap &&
                      pathCountMap[parentBranchPrefix] !== undefined
                        ? pathCountMap[parentBranchPrefix]
                        : pathCountMap
                          ? 0
                          : (extNode.tags || []).reduce((sum, t) => sum + (t.fileCount || 0), 0)

                    if (!existingDim) {
                      liftedDimTagsMap.set(extDimKey, {
                        dimensionId: extNode.id,
                        dimensionCode: resolveDimensionCode(extNode),
                        dimensionName: extNode.name,
                        tagValue: extNode.name,
                        code: extNode.code || `${resolveDimensionCode(group)}.${extNode.name}`,
                        codePath: parentBranchPrefix || undefined,
                        codePaths: parentBranchPrefix ? [parentBranchPrefix] : undefined,
                        namePath: curParentNamePath
                          ? `${curParentNamePath}/${extNode.name}`
                          : undefined,
                        viaParentCode: resolveDimensionCode(group),
                        hostScopeCode,
                        level: baseVisualDepth,
                        fileCount: liftGroupCount,
                        isMultiSelect: extNode.isMultiSelect ?? false,
                        isLifted: true
                      })
                    } else {
                      if (
                        parentBranchPrefix &&
                        !(existingDim.codePaths || []).includes(parentBranchPrefix)
                      ) {
                        existingDim.codePaths = [
                          ...(existingDim.codePaths || []),
                          parentBranchPrefix
                        ]
                        existingDim.fileCount = (existingDim.codePaths || []).reduce(
                          (sum, p) => sum + (pathCountMap?.[p] ?? 0),
                          0
                        )
                      }
                    }

                    // 2.2 外部子维度包含的标签提升为直属标签 (如 '中文')
                    for (const extTag of extNode.tags || []) {
                      const tagCodeSeg = extTag.code || extTag.tagValue
                      const branchCodePath = curParentCodePath
                        ? normalizeCodePath(`${curParentCodePath}/${segDimCode}/${tagCodeSeg}`)
                        : extTag.codePath
                      const branchNamePath = curParentNamePath
                        ? `${curParentNamePath}/${extNode.name}/${extTag.tagValue}`
                        : extTag.namePath

                      const liftTagKey = `${resolveDimensionCode(group)}::${resolveDimensionCode(extNode)}::${tagCodeSeg}`
                      const existingTag = liftedLeafTagsMap.get(liftTagKey)

                      if (!existingTag) {
                        const initCount =
                          branchCodePath &&
                          pathCountMap &&
                          pathCountMap[branchCodePath] !== undefined
                            ? pathCountMap[branchCodePath]
                            : pathCountMap
                              ? 0
                              : extTag.fileCount

                        liftedLeafTagsMap.set(liftTagKey, {
                          ...extTag,
                          codePath: branchCodePath,
                          codePaths: branchCodePath ? [branchCodePath] : [],
                          namePath: branchNamePath,
                          viaParentCode: resolveDimensionCode(group),
                          hostScopeCode,
                          level: baseVisualDepth,
                          fileCount: initCount,
                          isLifted: true
                        })
                      } else {
                        if (
                          branchCodePath &&
                          !(existingTag.codePaths || []).includes(branchCodePath)
                        ) {
                          existingTag.codePaths = [...(existingTag.codePaths || []), branchCodePath]
                          existingTag.fileCount = (existingTag.codePaths || []).reduce(
                            (sum, p) => sum + (pathCountMap?.[p] ?? 0),
                            0
                          )
                        }
                      }

                      // 2.3 若外部维度标签下还有 childTags，递归收集
                      if (extNode.childTags) {
                        const parentKey = extNode.code || extNode.name
                        const nodeKey = dimensionNodeKey(parentKey, extTag)
                        const subNodes =
                          extNode.childTags.get(nodeKey) || extNode.childTags.get(extTag.tagValue)
                        if (subNodes && subNodes.length > 0) {
                          collectExtTreeTags(subNodes, branchCodePath || '', branchNamePath || '')
                        }
                      }
                    }
                  }
                }

                collectExtTreeTags(externalChildren, parentCodePath, parentNamePath)
              }
            })

            for (const lt of liftedDimTagsMap.values()) {
              finalDirectTags.push(lt)
            }
            for (const lt of liftedLeafTagsMap.values()) {
              finalDirectTags.push(lt)
            }
          } else {
            // 当前层未达最大深度：正常挂载到 childTagsMap 中
            finalDirectTags.forEach(tag => {
              const externalChildren = recurse(group.id, tag.tagValue, lvl + 1, tag)
              if (externalChildren.length > 0) {
                const parentKey = group.code || group.name
                const key = dimensionNodeKey(parentKey, tag)
                const aliases = [tag.tagValue, `${parentKey}::${tag.tagValue}`]
                const parentCodePath =
                  tag.codePath || (tag.code ? `/${resolveDimensionCode(group)}/${tag.code}` : '')
                const parentNamePath = tag.namePath || `/${group.name}/${tag.tagValue}`
                const hostScopeCode = tag.hostScopeCode || tag.code || ''

                // 分支特化深拷贝：为外部子维度及其深层子树整树派生物化路径、宿主与真实计数 (SSOT)
                const specializedChildren: DimensionTreeNode[] = externalChildren
                  .map(childDim =>
                    specializeDimensionSubtree(
                      childDim,
                      parentCodePath,
                      parentNamePath,
                      hostScopeCode,
                      pathCountMap,
                      new Set([resolveDimensionCode(group)]),
                      0,
                      removeEmptyTags
                    )
                  )
                  .filter(childDim => {
                    if (!removeEmptyTags) return true
                    const hasTags = childDim.tags && childDim.tags.some(t => t.fileCount > 0)
                    const hasChild = childDim.childTags && childDim.childTags.size > 0
                    return Boolean(hasTags || hasChild)
                  })

                if (specializedChildren.length > 0) {
                  const existing = childTagsMap.get(key) || []
                  childTagsMap.set(key, [...existing, ...specializedChildren], aliases)
                }
              }
            })
          }
        }

        return {
          ...group,
          level: lvl,
          tags: finalDirectTags,
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
