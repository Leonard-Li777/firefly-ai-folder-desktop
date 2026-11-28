/**
 * R-27（W6）超大文件拆分片段，原 `.tmp-orig-dimension.ts` 的物理子模块。
 * 由原文件切片生成，保留全部既有实现与注释。
 */
import { DIMENSION_CODES, concept, ROOT_DIMENSION_META } from '@firefly/shared'
import { DimensionTreeNode } from '../AnalyzedDirectory/types'

/**
 * 轻量物化代码路径归一化函数（确保以单斜杠开头、无尾部斜杠、去除多余双斜杠）
 */
export function normalizeCodePath(p: string): string {
  if (!p) return ''
  const trimmed = p.trim().replace(/\\/g, '/')
  const segments = trimmed.split('/').filter(Boolean)
  return segments.length > 0 ? `/${segments.join('/')}` : ''
}

/**
 * 确定性解析维度根受控代码（消除 dim.{id} / builtin.dim.{id} 伪受控码构造）
 */
export function resolveDimensionCode(node: {
  id?: number | string
  code?: string
  name?: string
}): string {
  if (node.code && node.code.trim()) return node.code.trim()
  const numId = Number(node.id)
  if (numId === 4) return concept('作者')
  if (numId === 16) return concept('地理位置')
  if (numId === 28) return concept('内容标签')
  const entry = Object.entries(ROOT_DIMENSION_META).find(([_, meta]) => meta.id === numId)
  if (entry) return entry[0]
  if (node.name) {
    const nameEntry = Object.entries(ROOT_DIMENSION_META).find(
      ([_, meta]) => meta.name === node.name
    )
    if (nameEntry) return nameEntry[0]
    if (node.name === '作者') return concept('作者')
    if (node.name === '地理位置') return concept('地理位置')
    if (node.name === '内容标签') return concept('内容标签')
  }
  return node.id !== undefined && node.id !== null ? `group_${node.id}` : 'group_unknown'
}

/**
 * 判断指定的父级编码/名称是否指向维度根自身（消除对根维度的误挂载与误判定）
 */
export function isRootDimensionCodeOrName(
  group: { id?: number | string; code?: string; name?: string },
  candidate?: string | null
): boolean {
  if (!candidate || !candidate.trim()) return true
  const p = candidate.trim()
  const rootCode = resolveDimensionCode(group)
  if (
    p === rootCode ||
    p === group.code ||
    p === group.name ||
    (group.id !== undefined && p === String(group.id))
  )
    return true

  const id = Number(group.id)
  const authorCode = concept('作者')
  if (id === 4 || group.code === authorCode || group.name === '作者') {
    if (p === authorCode || p === '作者') return true
  }

  const geoCode = concept('地理位置')
  if (
    id === 16 ||
    group.code === geoCode ||
    group.code === 'hownet.000000010078.n' ||
    group.name === '地理位置'
  ) {
    if (p === geoCode || p === 'hownet.000000010078.n' || p === '地理位置') return true
  }

  const contentCode = concept('内容标签')
  if (
    id === 28 ||
    group.code === DIMENSION_CODES.CONTENT_TAGS ||
    group.code === contentCode ||
    group.name === '内容标签'
  ) {
    if (p === DIMENSION_CODES.CONTENT_TAGS || p === contentCode || p === '内容标签') {
      return true
    }
  }

  return false
}

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
  const tagKey = typeof tag === 'string' ? tag : tag.code || tag.tagValue || ''
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
    parentTagValue: contextualHost || (isParentCode ? undefined : parentPart || undefined),
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
