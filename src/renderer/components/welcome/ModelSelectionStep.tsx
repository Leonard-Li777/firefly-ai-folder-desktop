import { Check, Globe, HardDrive, Info, Loader2, Star, Zap } from 'lucide-react'
import { LogCategory, logger, MODEL_SOURCES } from '@firefly/shared'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'

import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Card } from '../ui/card'
import { HardwareInfo } from '@firefly/types'
import { WelcomeProgress } from './WelcomeProgress'
import i18nScope from '@src/languages'
import { useSettingsStore } from '@stores/settings-store'
import { useVoerkaI18n } from '@voerkai18n/react'

interface ModelSelectionStepProps {
  onNext: () => void
  onBack: () => void
}

export function ModelSelectionStep({ onNext, onBack }: ModelSelectionStepProps) {
  const { t } = useVoerkaI18n(i18nScope)
  const { updateConfigValue } = useSettingsStore()

  const [models, setModels] = useState<any[]>([])
  const [hardwareInfo, setHardwareInfo] = useState<HardwareInfo | null>(null)
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null)
  const [selectedModelSource, setSelectedModelSource] = useState<string | undefined>(undefined)
  const [activeTab, setActiveTab] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const initializedRef = useRef<boolean>(false)

  const parseToGB = useCallback((str: string) => {
    const match = (str || '').match(/([\d.]+)\s*(GB|MB|KB|B)?/i)
    if (!match) return 0
    const val = parseFloat(match[1])
    const unit = (match[2] || 'GB').toUpperCase()
    switch (unit) {
      case 'MB':
        return val / 1024
      case 'KB':
        return val / (1024 * 1024)
      case 'B':
        return val / 1024 ** 3
      default:
        return val
    }
  }, [])

  const fetchData = async () => {
    try {
      setLoading(true)
      const hwInfo = await window.electronAPI!.getHardwareInfo()
      setHardwareInfo(hwInfo)

      const modelList = await window.electronAPI!.listModels()
      setModels(modelList as any)

      if (modelList && modelList.length > 0) {
        // 自动选择第一个可用的 Tab (且不是 ollama)
        const validModels = (modelList as any).filter((m: any) => m.source !== 'ollama')
        if (validModels.length > 0) {
          const firstSource = validModels[0].source || 'modelscope'
          setActiveTab(firstSource)

          if (hwInfo) {
            const userVramGB = hwInfo.vramGB || 0

            // 候选模型过滤：2GB需求以内模型或显存充足的模型
            const candidates = validModels.filter((m: any) => {
              const vramReq = m.vramRequiredGB || 0
              if (vramReq <= 2.0) return true
              return userVramGB > 1 && vramReq <= userVramGB * 1.2
            })

            if (candidates.length > 0) {
              // 在候选者中选择显存要求最高的（性能最好的）
              const bestMatch = candidates.sort(
                (a: any, b: any) => (b.vramRequiredGB || 0) - (a.vramRequiredGB || 0)
              )[0]
              setSelectedModelId(bestMatch.id)
              setSelectedModelSource(bestMatch.source)
            } else {
              // 如果没有候选者，保底选择最小的模型
              const smallestModel = [...validModels].sort(
                (a: any, b: any) => (a.vramRequiredGB || 0) - (b.vramRequiredGB || 0)
              )[0]
              setSelectedModelId(smallestModel.id)
              setSelectedModelSource(smallestModel.source)
            }
          }
        }
      }
    } catch (err) {
      console.error('获取信息失败:', err)
      setError(t('获取模型信息失败，请稍后重试'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (initializedRef.current) return
    initializedRef.current = true
    fetchData()
  }, [])

  const minModelId = useMemo(() => {
    if (models.length === 0) return null
    return [...models].sort((a, b) => (a.vramRequiredGB || 0) - (b.vramRequiredGB || 0))[0]?.id
  }, [models])

  const groupedModels = useMemo(() => {
    const groups: Record<string, any[]> = {}
    models.forEach(m => {
      const s = m.source || 'modelscope'
      if (s === 'ollama') return // 物理隔离 Ollama

      const vramReq = m.vramRequiredGB || 0
      const isCpuMode = vramReq <= 2.0

      if (!groups[s]) groups[s] = []
      groups[s].push({ ...m, isCpuMode })
    })

    Object.keys(groups).forEach(s => {
      const group = groups[s]
      const userVramGB = hardwareInfo?.vramGB || 0

      // 智能推荐逻辑：
      // 1. 如果有显存，推荐显存范围内最大的（不超过 1.2 倍）
      // 2. 如果无显存，推荐 1GB 以内的模型中最大的
      const groupCandidates = group.filter((m: any) => {
        if (m.isCpuMode) return true // 2GB 需求以内始终可选
        return userVramGB > 1 && (m.vramRequiredGB || 0) <= userVramGB * 1.2
      })

      const groupBestId =
        groupCandidates.length > 0
          ? groupCandidates.sort((a, b) => (b.vramRequiredGB || 0) - (a.vramRequiredGB || 0))[0].id
          : group.length > 0
            ? [...group].sort((a, b) => (a.vramRequiredGB || 0) - (b.vramRequiredGB || 0))[0].id
            : null

      groups[s] = group
        .map(m => ({ ...m, isBestInTab: m.id === groupBestId }))
        .sort((a, b) => {
          if (a.isBestInTab !== b.isBestInTab) return a.isBestInTab ? -1 : 1

          // 显存超标判定逻辑更新
          const checkEx = (item: any) =>
            !item.isCpuMode && (userVramGB === 0 || (item.vramRequiredGB || 0) > userVramGB * 1.05)
          const aEx = checkEx(a)
          const bEx = checkEx(b)

          if (aEx !== bEx) return aEx ? 1 : -1
          return (a.vramRequiredGB || 0) - (b.vramRequiredGB || 0)
        })
    })
    return groups
  }, [models, hardwareInfo, parseToGB])

  const sourceList = useMemo(() => Object.keys(groupedModels), [groupedModels])

  const handleNext = async () => {
    if (selectedModelId) {
      updateConfigValue('SELECTED_MODEL_ID', selectedModelId)
      // 同时保存模型来源，以便后端精确查询模型配置
      updateConfigValue('SELECTED_MODEL_SOURCE', selectedModelSource)
      onNext()
    }
  }

  return (
    <div className="bg-slate-50 text-slate-900 flex flex-col h-full overflow-hidden">
      <WelcomeProgress currentStep={3} />

      {/* 滚动内容区 */}
      <div className="flex-grow overflow-y-auto">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
          <header className="mb-10 text-center">
            <h1 className="text-4xl font-black tracking-tight text-slate-900 mb-4">
              {t('选择您的 AI 模型')}
            </h1>
            <p className="text-slate-500 font-medium">
              {t('系统已根据您的显存配置自动为您标记了各平台的最佳选项')}
            </p>
          </header>

          <div className="grid grid-cols-3 gap-4 mb-8">
            <Card className="p-4 rounded-2xl bg-white border-slate-100 shadow-sm">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">
                {t('显卡模型')}
              </p>
              <p className="text-sm font-bold text-slate-900 truncate">
                {hardwareInfo?.gpuModel || t('未检测到')}
              </p>
            </Card>
            <Card className="p-4 rounded-2xl bg-white border-slate-100 shadow-sm">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">
                {t('可用显存')}
              </p>
              <p className="text-sm font-bold text-slate-900">
                {hardwareInfo?.vramGB ? `${hardwareInfo.vramGB}GB` : t('未知')}
              </p>
            </Card>
            <Card className="p-4 rounded-2xl bg-white border-slate-100 shadow-sm">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">
                {t('硬盘空间')}
              </p>
              <p className="text-sm font-bold text-slate-900">
                {hardwareInfo?.storageFreeGB ? `${hardwareInfo.storageFreeGB}GB` : t('未知')}
              </p>
            </Card>
          </div>

          <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col">
            <TabsList className="bg-slate-100/50 p-1.5 rounded-2xl self-start mb-6">
              {sourceList.map(s => (
                <TabsTrigger
                  key={s}
                  value={s}
                  className="rounded-xl px-6 py-2.5 text-xs font-black uppercase tracking-widest data-[state=active]:bg-white data-[state=active]:text-slate-900 data-[state=active]:shadow-xl transition-all"
                >
                  {(MODEL_SOURCES as any)[s]?.name || s}
                  <Badge
                    variant="secondary"
                    className="ml-2 bg-slate-200/50 text-slate-500 border-none px-1.5"
                  >
                    {(groupedModels[s] || []).length}
                  </Badge>
                </TabsTrigger>
              ))}
            </TabsList>

            {sourceList.map(s => (
              <TabsContent key={s} value={s} className="mt-0 outline-none">
                <div className="bg-sky-50/50 border border-sky-100 rounded-2xl p-4 mb-6 flex gap-3 items-start">
                  <Info className="w-5 h-5 text-sky-500 shrink-0 mt-0.5" />
                  <p className="text-xs font-medium text-sky-700 leading-relaxed">
                    {(MODEL_SOURCES as any)[s]?.description}
                  </p>
                </div>

                <div className="grid grid-cols-1 gap-3 pb-4">
                  {(groupedModels[s] || []).map(m => {
                    const userVramGB = hardwareInfo?.vramGB || 0
                    const vramReq = m.vramRequiredGB || 0

                    // 显存超标判定逻辑更新：
                    // 1. 如果是 CPU 模式（2GB需求以内），则永远不是显存不足
                    // 2. 如果不是 CPU 模式：
                    //    - 如果显存 <= 1GB，则显存不足（因为该模型需求 > 2GB）
                    //    - 如果显存 > 1GB，但不足以运行该模型（需求 > 可用*1.2），则显存不足
                    const isEx = !m.isCpuMode && (userVramGB <= 1 || vramReq > userVramGB * 1.2)

                    return (
                      <div
                        key={m.id}
                        onClick={() =>
                          !isEx && (setSelectedModelId(m.id), setSelectedModelSource(m.source))
                        }
                        className={`relative flex items-center justify-between p-5 rounded-2xl border-2 transition-all cursor-pointer ${isEx ? 'opacity-40 grayscale border-slate-100 bg-slate-50' : selectedModelId === m.id ? 'bg-white border-sky-500 shadow-xl ring-4 ring-sky-500/5' : 'bg-white border-slate-100 hover:border-sky-200'}`}
                      >
                        <div className="flex items-center gap-4 flex-grow">
                          <div
                            className={`p-3 rounded-xl ${selectedModelId === m.id ? 'bg-sky-500 text-white' : 'bg-slate-100 text-slate-400'}`}
                          >
                            <Globe className="h-5 w-5" />
                          </div>
                          <div className="flex-grow">
                            <div className="flex items-center gap-2 mb-1">
                              <h3 className="font-black text-slate-900 text-sm tracking-tight">
                                {m.name}
                              </h3>
                              {m.isBestInTab && (
                                <Badge className="bg-amber-400 hover:bg-amber-400 text-slate-900 text-[9px] font-black h-4 px-1.5 uppercase tracking-tighter border-none">
                                  <Star className="w-2 h-2 mr-1 fill-current" />
                                  {t('最佳推荐')}
                                </Badge>
                              )}
                              {m.isCpuMode && (
                                <Badge className="bg-green-500 hover:bg-green-500 text-white text-[9px] font-black h-4 px-1.5 uppercase tracking-tighter border-none">
                                  {t('CPU 兼容模式')}
                                </Badge>
                              )}
                            </div>
                            <div className="flex items-center gap-4 text-[10px] font-black text-slate-400 uppercase tracking-tight mb-2">
                              <div className="flex items-center gap-1">
                                <HardDrive className="h-3.5 w-3.5" />
                                {m.totalSize || m.totalSizeText || 'N/A'}
                              </div>
                              <div className="flex items-center gap-1">
                                <Zap
                                  className={`h-3.5 w-3.5 ${isEx ? 'text-rose-500' : 'text-amber-500'}`}
                                />
                                <span className={isEx ? 'text-rose-500' : ''}>
                                  {typeof vramReq === 'number' ? Math.ceil(vramReq) : 'N/A'}GB{' '}
                                  {t('建议显存')}
                                </span>
                              </div>
                            </div>
                            <p className="text-xs font-medium text-slate-500 line-clamp-1">
                              {m.description}
                            </p>
                          </div>
                        </div>
                        <div className="flex flex-col items-end gap-2 ml-4">
                          <div className="flex flex-wrap gap-1">
                            {(m.tags || []).map((tag: string) => (
                              <Badge
                                key={tag}
                                variant="outline"
                                className="text-[9px] font-black h-4 px-1.5 bg-slate-50 text-slate-500 border-slate-200 uppercase tracking-tighter"
                              >
                                {tag}
                              </Badge>
                            ))}
                          </div>
                          {isEx && m.id !== minModelId && (
                            <Badge
                              variant="destructive"
                              className="text-[9px] font-black h-4 px-1.5 uppercase tracking-tighter"
                            >
                              {t('显存不足')}
                            </Badge>
                          )}
                          {selectedModelId === m.id && (
                            <div className="h-6 w-6 rounded-full bg-sky-500 flex items-center justify-center text-white shadow-lg">
                              <Check className="h-4 w-4 stroke-[3]" />
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </TabsContent>
            ))}
          </Tabs>
        </div>
      </div>

      {/* 固定吸底的操作栏 */}
      <footer className="border-t border-slate-200 bg-white/80 backdrop-blur-md py-6 px-8 z-20 shadow-[0_-4px_20px_-5px_rgba(0,0,0,0.05)]">
        <div className="max-w-5xl mx-auto flex justify-between items-center">
          <Button
            variant="ghost"
            onClick={onBack}
            className="rounded-xl font-bold text-slate-400 hover:text-slate-900 transition-all px-8 h-11"
          >
            {t('返回')}
          </Button>

          <Button
            disabled={!selectedModelId || loading}
            onClick={handleNext}
            className="h-11 rounded-xl bg-slate-900 px-16 font-black text-white hover:bg-sky-600 active:scale-95 transition-all shadow-xl shadow-slate-900/10"
          >
            {loading ? <Loader2 className="h-5 w-5 animate-spin mr-2" /> : null}
            {t('继续安装')}
          </Button>
        </div>
      </footer>
    </div>
  )
}
