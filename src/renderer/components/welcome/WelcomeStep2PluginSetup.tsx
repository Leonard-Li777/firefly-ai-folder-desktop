import React, { useState, useEffect, useMemo } from 'react'
import { useVoerkaI18n } from '@voerkai18n/react'
import i18nScope from '@src/languages'
import { Card, CardContent } from '@components/ui/card'
import { Button } from '@components/ui/button'
import { Badge } from '@components/ui/badge'
import { Checkbox } from '@components/ui/checkbox'
import { ProgressBar } from '@components/ui/ProgressBar'
import {
  Cpu,
  HardDrive,
  ShieldAlert,
  Mic,
  Volume2,
  Sparkles,
  Layers,
  Feather,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Download,
  ArrowRight,
  ArrowLeft,
  FolderDown,
  Zap
} from 'lucide-react'

// 资源清单权威体积字典 (与 BOM SSOT 严格对齐)
const RESOURCE_BYTES_MAP: Record<string, number> = {
  'bekko-a8m': 106269288,
  'chinese-clip': 212925967,
  'embeddinggemma-2-onnx': 254003864,
  'nsfw-mobilenetv2': 9556862,
  'nsfw-l3': 33311367,
  'sherpa-onnx-runtime': 8282676,
  'sensevoice-onnx': 160304482,
  'moss-tts': 240822786,
  'm5-tts': 305845248
}

// 模块绑定的物理资源映射
const MODULE_RESOURCES_MAP: Record<string, string[]> = {
  engine_classic_light: ['bekko-a8m', 'chinese-clip'],
  engine_gemma_unified: ['embeddinggemma-2-onnx'],
  perception_nsfw: ['nsfw-mobilenetv2', 'nsfw-l3'],
  asr_sensevoice_onnx: ['sherpa-onnx-runtime', 'sensevoice-onnx'],
  tts_moss_onnx: ['sherpa-onnx-runtime', 'moss-tts'],
  tts_m5_onnx: ['m5-tts']
}

export interface HardwareProbeResult {
  totalMemGB: number
  totalMemMB: number
  gpuName: string
  vramGB: number
  isGpuSupported: boolean
  storageFreeGB: number
}

interface WelcomeStep2PluginSetupProps {
  onBack: () => void
  onComplete: () => void
}

