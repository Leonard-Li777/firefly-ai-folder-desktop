import React, { useState, useEffect } from 'react'
import { useVoerkaI18n } from '@voerkai18n/react'
import i18nScope from '@src/languages'
import { WelcomeStep1 } from './WelcomeStep1'
import { WelcomeStep2PluginSetup } from './WelcomeStep2PluginSetup'
import { WelcomeStep3PluginDir } from './WelcomeStep3PluginDir'
import { WelcomeStep4InstallMethod } from './WelcomeStep4InstallMethod'
import { WelcomeStep5InstallReady } from './WelcomeStep5InstallReady'
import { WelcomeStepper, type WelcomeStepNumber } from './WelcomeStepper'
import {
  DEFAULT_HARDWARE,
  DEFAULT_WELCOME_SELECTION,
  type HardwareProbeResult,
  type WelcomeSelection
} from './welcome-types'
import { useWelcomeStore } from '@stores/config-store'
import { usePluginCenterStore } from '@stores/plugin-center-store'
import { Header } from '../common/Header'
import './welcome.css'
import { captureEvent } from '../../lib/posthog'

interface WelcomeWizardProps {
  // 启动门禁（resolveWelcomeGateState）只会恢复到 1 或 2；
  // 3 / 4 / 5 用于向导内部流转与测试直接落到某一页。
  initialStep?: WelcomeStepNumber
  onComplete?: () => void
}

/**
 * 欢迎向导（5 步：选择与安装彻底拆开）
 *
 * Step 1: 语言选择
 * Step 2: AI 引擎与智能能力装配（只选不装）
 * Step 3: 选择插件安装目录（首次运行目录设定，不迁移、不重启）
 * Step 4: 插件安装方式（在线安装 / 导入离线总包，只选不执行）
 * Step 5: 安装与就绪（按 Step 4 的方式分两种展示态：在线下载进度 / 离线选包按钮）
 *
 * 「插件怎么装」放在「装到哪里」之后，用户先确定要什么插件、装到哪个文件夹，
 * 最后才决定从哪里拿插件，紧接着进入安装页；选错方式也能直接退回本步更改。
 * 所有跨步骤选择提升到本容器共享状态，步骤组件卸载不丢失；
 * LANGUAGE_CONFIRMED / IS_FIRST_RUN 只在最终按钮点击时落地。
 */
