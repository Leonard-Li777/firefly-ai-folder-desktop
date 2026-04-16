import React from 'react'
import { useVoerkaI18n } from '@voerkai18n/react'
import { Card, CardContent } from '@components/ui/card'
import { Button } from '@components/ui/button'
import { useWelcomeStore } from '@stores/config-store'
import i18nScope from '@src/languages'
import { WelcomeProgress } from './WelcomeProgress'

interface DownloadCompleteStepProps {
  onFinish?: () => void
}

export function DownloadCompleteStep({ onFinish }: DownloadCompleteStepProps) {
  const { t } = useVoerkaI18n(i18nScope)
  const { completeSetup } = useWelcomeStore()

  const handleStart = async () => {
    console.log('点击开始使用，完成设置...')
    await completeSetup()
    console.log('设置完成逻辑执行完毕，触发 onFinish...')
    onFinish?.()
  }

  return (
    <div className="xbg-slate-50 text-slate-900 flex flex-col">
      <WelcomeProgress currentStep={6} />

      <div className="flex-grow overflow-auto">
        <div className="w-full max-w-5xl px-4 sm:px-6 lg:px-8 py-10 mx-auto">
          <section className="mx-auto max-w-3xl">
            <header className="text-center mb-8">
              <h1 className="text-3xl font-bold tracking-tight">{t('设置完成')}</h1>
              <p className="mt-2 text-slate-600">{t('您已成功完成初始设置')}</p>
            </header>

            <Card className="rounded-xl bg-white shadow-sm ring-1 ring-slate-200 p-6">
              <CardContent className="p-0">
                <div className="text-center py-8">
                  <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
                    <svg className="h-8 w-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <h2 className="mt-4 text-2xl font-bold text-slate-900">{t('设置成功！')}</h2>
                  <p className="mt-2 text-slate-600">{t('您已成功完成所有初始设置步骤。现在可以开始使用应用程序了。')}</p>

                  <div className="mt-8">
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
