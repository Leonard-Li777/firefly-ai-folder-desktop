import React, { useEffect } from 'react'
import { useSettingsStore } from '@stores/settings-store'
import { useVoerkaI18n } from '@voerkai18n/react'
import i18nScope from '@src/languages'
import { WelcomeStep1 } from './WelcomeStep1'
import { ModelSelectionStep } from './ModelSelectionStep'
import { CloudModelConfigStep } from './CloudModelConfigStep'
import { DownloadCompleteStep } from './DownloadCompleteStep'
import { ModelStorageStep } from './ModelStorageStep'
import { OllamaInstallStep } from './OllamaInstallStep'
import { OllamaModelSelectionStep } from './OllamaModelSelectionStep'
import { useWelcomeStore } from '@stores/config-store'
import { Header } from '../common/Header'
import './welcome.css'
import { captureEvent } from '../../lib/posthog'
import { validateModelPath } from '@firefly/shared'

interface WelcomeWizardProps {
  onComplete?: () => void
}

export function WelcomeWizard({ onComplete }: WelcomeWizardProps) {
  const { t, activeLanguage } = useVoerkaI18n(i18nScope)
  const { currentStep, nextStep, previousStep, modelMode } = useWelcomeStore()

  const { config, getConfigValue, updateConfig, updateConfigValue } = useSettingsStore()

  // 设置窗口标题栏显示版本号
  useEffect(() => {
    const appName = t('萤核智能文件夹')
    document.title = `${appName} v${__APP_VERSION__}`
  }, [activeLanguage, t])

  // 跟踪步骤变化
  useEffect(() => {
    captureEvent('进入欢迎向导步骤', {
      step: currentStep,
      modelMode,
      engine: getConfigValue<string>('AI_ENGINE')
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

  // 自动跳转逻辑：如果是 llama.cpp 或 llamafile，跳过第 2 步模型选择
  useEffect(() => {
    const engine = getConfigValue<string>('AI_ENGINE')
    if (
      currentStep === 2 &&
      modelMode === 'local' &&
      (engine === 'llama.cpp' || engine === 'llamafile')
    ) {
      console.log(`[WelcomeWizard] 检测到 ${engine} 引擎，自动从步骤 2 跳转到步骤 3`)
      useWelcomeStore.getState().goToStep(3)
    }
  }, [currentStep, modelMode, getConfigValue])

  // 检查是否为 Ollama 模式
  const isOllamaMode = () => {
    return getConfigValue<string>('AI_ENGINE') === 'ollama'
  }

  // 自定义返回处理
  const handleBack = () => {
    // 1. 如果是本地 Ollama 模式，从第 3 步（Ollama 模型选择）返回时，跳过第 2 步（Ollama 安装检测）
    if (modelMode === 'local' && isOllamaMode() && currentStep === 3) {
      useWelcomeStore.getState().goToStep(2)
      return
    }

    // 2. 如果是 llama.cpp 或 llamafile 模式，从第 3 步（目录设置）返回时，跳到第 1 步（语言选择）
    const engine = getConfigValue<string>('AI_ENGINE')
    if (
      modelMode === 'local' &&
      (engine === 'llama.cpp' || engine === 'llamafile') &&
      currentStep === 3
    ) {
      useWelcomeStore.getState().goToStep(1)
      return
    }

    previousStep()
  }

  // 切换到云端模式
  const switchToCloudMode = async () => {
    await updateConfigValue('AI_SERVICE_MODE', 'cloud')
    await updateConfigValue('AI_ENGINE', 'cloud')
    useWelcomeStore.getState().setModelMode('cloud')
    useWelcomeStore.getState().goToStep(2)
  }

  // 渲染当前步骤
  const renderCurrentStep = () => {
    // 步骤 1: 语言选择 (通用)
    if (currentStep === 1) {
      return (
        <WelcomeStep1
          onNext={async () => {
            // 语言选择后，检测模型保存路径是否合法
            const modelPath = getConfigValue<string>('MODEL_STORAGE_PATH') || ''
            const engine = getConfigValue<string>('AI_ENGINE')
            const isLocalModel = engine === 'llama.cpp' || engine === 'llamafile'

            if (isLocalModel && modelPath && !validateModelPath(modelPath).isValid) {
              // 模型路径不合法，跳转到模型路径设置步骤
              useWelcomeStore.getState().goToStep(3)
              return
            }

            await useWelcomeStore.getState().completeSetup()
            onComplete?.()
          }}
        />
      )
    }

    // 步骤 2+: 根据平台分流处理

    // A. 如果是 Ollama 平台，需要先进行环境检测
    if (modelMode === 'local' && isOllamaMode()) {
      switch (currentStep) {
        case 2:
          return (
            <OllamaInstallStep
              onComplete={nextStep}
              onBack={handleBack}
              onSwitchToCloud={switchToCloudMode}
            />
          )
        case 3:
          return <OllamaModelSelectionStep onNext={nextStep} onBack={handleBack} />
        case 4:
          return <DownloadCompleteStep onFinish={onComplete} />
        default:
          return <WelcomeStep1 onNext={nextStep} />
      }
    }

    // B. 如果是 llama.cpp 平台 或 云端模式
    switch (currentStep) {
      case 2:
        // llama.cpp 的跳转已在 useEffect 中处理，
        // 此处 case 2 仅处理云端配置或非 llama.cpp 的本地模型选择
        return modelMode === 'local' ? (
          <ModelSelectionStep onNext={nextStep} onBack={handleBack} />
        ) : (
          <CloudModelConfigStep onNext={nextStep} onBack={handleBack} />
        )
      case 3:
        // llama.cpp 需要配置存储路径，云端直接进入完成
        return modelMode === 'local' ? (
          <ModelStorageStep onNext={nextStep} onBack={handleBack} />
        ) : (
          <DownloadCompleteStep onFinish={onComplete} />
        )
      case 4:
        return <DownloadCompleteStep onFinish={onComplete} />
      default:
        return <WelcomeStep1 onNext={nextStep} />
    }
  }

  return (
    <div className="h-screen w-full flex flex-col overflow-hidden bg-slate-50">
      <Header />
      <div className="flex-grow overflow-hidden">{renderCurrentStep()}</div>
    </div>
  )
}
