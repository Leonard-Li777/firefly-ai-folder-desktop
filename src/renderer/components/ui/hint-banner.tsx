import React from 'react'
import { X } from 'lucide-react'
import { cn } from '../../lib/utils'
import { t } from '@app/languages'

/**
 * 共享提示横幅（通栏提示条）
 *
 * 统一结构（全系统横幅约定）：
 *   [图标] [文案（过长单行截断）] [操作按钮组（紧跟文案、永不换行）] [右端 X]
 *
 * 为什么收在一个组件里：横幅是随手就会新增的 UI，先前四处横幅各自写了一遍
 * flex 结构与按钮对齐，结果出现「按钮被文案挤到第二行」「关闭按钮跑到文案右边」
 * 这类只有靠肉眼才发现的不一致。结构收敛到一处后，新增横幅只需要传文案与动作。
 *
 * 约定：
 * - 操作按钮放 `actions`，永远是文案之后的左对齐组，并强制 `whitespace-nowrap`；
 * - 关闭语义放 `onClose`，X 始终独占右端（`ml-auto`），文案长短不影响它的位置；
 * - 文案被截断时靠 `title` 悬浮看全文，调用方应把全量文案同样传进来。
 */
export interface HintBannerProps {
  /** 左侧图标节点（lucide 图标或 MaterialIcon 均可，尺寸/动画由调用方决定） */
  icon?: React.ReactNode
  /** 提示文案 */
  children: React.ReactNode
  /** 文案被截断时的悬浮全量文案 */
  title?: string
  /** 文案补充样式（字重、字号等） */
  textClassName?: string
  /** 文案之后的操作按钮组 */
  actions?: React.ReactNode
  /** 传了才渲染右端 X（透传点击事件，便于调用方 stopPropagation） */
  onClose?: React.MouseEventHandler<HTMLButtonElement>
  /** X 的悬浮/无障碍文案 */
  closeTitle?: string
  /** 外框补充样式（底色深浅、边框方向、内边距等，经 twMerge 覆盖默认值） */
  className?: string
  style?: React.CSSProperties
}

export function HintBanner({
  icon,
  children,
  title,
  textClassName,
  actions,
  onClose,
  closeTitle,
  className,
  style
}: HintBannerProps) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 px-4 py-1.5 text-xs text-amber-700 dark:text-amber-400 bg-amber-500/10 select-none',
        className
      )}
      style={style}
    >
      {icon ? <span className="shrink-0 flex items-center">{icon}</span> : null}
      <span className={cn('min-w-0 truncate', textClassName)} title={title}>
        {children}
      </span>
      {actions ? (
        <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">{actions}</div>
      ) : null}
      {onClose ? (
        <button
          type="button"
          onClick={onClose}
          title={closeTitle ?? t('关闭提示')}
          aria-label={closeTitle ?? t('关闭提示')}
          className="ml-auto shrink-0 p-0.5 rounded text-current opacity-70 hover:bg-amber-500/20 hover:opacity-100 transition-colors cursor-pointer"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      ) : null}
    </div>
  )
}

/** 横幅内的轻量动作（如「知道了」）：下划线文字按钮，视觉重量低于主操作按钮 */
export function HintBannerLink({
  children,
  onClick,
  title,
  className
}: {
  children: React.ReactNode
  onClick?: React.MouseEventHandler<HTMLButtonElement>
  title?: string
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'shrink-0 whitespace-nowrap px-1 py-0.5 font-medium underline underline-offset-2',
        'decoration-amber-600/50 dark:decoration-amber-400/50 hover:decoration-amber-600 dark:hover:decoration-amber-300',
        'hover:text-amber-800 dark:hover:text-amber-300 transition-colors cursor-pointer',
        className
      )}
    >
      {children}
    </button>
  )
}
