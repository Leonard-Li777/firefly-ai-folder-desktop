import React from 'react'
import { cn } from '../../../lib/utils'
import { PersistentTooltip } from '../PersistentTooltip'

export interface Step {
  key: string
  label: string
  path: string
  /** Material Icon 名称字符串 */
  icon: string
  /** 可选：Step 右上角的徽章数量（>0 时显示橙色脉冲徽章） */
  badgeCount?: number
  /** 可选：持久性提示的 ID（用于 localStorage 持久化关闭） */
  tooltipId?: string
  /** 可选：持久性提示的内容文本 */
  tooltipContent?: string
  /** 可选：手动控制提示的显示隐藏 */
  tooltipVisible?: boolean
  /** 可选：指示气泡的位置，支持 top / bottom / left / right，默认 bottom */
  tooltipPosition?: 'top' | 'bottom' | 'left' | 'right'
}

export interface StepperProps {
  steps: Step[]
  currentPath: string
  onStepClick?: (path: string) => void
}

/**
 * Stepper 步骤条组件 - Unified View Control Hub 核心导航
 *
 * 响应式压缩策略（空间不足时优先级）：
 *  Priority 1: 数字徽章  → style flexShrink:9999，最先被挤压消失
 *  Priority 2: 标签文字  → shrink + overflow-hidden text-ellipsis，逐步截断
 *  Priority 3: 图标      → flex-shrink-0，始终可见
 *  Priority 4: (›) 箭头  → flex-shrink-0，始终可见，保证流程顺序感知
 *
 * 明暗主题：全部使用 Tailwind 语义 CSS 变量，自动适配
 */
