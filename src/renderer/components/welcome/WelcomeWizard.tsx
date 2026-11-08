import React, { useState, useEffect } from 'react'
import { useVoerkaI18n } from '@voerkai18n/react'
import i18nScope from '@src/languages'
import { WelcomeStep1 } from './WelcomeStep1'
import { WelcomeStep2PluginSetup } from './WelcomeStep2PluginSetup'
import { useWelcomeStore } from '@stores/config-store'
import { Header } from '../common/Header'
import './welcome.css'
import { captureEvent } from '../../lib/posthog'

interface WelcomeWizardProps {
  onComplete?: () => void
}

/**
 * 欢迎向导（自适应两步流转）
 *
 * Step 1: 语言选择偏好
 * Step 2: AI 能力与插件自适应装配（硬件探测看板、去重精确求和与必装强门禁）
 */
export function WelcomeWizard({ onComplete }: WelcomeWizardProps) {
  const { t, activeLanguage } = useVoerkaI18n(i18nScope)
  const [currentStep, setCurrentStep] = useState<1 | 2>(1)

  // 设置窗口标题栏显示版本号
  useEffect(() => {
    const appName = t('萤核智能文件夹')
    document.title = `${appName} v${__APP_VERSION__}`
  }, [activeLanguage, t])

  // 跟踪进入向导步骤
  useEffect(() => {
    captureEvent('进入欢迎向导步骤', {
      step: currentStep
    })
  }, [currentStep])

  const handleStep1Next = () => {
    setCurrentStep(2)
  }

  const handleStep2Back = () => {
    setCurrentStep(1)
  }

  const handleFinish = async () => {
    await useWelcomeStore.getState().completeSetup()
    onComplete?.()
  }

  return (
    <div className="h-screen w-full flex flex-col overflow-hidden bg-slate-50">
      <Header />
      <div className="flex-grow overflow-hidden">
        {currentStep === 1 && <WelcomeStep1 onNext={handleStep1Next} />}
        {currentStep === 2 && (
          <WelcomeStep2PluginSetup onBack={handleStep2Back} onComplete={handleFinish} />
        )}
      </div>
    </div>
  )
}
