import React, { useState, useCallback, useMemo, useEffect } from 'react'
import {
  formatDateTimeShort,
  logger,
  LogCategory,
  isCategory,
  FileCategory
} from '@firefly/shared'
import { MaterialIcon, cn } from '../../../../lib/utils'
import { t } from '@app/languages'
import { toast } from '../../../common/Toast'
import { SystemFileIcon } from '../../../common/SystemFileIcon'
import { HighlightText } from '../../../common/HighlightText'
import { FileType } from '../types'
import { formatVideoTimestamp, clampVideoTime } from '../../../../lib/video-preview-utils'
import { getExtFromSmartName } from '../../../../lib/preview-utils'
import { usePreviewOverlayStore } from '../../../../stores/preview-overlay-store'
import { PageId, PAGE_IDS } from '../../../../constants/page-ids'
import { useSearchStore } from '../../../../stores/search-store'
import { getOrganizedSearchTags, OrganizedTagItem } from './search-list-tag-utils'

/**
 * 搜索列表模式专用行高（三行式多模态卡片排版，规格书定高 104px）
 */
export const SEARCH_LIST_ROW_HEIGHT = 104

/**
 * XSS 安全转义：将 snippet 中的 HTML 特殊字符转义后，仅放行受信任的 <mark> 高亮标签，
 * 服务端返回的其它任何标签（如 <script>、<img onerror>）都会被转义为纯文本展示
 */
export const sanitizeSnippetHtml = (snippet?: string): string => {
  if (!snippet) return ''
  const escaped = snippet
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
  // 转义后还原受信任的高亮标签
  return escaped.replace(/&lt;mark&gt;/g, '<mark>').replace(/&lt;\/mark&gt;/g, '</mark>')
}

/**
 * 转换本地路径为安全的 Chromium file:/// 协议 URL
 * 编码非 ASCII 字符以及 #、?、% 等特殊 URL 关键字符，防止被截断或解析错乱
 */
export function toSafeFileUrl(filePath: string): string {
  if (!filePath) return ''
  const unified = filePath.replace(/\\/g, '/').replace(/\/+/g, '/')
  const segments = unified.split('/')
  const encoded = segments
    .map((seg, i) => {
      if (i === 0 && /^[a-zA-Z]:$/.test(seg)) return seg
      return encodeURIComponent(seg)
    })
    .join('/')
  return `file://${encoded.startsWith('/') ? '' : '/'}${encoded}`
}

/**
 * 视频切片微型抽帧帧卡片（标准 16:9 画幅，时间锚定抽帧缩图预览，Hover 提示完整起止时间与相似度）
 */
