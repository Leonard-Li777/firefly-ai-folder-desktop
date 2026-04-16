import React, { useEffect } from 'react'
import { useSettingsStore } from '@stores/settings-store'
import { WelcomeStep1 } from './WelcomeStep1'
import { ModelModeSelectionStep } from './ModelModeSelectionStep'
import { ModelSelectionStep } from './ModelSelectionStep'
import { CloudModelConfigStep } from './CloudModelConfigStep'
import { ModelDownloadStep } from './ModelDownloadStep'
import { DownloadCompleteStep } from './DownloadCompleteStep'
import { ModelStorageStep } from './ModelStorageStep'
import { OllamaInstallStep } from './OllamaInstallStep'
import { OllamaModelSelectionStep } from './OllamaModelSelectionStep'
import { OllamaModelDownloadStep } from './OllamaModelDownloadStep'
import { useWelcomeStore } from '@stores/config-store'
import { Header } from '../common/Header'
import './welcome.css'
import { captureEvent } from '../../lib/posthog'

interface WelcomeWizardProps {
  onComplete?: () => void
}

export function WelcomeWizard({ onComplete }: WelcomeWizardProps) {
  const { currentStep, nextStep, previousStep, modelMode } = useWelcomeStore()

  const { config, getConfigValue, updateConfig } = useSettingsStore()

  // 跟踪步骤变化
  useEffect(() => {
    captureEvent('进入欢迎向导步骤', { 
      step: currentStep, 
      modelMode,
      platform: getConfigValue<string>('AI_PLATFORM')
    })
  }, [currentStep, modelMode])

  // 初始化获取配置
  useEffect(() => {
    // 确保配置是最新的
    if (typeof window.electronAPI?.getConfig === 'function') {
      window.electronAPI!.getConfig().then(cfg => {
        updateConfig(cfg, { internal: true })
      })
    }
  }, [])

  // 检查是否为 Ollama 模式
  const isOllamaMode = () => {
    return getConfigValue<string>('AI_PLATFORM') === 'ollama'
  }

  // 自定义返回处理，处理 Ollama 模式的特殊情况
  const handleBack = () => {
    // 如果是本地 Ollama 模式，从第 4 步（Ollama 模型选择）返回时，
    // 跳过第 3 步（Ollama 安装检测）直接返回到第 2 步（模式选择）
    if (modelMode === 'local' && isOllamaMode() && currentStep === 4) {
      useWelcomeStore.getState().goToStep(2)
      return
    }
    
    previousStep()
  }

  // 渲染当前步骤
  const renderCurrentStep = () => {
    // 步骤 1: 语言选择 (通用)
    if (currentStep === 1) {
      return <WelcomeStep1 onNext={nextStep} />
    }

    // 步骤 2: AI 服务选择 (通用)
    if (currentStep === 2) {
      return <ModelModeSelectionStep onNext={nextStep} onBack={handleBack} />
    }

    // 步骤 3+: 根据模式分流
    
    // 情况 A: 本地模式且为 Ollama 平台
    if (modelMode === 'local' && isOllamaMode()) {
      switch (currentStep) {
        case 3:
          // Ollama 安装检测
          return <OllamaInstallStep onComplete={nextStep} onBack={handleBack} />
        case 4:
          // Ollama 模型选择
          return <OllamaModelSelectionStep onNext={nextStep} onBack={handleBack} />
        case 5:
          // Ollama 模型下载
          return <OllamaModelDownloadStep onNext={nextStep} onBack={handleBack} />
        case 6:
          // 完成
          return <DownloadCompleteStep onFinish={onComplete} />
        default:
          return <WelcomeStep1 onNext={nextStep} />
      }
    }

    // 情况 B: 云端模式 或 本地模式(Llama.cpp)
    switch (currentStep) {
      case 3:
        // 根据选择的模式显示不同的配置页面
        return modelMode === 'local' 
          ? <ModelSelectionStep onNext={nextStep} onBack={handleBack} />
          : <CloudModelConfigStep onNext={nextStep} onBack={handleBack} />
      case 4:
        return <ModelStorageStep onNext={nextStep} onBack={handleBack} />
      case 5:
        return <ModelDownloadStep onNext={nextStep} onBack={handleBack} />
      case 6:
        return <DownloadCompleteStep onFinish={onComplete} />
      default:
        return <WelcomeStep1 onNext={nextStep} />
    }
  }

  return (
    <div className="h-screen w-full flex flex-col">
      <Header />
      <div className="flex-grow overflow-y-auto">{renderCurrentStep()}</div>
    </div>
  )
}