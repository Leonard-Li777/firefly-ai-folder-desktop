/**
 * 轻量物化代码路径归一化函数（确保以单斜杠开头、无尾部斜杠、去除多余双斜杠）
 */
export function normalizeCodePath(p: string): string {
  if (!p) return ''
  const trimmed = p.trim().replace(/\\/g, '/')
  const segments = trimmed.split('/').filter(Boolean)
  return segments.length > 0 ? `/${segments.join('/')}` : ''
}

import { DimensionGroup, DimensionTag, SelectedTag } from '@firefly/types'
import { isPanDimension, DIMENSION_CODES } from '@firefly/shared'
import { DimensionTreeNode } from './AnalyzedDirectory/types'

/** key 父级段的「常规父标签 code」前缀 */
const PARENT_CODE_PREFIX = 'parentCode:'
/** key 第 4 段的「分支消歧 codePath」前缀：多父维度（如语言细分）同名叶子在
 * 文档/电子书等不同分支下的 dimensionId/tagValue/viaParentCode/parentTagValue
 * 四元组完全相同（viaParentCode 均为语言细分自身），仅 codePath 不同。
 * 勾选 key 不携带 codePath 会导致跨分支勾选态共享（canon 4/0 同族口径分裂问题）。 */
const PATH_PREFIX = 'path:'
/**
 * builtin.content_tags 根节点恒定垫底序值（与 omni fast path / 回退路径 / TagTreeQuery 虚拟注入的 9999 三处口径统一）。
 * 虚拟注入组缺 order 时 id 回退会得到 28，受控根未全量到位时会误排前排，故比较层强制垫底。
 */
export const CONTENT_TAGS_TAIL_ORDER = 9999
/**
 * key 父级段的「穿透提升聚合行」前缀 (ADR-0034 §4 / M-4)：
 * 聚合行的 viaParentCode 被重写为提升容器，可能与容器直系真实实例的 key 撞车，
 * 仅凭 viaParentCode 无法区分「聚合行」与「直系实例」，故在 key 中显式打标，
 * 多选还原时聚合行走容器子树聚合口径、实例行走精确消歧口径，保证与单选 100% 一致。
 */
const LIFTED_PREFIX = 'liftCode:'

/**
 * 生成标签唯一 key（包含父标签标识以区分同名标签，V4 优先由 viaParentCode 驱动）
 *
 * 第 4 段（可选）为 `path:` + codePath 分支消歧段：多父受控维度（语言细分/地理位置/
 * 打码程度等）的同 code 叶子会在多个媒体分支下各自现身，四元组
 * (dimensionId, tagValue, parentTagValue, viaParentCode) 在各分支下完全相同，
 * 唯有 codePath（完整物化链）不同——不带第 4 段会导致勾选态跨分支串选。
 * 无 codePath 的行（聚合行/旧数据）key 与历史三段格式逐字节一致，localStorage 旧存档兼容。
 *
 * @param isLifted 是否为穿透提升聚合行（打 liftCode 标记，多选还原时按聚合口径处理）
 * @param codePath 标签的完整物化代码路径（分支消歧锚，可选）
 */
export function makeTagKey(
  dimensionId: number,
  tagValue: string,
  parentTagValue?: string,
  viaParentCode?: string,
  isLifted = false,
  codePath?: string,
  hostScopeCode?: string
): string {
  let parentIdStr = ''
  const trimmedPath = codePath?.trim()
  const effectiveHost = hostScopeCode || parentTagValue

  if (viaParentCode) {
    const hostSuffix =
      effectiveHost && !trimmedPath && effectiveHost !== viaParentCode ? `@${effectiveHost}` : ''
    parentIdStr = `${isLifted ? LIFTED_PREFIX : PARENT_CODE_PREFIX}${viaParentCode}${hostSuffix}`
  } else if (effectiveHost) {
    parentIdStr = effectiveHost
  }
  const base = `${dimensionId}::${parentIdStr}::${tagValue}`
  return trimmedPath ? `${base}::${PATH_PREFIX}${trimmedPath}` : base
}

/**
 * 构造维度子树与标签层级键 (Spec v4 §7 / PRD-0058)
 * 供生产端 (dimension-tree-utils.ts) 与消费端 (DimensionTreeSidebar.tsx) 共用
 *
 * @param parentKey 父级标识（父维度 code/name 或 父标签 code/tagValue）
 * @param tag 子标签对象或其字符串键
 */