const VideoChunkFrame: React.FC<{
  chunk: {
    chunkIndex?: number
    startSec: number
    endSec: number
    similarity?: number
    score?: number
  }
  filePath: string
  category?: any
  frameHeight?: number
  onPreviewSeek: (startSec: number, endSec: number) => void
  onItemSelect?: (e: React.MouseEvent) => void
}> = ({ chunk, filePath, category, frameHeight = 38, onPreviewSeek, onItemSelect }) => {
  const [hasError, setHasError] = useState(false)

  const videoUrl = useMemo(() => {
    if (!filePath) return ''
    const base = toSafeFileUrl(filePath)
    const safeTime = clampVideoTime(chunk.startSec, 3600)
    return `${base}#t=${safeTime}`
  }, [filePath, chunk.startSec])

  // 虚拟行复用时重置错误状态
  useEffect(() => {
    setHasError(false)
  }, [filePath, chunk.startSec])

  const chunkPercent =
    typeof chunk.similarity === 'number'
      ? Math.round(Math.min(1, Math.max(0, chunk.similarity)) * 100)
      : typeof chunk.score === 'number'
        ? Math.round(Math.min(1, Math.max(0, chunk.score)) * 100)
        : null

  // 悬浮到单帧上显示精准起止时间与相似度
  const frameTooltip = `${formatVideoTimestamp(chunk.startSec)} - ${formatVideoTimestamp(chunk.endSec)}${
    chunkPercent !== null ? ` (${t('相似度')}: ${chunkPercent}%)` : ''
  }\n${t('单击跳轴预览，双击外部播放器打开')}`

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    onItemSelect?.(e)
    onPreviewSeek(chunk.startSec, chunk.endSec)
  }

  const handleDoubleClick = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      const rawCat = category
      const cat = typeof rawCat === 'object' && rawCat !== null ? rawCat.label : rawCat
      const outcome = await window.electronAPI?.utils?.launchExternalDeepLink?.({
        filePath,
        category: cat || 'video',
        seekSeconds: chunk.startSec
      })
      if (outcome?.fallbackToDefault) {
        toast.info(t('未检测到支持精准定位的外部应用，已按默认方式打开'))
      }
    } catch (err: unknown) {
      logger.error(LogCategory.RENDERER, '外部深链定位打开失败:', err)
      toast.error(t('打开文件失败'))
    }
  }

  const frameWidth = Math.round(frameHeight * (16 / 9))
  return (
    <div
      style={{ height: `${frameHeight}px`, width: `${frameWidth}px` }}
      className="relative shrink-0 overflow-hidden bg-black/70 rounded border border-border/60 hover:border-primary/90 hover:ring-1 hover:ring-primary/80 transition-all cursor-pointer group/chunk select-none flex items-center justify-center"
      title={frameTooltip}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
    >
      {/* 视频指定时间点抽帧缩略图，破损时平滑回退占位图标 */}
      {!hasError && videoUrl ? (
        <video
          src={videoUrl}
          preload="metadata"
          muted
          playsInline
          className="w-full h-full object-cover pointer-events-none group-hover/chunk:scale-105 transition-transform duration-200"
          onError={() => setHasError(true)}
        />
      ) : (
        <MaterialIcon icon="movie" className="text-muted-foreground/50 text-base" />
      )}

      {/* Hover 遮罩与跳轴播放图标 */}
      <div className="absolute inset-0 bg-black/35 opacity-0 group-hover/chunk:opacity-100 flex items-center justify-center transition-opacity">
        <MaterialIcon icon="play_arrow" className="text-white drop-shadow text-base" />
      </div>

      {/* 底部微型起止时间胶囊（平时隐藏，Hover 时浮现，保持预览画面纯净无遮挡） */}
      <div className="absolute bottom-0.5 right-0.5 rounded bg-black/85 font-mono text-white/90 backdrop-blur-xs flex items-center gap-0.5 px-1 py-0.2 text-[9px] shadow-xs border border-white/10 pointer-events-none opacity-0 group-hover/chunk:opacity-100 transition-opacity">
        <span>{formatVideoTimestamp(chunk.startSec)}</span>
        {chunkPercent !== null && (
          <span className="text-violet-300 font-semibold">{`${chunkPercent}%`}</span>
        )}
      </div>
    </div>
  )
}

/**
 * 音频切片轻量 ASR 摘要芯片卡（免内联 Audio 上下文，点击联动侧边栏跳轴预览）
 */
