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
      {/* 多层背景光晕，适配明暗模式 */}
      <div className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-gradient-to-tr from-primary/6 to-purple-500/6 dark:from-primary/12 dark:to-purple-500/12 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-1/4 right-1/4 w-48 h-48 bg-gradient-to-bl from-indigo-500/4 to-cyan-500/4 dark:from-indigo-500/8 dark:to-cyan-500/8 rounded-full blur-2xl pointer-events-none" />

      <div className="relative z-10 text-center max-w-sm flex flex-col items-center">
        {/* 精美图标区域 */}
        <div className="relative mb-6">
          {/* 外层光圈脉冲动画 */}
          <div
            className="absolute inset-0 w-20 h-20 rounded-2xl bg-gradient-to-tr from-primary/20 to-purple-500/20 dark:from-primary/30 dark:to-purple-500/30 animate-ping opacity-30"
            style={{ animationDuration: '3s' }}
          />
          {/* 主图标容器 */}
          <div className="relative w-20 h-20 rounded-2xl bg-gradient-to-tr from-primary/15 via-primary/10 to-purple-500/15 dark:from-primary/25 dark:via-primary/15 dark:to-purple-500/25 border border-primary/15 dark:border-primary/25 flex items-center justify-center shadow-lg shadow-primary/8 dark:shadow-primary/15">
            {/* 内部装饰圆点 */}
            {!isLoading && (
              <>
                <div className="absolute top-2 right-2 w-1.5 h-1.5 rounded-full bg-primary/40 dark:bg-primary/60" />
                <div className="absolute bottom-2 left-2 w-1 h-1 rounded-full bg-purple-500/40 dark:bg-purple-500/60" />
              </>
            )}

            {isLoading ? (
              <div className="inline-block animate-spin rounded-full h-8 w-8 border-t-2 border-primary"></div>
            ) : (
              <img src={logoImageUrl} alt="logo" className="w-12 h-12 object-contain" />
            )}
          </div>
        </div>

        {/* 标题 */}
        <h3 className="text-xl font-bold tracking-tight text-foreground mb-2">{title}</h3>

        {/* 描述文本 */}
        {description && (
          <p className="text-sm text-muted-foreground leading-relaxed mb-7 max-w-xs">
            {description}
          </p>
        )}

        {children}
      </div>
    </div>
  )
}
