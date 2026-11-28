/**
 * 批量去重视图虚拟列表行模型（R-25 / W5-C）
 *
 * 将「分组卡片」扁平化为确定性高度的虚拟行序列：
 *   顶部间隙 -> [组头行 -> 内容行(图片网格分块 / 文档单文件) -> 组尾行] * N
 *
 * 设计要点：
 * 1. 行高全部由布局常量 + 容器宽度 + 文件元数据确定性推导（定高/变高混合），
 *    不做运行时 DOM 测量，滚动无布局抖动；窗口缩放时按新宽度整体重算。
 * 2. 组极值（最大体积 / 最高质量分 / 勾选数）用 reduce 循环预计算，
 *    严禁 Math.max(...files.map()) 展开——万级文件会触发调用栈溢出。
 * 3. 纯函数模块，不依赖 React 运行时，便于单测直接覆盖万级规模。
 */
import { DuplicateGroup, DuplicateFileItem } from '@firefly/types'
import { extractFileExtension } from '../../../../common/FileTypeIcon'

/** 常见图片扩展名集合（自 BatchDuplicateView 原样迁移，保持判定等价） */
const IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'bmp',
  'svg',
  'ico',
  'avif',
  'heic',
  'heif',
  'tiff',
  'tif'
])

/** 布局常量：与原卡片 p-4 / space-y-4 / 网格 minmax(140px,1fr) gap-3 视觉对齐 */
export const DUPLICATE_LIST_LAYOUT = {
  /** 中栏列表外侧水平留白（原 p-4） */
  outerPadX: 16,
  /** 组卡片内侧水平留白（原 p-4） */
  cardPadX: 16,
  /** 卡片左右边框合计 */
  cardBorderX: 2,
  /** 列表顶部留白（原 p-4 的上边距） */
  topGapHeight: 16,
  /** 组头行：上留白16 + 徽章行28 + pb-2.5(10) + 分隔线1 + 与内容间距14 ≈ 70 */
  headerRowHeight: 70,
  /** 组尾行：卡片下留白16 + 组间距16（原 space-y-4） */
  footerRowHeight: 32,
  /** 图片网格间隙（原 gap-3） */
  imageGap: 12,
  /** 图片卡片最小宽度（原 minmax(140px,1fr)） */
  imageMinCardWidth: 140,
  /** 图片卡片固定附加高度：p-2.5*2 + 边框 + mb-2 + 文件名行 + 规格行 + 安全余量 */
  imageCardExtraHeight: 50,
  /** 图片卡片含智能文件名第二行时的附加高度 */
  imageCardSmartNameHeight: 24,
  /** 文档列表行间隙（原 space-y-2） */
  listRowGap: 8,
  /** 文档列表基础行高：p-3*2 + max(图标40, 文本块) + 边框 + 安全余量 */
  listRowBaseHeight: 68,
  /** 文档列表含智能文件名行时的行高 */
  listRowSmartNameHeight: 84
} as const

/** 组级极值预计算结果（供组头与文件行徽标复用，避免每帧重复扫描） */
export interface GroupExtremes {
  maxSize: number
  bestScore: number
  selectedCount: number
}

/** 扁平化虚拟行描述符 */
export type DuplicateVirtualRow =
  | { kind: 'gap'; key: string; height: number }
  | {
      kind: 'header'
      key: string
      height: number
      group: DuplicateGroup
      groupIndex: number
      extremes: GroupExtremes
    }
  | {
      kind: 'image-chunk'
      key: string
      height: number
      group: DuplicateGroup
      groupIndex: number
      extremes: GroupExtremes
      files: DuplicateFileItem[]
      startIndex: number
      columns: number
    }
  | {
      kind: 'file'
      key: string
      height: number
      group: DuplicateGroup
      groupIndex: number
      extremes: GroupExtremes
      file: DuplicateFileItem
      fileIndex: number
    }
  | { kind: 'footer'; key: string; height: number }

export interface DuplicateVirtualRowsResult {
  rows: DuplicateVirtualRow[]
  /** 图片网格列数（随容器宽度重算） */
  columns: number
  /** 图片卡片实际宽度（px，用于行高推导） */
  cardWidth: number
}

/**
 * 判断某组是否以图片网格展示（自 BatchDuplicateView 原样迁移，保持判定等价）：
 * 异常与失效文件组必须以列表模式显示，以便突出排查理由。
 */