export function WelcomeStep2PluginSetup({ onBack, onComplete }: WelcomeStep2PluginSetupProps) {
  const { t } = useVoerkaI18n(i18nScope)

  // 1. 硬件探测状态
  const [hardware, setHardware] = useState<HardwareProbeResult>({
    totalMemGB: 16,
    totalMemMB: 16384,
    gpuName: '检测中...',
    vramGB: 0,
    isGpuSupported: false,
    storageFreeGB: 50
  })
  const [isDetectingHw, setIsDetectingHw] = useState(true)

  // 2. 插件装配选项状态
  const [selectedEngine, setSelectedEngine] = useState<
    'engine_classic_light' | 'engine_gemma_unified'
  >('engine_gemma_unified')
  const [selectedOptionals, setSelectedOptionals] = useState<Record<string, boolean>>({
    perception_nsfw: true,
    asr_sensevoice_onnx: false,
    tts_moss_onnx: false,
    tts_m5_onnx: true
  })
  const [selectedTtsEngine, setSelectedTtsEngine] = useState<'m5' | 'moss'>('m5')
  // 生成式引擎自适应底座推荐状态 (Spec §5.2 / AC-04)
  const [generativeEngineMode, setGenerativeEngineMode] = useState<'cpu' | 'local' | 'cloud'>('cpu')

  // 3. 安装流水线状态
  // idle -> installing -> smoke_testing -> ready -> error
  const [installPhase, setInstallPhase] = useState<
    'idle' | 'installing' | 'smoke_testing' | 'ready' | 'error'
  >('idle')
  const [baseEngineProgress, setBaseEngineProgress] = useState<{
    percentage: number
    speedBytesPerSec: number
    state: string
    errorMessage?: string
  }>({
    percentage: 0,
    speedBytesPerSec: 0,
    state: 'pending'
  })
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  // 硬件探测与自适应推荐初始化
  useEffect(() => {
    let isMounted = true
    const probeHardware = async () => {
      try {
        const electron = (window as any).electronAPI
        let res: any = null
        if (electron?.detectSystemResources) {
          res = await electron.detectSystemResources()
        } else if (electron?.getHardwareInfo) {
          const info = await electron.getHardwareInfo()
          res = {
            totalMemGB: info?.memory?.totalGB || 8,
            totalMemMB: (info?.memory?.totalGB || 8) * 1024,
            gpuName: info?.gpu?.name || '',
            vramGB: info?.gpu?.vramGB || 0,
            isGpuSupported: Boolean(info?.gpu?.vramGB > 0),
            storageFreeGB: 20
          }
        }

        if (isMounted && res) {
          const hw: HardwareProbeResult = {
            totalMemGB: res.totalMemGB || 8,
            totalMemMB: res.totalMemMB || 8192,
            gpuName: res.gpuName || 'Generic GPU',
            vramGB: res.vramGB || 0,
            isGpuSupported: Boolean(res.isGpuSupported),
            storageFreeGB: res.storageFreeGB !== undefined ? res.storageFreeGB : 20
          }
          setHardware(hw)

          // 硬件推荐算法
          const recommendClassic = hw.totalMemGB < 8
          const targetEngine = recommendClassic ? 'engine_classic_light' : 'engine_gemma_unified'
          setSelectedEngine(targetEngine)

          // ASR 与 TTS 推荐 (RAM >= 16GB 且有 GPU 推荐 ASR，RAM >= 16GB 推荐 TTS)
          setSelectedOptionals({
            perception_nsfw: true,
            asr_sensevoice_onnx: hw.totalMemGB >= 16 && hw.isGpuSupported,
            tts_moss_onnx: hw.totalMemGB >= 16
          })

          // 生成式引擎自适应推荐 (Spec §5.2, §7.2 / Issue 05 AC-04)
          // 无独显、显存 < 4GB、或内存 <= 16GB 的办公轻薄本，默认推荐轻量 CPU 引擎；高配独显机型推荐高级本地引擎
          const recommendCpu = !hw.isGpuSupported || hw.vramGB < 4 || hw.totalMemGB <= 16
          const targetGenMode: 'cpu' | 'local' = recommendCpu ? 'cpu' : 'local'
          setGenerativeEngineMode(targetGenMode)
        }
      } catch (err) {
        console.warn('硬件探测异常，采用标准默认推荐:', err)
      } finally {
        if (isMounted) setIsDetectingHw(false)
      }
    }

    probeHardware()
    return () => {
      isMounted = false
    }
  }, [])

  // 监听 ModularResourceService 下载进度
  useEffect(() => {
    const electron = (window as any).electronAPI
    if (!electron?.modularResource?.onProgress) return

    const unsub = electron.modularResource.onProgress((payload: any) => {
      if (payload.moduleId === selectedEngine) {
        setBaseEngineProgress({
          percentage: payload.percentage,
          speedBytesPerSec: payload.speedBytesPerSec || 0,
          state: payload.state,
          errorMessage: payload.errorMessage
        })
      }
    })

    return () => {
      unsub?.()
    }
  }, [selectedEngine])

  // 精确去重求和算法 (Deduplicated Volume Sum)
  const { totalBytes, displaySize } = useMemo(() => {
    const activeModuleIds = [
      selectedEngine,
      ...Object.keys(selectedOptionals).filter(k => selectedOptionals[k])
    ]

    const uniqueResourceIds = new Set<string>()
    for (const modId of activeModuleIds) {
      const boundRes = MODULE_RESOURCES_MAP[modId] || []
      for (const resId of boundRes) {
        uniqueResourceIds.add(resId)
      }
    }

    let bytes = 0
    for (const resId of uniqueResourceIds) {
      bytes += RESOURCE_BYTES_MAP[resId] || 0
    }

    const mib = (bytes / (1024 * 1024)).toFixed(1)
    return {
      totalBytes: bytes,
      displaySize: `${mib} MiB`
    }
  }, [selectedEngine, selectedOptionals])

  // 磁盘可用空间门禁 (ENOSPC Guard: < 2.0GB 强制阻断)
  const isDiskSpaceInsufficient = hardware.storageFreeGB < 2.0

  // 启动安装流水线与冒烟自检强门禁
  const handleStartInstall = async () => {
    if (isDiskSpaceInsufficient) return
    setInstallPhase('installing')
    setErrorMessage(null)
    setBaseEngineProgress({
      percentage: 5,
      speedBytesPerSec: 0,
      state: 'downloading'
    })

    const electron = (window as any).electronAPI
    const modular = electron?.modularResource || (window as any).modularResource

    try {
      // 1. 启动必须的基础引擎下载与解压
      if (modular?.install) {
        await modular.install(selectedEngine)
      }

      // 2. 基础引擎就绪后，执行 Omni 显式参数探活冒烟自检
      setInstallPhase('smoke_testing')
      const profile = selectedEngine.includes('classic') ? 'classic_light' : 'gemma_unified'
      if (modular?.smokeTest) {
        const smokeRes = await modular.smokeTest({ profile })
        if (!smokeRes.success) {
          throw new Error(smokeRes.error || t('引擎启动遇到问题，请尝试重试或切换为极速轻巧引擎'))
        }
      }

      // 3. 冒烟自检通过，激活主库 active 状态与 Epoch
      if (modular?.updateState) {
        await modular.updateState(selectedEngine, { active: true })
      }

      // 4. 异步平滑将勾选的推荐插件转入后台静默下载
      const optionalIds = Object.keys(selectedOptionals).filter(k => selectedOptionals[k])
      for (const optId of optionalIds) {
        modular?.install?.(optId).catch((err: any) => {
          console.warn(`[BackgroundDownload] 推荐插件后台下载异常: ${optId}`, err)
        })
      }

      // 同步生成式底座配置 (Spec §5.2)
      if (electron?.llmGateway?.setDesiredMode) {
        await electron.llmGateway.setDesiredMode(generativeEngineMode)
      }

      // 5. 必装放行强门禁解锁
      setInstallPhase('ready')
    } catch (err: any) {
      setInstallPhase('error')
      setErrorMessage(err?.message || t('引擎启动遇到问题，请尝试重试或切换为极速轻巧引擎'))
    }
  }

  // 离线插件包导入处理 (先掐断在线下载流并执行 Sign-Then-Extract 导入)
  const handleOfflineImport = async () => {
    try {
      const modular =
        (window as any).electronAPI?.modularResource || (window as any).modularResource
      if (modular?.abortAll) {
        await modular.abortAll()
      }
      if (modular?.importOfflinePackage) {
        const imported = await modular.importOfflinePackage()
        if (imported) {
          if (
            imported.id === selectedEngine ||
            imported.capability_slot === 'base_ai_engine' ||
            imported.capability_slot === 'base_embedding'
          ) {
            setInstallPhase('ready')
          }
        }
      }
    } catch (err: any) {
      setInstallPhase('error')
      setErrorMessage(err?.message || String(err))
    }
  }

  return (
    <div className="text-slate-900 flex flex-col h-full items-center justify-center p-4">
      <div className="w-full max-w-4xl mx-auto flex flex-col max-h-[90vh]">
        {/* 顶部标题区 */}
        <header className="text-center mb-4 shrink-0">
          <h1 className="text-xl font-bold tracking-tight">{t('AI 引擎与智能能力装配')}</h1>
          <p className="mt-1 text-sm text-slate-600">
            {t('已检测您的电脑硬件，为您推荐最流畅的搜索大脑与实用整理技能')}
          </p>
        </header>

        <div className="overflow-y-auto space-y-4 pr-1">
          {/* 1. 硬件自适应探测看板 */}
          <Card className="rounded-lg bg-slate-900 text-white shadow-md p-4">
            <CardContent className="p-0">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-6">
                  <div className="flex items-center gap-2">
                    <Cpu className="w-4 h-4 text-sky-400" />
                    <div>
                      <div className="text-xs text-slate-400">{t('电脑内存 (RAM)')}</div>
                      <div className="text-sm font-semibold">{hardware.totalMemGB} GB</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-amber-400" />
                    <div>
                      <div className="text-xs text-slate-400">{t('图形显卡 (GPU)')}</div>
                      <div
                        className="text-sm font-semibold truncate max-w-[200px]"
                        title={hardware.gpuName}
                      >
                        {hardware.gpuName || t('集成显卡 / 普通办公')}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <HardDrive className="w-4 h-4 text-emerald-400" />
                    <div>
                      <div className="text-xs text-slate-400">{t('磁盘剩余空间')}</div>
                      <div className="text-sm font-semibold">{hardware.storageFreeGB} GB</div>
                    </div>
                  </div>
                </div>

                <div>
                  {hardware.totalMemGB >= 8 ? (
                    <Badge className="bg-emerald-600 hover:bg-emerald-700 text-white border-none px-3 py-1 text-xs">
                      {t('推荐档位：高智能全能版（理解更深入）')}
                    </Badge>
                  ) : (
                    <Badge className="bg-sky-600 hover:bg-sky-700 text-white border-none px-3 py-1 text-xs">
                      {t('轻量档位：极速轻巧版（低配电脑秒开）')}
                    </Badge>
                  )}
                </div>
              </div>

              {/* 生成式引擎自适应推荐条目 (Spec §5.2 / AC-04) */}
              <div className="mt-3 pt-3 border-t border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                  <span className="text-slate-400">{t('智能起名与总结')}:</span>
                  <Badge
                    variant="outline"
                    className="bg-slate-800 text-amber-300 border-amber-400/40 text-xs"
                  >
                    {generativeEngineMode === 'cpu'
                      ? t('轻巧办公版（无需独立显卡，低内存占用）')
                      : t('专业深度版（需独立显卡，深度整理）')}
                  </Badge>
                </div>
                <span className="text-slate-400">
                  {generativeEngineMode === 'cpu'
                    ? t('不挑电脑、秒级启动、后台静默不卡电脑')
                    : t('显卡加速运算、擅长大批量文件智能整理')}
                </span>
              </div>
            </CardContent>
          </Card>

          {/* 磁盘空间不足告警门禁 */}
          {isDiskSpaceInsufficient && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-3 text-red-800 text-sm">
              <AlertCircle className="w-5 h-5 shrink-0 text-red-600" />
              <span>{t('磁盘剩余空间不足，请至少预留 2GB 空间以供下载与安装')}</span>
            </div>
          )}

          {/* 2. 必选基础 AI 语义嵌入底座 (二选一) */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-800 flex items-center gap-1.5">
                <span className="w-1.5 h-3.5 bg-sky-500 rounded-full inline-block" />
                {t('搜索核心大脑（二选一 · 必选）')}
              </h2>
              <span className="text-xs text-slate-500">
                {t('用你的大白话随心找文件和整理目录的核心动力')}
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Gemma Unified */}
              <div
                onClick={() => installPhase === 'idle' && setSelectedEngine('engine_gemma_unified')}
                className={`relative p-3.5 rounded-lg border-2 cursor-pointer transition-all ${
                  selectedEngine === 'engine_gemma_unified'
                    ? 'border-sky-500 bg-sky-50/60 shadow-sm'
                    : 'border-slate-200 bg-white hover:border-slate-300'
                } ${installPhase !== 'idle' ? 'pointer-events-none opacity-80' : ''}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Layers className="w-5 h-5 text-sky-600" />
                    <div>
                      <div className="font-semibold text-sm text-slate-900">
                        {t('高智能全能引擎（理解更准）')}
                      </div>
                      <div className="text-xs text-slate-500 mt-0.5">
                        {t('深度理解一句话的大致意思，找文字和图片更精准；推荐电脑内存 8GB 或以上')}
                      </div>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <Badge variant="outline" className="text-xs bg-slate-50 font-mono">
                      242.2 MiB
                    </Badge>
                  </div>
                </div>
                {hardware.totalMemGB >= 8 && (
                  <div className="mt-2 text-[11px] text-emerald-600 font-medium flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    {t('当前电脑配置推荐（内存充足，体验最佳）')}
                  </div>
                )}
              </div>

              {/* Classic Light */}
              <div
                onClick={() => installPhase === 'idle' && setSelectedEngine('engine_classic_light')}
                className={`relative p-3.5 rounded-lg border-2 cursor-pointer transition-all ${
                  selectedEngine === 'engine_classic_light'
                    ? 'border-sky-500 bg-sky-50/60 shadow-sm'
                    : 'border-slate-200 bg-white hover:border-slate-300'
                } ${installPhase !== 'idle' ? 'pointer-events-none opacity-80' : ''}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Feather className="w-5 h-5 text-amber-600" />
                    <div>
                      <div className="font-semibold text-sm text-slate-900">
                        {t('极速轻巧引擎（老电脑首选）')}
                      </div>
                      <div className="text-xs text-slate-500 mt-0.5">
                        {t('占用内存极少，反应极快；老电脑和低配轻薄本也能流畅运行不卡顿')}
                      </div>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <Badge variant="outline" className="text-xs bg-slate-50 font-mono">
                      304.4 MiB
                    </Badge>
                  </div>
                </div>
                {hardware.totalMemGB < 8 && (
                  <div className="mt-2 text-[11px] text-sky-600 font-medium flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    {t('当前电脑配置推荐（轻巧省资源）')}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* 3. 推荐感知与语音插件 (选配) */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-800 flex items-center gap-1.5">
                <span className="w-1.5 h-3.5 bg-emerald-500 rounded-full inline-block" />
                {t('实用智能技能扩展（选配 · 可随时调整）')}
              </h2>
              <span className="text-xs text-slate-500">
                {t('进入主界面后后台静默下载，不耽误您马上使用')}
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              {/* NSFW */}
              <div
                onClick={() =>
                  installPhase === 'idle' &&
                  setSelectedOptionals(prev => ({
                    ...prev,
                    perception_nsfw: !prev.perception_nsfw
                  }))
                }
                className={`p-3 rounded-lg border flex flex-col justify-between cursor-pointer transition-all ${
                  selectedOptionals.perception_nsfw
                    ? 'border-emerald-500 bg-emerald-50/30'
                    : 'border-slate-200 bg-white'
                } ${installPhase !== 'idle' ? 'pointer-events-none opacity-80' : ''}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <ShieldAlert className="w-4 h-4 text-rose-500 shrink-0" />
                    <span className="text-xs font-semibold text-slate-900">
                      {t('私密与敏感照片识别')}
                    </span>
                  </div>
                  <Checkbox checked={selectedOptionals.perception_nsfw} />
                </div>
                <div className="text-[11px] text-slate-500 mt-2">
                  {t('自动识别私密照片与敏感内容并打上安全标签，投屏或分享时避免尴尬')}
                </div>
                <div className="mt-2 flex justify-between items-center text-[11px]">
                  <span className="text-emerald-600 font-medium">{t('推荐勾选')}</span>
                  <span className="font-mono text-slate-400">40.9 MiB</span>
                </div>
              </div>

              {/* ASR */}
              <div
                onClick={() =>
                  installPhase === 'idle' &&
                  setSelectedOptionals(prev => ({
                    ...prev,
                    asr_sensevoice_onnx: !prev.asr_sensevoice_onnx
                  }))
                }
                className={`p-3 rounded-lg border flex flex-col justify-between cursor-pointer transition-all ${
                  selectedOptionals.asr_sensevoice_onnx
                    ? 'border-emerald-500 bg-emerald-50/30'
                    : 'border-slate-200 bg-white'
                } ${installPhase !== 'idle' ? 'pointer-events-none opacity-80' : ''}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Mic className="w-4 h-4 text-sky-500 shrink-0" />
                    <span className="text-xs font-semibold text-slate-900">
                      {t('音视频转字幕与语音搜索')}
                    </span>
                  </div>
                  <Checkbox checked={selectedOptionals.asr_sensevoice_onnx} />
                </div>
                <div className="text-[11px] text-slate-500 mt-2">
                  {t('听懂视频和录音里的对白并提取字幕，可以直接按台词找到对应视频')}
                </div>
                <div className="mt-2 flex justify-between items-center text-[11px]">
                  <span className="text-slate-400">{t('可选功能')}</span>
                  <span className="font-mono text-slate-400">160.8 MiB</span>
                </div>
              </div>

              {/* TTS 二选一互斥单选组 */}
              {(() => {
                const isTtsEnabled =
                  Boolean(selectedOptionals.tts_m5_onnx) || Boolean(selectedOptionals.tts_moss_onnx)
                return (
                  <div
                    className={`p-3 rounded-lg border flex flex-col justify-between transition-all ${
                      isTtsEnabled
                        ? 'border-emerald-500 bg-emerald-50/30'
                        : 'border-slate-200 bg-white'
                    } ${installPhase !== 'idle' ? 'pointer-events-none opacity-80' : ''}`}
                  >
                    <div>
                      <div
                        className="flex items-start justify-between gap-2 cursor-pointer"
                        onClick={() => {
                          if (installPhase !== 'idle') return
                          if (isTtsEnabled) {
                            setSelectedOptionals(prev => ({
                              ...prev,
                              tts_m5_onnx: false,
                              tts_moss_onnx: false
                            }))
                          } else {
                            setSelectedOptionals(prev => ({
                              ...prev,
                              tts_m5_onnx: selectedTtsEngine === 'm5',
                              tts_moss_onnx: selectedTtsEngine === 'moss'
                            }))
                          }
                        }}
                      >
                        <div className="flex items-center gap-2">
                          <Volume2 className="w-4 h-4 text-purple-500 shrink-0" />
                          <span className="text-xs font-semibold text-slate-900">
                            {t('离线语音朗读')}
                          </span>
                        </div>
                        <Checkbox checked={isTtsEnabled} />
                      </div>
                      <div className="text-[11px] text-slate-500 mt-1.5">
                        {t('用自然真人声音把文档读给你听，支持戴耳机离线听书')}
                      </div>

                      {/* 二选一互斥选择器 */}
                      <div className="mt-2.5 grid grid-cols-2 gap-1.5 p-1 bg-slate-100/80 rounded-md">
                        <button
                          type="button"
                          disabled={installPhase !== 'idle'}
                          onClick={e => {
                            e.stopPropagation()
                            setSelectedTtsEngine('m5')
                            setSelectedOptionals(prev => ({
                              ...prev,
                              tts_m5_onnx: true,
                              tts_moss_onnx: false
                            }))
                          }}
                          className={`px-2 py-1.5 rounded text-[11px] font-medium flex items-center justify-center gap-1 transition-all ${
                            isTtsEnabled && selectedTtsEngine === 'm5'
                              ? 'bg-white text-purple-700 shadow-xs border border-purple-200'
                              : 'text-slate-600 hover:text-slate-900'
                          }`}
                        >
                          <Zap className="w-3 h-3 text-amber-500 shrink-0" />
                          <span>{t('极速轻量')}</span>
                        </button>
                        <button
                          type="button"
                          disabled={installPhase !== 'idle'}
                          onClick={e => {
                            e.stopPropagation()
                            setSelectedTtsEngine('moss')
                            setSelectedOptionals(prev => ({
                              ...prev,
                              tts_moss_onnx: true,
                              tts_m5_onnx: false
                            }))
                          }}
                          className={`px-2 py-1.5 rounded text-[11px] font-medium flex items-center justify-center gap-1 transition-all ${
                            isTtsEnabled && selectedTtsEngine === 'moss'
                              ? 'bg-white text-purple-700 shadow-xs border border-purple-200'
                              : 'text-slate-600 hover:text-slate-900'
                          }`}
                        >
                          <Volume2 className="w-3 h-3 text-purple-500 shrink-0" />
                          <span>{t('声音克隆')}</span>
                        </button>
                      </div>
                    </div>

                    <div className="mt-2.5 flex justify-between items-center text-[11px]">
                      <span className="text-purple-600 font-medium">
                        {selectedTtsEngine === 'm5' ? t('推荐 · 极速省电') : t('支持克隆音色')}
                      </span>
                      <span className="font-mono text-slate-400">
                        {selectedTtsEngine === 'm5' ? '291.7 MiB' : '237.6 MiB'}
                      </span>
                    </div>
                  </div>
                )
              })()}
            </div>
          </div>

          {/* 4. 安装进度与冒烟自检面板 */}
          {installPhase !== 'idle' && (
            <Card className="p-4 rounded-lg bg-white border border-slate-200 shadow-sm">
              <CardContent className="p-0 space-y-3">
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2 font-medium text-slate-800">
                    {installPhase === 'installing' && (
                      <>
                        <RefreshCw className="w-4 h-4 text-sky-500 animate-spin" />
                        <span>{t('正在准备核心搜索引擎...')}</span>
                      </>
                    )}
                    {installPhase === 'smoke_testing' && (
                      <>
                        <RefreshCw className="w-4 h-4 text-amber-500 animate-spin" />
                        <span>{t('正在检验引擎运行状态...')}</span>
                      </>
                    )}
                    {installPhase === 'ready' && (
                      <>
                        <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                        <span className="text-emerald-700 font-semibold">
                          {t('核心引擎已准备就绪，可以开始使用了！')}
                        </span>
                      </>
                    )}
                    {installPhase === 'error' && (
                      <>
                        <AlertCircle className="w-4 h-4 text-red-500" />
                        <span className="text-red-700 font-semibold">{t('引擎准备遇到问题')}</span>
                      </>
                    )}
                  </div>
                  <span className="font-mono font-medium">
                    {installPhase === 'ready' ? '100%' : `${baseEngineProgress.percentage}%`}
                  </span>
                </div>

                <ProgressBar
                  value={installPhase === 'ready' ? 100 : baseEngineProgress.percentage}
                  max={100}
                />

                {installPhase === 'error' && (
                  <div className="p-2.5 bg-red-50 text-red-700 rounded text-xs flex flex-col gap-2">
                    <div>{errorMessage}</div>
                    <div className="flex items-center gap-2 pt-1">
                      <Button size="sm" variant="outline" onClick={handleStartInstall}>
                        <RefreshCw className="w-3.5 h-3.5 mr-1" />
                        {t('重试')}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setSelectedEngine(
                            selectedEngine === 'engine_classic_light'
                              ? 'engine_gemma_unified'
                              : 'engine_classic_light'
                          )
                          setInstallPhase('idle')
                        }}
                      >
                        {t('换选另一引擎')}
                      </Button>
                      <Button size="sm" variant="outline" onClick={handleOfflineImport}>
                        <FolderDown className="w-3.5 h-3.5 mr-1" />
                        {t('导入离线插件包')}
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        {/* 底部汇总与操作按钮 */}
        <footer className="mt-4 pt-3 border-t border-slate-200 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={onBack}
              disabled={installPhase !== 'idle'}
              className="text-slate-600 hover:text-slate-900"
            >
              <ArrowLeft className="w-4 h-4 mr-1" />
              {t('返回')}
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={handleOfflineImport}
              disabled={installPhase === 'installing' || installPhase === 'smoke_testing'}
              className="text-xs text-slate-600"
            >
              <FolderDown className="w-3.5 h-3.5 mr-1" />
              {t('导入离线插件包')}
            </Button>
          </div>

          <div className="flex items-center gap-4">
            <div className="text-right text-xs">
              <span className="text-slate-500">{t('预估下载大小:')} </span>
              <span className="font-semibold text-slate-900 font-mono text-sm">{displaySize}</span>
            </div>

            {installPhase === 'idle' && (
              <Button
                onClick={handleStartInstall}
                disabled={isDiskSpaceInsufficient}
                className="bg-sky-600 hover:bg-sky-700 text-white font-medium px-5"
              >
                {t('开启 Firefly')}
                <ArrowRight className="w-4 h-4 ml-1.5" />
              </Button>
            )}

            {installPhase !== 'idle' && (
              <Button
                onClick={onComplete}
                disabled={installPhase !== 'ready'}
                className={`${
                  installPhase === 'ready'
                    ? 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-lg animate-pulse'
                    : 'bg-slate-300 text-slate-500 cursor-not-allowed'
                } font-medium px-5`}
              >
                {t('立即进入主界面')}
                <ArrowRight className="w-4 h-4 ml-1.5" />
              </Button>
            )}
          </div>
        </footer>
      </div>
    </div>
  )
}
