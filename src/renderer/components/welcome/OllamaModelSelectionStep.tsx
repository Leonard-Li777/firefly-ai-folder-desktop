import { useVoerkaI18n } from '@voerkai18n/react'
import i18nScope from '@src/languages'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@components/ui/tabs'
import { Badge } from '@components/ui/badge'
import { Globe, Star, Sparkles, Info, Cpu, HardDrive, Zap, Check, RefreshCw } from 'lucide-react'
import { Button } from '../ui/button'
import { MODEL_SOURCES, groupAndSortModels } from '@firefly/shared'
import { HardwareInfo, ModelSource, TModelSource, IModelSummary } from '@firefly/types'
import React, { useState, useEffect, useMemo } from 'react'
import { useModelStore } from '../../stores/model-store'
import { useSettingsStore } from '../../stores/settings-store'
import { Card } from '../ui/card'
import { WelcomeProgress } from './WelcomeProgress'

interface OllamaModelSelectionStepProps {
  onNext: () => void
  onBack: () => void
}

export function OllamaModelSelectionStep({ onNext, onBack }: OllamaModelSelectionStepProps) {
  const { t } = useVoerkaI18n(i18nScope)
  const { updateConfigValue } = useSettingsStore()
  const { setModelName } = useModelStore()
  const [models, setModels] = useState<any[]>([])
  const [hardwareInfo, setHardwareInfo] = useState<HardwareInfo | null>(null)
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<string>('modelscope')
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)
  const initializedRef = React.useRef(false)

  useEffect(() => {
    if (initializedRef.current) return
    initializedRef.current = true

    const fetchData = async () => {
      try {
        setLoading(true)
        console.log('[OllamaStep] 正在初始化数据...')

        let hwInfo: HardwareInfo | null = null
        try {
          hwInfo = await window.electronAPI!.getHardwareInfo()
          setHardwareInfo(hwInfo)
        } catch (e) {
          console.error('硬件信息获取失败', e)
        }

        // 统一使用 listModels 接口 (它已在后端根据 ai-engine 路由到正确的 UnifiedModelManager 逻辑)
        const modelList = await window.electronAPI!.listModels()

        if (modelList && Array.isArray(modelList)) {
          setModels(modelList)

          // 初始自动选择：使用共享逻辑计算出的最佳推荐
          const grouped = groupAndSortModels(modelList as IModelSummary[], hwInfo) as Record<
            string,
            IModelSummary[]
          >
          let firstBestModel: any = null

          // 寻找第一个组里的最佳模型
          for (const s of Object.keys(grouped)) {
            const best = grouped[s].find(m => m.isBest)
            if (best) {
              firstBestModel = best
              break
            }
          }

          if (firstBestModel) {
            setSelectedModelId(firstBestModel.id)
            if (firstBestModel.source)
              setActiveTab(firstBestModel.source)
              // 兼容性存储，用于其他可能的逻辑
            ;(window as any)._computedBestOllamaId = firstBestModel.id
          }
        }
      } catch (err) {
        console.error('[OllamaStep] 初始化失败:', err)
        setError(t('获取模型列表失败'))
      } finally {
        setLoading(false)
      }
    }
    fetchData()
  }, [])

  // 计算每个 Tab 中的最佳推荐模型
  const groupedModels = useMemo(() => {
    return groupAndSortModels(models, hardwareInfo)
  }, [models, hardwareInfo])

  const handleContinue = async () => {
    if (!selectedModelId) return
    const model = models.find(m => m.id === selectedModelId)
    await updateConfigValue('SELECTED_MODEL_ID', selectedModelId)
    // Ollama 引擎的模型来源固定为 'ollama'
    await updateConfigValue('SELECTED_MODEL_SOURCE', 'ollama')
    await updateConfigValue('AI_ENGINE', 'ollama')
    await updateConfigValue('AI_SERVICE_MODE', 'local')
    if (model) setModelName(model.name)
    onNext()
  }

  if (loading)
    return (
      <div className="h-full bg-white flex flex-col">
        <WelcomeProgress currentStep={4} />
        <div className="flex-grow flex items-center justify-center flex-col gap-4">
          <RefreshCw className="w-10 h-10 animate-spin text-sky-500" />
          <p className="font-black text-slate-400 uppercase tracking-widest">
            {t('正在加载 Ollama 模型列表...')}
          </p>
        </div>
      </div>
    )

  const sourceList = (Object.keys(MODEL_SOURCES) as TModelSource[]).filter(
    s => (groupedModels[s]?.length ?? 0) > 0
  )

  return (
    <div className="h-full bg-white text-slate-900 flex flex-col font-sans">
      <WelcomeProgress currentStep={4} />
      <div className="flex-grow flex flex-col overflow-hidden max-w-5xl mx-auto px-4 py-6 w-full overflow-y-auto">
        <header className="mb-6 text-center">
          <h1 className="text-3xl font-black tracking-tight">{t('选择您的 AI 模型')}</h1>
          <p className="mt-2 text-slate-500 font-medium">
            {t('根据您的显存配置，系统已为每个平台标记了最佳推荐选项')}
          </p>
        </header>

        {hardwareInfo && (
          <Card className="p-5 bg-slate-50 border-none shadow-inner grid grid-cols-3 gap-4 mb-6">
            <div className="flex flex-col">
              <span className="text-[10px] font-black text-slate-400 uppercase leading-none mb-1">
                {t('显卡模型')}
              </span>
              <span className="text-xs font-black text-slate-700 truncate">
                {hardwareInfo.gpuModel || t('正在检测...')}
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] font-black text-slate-400 uppercase leading-none mb-1">
                {t('可用显存')}
              </span>
              <span className="text-sm font-black text-slate-800">
                {hardwareInfo.vramGB !== undefined ? `${hardwareInfo.vramGB}GB` : 'N/A'}
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] font-black text-slate-400 uppercase leading-none mb-1">
                {t('系统内存')}
              </span>
              <span className="text-sm font-black text-slate-800">
                {hardwareInfo.totalMemGB !== undefined ? `${hardwareInfo.totalMemGB}GB` : 'N/A'}
              </span>
            </div>
          </Card>
        )}

        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="grid w-full grid-cols-2 lg:grid-cols-3 mb-6 bg-slate-100 p-1.5 rounded-2xl h-16">
            {sourceList.map(s => (
              <TabsTrigger
                key={s}
                value={s}
                className="rounded-xl font-black text-sm py-3 px-4 text-slate-900 data-[state=active]:bg-gradient-to-b data-[state=active]:from-white data-[state=active]:to-slate-50 data-[state=active]:text-sky-600 data-[state=active]:shadow-lg data-[state=active]:ring-2 data-[state=active]:ring-sky-200 data-[state=active]:border-sky-100 transition-all border border-transparent"
              >
                <Globe className="w-4 h-4 mr-2" />
                {MODEL_SOURCES[s].name}
                <span className="ml-2.5 text-[11px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-400 data-[state=active]:bg-sky-100 data-[state=active]:text-sky-600">
                  {(groupedModels[s] || []).length}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>

          {sourceList.map(s => (
            <TabsContent key={s} value={s} className="space-y-4 focus-visible:ring-0 m-0">
              <div className="flex items-start gap-3 p-4 bg-sky-50 rounded-2xl border border-sky-100 italic text-xs text-sky-800 font-medium">
                <Info className="w-4 h-4 shrink-0 text-sky-500" />
                {MODEL_SOURCES[s].description}
              </div>
              <div className="grid grid-cols-1 gap-3 pb-10">
                {(groupedModels[s] || []).map(m => (
                  <div
                    key={m.id}
                    onClick={() => setSelectedModelId(m.id)}
                    className={`relative flex items-center justify-between p-5 rounded-2xl border-2 transition-all cursor-pointer ${m.isEx ? 'opacity-40 grayscale border-slate-100 bg-slate-50' : selectedModelId === m.id ? 'bg-sky-50 border-sky-500 shadow-xl ring-4 ring-sky-500/10' : 'bg-white border-slate-100 hover:border-sky-200'}`}
                  >
                    {' '}
                    <div className="flex-grow pr-4">
                      <div className="flex items-center gap-2 mb-2 flex-wrap">
                        <h4 className="font-black text-lg text-slate-900">{m.name}</h4>
                        <div className="flex gap-1.5 flex-wrap">
                          {m.recommended && (
                            <Badge className="text-[10px] font-black h-5 px-2 bg-amber-500 text-white border-none shadow-md flex items-center gap-1 animate-pulse">
                              <Star className="h-3.5 w-3.5 fill-current text-white" />{' '}
                              {t('推荐')}
                            </Badge>
                          )}
                          {m.isBest && (
                            <Badge className="text-[10px] font-black h-5 px-2 bg-gradient-to-r from-blue-500 to-indigo-600 text-white border-none shadow-md flex items-center gap-1">
                              <Sparkles className="h-3.5 w-3.5 fill-current text-white" />{' '}
                              {t('最佳推荐')}
                            </Badge>
                          )}
                          {(m.vramRequiredGB || 0) < 2 && (
                            <Badge className="text-[10px] font-black h-5 px-2 bg-green-600 text-white border-none shadow-md flex items-center gap-1">
                              <Cpu className="h-3 w-3" />
                              {t('CPU 兼容模式')}
                            </Badge>
                          )}
                          {m.parameterSize && (
                            <Badge
                              variant="outline"
                              className="text-[9px] font-black h-4 px-1.5 bg-slate-50 text-slate-500 border-slate-200 uppercase tracking-tighter"
                            >
                              {m.parameterSize}
                            </Badge>
                          )}
                          {(m.tags || []).map((tag: string) => (
                            <Badge
                              key={tag}
                              variant="outline"
                              className="text-[9px] font-black h-4 px-1.5 bg-slate-50 text-slate-500 border-slate-200 uppercase tracking-tighter"
                            >
                              {tag}
                            </Badge>
                          ))}
                          {m.isEx && (
                            <Badge
                              variant="destructive"
                              className="text-[9px] font-black h-4 px-1.5 uppercase tracking-tighter"
                            >
                              {t('显存不足')}
                            </Badge>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-4 text-[10px] font-black text-slate-400 uppercase tracking-tight mb-2">
                        <div className="flex items-center gap-1">
                          <HardDrive className="h-3.5 w-3.5" />
                          {m.totalSize || 'N/A'}
                        </div>
                        <div className="flex items-center gap-1">
                          <Zap
                            className={`h-3.5 w-3.5 ${m.isEx && (m.vramRequiredGB || 0) >= 2 ? 'text-rose-500' : 'text-amber-500'}`}
                          />
                          <span
                            className={
                              m.isEx && (m.vramRequiredGB || 0) >= 2 ? 'text-rose-500' : ''
                            }
                          >
                            {typeof m.vramRequiredGB === 'number'
                              ? Math.ceil(m.vramRequiredGB)
                              : 'N/A'}
                            GB {t('建议显存')}
                          </span>
                        </div>
                        {(m.vramRequiredGB || 0) < 2 && (
                          <div className="flex items-center gap-1 text-green-600">
                            <Info className="h-3 w-3" />
                            <span>{t('低配显存/无显存亦可流畅运行')}</span>
                          </div>
                        )}
                        {m.capabilities && m.capabilities.length > 0 && (
                          <div className="flex items-center gap-1.5 bg-slate-100/50 px-2 py-0.5 rounded-full border border-slate-200 text-slate-500">
                            <span className="opacity-60 font-black text-[9px]">{t('支持：')}</span>
                            <div className="flex flex-wrap gap-1">
                              {m.capabilities.map((c: any, i: number) => (
                                <span
                                  key={i}
                                  className="text-[9px] font-black text-slate-600 uppercase"
                                >
                                  {typeof c === 'string' ? c : c.type || 'TEXT'}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                      <p className="text-xs text-slate-500 line-clamp-2 font-medium italic opacity-80 leading-relaxed">
                        {m.description}
                      </p>
                    </div>
                    <div
                      className={`w-10 h-10 rounded-full border-4 shrink-0 flex items-center justify-center transition-all ${selectedModelId === m.id ? 'border-sky-500 bg-sky-500 scale-110 shadow-lg shadow-sky-500/20' : 'border-slate-200'}`}
                    >
                      {selectedModelId === m.id && (
                        <div className="w-3 h-3 rounded-full bg-white shadow-inner" />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </TabsContent>
          ))}
        </Tabs>
      </div>
      <div className="bg-white/80 backdrop-blur-md py-6 border-t border-slate-200 mt-auto">
        <div className="max-w-5xl mx-auto px-4 flex justify-between items-center">
          <Button
            variant="ghost"
            onClick={onBack}
            className="h-12 rounded-2xl px-8 font-black text-slate-400 hover:text-slate-600 transition-colors"
          >
            {t('返回')}
          </Button>
          <div className="flex items-center gap-6">
            {selectedModelId && (
              <div className="text-right hidden sm:block">
                <p className="text-[10px] font-black text-slate-300 uppercase tracking-widest leading-none mb-1">
                  {t('当前选择')}
                </p>
                <p className="text-sm font-black text-slate-900 leading-none">
                  {models.find(m => m.id === selectedModelId)?.name}
                </p>
              </div>
            )}
            <Button
              onClick={handleContinue}
              disabled={!selectedModelId}
              className="h-12 rounded-2xl bg-slate-900 px-12 font-black text-white hover:bg-sky-600 active:scale-95 transition-all shadow-lg shadow-slate-900/10"
            >
              {t('继续')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
