import React from 'react'
import { useVoerkaI18n } from '@voerkai18n/react'
import i18nScope from '@src/languages'
import { WelcomeStepLayout } from './WelcomeStepLayout'
import { Card, CardContent } from '@components/ui/card'
import { Button } from '@components/ui/button'
import { Badge } from '@components/ui/badge'
import { Wifi, PackageOpen, CheckCircle2, ArrowLeft, ArrowRight, Info } from 'lucide-react'
import type { WelcomeInstallMethod } from './welcome-types'

interface WelcomeStep4InstallMethodProps {
  value: WelcomeInstallMethod
  onChange: (method: WelcomeInstallMethod) => void
  onBack: () => void
  onNext: () => void
}

/**
 * 欢迎向导 Step 4：插件安装方式（只做选择，不执行任何下载 / 导入）
 *
 * 按用户要求排在「选择插件安装目录」之后：先定插件、再定文件夹，最后才定从哪里拿插件，
 * 紧接着 Step 5 就按这里选的方式展示「在线下载进度」或「离线选包按钮」两种 UI。
 * 真正的下载与导入统一推迟到 Step 5，避免选目录 / 选方式之前就开始写盘。
 */
export function WelcomeStep4InstallMethod({
  value,
  onChange,
  onBack,
  onNext
}: WelcomeStep4InstallMethodProps) {
  const { t } = useVoerkaI18n(i18nScope)

  const methods: Array<{
    id: WelcomeInstallMethod
    title: string
    subtitle: string
    description: string
    badge: string
    icon: React.ReactNode
    accent: string
  }> = [
    {
      id: 'online',
      title: '在线安装插件',
      subtitle: '联网自动装好，最省事',
      description:
        '插件和存放文件夹前面都选好了，只要电脑能上网，下一步软件就会自己把需要的东西下载好、装好，全程不用你操心。第一次花的时间主要看网速。',
      badge: '推荐',
      icon: <Wifi className="w-6 h-6 text-primary" />,
      accent: 'sky'
    },
    {
      id: 'offline',
      title: '导入离线总包',
      subtitle: '不联网也能一次装齐',
      description:
        '电脑不方便上网，或者你手上已经有完整的安装包时选这个。存放文件夹上一步已经选好，下一步会让你挑一个安装包文件，一次导入就能把插件装齐，全程不联网、不上传任何文件。',
      badge: '无网可用',
      icon: <PackageOpen className="w-6 h-6 text-emerald-600 dark:text-emerald-400" />,
      accent: 'emerald'
    }
  ]

  return (
    <WelcomeStepLayout
      testId="welcome-step4-container"
      maxWidthClass="max-w-3xl"
      title={t('插件怎么装？')}
      subtitle={t('插件和存放文件夹都定好了，最后选一种拿插件的方式；点下一步才会开始装，现在还不会占用你的磁盘')}
      footer={
        <>
          <Button
            data-testid="welcome-step4-back-btn"
            variant="ghost"
            size="sm"
            onClick={onBack}
            className="text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="w-4 h-4 mr-1" />
            {t('返回')}
          </Button>
          <Button
            data-testid="welcome-step4-next-btn"
            onClick={onNext}
            className="bg-primary hover:bg-primary/90 text-primary-foreground font-medium px-5"
          >
            {t('下一步')}
            <ArrowRight className="w-4 h-4 ml-1.5" />
          </Button>
        </>
      }
    >

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {methods.map(method => {
            const isSelected = value === method.id
            const isOnline = method.id === 'online'
            return (
              <Card
                key={method.id}
                data-testid={`welcome-method-${method.id}-card`}
                onClick={() => onChange(method.id)}
                className={`cursor-pointer rounded-xl border-2 p-4 transition-all ${
                  isSelected
                    ? isOnline
                      ? 'border-primary bg-primary/10 shadow-md'
                      : 'border-emerald-500 bg-emerald-500/10 shadow-md'
                    : 'border-border bg-card hover:border-primary/40'
                }`}
              >
                <CardContent className="p-0 flex flex-col gap-3 min-h-[190px]">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2.5">
                      <span
                        className={`w-10 h-10 rounded-lg inline-flex items-center justify-center ${
                          isOnline ? 'bg-primary/15' : 'bg-emerald-500/15'
                        }`}
                      >
                        {method.icon}
                      </span>
                      <div>
                        <div className="text-base font-semibold text-foreground">
                          {t(method.title)}
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {t(method.subtitle)}
                        </div>
                      </div>
                    </div>
                    <Badge
                      variant="outline"
                      className={`text-[11px] shrink-0 ${
                        isOnline
                          ? 'bg-primary/10 border-primary/30 text-primary'
                          : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-300'
                      }`}
                    >
                      {t(method.badge)}
                    </Badge>
                  </div>

                  <p className="text-xs text-muted-foreground leading-relaxed flex-grow">
                    {t(method.description)}
                  </p>

                  <div
                    className={`flex items-center gap-1.5 text-xs font-medium ${
                      isSelected
                        ? isOnline
                          ? 'text-primary'
                          : 'text-emerald-700 dark:text-emerald-300'
                        : 'text-muted-foreground'
                    }`}
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    <span>{isSelected ? t('已选中，下一步继续') : t('点这张卡片选中')}</span>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>

        <div
          data-testid="welcome-step4-hint"
          className="mt-4 flex items-start gap-2 rounded-lg bg-muted border border-border p-3 text-xs text-muted-foreground"
        >
          <Info className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
          <span>
            {t(
              '两种方式只是拿插件的途径不同，装好之后功能完全一样；以后也随时可以在插件中心增减，不用担心现在选错。'
            )}
          </span>
        </div>

        {/* 离线方式：说明前面选好的插件在导入完成后如何生效（原能力装配页提示移到这里） */}
        {value === 'offline' && (
          <div
            data-testid="welcome-step4-offline-hint"
            className="mt-2 flex items-start gap-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 p-3 text-xs text-emerald-700 dark:text-emerald-300"
          >
            <PackageOpen className="w-4 h-4 shrink-0 mt-0.5 text-emerald-600 dark:text-emerald-400" />
            <span>
              {t(
                '离线总包里已经带了全部插件；前面选好的引擎和插件，会作为导入完成后优先启用哪一项的参考。'
              )}
            </span>
          </div>
        )}
    </WelcomeStepLayout>
  )
}
