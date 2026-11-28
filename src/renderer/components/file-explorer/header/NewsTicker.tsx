import React, { useEffect, useRef, useState } from 'react'
import { MaterialIcon, cn } from '../../../lib/utils'
import { LatestNewsItem } from '@firefly/types/config-types'
import { openExternalLink } from '../../../lib/external-link'
import { t } from '@app/languages'
import { subscribeSharedTicker } from './header-clock'

/** 新闻等级 → 配色（自 DirectoryHeader 迁入，J-03 叶节点自治） */
const getLevelStyles = (level?: string) => {
  switch (level) {
    case 'error':
      return {
        bg: 'bg-red-500/10 hover:bg-red-500/20',
        dot: 'bg-red-500',
        text: 'text-red-500',
        ring: 'ring-red-500/30'
      }
    case 'warn':
      return {
        bg: 'bg-amber-500/10 hover:bg-amber-500/20',
        dot: 'bg-amber-500',
        text: 'text-amber-500',
        ring: 'ring-amber-500/30'
      }
    case 'info':
      return {
        bg: 'bg-primary/10 hover:bg-primary/20',
        dot: 'bg-primary',
        text: 'text-primary',
        ring: 'ring-primary/30'
      }
    default:
      return {
        bg: 'bg-primary/10 hover:bg-primary/20',
        dot: 'bg-primary',
        text: 'text-primary',
        ring: 'ring-primary/30'
      }
  }
}

interface NewsTickerProps {
  latestNews: LatestNewsItem[]
  /** 受控下拉开合：父级持有镜像（拖拽区判定 + 全屏拦截层可统一关闭），tick 轮播仍内聚叶节点 */
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * 新闻轮播叶节点（J-03）：轮播索引 / click-outside 内聚，下拉开合受控于父级，
 * 5000ms tick 只重渲染本微节点，不再带动 1400+ 行 DirectoryHeader 重渲染。
 * 定时器来自模块级共享 Ticker（多 KeepAlive 实例共用、卸载归零即停）；
 * KeepAlive 隐藏（.opacity-0 祖先）时跳过 tick，0 无效唤醒。
 * JSX 与迁移前 DirectoryHeader 内联块逐字等价（含无新闻兜底文案）。
 */
const NewsTicker: React.FC<NewsTickerProps> = ({ latestNews, open, onOpenChange }) => {
  const [currentNewsIndex, setCurrentNewsIndex] = useState(0)
  const newsDropdownRef = useRef<HTMLDivElement | null>(null)

  // 共享 5000ms Ticker：与原逻辑一致，仅多于 1 条新闻时轮播；隐藏视图跳过 setState
  useEffect(() => {
    if (latestNews.length <= 1) return
    return subscribeSharedTicker(5000, () => {
      if (newsDropdownRef.current?.closest('.opacity-0')) return
      setCurrentNewsIndex(prev => (prev + 1) % latestNews.length)
    })
  }, [latestNews.length])

  // 点击外部关闭新闻下拉（自 DirectoryHeader 全局 click-outside 迁入）
  useEffect(() => {
    if (!open) return
    const handleClickOutside = (event: PointerEvent) => {
      if (newsDropdownRef.current && !newsDropdownRef.current.contains(event.target as Node)) {
        onOpenChange(false)
      }
    }
    document.addEventListener('pointerdown', handleClickOutside)
    return () => document.removeEventListener('pointerdown', handleClickOutside)
  }, [open, onOpenChange])

  const handleNewsClick = (url: string | undefined) => {
    if (url) {
      openExternalLink(url, { errorTitle: t('无法打开链接') })
      onOpenChange(false)
    }
  }

  return (
    <div
      className="relative flex items-center text-xs text-primary transition-all duration-500 min-w-0 flex-1 justify-start"
      ref={newsDropdownRef}
      onPointerDown={e => e.stopPropagation()}
    >
      {latestNews.length > 0 ? (
        <>
          <div
            className={cn(
              'flex items-center gap-1.5 px-1 py-1 rounded-md animate-in fade-in duration-500 cursor-pointer max-w-full min-w-0 hover:opacity-85 transition-opacity',
              getLevelStyles(latestNews[currentNewsIndex]?.level).text
            )}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            onClick={() => onOpenChange(!open)}
          >
            <span
              className={cn(
                'flex h-1.5 w-1.5 rounded-full animate-pulse flex-shrink-0',
                getLevelStyles(latestNews[currentNewsIndex]?.level).dot
              )}
            />
            <span
              className="truncate font-medium min-w-0 text-left"
              title={latestNews[currentNewsIndex]?.text}
            >
              {latestNews[currentNewsIndex]?.text}
            </span>
            <MaterialIcon
              icon={open ? 'arrow_drop_up' : 'arrow_drop_down'}
              className="text-base opacity-70 flex-shrink-0"
            />
          </div>

          {open && (
            <div
              className="absolute top-full left-0 mt-2 bg-popover border border-border rounded-md shadow-xl z-[120] py-1 min-w-[280px] max-w-[420px]"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            >
              <div className="px-3 py-1.5 text-[10px] font-semibold text-muted-foreground border-b border-border mb-1 uppercase tracking-wider">
                {t('最新动态')}
              </div>
              <div className="max-h-60 overflow-y-auto">
                {latestNews.map((news, index) => {
                  const styles = getLevelStyles(news.level)
                  return (
                    <button
                      key={index}
                      className={cn(
                        'w-full flex items-start gap-3 px-3 py-2.5 text-left transition-colors group whitespace-nowrap',
                        news.url
                          ? 'cursor-pointer hover:bg-accent hover:text-accent-foreground'
                          : 'cursor-default',
                        'border-b border-border/50 last:border-none'
                      )}
                      onClick={() => handleNewsClick(news.url)}
                    >
                      <span
                        className={cn(
                          'flex h-1.5 w-1.5 rounded-full mt-1.5 flex-shrink-0',
                          news.level
                            ? styles.dot
                            : index === currentNewsIndex
                              ? 'bg-primary animate-pulse'
                              : 'bg-muted-foreground/40'
                        )}
                      />
                      <div className="min-w-0">
                        <div className={cn('text-xs font-medium', news.level && styles.text)}>
                          {news.text}
                        </div>
                        {news.url && (
                          <div className="text-[10px] text-muted-foreground truncate opacity-60 transition-colors duration-200 group-hover:text-accent-foreground/70">
                            {news.url}
                          </div>
                        )}
                      </div>
                      {news.url && (
                        <MaterialIcon
                          icon="open_in_new"
                          className="text-sm text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity self-center"
                        />
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </>
      ) : (
        <span className="truncate px-2">{t('AI 摘要功能已上线!')}</span>
      )}
    </div>
  )
}

export default React.memo(NewsTicker)
