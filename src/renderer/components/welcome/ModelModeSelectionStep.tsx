import React from 'react'
import { useVoerkaI18n } from '@voerkai18n/react'
import { Card, CardContent } from '@components/ui/card'
import { Button } from '@components/ui/button'
import { useWelcomeStore } from '@stores/config-store'
import { useSettingsStore } from '@stores/settings-store'
import i18nScope from '@src/languages'
import { WelcomeProgress } from './WelcomeProgress'
import { ShieldCheck, Cloud, Cpu, Lock, Zap, CreditCard } from 'lucide-react'

interface ModelModeSelectionStepProps {
  onNext: () => void
  onBack: () => void
}

export function ModelModeSelectionStep({ onNext, onBack }: ModelModeSelectionStepProps) {
  const { t } = useVoerkaI18n(i18nScope)
  const { modelMode, setModelMode } = useWelcomeStore()
  const { getConfigValue } = useSettingsStore()
  const aiPlatform = getConfigValue<string>('AI_PLATFORM')
  const isOllama = aiPlatform === 'ollama'

  const handleSelectMode = (mode: 'local' | 'cloud') => {
    // 设置模型模式
    setModelMode(mode)
    // 不在这里调用 onNext()，让用户点击"继续"按钮来进行下一步
    // 这样可以避免用户返回后自动进入下一步的问题
  }

  return (
    <div className="flex flex-col h-full">
      <WelcomeProgress currentStep={2} />

      <div className="flex-grow overflow-auto py-10">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <header className="text-center mb-12">
            <h1 className="text-3xl font-bold tracking-tight text-slate-900">{t('选择运行模式')}</h1>
            <p className="mt-4 text-lg text-slate-600 max-w-2xl mx-auto">
              {t('您可以根据隐私需求和硬件性能，选择使用本地离线模型或云端在线服务')}
            </p>
          </header>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {/* 本地模式卡片 */}
            <Card 
              className={`relative cursor-pointer transition-all duration-300 border-2 overflow-hidden ${
                modelMode === 'local' 
                ? 'border-sky-500 ring-2 ring-sky-500/20 bg-sky-50/30' 
                : 'border-slate-200 hover:border-slate-300 bg-white shadow-sm'
              }`}
              onClick={() => handleSelectMode('local')}
            >
              <CardContent className="p-8">
                <div className={`mb-6 inline-flex h-12 w-12 items-center justify-center rounded-xl ${modelMode === 'local' ? 'bg-sky-500 text-white' : 'bg-slate-100 text-slate-600'}`}>
                  <Cpu className="h-6 w-6" />
                </div>
                <h3 className="text-xl font-bold text-slate-900 mb-4">{t('本地模式')}</h3>
                
                <ul className="space-y-4 text-sm text-slate-600">
                  <li className="flex items-start gap-3">
                    <ShieldCheck className="h-5 w-5 text-green-500 mt-0.5 shrink-0" />
                    <span>{t('使用本地模型分析数据，不会喂给云端大模型进行数据训练，充分保证数据安全性和隐私性')}</span>
                  </li>
                  <li className="flex items-start gap-3">
                    <Lock className="h-5 w-5 text-green-500 mt-0.5 shrink-0" />
                    <span>{t('完全离线运行，无需网络连接')}</span>
                  </li>
                  <li className="flex items-start gap-3">
                    <Zap className="h-5 w-5 text-amber-500 mt-0.5 shrink-0" />
                    <span>{t('依赖本地硬件，建议具有高性能 GPU 显卡')}</span>
                  </li>
                </ul>
              </CardContent>
              {modelMode === 'local' && (
                <div className="absolute top-4 right-4 h-6 w-6 bg-sky-500 rounded-full flex items-center justify-center">
                  <svg className="h-4 w-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
              )}
            </Card>

            {/* 云端模式卡片 */}
            <Card 
              className={`relative cursor-pointer transition-all duration-300 border-2 overflow-hidden ${
                modelMode === 'cloud' 
                ? 'border-sky-500 ring-2 ring-sky-500/20 bg-sky-50/30' 
                : 'border-slate-200 hover:border-slate-300 bg-white shadow-sm'
              }`}
              onClick={() => handleSelectMode('cloud')}
            >
              <CardContent className="p-8">
                <div className={`mb-6 inline-flex h-12 w-12 items-center justify-center rounded-xl ${modelMode === 'cloud' ? 'bg-sky-500 text-white' : 'bg-slate-100 text-slate-600'}`}>
                  <Cloud className="h-6 w-6" />
                </div>
                <h3 className="text-xl font-bold text-slate-900 mb-4">{t('云端AI服务')}</h3>
                
                <ul className="space-y-4 text-sm text-slate-600">
                  <li className="flex items-start gap-3">
                    <Zap className="h-5 w-5 text-sky-500 mt-0.5 shrink-0" />
                    <span>{t('支持分析大文件，响应快速，分析更加准确智能')}</span>
                  </li>
                  <li className="flex items-start gap-3">
                    <CreditCard className="h-5 w-5 text-sky-500 mt-0.5 shrink-0" />
                    <span>{t('部分服务商模型需要收费')}</span>
                  </li>
                  <li className="flex items-start gap-3">
                    <ShieldCheck className="h-5 w-5 text-rose-500 mt-0.5 shrink-0 opacity-70" />
                    <span>{t('需要上传数据至云端，无法保证绝对的数据隐私性')}</span>
                  </li>
                </ul>
              </CardContent>
              {modelMode === 'cloud' && (
                <div className="absolute top-4 right-4 h-6 w-6 bg-sky-500 rounded-full flex items-center justify-center">
                  <svg className="h-4 w-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
              )}
            </Card>
          </div>
        </div>
      </div>

      <div className="flex-shrink-0 bg-slate-50 py-4 border-t border-slate-200">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between">
            <Button variant="outline" onClick={onBack} className="h-11 rounded-xl px-6 font-semibold">
              {t('返回')}
            </Button>
            <Button 
              variant="default" 
              onClick={onNext} 
              className="h-11 rounded-xl bg-slate-900 px-10 font-semibold text-white hover:bg-slate-800"
            >
              {t('继续')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
