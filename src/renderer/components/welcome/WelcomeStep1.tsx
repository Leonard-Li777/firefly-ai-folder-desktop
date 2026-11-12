import React, { useState, useEffect } from 'react'
import { useVoerkaI18n } from '@voerkai18n/react'
import { Card, CardContent } from '@components/ui/card'
import { Button } from '@components/ui/button'
import { RadioGroup, RadioGroupItem } from '@components/ui/radio-group'
import { type LanguageCode } from '@firefly/types'
import { useSettingsStore } from '@stores/settings-store'
import i18nScope from '@src/languages'
import { WelcomeStepLayout } from './WelcomeStepLayout'
import { SUPPORTED_LANGUAGES, getDefaultLanguage } from '@firefly/shared'

interface WelcomeStep1Props {
  onNext: () => void
}

export function WelcomeStep1({ onNext }: WelcomeStep1Props) {
  const { t, changeLanguage, activeLanguage } = useVoerkaI18n(i18nScope)
  const { getConfigValue, updateConfigValue } = useSettingsStore()
  const [selectedLanguage, setSelectedLanguage] = useState<LanguageCode>(
    () => getConfigValue<LanguageCode>('DEFAULT_LANGUAGE') || getDefaultLanguage()
  )

  // 初始加载时自动将智能选中的默认语言同步给 i18n 试用界面
  useEffect(() => {
    if (selectedLanguage && selectedLanguage !== activeLanguage) {
      changeLanguage(selectedLanguage)
    }
  }, [])

  const handleLanguageChange = async (value: string) => {
    const newLanguage = value as LanguageCode
    setSelectedLanguage(newLanguage)
    // 仅实时切换 UI 试用语言，不提前持久化或创建数据库
    await changeLanguage(newLanguage)
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
    <WelcomeStepLayout
      testId="welcome-step1-container"
      maxWidthClass="max-w-2xl"
      title={t('欢迎使用 - 初始设置')}
      subtitle={t('请选择您偏好的语言以继续')}
      footer={
        <>
          <span />
          <Button
            data-testid="welcome-step1-next-btn"
            onClick={handleNext}
            className="h-10 rounded-lg bg-primary px-6 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
          >
            {t('继续')}
          </Button>
        </>
      }
    >
      <Card className="rounded-xl bg-card shadow-sm ring-1 ring-border p-3 sm:p-4">
        <CardContent className="p-0">
          <RadioGroup
            data-testid="welcome-lang-radiogroup"
            value={selectedLanguage}
            onValueChange={handleLanguageChange}
            className="grid grid-cols-2 sm:grid-cols-3 gap-2"
            role="radiogroup"
            aria-label={t('语言选择')}
          >
            {SUPPORTED_LANGUAGES.map(language => (
              <label
                key={language.code}
                data-testid={`welcome-lang-${language.code}`}
                className={`relative flex items-center justify-between gap-2 rounded-lg p-2.5 cursor-pointer transition-all duration-200 ${
                  selectedLanguage === language.code
                    ? 'border-2 border-primary bg-primary/10'
                    : 'border border-border bg-card hover:border-primary hover:bg-primary/10'
                }`}
              >
                <div className="min-w-0">
                  <span className="block text-sm font-semibold text-foreground truncate">
                    {language.nativeName}
                  </span>
                  <span className="block text-xs text-muted-foreground truncate">{language.name}</span>
                </div>
                <RadioGroupItem value={language.code} className="peer sr-only" />
                {selectedLanguage === language.code ? (
                  <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5 shrink-0 text-white">
                    <circle cx="12" cy="12" r="12" className="fill-primary" />
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
                  <span className="h-5 w-5 rounded-full border border-border shrink-0"></span>
                )}
              </label>
            ))}
          </RadioGroup>
        </CardContent>
      </Card>
    </WelcomeStepLayout>
  )
}

