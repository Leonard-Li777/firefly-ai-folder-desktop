import React from 'react'
import { cn } from '../../lib/utils'

interface LoadingProps {
  type?: 'spinner' | 'skeleton' | 'mini'
  title?: string
  className?: string
}

export const Loading: React.FC<LoadingProps> = ({ type = 'spinner', title, className }) => {
  if (type === 'mini') {
    return (
      <div className={cn('inline-flex items-center justify-center text-primary', className)}>
        <svg
          className="animate-spin h-4 w-4 text-current"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
          />
        </svg>
        {title && <span className="ml-2 text-xs font-medium">{title}</span>}
      </div>
    )
  }

  if (type === 'skeleton') {
    return (
      <div className={cn('w-full space-y-4 animate-pulse', className)}>
        <div className="h-6 bg-muted/60 dark:bg-muted/30 rounded-lg w-2/3" />
        <div className="space-y-2.5">
          <div className="h-4 bg-muted/40 dark:bg-muted/20 rounded-md w-full" />
          <div className="h-4 bg-muted/40 dark:bg-muted/20 rounded-md w-5/6" />
          <div className="h-4 bg-muted/40 dark:bg-muted/20 rounded-md w-4/5" />
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center p-8 select-none relative overflow-hidden w-full h-full min-h-[200px]',
        className
      )}
    >
      {/* 优雅背景发光 */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-48 h-48 bg-primary/5 rounded-full blur-2xl pointer-events-none" />

      <div className="relative z-10 flex flex-col items-center">
        <div className="relative mb-5">
          {/* 外层呼吸光环 */}
          <div
            className="absolute inset-0 w-12 h-12 rounded-2xl bg-primary/20 dark:bg-primary/30 animate-ping opacity-35"
            style={{ animationDuration: '2.5s' }}
          />
          {/* 主 Loading 转圈 */}
          <div className="relative w-12 h-12 rounded-2xl bg-gradient-to-tr from-primary/10 via-primary/5 to-transparent border border-primary/20 dark:border-primary/30 flex items-center justify-center shadow-lg shadow-primary/5">
            <svg
              className="animate-spin h-6 w-6 text-primary"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-10"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="3"
              />
              <path
                className="opacity-80"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
          </div>
        </div>
        {title && (
          <p className="text-sm text-muted-foreground font-semibold tracking-wide animate-pulse">
            {title}
          </p>
        )}
      </div>
    </div>
  )
}
