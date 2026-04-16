import React, { useState, useEffect } from 'react'
import { useVoerkaI18n } from '@voerkai18n/react'
import { Button } from '@components/ui/button'
import { WelcomeProgress } from './WelcomeProgress'
import i18nScope from '@src/languages'
import { useSettingsStore } from '@stores/settings-store'
import { HardwareInfo } from '@yonuc/types/types'
import { Card } from '@components/ui/card'

interface OllamaModelSelectionStepProps {
  onNext: () => void
  onBack: () => void
}

export function OllamaModelSelectionStep({ onNext, onBack }: OllamaModelSelectionStepProps) {
  const { t } = useVoerkaI18n(i18nScope)
  const { updateConfigValue } = useSettingsStore()
  const [models, setModels] = useState<any[]>([])
  const [hardwareInfo, setHardwareInfo] = useState<HardwareInfo | null>(null)
  const [recommendedModelIds, setRecommendedModelIds] = useState<string[]>([])
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)
  const initializedRef = React.useRef(false)

  // 获取模型列表和硬件信息
  useEffect(() => {
    if (initializedRef.current) return
    initializedRef.current = true

    const fetchData = async () => {
      try {
        setLoading(true)
        
        // 1. 获取硬件信息
        let hwInfo: HardwareInfo | null = null
        if (typeof window.electronAPI?.getHardwareInfo === 'function') {
          hwInfo = await window.electronAPI!.getHardwareInfo()
          setHardwareInfo(hwInfo)
        }

        // 2. 获取 Ollama 模型列表
        if (!window.electronAPI?.ollama) {
          throw new Error('Ollama API not available')
        }
        const result = await window.electronAPI!.ollama.getRecommendedModels()
        
        if (result && Array.isArray(result.models)) {
          const rawModels = result.models
          
          // 3. 根据硬件推荐模型
          let recommendedIds: string[] = []
          if (hwInfo && typeof window.electronAPI?.recommendModelsByHardware === 'function') {
            try {
              const recommendation = await window.electronAPI!.recommendModelsByHardware(
                hwInfo.freeMemGB || hwInfo.totalMemGB, 
                hwInfo.hasGPU, 
                hwInfo.vramGB
              )
              recommendedIds = recommendation?.recommendedModels || []
              setRecommendedModelIds(recommendedIds)
            } catch (err) {
              console.error('获取硬件推荐模型失败:', err)
            }
          }

          // 4. 转换并设置模型
          const mappedModels = rawModels.map((m: any) => {
            // 解析显存/内存需求
            const minVram = m.minVramGB ?? m.performance?.minMemoryGB
            const isModelExceedsHardware = hwInfo?.vramGB !== undefined &&
              minVram !== undefined &&
              minVram > hwInfo.vramGB

            return {
              id: m.id,
              name: m.name,
              size: m.totalSize || m.size || '未知大小',
              desc: m.description || m.desc || '',
              tags: m.tags || [],
              recommended: recommendedIds.includes(m.id) || m.recommended || false,
              isExceedsHardware: isModelExceedsHardware,
              minVram
            }
          })

          // 排序：超出硬件限制的排在最后，推荐的排在前面
          mappedModels.sort((a: any, b: any) => {
            // 1. 硬件限制优先：未超出的排前面
            if (a.isExceedsHardware !== b.isExceedsHardware) {
              return a.isExceedsHardware ? 1 : -1
            }
            // 2. 推荐优先：推荐的排前面
            if (a.recommended !== b.recommended) {
              return a.recommended ? -1 : 1
            }
            return 0
          })

          setModels(mappedModels)
          
          // 5. 自动选择第一个推荐且符合硬件条件的模型
          // 优先选择被推荐且硬件符合的模型
          const recommendedAndFits = mappedModels.find((m: any) => m.recommended && !m.isExceedsHardware)
          // 其次选择任何推荐的模型（即使硬件可能吃紧）
          const anyRecommended = mappedModels.find((m: any) => m.recommended)
          // 再次选择第一个符合硬件的模型
          const firstFits = mappedModels.find((m: any) => !m.isExceedsHardware)
          
          const autoSelectModel = recommendedAndFits || anyRecommended || firstFits || mappedModels[0]
          
          if (autoSelectModel) {
            setSelectedModelId(autoSelectModel.id)
          }
        }
      } catch (err) {
        console.error('初始化模型选择数据失败:', err)
        setError(t('获取模型列表失败'))
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [])

  const handleModelSelect = (id: string, isExceedsHardware: boolean) => {
    if (isExceedsHardware) return
    setSelectedModelId(id)
  }

  const handleContinue = async () => {
    if (!selectedModelId) return
    // 保存选择的模型ID和平台信息
    await updateConfigValue('SELECTED_MODEL_ID', selectedModelId)
    await updateConfigValue('AI_PLATFORM', 'ollama')
    await updateConfigValue('AI_SERVICE_MODE', 'local')
    onNext()
  }

  return (
    <div className="h-full min-h-full bg-white text-slate-900 flex flex-col">
      <WelcomeProgress currentStep={4} />

      <div className="flex-grow flex flex-col overflow-hidden">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6 w-full overflow-y-auto">
          <header className="mb-6">
            <h1 className="text-2xl font-bold tracking-tight">{t('选择 AI 模型')}</h1>
            <p className="mt-2 text-slate-600">
              {t('根据您的需求选择要安装的 Ollama 模型')}
            </p>
          </header>

          {loading ? (
            <div className="flex flex-col items-center justify-center py-20">
              <div className="w-10 h-10 border-4 border-slate-200 border-t-slate-900 rounded-full animate-spin mb-4" />
              <p className="text-slate-500">{t('正在检测硬件并加载列表...')}</p>
            </div>
          ) : error ? (
            <div className="text-center py-20">
              <p className="text-red-500 mb-4">{error}</p>
              <Button onClick={() => window.location.reload()}>{t('重试')}</Button>
            </div>
          ) : (
            <>
              {/* 硬件信息展示 */}
              {hardwareInfo && (
                <Card className="rounded-xl bg-slate-50 shadow-sm ring-1 ring-slate-200 p-6 mb-6">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="w-2 h-2 rounded-full bg-sky-500 animate-pulse"></span>
                    <h2 className="text-sm font-semibold text-slate-900">{t('您的硬件检测结果')}</h2>
                  </div>
                  <dl className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
                    <div className="rounded-lg border border-slate-200 bg-white p-3">
                      <dt className="text-slate-500 mb-1">{t('GPU支持')}</dt>
                      <dd className="text-slate-900 font-bold">
                        {hardwareInfo.hasGPU && hardwareInfo.gpuModel
                          ? hardwareInfo.gpuModel
                          : hardwareInfo.hasGPU
                            ? t('已检测到独立 GPU')
                            : t('未检测到独立 GPU')}
                      </dd>
                    </div>
                    <div className="rounded-lg border border-slate-200 bg-white p-3">
                      <dt className="text-slate-500 mb-1">{t('可用显存')}</dt>
                      <dd className="text-slate-900 font-bold">
                        {hardwareInfo.hasGPU
                          ? (hardwareInfo.vramGB
                            ? `${hardwareInfo.vramGB}GB`
                            : t('检测中...'))
                          : t('无独立显存')}
                      </dd>
                    </div>
                    <div className="rounded-lg border border-slate-200 bg-white p-3">
                      <dt className="text-slate-500 mb-1">{t('内存总量')}</dt>
                      <dd className="text-slate-900 font-bold">
                        {hardwareInfo.totalMemGB ? `${hardwareInfo.totalMemGB}GB` : t('未知')}
                      </dd>
                    </div>
                  </dl>
                </Card>
              )}

              {/* 模型列表 */}
              <div className="space-y-3 mb-6">
                <div className="text-sm font-medium text-slate-500 px-1 mb-2">
                  {t('根据硬件为您推荐以下模型：')}
                </div>
                {models.map((model) => (
                  <div 
                    key={model.id}
                    onClick={() => handleModelSelect(model.id, model.isExceedsHardware)}
                    onKeyDown={(e) => e.key === 'Enter' && handleModelSelect(model.id, model.isExceedsHardware)}
                    role="button"
                    tabIndex={model.isExceedsHardware ? -1 : 0}
                    className={`flex items-center justify-between p-4 rounded-xl border-2 transition-all ${
                      model.isExceedsHardware 
                        ? 'opacity-30 cursor-not-allowed bg-slate-50 border-slate-100'
                        : selectedModelId === model.id 
                          ? 'bg-sky-50 border-sky-500 ring-1 ring-sky-500/20 cursor-pointer shadow-sm' 
                          : 'border-slate-200 hover:border-sky-200 hover:bg-slate-50 cursor-pointer'
                    }`}
                  >
                    <div className="flex-grow">
                      <div className="flex items-center gap-2">
                        <p className={`font-bold text-lg ${model.isExceedsHardware ? 'text-slate-400' : 'text-slate-900'}`}>
                          {model.name}
                        </p>
                        {model.tags.map((tag: string) => (
                          <span key={tag} className="px-2 py-0.5 rounded-full bg-slate-100 text-[10px] text-slate-600 font-medium border border-slate-200">
                            {tag}
                          </span>
                        ))}
                      </div>
                      <div className="flex items-center text-sm text-slate-500 mt-1 gap-3">
                        <span>{model.size}</span>
                        <span className="w-1 h-1 rounded-full bg-slate-300"></span>
                        <span>{model.desc}</span>
                        {model.minVram !== undefined && (
                          <>
                            <span className="w-1 h-1 rounded-full bg-slate-300"></span>
                            <span className={model.isExceedsHardware ? 'text-red-500 font-medium' : ''}>
                              {t('需 {n}GB 显存', { n: model.minVram })}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      {model.recommended && (
                        <span className="text-[10px] font-bold text-sky-600 bg-sky-100 px-2 py-1 rounded tracking-tight">{t('推荐')}</span>
                      )}
                      {model.isExceedsHardware && (
                        <span className="text-[10px] font-bold text-red-600 bg-red-100 px-2 py-1 rounded flex items-center gap-1">
                          {t('硬件不足')}
                        </span>
                      )}
                      {!model.isExceedsHardware && (
                        <div className={`w-6 h-6 rounded-full border-2 flex items-center justify-center ${
                          selectedModelId === model.id ? 'border-sky-500 bg-sky-500' : 'border-slate-300'
                        }`}>
                          {selectedModelId === model.id && (
                            <div className="w-2.5 h-2.5 rounded-full bg-white shadow-sm" />
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* 固定在底部的操作按钮 */}
        <div className="sticky bottom-0 bg-white py-4 mt-auto border-t border-slate-200 z-10 w-full shadow-[0_-4px_12px_rgba(0,0,0,0.02)]">
          <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex justify-between items-center">
              <Button
                variant="outline"
                onClick={onBack}
                className="h-11 rounded-xl px-6 font-semibold border-slate-200"
              >
                {t('返回')}
              </Button>
              
              <div className="flex items-center gap-4">
                {selectedModelId && (
                   <p className="text-xs text-slate-500 hidden sm:block">
                     {t('已选择：{model}', { model: models.find(m => m.id === selectedModelId)?.name || '' })}
                   </p>
                )}
                <Button
                  variant="default"
                  onClick={handleContinue}
                  disabled={!selectedModelId || loading}
                  className="h-11 rounded-xl bg-slate-900 px-10 font-semibold text-white hover:bg-slate-800 transition-all active:scale-95"
                >
                  {t('继续')}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
