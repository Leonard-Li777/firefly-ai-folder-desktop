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
 * 欢迎向导（仅语言选择一步）
 *
 * 模型存储目录配置已迁移至引擎应用（firefly-ai-engine），
 * 引擎/模型下载引导由引擎应用承载（见 docs/prd/0043-engine-model-first-download-guidance-prd.md 与 ADR-0042）。
 *
 * V4 架构已取消内置模型、模型下载完全由引擎应用负责，因此原「模型目录合法检测」步骤
 * 及其配套步骤机（currentStep / modelMode / nextStep / goToStep / goToModelSelection）
 * 已随 PRD-0044 全链清退，本组件固定渲染唯一的语言选择步骤。
 */
export function WelcomeWizard({ onComplete }: WelcomeWizardProps) {
  const { t, activeLanguage } = useVoerkaI18n(i18nScope)

  // 设置窗口标题栏显示版本号
  useEffect(() => {
    const appName = t('萤核智能文件夹')
    document.title = `${appName} v${__APP_VERSION__}`
  }, [activeLanguage, t])

  // 跟踪进入向导（单步：语言选择）
  useEffect(() => {
    captureEvent('进入欢迎向导步骤', {
      step: 1
    })
  }, [])

  const handleNext = async () => {
    await useWelcomeStore.getState().completeSetup()
    onComplete?.()
  }

  return (
    <div className="h-screen w-full flex flex-col overflow-hidden bg-slate-50">
      <Header />
      <div className="flex-grow overflow-hidden">
        <WelcomeStep1 onNext={handleNext} />
      </div>
    </div>
  )
}