const AudioChunkChip: React.FC<{
  chunk: {
    startSec: number
    endSec: number
    similarity?: number
    score?: number
    text?: string
  }
  filePath: string
  category?: any
  onPreviewSeek: (startSec: number, endSec: number) => void
  onItemSelect?: (e: React.MouseEvent) => void
}> = ({ chunk, filePath, category, onPreviewSeek, onItemSelect }) => {
  const chunkPercent =
    typeof chunk.similarity === 'number'
      ? Math.round(Math.min(1, Math.max(0, chunk.similarity)) * 100)
      : typeof chunk.score === 'number'
        ? Math.round(Math.min(1, Math.max(0, chunk.score)) * 100)
        : null

  const chipTooltip = `${formatVideoTimestamp(chunk.startSec)} - ${formatVideoTimestamp(chunk.endSec)}${
    chunkPercent !== null ? ` (${t('相似度')}: ${chunkPercent}%)` : ''
  }${chunk.text ? `\nASR: ${chunk.text}` : ''}\n${t('单击跳轴试听，双击外部播放器打开')}`

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    onItemSelect?.(e)
    onPreviewSeek(chunk.startSec, chunk.endSec)
  }

  const handleDoubleClick = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      const rawCat = category
      const cat = typeof rawCat === 'object' && rawCat !== null ? rawCat.label : rawCat
      const outcome = await window.electronAPI?.utils?.launchExternalDeepLink?.({
        filePath,
        category: cat || 'audio',
        seekSeconds: chunk.startSec
      })
      if (outcome?.fallbackToDefault) {
        toast.info(t('未检测到支持精准定位的外部应用，已按默认方式打开'))
      }
    } catch (err: unknown) {
      logger.error(LogCategory.RENDERER, '外部音频深链定位打开失败:', err)
      toast.error(t('打开文件失败'))
    }
  }

  return (
    <div
      className="h-[34px] px-2 py-0.5 rounded border border-border/60 bg-muted/30 hover:border-primary/80 hover:bg-muted/50 transition-all flex items-center gap-1.5 shrink-0 max-w-[260px] cursor-pointer select-none group/audio"
      title={chipTooltip}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
    >
      <MaterialIcon icon="graphic_eq" className="text-xs text-primary shrink-0 group-hover/audio:scale-110 transition-transform" />
      <span className="font-mono text-[10px] text-muted-foreground/90 shrink-0">
        {`${formatVideoTimestamp(chunk.startSec)} - ${formatVideoTimestamp(chunk.endSec)}`}
      </span>
      {chunkPercent !== null && (
        <span className="text-violet-600 dark:text-violet-300 font-semibold text-[9px] shrink-0">
          {`${chunkPercent}%`}
        </span>
      )}
      {chunk.text && (
        <span className="text-[11px] text-foreground/80 truncate">
          {chunk.text}
        </span>
      )}
    </div>
  )
}

interface SearchListCardProps {
  item: FileType
  safeItemName: string
  formatFileSize: (size?: number) => string
  onItemClick: (index: number, e: React.MouseEvent) => void
  onContextMenu: (e: React.MouseEvent, item: FileType) => void
  /** 双击打开：预览或系统默认程序打开（PRD：未分析文件也支持直接打开） */
  onDoubleClick?: () => void
  isSelected?: boolean
  isActive?: boolean
  index: number
  pageId?: PageId
  /** 显式传入搜索关键词（用于单测或外部指定，缺省自动从 search-store 订阅） */
  searchKeyword?: string
  /** 显式传入搜索分词列表（用于单测或外部指定，缺省自动从 search-store 订阅） */
  searchTokens?: string[]
  /** 工作目录绝对路径（用于将缩略图相对路径转换为真实物理路径） */
  workspaceDirectoryPath?: string | null
  /** 卡片动态行高（88~220px，默认 104px） */
  cardHeight?: number
}

/**
 * 搜索列表模式专属卡片（三行式多模态卡片架构，定高 104px）：
 * - 左侧：64×64px 媒体区（图片优先渲染真实缩略图，其他展示系统文件图标）
 * - 右侧第一行：主文件名 + 双层 Flex 右侧度量（国际化自适应召回徽标 + 确定宽度日期/大小列）
 * - 右侧第二行：真实文件名（Hover 浮现绝对物理路径） + 标签序列（溢出自动截断）
 * - 右侧第三行：类型化专有内容（文本高亮摘要 / 图片多模态描述 / 视频微缩抽帧序列 / 音频 ASR 命名芯片）
 */
