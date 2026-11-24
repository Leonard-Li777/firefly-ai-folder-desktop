import React from 'react'
import { MaterialIcon, cn } from '../../../lib/utils'
import { LAYOUT_KEYS, type LayoutKey } from './types'

export interface LayoutPresetIconProps {
  layoutKey: LayoutKey
  icon: string
  className?: string
}

/**
 * 布局预设图标渲染器：
 * 品字布局使用精确三矩形（上 1 下 2）实心圆角矢量图标呈现“品”字结构，其余布局复用 MaterialIcon。
 */
export const LayoutPresetIcon: React.FC<LayoutPresetIconProps> = ({
  layoutKey,
  icon,
  className
}) => {
  if (layoutKey === LAYOUT_KEYS.PIN_LIST_TOP) {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
        className={cn('w-[18px] h-[18px] shrink-0', className)}
      >
        <rect x="3" y="4" width="18" height="7" rx="1.5" />
        <rect x="3" y="13" width="8" height="7" rx="1.5" />
        <rect x="13" y="13" width="8" height="7" rx="1.5" />
      </svg>
    )
  }

  return <MaterialIcon icon={icon} className={className} />
}
