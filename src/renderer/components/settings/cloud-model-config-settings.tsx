import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Card } from '../ui/card'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { toast } from '../common/Toast'
import { logger, LogCategory } from '@firefly/shared'
import type { CloudModelConfig, ProviderModel } from '@firefly/types'
import { useSettingsStore } from '../../stores/settings-store'
import { useCloudModelConfigStore } from '../../stores/cloud-model-config-store'
import CloudModelConfigAPI from '../../api/cloud-model-config-api'
import { Loader2, ChevronDown, Check, AlertTriangle } from 'lucide-react'
import { t } from '@app/languages'
import { openExternalLink } from '../../lib/external-link'
import { validateCloudConfig } from '../../lib/cloud-config-validator'

type ProviderPresetModelCapability = {
  type: string
}

type ProviderPresetModel = {
  id: string
  name: string
  description?: string
  isMultiModal?: boolean
  free?: boolean
  capabilities?: (ProviderPresetModelCapability | string)[]
  parameterSize?: string
  contextLength?: string
  maxOutput?: string
  rateLimit?: string
  company?: string
}

type ProviderPreset = {
  id: string
  name: string
  baseUrl?: string
  free?: boolean
  description?: string
  registerUrl?: string
  models?: ProviderPresetModel[]
  flag?: string
  country?: string
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

async function loadProvidersConfig(language: string): Promise<ProviderPreset[]> {
  try {
    logger.debug(LogCategory.RENDERER, `正在加载云端提供商配置 language=${language}`)

    const presets = (await CloudModelConfigAPI.getCloudProvidersConfig(
      language
    )) as ProviderPreset[]
    logger.info(LogCategory.RENDERER, `成功加载云端提供商配置: ${presets.length}个提供商`)

    return presets
  } catch (error) {
    logger.error(LogCategory.RENDERER, `加载云端提供商配置失败 language=${language}:`, error)
    console.error('loadProvidersConfig error:', error)
    return []
  }
}

function getDefaultModelId(models: ProviderPresetModel[] | ProviderModel[]): string {
  if (!Array.isArray(models) || models.length === 0) {
    return ''
  }

  const withMulti = (models as ProviderPresetModel[]).find(model => model.isMultiModal)
  const first = withMulti || models[0]
  return first?.id || ''
}

function isConfigBasicallyValid(config: CloudModelConfig): boolean {
  return Boolean(config.provider?.trim() && config.apiKey?.trim() && config.model?.trim())
}

/**
 * 格式化模型速率限制和规格信息，使其更加通俗易懂
 */
function formatModelInfo(model: ProviderPresetModel): { label: string; value: string }[] {
  const infos: { label: string; value: string }[] = []

  if (model.company) {
    infos.push({ label: t('厂商'), value: model.company })
  }
  if (model.parameterSize) {
    infos.push({ label: t('参数规模'), value: model.parameterSize })
  }
  if (model.contextLength) {
    infos.push({ label: t('上下文长度'), value: model.contextLength })
  }
  if (model.maxOutput) {
    infos.push({ label: t('最大输出'), value: model.maxOutput })
  }
  if (model.rateLimit) {
    // 翻译 RPM, RPD, TPM 为通俗表达
    const formattedRate = model.rateLimit
      .replace(/RPM/gi, t('每分钟请求数'))
      .replace(/RPD/gi, t('每天请求限制'))
      .replace(/TPM/gi, t('每分钟 Token 限制'))
      .replace(/RPS/gi, t('每秒请求数'))

    infos.push({ label: t('速率限制'), value: formattedRate })
  }

  return infos
}

export const CloudModelConfigSettings: React.FC = () => {
  const { config, getConfigValue, updateConfigValue } = useSettingsStore()
  const language = config.language

  // Custom Combobox state
  const [isModelListOpen, setIsModelListOpen] = useState(false)
  const [showAllModels, setShowAllModels] = useState(false)

  const setConfigs = useCloudModelConfigStore(state => state.setConfigs)
  const setError = useCloudModelConfigStore(state => state.setError)
  const clearError = useCloudModelConfigStore(state => state.clearError)
  const testingConfigIndex = useCloudModelConfigStore(state => state.testingConfigIndex)
  const setTestingIndex = useCloudModelConfigStore(state => state.setTestingIndex)
  const fetchingModelsProvider = useCloudModelConfigStore(state => state.fetchingModelsProvider)
  const setFetchingModelsProvider = useCloudModelConfigStore(
    state => state.setFetchingModelsProvider
  )
  const cachedModels = useCloudModelConfigStore(state => state.cachedModels)
  const getCachedModels = useCloudModelConfigStore(state => state.getCachedModels)
  const setCachedModels = useCloudModelConfigStore(state => state.setCachedModels)
  const providersPresets = useCloudModelConfigStore(state => state.providersPresets)
  const storeSetProvidersPresets = useCloudModelConfigStore(state => state.setProvidersPresets)
  const getProvidersPresetsIfMatch = useCloudModelConfigStore(
    state => state.getProvidersPresetsIfMatch
  )
  const initializedRef = useRef<string | null>(null)

  const [isInitializing, setIsInitializing] = useState(false)
  const [draft, setDraft] = useState<CloudModelConfig | null>(null)

  const getProviderPreset = useCallback(
    (providerId: string | undefined) => {
      if (!providerId) {
        return undefined
      }
      return providersPresets.find(p => p.id === providerId)
    },
    [providersPresets]
  )

  useEffect(() => {
    if (initializedRef.current === language) return

    const initialize = async () => {
      setIsInitializing(true)
      clearError()
      initializedRef.current = language

      try {
        const nextConfigs = await CloudModelConfigAPI.getConfigs()
        setConfigs(nextConfigs)

        // 加载云端提供商配置 - 优先从 store 缓存读取，只有缓存未命中或语言变化时才调用 IPC
        let presets = getProvidersPresetsIfMatch(language)
        if (!presets) {
          presets = await loadProvidersConfig(language)
          // 缓存到 store，供后续切换页面使用
          storeSetProvidersPresets(presets, language)
        }

        // 获取当前全局激活的配置
        const activeProvider = getConfigValue<string>('AI_CLOUD_PROVIDER') || 'ollama'
        const activeApiKey =
          activeProvider === 'ollama' ? '123' : getConfigValue<string>('AI_CLOUD_API_KEY') || ''
        // 如果全局配置中的 baseUrl 为空，则使用 preset 中的默认值
        const activePreset = presets.find(p => p.id === activeProvider)
        const activeBaseUrl =
          getConfigValue<string>('AI_CLOUD_BASE_URL') || activePreset?.baseUrl || ''
        const activeModel = getConfigValue<string>('AI_CLOUD_SELECTED_MODEL_ID') || ''

        // 同步当前激活配置到 localStorage 缓存
        const savedCreds = getSavedCredentials()
        savedCreds[activeProvider] = {
          apiKey: activeApiKey,
          baseUrl: activeBaseUrl,
          model: activeModel
        }
        localStorage.setItem(CREDENTIALS_KEY, JSON.stringify(savedCreds))

        const initialDraft: CloudModelConfig = {
          provider: activeProvider,
          apiKey: activeApiKey,
          baseUrl: activeBaseUrl,
          model: activeModel
        }
        setDraft(initialDraft)
      } catch (error) {
        const message = t('未知错误')
        setError(message)
        logger.error(LogCategory.RENDERER, '加载云端模型配置失败:', error)
      } finally {
        setIsInitializing(false)
      }
    }

    initialize()
  }, [language])

  const availableModels = useMemo(() => {
    if (!draft?.provider) {
      return [] as Array<ProviderPresetModel | ProviderModel>
    }

    const cached = getCachedModels(draft.provider)
    if (cached.length > 0) {
      return cached
    }

    const preset = getProviderPreset(draft.provider)
    return preset?.models || []
  }, [draft?.provider, getCachedModels, getProviderPreset, cachedModels])

  const isUsingDynamicModels = useMemo(() => {
    if (!draft?.provider) {
      return false
    }
    const cached = getCachedModels(draft.provider)
    return cached.length > 0
  }, [draft?.provider, getCachedModels, cachedModels])

  const selectedPresetModel = useMemo(() => {
    if (!draft?.provider || !draft.model) {
      return undefined
    }

    if (isUsingDynamicModels) {
      return undefined
    }

    const preset = getProviderPreset(draft.provider)
    return preset?.models?.find((model: ProviderPresetModel) => model.id === draft.model)
  }, [draft?.model, draft?.provider, getProviderPreset, isUsingDynamicModels])

  const capabilities: string[] = useMemo(() => {
    if (!selectedPresetModel?.capabilities) return []
    const types = selectedPresetModel.capabilities
      .map((cap: ProviderPresetModelCapability | string) =>
        typeof cap === 'string' ? cap : cap.type
      )
      .filter(Boolean)
    return Array.from(new Set(types))
  }, [selectedPresetModel?.capabilities])

  // 自动保存配置
  const autoSaveConfig = useCallback(
    async (config: CloudModelConfig) => {
      if (!config.provider?.trim()) {
        return
      }

      saveCredentials(config.provider, {
        apiKey: config.apiKey || '',
        baseUrl: config.baseUrl || '',
        model: config.model || ''
      })

      // 如果当前编辑的正是激活的提供商，或者当前全局未激活任何提供商，同步更新全局配置
      const activeProvider = getConfigValue<string>('AI_CLOUD_PROVIDER')
      if (config.provider === activeProvider || !activeProvider) {
        const preset = providersPresets.find(p => p.id === config.provider)
        const effectiveBaseUrl = config.baseUrl?.trim() || preset?.baseUrl || ''

        await Promise.all([
          updateConfigValue('AI_CLOUD_PROVIDER', config.provider),
          updateConfigValue('AI_CLOUD_API_KEY', config.apiKey || ''),
          updateConfigValue('AI_CLOUD_BASE_URL', effectiveBaseUrl),
          updateConfigValue('AI_CLOUD_SELECTED_MODEL_ID', config.model || '')
        ])
      }
    },
    [getConfigValue, updateConfigValue, providersPresets]
  )

  const handleProviderChange = (newProvider: string) => {
    if (!draft) return

    const preset = getProviderPreset(newProvider)
    const cachedModels = getCachedModels(newProvider)
    const presetModels = preset?.models || []
    const availableModels = cachedModels.length > 0 ? cachedModels : presetModels

    const saved = getSavedCredentials()[newProvider]

    const nextBaseUrl = saved?.baseUrl || preset?.baseUrl || ''
    const nextModel = saved?.model || getDefaultModelId(availableModels)
    const nextApiKey = newProvider === 'ollama' ? '123' : saved?.apiKey || ''

    const newDraft = {
      provider: newProvider,
      baseUrl: nextBaseUrl,
      model: nextModel,
      apiKey: nextApiKey
    }

    setDraft(newDraft)
    void autoSaveConfig(newDraft)
  }

  const handleApiKeyBlur = () => {
    if (draft) {
      void autoSaveConfig(draft)
    }
  }

  const handleBaseUrlBlur = () => {
    if (draft) {
      void autoSaveConfig(draft)
    }
  }

  const handleTestAndFetchModels = async () => {
    if (!draft) {
      return
    }

    if (!draft.provider?.trim() || !draft.apiKey?.trim()) {
      toast.error(t('请先填写服务商和 API Key'))
      return
    }

    const preset = getProviderPreset(draft.provider)
    const effectiveBaseUrl = draft.baseUrl?.trim() || preset?.baseUrl || ''

    if (!effectiveBaseUrl) {
      toast.error(t('请先填写Base URL或选择有默认URL的服务商'))
      return
    }

    const testConfig = {
      ...draft,
      baseUrl: effectiveBaseUrl
    }

    setTestingIndex(-1)
    setFetchingModelsProvider(draft.provider)

    try {
      await CloudModelConfigAPI.testConfig(testConfig)
      toast.success(t('连接测试成功，正在获取模型列表...'))

      const models = await CloudModelConfigAPI.getProviderModels(
        draft.provider,
        draft.apiKey,
        effectiveBaseUrl,
        true // throwOnError
      )

      if (models.length === 0) {
        toast.info(t('未获取到在线模型列表，将继续使用内置模型列表'))
        return
      }

      setCachedModels(draft.provider, models)

      const hasModel = models.some(m => m.id === draft.model)
      const selectedModel = hasModel ? draft.model : models[0].id

      const updatedConfig = {
        ...draft,
        model: selectedModel
      }

      setDraft(updatedConfig)
      await autoSaveConfig(updatedConfig)

      toast.success(t('已加载并保存在线模型列表（{count}个）', { count: models.length }))
    } catch (error) {
      const message = error instanceof Error ? error.message : t('未知错误')
      toast.error(message)
      logger.error(LogCategory.RENDERER, '测试连接或获取模型列表失败:', error)
    } finally {
      setTestingIndex(null)
      setFetchingModelsProvider(null)
    }
  }

  const handleActivateConfig = async () => {
    if (!draft) {
      return
    }

    if (!isConfigBasicallyValid(draft)) {
      toast.error(t('请填写完整的配置信息'))
      return
    }

    await autoSaveConfig(draft)

    const preset = getProviderPreset(draft.provider)
    const effectiveBaseUrl = draft.baseUrl?.trim() || preset?.baseUrl || ''

    if (!effectiveBaseUrl) {
      toast.error(t('请先填写Base URL或选择有默认URL的服务商'))
      return
    }

    const testConfig = {
      ...draft,
      baseUrl: effectiveBaseUrl
    }

    setTestingIndex(-1)

    try {
      await CloudModelConfigAPI.testConfig(testConfig)

      // 顺序写入所有云端配置，确保数据到位再触发服务切换，
      // 避免 AI_SERVICE_MODE 先于 AI_CLOUD_BASE_URL 写入导致的竞态
      await updateConfigValue('AI_CLOUD_PROVIDER', draft.provider)
      await updateConfigValue('AI_CLOUD_API_KEY', draft.apiKey)
      await updateConfigValue('AI_CLOUD_BASE_URL', effectiveBaseUrl)
      await updateConfigValue('AI_CLOUD_SELECTED_MODEL_ID', draft.model)
      // 最后才切换模式，触发服务重载
      await updateConfigValue('AI_SERVICE_MODE', 'cloud')

      toast.success(t('已设为当前云端配置'))
    } catch (error) {
      const message = error instanceof Error ? error.message : t('未知错误')
      toast.error(t('无法激活为云端配置，错误信息：{message}', { message }))
      logger.error(LogCategory.RENDERER, '设置选中云端配置失败:', error)
    } finally {
      setTestingIndex(null)
    }
  }

  const providerOptions = useMemo(() => {
    const providerMap = new Map<string, ProviderPreset>()
    providersPresets.forEach(p => {
      if (!providerMap.has(p.id)) {
        providerMap.set(p.id, p)
      }
    })

    const fromPresets = Array.from(providerMap.values())

    fromPresets.sort((a, b) => {
      if (a.id === 'ollama' && b.id !== 'ollama') return -1
      if (a.id !== 'ollama' && b.id === 'ollama') return 1
      if (a.free && !b.free) return -1
      if (!a.free && b.free) return 1
      return 0
    })

    const hasCustom = fromPresets.some(p => p.id === 'custom')
    if (!hasCustom) {
      fromPresets.push({
        id: 'custom',
        name: t('Custom（OpenAI Compatible）'),
        baseUrl: '',
        models: []
      } satisfies ProviderPreset)
    }

    return fromPresets
  }, [providersPresets])

  const isBusy = isInitializing || testingConfigIndex !== null || fetchingModelsProvider !== null

  // 直接计算，不缓存，保证每次渲染都反映最新的全局配置
  const isCurrentConfig = Boolean(
    draft && getConfigValue<string>('AI_CLOUD_PROVIDER') === draft.provider
  )

  // 当前全局激活的云端配置信息及完整性校验结果
  const activeConfigValidation = useMemo(() => {
    const provider = getConfigValue<string>('AI_CLOUD_PROVIDER')
    const apiKey = getConfigValue<string>('AI_CLOUD_API_KEY')
    const baseUrl = getConfigValue<string>('AI_CLOUD_BASE_URL')
    const model = getConfigValue<string>('AI_CLOUD_SELECTED_MODEL_ID')

    if (!provider) {
      return {
        hasConfig: false,
        validation: validateCloudConfig(undefined, apiKey, baseUrl, model),
        provider: '',
        providerName: '',
        baseUrl: '',
        model: ''
      }
    }

    const preset = providersPresets.find(p => p.id === provider)
    const validation = validateCloudConfig(provider, apiKey, baseUrl, model, preset?.baseUrl)

    return {
      hasConfig: true,
      validation,
      provider,
      providerName: preset?.name || provider,
      baseUrl: validation.details.baseUrl || '',
      model: model || ''
    }
  }, [config, getConfigValue, providersPresets])

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4">
        <Card className="p-4">
          {isInitializing ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('正在加载...')}
            </div>
          ) : draft ? (
            <div className="space-y-4">
              <div className="grid grid-cols-8 gap-4">
                <div className="grid gap-2 col-span-3">
                  <Label>{t('云服务商')}</Label>
                  <Select
                    value={draft.provider}
                    onValueChange={handleProviderChange}
                    disabled={isBusy}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={t('选择服务商')} />
                    </SelectTrigger>
                    <SelectContent>
                      {providerOptions.map((provider, idx) => (
                        <SelectItem key={`${provider.id}-${idx}`} value={provider.id}>
                          <div className="flex items-center gap-2">
                            <span>
                              {provider.name}
                              {provider.flag && provider.country && (
                                <span className="ml-1.5 text-muted-foreground">
                                  {provider.flag}{' '}
                                  <span className="text-[10px]">{provider.country}</span>
                                </span>
                              )}
                            </span>
                            {provider.id === 'ollama' && (
                              <span className="inline-flex items-center rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-800 dark:bg-blue-900/30 dark:text-blue-400">
                                {t('本地')}
                              </span>
                            )}
                            {provider.free && (
                              <span className="inline-flex items-center rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-800 dark:bg-green-900/30 dark:text-green-400">
                                {t('免费')}
                              </span>
                            )}
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid gap-2 col-span-5">
                  <Label>{t('Base URL（可选）')}</Label>
                  <Input
                    value={draft.baseUrl || ''}
                    onChange={e =>
                      setDraft(prev => (prev ? { ...prev, baseUrl: e.target.value } : prev))
                    }
                    onBlur={handleBaseUrlBlur}
                    placeholder={
                      getProviderPreset(draft.provider)?.baseUrl || 'https://api.openai.com/v1'
                    }
                    disabled={isBusy}
                  />
                </div>
                <div className="grid col-span-8">
                  {getProviderPreset(draft.provider)?.description && (
                    <p className="text-xs text-slate-500 leading-relaxed">
                      {getProviderPreset(draft.provider)?.description}
                    </p>
                  )}
                </div>
                {draft.provider !== 'ollama' ? (
                  <>
                    <div className="grid gap-2 col-span-6">
                      <Label>
                        API Key<span className="text-red-500 ml-1">*</span>{' '}
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
                              className="text-xs text-sky-600 hover:underline"
                            >
                              {t('去注册/获取密钥')}
                            </a>
                          )}
                        </span>
                      </Label>
                      <Input
                        type="password"
                        value={draft.apiKey}
                        onChange={e =>
                          setDraft(prev => (prev ? { ...prev, apiKey: e.target.value } : prev))
                        }
                        onBlur={handleApiKeyBlur}
                        placeholder="sk-..."
                        disabled={isBusy}
                        className="ph-no-capture"
                      />
                    </div>
                    <div className="grid gap-2 col-span-2">
                      <Label>&nbsp;</Label>
                      <Button
                        variant="outline"
                        className="w-fit"
                        onClick={() => void handleTestAndFetchModels()}
                        disabled={isBusy || !draft.provider || !draft.apiKey}
                      >
                        {(testingConfigIndex !== null || fetchingModelsProvider !== null) && (
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        )}
                        {t('获取模型列表')}
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="grid gap-2 col-span-6">
                      <div className="text-xs gap-2">
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
                        ）{t('并在Ollama中安装Qwen3.5系列模型后，点击"获取模型列表"')}
                      </div>
                    </div>
                    <div className="grid gap-2 col-span-2">
                      <Button
                        variant="outline"
                        className="w-fit"
                        onClick={() => void handleTestAndFetchModels()}
                        disabled={isBusy || !draft.provider}
                      >
                        {(testingConfigIndex !== null || fetchingModelsProvider !== null) && (
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        )}
                        {t('获取模型列表')}
                      </Button>
                    </div>
                  </>
                )}
                <div className="grid gap-2 col-span-8">
                  <div className="relative">
                    <div className="relative">
                      <Input
                        value={draft.model}
                        onChange={e => {
                          const newModel = e.target.value
                          setDraft(prev => (prev ? { ...prev, model: newModel } : prev))
                          if (!isModelListOpen) setIsModelListOpen(true)
                          setShowAllModels(false)
                        }}
                        onFocus={() => {
                          setIsModelListOpen(true)
                          setShowAllModels(true)
                        }}
                        onBlur={() => {
                          setTimeout(() => {
                            if (draft) autoSaveConfig(draft)
                            setIsModelListOpen(false)
                          }, 200)
                        }}
                        placeholder={t('请输入或选择模型ID')}
                        disabled={isBusy}
                        className="pr-10"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="absolute right-0 top-0 h-full px-3 text-muted-foreground hover:bg-transparent"
                        onMouseDown={e => {
                          e.preventDefault()
                          if (isModelListOpen) {
                            setIsModelListOpen(false)
                          } else {
                            setIsModelListOpen(true)
                            setShowAllModels(true)
                          }
                        }}
                        tabIndex={-1}
                      >
                        <ChevronDown
                          className={`h-4 w-4 transition-transform ${isModelListOpen ? 'rotate-180' : ''}`}
                        />
                      </Button>
                    </div>

                    {isModelListOpen && availableModels.length > 0 && (
                      <div className="absolute z-50 w-full mt-1 max-h-60 overflow-y-auto bg-popover text-popover-foreground rounded-md border shadow-md animate-in fade-in-0 zoom-in-95">
                        <div className="p-1">
                          {availableModels
                            .filter(
                              (m: ProviderPresetModel | ProviderModel) =>
                                !m.id ||
                                showAllModels ||
                                !draft.model ||
                                m.id.toLowerCase().includes(draft.model.toLowerCase()) ||
                                draft.model === m.id
                            )
                            .map((model: ProviderPresetModel | ProviderModel, idx: number) => (
                              <div
                                key={`${model.id}-${idx}`}
                                className={`
                                  relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none
                                  ${draft.model === model.id ? 'bg-accent text-accent-foreground' : 'hover:bg-accent hover:text-accent-foreground'}
                                `}
                                onMouseDown={e => {
                                  e.preventDefault()
                                  const updated = { ...draft, model: model.id }
                                  setDraft(updated)
                                  void autoSaveConfig(updated)
                                  setIsModelListOpen(false)
                                }}
                              >
                                <Check
                                  className={`mr-2 h-4 w-4 ${draft.model === model.id ? 'opacity-100' : 'opacity-0'}`}
                                />
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
                                    <span className="text-xs text-muted-foreground">
                                      {model.name}
                                    </span>
                                  )}
                                </div>
                              </div>
                            ))}
                          {availableModels.filter(
                            (m: ProviderPresetModel | ProviderModel) =>
                              !m.id ||
                              !draft.model ||
                              m.id.toLowerCase().includes(draft.model.toLowerCase()) ||
                              draft.model === m.id
                          ).length === 0 && (
                            <div className="py-6 text-center text-sm text-muted-foreground">
                              {t('没有找到匹配的模型')}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {selectedPresetModel && (
                <div className="space-y-3 pt-1 border-t border-dashed">
                  {formatModelInfo(selectedPresetModel).length > 0 && (
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-y-2 gap-x-4">
                      {formatModelInfo(selectedPresetModel).map((info, idx) => (
                        <div key={idx} className="flex flex-col gap-0.5">
                          <span className="text-[11px] text-muted-foreground">{info.label}</span>
                          <span className="text-xs font-medium truncate" title={info.value}>
                            {info.value}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {capabilities.length > 0 &&
                    (selectedPresetModel.isMultiModal || capabilities.some(c => c !== 'TEXT')) && (
                      <div className="space-y-1.5">
                        <div className="text-[11px] text-muted-foreground">{t('多模态能力')}</div>
                        <div className="flex flex-wrap gap-1.5">
                          {capabilities.map((cap, idx) => (
                            <span
                              key={`${cap}-${idx}`}
                              className="inline-flex items-center rounded bg-muted/50 px-2 py-0.5 text-[10px] text-foreground border border-muted"
                            >
                              {cap}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Button
                    onClick={() => void handleActivateConfig()}
                    disabled={isBusy || !isConfigBasicallyValid(draft)}
                  >
                    {isCurrentConfig ? t('当前使用的配置（已激活）') : t('设为当前配置(激活)')}
                  </Button>
                </div>
              </div>
              {activeConfigValidation.hasConfig && (
                <Card
                  className={`p-3.5 shadow-sm border-l-4 transition-all ${
                    activeConfigValidation.validation.isValid
                      ? 'border-l-primary bg-primary/5 dark:bg-primary/10'
                      : 'border-l-amber-500 bg-amber-500/5 dark:bg-amber-950/20 border-amber-500/40'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 mb-2.5">
                    <div className="flex items-center gap-2">
                      {activeConfigValidation.validation.isValid ? (
                        <div className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
                      ) : (
                        <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                      )}
                      <h4
                        className={`text-xs font-semibold ${
                          activeConfigValidation.validation.isValid
                            ? 'text-primary'
                            : 'text-amber-700 dark:text-amber-400'
                        }`}
                      >
                        {t('当前激活的云端配置')}
                      </h4>
                    </div>

                    {!activeConfigValidation.validation.isValid && (
                      <span className="text-[11px] text-amber-600 dark:text-amber-400 font-medium flex items-center gap-1">
                        <span>
                          {t('缺少')}: {activeConfigValidation.validation.missingFields.join('、')}
                        </span>
                      </span>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground text-xs">{t('服务商')}：</span>
                      <span className="font-medium truncate">
                        {activeConfigValidation.providerName}
                      </span>
                      {activeConfigValidation.provider === draft?.provider && (
                        <span className="inline-flex items-center rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-800 dark:bg-green-900/30 dark:text-green-400">
                          {t('当前编辑')}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground text-xs">{t('模型')}：</span>
                      <span
                        className={`font-medium truncate ${
                          !activeConfigValidation.model || activeConfigValidation.model === '-'
                            ? 'text-amber-600 dark:text-amber-400 text-xs font-semibold'
                            : ''
                        }`}
                      >
                        {activeConfigValidation.model || t('未选择')}
                      </span>
                    </div>
                    <div className="col-span-2 flex items-center gap-2">
                      <span className="text-muted-foreground text-xs shrink-0">
                        {t('Base URL')}：
                      </span>
                      <span
                        className={`font-medium truncate text-xs break-all ${
                          !activeConfigValidation.baseUrl || activeConfigValidation.baseUrl === '-'
                            ? 'text-amber-600 dark:text-amber-400 font-semibold'
                            : 'text-muted-foreground'
                        }`}
                      >
                        {activeConfigValidation.baseUrl || t('未配置')}
                      </span>
                    </div>
                  </div>
                </Card>
              )}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">{t('正在加载配置...')}</div>
          )}
        </Card>
      </div>
    </div>
  )
}
