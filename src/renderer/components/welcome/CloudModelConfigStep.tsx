import { Check, ChevronDown, Loader2 } from 'lucide-react'
import type { CloudModelConfig, ProviderModel } from '@firefly/types'
import { LogCategory, logger } from '@firefly/shared'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'

import { Button } from '../ui/button'
import { Card } from '../ui/card'
import CloudModelConfigAPI from '../../api/cloud-model-config-api'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { WelcomeProgress } from './WelcomeProgress'
import { openExternalLink } from '../../lib/external-link'
import { t } from '@app/languages'
import { toast } from '../common/Toast'
import { useSettingsStore } from '../../stores/settings-store'
import { useCloudModelConfigStore } from '../../stores/cloud-model-config-store'

interface CloudModelConfigStepProps {
  onNext: () => void
  onBack: () => void
}

type ProviderPresetModel = {
  id: string
  name: string
  description?: string
  isMultiModal?: boolean
  free?: boolean
  capabilities?: ({ type: string } | string)[]
}

type ProviderPreset = {
  id: string
  name: string
  baseUrl?: string
  free?: boolean
  description?: string
  registerUrl?: string
  models?: ProviderPresetModel[]
}

const CREDENTIALS_KEY = 'firefly_cloud_credentials'

function getSavedCredentials(): Record<string, { apiKey: string; baseUrl: string; model: string }> {
  try {
    const data = localStorage.getItem(CREDENTIALS_KEY)
    return data ? JSON.parse(data) : {}
  } catch {
    return {}
  }
}

function saveCredentials(
  provider: string,
  creds: { apiKey: string; baseUrl: string; model: string }
) {
  try {
    const all = getSavedCredentials()
    all[provider] = creds
    localStorage.setItem(CREDENTIALS_KEY, JSON.stringify(all))
  } catch (error) {
    console.error('Failed to save credentials to localStorage', error)
  }
}

