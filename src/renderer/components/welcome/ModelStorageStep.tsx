import React, { useEffect, useState } from 'react'
import { useVoerkaI18n } from '@voerkai18n/react'
import { Card, CardContent } from '@components/ui/card'
import { Button } from '@components/ui/button'
import { Input } from '@components/ui/input'
import { useSettingsStore } from '@stores/settings-store'
import i18nScope from '@src/languages'
import { WelcomeProgress } from './WelcomeProgress'

interface ModelStorageStepProps {
  onNext: () => void
  onBack: () => void
}

export function ModelStorageStep({ onNext, onBack }: ModelStorageStepProps) {
  const { t } = useVoerkaI18n(i18nScope)
  const { getConfigValue, updateConfigValue } = useSettingsStore()
  const [storagePath, setStoragePath] = useState(() => getConfigValue<string>('MODEL_STORAGE_PATH') || '')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const syncLatestPath = async () => {
      try {
        const config = await window.electronAPI!.getConfig()
        if (!storagePath && config.modelPath) {
          setStoragePath(config.modelPath)
        }
      } catch (err) {
        console.warn('刷新模型存储路径失败:', err)
      }
    }

    syncLatestPath()
    // 仅在初始化时同步一次默认路径
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleBrowseDirectory = async () => {
    try {
      const result = await window.electronAPI!.utils.showOpenDialog({
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: storagePath || undefined,
      })

      if (!result.canceled && result.filePaths.length > 0) {
        setStoragePath(result.filePaths[0])
        setError(null)
      }
    } catch (err) {
      console.error('选择模型目录失败:', err)
      setError(t("请选择有效的模型存储目录。"))
    }
  }

  const handleNext = async () => {
    const trimmedPath = storagePath.trim()
    if (!trimmedPath) {
      setError(t("请选择有效的模型存储目录。"))
      return
    }

    try {
      await updateConfigValue('MODEL_STORAGE_PATH', trimmedPath)
      setError(null)
      onNext()
    } catch (err) {
      console.error('保存模型目录失败:', err)
      setError(t("请选择有效的模型存储目录。"))
    }
  }

  return (
    <div className="xbg-slate-50 text-slate-900 flex flex-col">
      <WelcomeProgress currentStep={4} />

      <div className="flex-grow overflow-hidden">
        <div className="h-full flex flex-col">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-10 flex-grow overflow-auto">
            <header className="mb-6">
              <h1 className="text-2xl font-bold tracking-tight">{t("选择模型存储目录")}</h1>
              <p className="mt-2 text-slate-600">{t("建议使用剩余空间充足且读写稳定的磁盘目录，以保证模型加载速度。")}</p>
            </header>

            <Card className="rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
              <CardContent className="p-6 space-y-6">
                <div>
                  <label className="text-sm font-medium text-slate-700 block mb-2">
                    {t("模型存储路径")}
                  </label>
                  <div className="flex gap-3">
                    <Input
                      value={storagePath}
                      onChange={event => {
                        setStoragePath(event.target.value)
                        setError(null)
                      }}
                      placeholder={t("例如 D:\\AI-Models")}
                    />
                    <Button variant="outline" className="text-slate-900" onClick={handleBrowseDirectory}>
                      {t("浏览")}
                    </Button>
                  </div>
                  <p className="text-xs text-slate-500 mt-2">{t("模型文件体积较大，继续之前请确认该磁盘拥有足够的可用空间。")}</p>
                  {error && <p className="text-sm text-red-500 mt-1">{error}</p>}
                </div>

                <div className="rounded-lg bg-slate-50 border border-slate-200 p-4">
                  <h2 className="text-sm font-semibold text-slate-900 mb-2">{t("存储建议")}</h2>
                  <ul className="text-sm text-slate-600 list-disc pl-5 space-y-1">
                    <li>{t("不同模型可能占用 2-8GB 甚至更多空间。")}</li>
                    <li>{t("优先选择 SSD，可显著提升模型加载与推理速度。")}</li>
                  </ul>
                </div>

                <div className="flex justify-between">
                  <Button variant="outline" className="text-slate-900" onClick={onBack}>
                    {t("返回")}
                  </Button>
                  <Button onClick={handleNext} className="bg-slate-900 text-white hover:bg-slate-800">
                    {t("继续")}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}
