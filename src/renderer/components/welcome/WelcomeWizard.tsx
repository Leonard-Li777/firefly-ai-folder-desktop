import React, { useEffect } from 'react'
import { useVoerkaI18n } from '@voerkai18n/react'
import i18nScope from '@src/languages'
import { WelcomeStep1 } from './WelcomeStep1'
import { useWelcomeStore } from '@stores/config-store'
import { Header } from '../common/Header'
import './welcome.css'
import { captureEvent } from '../../lib/posthog'

interface WelcomeWizardProps {
  onComplete?: () => void
}

/**
 * 欢迎向导（已收敛为仅语言选择一步）
 *
 * 模型存储目录配置已迁移至引擎应用（firefly-ai-engine），
 * 引擎/模型下载引导由引擎应用承载（见 docs/prd/0043-engine-model-first-download-guidance-prd.md 与 ADR-0042）。
 */
export function WelcomeWizard({ onComplete }: WelcomeWizardProps) {
  const { t, activeLanguage } = useVoerkaI18n(i18nScope)
  const { currentStep, modelMode } = useWelcomeStore()

  // 设置窗口标题栏显示版本号
  useEffect(() => {
    const appName = t('萤核智能文件夹')
    document.title = `${appName} v${__APP_VERSION__}`
  }, [activeLanguage, t])

  // 跟踪步骤变化
  useEffect(() => {
    captureEvent('进入欢迎向导步骤', {
      step: currentStep,
      modelMode
    })
  }, [currentStep, modelMode])

  // 渲染当前步骤：仅语言选择，确认即完成设置
  const renderCurrentStep = () => {
    if (currentStep === 1) {
      return (
        <WelcomeStep1
          onNext={async () => {
            await useWelcomeStore.getState().completeSetup()
            onComplete?.()
          }}
        />
      )
    }

    // 防御：不存在后续步骤，任何越界步骤号一律回落到语言选择
    return <WelcomeStep1 onNext={async () => {
      await useWelcomeStore.getState().completeSetup()
      onComplete?.()
    }} />
  }

  return (
    <div className="h-screen w-full flex flex-col overflow-hidden bg-slate-50">
      <Header />
      <div className="flex-grow overflow-hidden">{renderCurrentStep()}</div>
    </div>
  )
}
