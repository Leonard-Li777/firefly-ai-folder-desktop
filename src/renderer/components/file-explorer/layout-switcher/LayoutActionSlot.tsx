import React from 'react'
import { cn } from '../../../lib/utils'

export interface LayoutActionSlotProps {
  className?: string
  children?: React.ReactNode
}

/**
 * 恒定外层槽位包装器 (LayoutActionSlot)
 * 全权持有容器查询规则，几何结构与类名绝对恒定，彻底杜绝浮层开合时的视觉抖动
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