export function isImageGroup(group: DuplicateGroup): boolean {
  const isAnomaly =
    group.strategy === 'invalid_symlinks' ||
    group.strategy === 'broken_files' ||
    group.strategy === 'bad_extensions' ||
    group.strategy === 'bad_names'
  if (isAnomaly) return false

  if (group.strategy === 'image_phash') return true
  let imageCount = 0
  for (const f of group.files) {
    const ext = extractFileExtension(f.path) || extractFileExtension(f.name)
    if (IMAGE_EXTENSIONS.has(ext)) imageCount++
  }
  return imageCount > 0 && imageCount >= group.files.length / 2
}

/** 组极值预计算：reduce 循环，万级文件安全（严禁 spread 展开） */
export function computeGroupExtremes(group: DuplicateGroup): GroupExtremes {
  let maxSize = 0
  let bestScore = 0
  let selectedCount = 0
  for (const f of group.files) {
    const size = f.size || 0
    if (size > maxSize) maxSize = size
    const score = f.qualityScore || 0
    if (score > bestScore) bestScore = score
    if (f.selectedForDelete) selectedCount++
  }
  return { maxSize, bestScore, selectedCount }
}

/** 文件是否存在区别于真实文件名的智能文件名（决定行高是否需要第二行） */
function hasSmartName(file: DuplicateFileItem, fileMetaMap: Map<string, any>): boolean {
  const meta = fileMetaMap.get(file.path)
  return Boolean(meta?.smartName && meta.smartName !== file.name)
}

/**
 * 将过滤后的分组扁平化为确定性高度的虚拟行序列。
 * @param groups 过滤后的相似组（filteredGroups）
 * @param viewportWidth 中栏列表视口宽度（px）
 * @param fileMetaMap 真实路径 -> 文件元数据索引
 */
export function buildDuplicateVirtualRows(
  groups: DuplicateGroup[],
  viewportWidth: number,
  fileMetaMap: Map<string, any>
): DuplicateVirtualRowsResult {
  const L = DUPLICATE_LIST_LAYOUT
  const innerWidth = Math.max(0, viewportWidth - L.outerPadX * 2)
  const cardInnerWidth = Math.max(L.imageMinCardWidth, innerWidth - L.cardPadX * 2 - L.cardBorderX)
  // 与 CSS grid repeat(auto-fill, minmax(140px,1fr)) 的列数推导保持一致
  const columns = Math.max(
    1,
    Math.floor((cardInnerWidth + L.imageGap) / (L.imageMinCardWidth + L.imageGap))
  )
  const cardWidth = (cardInnerWidth - (columns - 1) * L.imageGap) / columns

  const rows: DuplicateVirtualRow[] = [{ kind: 'gap', key: 'top-gap', height: L.topGapHeight }]

  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi]
    const groupKey = group.groupId || String(gi)
    const extremes = computeGroupExtremes(group)

    rows.push({
      kind: 'header',
      key: `${groupKey}:header`,
      height: L.headerRowHeight,
      group,
      groupIndex: gi,
      extremes
    })

    if (isImageGroup(group)) {
      for (let start = 0; start < group.files.length; start += columns) {
        const chunk = group.files.slice(start, start + columns)
        let chunkHasSmartName = false
        for (const f of chunk) {
          if (hasSmartName(f, fileMetaMap)) {
            chunkHasSmartName = true
            break
          }
        }
        const cardHeight =
          Math.ceil(cardWidth) +
          L.imageCardExtraHeight +
          (chunkHasSmartName ? L.imageCardSmartNameHeight : 0)
        rows.push({
          kind: 'image-chunk',
          key: `${groupKey}:img:${start}`,
          height: cardHeight + L.imageGap,
          group,
          groupIndex: gi,
          extremes,
          files: chunk,
          startIndex: start,
          columns
        })
      }
    } else {
      for (let fi = 0; fi < group.files.length; fi++) {
        const file = group.files[fi]
        const itemHeight = hasSmartName(file, fileMetaMap)
          ? L.listRowSmartNameHeight
          : L.listRowBaseHeight
        rows.push({
          kind: 'file',
          key: `${groupKey}:file:${file.fileId || fi}`,
          height: itemHeight + L.listRowGap,
          group,
          groupIndex: gi,
          extremes,
          file,
          fileIndex: fi
        })
      }
    }

    rows.push({ kind: 'footer', key: `${groupKey}:footer`, height: L.footerRowHeight })
  }

  return { rows, columns, cardWidth }
}
