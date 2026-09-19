import React from 'react'
import { formatDateTimeShort } from '@firefly/shared'
import { cn } from '../../../../lib/utils'
import { t } from '@app/languages'
import { toast } from '../../../common/Toast'
import { SystemFileIcon } from '../../../common/SystemFileIcon'
import { FileType } from '../types'

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

/** 匹配类型徽章的样式与文案配置 */
const MATCH_BADGE_CONFIG: Record<
  string,
  { label: string; className: string; icon: string }
> = {
  exact: {
    label: '字面匹配',
    className: 'text-emerald-600 dark:text-emerald-400 bg-emerald-100 dark:bg-emerald-950/80 border-emerald-300 dark:border-emerald-800',
    icon: 'text_match'
  },
  fuzzy: {
    label: '模糊匹配',
    className: 'text-sky-600 dark:text-sky-400 bg-sky-100 dark:bg-sky-950/80 border-sky-300 dark:border-sky-800',
    icon: 'manage_search'
  },
  semantic: {
    label: '语义召回',
    className: 'text-violet-600 dark:text-violet-400 bg-violet-100 dark:bg-violet-950/80 border-violet-300 dark:border-violet-800',
    icon: 'psychology'
  },
  unanalyzed: {
    label: '未分析',
    className: 'text-amber-600 dark:text-amber-400 bg-amber-100 dark:bg-amber-950/80 border-amber-300 dark:border-amber-800',
    icon: 'help_outline'
  }
}

interface SearchListCardProps {
  item: FileType
  safeItemName: string
  formatFileSize: (size?: number) => string
  onItemClick: (index: number, e: React.MouseEvent) => void
  onContextMenu: (e: React.MouseEvent, item: any) => void
  isSelected?: boolean
  isActive?: boolean
  index: number
}

/**
 * 搜索列表模式专属卡片：
 * - 元数据行：文件图标、智能名/文件名、匹配类型徽章、修改时间、大小
 * - 路径提示：物理路径
 * - 富正文摘要：已分析文件呈现 <mark> 高亮片段（XSS 安全转义），未分析文件提供“立即分析”插队按钮
 */
export const SearchListCard = React.memo(
  ({
    item,
    safeItemName,
    formatFileSize,
    onItemClick,
    onContextMenu,
    isSelected,
    isActive,
    index
  }: SearchListCardProps) => {
    const isUnanalyzed = Boolean(item.isUnanalyzed || item.matchType === 'unanalyzed')
    const matchType = item.matchType || (isUnanalyzed ? 'unanalyzed' : 'exact')
    const badge = MATCH_BADGE_CONFIG[matchType] || MATCH_BADGE_CONFIG.exact

    // 语义召回徽章附加相似度百分比（0~1 → 0~100）
    const badgeLabel =
      matchType === 'semantic' && typeof item.similarity === 'number'
        ? `${t(badge.label)} ${Math.round(Math.min(1, Math.max(0, item.similarity)) * 100)}%`
        : t(badge.label)

    const primaryName = item.smartName || safeItemName
    const secondaryName = item.smartName && item.smartName !== safeItemName ? safeItemName : ''

    /** “立即分析”：将该文件插队至分析队列并给用户提示 */
    const handleAnalyzeNow = (e: React.MouseEvent) => {
      e.stopPropagation()
      if (!item.path) return
      window.electronAPI
        ?.addToAnalysisQueue?.(
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
        .then(() => {
          toast.success(t('已加入分析队列'))
        })
        .catch((error: Error) => {
          const message =
            error?.message?.replace(/^Error invoking remote method.*?: Error: /, '') ||
            String(error)
          toast.error(t('加入分析队列失败: {message}', { message }))
        })
    }

    return (
      <div
        className={cn(
          'w-full h-full px-4 py-2 flex flex-col justify-center gap-1 border-b border-border/30 select-none search-list-card',
          isUnanalyzed && 'bg-amber-500/5 dark:bg-amber-950/10',
          isSelected || isActive
            ? 'bg-primary/20 dark:bg-primary/30'
            : 'hover:bg-secondary/60'
        )}
        data-index={index}
        onClick={e => onItemClick(index, e)}
        onContextMenu={e => onContextMenu(e, item)}
      >
        {/* 元数据行：图标 + 名称 + 匹配徽章 + 时间/大小 */}
        <div className="flex items-center gap-2 min-w-0">
          <SystemFileIcon
            path={item.path}
            extension={item.extension}
            className="w-5 h-5 object-contain flex-shrink-0"
            fallback={
              <span className="material-icons text-xl flex-shrink-0 text-primary">description</span>
            }
          />
          <span className="font-medium truncate text-primary" title={primaryName}>
            {primaryName}
          </span>
          {secondaryName && (
            <span className="text-xs text-gray-400 truncate flex-shrink" title={secondaryName}>
              {secondaryName}
            </span>
          )}
          <span
            className={cn(
              'inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded border shrink-0',
              badge.className
            )}
          >
            <span className="material-icons text-[12px]">{badge.icon}</span>
            {badgeLabel}
          </span>
          <span className="ml-auto flex items-center gap-2 text-xs text-foreground/60 shrink-0">
            <span>{item.modifiedAt ? formatDateTimeShort(item.modifiedAt) : '-'}</span>
            <span className="w-16 text-right">{formatFileSize(item.size)}</span>
          </span>
        </div>

        {/* 路径提示：物理路径 */}
        {item.path && (
          <div
            className="text-xs text-muted-foreground truncate"
            title={item.path}
          >
            {item.path}
          </div>
        )}

        {/* 富正文摘要区 */}
        <div className="min-w-0 flex items-start gap-2">
          {isUnanalyzed ? (
            <>
              <span className="text-xs text-amber-600 dark:text-amber-400 truncate">
                {t('尚未进行 AI 深度分析，命中文件名')}
              </span>
              <button
                type="button"
                className="ml-auto shrink-0 inline-flex items-center gap-1 text-xs font-medium text-primary hover:text-primary/80 border border-primary/40 hover:border-primary/60 rounded px-2 py-0.5 transition-colors"
                onClick={handleAnalyzeNow}
              >
                <span className="material-icons text-[14px]">bolt</span>
                {t('立即分析')}
              </button>
            </>
          ) : item.snippet ? (
            // snippet 已通过 sanitizeSnippetHtml 转义，仅保留受信任的 <mark> 标签
            <p
              className="text-xs text-foreground/70 leading-5 line-clamp-2 [&_mark]:bg-yellow-300/70 [&_mark]:dark:bg-yellow-500/40 [&_mark]:text-inherit [&_mark]:rounded-sm [&_mark]:px-0.5"
              dangerouslySetInnerHTML={{ __html: sanitizeSnippetHtml(item.snippet) }}
            />
          ) : null}
        </div>
      </div>
    )
  }
)

SearchListCard.displayName = 'SearchListCard'
