import React, { useCallback, useEffect, useState, useRef } from 'react'
import { Card } from '../ui/card'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { toast } from '../common/Toast'
import { logger, LogCategory } from '@yonuc/shared'
import type { CloudModelConfig, ProviderModel } from '@yonuc/types'
import { useSettingsStore } from '../../stores/settings-store'
import CloudModelConfigAPI from '../../api/cloud-model-config-api'
import { Loader2, ChevronDown, Check } from 'lucide-react'
import { t } from '@app/languages'
import { WelcomeProgress } from './WelcomeProgress'

interface CloudModelConfigStepProps {
  onNext: () => void
  onBack: () => void
}

type ProviderPresetModel = {
  id: string
  name: string
  description?: string
  isMultiModal?: boolean
}

type ProviderPreset = {
  id: string
  name: string
  baseUrl?: string
  models?: ProviderPresetModel[]
}

export function CloudModelConfigStep({ onNext, onBack }: CloudModelConfigStepProps) {
  const { config, updateConfigValue } = useSettingsStore()
  const language = config?.language || 'zh-CN'

  const [providersPresets, setProvidersPresets] = useState<ProviderPreset[]>([])
  const [draft, setDraft] = useState<CloudModelConfig>({
    provider: 'openai',
    apiKey: '',
    baseUrl: '',
    model: ''
  })
  
  const [isLoadingPresets, setIsLoadingPresets] = useState(true)
  const [isTesting, setIsTesting] = useState(false)
  const [isModelListOpen, setIsModelListOpen] = useState(false)
  const [availableModels, setAvailableModels] = useState<Array<ProviderPresetModel | ProviderModel>>([])
  const [isTested, setIsTested] = useState(false)
  const initializedRef = useRef<string | null>(null)

  // 加载预设
  useEffect(() => {
    if (initializedRef.current === language) return

    const init = async () => {
      try {
        setIsLoadingPresets(true)
        initializedRef.current = language
        const presets = await CloudModelConfigAPI.getCloudProvidersConfig(language)
        setProvidersPresets(presets)
        
        // 设置默认值
        if (presets.length > 0) {
          const first = presets[0]
          setDraft(prev => ({
            ...prev,
            provider: first.id,
            baseUrl: '', // 显示时使用placeholder
            model: first.models?.[0]?.id || ''
          }))
          setAvailableModels(first.models || [])
        }
      } catch (error) {
        logger.error(LogCategory.RENDERER, '加载云端预设失败:', error)
        initializedRef.current = null // 允许重试
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
      baseUrl: '',
      model: nextModels[0]?.id || '',
      apiKey: ''
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
        effectiveBaseUrl
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
      const message = error instanceof Error ? error.message : String(error)
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
      
      const finalConfig: CloudModelConfig = {
        ...draft,
        baseUrl: effectiveBaseUrl,
        modelList: (availableModels as ProviderModel[])
      }

      // 1. 先保存到云端详细配置列表（这个是通过独立的 API 管理的）
      await CloudModelConfigAPI.addConfig(finalConfig)
      
      const configs = await CloudModelConfigAPI.getConfigs()
      const index = configs.findIndex(c => c.provider === draft.provider)
      if (index >= 0) {
        await CloudModelConfigAPI.setSelectedIndex(index)
      }

      // 2. 使用 updateConfigValue 进行更新全局配置字段，确保写入 UnifiedStore
      // 这会触发一次 IPC 并同步更新本地 store
      await updateConfigValue('AI_SERVICE_MODE', 'local') // 先确保模式正确
      await updateConfigValue('AI_SERVICE_MODE', 'cloud')
      await updateConfigValue('AI_CLOUD_PROVIDER', draft.provider)
      await updateConfigValue('AI_CLOUD_API_KEY', draft.apiKey)
      await updateConfigValue('AI_CLOUD_BASE_URL', effectiveBaseUrl)
      await updateConfigValue('AI_CLOUD_SELECTED_MODEL_ID', draft.model)

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
            <p className="mt-2 text-slate-600">{t('输入您的 API 信息以连接到云端 AI 服务')}</p>
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
                          <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                        ))}
                        <SelectItem value="custom">{t('Custom（OpenAI Compatible）')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label className="text-sm font-semibold text-slate-700">{t('Base URL（可选）')}</Label>
                    <Input
                      className="h-11 border-slate-200 focus:ring-sky-500"
                      value={draft.baseUrl || ''}
                      onChange={e => setDraft(prev => ({ ...prev, baseUrl: e.target.value }))}
                      placeholder={getProviderPreset(draft.provider)?.baseUrl || 'https://api.openai.com/v1'}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <Label className="text-sm font-semibold text-slate-700">{t('API Key')}</Label>
                    <Button 
                      variant="link" 
                      className="h-auto p-0 text-sky-600 font-medium"
                      onClick={handleTestAndFetchModels}
                      disabled={isTesting || !draft.apiKey}
                    >
                      {isTesting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                      {t('测试连接并获取模型')}
                    </Button>
                  </div>
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
                </div>

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
                        <ChevronDown className={`h-5 w-5 transition-transform ${isModelListOpen ? 'rotate-180' : ''}`} />
                      </div>
                    </div>

                    {isModelListOpen && availableModels.length > 0 && (
                      <div className="absolute z-50 w-full mt-1 max-h-60 overflow-y-auto bg-white rounded-md border border-slate-200 shadow-lg">
                        {availableModels.map(model => (
                          <div
                            key={model.id}
                            className={`px-4 py-2.5 text-sm cursor-pointer flex items-center justify-between hover:bg-sky-50 ${draft.model === model.id ? 'bg-sky-50 text-sky-700' : 'text-slate-700'}`}
                            onMouseDown={(e) => {
                              e.preventDefault()
                              setDraft(prev => ({ ...prev, model: model.id }))
                              setIsModelListOpen(false)
                            }}
                          >
                            <span>{model.name || model.id}</span>
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
            <Button variant="outline" onClick={onBack} className="h-11 rounded-xl px-6 font-semibold">
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