export const SearchListCard = React.memo(
  ({
    item,
    safeItemName,
    formatFileSize,
    onItemClick,
    onContextMenu,
    onDoubleClick,
    isSelected,
    isActive,
    index,
    pageId,
    searchKeyword: propKeyword,
    searchTokens: propTokens,
    workspaceDirectoryPath,
    cardHeight
  }: SearchListCardProps) => {
    const [isQueueSubmitting, setIsQueueSubmitting] = useState(false)
    const [useFallbackImg, setUseFallbackImg] = useState(false)
    const [imgError, setImgError] = useState(false)

    const storeGlobalKeyword = useSearchStore(s => s.globalSearchKeyword)
    const storeRealKeyword = useSearchStore(s => s.realDirectoryKeyword)
    const storeAnalyzedKeyword = useSearchStore(s => s.analyzedDirectoryKeyword)
    const storeVirtualKeyword = useSearchStore(s => s.virtualDirectoryKeyword)
    const storeTokens = useSearchStore(s => s.searchTokens)

    const effectiveKeyword =
      propKeyword !== undefined
        ? propKeyword
        : (storeGlobalKeyword || storeAnalyzedKeyword || storeVirtualKeyword || storeRealKeyword || '')
    const effectiveTokens =
      propTokens && propTokens.length > 0 ? propTokens : storeTokens

    // 标签微胶囊三级梯队编排与泛化过滤（关键词优先 > 融合标签次之 > 其它标签确定性随机；过滤全年龄/已归档）
    const organizedTags = useMemo<OrganizedTagItem[]>(() => {
      return getOrganizedSearchTags({
        tags: item.tags,
        fusedTags: item.fusedTags,
        searchTokens: effectiveTokens,
        searchKeyword: effectiveKeyword,
        seed: item.path || item.fileFingerprint || item.id || ''
      })
    }, [item.tags, item.fusedTags, effectiveTokens, effectiveKeyword, item.path, item.fileFingerprint, item.id])

    // 虚拟行复用保护：路径变更时重置图片加载错误状态，防状态穿透
    useEffect(() => {
      setUseFallbackImg(false)
      setImgError(false)
    }, [item.path, item.thumbnailPath])

    const isUnanalyzed = Boolean(item.isUnanalyzed || item.matchType === 'unanalyzed')
    const hasMatchedChunks = Boolean(item.matchedChunks && item.matchedChunks.length > 0)

    // 强类型媒体分类判定（对齐 PRD-0058，严禁自然语言硬编码比对；覆盖扩展名与路径全场景）
    const isImage = Boolean(
      (item.extension && isCategory(item.extension, FileCategory.IMAGE)) ||
      (item.path && isCategory(item.path, FileCategory.IMAGE)) ||
      (item.name && isCategory(item.name, FileCategory.IMAGE)) ||
      (safeItemName && isCategory(safeItemName, FileCategory.IMAGE))
    )
    const isVideo = Boolean(
      (item.extension && isCategory(item.extension, FileCategory.VIDEO)) ||
      (item.path && isCategory(item.path, FileCategory.VIDEO)) ||
      (item.name && isCategory(item.name, FileCategory.VIDEO)) ||
      (safeItemName && isCategory(safeItemName, FileCategory.VIDEO))
    )
    const isAudio = Boolean(
      (item.extension && isCategory(item.extension, FileCategory.AUDIO)) ||
      (item.path && isCategory(item.path, FileCategory.AUDIO)) ||
      (item.name && isCategory(item.name, FileCategory.AUDIO)) ||
      (safeItemName && isCategory(safeItemName, FileCategory.AUDIO))
    )

    // Windows 安全 file:/// 协议与双层图片加载（缩略图优先 + 原始图片平滑回退，防幽灵破损图标）
    const { primaryImageUrl, fallbackImageUrl } = useMemo(() => {
      if (!isImage) return { primaryImageUrl: '', fallbackImageUrl: '' }

      const originalUrl = item.path ? toSafeFileUrl(item.path) : ''
      let thumbUrl = ''

      if (item.thumbnailPath) {
        const thumbPath = item.thumbnailPath
        const isAbs =
          /^[a-zA-Z]:[\\/]/.test(thumbPath) ||
          thumbPath.startsWith('/') ||
          thumbPath.startsWith('\\')

        if (isAbs) {
          thumbUrl = toSafeFileUrl(thumbPath)
        } else {
          let wsDir = workspaceDirectoryPath || (item as any).workspaceDirectoryPath || ''
          if (!wsDir && item.path) {
            const virtIdx = item.path.indexOf('.VirtualDirectory')
            if (virtIdx > 0) {
              wsDir = item.path.substring(0, virtIdx).replace(/[\\/]+$/, '')
            }
          }
          if (wsDir) {
            const cleanWs = wsDir.replace(/[\\/]+$/, '')
            const cleanThumb = thumbPath.replace(/^[\\/]+/, '')
            thumbUrl = toSafeFileUrl(`${cleanWs}/${cleanThumb}`)
          }
        }
      }

      return {
        primaryImageUrl: thumbUrl || originalUrl,
        fallbackImageUrl: thumbUrl && originalUrl ? originalUrl : ''
      }
    }, [isImage, item.path, item.thumbnailPath, workspaceDirectoryPath, (item as any).workspaceDirectoryPath])

    const activeImageUrl = !useFallbackImg ? primaryImageUrl : fallbackImageUrl

    const handleImageLoadError = useCallback(() => {
      if (!useFallbackImg && fallbackImageUrl) {
        setUseFallbackImg(true)
      } else {
        setImgError(true)
      }
    }, [useFallbackImg, fallbackImageUrl])

    // 仅基于有效语义召回时才打上标签，其他情况不打标签；
    // 若相似度经计算为 0% 或负值，属于无相关性噪点，不应展示“语义召回 0%”
    const rawPercent =
      typeof item.similarity === 'number'
        ? Math.round(Math.min(1, Math.max(0, item.similarity)) * 100)
        : null

    const hasValidSimilarity = typeof rawPercent === 'number' && rawPercent > 0
    const isSemantic =
      hasValidSimilarity ||
      (item.matchType === 'semantic' && typeof item.similarity !== 'number')

    const semanticLabel = hasValidSimilarity
      ? `${t('语义召回')} ${rawPercent}%`
      : t('语义召回')

    const primaryName = item.smartName || safeItemName
    const secondaryName = item.smartName && item.smartName !== safeItemName ? safeItemName : ''

    /** 抽帧/音频切片跳轴定位 */
    const handlePreviewSeek = useCallback(
      (startSec: number, endSec: number) => {
        // 同步挂载到当前内存 item 实例上，保证 FileExplorerLayout 的响应式监听能读取到最新的切片跳转参数
        ;(item as any).currentTime = startSec
        ;(item as any).highlightRange = [startSec, endSec]

        const splitState = usePreviewOverlayStore.getState()
        const effectivePageId = pageId || splitState.activePageId || PAGE_IDS.REAL_DIRECTORY
        const ext =
          item.extension ||
          getExtFromSmartName(item.smartName || item.name || '') ||
          item.path.split('.').pop() ||
          ''
        splitState.openPreview(
          item.path,
          item.smartName || item.name || '',
          ext,
          effectivePageId,
          {
            currentTime: startSec,
            highlightRange: [startSec, endSec]
          }
        )
      },
      [item, pageId]
    )

    /** “立即分析”：将该文件插队至分析队列并给用户提示 */
    const handleAnalyzeNow = useCallback((e: React.MouseEvent) => {
      e.stopPropagation()
      if (!item.path || isQueueSubmitting) return
      const addFn = window.electronAPI?.addToAnalysisQueue
      if (typeof addFn !== 'function') {
        toast.error(t('加入分析队列失败: {message}', { message: 'IPC unavailable' }))
        return
      }

      setIsQueueSubmitting(true)
      Promise.resolve(
        addFn(
          [
            {
              path: item.path,
              name: item.name || primaryName,
              size: item.size || 0,
              type: item.extension || ''
            }
          ],
          false
        )
      )
        .then(() => {
          toast.success(t('已加入分析队列'))
        })
        .catch((err: unknown) => {
          setIsQueueSubmitting(false)
          logger.error(LogCategory.RENDERER, '加入分析队列失败:', err)
          const message =
            err instanceof Error
              ? err.message.replace(/^Error invoking remote method.*?: Error: /, '')
              : String(err)
          toast.error(t('加入分析队列失败: {message}', { message }))
        })
    }, [item.path, item.name, item.size, item.extension, primaryName, isQueueSubmitting])

    const isRowActive = Boolean(isSelected || isActive)

    /** 切片点击选中守护：若当前卡片尚未被激活才触发 onItemClick，避免触发父级单选 toggle 取消选择 */
    const handleChunkSelect = useCallback(
      (e: React.MouseEvent) => {
        if (!isRowActive) {
          onItemClick(index, e)
        }
      },
      [isRowActive, onItemClick, index]
    )

    // 视频切片合集（兼容多切片 matchedChunks 与单切片 matchedChunk）
    const videoChunks = useMemo(() => {
      if (hasMatchedChunks) return item.matchedChunks!
      if (item.matchedChunk) return [item.matchedChunk]
      return []
    }, [hasMatchedChunks, item.matchedChunks, item.matchedChunk])

    // 音频切片合集（兼容多切片 matchedChunks 与单切片 matchedChunk）
    const audioChunks = useMemo(() => {
      if (hasMatchedChunks) return item.matchedChunks!
      if (item.matchedChunk) return [item.matchedChunk]
      return []
    }, [hasMatchedChunks, item.matchedChunks, item.matchedChunk])

    const effectiveCardHeight = cardHeight && cardHeight >= 80 ? Math.min(220, cardHeight) : 104
    // 左侧缩略图尺寸随行高弹性放大（行高 104 时为 64px，最大 140px）
    const mediaSize = Math.max(56, Math.min(140, Math.round(effectiveCardHeight * 0.65)))
    // 视频抽帧高度：按 16:9 比例等比变大变清晰（基准 38px，最大 80px）
    const chunkFrameHeight = Math.max(34, Math.min(80, Math.round((effectiveCardHeight - 60) * 0.7)))

    // 图片多模态描述内容
    const imageDesc = item.multimodalContent || item.description || ''

    return (
      <div
        className={cn(
          'w-full box-border px-4 py-2 flex items-center gap-3 border-b border-border/30 select-none transition-colors duration-150',
          'search-list-card overflow-hidden',
          isUnanalyzed && 'bg-amber-500/[0.02] dark:bg-amber-950/10',
          isRowActive
            ? 'bg-primary/10 dark:bg-primary/20 border-l-[3px] border-l-primary pl-[13px]'
            : 'hover:bg-accent/40 dark:hover:bg-accent/30'
        )}
        style={{ height: `${effectiveCardHeight}px` }}
        data-index={index}
        data-path={item.path}
        onClick={e => onItemClick(index, e)}
        onDoubleClick={() => onDoubleClick?.()}
        onContextMenu={e => onContextMenu(e, item)}
      >
        {/* ======================================================== */}
        {/* 左侧：64×64px 媒体缩略图 / 系统分类图标区 */}
        {/* ======================================================== */}
        <div
          style={{ width: `${mediaSize}px`, height: `${mediaSize}px` }}
          className="shrink-0 flex items-center justify-center overflow-hidden rounded-md border border-border/40 bg-muted/20"
        >
          {isImage && activeImageUrl && !imgError ? (
            <img
              src={activeImageUrl}
              alt={safeItemName}
              loading="lazy"
              className="w-full h-full object-cover transition-transform duration-200 hover:scale-105"
              onError={handleImageLoadError}
            />
          ) : (
            <SystemFileIcon
              path={item.path}
              extension={item.extension}
              iconSize="normal"
              className="w-8 h-8 object-contain"
              fallback={
                <MaterialIcon
                  icon={isAudio ? 'audio_file' : isVideo ? 'movie' : isImage ? 'image' : 'description'}
                  className="text-2xl text-primary"
                />
              }
            />
          )}
        </div>

        {/* ======================================================== */}
        {/* 右侧：高度定准 87px，严格三行式信息流 */}
        {/* ======================================================== */}
        <div
          style={{ height: `${effectiveCardHeight - 16}px` }}
          className="flex-1 min-w-0 flex flex-col justify-between overflow-hidden"
        >
          {/* ------------------------------------------------------ */}
          {/* 第一行 (Row 1, 22px)：主文件名 + 双层 Flex 绝对右对齐度量列 */}
          {/* ------------------------------------------------------ */}
          <div className="flex items-center justify-between min-w-0 h-[22px]">
            {/* 左侧：智能文件名 / 原文件名 */}
            <div className="flex items-center gap-1.5 min-w-0 flex-1 mr-2">
              <HighlightText
                text={primaryName}
                className="text-[13px] font-semibold text-foreground tracking-tight truncate max-w-full"
                title={primaryName}
              />
              {secondaryName && (
                <span
                  className="text-[11px] text-muted-foreground/70 truncate shrink min-w-0"
                  title={t('原始文件名: {name}', { name: secondaryName })}
                >
                  (<HighlightText text={secondaryName} />)
                </span>
              )}
            </div>

            {/* 右侧：双层 Flex 度量区（国际化自适应召回徽标 + 确定宽度时间与大小列） */}
            <div className="flex items-center gap-2 shrink-0 ml-2">
              {/* 1. 语义召回与展开徽标（随国际化语言长度自适应展开，无多余空隙） */}
              <div className="flex items-center gap-1 shrink-0">
                {item.matchedPinyinCandidate && (
                  <span
                    className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded border text-purple-700 dark:text-purple-300 bg-purple-50 dark:bg-purple-950/70 border-purple-200 dark:border-purple-800 shrink-0 whitespace-nowrap"
                    title={t('拼音展开: {cand}', { cand: item.matchedPinyinCandidate })}
                  >
                    <MaterialIcon icon="translate" className="text-[11px]" />
                    <span className="truncate max-w-[90px]">{item.matchedPinyinCandidate}</span>
                  </span>
                )}
                {isSemantic && (
                  <span
                    className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded border text-violet-700 dark:text-violet-300 bg-violet-50 dark:bg-violet-950/70 border-violet-200 dark:border-violet-800 shrink-0 whitespace-nowrap"
                    title={t('向量语义召回')}
                  >
                    <MaterialIcon icon="psychology" className="text-[11px]" />
                    <span>{semanticLabel}</span>
                  </span>
                )}
              </div>

              {/* 2. 确定宽度度量列 (时间固定 78px 靠左，大小固定 70px 靠右，纵向对齐) */}
              <div className="flex items-center shrink-0 gap-2 font-mono text-[11px]">
                <span
                  className="w-[70px] text-left text-muted-foreground/75 truncate shrink-0"
                  title={item.modifiedAt ? formatDateTimeShort(item.modifiedAt) : undefined}
                >
                  {item.modifiedAt ? formatDateTimeShort(item.modifiedAt) : '-'}
                </span>
                <span className="w-[50px] text-right text-foreground/80 font-medium shrink-0">
                  {formatFileSize(item.size)}
                </span>
              </div>
            </div>
          </div>

          {/* ------------------------------------------------------ */}
          {/* 第二行 (Row 2, 20px)：真实文件名 (Hover 显路径) + 标签序列 */}
          {/* ------------------------------------------------------ */}
          <div className="flex items-center gap-2 min-w-0 h-[20px]">
            <span
              className="text-[11px] font-mono text-muted-foreground/80 max-w-[240px] truncate shrink-0 cursor-default hover:text-foreground transition-colors"
              title={item.path}
            >
              <HighlightText text={safeItemName} />
            </span>

            {/* 标签微胶囊序列（三级梯队排序：关键词命中 > 融合标签 > 其它随机；过滤全年龄/已归档） */}
            {organizedTags.length > 0 && (
              <div
                className="flex items-center gap-1 overflow-hidden shrink min-w-0"
                title={organizedTags.map(t => `#${t.name}`).join(' ')}
              >
                {organizedTags.map((tagItem, tIdx) => (
                  <span
                    key={`${tagItem.name}-${tIdx}`}
                    className={cn(
                      'inline-flex items-center text-[10px] px-1.5 py-0.2 rounded border shrink-0 truncate max-w-[120px]',
                      tagItem.isKeywordMatch
                        ? 'bg-primary/15 text-primary border-primary/35 font-medium'
                        : tagItem.isFused
                          ? 'bg-secondary/80 text-secondary-foreground border-border/50'
                          : 'bg-secondary/45 text-muted-foreground/90 border-border/30'
                    )}
                  >
                    #{tagItem.name}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* ------------------------------------------------------ */}
          {/* 第三行 (Row 3, 42px)：类型化专有内容（文本/图片/视频/音频） */}
          {/* ------------------------------------------------------ */}
          <div className="w-full flex-1 min-h-0 flex items-center min-w-0 overflow-hidden">
            {/* 分支 1: 视频微缩抽帧序列 */}
            {isVideo && videoChunks.length > 0 ? (
              <div className="w-full h-full flex items-center gap-2 overflow-x-auto overflow-y-hidden no-scrollbar py-0.5">
                {videoChunks.map((chunk, cIdx) => (
                  <VideoChunkFrame
                    key={cIdx}
                    chunk={chunk}
                    filePath={item.path}
                    category={(item as any).category}
                    frameHeight={chunkFrameHeight}
                    onPreviewSeek={handlePreviewSeek}
                    onItemSelect={handleChunkSelect}
                  />
                ))}
              </div>
            ) : isAudio && audioChunks.length > 0 ? (
              /* 分支 2: 音频时序 ASR 命名切片芯片序列 */
              <div className="w-full h-full flex items-center gap-2 overflow-x-auto overflow-y-hidden no-scrollbar py-0.5">
                {audioChunks.map((chunk, cIdx) => (
                  <AudioChunkChip
                    key={cIdx}
                    chunk={{
                      ...chunk,
                      text: (chunk as any).text || item.snippet || item.description
                    }}
                    filePath={item.path}
                    category={(item as any).category}
                    onPreviewSeek={handlePreviewSeek}
                    onItemSelect={handleChunkSelect}
                  />
                ))}
              </div>
            ) : isImage && imageDesc ? (
              /* 分支 3: 图片多模态 AI 描述 */
              <div
                className={cn(
                  'text-xs text-foreground/80 overflow-hidden leading-relaxed break-words w-full',
                  effectiveCardHeight > 170 ? 'line-clamp-6' : effectiveCardHeight > 135 ? 'line-clamp-4' : 'line-clamp-2'
                )}
                title={imageDesc}
              >
                <span className="inline-flex items-center gap-1 text-primary font-medium mr-1.5 select-none">
                  <MaterialIcon icon="auto_awesome" className="text-xs text-violet-500" />
                  {t('AI描述')}:
                </span>
                <HighlightText text={imageDesc} />
              </div>
            ) : isUnanalyzed ? (
              /* 分支 4: 未分析状态提示与立即分析按钮 */
              <div className="flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400 min-w-0 truncate">
                <span className="truncate">{t('尚未进行 AI 深度分析，命中文件名')}</span>
                <button
                  type="button"
                  disabled={isQueueSubmitting}
                  className="shrink-0 inline-flex items-center gap-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300 hover:underline cursor-pointer disabled:opacity-50"
                  onClick={handleAnalyzeNow}
                >
                  <MaterialIcon icon="bolt" className="text-xs" />
                  <span>{isQueueSubmitting ? t('已提交') : t('立即分析')}</span>
                </button>
              </div>
            ) : item.snippet ? (
              /* 分支 5: 文本富高亮摘要 */
              <p
                className={cn(
                  'text-xs text-foreground/80 leading-snug [&_mark]:bg-amber-300/60 [&_mark]:dark:bg-amber-400/30 [&_mark]:text-amber-950 [&_mark]:dark:text-amber-100 [&_mark]:font-semibold [&_mark]:rounded-sm [&_mark]:px-0.5 overflow-hidden',
                  effectiveCardHeight > 170 ? 'line-clamp-6' : effectiveCardHeight > 135 ? 'line-clamp-4' : 'line-clamp-2'
                )}
                title={item.snippet.replace(/<[^>]+>/g, '')}
                dangerouslySetInnerHTML={{ __html: sanitizeSnippetHtml(item.snippet) }}
              />
            ) : item.description ? (
              /* 分支 6: 普通文件描述 */
              <p
                className={cn(
                  'text-xs text-foreground/75 leading-snug overflow-hidden',
                  effectiveCardHeight > 170 ? 'line-clamp-6' : effectiveCardHeight > 135 ? 'line-clamp-4' : 'line-clamp-2'
                )}
                title={item.description}
              >
                <HighlightText text={item.description} />
              </p>
            ) : (
              /* 分支 7: 兜底路径/格式提示 */
              <span className="text-[11px] text-muted-foreground/60 italic">
                {t('无额外上下文信息')}
              </span>
            )}
          </div>
        </div>
      </div>
    )
  }
)

SearchListCard.displayName = 'SearchListCard'
