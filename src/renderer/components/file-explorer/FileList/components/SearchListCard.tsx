import React, { useState, useCallback, useMemo } from 'react'
import { formatDateTimeShort, logger, LogCategory } from '@firefly/shared'
import { MaterialIcon, cn } from '../../../../lib/utils'
import { t } from '@app/languages'
import { toast } from '../../../common/Toast'
import { SystemFileIcon } from '../../../common/SystemFileIcon'
import { HighlightText } from '../../../common/HighlightText'
import { FileType } from '../types'
import { formatVideoTimestamp, clampVideoTime } from '../../../../lib/video-preview-utils'
import { getExtFromSmartName } from '../../../../lib/preview-utils'
import { usePreviewOverlayStore } from '../../../../stores/preview-overlay-store'
import { PageId } from '../../../../constants/page-ids'

/**
 * 搜索列表模式专用行高（卡片式排版，较普通列表行更高）
 */
export const SEARCH_LIST_ROW_HEIGHT = 96

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
 * 视频切片微型帧卡片（标准 16:9 画幅，Hover 提示起止时间，点击跳轴预览，双击外部定位播放）
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
  onPreviewSeek: (startSec: number, endSec: number) => void
}> = ({ chunk, filePath, category, onPreviewSeek }) => {
  const [hasError, setHasError] = useState(false)

  const videoUrl = useMemo(() => {
    if (!filePath) return ''
    const norm = filePath.replace(/\\/g, '/')
    const clean = norm.startsWith('/') ? norm : `/${norm}`
    return `file://${clean}#t=${clampVideoTime(chunk.startSec, 3600)}`
  }, [filePath, chunk.startSec])

  const chunkPercent =
    typeof chunk.similarity === 'number'
      ? Math.round(Math.min(1, Math.max(0, chunk.similarity)) * 100)
      : typeof chunk.score === 'number'
        ? Math.round(Math.min(1, Math.max(0, chunk.score)) * 100)
        : null

  // 悬浮到单帧上显示精准时间与相似度信息
  const frameTooltip = `${formatVideoTimestamp(chunk.startSec)} - ${formatVideoTimestamp(chunk.endSec)}${
    chunkPercent !== null ? ` (${t('相似度')}: ${chunkPercent}%)` : ''
  }\n${t('单击跳轴预览，双击外部播放器打开')}`

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    onPreviewSeek(chunk.startSec, chunk.endSec)
  }

  const handleDoubleClick = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      const rawCat = category
      const cat = typeof rawCat === 'object' && rawCat !== null ? rawCat.label : rawCat
      const outcome = await window.electronAPI!.utils.launchExternalDeepLink({
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

  return (
    <div
      className="relative shrink-0 overflow-hidden bg-black/60 rounded-md border border-border/60 hover:border-primary/90 hover:ring-1 hover:ring-primary/80 transition-all cursor-pointer group/chunk select-none h-[76px] w-[135px]"
      title={frameTooltip}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
    >
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
        <div className="w-full h-full flex items-center justify-center bg-muted/40 text-muted-foreground/60">
          <MaterialIcon icon="movie" className="text-xl" />
        </div>
      )}

      {/* Hover 遮罩与跳轴小播放图标 */}
      <div className="absolute inset-0 bg-black/25 opacity-0 group-hover/chunk:opacity-100 flex items-center justify-center transition-opacity">
        <MaterialIcon icon="play_arrow" className="text-white drop-shadow text-xl" />
      </div>

      {/* 底部时间胶囊 */}
      <div className="absolute bottom-1 left-1 rounded bg-black/80 font-mono text-white/90 backdrop-blur-xs flex items-center gap-1 px-1.5 py-0.5 text-[10px] shadow-xs border border-white/10 pointer-events-none">
        <MaterialIcon icon="schedule" className="text-[10px] text-blue-400" />
        <span>{`${formatVideoTimestamp(chunk.startSec)} - ${formatVideoTimestamp(chunk.endSec)}`}</span>
        {chunkPercent !== null && (
          <span className="text-violet-300 ml-0.5 font-semibold text-[9px]">{`${chunkPercent}%`}</span>
        )}
      </div>
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
}

