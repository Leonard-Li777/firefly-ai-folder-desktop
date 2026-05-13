import React, { useState } from 'react'
import { useVoerkaI18n } from '@voerkai18n/react'
import { Card, CardContent } from '@components/ui/card'
import { Button } from '@components/ui/button'
import { RadioGroup, RadioGroupItem } from '@components/ui/radio-group'
import { type LanguageCode } from '@yonuc/types'
import { useSettingsStore } from '@stores/settings-store'
import i18nScope from '@src/languages'
import { WelcomeProgress } from './WelcomeProgress'
import { SUPPORTED_LANGUAGES } from '@yonuc/shared'

interface WelcomeStep1Props {
  onNext: () => void
}

export function WelcomeStep1({ onNext }: WelcomeStep1Props) {
  const { t, changeLanguage, activeLanguage } = useVoerkaI18n(i18nScope)
  const { getConfigValue, updateConfigValue } = useSettingsStore()
  const [selectedLanguage, setSelectedLanguage] = useState<LanguageCode>(
    () => getConfigValue<LanguageCode>('DEFAULT_LANGUAGE') || 'en-US'
  )

  const handleLanguageChange = async (value: string) => {
    const newLanguage = value as LanguageCode
    setSelectedLanguage(newLanguage)
    // 实时切换语言
    await changeLanguage(newLanguage)
    // 使用统一配置系统更新语言设置
    updateConfigValue('DEFAULT_LANGUAGE', newLanguage)
  }

  const handleNext = async () => {
    try {
      // 1. 先更新语言
      await updateConfigValue('DEFAULT_LANGUAGE', selectedLanguage)

      // 2. 再更新确认状态（使用 updateConfigValue 更可靠，避免批量更新冲突）
      await updateConfigValue('LANGUAGE_CONFIRMED', true)

      onNext()
    } catch (error) {
      console.error('保存语言设置失败:', error)
    }
  }

  return (
    <div className="xbg-slate-50 text-slate-900 flex flex-col">
      <WelcomeProgress currentStep={1} />

      {/* 主要内容区域 */}
      <div className="flex-grow overflow-auto">
        <div className="w-full max-w-5xl px-4 py-4 mx-auto">
          <section className="mx-auto max-w-2xl">
            <header className="text-center mb-4">
              <h1 className="text-xl font-bold tracking-tight">{t('欢迎使用 - 初始设置')}</h1>
              <p className="mt-1 text-sm text-slate-600">{t('请选择您偏好的语言以继续')}</p>
            </header>

            <Card className="rounded-lg bg-white shadow-sm ring-1 ring-slate-200 p-4">
              <CardContent className="p-0">
                <RadioGroup
                  value={selectedLanguage}
                  onValueChange={handleLanguageChange}
                  className="grid grid-cols-2 sm:grid-cols-3 gap-2"
                  role="radiogroup"
                  aria-label={t('语言选择')}
                >
                  {SUPPORTED_LANGUAGES.map(language => (
                    <label
                      key={language.code}
                      className={`relative flex items-center justify-between gap-2 rounded-md p-2 cursor-pointer transition-all duration-200 ${
                        selectedLanguage === language.code
                          ? 'border-2 border-sky-500 bg-sky-50'
                          : 'border border-slate-200 bg-white hover:border-sky-500 hover:bg-sky-50/50'
                      }`}
                    >
                      <div className="min-w-0">
                        <span className="block text-sm font-semibold text-slate-900 truncate">
                          {language.nativeName}
                        </span>
                        <span className="block text-xs text-slate-500 truncate">
                          {language.name}
                        </span>
                      </div>
                      <RadioGroupItem value={language.code} className="peer sr-only" />
                      {selectedLanguage === language.code ? (
                        <svg
                          aria-hidden="true"
                          viewBox="0 0 24 24"
                          className="h-5 w-5 shrink-0 text-white"
                        >
                          <circle cx="12" cy="12" r="12" className="fill-sky-500" />
                          <path
                            d="M7 13l3 3 7-7"
                            stroke="white"
                            strokeWidth="2"
                            fill="none"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      ) : (
                        <span className="h-5 w-5 rounded-full border border-slate-300 shrink-0"></span>
                      )}
                    </label>
                  ))}
                </RadioGroup>

                <div className="mt-4 flex items-center justify-end">
                  <Button
                    onClick={handleNext}
                    className="h-9 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-800"
                  >
                    {t('继续')}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </section>
        </div>
      </div>
    </div>
  )
}
