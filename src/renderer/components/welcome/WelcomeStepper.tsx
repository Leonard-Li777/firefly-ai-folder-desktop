import React from 'react'
import { useVoerkaI18n } from '@voerkai18n/react'
import i18nScope from '@src/languages'
import { Check } from 'lucide-react'

export type WelcomeStepNumber = 1 | 2 | 3 | 4 | 5

/** 与 5 步向导一一对应的短标签，保持大白话、避免技术黑话 */
const STEP_LABELS = [
  '选择语言',
  '能力装配',
  '安装目录',
  '插件安装方式',
  '安装完成'
] as const

interface WelcomeStepperProps {
  currentStep: WelcomeStepNumber
}

/**
 * 欢迎向导顶部步骤指示器。
 *
 * 向导页面是硬编码浅色设计，所有颜色必须是确定性色值；
 * 严禁使用 text-foreground / text-muted-foreground 等会随主题反转的变量色，
 * 否则亮色模式下会出现白底白字。
 */
export function WelcomeStepper({ currentStep }: WelcomeStepperProps) {
  const { t } = useVoerkaI18n(i18nScope)

  return (
    <div
      data-testid="welcome-stepper"
      className="shrink-0 w-full border-b border-border bg-card px-4 py-2.5"
    >
      <div className="max-w-3xl mx-auto">
        <div
          data-testid="welcome-stepper-caption"
          className="text-center text-xs font-medium text-muted-foreground mb-1.5"
        >
          {t('第 {step} 步 / 共 5 步', { step: currentStep })}
        </div>
        <div className="flex items-center justify-between">
          {STEP_LABELS.map((label, index) => {
            const step = (index + 1) as WelcomeStepNumber
            const isDone = step < currentStep
            const isCurrent = step === currentStep

            const circleClass = isDone
              ? 'bg-emerald-500/15 border-emerald-500/50 text-emerald-700 dark:text-emerald-300'
              : isCurrent
                ? 'bg-primary border-primary text-primary-foreground shadow-sm'
                : 'bg-card border-border text-muted-foreground'

            const labelClass = isDone
              ? 'text-emerald-700 dark:text-emerald-300'
              : isCurrent
                ? 'text-primary font-semibold'
                : 'text-muted-foreground'

            return (
              <React.Fragment key={label}>
                <div
                  data-testid={`welcome-stepper-item-${step}`}
                  aria-current={isCurrent ? 'step' : undefined}
                  className="flex flex-col items-center gap-1 sm:min-w-[64px]"
                >
                  <span
                    className={`w-7 h-7 rounded-full border-2 inline-flex items-center justify-center text-xs font-bold ${circleClass}`}
                  >
                    {isDone ? <Check className="w-3.5 h-3.5" /> : step}
                  </span>
                  {/* 窄屏只显示当前步骤名，避免 5 个标签挤爆一行 */}
                  <span
                    className={`text-xs whitespace-nowrap ${isCurrent ? '' : 'hidden sm:inline'} ${labelClass}`}
                  >
                    {t(label)}
                  </span>
                </div>
                {index < STEP_LABELS.length - 1 && (
                  <div
                    className={`flex-1 h-0.5 mx-1 mb-5 rounded-full ${
                      isDone ? 'bg-emerald-500/50' : 'bg-border'
                    }`}
                  />
                )}
              </React.Fragment>
            )
          })}
        </div>
      </div>
    </div>
  )
}
