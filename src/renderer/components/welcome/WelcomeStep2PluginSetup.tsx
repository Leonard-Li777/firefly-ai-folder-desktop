import React, { useMemo } from 'react'
import { useVoerkaI18n } from '@voerkai18n/react'
import i18nScope from '@src/languages'
import { Card, CardContent } from '@components/ui/card'
import { Button } from '@components/ui/button'
import { Badge } from '@components/ui/badge'
import { Checkbox } from '@components/ui/checkbox'
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
  XCircle,
  AlertCircle,
  ArrowRight,
  ArrowLeft
} from 'lucide-react'
import { WelcomeStepLayout } from './WelcomeStepLayout'
import type { HardwareProbeResult, WelcomeSelection } from './welcome-types'

// 资源清单权威体积字典 (与 BOM SSOT 严格对齐)
const RESOURCE_BYTES_MAP: Record<string, number> = {
  'bekko-a8m': 106269288,
  'chinese-clip': 212925967,
  'embeddinggemma-2-onnx': 254003864,
  'nsfw-mobilenetv2': 9556862,
  'nsfw-l3': 33311367,
  'sensevoice-onnx': 160304482,
  'moss-tts': 240822786,
  'm5-tts': 253215862,
  'mobile-clip': 57910236
}

// 模块绑定的物理资源映射
const MODULE_RESOURCES_MAP: Record<string, string[]> = {
  engine_classic_light: ['bekko-a8m', 'chinese-clip', 'mobile-clip'],
  engine_gemma_unified: ['embeddinggemma-2-onnx'],
  perception_nsfw: ['nsfw-mobilenetv2', 'nsfw-l3'],
  asr_sensevoice_onnx: ['sensevoice-onnx'],
  tts_m5_onnx: ['m5-tts']
}

export interface WelcomeStep2PluginSetupProps {
  selection: WelcomeSelection
  hardware: HardwareProbeResult
  isDetectingHw?: boolean
  onChange: (patch: Partial<WelcomeSelection>) => void
  onBack: () => void
  onNext: () => void
}

