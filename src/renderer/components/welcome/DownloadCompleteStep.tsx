import React from 'react'
import { useVoerkaI18n } from '@voerkai18n/react'
import { Card, CardContent } from '@components/ui/card'
import { Button } from '@components/ui/button'
import { useWelcomeStore } from '@stores/config-store'
import { useSettingsStore } from '@stores/settings-store'
import i18nScope from '@src/languages'
import { WelcomeProgress } from './WelcomeProgress'
import { Info } from 'lucide-react'

interface DownloadCompleteStepProps {
  onFinish?: () => void
}

export function DownloadCompleteStep({ onFinish }: DownloadCompleteStepProps) {
  const { t } = useVoerkaI18n(i18nScope)
  const { completeSetup } = useWelcomeStore()
  const { getConfigValue } = useSettingsStore()
  const aiEngine = getConfigValue<string>('AI_ENGINE')

  const handleStart = async () => {
    console.log('点击开始使用，完成设置...')
    await completeSetup()
    
    // 增加一个小延迟，确保配置同步完成
    console.log('设置完成逻辑执行完毕，等待同步...')
    await new Promise(resolve => setTimeout(resolve, 500))
    
    console.log('触发 onFinish...')
    onFinish?.()
  }

  return (
    <div className="xbg-slate-50 text-slate-900 flex flex-col">
      <WelcomeProgress currentStep={6} />

      <div className="flex-grow overflow-auto">
        <div className="w-full max-w-5xl px-4 sm:px-6 lg:px-8 py-10 mx-auto">
          <section className="mx-auto max-w-3xl">
            <Card className="rounded-xl bg-white shadow-sm ring-1 ring-slate-200 p-6">
              <CardContent className="p-0">
                <div className="text-center py-8">
                  <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
                    <svg className="h-8 w-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <h2 className="mt-4 text-2xl font-bold text-slate-900">{t('设置成功！')}</h2>
                  <p className="mt-2 text-slate-600 mb-6">{t('您已成功完成所有初始设置步骤。现在可以开始使用应用程序了。')}</p>

                  {/* llama.cpp 平台的特别提示 */}
                  {aiEngine === 'llama.cpp' && (
                    <div className="max-w-md mx-auto mb-8 p-4 bg-sky-50 border border-sky-100 rounded-xl flex items-start gap-3 text-left animate-in slide-in-from-bottom-2 duration-500">
                      <Info className="h-5 w-5 text-sky-500 shrink-0 mt-0.5" />
                      <p className="text-sm text-sky-800 leading-relaxed">
                        {t('已安装 Qwen3.5-0.8B 轻量模型。为了获得最佳的文件整理效果，你可以随时在“设置”页面切换到更强大的模型。')}
                      </p>
                    </div>
                  )}

                  <div className="">
                    <div className="flex justify-center">
                      <Button
                        onClick={handleStart}
                        className="h-12 rounded-lg bg-slate-900 px-8 text-base font-semibold text-white hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-slate-900"
                      >
                        {t('开始使用')}
                      </Button>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </section>
        </div>
      </div>
    </div>
  )
}
