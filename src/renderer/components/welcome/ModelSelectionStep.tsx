import { useState, useEffect, useRef, useMemo } from 'react'
import { useVoerkaI18n } from '@voerkai18n/react'
import { Card } from '@components/ui/card'
import { Button } from '@components/ui/button'
import { useSettingsStore } from '@stores/settings-store'
import { ModelSummary, HardwareInfo } from '@yonuc/types/types'
import i18nScope from '@src/languages'
import { WelcomeProgress } from './WelcomeProgress'
import { cn } from '@lib/utils'

interface ModelSelectionStepProps {
  onNext: () => void
  onBack: () => void
}

export function ModelSelectionStep({ onNext, onBack }: ModelSelectionStepProps) {
  const { t } = useVoerkaI18n(i18nScope)
  const { updateConfigValue } = useSettingsStore()

  const [models, setModels] = useState<ModelSummary[]>([])
  const [hardwareInfo, setHardwareInfo] = useState<HardwareInfo | null>(null)
  const [recommendedModelIds, setRecommendedModelIds] = useState<string[]>([])
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [hardwareCheckComplete, setHardwareCheckComplete] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const initializedRef = useRef<boolean>(false)

  // 获取模型列表和硬件信息
  useEffect(() => {
    if (initializedRef.current) return

    const fetchData = async () => {
      try {
        setLoading(true)
        initializedRef.current = true
        
        // 第一步：获取硬件信息（优先级最高）
        const hwInfo = await window.electronAPI!.getHardwareInfo()
        setHardwareInfo(hwInfo)
        setHardwareCheckComplete(true)

        // 捕获硬件信息
        if (hwInfo) {
          // captureEvent 可能未定义，移除该调用
          console.log('硬件信息:', {
            hasGPU: hwInfo.hasGPU,
            gpuModel: hwInfo.gpuModel,
            vramGB: hwInfo.vramGB,
            totalMemGB: hwInfo.totalMemGB,
            freeMemGB: hwInfo.freeMemGB,
            storageFreeGB: hwInfo.storageFreeGB,
            os: window.navigator.platform
          })
        }

        // 第二步：获取模型列表
        const modelList = await window.electronAPI!.listModels()
        // 类型断言：IModelSummary[] -> ModelSummary[]
        setModels(modelList as any)

        // 第三步：根据硬件信息推荐模型
        if (modelList && modelList.length > 0 && hwInfo) {
          try {
            const recommendation = await window.electronAPI!.recommendModelsByHardware(
              hwInfo.freeMemGB || hwInfo.totalMemGB,
              hwInfo.hasGPU,
              hwInfo.vramGB
            );
            const recommendedIds = recommendation?.recommendedModels || [];
            setRecommendedModelIds(recommendedIds);

            // 自动选择逻辑
            const currentVram = hwInfo.vramGB;

            // 1. 优先选择推荐且硬件符合的模型
            const recommendedAndFits = (modelList as any).find((m: ModelSummary) =>
              recommendedIds.includes(m.id) &&
              (m.minVramGB === undefined || currentVram === undefined || m.minVramGB <= currentVram)
            );

            // 2. 其次选择任何推荐的模型
            const anyRecommended = (modelList as any).find((m: ModelSummary) => recommendedIds.includes(m.id));

            // 3. 再次选择第一个符合硬件的模型
            const firstFits = (modelList as any).find((m: ModelSummary) =>
              (m.minVramGB === undefined || currentVram === undefined || m.minVramGB <= currentVram)
            );

            const autoSelectId = recommendedAndFits?.id || anyRecommended?.id || firstFits?.id || modelList[0].id;
            setSelectedModelId(autoSelectId);
            
          } catch (err) {
            console.error('获取推荐模型失败:', err);
            setSelectedModelId(modelList[0].id);
          }
        } else if (modelList.length > 0) {
          setSelectedModelId(modelList[0].id);
        }
      } catch (err) {
        console.error('获取模型或硬件信息失败:', err)
        setError(t('获取模型信息失败，请稍后重试'))
        initializedRef.current = false
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [])

  // 对模型进行排序：将超出显存限制的模型排到最后
  const sortedModels = useMemo(() => {
    if (!hardwareInfo?.vramGB || models.length === 0) return models;

    const currentVramGB = hardwareInfo.vramGB;
    const fits: ModelSummary[] = [];
    const exceeds: ModelSummary[] = [];

    models.forEach(model => {
      const isExceeds = model.minVramGB !== undefined && model.minVramGB > currentVramGB;
      if (isExceeds) {
        exceeds.push(model);
      } else {
        fits.push(model);
      }
    });

    return [...fits, ...exceeds];
  }, [models, hardwareInfo]);

  const handleModelSelect = (modelId: string) => {
    setSelectedModelId(modelId)
  }

  const handleNext = async () => {
    if (!selectedModelId) return

    try {
      await updateConfigValue('SELECTED_MODEL_ID', selectedModelId)
      await updateConfigValue('AI_PLATFORM', 'llama.cpp')
      await updateConfigValue('AI_SERVICE_MODE', 'local')
      onNext()
    } catch (err) {
      console.error('保存模型选择失败:', err)
      setError(t('保存模型选择失败，请稍后重试'))
    }
  }

  // 获取性能描述文本
  const getPerformanceText = (performance: 'very_fast' | 'fast' | 'medium' | 'slow') => {
    switch (performance) {
      case 'very_fast': return t('極快')
      case 'fast': return t('快速')
      case 'medium': return t('中等')
      case 'slow': return t('缓慢')
      default: return performance
    }
  }

  if (loading) {
    return (
      <div className="h-screen min-h-screen bg-slate-50 text-slate-900 flex flex-col">
        <WelcomeProgress currentStep={3} />
        <div className="flex-grow flex items-center justify-center">
          <div className="text-center">
            <div className="inline-block animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-sky-500 mb-4"></div>
            <p>{t('正在加载模型信息...')}</p>
          </div>
        </div>
      </div>
    )
  }

  // 硬件检查未完成时，显示检查进度，不显示模型列表
  if (!hardwareCheckComplete) {
    return (
      <div className="h-screen min-h-screen bg-slate-50 text-slate-900 flex flex-col">
        <WelcomeProgress currentStep={3} />
        <div className="flex-grow flex items-center justify-center">
          <div className="text-center">
            <div className="inline-block animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-sky-500 mb-4"></div>
            <p className="text-lg font-medium mb-2">{t('正在检测硬件信息...')}</p>
            <p className="text-slate-600 text-sm">{t('请稍候，这可能需要几秒钟')}</p>
          </div>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="h-screen min-h-screen bg-slate-50 text-slate-900 flex flex-col">
        <WelcomeProgress currentStep={3} />
        <div className="flex-grow flex items-center justify-center">
          <div className="text-center">
            <p className="text-red-500 mb-4">{error}</p>
            <Button onClick={() => window.location.reload()}>
              {t('重试')}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="xbg-slate-50 text-slate-900 flex flex-col h-full">
      <WelcomeProgress currentStep={3} />

      {/* 主要内容区域 */}
      <div className="flex-grow overflow-hidden">
        <div className="h-full flex flex-col">
          <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6 overflow-auto">
            <header className="mb-6">
              <h1 className="text-2xl font-bold tracking-tight">{t('为您硬件推荐的模型')}</h1>
              <p className="mt-2 text-slate-600">{t('根据您的设备性能选择要安装的模型')}</p>
            </header>

            {/* 硬件信息展示 */}
            {hardwareInfo && (
              <>
                <Card className="rounded-xl bg-white shadow-sm ring-1 ring-slate-200 p-6 mb-6">
                  <h2 className="text-sm font-semibold text-slate-900">{t('您的硬件信息')}</h2>
                  <dl className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
                    <div className="rounded-lg border border-slate-200 p-3">
                      <dt className="text-slate-500">{t('GPU支持')}</dt>
                      <dd className="text-slate-500 font-medium">
                        {hardwareInfo.hasGPU && hardwareInfo.gpuModel
                          ? hardwareInfo.gpuModel
                          : hardwareInfo.hasGPU
                            ? t('是')
                            : t('否')}
                      </dd>
                    </div>
                    <div className="rounded-lg border border-slate-200 p-3">
                      <dt className="text-slate-500">{t('显存')}</dt>
                      <dd className="text-slate-500 font-medium" title={hardwareInfo.vramSource ? t(`来自${hardwareInfo.vramSource}`) : ''}>
                        {hardwareInfo.hasGPU
                          ? (hardwareInfo.vramGB
                            ? `${hardwareInfo.vramGB}GB`
                            : t('检测中...'))
                          : t('无独立显存')}
                      </dd>
                    </div>
                    <div className="rounded-lg border border-slate-200 p-3">
                      <dt className="text-slate-500">{t('存储空间')}</dt>
                      <dd className="text-slate-500 font-medium">
                        {hardwareInfo.storageFreeGB ? `${hardwareInfo.storageFreeGB}GB ${t('可用')}` : t('未知')}
                      </dd>
                    </div>
                  </dl>
                </Card>

                {/* 显存不足警告 */}
                {hardwareInfo.vramGB !== undefined && hardwareInfo.vramGB < 2 && (
                  <Card className="rounded-xl bg-amber-50 border-amber-200 ring-1 ring-amber-200 p-6 mb-6">
                    <div className="flex gap-4">
                      <div className="flex-shrink-0">
                        <svg className="h-6 w-6 text-amber-600" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c.866 1.5 2.926 2.875 5.303 2.875s4.437-1.375 5.303-2.875m0 0a3.75 3.75 0 11-7.5 0m7.5 0a3.75 3.75 0 1-7.5 0" />
                        </svg>
                      </div>
                      <div>
                        <h3 className="text-sm font-semibold text-amber-900">{t('显存不足')}</h3>
                        <p className="mt-2 text-sm text-amber-800">
                          {t('您的显存小于2GB，无法使用本地模式。建议返回上一步选择云端AI服务。')}
                        </p>
                      </div>
                    </div>
                  </Card>
                )}
              </>
            )}

            {/* 模型列表 */}
            <div className="h-[calc(100vh-600px)] overflow-y-auto rounded-lg ring-1 ring-slate-200 bg-white scrollbar-thin scrollbar-thumb-slate-400 scrollbar-track-slate-100 scrollbar-thumb-rounded-full scrollbar-track-rounded-full">
              <table className="min-w-full">
                <thead>
                  <tr className="bg-slate-50">
                    <th scope="col" className="w-8 p-4 text-left text-sm font-medium text-slate-900">
                      <span className="sr-only">{t('选择模型')}</span>
                    </th>
                    <th scope="col" className="min-w-[120px] p-4 text-left text-sm font-medium text-slate-900">
                      {t('模型名称')}
                    </th>
                    <th scope="col" className="p-4 text-left text-sm font-medium text-slate-900">
                      {t('显存')}
                    </th>
                    <th scope="col" className="p-4 text-left text-sm font-medium text-slate-900 whitespace-nowrap">
                      {t('性能')}
                    </th>
                    <th scope="col" className="p-4 text-left text-sm font-medium text-slate-900">
                      {t('功能')}
                    </th>
                    <th scope="col" className="p-4 text-left text-sm font-medium text-slate-900">
                      {t('推荐理由')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sortedModels.map((model) => {
                    const isModelExceedsVRAM = hardwareInfo?.vramGB !== undefined &&
                      model.minVramGB !== undefined &&
                      model.minVramGB > hardwareInfo.vramGB;

                    return (
                      <tr
                        key={model.id}
                        className={cn(
                          "border-t border-slate-200 cursor-pointer transition-colors",
                          selectedModelId === model.id ? "bg-sky-50" : "hover:bg-slate-50",
                          isModelExceedsVRAM && "opacity-50"
                        )}
                        onClick={() => !isModelExceedsVRAM && handleModelSelect(model.id)}
                      >
                        <td className="p-4">
                          <input
                            type="radio"
                            name="model"
                            checked={selectedModelId === model.id}
                            readOnly
                            disabled={isModelExceedsVRAM}
                            className="h-4 w-4 text-sky-600 focus:ring-sky-500"
                          />
                        </td>
                        <td className="p-4 font-medium text-slate-900">
                          <div className="flex items-center gap-2">
                            {model.name} {model.parameterSize}
                            {recommendedModelIds.includes(model.id) && (
                              <span className="inline-flex items-center rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-800">
                                {t('推荐')}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="p-4 text-slate-500">{model.minVramGB ? `${model.minVramGB}GB` : 'N/A'}</td>
                        <td className="p-4 text-slate-500">{getPerformanceText(model.performance.speed)}</td>
                        <td className="p-4 text-slate-500">{model.capabilities.join(', ')}</td>
                        <td className="p-4 text-slate-500">{model.description}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* 固定在底部的操作按钮 */}
          <div className="flex-shrink-0 bg-slate-50 py-4 mt-auto border-t border-slate-200">
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
                  disabled={!selectedModelId || !hardwareCheckComplete || (hardwareInfo?.vramGB !== undefined && hardwareInfo.vramGB < 2)}
                  className="h-11 rounded-xl bg-slate-900 px-10 font-semibold text-white hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed"
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
