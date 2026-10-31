import React from 'react'
import { MaterialIcon, cn } from '../../lib/utils'

const logoImageUrl = new URL('../../assets/logo_128.png', import.meta.url).href

interface EmptyStateProps {
  icon?: string
  title: React.ReactNode
  description?: React.ReactNode
  isLoading?: boolean
  className?: string
  children?: React.ReactNode
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  icon = 'auto_awesome',
  title,
  description,
  isLoading = false,
  className,
  children
}) => {
  return (
    <div
      className={cn(
        'flex-1 flex flex-col items-center justify-center h-full w-full bg-background relative overflow-hidden p-8 select-none',
        className
      )}
    >
      <div className="relative z-10 text-center max-w-sm flex flex-col items-center">
        {/* 精美图标区域 */}
        <div className="relative mb-6">
          {/* 主图标容器 */}
          <div className="relative w-20 h-20 rounded-2xl bg-gradient-to-tr from-primary/15 via-primary/10 to-purple-500/15 dark:from-primary/25 dark:via-primary/15 dark:to-purple-500/25 border border-primary/15 dark:border-primary/25 flex items-center justify-center shadow-md shadow-primary/5 dark:shadow-primary/10">
            {/* 内部装饰圆点 */}
            {!isLoading && (
              <>
                <div className="absolute top-2 right-2 w-1.5 h-1.5 rounded-full bg-primary/40 dark:bg-primary/60" />
                <div className="absolute bottom-2 left-2 w-1 h-1 rounded-full bg-purple-500/40 dark:bg-purple-500/60" />
              </>
            )}

            {isLoading ? (
              <div className="relative flex items-center justify-center">
                <div
                  className="absolute inset-0 w-10 h-10 -m-1 rounded-2xl bg-primary/20 dark:bg-primary/30 animate-ping opacity-35"
                  style={{ animationDuration: '2.4s' }}
                />
                <svg
                  className="animate-spin h-8 w-8 text-primary"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-15"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="3"
                  />
                  <path
                    className="opacity-85"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                {icon && icon !== 'auto_awesome' && (
                  <MaterialIcon icon={icon} className="absolute text-sm text-primary/70" />
                )}
              </div>
            ) : (
              <img src={logoImageUrl} alt="logo" className="w-12 h-12 object-contain" />
            )}
          </div>
        </div>

        {/* 标题 */}
        <h3 className={cn('text-xl font-bold tracking-tight text-foreground mb-2', isLoading && 'animate-pulse')}>
          {title}
        </h3>

        {/* 描述文本 */}
        {description && (
          <div className="text-sm text-muted-foreground leading-relaxed mb-7 max-w-xs">
            {description}
          </div>
        )}

        {children}
      </div>
    </div>
  )
}