/**
 * 搜索列表模式专属卡片：
 * - 抽帧预览模式 (Frame Preview Grid)：当命中视频多时序切片时，完全切换为 Grid 抽帧预览模式，
 *   高度严格锁死 SEARCH_LIST_ROW_HEIGHT (96px)，整行 hover 显示文件详细信息，单帧 hover 显示时间与相似度；
 * - 普通图文行模式：文件图标 + 文件名/路径/正文描述 + 召回 label/时间/大小。
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
    pageId
  }: SearchListCardProps) => {
    const [isQueueSubmitting, setIsQueueSubmitting] = useState(false)
    const isUnanalyzed = Boolean(item.isUnanalyzed || item.matchType === 'unanalyzed')
    const hasMatchedChunks = Boolean(item.matchedChunks && item.matchedChunks.length > 0)

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

    /** 抽帧预览跳轴定位 */
    const handlePreviewSeek = useCallback(
      (startSec: number, endSec: number) => {
        const splitState = usePreviewOverlayStore.getState()
        const pageMode = pageId ? (splitState.pageStates[pageId]?.mode ?? 'split') : undefined
        if (pageMode === 'split') {
          const ext =
            item.extension ||
            getExtFromSmartName(item.smartName || item.name || '') ||
            item.path.split('.').pop() ||
            ''
          splitState.openPreview(
            item.path,
            item.smartName || item.name || '',
            ext,
            pageId,
            {
              currentTime: startSec,
              highlightRange: [startSec, endSec]
            }
          )
        }
      },
      [item.path, item.name, item.smartName, item.extension, pageId]
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

    if (hasMatchedChunks) {
      const rowTooltip = [
        `${t('文件名')}: ${primaryName}${secondaryName ? ` (${secondaryName})` : ''}`,
        item.path ? `${t('完整路径')}: ${item.path}` : null,
        item.size ? `${t('文件大小')}: ${formatFileSize(item.size)}` : null,
        item.modifiedAt ? `${t('修改时间')}: ${formatDateTimeShort(item.modifiedAt)}` : null,
        hasValidSimilarity ? `${t('整体匹配度')}: ${rawPercent}%` : null,
        (item as any).totalChunkRows && (item as any).totalChunkRows > 1
          ? `${t('时序片段 (第 {current}/{total} 行)', { current: ((item as any).chunkRowIndex ?? 0) + 1, total: (item as any).totalChunkRows })}`
          : `${t('命中时序片段数')}: ${item.matchedChunks!.length}`
      ]
        .filter(Boolean)
        .join('\n')

      const isFirstOfMulti = (item as any).chunkRowIndex === 0 && ((item as any).totalChunkRows ?? 1) > 1
      const isLastOfMulti =
        (item as any).chunkRowIndex !== undefined &&
        (item as any).chunkRowIndex === ((item as any).totalChunkRows ?? 1) - 1 &&
        ((item as any).totalChunkRows ?? 1) > 1

      return (
        <div
          className={cn(
            'w-full h-full px-4 py-2 flex items-center border-border/30 select-none transition-colors duration-150',
            'search-list-card overflow-hidden',
            // 若为同一文件的多行拆分，中间无缝拼接为一体大卡片
            isFirstOfMulti
              ? 'border-b-transparent'
              : isLastOfMulti
                ? 'border-t-transparent border-b'
                : 'border-b',
            isRowActive
              ? 'bg-primary/10 dark:bg-primary/20 border-l-[3px] border-l-primary pl-[13px]'
              : 'hover:bg-accent/40 dark:hover:bg-accent/30'
          )}
          data-index={index}
          data-path={item.path}
          title={rowTooltip}
          onClick={e => onItemClick(index, e)}
          onDoubleClick={() => onDoubleClick?.()}
          onContextMenu={e => onContextMenu(e, item)}
        >
          {/* 全宽抽帧预览 Grid：无左侧图标，无右侧信息条，全部宽度纯粹留给抽帧预览 */}
          <div className="w-full h-full flex items-center gap-3 overflow-x-auto no-scrollbar py-0.5">
            {item.matchedChunks!.map((chunk, cIdx) => (
              <VideoChunkFrame
                key={cIdx}
                chunk={chunk}
                filePath={item.path}
                category={(item as any).category}
                onPreviewSeek={handlePreviewSeek}
              />
            ))}
          </div>
        </div>
      )
    }

    // ==========================================
    // 普通图文行模式 (默认)
    // ==========================================
    return (
      <div
        className={cn(
          'w-full h-full px-4 py-2 flex items-start gap-3 border-b border-border/30 select-none transition-colors duration-150',
          'search-list-card overflow-hidden',
          isUnanalyzed && 'bg-amber-500/[0.02] dark:bg-amber-950/10',
          isRowActive
            ? 'bg-primary/10 dark:bg-primary/20 border-l-[3px] border-l-primary pl-[13px]'
            : 'hover:bg-accent/40 dark:hover:bg-accent/30'
        )}
        data-index={index}
        data-path={item.path}
        onClick={e => onItemClick(index, e)}
        onDoubleClick={() => onDoubleClick?.()}
        onContextMenu={e => onContextMenu(e, item)}
      >
        {/* 左侧：文件图标 */}
        <div className="shrink-0 flex items-center justify-center pt-1">
          <SystemFileIcon
            path={item.path}
            extension={item.extension}
            className="w-7 h-7 object-contain flex-shrink-0"
            fallback={
              <MaterialIcon icon="description" className="text-2xl flex-shrink-0 text-primary" />
            }
          />
        </div>

        {/* 中间：智能文件名、真实路径、描述与切片（自适应宽度，溢出截断） */}
        <div className="flex-1 min-w-0 flex flex-col justify-center gap-1 overflow-hidden">
          {/* 1. 文件名 */}
          <div className="flex items-center gap-1.5 min-w-0">
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

          {/* 2. 文件真实路径 */}
          {item.path && (
            <div
              className="text-[11px] font-mono text-muted-foreground/75 truncate"
              title={item.path}
            >
              <HighlightText text={item.path} title={item.path} />
            </div>
          )}

          {/* 3. 文件描述 / 正文切片 / 未分析提示（非废话，有内容才显示） */}
          {isUnanalyzed ? (
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
            <p
              className="text-xs text-foreground/80 leading-relaxed line-clamp-2 [&_mark]:bg-amber-300/60 [&_mark]:dark:bg-amber-400/30 [&_mark]:text-amber-950 [&_mark]:dark:text-amber-100 [&_mark]:font-semibold [&_mark]:rounded-sm [&_mark]:px-0.5 overflow-hidden"
              dangerouslySetInnerHTML={{ __html: sanitizeSnippetHtml(item.snippet) }}
            />
          ) : item.description ? (
            <p className="text-xs text-foreground/75 leading-relaxed line-clamp-2 truncate">
              <HighlightText text={item.description} />
            </p>
          ) : null}
        </div>

        {/* 右侧：召回 label（仅语义召回展示）、修改时间和文件大小 */}
        <div className="shrink-0 flex flex-col items-end justify-between self-stretch text-xs pl-2 text-right">
          {/* 召回 label：拼音展开、语义召回或视频匹配 */}
          <div className="flex items-center gap-1 justify-end min-h-[20px]">
            {item.matchedPinyinCandidate && (
              <span
                className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded border text-purple-700 dark:text-purple-300 bg-purple-50 dark:bg-purple-950/70 border-purple-200 dark:border-purple-800 shrink-0"
                title={t('拼音展开: {cand}', { cand: item.matchedPinyinCandidate })}
              >
                <MaterialIcon icon="translate" className="text-[11px]" />
                <span>{item.matchedPinyinCandidate}</span>
              </span>
            )}
            {isSemantic && (
              <span
                className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded border text-violet-700 dark:text-violet-300 bg-violet-50 dark:bg-violet-950/70 border-violet-200 dark:border-violet-800 shrink-0"
                title={t('向量语义召回')}
              >
                <MaterialIcon icon="psychology" className="text-[11px]" />
                <span>{semanticLabel}</span>
              </span>
            )}
            {item.matchedChunk && (
              <span
                className="inline-flex items-center gap-1 text-[10px] font-mono font-medium px-1.5 py-0.5 rounded border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 shrink-0 cursor-pointer hover:bg-blue-100 dark:hover:bg-blue-900/80 transition-colors"
                title={t('在外部应用中精准定位打开')}
                onClick={async (e) => {
                  e.stopPropagation()
                  try {
                    const rawCat = (item as any).category
                    const cat = typeof rawCat === 'object' && rawCat !== null ? rawCat.label : rawCat
                    const outcome = await window.electronAPI!.utils.launchExternalDeepLink({
                      filePath: item.path,
                      category: cat || '',
                      seekSeconds: item.matchedChunk!.startSec
                    })
                    if (outcome.fallbackToDefault) {
                      toast.info(t('未检测到支持精准定位的外部应用，已按默认方式打开'))
                    }
                  } catch (error: any) {
                    logger.error(LogCategory.RENDERER, '外部深链定位打开失败:', error)
                    toast.error(t('打开文件失败'))
                  }
                }}
              >
                <MaterialIcon icon="schedule" className="text-[11px]" />
                <span>{`${formatVideoTimestamp(item.matchedChunk.startSec)} - ${formatVideoTimestamp(item.matchedChunk.endSec)}`}</span>
              </span>
            )}
          </div>

          {/* 修改时间与文件大小 */}
          <div className="flex flex-col items-end gap-0.5 text-muted-foreground/75 mt-auto">
            <span className="text-[11px]">
              {item.modifiedAt ? formatDateTimeShort(item.modifiedAt) : '-'}
            </span>
            <span className="text-[11px] font-mono font-medium">
              {formatFileSize(item.size)}
            </span>
          </div>
        </div>
      </div>
    )
  }
)

SearchListCard.displayName = 'SearchListCard'