/**
 * 维度子树专用 Map (Spec v4 §7 / PRD-0058)
 * 默认使用 dimensionNodeKey 层级键精确索引，并在调用方仅传入 tagValue/code 时安全降级后缀匹配
 */
export class DimensionChildTagsMap extends Map<string, DimensionTreeNode[]> {
  private aliases = new Map<string, string>()

  set(key: string, value: DimensionTreeNode[], alias?: string | string[]): this {
    super.set(key, value)
    if (alias) {
      const aliasList = Array.isArray(alias) ? alias : [alias]
      for (const a of aliasList) {
        if (a && a !== key) {
          this.aliases.set(a, key)
        }
      }
    }
    return this
  }

  get(key: string): DimensionTreeNode[] | undefined {
    const direct = super.get(key)
    if (direct !== undefined) return direct
    const aliased = this.aliases.get(key)
    if (aliased !== undefined) {
      const fromAlias = super.get(aliased)
      if (fromAlias !== undefined) return fromAlias
    }
    if (!key.includes('::')) {
      for (const [k, v] of this.entries()) {
        if (k.endsWith(`::${key}`) || v[0]?.name === key) {
          return v
        }
      }
    }
    return undefined
  }

  has(key: string): boolean {
    if (super.has(key)) return true
    const aliased = this.aliases.get(key)
    if (aliased !== undefined && super.has(aliased)) return true
    if (!key.includes('::')) {
      for (const [k, v] of this.entries()) {
        if (k.endsWith(`::${key}`) || v[0]?.name === key) {
          return true
        }
      }
    }
    return false
  }
}

export const dimensionNodeKey = (
  parentKey: string,
  tag: { code?: string; tagValue?: string } | string
): string => {
  const tagKey = typeof tag === 'string' ? tag : (tag.code || tag.tagValue || '')
  if (tagKey.startsWith(`${parentKey}::`)) {
    return tagKey
  }
  return `${parentKey}::${tagKey}`
}

/**
 * 从 key 中解析出各部分
 */
