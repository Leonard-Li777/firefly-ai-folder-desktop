import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../ui/card'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { toast } from '../common/Toast'
import { logger, LogCategory } from '@yonuc/shared'
import type { CloudModelConfig, ProviderModel } from '@yonuc/types'
import { useSettingsStore } from '../../stores/settings-store'
import { useCloudModelConfigStore } from '../../stores/cloud-model-config-store'
import CloudModelConfigAPI from '../../api/cloud-model-config-api'
import { Loader2, ChevronDown, Check } from 'lucide-react'
import { t } from '@app/languages'

type ProviderPresetModelCapability = {
  type: string
}

type ProviderPresetModel = {
  id: string
  name: string
  description?: string
  isMultiModal?: boolean
  capabilities?: ProviderPresetModelCapability[]
}

type ProviderPreset = {
  id: string
  name: string
  baseUrl?: string
  models?: ProviderPresetModel[]
}

async function loadProvidersConfig(
  language: string,
  setPresets: (presets: ProviderPreset[]) => void
): Promise<ProviderPreset[]> {
  try {
    logger.debug(LogCategory.RENDERER, `正在加载云端提供商配置 language=${language}`)

    const presets = (await CloudModelConfigAPI.getCloudProvidersConfig(
      language
    )) as ProviderPreset[]
    logger.info(LogCategory.RENDERER, `成功加载云端提供商配置: ${presets.length}个提供商`)

    setPresets(presets)
    return presets
  } catch (error) {
    logger.error(LogCategory.RENDERER, `加载云端提供商配置失败 language=${language}:`, error)
    console.error('loadProvidersConfig error:', error)
    // 返回空数组作为fallback
    setPresets([])
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

export const CloudModelConfigSettings: React.FC = () => {
  const { config, getConfigValue } = useSettingsStore()
  const language = config.language
  const [providersPresets, setProvidersPresets] = useState<ProviderPreset[]>([])

  // Custom Combobox state
  const [isModelListOpen, setIsModelListOpen] = useState(false)
  const [showAllModels, setShowAllModels] = useState(false)
  const [searchModelTerm, setSearchModelTerm] = useState('')

  const configs = useCloudModelConfigStore(state => state.configs)
  const selectedIndex = useCloudModelConfigStore(state => state.selectedIndex)
  const setConfigs = useCloudModelConfigStore(state => state.setConfigs)
  const setSelectedIndex = useCloudModelConfigStore(state => state.setSelectedIndex)
  const setError = useCloudModelConfigStore(state => state.setError)
  const clearError = useCloudModelConfigStore(state => state.clearError)
  const testingConfigIndex = useCloudModelConfigStore(state => state.testingConfigIndex)
  const setTestingIndex = useCloudModelConfigStore(state => state.setTestingIndex)
  const fetchingModelsProvider = useCloudModelConfigStore(state => state.fetchingModelsProvider)
  const setFetchingModelsProvider = useCloudModelConfigStore(
    state => state.setFetchingModelsProvider
  )
  const getCachedModels = useCloudModelConfigStore(state => state.getCachedModels)
  const setCachedModels = useCloudModelConfigStore(state => state.setCachedModels)

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

  const refreshConfigs = useMemo(async () => {
    setIsInitializing(true)
    clearError()

    try {
      const [nextConfigs, nextSelectedIndex] = await Promise.all([
        CloudModelConfigAPI.getConfigs(),
        CloudModelConfigAPI.getSelectedIndex()
      ])

      setConfigs(nextConfigs)
      setSelectedIndex(nextSelectedIndex)

      // 加载云端提供商配置
      const presets = await loadProvidersConfig(language, setProvidersPresets)

      let initialDraft: CloudModelConfig | null = null

      const activeMode = getConfigValue<string>('AI_SERVICE_MODE')
      const activeProvider = getConfigValue<string>('AI_CLOUD_PROVIDER')

      // 优先显示当前激活的云端配置（如果在云端模式下）
      if (activeMode === 'cloud' && activeProvider) {
        // 尝试从列表中找到对应的配置
        const matchingConfig = nextConfigs.find(c => c.provider === activeProvider)

        const activeApiKey = getConfigValue<string>('AI_CLOUD_API_KEY')
        const activeModel = getConfigValue<string>('AI_CLOUD_SELECTED_MODEL_ID')
        const activeBaseUrl = getConfigValue<string>('AI_CLOUD_BASE_URL')

        if (matchingConfig) {
          // 如果列表中有，使用它，但用全局配置补全可能缺失的信息（Self-healing）
          initialDraft = {
            ...matchingConfig,
            apiKey: activeApiKey && !matchingConfig.apiKey ? activeApiKey : matchingConfig.apiKey,
            model: activeModel && !matchingConfig.model ? activeModel : matchingConfig.model,
            baseUrl:
              activeBaseUrl && !matchingConfig.baseUrl ? activeBaseUrl : matchingConfig.baseUrl
          }
        } else {
          // 如果列表中没有（可能丢失），完全从全局配置重建
          initialDraft = {
            provider: activeProvider,
            apiKey: activeApiKey || '',
            model: activeModel || '',
            baseUrl: activeBaseUrl || ''
          }
        }
      }
      // 否则使用选中的索引
      else if (
        nextConfigs.length > 0 &&
        nextSelectedIndex >= 0 &&
        nextSelectedIndex < nextConfigs.length
      ) {
        initialDraft = nextConfigs[nextSelectedIndex]
      }
      // 否则使用第一个
      else if (nextConfigs.length > 0) {
        initialDraft = nextConfigs[0]
      }
      // 否则初始化默认值
      else {
        const firstProvider = presets[0]?.id || 'openai'
        initialDraft = {
          provider: firstProvider,
          apiKey: '',
          baseUrl: '',
          model: ''
        }
      }

      setDraft(initialDraft)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setError(message)
      logger.error(LogCategory.RENDERER, '加载云端模型配置失败:', error)
    } finally {
      setIsInitializing(false)
    }
  }, [setSelectedIndex, language])

  const availableModels = useMemo(() => {
    if (!draft?.provider) {
      return [] as Array<ProviderPresetModel | ProviderModel>
    }

    // 查找该provider的已有配置
    const existingConfig = configs.find(c => c.provider === draft.provider)

    // 优先使用已保存配置的modelList，其次使用缓存，最后使用预置列表
    const savedModelList = existingConfig?.modelList || []
    if (savedModelList.length > 0) {
      return savedModelList
    }

    const cached = getCachedModels(draft.provider)
    if (cached.length > 0) {
      return cached
    }

    const preset = getProviderPreset(draft.provider)
    return preset?.models || []
  }, [draft?.provider, configs, getCachedModels, getProviderPreset])

  const isUsingDynamicModels = useMemo(() => {
    if (!draft?.provider) {
      return false
    }
    // 如果有保存的modelList或缓存的模型，则认为是动态模型
    const existingConfig = configs.find(c => c.provider === draft.provider)
    const savedModelList = existingConfig?.modelList || []
    const cached = getCachedModels(draft.provider)
    return savedModelList.length > 0 || cached.length > 0
  }, [draft?.provider, configs, getCachedModels])

  const selectedPresetModel = useMemo(() => {
    if (!draft?.provider || !draft.model) {
      return undefined
    }

    // 只在使用内置模型时返回预设模型信息（用于显示description）
    if (isUsingDynamicModels) {
      return undefined
    }

    const preset = getProviderPreset(draft.provider)
    return preset?.models?.find(model => model.id === draft.model)
  }, [draft?.model, draft?.provider, getProviderPreset, isUsingDynamicModels])

  const capabilities = useMemo(() => {
    const types = selectedPresetModel?.capabilities?.map(cap => cap.type).filter(Boolean) || []
    return Array.from(new Set(types))
  }, [selectedPresetModel?.capabilities])

  // 自动保存配置（允许保存不完整的配置）
  const autoSaveConfig = useCallback(
    async (config: CloudModelConfig, skipRefresh = false) => {
      // 至少需要provider才能保存
      if (!config.provider?.trim()) {
        return
      }

      try {
        // 保存前处理baseUrl：如果baseUrl为空，尝试使用预置的默认值
        const preset = getProviderPreset(config.provider)
        const configToSave = {
          ...config,
          // 如果baseUrl为空，使用预设值；否则使用当前值。不再为了节省空间存空字符串。
          baseUrl: !config.baseUrl ? preset?.baseUrl || '' : config.baseUrl
        }

        // Use addConfig for both new and existing configs (Backend handles Upsert by provider)
        // This avoids "Index out of range" errors caused by stale frontend state
        await CloudModelConfigAPI.addConfig(configToSave)
        logger.debug(LogCategory.RENDERER, `自动保存配置(Upsert): provider=${config.provider}`)

        if (!skipRefresh) {
          // 刷新配置但保持当前编辑的provider
          const currentProvider = config.provider
          const [nextConfigs, nextSelectedIndex] = await Promise.all([
            CloudModelConfigAPI.getConfigs(),
            CloudModelConfigAPI.getSelectedIndex()
          ])

          setConfigs(nextConfigs)
          setSelectedIndex(nextSelectedIndex)

          // 刷新后，重新设置draft为当前provider的配置
          const updatedIndex = nextConfigs.findIndex(c => c.provider === currentProvider)
          if (updatedIndex >= 0) {
            setDraft(nextConfigs[updatedIndex])
          }
        }
      } catch (error) {
        logger.error(LogCategory.RENDERER, '自动保存云端配置失败:', error)
      }
    },
    [configs, getProviderPreset, setConfigs, setSelectedIndex]
  )

  const handleProviderChange = (newProvider: string) => {
    if (!draft) return

    // 查找该provider的已有配置
    const existingConfig = configs.find(c => c.provider === newProvider)
    const preset = getProviderPreset(newProvider)

    // 优先使用已保存配置的modelList，其次使用缓存，最后使用预置列表
    const savedModelList = existingConfig?.modelList || []
    const cachedModels = getCachedModels(newProvider)
    const presetModels = preset?.models || []
    const availableModels =
      savedModelList.length > 0
        ? savedModelList
        : cachedModels.length > 0
          ? cachedModels
          : presetModels

    // 优先使用已保存配置的model
    const savedModel = existingConfig?.model || ''
    const hasModel = Boolean(savedModel && availableModels.some(m => m.id === savedModel))
    const nextModel = hasModel ? savedModel : getDefaultModelId(availableModels)

    // baseUrl: 如果已保存的为空或与预置的相同，则显示为空（使用placeholder）
    // 否则显示已保存的自定义baseUrl
    const savedBaseUrl = existingConfig?.baseUrl || ''
    const nextBaseUrl = savedBaseUrl && savedBaseUrl !== preset?.baseUrl ? savedBaseUrl : ''

    // apiKey: 始终从已保存的配置加载，即使为空也要置空
    const nextApiKey = existingConfig?.apiKey || ''

    const newDraft = {
      ...draft,
      provider: newProvider,
      baseUrl: nextBaseUrl,
      model: nextModel,
      apiKey: nextApiKey,
      modelList: savedModelList.length > 0 ? savedModelList : undefined
    }

    setDraft(newDraft)
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

  const handleModelChange = (newModel: string) => {
    if (!draft) return

    const newDraft = { ...draft, model: newModel }
    setDraft(newDraft)
    void autoSaveConfig(newDraft)
  }

  const handleTestAndFetchModels = async () => {
    if (!draft) {
      return
    }

    if (!draft.provider?.trim() || !draft.apiKey?.trim()) {
      toast.error(t('请先填写服务商和 API Key'))
      return
    }

    // 如果baseUrl为空，使用预置的baseUrl
    const preset = getProviderPreset(draft.provider)
    const effectiveBaseUrl = draft.baseUrl?.trim() || preset?.baseUrl || ''

    if (!effectiveBaseUrl) {
      toast.error(t('请先填写Base URL或选择有默认URL的服务商'))
      return
    }

    // 创建用于测试的配置对象
    const testConfig = {
      ...draft,
      baseUrl: effectiveBaseUrl
    }

    setTestingIndex(-1)
    setFetchingModelsProvider(draft.provider)

    try {
      // testConfig now throws error on failure
      const ok = await CloudModelConfigAPI.testConfig(testConfig)
      // Note: backend may still return boolean true if successful, or throw if failed.
      // If it changed to throw, then if we are here, it succeeded.
      // But verify if CloudModelConfigAPI wrapper returns boolean.
      // CloudModelConfigAPI wrapper returns boolean currently.
      // If backend throws, CloudModelConfigAPI wrapper throws.
      // So if we reach here, ok is true.

      toast.success(t('连接测试成功，正在获取模型列表...'))

      const models = await CloudModelConfigAPI.getProviderModels(
        draft.provider,
        draft.apiKey,
        effectiveBaseUrl
      )

      if (models.length === 0) {
        toast.info(t('未获取到在线模型列表，将继续使用内置模型列表'))
        return
      }

      setCachedModels(draft.provider, models)

      // 选择模型：优先使用当前选择的模型（如果在列表中），否则使用第一个
      const hasModel = models.some(m => m.id === draft.model)
      const selectedModel = hasModel ? draft.model : models[0].id

      // 更新draft，如果baseUrl与预置相同则保存为空
      const baseUrlToSave = effectiveBaseUrl === preset?.baseUrl ? '' : effectiveBaseUrl

      const updatedConfig = {
        ...draft,
        baseUrl: baseUrlToSave,
        model: selectedModel,
        modelList: models // 保存获取到的模型列表
      }

      setDraft(updatedConfig)

      // 自动保存配置
      const existingIndex = configs.findIndex(c => c.provider === updatedConfig.provider)
      if (existingIndex >= 0) {
        await CloudModelConfigAPI.updateConfig(existingIndex, updatedConfig)
      } else {
        await CloudModelConfigAPI.addConfig(updatedConfig)
      }

      toast.success(t('已加载并保存在线模型列表（{count}个）', { count: models.length }))

      // 刷新配置列表，但保持当前编辑的provider
      const currentProvider = updatedConfig.provider
      const [nextConfigs, nextSelectedIndex] = await Promise.all([
        CloudModelConfigAPI.getConfigs(),
        CloudModelConfigAPI.getSelectedIndex()
      ])

      setConfigs(nextConfigs)
      setSelectedIndex(nextSelectedIndex)

      // 刷新后，重新设置draft为当前provider的配置
      const updatedIndex = nextConfigs.findIndex(c => c.provider === currentProvider)
      if (updatedIndex >= 0) {
        setDraft(nextConfigs[updatedIndex])
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
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

    // 先确保配置已保存
    if (!isConfigBasicallyValid(draft)) {
      toast.error(t('请填写完整的配置信息'))
      return
    }

    // 先保存配置（不刷新界面）
    await autoSaveConfig(draft, true)

    // 测试连接
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
      // testConfig throws on error
      await CloudModelConfigAPI.testConfig(testConfig)

      // 测试成功后才设置为当前配置
      const freshConfigs = await CloudModelConfigAPI.getConfigs()
      const index = freshConfigs.findIndex(c => c.provider === draft.provider)

      if (index < 0) {
        toast.error(t('配置未保存，请稍后重试'))
        setTestingIndex(null)
        return
      }

      await CloudModelConfigAPI.setSelectedIndex(index)
      toast.success(t('已设为当前云端配置'))

      // 刷新配置但保持当前编辑的provider
      const currentProvider = draft.provider
      const [nextConfigs, nextSelectedIndex] = await Promise.all([
        CloudModelConfigAPI.getConfigs(),
        CloudModelConfigAPI.getSelectedIndex()
      ])

      setConfigs(nextConfigs)
      setSelectedIndex(nextSelectedIndex)

      // 刷新后，重新设置draft为当前provider的配置
      const updatedIndex = nextConfigs.findIndex(c => c.provider === currentProvider)
      if (updatedIndex >= 0) {
        setDraft(nextConfigs[updatedIndex])
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(t('无法激活为云端配置，错误信息：{message}', { message }))
      logger.error(LogCategory.RENDERER, '设置选中云端配置失败:', error)
    } finally {
      setTestingIndex(null)
    }
  }

  const providerOptions = useMemo(() => {
    const fromPresets = providersPresets

    const hasCustom = fromPresets.some(p => p.id === 'custom')
    return hasCustom
      ? fromPresets
      : [
          ...fromPresets,
          {
            id: 'custom',
            name: t('Custom（OpenAI Compatible）'),
            baseUrl: '',
            models: []
          } satisfies ProviderPreset
        ]
  }, [providersPresets])

  const currentProviderLabel = useCallback(
    (providerId: string) => {
      const preset = providerOptions.find(p => p.id === providerId)
      return preset?.name || providerId
    },
    [providerOptions]
  )

  const isBusy = isInitializing || testingConfigIndex !== null || fetchingModelsProvider !== null

  const isCurrentConfig = useMemo(() => {
    if (!draft || selectedIndex < 0 || selectedIndex >= configs.length) {
      return false
    }
    const selectedConfig = configs[selectedIndex]
    return selectedConfig.provider === draft.provider
  }, [draft, selectedIndex, configs])

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h4 className="text-base font-semibold">{t('云端配置')}</h4>
          <p className="text-sm text-muted-foreground">
            {t('选择云端服务商，配置API密钥和模型。修改后自动保存。')}
          </p>
        </div>
      </div>

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
                <div className="grid gap-2 col-span-2">
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
                      {providerOptions.map(provider => (
                        <SelectItem key={provider.id} value={provider.id}>
                          {provider.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid gap-2 col-span-6">
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

                <div className="grid gap-2 col-span-6">
                  <Label>API Key</Label>
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
                    variant="link"
                    className="ml-[-20px]"
                    onClick={() => void handleTestAndFetchModels()}
                    disabled={isBusy || !draft.provider || !draft.apiKey}
                  >
                    {(testingConfigIndex !== null || fetchingModelsProvider !== null) && (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    )}
                    {t('测试连接')}
                  </Button>
                </div>
                <div className="grid gap-2 col-span-8">
                  <Label>
                    {' '}
                    {t('模型')}{' '}
                    <span className="text-xs text-muted-foreground">
                      {isUsingDynamicModels
                        ? t('当前使用在线获取的模型列表')
                        : t('当前使用预置模型列表')}
                    </span>
                  </Label>
                  <div className="relative">
                    <div className="relative">
                      <Input
                        value={draft.model}
                        onChange={e => {
                          const newModel = e.target.value
                          setDraft(prev => (prev ? { ...prev, model: newModel } : prev))
                          // Open list when typing to show filtering
                          if (!isModelListOpen) setIsModelListOpen(true)
                          setShowAllModels(false)
                        }}
                        onFocus={() => {
                          setIsModelListOpen(true)
                          setShowAllModels(true)
                        }}
                        onBlur={() => {
                          // Delayed close to allow click on items
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
                          e.preventDefault() // Prevent blur
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

                    {/* Custom Model Dropdown List */}
                    {isModelListOpen && availableModels.length > 0 && (
                      <div className="absolute z-50 w-full mt-1 max-h-60 overflow-y-auto bg-popover text-popover-foreground rounded-md border shadow-md animate-in fade-in-0 zoom-in-95">
                        <div className="p-1">
                          {availableModels
                            .filter(
                              m =>
                                showAllModels ||
                                !draft.model ||
                                m.id.toLowerCase().includes(draft.model.toLowerCase()) ||
                                draft.model === m.id
                            )
                            .map(model => (
                              <div
                                key={model.id}
                                className={`
                                  relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none
                                  ${draft.model === model.id ? 'bg-accent text-accent-foreground' : 'hover:bg-accent hover:text-accent-foreground'}
                                `}
                                onMouseDown={e => {
                                  e.preventDefault() // Prevent blur
                                  setDraft(prev => (prev ? { ...prev, model: model.id } : prev))
                                  void autoSaveConfig({ ...draft, model: model.id })
                                  setIsModelListOpen(false)
                                }}
                              >
                                <Check
                                  className={`mr-2 h-4 w-4 ${draft.model === model.id ? 'opacity-100' : 'opacity-0'}`}
                                />
                                <div className="flex flex-col">
                                  <span>{model.id}</span>
                                  {model.name && model.name !== model.id && (
                                    <span className="text-xs text-muted-foreground">
                                      {model.name}
                                    </span>
                                  )}
                                </div>
                              </div>
                            ))}
                          {availableModels.filter(
                            m =>
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

                  {/* 显示模型描述信息 */}
                  {selectedPresetModel?.description && (
                    <div className="space-y-2">
                      <div className="text-sm text-muted-foreground rounded-md">
                        {selectedPresetModel.description}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {capabilities.length > 0 && selectedPresetModel?.isMultiModal && (
                <div className="space-y-2">
                  <div className="text-sm font-medium">{t('多模态能力')}</div>
                  <div className="flex flex-wrap gap-2">
                    {capabilities.map(cap => (
                      <span
                        key={cap}
                        className="inline-flex items-center rounded-full bg-muted px-3 py-1 text-xs text-foreground"
                      >
                        {cap}
                      </span>
                    ))}
                  </div>
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
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">{t('正在加载配置...')}</div>
          )}
        </Card>
      </div>
    </div>
  )
}