export const Stepper: React.FC<StepperProps> = ({ steps, currentPath, onStepClick }) => {
  const currentIndex = steps.findIndex(step => step.path === currentPath)

  const renderCapsule = (step: Step, index: number) => {
    const isActive = index === currentIndex
    const isCompleted = index < currentIndex
    const isPending = index > currentIndex
    const showBadge = step.badgeCount !== undefined && step.badgeCount > 0

    return (
      <div
        role="button"
        tabIndex={0}
        aria-current={isActive ? 'step' : undefined}
        title={step.label}
        onClick={() => onStepClick?.(step.path)}
        onKeyDown={e => e.key === 'Enter' && onStepClick?.(step.path)}
        className={cn(
          // 布局 & 形态：全圆角胶囊
          // 注意：不使用 overflow-hidden，以便绝对定位的 Badge 可以越出胶囊边界
          'relative flex items-center rounded-full',
          'cursor-pointer select-none',
          'transition-all duration-200 ease-out',
          // 垂直方向更高，让短内容接近圆形
          'px-2 py-1.5',
          // 自适应缩放：步骤项本身可 shrink，最小宽度由图标撑开
          'shrink min-w-0',
          // ── 三种视觉状态 ──
          isActive && [
            // 激活：主色渐变胶囊 + 阴影光晕
            'bg-primary text-primary-foreground',
            'shadow-[0_2px_8px_-2px_hsl(var(--primary)/0.5)]',
            'ring-1 ring-primary/30'
          ],
          isCompleted && [
            // 已完成：主色淡底 + 主色文字
            'bg-primary/12 dark:bg-primary/18 text-primary',
            'hover:bg-primary/20 dark:hover:bg-primary/26'
          ],
          isPending && [
            // 待进行：透明底 + 灰色文字，hover 时轻亮
            'text-muted-foreground',
            'hover:bg-accent/70 hover:text-accent-foreground'
          ]
        )}
      >
        {/* ─── 橙色计数 Badge（右上角绝对定位） ─── */}
        {showBadge && (
          <div
            className={cn(
              'absolute -top-1.5 -right-1.5 z-10',
              'min-w-[1.25rem] h-5 px-1.5 py-0.5',
              'flex items-center justify-center',
              'bg-orange-500 hover:bg-orange-600',
              'text-white text-[10px] font-bold leading-none',
              'rounded-full',
              'border-none',
              'shadow-[0_0_10px_rgba(249,115,22,0.6)]',
              'animate-pulse',
              'cursor-pointer'
            )}
            onClick={e => {
              e.stopPropagation()
              onStepClick?.(step.path)
            }}
          >
            {step.badgeCount! > 99 ? '99+' : step.badgeCount}
          </div>
        )}

        {/* ② 数字徽章：设置 flex-shrink-0 保证其圆圈和数字始终可见，而不是最先挤压到 0 */}
        <div
          className={cn(
            'flex items-center justify-center rounded-full leading-none flex-shrink-0',
            'text-[10px] font-bold',
            'transition-all duration-150',
            'w-[20px] h-[20px]',
            // 激活态：自适应主题背景
            // - 亮色模式下步骤胶囊是深色 bg-primary，故徽章使用白色圆圈 + 深色文字 (bg-white text-zinc-950)
            // - 暗色模式下步骤胶囊是浅色 bg-primary，故徽章使用深色圆圈 + 浅色文字 (dark:bg-zinc-900 dark:text-zinc-50)
            isActive
              ? 'bg-white text-zinc-950 dark:bg-zinc-900 dark:text-zinc-50 border border-zinc-200 dark:border-zinc-700/30'
              : // 已完成态：主色背景 + 白色文字
                isCompleted
                ? 'bg-primary text-primary-foreground'
                : // 待进入态：半透明背景 + 灰色文字 + 边框
                  'bg-muted text-muted-foreground border border-muted-foreground/25'
          )}
        >
          <span>{index + 1}</span>
        </div>

        {/* ① 图标区域：flex-shrink-0，永远可见 */}
        <div className="relative flex-shrink-0 flex items-center justify-center ml-2">
          {/* 已完成时：图标用勾替换 */}
          {isCompleted ? (
            <span className="material-icons text-[16px] leading-none text-primary">
              check_circle
            </span>
          ) : (
            <span
              className={cn(
                'material-icons text-[16px] leading-none',
                isActive ? 'text-primary-foreground' : 'text-muted-foreground'
              )}
            >
              {step.icon}
            </span>
          )}
        </div>

        {/* ③ 标签文字：中等 shrink，空间再压缩时截断 */}
        <span
          className={cn(
            'ml-1 text-[11px] font-semibold',
            'overflow-hidden text-ellipsis whitespace-nowrap',
            'min-w-0',
            isActive
              ? 'text-primary-foreground'
              : isCompleted
                ? 'text-primary'
                : 'text-muted-foreground'
          )}
          style={{ flexShrink: 2 }}
        >
          {step.label}
        </span>
      </div>
    )
  }

  return (
    <div className="flex items-center min-w-0 flex-1" style={{ gap: '5px' }}>
      {steps.map((step, index) => {
        return (
          <React.Fragment key={step.key}>
            {step.tooltipContent && step.tooltipId ? (
              <PersistentTooltip
                id={step.tooltipId}
                content={step.tooltipContent}
                visible={
                  step.tooltipVisible !== undefined
                    ? step.tooltipVisible
                    : step.badgeCount !== undefined && step.badgeCount > 0
                }
                position={step.tooltipPosition || 'bottom'}
                delay={1000}
                duration={Infinity}
              >
                {renderCapsule(step, index)}
              </PersistentTooltip>
            ) : (
              renderCapsule(step, index)
            )}

            {/* ─── 箭头分隔符：flex-shrink-0，永远可见 ─── */}
            {index < steps.length - 1 && (
              <div
                className="flex items-center justify-center flex-shrink-0"
                style={{ width: '18px' }}
              >
                <span
                  className={cn(
                    'material-icons leading-none text-[16px]',
                    // 已经过的箭头：淡主色；未到达的箭头：更暗淡
                    index < currentIndex
                      ? 'text-primary/40 dark:text-primary/30'
                      : 'text-muted-foreground/35 dark:text-muted-foreground/25'
                  )}
                >
                  chevron_right
                </span>
              </div>
            )}
          </React.Fragment>
        )
      })}
    </div>
  )
}