export function CloudModelConfigStep({ onNext, onBack }: CloudModelConfigStepProps) {
  const { config, updateConfigValue } = useSettingsStore()
  const language = config?.language || 'zh-CN'

  const [draft, setDraft] = useState<CloudModelConfig>({
    provider: '',
    apiKey: '',
    baseUrl: '',
    model: ''
  })

  const [isLoadingPresets, setIsLoadingPresets] = useState(true)
  const [isTesting, setIsTesting] = useState(false)
  const [isModelListOpen, setIsModelListOpen] = useState(false)
  const [availableModels, setAvailableModels] = useState<
    Array<ProviderPresetModel | ProviderModel>
  >([])
  const [isTested, setIsTested] = useState(false)
  const initializedRef = useRef<string | null>(null)

  // 使用 store 缓存 providersPresets
  const providersPresets = useCloudModelConfigStore(state => state.providersPresets)
  const storeSetProvidersPresets = useCloudModelConfigStore(state => state.setProvidersPresets)
  const getProvidersPresetsIfMatch = useCloudModelConfigStore(
    state => state.getProvidersPresetsIfMatch
  )

  // 加载预设
  useEffect(() => {
    if (initializedRef.current === language) return

    const init = async () => {
      try {
        setIsLoadingPresets(true)
        initializedRef.current = language

        // 优先从 store 缓存读取
        let sortedPresets = getProvidersPresetsIfMatch(language)
        if (!sortedPresets) {
          const rawPresets = await CloudModelConfigAPI.getCloudProvidersConfig(language)

          const uniquePresets = Array.from(new Map(rawPresets.map(p => [p.id, p])).values())

          sortedPresets = [...uniquePresets].sort((a, b) => {
            if (a.id === 'ollama' && b.id !== 'ollama') return -1
            if (a.id !== 'ollama' && b.id === 'ollama') return 1
            if (a.free && !b.free) return -1
            if (!a.free && b.free) return 1
            return 0
          })
          // 缓存到 store
          storeSetProvidersPresets(sortedPresets, language)
        }

        // 设置默认值
        if (sortedPresets.length > 0) {
          const defaultProvider = sortedPresets[0]

          setDraft(prev => ({
            ...prev,
            provider: defaultProvider.id,
            baseUrl: defaultProvider.baseUrl || '',
            apiKey: defaultProvider.id === 'ollama' ? '123' : '',
            model: defaultProvider.models?.[0]?.id || ''
          }))
          setAvailableModels(defaultProvider.models || [])
        }
      } catch (error) {
        logger.error(LogCategory.RENDERER, '加载云端预设失败:', error)
        initializedRef.current = null
      } finally {
        setIsLoadingPresets(false)
      }
    }
    init()
  }, [language])

  const getProviderPreset = (providerId: string) => {
    return providersPresets.find(p => p.id === providerId)
  }

  const handleProviderChange = (newProvider: string) => {
    const preset = getProviderPreset(newProvider)
    const nextModels = preset?.models || []
    setAvailableModels(nextModels)

    setDraft(prev => ({
      ...prev,
      provider: newProvider,
      baseUrl: preset?.baseUrl || '',
      model: nextModels[0]?.id || '',
      apiKey: newProvider === 'ollama' ? '123' : ''
    }))
    setIsTested(false)
  }

  const handleTestAndFetchModels = async () => {
    if (!draft.apiKey.trim()) {
      toast.error(t('请填写 API Key'))
      return
    }

    const preset = getProviderPreset(draft.provider)
    const effectiveBaseUrl = draft.baseUrl?.trim() || preset?.baseUrl || ''

    if (!effectiveBaseUrl) {
      toast.error(t('请填写 Base URL'))
      return
    }

    setIsTesting(true)
    try {
      const testConfig = { ...draft, baseUrl: effectiveBaseUrl }
      await CloudModelConfigAPI.testConfig(testConfig)

      toast.success(t('连接测试成功，正在获取模型列表...'))

      const models = await CloudModelConfigAPI.getProviderModels(
        draft.provider,
        draft.apiKey,
        effectiveBaseUrl,
        true
      )

      if (models.length > 0) {
        setAvailableModels(models)
        const hasModel = models.some(m => m.id === draft.model)
        const selectedModel = hasModel ? draft.model : models[0].id
        setDraft(prev => ({ ...prev, model: selectedModel }))
        toast.success(t('成功获取模型列表（{count}个）', { count: models.length }))
      } else {
        toast.info(t('未获取到模型列表，将使用预置模型'))
      }

      setIsTested(true)
    } catch (error) {
      const message = error instanceof Error ? error.message : t('未知错误')
      toast.error(t('测试失败: {message}', { message }))
    } finally {
      setIsTesting(false)
    }
  }

  const handleNext = async () => {
    if (!isTested || !draft.model) return

    try {
      const preset = getProviderPreset(draft.provider)
      const effectiveBaseUrl = draft.baseUrl?.trim() || preset?.baseUrl || ''

      // 保存到 localStorage 缓存中
      saveCredentials(draft.provider, {
        apiKey: draft.apiKey,
        baseUrl: effectiveBaseUrl,
        model: draft.model
      })

      // 顺序写入所有云端配置，确保数据到位再触发服务切换，
      // 避免 AI_SERVICE_MODE 先于 AI_CLOUD_BASE_URL 写入导致的竞态
      await updateConfigValue('AI_CLOUD_PROVIDER', draft.provider)
      await updateConfigValue('AI_CLOUD_API_KEY', draft.apiKey)
      await updateConfigValue('AI_CLOUD_BASE_URL', effectiveBaseUrl)
      await updateConfigValue('AI_CLOUD_SELECTED_MODEL_ID', draft.model)
      // 最后才切换模式，触发服务重载
      await updateConfigValue('AI_SERVICE_MODE', 'cloud')

      onNext()
    } catch (error) {
      logger.error(LogCategory.RENDERER, '保存云端配置失败:', error)
      toast.error(t('保存配置失败'))
    }
  }

  return (
    <div className="flex flex-col h-full">
      <WelcomeProgress currentStep={3} />

      <div className="flex-grow overflow-auto py-6">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <header className="mb-8">
            <h1 className="text-2xl font-bold tracking-tight">{t('配置云端模型')}</h1>
            <p className="mt-2 text-slate-600">{t('输入您的 API 信息以连接 to 云端 AI 服务')}</p>
          </header>

          <Card className="p-8 bg-white shadow-sm border-slate-200">
            {isLoadingPresets ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-sky-500" />
              </div>
            ) : (
              <div className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <Label className="text-sm font-semibold text-slate-700">{t('云服务商')}</Label>
                    <Select value={draft.provider} onValueChange={handleProviderChange}>
                      <SelectTrigger className="h-11 border-slate-200 focus:ring-sky-500">
                        <SelectValue placeholder={t('选择服务商')} />
                      </SelectTrigger>
                      <SelectContent>
                        {providersPresets.map(p => (
                          <SelectItem key={p.id} value={p.id}>
                            <div className="flex items-center gap-2">
                              <span>{p.name}</span>
                              {p.id === 'ollama' && (
                                <span className="inline-flex items-center rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-800 dark:bg-blue-900/30 dark:text-blue-400">
                                  {t('本地')}
                                </span>
                              )}
                              {p.free && (
                                <span className="inline-flex items-center rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-800 dark:bg-green-900/30 dark:text-green-400">
                                  {t('免费')}
                                </span>
                              )}
                            </div>
                          </SelectItem>
                        ))}
                        {!providersPresets.some(p => p.id === 'custom') && (
                          <SelectItem value="custom">{t('Custom（OpenAI Compatible）')}</SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label className="text-sm font-semibold text-slate-700">
                      {t('Base URL（可选）')}
                    </Label>
                    <Input
                      className="h-11 border-slate-200 focus:ring-sky-500"
                      value={draft.baseUrl || ''}
                      onChange={e => setDraft(prev => ({ ...prev, baseUrl: e.target.value }))}
                      placeholder={
                        getProviderPreset(draft.provider)?.baseUrl || 'https://api.openai.com/v1'
                      }
                    />
                  </div>
                </div>
                {getProviderPreset(draft.provider)?.description && (
                  <div className="mt-1">
                    <p className="text-xs text-slate-500 leading-relaxed">
                      {getProviderPreset(draft.provider)?.description}
                    </p>
                  </div>
                )}

                {draft.provider !== 'ollama' ? (
                  <div className="space-y-2">
                    <Label className="text-sm font-semibold text-slate-700">
                      {t('API Key')}
                      <span className="text-red-500 ml-1">*</span>{' '}
                      <span>
                        {getProviderPreset(draft.provider)?.registerUrl && (
                          <a
                            href="#"
                            onClick={e => {
                              e.preventDefault()
                              const url = getProviderPreset(draft.provider)?.registerUrl
                              if (url) openExternalLink(url)
                            }}
                            className="text-xs text-sky-600 hover:underline"
                          >
                            {t('去注册/获取密钥')}
                          </a>
                        )}
                      </span>
                    </Label>

                    <div className="flex gap-5 justify-between items-center">
                      <Input
                        type="password"
                        className="h-11 border-slate-200 focus:ring-sky-500"
                        value={draft.apiKey}
                        onChange={e => {
                          setDraft(prev => ({ ...prev, apiKey: e.target.value }))
                          setIsTested(false)
                        }}
                        placeholder="sk-..."
                      />
                      <Button
                        variant="default"
                        className="h-auto p-3 font-medium"
                        onClick={handleTestAndFetchModels}
                        disabled={isTesting || !draft.apiKey}
                      >
                        {isTesting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                        {t('测试连接并获取模型列表')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="gap-2 flex justify-between items-center">
                      <Label className="font-semibold text-slate-700">
                        {t('请下载 Ollama')} （
                        <span>
                          {' '}
                          {getProviderPreset(draft.provider)?.registerUrl && (
                            <a
                              href="#"
                              onClick={e => {
                                e.preventDefault()
                                const url = getProviderPreset(draft.provider)?.registerUrl
                                if (url) openExternalLink(url)
                              }}
                              className="text-sky-600 hover:underline"
                            >
                              {getProviderPreset(draft.provider)?.registerUrl}
                            </a>
                          )}
                        </span>{' '}
                        ）{t('并在Ollama中安装Qwen3.5系列模型后，点击')}
                      </Label>
                      <Button
                        variant="default"
                        className="w-fit h-11 px-6 font-medium  vertical-align-middle"
                        onClick={handleTestAndFetchModels}
                        disabled={isTesting}
                      >
                        {isTesting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                        {t('测试连接并获取模型列表')}
                      </Button>
                    </div>
                  </>
                )}

                <div className="space-y-2">
                  <Label className="text-sm font-semibold text-slate-700">{t('选择模型')}</Label>
                  <div className="relative">
                    <div className="relative">
                      <Input
                        className="h-11 border-slate-200 focus:ring-sky-500 pr-10"
                        value={draft.model}
                        onChange={e => setDraft(prev => ({ ...prev, model: e.target.value }))}
                        onFocus={() => setIsModelListOpen(true)}
                        onBlur={() => setTimeout(() => setIsModelListOpen(false), 200)}
                        placeholder={t('请输入或选择模型ID')}
                      />
                      <div
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 cursor-pointer"
                        onClick={() => setIsModelListOpen(!isModelListOpen)}
                      >
                        <ChevronDown
                          className={`h-5 w-5 transition-transform ${isModelListOpen ? 'rotate-180' : ''}`}
                        />
                      </div>
                    </div>

                    {isModelListOpen && availableModels.length > 0 && (
                      <div className="absolute z-50 w-full mt-1 max-h-60 overflow-y-auto bg-white rounded-md border border-slate-200 shadow-lg">
                        {availableModels.map(model => (
                          <div
                            key={model.id}
                            className={`px-4 py-2.5 text-sm cursor-pointer flex items-center justify-between hover:bg-sky-50 ${draft.model === model.id ? 'bg-sky-50 text-sky-700' : 'text-slate-700'}`}
                            onMouseDown={e => {
                              e.preventDefault()
                              setDraft(prev => ({ ...prev, model: model.id }))
                              setIsModelListOpen(false)
                            }}
                          >
                            <div className="flex flex-col">
                              <div className="flex items-center gap-2">
                                <span>{model.id}</span>
                                {(model as ProviderPresetModel).free && (
                                  <span className="inline-flex items-center rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-800 dark:bg-green-900/30 dark:text-green-400">
                                    {t('免费')}
                                  </span>
                                )}
                              </div>
                              {model.name && model.name !== model.id && (
                                <span className="text-xs text-muted-foreground">{model.name}</span>
                              )}
                            </div>
                            {draft.model === model.id && <Check className="h-4 w-4" />}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </Card>
        </div>
      </div>

      <div className="flex-shrink-0 bg-slate-50 py-4 border-t border-slate-200">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between">
            <Button
              variant="outline"
              onClick={onBack}
              className="h-11 rounded-xl px-6 font-semibold"
            >
              {t('返回')}
            </Button>
            <Button
              variant="default"
              onClick={handleNext}
              disabled={!isTested || !draft.model}
              className="h-11 rounded-xl bg-slate-900 px-8 font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {t('开始使用')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