export function parseTagKey(key: string) {
  const parts = key.split('::')
  // 第 4 段（可选）：`path:` + codePath 分支消歧段（makeTagKey 文档见上）
  let codePath: string | undefined
  if (parts.length > 3 && parts[parts.length - 1].startsWith(PATH_PREFIX)) {
    codePath = parts[parts.length - 1].slice(PATH_PREFIX.length)
    parts.pop()
  }
  const parentPart = parts[1] || ''
  const isLifted = parentPart.startsWith(LIFTED_PREFIX)
  const isParentCode = isLifted || parentPart.startsWith(PARENT_CODE_PREFIX)
  let viaParent = isLifted
    ? parentPart.slice(LIFTED_PREFIX.length)
    : isParentCode
      ? parentPart.slice(PARENT_CODE_PREFIX.length)
      : undefined
  let contextualHost: string | undefined
  if (viaParent && viaParent.includes('@')) {
    const atIdx = viaParent.indexOf('@')
    contextualHost = viaParent.slice(atIdx + 1)
    viaParent = viaParent.slice(0, atIdx)
  }
  return {
    dimensionId: parseInt(parts[0], 10),
    parentTagValue: contextualHost || (isParentCode ? undefined : (parentPart || undefined)),
    hostScopeCode: contextualHost,
    viaParentCode: viaParent,
    isLifted,
    tagValue: parts.slice(2).join('::'),
    codePath
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
 * 1. order: 内置顺序（升序优先，如 1 < 2 < 3；仅 > 0 视为已设置，0 = 未设置）
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

  // 1.4 builtin.content_tags 恒定垫底特例（三处 9999 口径统一：omni fast path / omni 回退路径 / 本前端）
  if (node.code === DIMENSION_CODES.CONTENT_TAGS) {
    orderVal = CONTENT_TAGS_TAIL_ORDER
  }

  // 语义约定与后端一致：order/sort_order 仅在 > 0 时视为已设置，0 = 未设置（对齐 TagTreeQuery 与 taxonomy.rs 的 `order > 0` 判据）
  const hasOrder = typeof orderVal === 'number' && Number.isFinite(orderVal) && orderVal > 0
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
  // builtin.content_tags 恒定垫底（无条件，优先于全部权重档）：
  // 仅靠 order=9999 不够——hasOrder 根永远排在未设置档之前，正序根稀少时会卡在未设置根之前；
  // 与 omni fast path / 回退路径 / TagTreeQuery 出口的 9999 特例口径统一，但最终裁决以本判定为准
  const isTailA = a.code === DIMENSION_CODES.CONTENT_TAGS
  const isTailB = b.code === DIMENSION_CODES.CONTENT_TAGS
  if (isTailA !== isTailB) return isTailA ? 1 : -1

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
 * 标签父子索引（code/tagValue 双键登记）。
 * 穿透提升（单选聚合行）与多选聚合还原必须共用同一份索引口径，否则两模式视野会分叉。
 */
interface TagParentIndex {
  tagByCode: Map<string, DimensionTag>
  tagByName: Map<string, DimensionTag>
  tagsByParent: Map<string, DimensionTag[]>
}

/**
 * 构建标签父子索引：根据 viaParentCode 归类子标签，
 * 优先精确按 Code 登记父子关系，杜绝跨异码同名标签错误广播子树
 */
function buildTagParentIndex(tags: DimensionTag[]): TagParentIndex {
  // 1. 构建 code -> tag 与 tagValue -> tag 快速索引
  const tagByCode = new Map<string, DimensionTag>()
  const tagByName = new Map<string, DimensionTag>()
  const tagsByParent = new Map<string, DimensionTag[]>()

  for (const t of tags) {
    if (t.code) tagByCode.set(t.code, t)
    if (t.tagValue) tagByName.set(t.tagValue, t)
  }

  // 2. 根据 viaParentCode 归类子标签（机器码精确匹配优先）
  for (const t of tags) {
    const parentKey = t.viaParentCode
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
        const pKeys = new Set([parentKey, parentByName.code, parentByName.tagValue].filter(Boolean) as string[])
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

  return { tagByCode, tagByName, tagsByParent }
}

/**
 * 递归收集任意父标签下的所有深层子孙标签（用于穿透提升）：
 * 按对象身份防环遍历多父 DAG，保留同 Code/同名的全部分支实例，
 * 合并去重延后至提升聚合阶段完成，确保跨分支物化路径集合 codePaths 零丢失
 */
function collectDescendantTags(startTag: DimensionTag, index: TagParentIndex): DimensionTag[] {
  const result: DimensionTag[] = []
  // 已访问实例集合：多父 DAG 中同一实例可能被多条分支同时到达，按对象身份去环保证终止
  const visited = new Set<DimensionTag>([startTag])
  const containerPrefixes = [
    startTag.codePath,
    ...(startTag.codePaths || [])
  ].filter(Boolean) as string[]
  const containerHost = startTag.hostScopeCode || (startTag.level === 1 ? startTag.code : undefined)

  function collectAll(curr: DimensionTag) {
    // 优先以机器码查找直接子节点，缺失机器码时才以 tagValue 兜底
    const keys = curr.code
      ? [curr.code]
      : ([curr.tagValue].filter(Boolean) as string[])
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
function aggregateLiftedTags(
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
  maxScaleDepth: number = 7,
  pathCountMap?: Record<string, number>,
  removeEmptyTags = false
): { directTags: DimensionTag[]; childTagsMap: DimensionChildTagsMap } {
  const childTagsMap = new DimensionChildTagsMap()
  if (!tags || tags.length === 0) {
    return { directTags: [], childTagsMap }
  }
  const hasPathIndex = pathCountMap ? Object.keys(pathCountMap).length > 0 : false

  // 1-2. 构建 code/name 双键父子索引（与多选聚合还原共用同一口径）
  const index = buildTagParentIndex(tags)
  const { tagsByParent } = index

  // 3. 确定当前层级的直属候选标签 (rawDirectTags)：
  // 顶层直属标签优先由 level === 1 或 viaParentCode === group.code 确定
  const rawDirectTags: DimensionTag[] = []
  for (const t of tags) {
    const parentKey = t.viaParentCode
    const isLevel1 = t.level === 1 || parentKey === group.code || (!parentKey && (!t.level || t.level <= 1))
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

      const liftedTags = aggregateLiftedTags(descendants, containerTag, baseVisualDepth, pathCountMap, removeEmptyTags)
      for (const lt of liftedTags) {
        const isContainerSelf = lt.code
          ? lt.code === containerTag.code
          : !containerTag.code && lt.tagValue === containerTag.tagValue
        if (!isContainerSelf) directTags.push(lt)
      }
    }
    return { directTags, childTagsMap }
  }

  // 5. 当 baseVisualDepth < maxScaleDepth 时：
  // 递归根据 tagsByParent 构建深层多级子树（支持 ADR-0034 §4 刻度穿透提升）
  function buildChildNode(parentTag: DimensionTag, currentVisualDepth: number): DimensionTreeNode | null {
    // 若当前层级视觉深度达到或超过用户设定的刻度上限，则所有更深层子孙标签穿透提升（Pass-through Lift-up），
    // 汇聚挂载在当前刻度父级节点下，且该层不再向下生成更深层孙级节点 (ADR-0034 §4)
    if (currentVisualDepth >= maxScaleDepth) {
      const descendants = collectDescendantTags(parentTag, index)
      if (descendants.length === 0) return null

      // 跨分支同名/同 Code 提升聚合 (ADR-0034 §4 / M-4)，聚合口径见 aggregateLiftedTags 注释
      const liftedTags: DimensionTag[] = aggregateLiftedTags(descendants, parentTag, currentVisualDepth, pathCountMap, removeEmptyTags)

      if (removeEmptyTags && liftedTags.length === 0) return null

      return {
        id: group.id * 10000 + currentVisualDepth * 100 + (parentTag.order || 1),
        name: parentTag.tagValue,
        code: parentTag.code || `${group.code || group.id}.${parentTag.tagValue}`,
        level: currentVisualDepth - 1,
        tags: liftedTags,
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

    const parentCodePath = parentTag.codePath || (parentTag.code ? normalizeCodePath(`/${group.code || group.id}/${parentTag.code}`) : '')
    const parentNamePath = parentTag.namePath || `/${group.name}/${parentTag.tagValue}`
    const effectiveHost = parentTag.hostScopeCode || (parentTag.level === 1 ? parentTag.code : undefined) || parentTag.code || undefined

    for (const childTag of directChildren) {
      const tagCodeSeg = childTag.code || childTag.tagValue
      const branchCodePath = parentCodePath
        ? normalizeCodePath(`${parentCodePath}/${tagCodeSeg}`)
        : childTag.codePath
      const branchNamePath = parentNamePath
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
        ((grandSub.tags && grandSub.tags.length > 0) || (grandSub.childTags && grandSub.childTags.size > 0))
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
      code: parentTag.code || `${group.code || group.id}.${parentTag.tagValue}`,
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
      parentTag.codePath = normalizeCodePath(`/${group.code || group.id}/${parentTag.code}`)
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
      const hasDeep = (t.code && deepTagKeys.has(t.code)) || (t.tagValue && deepTagKeys.has(t.tagValue))
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
  const segDimCode = node.code || `dim.${node.id}`

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
  maxScaleDepth: number = 7,
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
        const finalDirectTags = lvl === 0
          ? directTags.map(t => {
              const rootPath = t.codePath || (t.code ? normalizeCodePath(`/${group.code || group.id}/${t.code}`) : '')
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
                hostScopeCode: t.hostScopeCode || (t.level === 1 ? t.code : undefined) || t.code || undefined
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
                const parentCodePath = tag.codePath || (tag.code ? `/${group.code || group.id}/${tag.code}` : '')
                const parentNamePath = tag.namePath || `/${group.name}/${tag.tagValue}`
                const hostScopeCode = tag.hostScopeCode || tag.code || undefined

                // 递归收集外部子维度及其深层所有标签
                function collectExtTreeTags(
                  nodes: DimensionTreeNode[],
                  curParentCodePath: string,
                  curParentNamePath: string
                ) {
                  for (const extNode of nodes) {
                    const segDimCode = extNode.code || `dim.${extNode.id}`
                    const parentBranchPrefix = curParentCodePath
                      ? normalizeCodePath(`${curParentCodePath}/${segDimCode}`)
                      : ''

                    // 2.1 外部子维度自身提升为标签项 (如 '语言细分')
                    const extDimKey = `${group.code || group.id}::${extNode.code || extNode.id}`
                    const existingDim = liftedDimTagsMap.get(extDimKey)
                    const liftGroupCount =
                      parentBranchPrefix && pathCountMap && pathCountMap[parentBranchPrefix] !== undefined
                        ? pathCountMap[parentBranchPrefix]
                        : pathCountMap
                          ? 0
                          : (extNode.tags || []).reduce((sum, t) => sum + (t.fileCount || 0), 0)

                    if (!existingDim) {
                      liftedDimTagsMap.set(extDimKey, {
                        dimensionId: extNode.id,
                        dimensionCode: extNode.code || `builtin.dim.${extNode.id}`,
                        dimensionName: extNode.name,
                        tagValue: extNode.name,
                        code: extNode.code || `${group.code || group.id}.${extNode.name}`,
                        codePath: parentBranchPrefix || undefined,
                        codePaths: parentBranchPrefix ? [parentBranchPrefix] : undefined,
                        namePath: curParentNamePath ? `${curParentNamePath}/${extNode.name}` : undefined,
                        viaParentCode: group.code || group.name,
                        hostScopeCode,
                        level: baseVisualDepth,
                        fileCount: liftGroupCount,
                        isMultiSelect: extNode.isMultiSelect ?? false,
                        isLifted: true
                      })
                    } else {
                      if (parentBranchPrefix && !(existingDim.codePaths || []).includes(parentBranchPrefix)) {
                        existingDim.codePaths = [...(existingDim.codePaths || []), parentBranchPrefix]
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

                      const liftTagKey = `${group.code || group.id}::${extNode.code || extNode.id}::${tagCodeSeg}`
                      const existingTag = liftedLeafTagsMap.get(liftTagKey)

                      if (!existingTag) {
                        const initCount =
                          branchCodePath && pathCountMap && pathCountMap[branchCodePath] !== undefined
                            ? pathCountMap[branchCodePath]
                            : pathCountMap
                              ? 0
                              : extTag.fileCount

                        liftedLeafTagsMap.set(liftTagKey, {
                          ...extTag,
                          codePath: branchCodePath,
                          codePaths: branchCodePath ? [branchCodePath] : [],
                          namePath: branchNamePath,
                          viaParentCode: group.code || group.name,
                          hostScopeCode,
                          level: baseVisualDepth,
                          fileCount: initCount,
                          isLifted: true
                        })
                      } else {
                        if (branchCodePath && !(existingTag.codePaths || []).includes(branchCodePath)) {
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
                        const subNodes = extNode.childTags.get(nodeKey) || extNode.childTags.get(extTag.tagValue)
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
                const parentCodePath = tag.codePath || (tag.code ? `/${group.code || group.id}/${tag.code}` : '')
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
                      new Set([group.code || `dim.${group.id}`]),
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
      const children = childTags!.get(dimensionNodeKey(group.code || group.name, tag)) || childTags!.get(tag.tagValue)
      if (
        children &&
        children.some(child => {
          function hasAnyPositiveDescendant(node: DimensionTreeNode, parentTagValue?: string): boolean {
            let tagsToInspect = node.tags
            const effectiveParentValue = parentTagValue || tag.tagValue
            if (node.contextualTags && effectiveParentValue && node.contextualTags[effectiveParentValue]) {
              const isL3Ext = /扩展名|Extension/i.test(node.name)
              if (!isL3Ext) {
                tagsToInspect = node.contextualTags[effectiveParentValue]
              }
            }
            if (tagsToInspect && tagsToInspect.some(t => t.fileCount > 0)) return true
            if (node.childTags instanceof Map) {
              for (const subList of node.childTags.values()) {
                if (subList.some(subNode => hasAnyPositiveDescendant(subNode, node.name))) return true
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
      index = buildTagParentIndex(group.tags || [])
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

    const effectiveViaParent =
      parsed.viaParentCode || tagItem?.viaParentCode || undefined

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
          keys.push(
            ...getAllKeys(childNodes, tag.tagValue, currentChain, collapsedDimensionGroups)
          )
        }
      }
    })

    if (node.childTags) {
      for (const [childKey, childNodes] of node.childTags) {
        if (!visitedChildKeys.has(childKey)) {
          const fallbackTag = childKey.includes('::') ? childKey.split('::').pop()! : childKey
          keys.push(
            ...getAllKeys(childNodes, fallbackTag, [...chain, fallbackTag], collapsedDimensionGroups)
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
  const {
    prevSelected,
    prevStack,
    prevParentMap,
    currentVisibleGroups,
    masterDimensionGroups
  } = params

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
    masterIndexMap.set(g.id, buildTagParentIndex(g.tags || []))
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
      const containerTag = masterIndex.tagByCode.get(containerKey) || masterIndex.tagByName.get(containerKey)
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

        const containerTag = masterIndex.tagByCode.get(containerKey) || masterIndex.tagByName.get(containerKey)
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
