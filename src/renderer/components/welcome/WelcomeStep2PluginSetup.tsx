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
  FolderDown
} from 'lucide-react'

// 资源清单权威体积字典 (与 BOM SSOT 严格对齐)
const RESOURCE_BYTES_MAP: Record<string, number> = {
  'bekko-a8m': 106269288,
  'chinese-clip': 212925967,
  'embeddinggemma-2-onnx': 254003864,
  'nsfw-l3': 21966375,
  'sherpa-onnx-runtime': 8282676,
  'sensevoice-onnx': 160304482,
  'moss-tts': 240822786
}

// 模块绑定的物理资源映射
const MODULE_RESOURCES_MAP: Record<string, string[]> = {
  engine_classic_light: ['bekko-a8m', 'chinese-clip'],
  engine_gemma_unified: ['embeddinggemma-2-onnx'],
  perception_nsfw: ['nsfw-l3'],
  asr_sensevoice_onnx: ['sherpa-onnx-runtime', 'sensevoice-onnx'],
  tts_moss_onnx: ['sherpa-onnx-runtime', 'moss-tts']
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
    tts_moss_onnx: false
  })

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
    const modular = electron?.modularResource

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
          throw new Error(
            smokeRes.error || t('模型初始化异常，可能由于系统缺失对应 VC++ 运行库或指令集不支持')
          )
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

      // 5. 必装放行强门禁解锁
      setInstallPhase('ready')
    } catch (err: any) {
      setInstallPhase('error')
      setErrorMessage(
        err?.message || t('模型初始化异常，可能由于系统缺失对应 VC++ 运行库或指令集不支持')
      )
    }
  }

  // 离线插件包导入处理 (先掐断在线下载流)
  const handleOfflineImport = async () => {
    try {
      const electron = (window as any).electronAPI
      if (electron?.modularResource?.abortAll) {
        await electron.modularResource.abortAll()
      }
      // 触发离线包导入文件选择
      alert(t('已中止在途网络下载。请选择官方离线插件包 (.ffp / .zip) 进行导入。'))
    } catch (err) {
      console.warn('离线导入中断异常:', err)
    }
  }

  return (
    <div className="text-slate-900 flex flex-col h-full items-center justify-center p-4">
      <div className="w-full max-w-4xl mx-auto flex flex-col max-h-[90vh]">
        {/* 顶部标题区 */}
        <header className="text-center mb-4 shrink-0">
          <h1 className="text-xl font-bold tracking-tight">{t('AI 能力与插件装配')}</h1>
          <p className="mt-1 text-sm text-slate-600">
            {t('根据您的电脑硬件配置，自适应推荐最佳 AI 引擎档位与可选感知插件')}
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
                      <div className="text-xs text-slate-400">{t('物理内存 (RAM)')}</div>
                      <div className="text-sm font-semibold">{hardware.totalMemGB} GB</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-amber-400" />
                    <div>
                      <div className="text-xs text-slate-400">{t('图形设备 (GPU)')}</div>
                      <div
                        className="text-sm font-semibold truncate max-w-[200px]"
                        title={hardware.gpuName}
                      >
                        {hardware.gpuName || t('集成显卡')}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <HardDrive className="w-4 h-4 text-emerald-400" />
                    <div>
                      <div className="text-xs text-slate-400">{t('磁盘可用空间')}</div>
                      <div className="text-sm font-semibold">{hardware.storageFreeGB} GB</div>
                    </div>
                  </div>
                </div>

                <div>
                  {hardware.totalMemGB >= 8 ? (
                    <Badge className="bg-emerald-600 hover:bg-emerald-700 text-white border-none px-3 py-1 text-xs">
                      {t('推荐配置: 统一全模态档 (Gemma Unified)')}
                    </Badge>
                  ) : (
                    <Badge className="bg-sky-600 hover:bg-sky-700 text-white border-none px-3 py-1 text-xs">
                      {t('轻量配置: 经典极速档 (Classic Light)')}
                    </Badge>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* 磁盘空间不足告警门禁 */}
          {isDiskSpaceInsufficient && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-3 text-red-800 text-sm">
              <AlertCircle className="w-5 h-5 shrink-0 text-red-600" />
              <span>{t('磁盘剩余空间不足，请至少预留 2GB 空间以供模型下载与解压')}</span>
            </div>
          )}

          {/* 2. 必选基础 AI 语义嵌入底座 (二选一) */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-800 flex items-center gap-1.5">
                <span className="w-1.5 h-3.5 bg-sky-500 rounded-full inline-block" />
                {t('基础 AI 语义嵌入底座 (二选一必选)')}
              </h2>
              <span className="text-xs text-slate-500">
                {t('全系统语义检索与智能归类的核心基石')}
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
                        {t('统一全模态 AI 引擎 (Gemma Unified)')}
                      </div>
                      <div className="text-xs text-slate-500 mt-0.5">
                        {t('EmbeddingGemma-2 图文同构统一流形，精度更高')}
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
                    {t('当前机器硬件推荐档位 (RAM ≥ 8GB)')}
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
                        {t('经典轻量 AI 引擎 (Classic Light)')}
                      </div>
                      <div className="text-xs text-slate-500 mt-0.5">
                        {t('Bekko 384d + CLIP 512d 非对称极速架构，CPU 流畅运转')}
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
                    {t('当前机器硬件推荐档位 (RAM < 8GB)')}
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
                {t('感知分析与多媒体能力扩展 (推荐预选)')}
              </h2>
              <span className="text-xs text-slate-500">{t('可在主界面就绪后在后台静默下载')}</span>
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
                      {t('敏感内容合规识别 (NSFW)')}
                    </span>
                  </div>
                  <Checkbox checked={selectedOptionals.perception_nsfw} />
                </div>
                <div className="text-[11px] text-slate-500 mt-2">
                  {t('MobileNetV2 5分类 + FastText，护航内容合规')}
                </div>
                <div className="mt-2 flex justify-between items-center text-[11px]">
                  <span className="text-emerald-600 font-medium">{t('默认推荐')}</span>
                  <span className="font-mono text-slate-400">20.9 MiB</span>
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
                      {t('语音识别转录 (ASR)')}
                    </span>
                  </div>
                  <Checkbox checked={selectedOptionals.asr_sensevoice_onnx} />
                </div>
                <div className="text-[11px] text-slate-500 mt-2">
                  {t('SenseVoice 高精多语言字幕转录，复用系统 FFmpeg')}
                </div>
                <div className="mt-2 flex justify-between items-center text-[11px]">
                  <span className="text-slate-400">{t('可选功能')}</span>
                  <span className="font-mono text-slate-400">160.8 MiB</span>
                </div>
              </div>

              {/* TTS */}
              <div
                onClick={() =>
                  installPhase === 'idle' &&
                  setSelectedOptionals(prev => ({ ...prev, tts_moss_onnx: !prev.tts_moss_onnx }))
                }
                className={`p-3 rounded-lg border flex flex-col justify-between cursor-pointer transition-all ${
                  selectedOptionals.tts_moss_onnx
                    ? 'border-emerald-500 bg-emerald-50/30'
                    : 'border-slate-200 bg-white'
                } ${installPhase !== 'idle' ? 'pointer-events-none opacity-80' : ''}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Volume2 className="w-4 h-4 text-purple-500 shrink-0" />
                    <span className="text-xs font-semibold text-slate-900">
                      {t('离线语音朗读 (TTS)')}
                    </span>
                  </div>
                  <Checkbox checked={selectedOptionals.tts_moss_onnx} />
                </div>
                <div className="text-[11px] text-slate-500 mt-2">
                  {t('Moss-TTS 离线自然语音合成，51款高品质音色')}
                </div>
                <div className="mt-2 flex justify-between items-center text-[11px]">
                  <span className="text-slate-400">{t('可选功能')}</span>
                  <span className="font-mono text-slate-400">237.6 MiB</span>
                </div>
              </div>
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
                        <span>{t('正在下载并解压基础 AI 引擎...')}</span>
                      </>
                    )}
                    {installPhase === 'smoke_testing' && (
                      <>
                        <RefreshCw className="w-4 h-4 text-amber-500 animate-spin" />
                        <span>{t('正在执行 Omni 显式参数探活冒烟自检...')}</span>
                      </>
                    )}
                    {installPhase === 'ready' && (
                      <>
                        <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                        <span className="text-emerald-700 font-semibold">
                          {t('基础 AI 引擎已完成装配并通过自检！')}
                        </span>
                      </>
                    )}
                    {installPhase === 'error' && (
                      <>
                        <AlertCircle className="w-4 h-4 text-red-500" />
                        <span className="text-red-700 font-semibold">{t('安装自检异常')}</span>
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
              <span className="text-slate-500">{t('精确预估下载体积:')} </span>
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
