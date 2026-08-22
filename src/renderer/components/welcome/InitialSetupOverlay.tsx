import React from 'react'
import { Loader2 } from 'lucide-react'
import { Card } from '../ui/card'
import { useVoerkaI18n } from '@voerkai18n/react'
import i18nScope from '@src/languages'

interface InitialSetupOverlayProps {
  status: string
  message?: string
  /** 非阻塞模式：显示为角落小卡片，不遮挡底层交互 */
  nonBlocking?: boolean
}

export const InitialSetupOverlay: React.FC<InitialSetupOverlayProps> = ({ status, message, nonBlocking }) => {
  const { t } = useVoerkaI18n(i18nScope)

  const getTitle = () => {
    if (status === 'preparing') return t('正在准备应用')
    return t('正在安装 AI 引擎及配置')
  }

  // 非阻塞模式：小卡片浮在角落，不遮挡点击
  if (nonBlocking) {
    return (
      <div className="fixed top-4 right-4 z-50">
        <Card className="p-4 w-72 border border-primary/20 shadow-lg rounded-xl bg-card/95 backdrop-blur-sm">
          <div className="flex items-center gap-3">
            <div className="relative shrink-0">
              <div className="absolute inset-0 bg-primary/15 blur-md rounded-full animate-pulse"></div>
              <div className="relative bg-primary/10 p-2 rounded-full">
                <Loader2 className="h-5 w-5 text-primary animate-spin" />
              </div>
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-foreground truncate">
                {getTitle()}
              </p>
              <p className="text-xs text-muted-foreground truncate mt-0.5">
                {message || t('正在后台安装环境，您可先进行语言设置')}
              </p>
            </div>
          </div>
          <div className="mt-2 w-full bg-primary/5 rounded-full h-1 overflow-hidden border border-primary/10">
            <div className="bg-primary h-full w-full origin-left animate-[loading_2s_ease-in-out_infinite] rounded-full"></div>
          </div>
        </Card>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-background/90 backdrop-blur-xl">
      <Card className="p-10 max-w-lg w-full border-2 border-primary/30 shadow-[0_0_50px_-12px_rgba(0,0,0,0.3)] shadow-primary/20 rounded-[2.5rem] bg-card/50 animate-in fade-in zoom-in duration-500">
        <div className="flex flex-col items-center text-center space-y-8">
          <div className="relative">
            <div className="absolute inset-0 bg-primary/25 blur-2xl rounded-full animate-pulse"></div>
            <div className="relative bg-primary/10 p-6 rounded-full border border-primary/20">
              <Loader2 className="h-12 w-12 text-primary animate-spin" />
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="text-2xl font-black tracking-tight text-foreground sm:text-3xl">
              {getTitle()}
            </h3>
            <p className="text-base text-muted-foreground font-medium px-6 leading-relaxed">
              {message || t('应用首次启动或版本升级，正在为您配置最佳运行环境，请稍候...')}
            </p>
          </div>

          <div className="w-full space-y-4">
            <div className="w-full bg-primary/5 rounded-full h-2 overflow-hidden border border-primary/10">
              <div className="bg-primary h-full w-full origin-left animate-[loading_2s_ease-in-out_infinite] rounded-full shadow-[0_0_10px_color-mix(in_srgb,var(--primary)_50%,transparent)]"></div>
            </div>
            <div className="flex justify-between items-center px-1">
              <span className="text-[10px] text-primary/70 font-bold uppercase tracking-[0.2em]">
                {t('初始化中')}
              </span>
              <span className="text-[10px] text-muted-foreground/60 font-bold uppercase tracking-[0.2em]">
                {t('请勿关闭应用')}
              </span>
            </div>
          </div>
        </div>
      </Card>

      {/* 背景装饰元素 */}
      <div className="absolute top-1/4 -left-20 w-64 h-64 bg-primary/5 rounded-full blur-3xl -z-10 animate-pulse"></div>
      <div className="absolute bottom-1/4 -right-20 w-80 h-80 bg-primary/10 rounded-full blur-3xl -z-10 animate-pulse" style={{ animationDelay: '1s' }}></div>
    </div>
  )
}
