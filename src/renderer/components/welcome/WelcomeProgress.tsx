import React from 'react'
import { useVoerkaI18n } from '@voerkai18n/react'
import i18nScope, { t } from '@app/languages'
import { useWelcomeStore } from '@stores/config-store'
import { useSettingsStore } from '@stores/settings-store'

interface WelcomeProgressProps {
  currentStep: number
}

// 步骤定义
const STEPS = {
  LANGUAGE: { id: 'language', name: t('语言选择') },
  MODE: { id: 'mode', name: t('模式选择') },
  MODEL_LOCAL: { id: 'model_local', name: t('模型配置') },
  MODEL_CLOUD: { id: 'model_cloud', name: t('云端配置') },
  STORAGE: { id: 'storage', name: t('模型存储目录') },
  DOWNLOAD: { id: 'download', name: t('资源下载') },
  COMPLETE: { id: 'complete', name: t('设置完成') },
  OLLAMA_INSTALL: { id: 'ollama_install', name: t('安装AI引擎') },
  OLLAMA_MODEL: { id: 'ollama_model', name: t('模型选择') },
  OLLAMA_DOWNLOAD: { id: 'ollama_download', name: t('模型下载') },
  OLLAMA_COMPLETE: { id: 'ollama_complete', name: t('下载完成') }
}

export function WelcomeProgress({ currentStep }: WelcomeProgressProps) {
  const { t } = useVoerkaI18n(i18nScope)
  const { modelMode } = useWelcomeStore()
  const { getConfigValue } = useSettingsStore()
  const isOllama = getConfigValue<string>('AI_PLATFORM') === 'ollama'

  // 根据模型模式生成步骤序列
  let steps = modelMode === 'local' 
    ? [STEPS.LANGUAGE, STEPS.MODE, STEPS.MODEL_LOCAL, STEPS.STORAGE, STEPS.DOWNLOAD, STEPS.COMPLETE]
    : [STEPS.LANGUAGE, STEPS.MODE, STEPS.MODEL_CLOUD, STEPS.COMPLETE]

  if (isOllama && modelMode === 'local') {
    steps = [
      STEPS.LANGUAGE, 
      STEPS.MODE, 
      STEPS.OLLAMA_INSTALL, 
      STEPS.OLLAMA_MODEL, 
      STEPS.OLLAMA_DOWNLOAD, 
      STEPS.OLLAMA_COMPLETE
    ]
  }

  // 计算当前步骤在显示序列中的索引
  let activeIndex = 0
  
  if (isOllama && modelMode === 'local') {
    // Ollama 模式映射: 1->0, 2->1, 3->2, 4->3, 5->4, 6->5
    activeIndex = currentStep - 1
  } else if (modelMode === 'local') {
    activeIndex = currentStep - 1
  } else {
    // 云端模式映射: 1->0, 2->1, 3->2, 6->3
    if (currentStep === 1) activeIndex = 0
    else if (currentStep === 2) activeIndex = 1
    else if (currentStep === 3) activeIndex = 2
    else if (currentStep === 6) activeIndex = 3
  }

  return (
    <div className="flex-shrink-0 py-8 sticky top-0 z-10 bg-slate-50">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        <nav aria-label="Progress">
          <ol className="flex items-center justify-center gap-2 sm:gap-4">
            {steps.map((step, index) => {
              const isCurrent = index === activeIndex
              const isCompleted = index < activeIndex

              return (
                <React.Fragment key={step.id}>
                  <li className="flex items-center gap-2 min-w-0" aria-current={isCurrent ? 'step' : undefined}>
                    <span
                      className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
                        isCurrent
                          ? 'bg-sky-600 text-white'
                          : isCompleted
                            ? 'bg-sky-100 text-sky-800'
                            : 'bg-slate-200 text-slate-600'
                      }`}
                    >
                      {index + 1}
                    </span>
                    <span
                      className={`hidden sm:inline text-sm font-medium whitespace-nowrap overflow-hidden text-ellipsis ${
                        isCurrent
                          ? 'text-slate-900'
                          : isCompleted
                            ? 'text-slate-700'
                            : 'text-slate-600 opacity-70'
                      }`}
                      style={{ maxWidth: '140px' }}
                    >
                      {t(step.name)}
                    </span>
                  </li>
                  {index < steps.length - 1 && (
                    <span className="h-px w-4 flex-shrink-0 bg-slate-200" aria-hidden="true"></span>
                  )}
                </React.Fragment>
              )
            })}
          </ol>
        </nav>
      </div>
    </div>
  )
}