export function WelcomeWizard({ initialStep = 1, onComplete }: WelcomeWizardProps) {
  const { t, activeLanguage } = useVoerkaI18n(i18nScope)
  const [currentStep, setCurrentStep] = useState<WelcomeStepNumber>(initialStep)

  // 跨步骤共享选择结果
  const [selection, setSelection] = useState<WelcomeSelection>(DEFAULT_WELCOME_SELECTION)
  const [hardware, setHardware] = useState<HardwareProbeResult>(DEFAULT_HARDWARE)
  const [isDetectingHw, setIsDetectingHw] = useState(true)
  const [pluginDir, setPluginDir] = useState<string | null>(null)
  // 主引擎已就绪：从 Step 5 返回再进来时恢复完成态，不重复下载
  const [installCompleted, setInstallCompleted] = useState(false)

  useEffect(() => {
    setCurrentStep(initialStep)
  }, [initialStep])

  // 硬件探测与自适应推荐只在向导容器挂载时执行一次；
  // 之后用户在步骤间来回切换，已做过的选择不会被重新覆盖。
  useEffect(() => {
    let isMounted = true
    const probeHardware = async () => {
      try {
        const electron = (window as any).electronAPI
        let res: any = null
        if (electron?.detectSystemResources) {
          res = await electron.detectSystemResources()
        } else if (electron?.getHardwareInfo) {
          const info = await electron.getHardwareInfo()
          res = {
            totalMemGB: info?.memory?.totalGB || 8,
            totalMemMB: (info?.memory?.totalGB || 8) * 1024,
            gpuName: info?.gpu?.name || '',
            vramGB: info?.gpu?.vramGB || 0,
            isGpuSupported: Boolean(info?.gpu?.vramGB > 0),
            storageFreeGB: 20
          }
        }

        if (isMounted && res) {
          const hw: HardwareProbeResult = {
            totalMemGB: res.totalMemGB || 8,
            totalMemMB: res.totalMemMB || 8192,
            gpuName: res.gpuName || 'Generic GPU',
            vramGB: res.vramGB || 0,
            isGpuSupported: Boolean(res.isGpuSupported),
            storageFreeGB: res.storageFreeGB !== undefined ? res.storageFreeGB : 20
          }
          setHardware(hw)

          const targetEngine = hw.totalMemGB < 8 ? 'engine_classic_light' : 'engine_gemma_unified'
          const targetGenMode =
            !hw.isGpuSupported || hw.vramGB < 4 || hw.totalMemGB <= 16 ? 'cpu' : 'local'

          setSelection(prev => ({
            ...prev,
            selectedEngine: targetEngine,
            generativeEngineMode: targetGenMode,
            selectedOptionals: {
              ...prev.selectedOptionals,
              perception_nsfw: true,
              asr_sensevoice_onnx: hw.totalMemGB >= 16 && hw.isGpuSupported,
              // 离线语音朗读恒为单一插件，不随硬件档位切换
              tts_m5_onnx: true
            }
          }))
        }
      } catch (err) {
        console.warn('[Welcome] 硬件探测异常，采用标准默认推荐:', err)
      } finally {
        if (isMounted) setIsDetectingHw(false)
      }
    }

    probeHardware()

    // 挂载时主动拉取主进程当前生效的插件目录，确保 Step 5 顶部摘要权威展示用户配置的实际目录
    void usePluginCenterStore
      .getState()
      .loadDirInfo()
      .then(info => {
        const activePath = info?.currentPath || info?.currentDir
        if (isMounted && activePath) {
          setPluginDir(activePath)
        }
      })
      .catch(() => {})

    return () => {
      isMounted = false
    }
  }, [])

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

  const handleSelectionChange = (patch: Partial<WelcomeSelection>) => {
    setSelection(prev => ({ ...prev, ...patch }))
  }

  // 只有最终按钮点击才真正落地 LANGUAGE_CONFIRMED / IS_FIRST_RUN
  const handleFinish = async () => {
    await useWelcomeStore.getState().completeSetup()
    onComplete?.()
  }

  return (
    <div
      data-testid="welcome-wizard-container"
      className="h-dvh w-full flex flex-col overflow-hidden bg-gradient-to-b from-background to-primary/5"
    >
      <Header />
      <WelcomeStepper currentStep={currentStep} />
      <div className="flex-1 min-h-0 overflow-hidden">
        {currentStep === 1 && <WelcomeStep1 onNext={() => setCurrentStep(2)} />}
        {currentStep === 2 && (
          <WelcomeStep2PluginSetup
            selection={selection}
            hardware={hardware}
            isDetectingHw={isDetectingHw}
            onChange={handleSelectionChange}
            onBack={() => setCurrentStep(1)}
            onNext={() => setCurrentStep(3)}
          />
        )}
        {currentStep === 3 && (
          <WelcomeStep3PluginDir
            initialAppliedPath={pluginDir}
            onDirApplied={setPluginDir}
            onBack={() => setCurrentStep(2)}
            onNext={() => setCurrentStep(4)}
          />
        )}
        {currentStep === 4 && (
          <WelcomeStep4InstallMethod
            value={selection.installMethod}
            onChange={installMethod => handleSelectionChange({ installMethod })}
            onBack={() => setCurrentStep(3)}
            onNext={() => setCurrentStep(5)}
          />
        )}
        {currentStep === 5 && (
          <WelcomeStep5InstallReady
            selection={selection}
            hardware={hardware}
            pluginDir={pluginDir}
            initialReady={installCompleted}
            onReady={() => setInstallCompleted(true)}
            onBack={() => setCurrentStep(4)}
            onFinish={handleFinish}
          />
        )}
      </div>
    </div>
  )
}
