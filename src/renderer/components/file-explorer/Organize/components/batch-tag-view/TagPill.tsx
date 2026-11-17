import React from 'react'
import { t } from '@app/languages'
import { MaterialIcon, cn } from '../../../../../lib/utils'
import type { TagPillProps } from './types'

/**
 * 单个标签胶囊组件 (React.memo)
 * 仅在其自身状态或聚焦拥有状态变化时重绘，杜绝点击文件时全量 1000+ 标签无效重绘与动画卡顿
 */

export const TagPill: React.FC<TagPillProps> = React.memo(
  ({
    dimId,
    tagName,
    tagKey,
    count,
    totalFilesCount,
    state,
    isOwnedByInspected,
    isPan,
    onToggle,
    onDelete
  }) => {
    const ratio = totalFilesCount > 0 ? count / totalFilesCount : 0

    // 状态与覆盖率
    const isAllAttached = state === 'add_all'
    const isAllRemoved = state === 'remove_all'
    const isFullyOwned = ratio >= 1 && state === 'initial'
    const isPartial = ratio > 0 && ratio < 1 && state === 'initial'

    return (
      <div className="group relative inline-flex">
        <div
          onClick={() => onToggle(tagKey)}
          className={cn(
            'relative overflow-hidden inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-medium cursor-pointer',
            'border select-none shadow-2xs transition-colors duration-150',
            // 状态与拥有高亮
            isAllAttached
              ? 'border-emerald-600 bg-emerald-600 text-white font-semibold shadow-xs'
              : isAllRemoved
                ? 'border-destructive/60 bg-destructive/15 text-destructive line-through opacity-85'
                : isOwnedByInspected
                  ? 'border-primary bg-primary/20 text-primary font-bold shadow-xs ring-1.5 ring-primary/60 z-10'
                  : isFullyOwned
                    ? 'border-primary bg-primary text-primary-foreground font-semibold shadow-xs'
                    : isPartial
                      ? 'border-primary/40 text-foreground hover:border-primary/70'
                      : 'border-border/60 bg-card hover:border-border text-foreground/80'
          )}
          style={
            isPartial && !isOwnedByInspected
              ? {
                  backgroundColor: `rgba(var(--primary-rgb, 59, 130, 246), ${0.08 + ratio * 0.25})`
                }
              : undefined
          }
        >
          {/* 部分拥有时的背景进度条 (覆盖率比值) */}
          {isPartial && !isOwnedByInspected && (
            <div
              className="absolute inset-y-0 left-0 bg-primary/20 pointer-events-none rounded-xl"
              style={{ width: `${Math.round(ratio * 100)}%` }}
            />
          )}

          {/* 三态状态前置小图标 */}
          {isAllAttached && (
            <MaterialIcon icon="add_circle" className="text-xs text-white shrink-0 relative z-10" />
          )}
          {isAllRemoved && (
            <MaterialIcon
              icon="do_not_disturb_on"
              className="text-xs text-destructive shrink-0 relative z-10"
            />
          )}
          {isOwnedByInspected && !isAllAttached && !isAllRemoved && (
            <MaterialIcon
              icon="check_circle"
              className="text-xs text-primary shrink-0 relative z-10"
            />
          )}

          {/* 标签名称 */}
          <span className="relative z-10">{tagName}</span>

          {/* 数量统计徽章（仅显示当前匹配文件计数，不显示总数） */}
          <span
            className={cn(
              'relative z-10 text-[10px] tabular-nums font-mono px-1 rounded',
              isAllAttached
                ? 'bg-black/20 text-white'
                : isAllRemoved
                  ? 'bg-destructive/20 text-destructive'
                  : isOwnedByInspected
                    ? 'bg-primary/25 text-primary font-bold'
                    : isFullyOwned
                      ? 'bg-black/20 text-white'
                      : 'bg-background/80 text-muted-foreground border border-border/40'
            )}
            title={t('{count} 个文件', {
              count: isAllAttached ? totalFilesCount : isAllRemoved ? 0 : count
            })}
          >
            {isAllAttached ? totalFilesCount : isAllRemoved ? 0 : count}
          </span>
        </div>

        {/* 仅泛维度的标签在 hover 时浮动到右上角（一半在胶囊外），不占用胶囊内部空间 */}
        {isPan && onDelete && (
          <button
            type="button"
            title={t('移除该标签')}
            onClick={e => onDelete(dimId, tagName, e)}
            className={cn(
              'absolute -top-1.5 -right-1.5 z-20 w-5 h-5 rounded-full',
              'bg-destructive text-destructive-foreground shadow-xs border border-background',
              'opacity-0 scale-75 group-hover:opacity-100 group-hover:scale-100 transition-all duration-150',
              'flex items-center justify-center cursor-pointer hover:bg-destructive/90 hover:scale-110'
            )}
          >
            <MaterialIcon icon="close" className="text-[10px]" />
          </button>
        )}
      </div>
    )
  }
)

TagPill.displayName = 'TagPill'
