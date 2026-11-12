import React from 'react'

interface WelcomeStepLayoutProps {
  /** 步骤容器 data-testid（各步骤既有测试依赖） */
  testId?: string
  title: React.ReactNode
  subtitle?: React.ReactNode
  /** 内容区最大宽度，默认 max-w-3xl */
  maxWidthClass?: string
  /** 固定在底部的操作区（返回 / 下一步等），不随内容滚动，小屏也不会被遮挡 */
  footer: React.ReactNode
  children: React.ReactNode
}

/**
 * 欢迎向导统一步骤骨架。
 *
 * - 内容区独立滚动（min-h-0 + overflow-y-auto），窗口矮 / 平板竖屏时内容可滚动；
 * - 底部操作栏固定在滚动区之外（shrink-0），关键按钮永远可见、不被内容遮挡；
 * - 内边距与标题字号随屏幕自适应，所有步骤共用同一套视觉与间距。
 *
 * 向导页面是硬编码浅色设计，严禁使用 text-foreground 等随主题反转的变量色。
 */
export function WelcomeStepLayout({
  testId,
  title,
  subtitle,
  maxWidthClass = 'max-w-3xl',
  footer,
  children
}: WelcomeStepLayoutProps) {
  return (
    <div data-testid={testId} className="text-foreground flex flex-col h-full min-h-0">
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
        <div className={`mx-auto w-full ${maxWidthClass} px-4 sm:px-6 py-4 sm:py-6`}>
          <header className="text-center mb-4 sm:mb-6">
            <h1 className="text-lg sm:text-2xl font-bold tracking-tight text-foreground">{title}</h1>
            {subtitle && (
              <p className="mt-1.5 text-sm text-muted-foreground leading-relaxed">{subtitle}</p>
            )}
          </header>
          <div className="space-y-4">{children}</div>
        </div>
      </div>
      <footer className="shrink-0 border-t border-border bg-card/95 shadow-[0_-4px_12px_rgba(15,23,42,0.05)]">
        <div
          className={`mx-auto w-full ${maxWidthClass} px-4 sm:px-6 py-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2`}
        >
          {footer}
        </div>
      </footer>
    </div>
  )
}
