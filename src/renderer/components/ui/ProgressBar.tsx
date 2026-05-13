import React from 'react'
import { cn } from '../../lib/utils'

interface ProgressBarProps {
  value: number
  max?: number
  className?: string
  colorClass?: string
  showValue?: boolean
}

export const ProgressBar: React.FC<ProgressBarProps> = ({
  value,
  max = 100,
  className,
  colorClass = 'bg-blue-500',
  showValue = false
}) => {
  const safeValue = value || 0
  const percentage = Math.min(100, Math.max(0, (safeValue / max) * 100))

  return (
    <div className={cn("w-full flex items-center gap-2", className)}>
      <div className={cn("flex-1 bg-gray-100 rounded-full overflow-hidden", className?.includes('h-') ? 'h-full' : 'h-2')}>
        <div
          className={cn("h-full rounded-full transition-all duration-300", colorClass)}
          style={{ width: `${percentage}%` }}
        />
      </div>
      {showValue && (
        <span className="text-xs text-gray-500 w-8 text-right">
          {Number(safeValue).toFixed(1)}
        </span>
      )}
    </div>
  )
}
