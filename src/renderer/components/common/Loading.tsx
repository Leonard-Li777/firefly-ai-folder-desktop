import React from 'react'
import { MaterialIcon, cn } from '../../lib/utils'
import { t } from '@app/languages'

export interface LoadingProps {
  type?: 'spinner' | 'skeleton' | 'mini' | 'search' | 'file-list'
  title?: string
  description?: string
  icon?: string
  className?: string
}

export const Loading: React.FC<LoadingProps> = ({
  type = 'spinner',
  title,
  description,
  icon,
  className
}) => {
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

  if (type === 'search') {
    const defaultTitle = t('正在搜索...')
    const defaultDesc = t('正在检索文件名、标签与深度多模态语义内容...')

    return (
      <div
        className={cn(
          'flex flex-col items-center justify-center p-8 select-none relative overflow-hidden w-full h-full min-h-[220px]',
          className
        )}
      >
        {/* 优雅多光谱背景发光 */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-64 h-64 bg-gradient-to-tr from-violet-500/10 via-primary/10 to-indigo-500/10 rounded-full blur-3xl pointer-events-none" />

        <div className="relative z-10 flex flex-col items-center text-center max-w-sm">
          {/* 雷达扫描/搜索脉冲主体 */}
          <div className="relative mb-5 flex items-center justify-center">
            {/* 外层脉冲波纹 */}
            <div
              className="absolute w-16 h-16 rounded-2xl bg-violet-500/15 dark:bg-violet-500/25 animate-ping opacity-40 pointer-events-none"
              style={{ animationDuration: '2.8s' }}
            />
            {/* 次级扩散环 */}
            <div
              className="absolute w-20 h-20 rounded-2xl border border-primary/20 dark:border-primary/30 animate-pulse opacity-30 pointer-events-none"
              style={{ animationDuration: '2s' }}
            />

            {/* 核心卡片 */}
            <div className="relative w-16 h-16 rounded-2xl bg-gradient-to-br from-violet-500/10 via-background to-primary/10 border border-primary/25 dark:border-primary/40 flex items-center justify-center shadow-xl shadow-primary/10 backdrop-blur-xs">
              <svg
                className="animate-spin absolute inset-0 w-full h-full p-2.5 text-primary/80"
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
                  strokeWidth="2.5"
                />
                <path
                  className="opacity-90"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              <MaterialIcon
                icon={icon || 'travel_explore'}
                className="text-2xl text-primary drop-shadow-xs"
              />
            </div>
          </div>

          {/* 标题 */}
          <h3 className="text-base font-semibold text-foreground tracking-tight mb-1.5 flex items-center gap-1.5 justify-center">
            <span>{title || defaultTitle}</span>
            <span className="flex space-x-1 items-center">
              <span className="w-1 h-1 rounded-full bg-primary animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1 h-1 rounded-full bg-primary animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-1 h-1 rounded-full bg-primary animate-bounce" style={{ animationDelay: '300ms' }} />
            </span>
          </h3>

          {/* 描述 */}
          <p className="text-xs text-muted-foreground leading-relaxed max-w-xs">
            {description !== undefined ? description : defaultDesc}
          </p>
        </div>
      </div>
    )
  }

  if (type === 'file-list') {
    const defaultTitle = t('正在加载文件...')
    const defaultDesc = t('正在读取目录内容与文件元数据...')

    return (
      <div
        className={cn(
          'flex flex-col items-center justify-center p-8 select-none relative overflow-hidden w-full h-full min-h-[220px]',
          className
        )}
      >
        {/* 背景发光 */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-56 h-56 bg-primary/8 rounded-full blur-2xl pointer-events-none" />

        <div className="relative z-10 flex flex-col items-center text-center max-w-sm">
          {/* 主体图标 */}
          <div className="relative mb-5 flex items-center justify-center">
            {/* 外层呼吸光环 */}
            <div
              className="absolute inset-0 w-14 h-14 rounded-2xl bg-primary/20 dark:bg-primary/30 animate-ping opacity-30 pointer-events-none"
              style={{ animationDuration: '2.4s' }}
            />
            {/* 核心卡片 */}
            <div className="relative w-14 h-14 rounded-2xl bg-gradient-to-tr from-primary/10 via-background to-transparent border border-primary/20 dark:border-primary/30 flex items-center justify-center shadow-lg shadow-primary/5 backdrop-blur-xs">
              <svg
                className="animate-spin absolute inset-0 w-full h-full p-2.5 text-primary"
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
                  className="opacity-80"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              <MaterialIcon icon={icon || 'folder_open'} className="text-xl text-primary/80" />
            </div>
          </div>

          {/* 标题 */}
          <h3 className="text-sm font-semibold text-foreground tracking-wide mb-1 animate-pulse">
            {title || defaultTitle}
          </h3>

          {/* 描述 */}
          {(description || defaultDesc) && (
            <p className="text-xs text-muted-foreground leading-relaxed max-w-xs">
              {description !== undefined ? description : defaultDesc}
            </p>
          )}
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
