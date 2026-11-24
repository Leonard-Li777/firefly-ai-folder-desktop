import React from 'react'
import { cn } from '../../../lib/utils'

export interface LayoutActionSlotProps {
  className?: string
  children?: React.ReactNode
}

/**
 * 恒定外层槽位包装器 (LayoutActionSlot)
 * 几何结构与类名绝对恒定，彻底杜绝浮层开合时的视觉抖动。
 * 注意：严禁挂载 `@container/*`（`container-type: inline-size`），否则该无显式宽度的 flex 子项固有宽度将坍缩为 0px，导致内部布局按钮组向右溢出窗口。
 */
export const LayoutActionSlot: React.FC<LayoutActionSlotProps> = ({ className, children }) => {
  return (
    <div
      data-testid="layout-action-slot"
      className={cn('flex items-center shrink-0 h-9 relative', 'no-drag', className)}
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      {children || <div className="w-0 h-0" aria-hidden="true" />}
    </div>
  )
}