export function WelcomeStep2PluginSetup({
  selection,
  hardware,
  isDetectingHw = false,
  onChange,
  onBack,
  onNext
}: WelcomeStep2PluginSetupProps) {
  const { t } = useVoerkaI18n(i18nScope)

  const selectedEngine = selection.selectedEngine
  const selectedOptionals = selection.selectedOptionals

  // 精确去重求和算法 (Deduplicated Volume Sum)
  const { displaySize } = useMemo(() => {
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

  const handleToggleOptional = (key: string) => {
    onChange({
      selectedOptionals: {
        ...selectedOptionals,
        [key]: !selectedOptionals[key]
      }
    })
  }

  const footer = (
    <>
      <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4 text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5 font-medium text-foreground">
          <span>{t('预计占用空间:')}</span>
          <span className="font-mono text-sm font-semibold text-primary">{displaySize}</span>
        </div>
        <div
          data-testid="welcome-step2-later-method-hint"
          className="text-muted-foreground text-[11px] sm:text-xs"
        >
          {t('先挑插件，稍后决定安装方式 · 现在还不会下载文件')}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          data-testid="welcome-step2-back-btn"
          onClick={onBack}
          className="gap-1 text-sm border-border hover:bg-muted"
        >
          <ArrowLeft className="w-4 h-4" />
          {t('返回')}
        </Button>
        <Button
          type="button"
          data-testid="welcome-step2-next-btn"
          disabled={isDiskSpaceInsufficient}
          onClick={onNext}
          className="gap-1 text-sm bg-primary hover:bg-primary/90 text-primary-foreground shadow-sm"
        >
          {t('下一步')}
          <ArrowRight className="w-4 h-4" />
        </Button>
      </div>
    </>
  )

  return (
    <WelcomeStepLayout
      testId="welcome-step2-container"
      title={t('AI 引擎与智能能力装配')}
      subtitle={t('已检测您的电脑硬件，为您推荐最流畅的搜索大脑与实用整理技能')}
      maxWidthClass="max-w-4xl"
      footer={footer}
    >
      {/* 1. 硬件自适应探测看板 */}
      <Card className="rounded-lg bg-card text-card-foreground border-border shadow-sm p-4">
        <CardContent className="p-0">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="flex items-center gap-3 p-1">
              <div className="p-2 rounded-md bg-primary/10 text-primary shrink-0">
                <Cpu className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <div className="text-xs text-muted-foreground">{t('电脑内存 (RAM)')}</div>
                <div className="text-sm font-semibold text-foreground truncate">
                  {hardware.totalMemGB} GB
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3 p-1">
              <div className="p-2 rounded-md bg-amber-500/10 text-amber-500 shrink-0">
                <Sparkles className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <div className="text-xs text-muted-foreground">{t('图形显卡 (GPU)')}</div>
                <div
                  className="text-sm font-semibold text-foreground truncate"
                  title={hardware.gpuName}
                >
                  {isDetectingHw ? t('检测中...') : hardware.gpuName || t('集成显卡 / 普通办公')}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3 p-1">
              <div className="p-2 rounded-md bg-emerald-500/10 text-emerald-500 shrink-0">
                <HardDrive className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <div className="text-xs text-muted-foreground">{t('磁盘剩余空间')}</div>
                <div className="text-sm font-semibold text-foreground truncate">
                  {hardware.storageFreeGB} GB
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 磁盘空间不足告警门禁 */}
      {isDiskSpaceInsufficient && (
        <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg flex items-center gap-3 text-destructive text-sm">
          <AlertCircle className="w-5 h-5 shrink-0 text-destructive" />
          <span>{t('磁盘剩余空间不足，请至少预留 2GB 空间以供下载与安装')}</span>
        </div>
      )}

      {/* 2. 必选基础 AI 语义嵌入底座 (二选一) */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
            <span className="w-1.5 h-3.5 bg-primary rounded-full inline-block" />
            {t('检索引擎核心大脑（二选一 · 必选）')}
          </h2>
          <span className="text-xs text-muted-foreground">
            {t('用你的大白话随心找文件和整理目录的核心动力')}
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {/* Gemma Unified */}
          <div
            data-testid="welcome-engine-gemma-card"
            onClick={() => onChange({ selectedEngine: 'engine_gemma_unified' })}
            className={`relative p-3.5 rounded-lg border-2 cursor-pointer transition-all ${
              selectedEngine === 'engine_gemma_unified'
                ? 'border-primary bg-primary/5 shadow-sm'
                : 'border-border bg-card hover:border-primary/50'
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-start gap-2.5">
                <Layers className="w-5 h-5 text-primary mt-0.5 shrink-0" />
                <div>
                  <div className="font-semibold text-sm text-foreground flex items-center gap-2">
                    <span>{t('高智能全能引擎（理解更准）')}</span>
                    {hardware.totalMemGB >= 8 && (
                      <Badge className="bg-emerald-600 hover:bg-emerald-700 text-white border-none px-2 py-0.5 text-xs">
                        {t('推荐')}
                      </Badge>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    {t('找文字、图片、视频、录音更精准；最低内存 8GB，推荐 16G')}
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <span
                      data-testid="engine-gemma-media-capability"
                      className="text-xs text-primary font-medium flex items-center gap-1"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      {t('支持音视频')}
                    </span>
                  </div>
                </div>
              </div>
              <div className="text-right shrink-0">
                <Badge
                  variant="outline"
                  className="text-xs bg-muted text-muted-foreground font-mono border-border"
                >
                  242.2 MiB
                </Badge>
              </div>
            </div>
          </div>

          {/* Classic Light */}
          <div
            data-testid="welcome-engine-classic-card"
            onClick={() => onChange({ selectedEngine: 'engine_classic_light' })}
            className={`relative p-3.5 rounded-lg border-2 cursor-pointer transition-all ${
              selectedEngine === 'engine_classic_light'
                ? 'border-primary bg-primary/5 shadow-sm'
                : 'border-border bg-card hover:border-primary/50'
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-start gap-2.5">
                <Feather className="w-5 h-5 text-amber-500 mt-0.5 shrink-0" />
                <div>
                  <div className="font-semibold text-sm text-foreground flex items-center gap-2">
                    <span>{t('极速轻巧引擎（老电脑、NAS首选）')}</span>
                    {hardware.totalMemGB < 8 && (
                      <Badge className="bg-primary hover:bg-primary/90 text-primary-foreground border-none px-2 py-0.5 text-xs">
                        {t('推荐')}
                      </Badge>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    {t(
                      '占用内存极少，反应极快；只处理文档和图片；老电脑和低配轻薄本也能流畅运行不卡顿'
                    )}
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <span
                      data-testid="engine-classic-media-capability"
                      className="text-xs text-muted-foreground font-medium flex items-center gap-1"
                    >
                      <XCircle className="w-3.5 h-3.5 text-muted-foreground/70" />
                      {t('不支持音视频')}
                    </span>
                  </div>
                </div>
              </div>
              <div className="text-right shrink-0">
                <Badge
                  variant="outline"
                  className="text-xs bg-muted text-muted-foreground font-mono border-border"
                >
                  304.4 MiB
                </Badge>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 3. 推荐感知与语音插件 (选配) */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
            <span className="w-1.5 h-3.5 bg-emerald-500 rounded-full inline-block" />
            {t('实用智能技能扩展（选配 · 后续可随时调整）')}
          </h2>
          <span className="text-xs text-muted-foreground">
            {t('后续由您决定获取方式，不耽误您马上使用')}
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
          {/* NSFW */}
          <div
            data-testid="welcome-perception-nsfw-card"
            onClick={() => handleToggleOptional('perception_nsfw')}
            className={`p-3 rounded-lg border flex flex-col justify-between cursor-pointer transition-all ${
              selectedOptionals.perception_nsfw
                ? 'border-emerald-500 bg-emerald-500/5'
                : 'border-border bg-card'
            }`}
          >
            <div>
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <ShieldAlert className="w-4 h-4 text-rose-500 shrink-0" />
                  <span className="text-xs font-semibold text-foreground">
                    {t('私密与敏感图文识别（NSFW）')}
                  </span>
                </div>
                <Checkbox checked={selectedOptionals.perception_nsfw} />
              </div>
              <div className="text-[11px] text-muted-foreground mt-2 leading-relaxed">
                {t('自动识别私密照片与敏感内容并打上安全标签，投屏或分享时避免尴尬')}
              </div>
            </div>
            <div className="mt-3 flex justify-between items-center text-[11px]">
              <span className="text-emerald-600 font-medium">{t('推荐勾选')}</span>
              <span className="font-mono text-muted-foreground">40.9 MiB</span>
            </div>
          </div>

          {/* ASR */}
          <div
            data-testid="welcome-asr-sensevoice-card"
            onClick={() => handleToggleOptional('asr_sensevoice_onnx')}
            className={`p-3 rounded-lg border flex flex-col justify-between cursor-pointer transition-all ${
              selectedOptionals.asr_sensevoice_onnx
                ? 'border-emerald-500 bg-emerald-500/5'
                : 'border-border bg-card'
            }`}
          >
            <div>
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Mic className="w-4 h-4 text-primary shrink-0" />
                  <span className="text-xs font-semibold text-foreground">
                    {t('音视频转字幕文本（ASR）')}
                  </span>
                </div>
                <Checkbox checked={selectedOptionals.asr_sensevoice_onnx} />
              </div>
              <div className="text-[11px] text-muted-foreground mt-2 leading-relaxed">
                {t('听懂视频和录音里的对白并提取字幕，可以直接按台词找到对应视频')}
              </div>
            </div>
            <div className="mt-3 flex justify-between items-center text-[11px]">
              <span className="text-muted-foreground">{t('可选功能')}</span>
              <span className="font-mono text-muted-foreground">160.8 MiB</span>
            </div>
          </div>

          {/* TTS */}
          <div
            data-testid="welcome-tts-m5-card"
            onClick={() => handleToggleOptional('tts_m5_onnx')}
            className={`p-3 rounded-lg border flex flex-col justify-between cursor-pointer transition-all ${
              selectedOptionals.tts_m5_onnx
                ? 'border-emerald-500 bg-emerald-500/5'
                : 'border-border bg-card'
            }`}
          >
            <div>
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Volume2 className="w-4 h-4 text-purple-500 shrink-0" />
                  <span className="text-xs font-semibold text-foreground">
                    {t('离线语音朗读（TTS）')}
                  </span>
                </div>
                <Checkbox checked={Boolean(selectedOptionals.tts_m5_onnx)} />
              </div>
              <div
                data-testid="welcome-tts-description"
                className="text-[11px] text-muted-foreground mt-2 leading-relaxed"
              >
                {t(
                  '用自然真人声音把文档读给你听。实时长文朗读、50+音色、中英文混读，文件分析结果直接收听'
                )}
              </div>
            </div>
            <div className="mt-3 flex justify-between items-center text-[11px]">
              <span className="text-emerald-600 font-medium">{t('推荐勾选')}</span>
              <span className="font-mono text-muted-foreground">291.7 MiB</span>
            </div>
          </div>
        </div>
      </div>
    </WelcomeStepLayout>
  )
}
