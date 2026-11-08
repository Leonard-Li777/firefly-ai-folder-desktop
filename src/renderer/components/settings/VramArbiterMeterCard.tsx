import React, { useMemo } from 'react'
import {
  Activity,
  Cpu,
  Sparkles,
  Layers,
  Image as ImageIcon,
  Mic,
  RefreshCw,
  ShieldCheck
} from 'lucide-react'
import { Card } from '../ui/card'
import { Badge } from '../ui/badge'
import { cn } from '../../lib/utils'
import i18nScope from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'
import { useEngineStore } from '../../stores/engine-store'
import { useAnalysisQueueStore } from '../../stores/analysis-queue-store'

export interface VramArbiterMeterCardProps {
  className?: string
}

/**
 * 本地 AI 引擎显存与调度状态大白话仪表盘
 *
 * 遵循规格说明书 §6.3 与 Ticket 04 验收标准：
 * 1. 显存总览条：专用显存进度条 + 大白话文案；核显/共享内存防除零保护与友好提示；
 * 2. 4 栏 Worker 状态矩阵：纯大白话中文，展示大语言模型、向量计算、生图与语音状态；
 * 3. 置换呼吸横幅：持有排队任务且处于模型置换时展示温和黄色呼吸灯横幅。
 */
export const VramArbiterMeterCard: React.FC<VramArbiterMeterCardProps> = ({ className }) => {
  const { t } = useVoerkaI18n(i18nScope)
  const snapshot = useEngineStore(s => s.snapshot)

  // 细粒度布尔选择器，避免队列进度频繁 tick 导致 items 引用重算触发非必要 re-render
  const hasPendingAnalysis = useAnalysisQueueStore(s =>
    Boolean(
      s.snapshot?.running ||
      s.snapshot?.items?.some(i => i.status === 'pending' || i.status === 'analyzing')
    )
  )

  const metrics = (snapshot as any)?.metrics
  const raw = snapshot?.raw
  const hardware = raw?.hardware
  const arbiter = raw?.arbiter

  // 显卡型号名称：优先 metrics?.gpuName，次取 hardware?.gpu_name，兜底默认显卡
  const gpuName = metrics?.gpuName || hardware?.gpu_name?.trim() || t('默认显卡')
  const isIntegrated = Boolean(hardware?.is_integrated)

  // 显存容量与占用换算 (GB)
  // 总显存优先取 metrics?.totalVramBytes / 1024^3，次取 arbiter?.vram_budget_mb / 1024，次取 hardware?.total_vram_gb，兜底 0
  const totalVramGb = useMemo(() => {
    if (typeof metrics?.totalVramBytes === 'number' && metrics.totalVramBytes > 0) {
      return metrics.totalVramBytes / 1024 ** 3
    }
    if (typeof arbiter?.vram_budget_mb === 'number' && arbiter.vram_budget_mb > 0) {
      return arbiter.vram_budget_mb / 1024
    }
    if (typeof hardware?.total_vram_gb === 'number' && hardware.total_vram_gb > 0) {
      return hardware.total_vram_gb
    }
    return 0
  }, [metrics?.totalVramBytes, arbiter?.vram_budget_mb, hardware?.total_vram_gb])

  // 已用显存优先取 metrics?.usedVramBytes / 1024^3，次取 arbiter?.vram_used_mb / 1024，次取 hardware?.used_vram_gb，次取 snapshot?.vramMb / 1024，兜底 0
  const usedVramGb = useMemo(() => {
    if (typeof metrics?.usedVramBytes === 'number' && metrics.usedVramBytes >= 0) {
      return metrics.usedVramBytes / 1024 ** 3
    }
    if (typeof arbiter?.vram_used_mb === 'number' && arbiter.vram_used_mb >= 0) {
      return arbiter.vram_used_mb / 1024
    }
    if (typeof hardware?.used_vram_gb === 'number' && hardware.used_vram_gb >= 0) {
      return hardware.used_vram_gb
    }
    if (typeof snapshot?.vramMb === 'number' && snapshot.vramMb >= 0) {
      return snapshot.vramMb / 1024
    }
    return 0
  }, [metrics?.usedVramBytes, arbiter?.vram_used_mb, hardware?.used_vram_gb, snapshot?.vramMb])

  // 系统防卡顿保底水位: 优先 metrics?.systemReservedVramBytes / 1024^3，次取 max(1.5, total * 0.15)
  const safetyWatermarkGb = useMemo(() => {
    if (
      typeof metrics?.systemReservedVramBytes === 'number' &&
      metrics.systemReservedVramBytes > 0
    ) {
      return metrics.systemReservedVramBytes / 1024 ** 3
    }
    if (totalVramGb <= 0) return 0
    return Math.max(1.5, totalVramGb * 0.15)
  }, [metrics?.systemReservedVramBytes, totalVramGb])

  // 剩余可用显存: 优先 metrics?.freeVramBytes / 1024^3，次取 max(0, total - used - safety)
  const freeVramGb = useMemo(() => {
    if (typeof metrics?.freeVramBytes === 'number' && metrics.freeVramBytes >= 0) {
      return metrics.freeVramBytes / 1024 ** 3
    }
    if (totalVramGb <= 0) return 0
    return Math.max(0, totalVramGb - usedVramGb - safetyWatermarkGb)
  }, [metrics?.freeVramBytes, totalVramGb, usedVramGb, safetyWatermarkGb])

  // 核显/共享内存保护判定（优先 metrics?.isSharedMemory，次取 isIntegrated || totalVramGb <= 0.5）
  const isSharedOrIntegrated =
    typeof metrics?.isSharedMemory === 'boolean'
      ? metrics.isSharedMemory
      : isIntegrated || totalVramGb <= 0.5

  // 显存使用率 (0 ~ 100)
  const usedPercentage = useMemo(() => {
    if (isSharedOrIntegrated || totalVramGb <= 0) return 0
    return Math.min(100, Math.max(0, (usedVramGb / totalVramGb) * 100))
  }, [isSharedOrIntegrated, usedVramGb, totalVramGb])

  // 保底安全水位占比 (0 ~ 100)，增加剩余空间钳位防色块拉伸溢出
  const safetyPercentage = useMemo(() => {
    if (isSharedOrIntegrated || totalVramGb <= 0) return 0
    const rawSafetyPct = (safetyWatermarkGb / totalVramGb) * 100
    return Math.min(rawSafetyPct, Math.max(0, 100 - usedPercentage))
  }, [isSharedOrIntegrated, safetyWatermarkGb, totalVramGb, usedPercentage])

  // Swapping 置换状态与排队推理任务
  const isSwapping =
    metrics?.swapping?.isSwapping ??
    (arbiter?.phase === 'swapping' || raw?.reasonCode === 'engine_swapping')
  const hasQueuedTasks =
    hasPendingAnalysis ||
    Boolean(typeof arbiter?.queue_position === 'number' && arbiter.queue_position > 0)

  const showSwappingBanner = isSwapping && hasQueuedTasks
  const etaSeconds = useMemo(() => {
    const ms =
      typeof metrics?.swapping?.etaMs === 'number' && metrics.swapping.etaMs > 0
        ? metrics.swapping.etaMs
        : typeof arbiter?.eta_ms === 'number' && arbiter.eta_ms > 0
          ? arbiter.eta_ms
          : 2500
    return Math.max(0.5, ms / 1000).toFixed(1)
  }, [metrics?.swapping?.etaMs, arbiter?.eta_ms])

  // Worker 1: 大语言模型状态
  const isLLMRunning =
    metrics?.workers?.llm?.state === 'processing' ||
    raw?.status === 'processing' ||
    arbiter?.phase === 'serving'

  return (
    <Card
      className={cn(
        'p-5 border-border/80 shadow-xs rounded-2xl bg-card overflow-hidden space-y-4',
        className
      )}
    >
      {/* 1. Swapping 置换呼吸横幅 */}
      {showSwappingBanner && (
        <div className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-300 animate-pulse transition-opacity duration-300">
          <RefreshCw className="h-4 w-4 animate-spin text-amber-600 dark:text-amber-400 shrink-0" />
          <span className="text-xs font-medium leading-relaxed">
            {t(
              '正在调度释放显卡显存空间，大约还需 {seconds} 秒，任务已自动挂起排队，无需担心失败。',
              { seconds: etaSeconds }
            )}
          </span>
        </div>
      )}

      {/* 2. 显卡与显存总览条 */}
      <div className="space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary border border-primary/20">
              <Cpu className="h-4 w-4" />
            </div>
            <div>
              <span className="text-xs font-semibold text-foreground/90 block leading-tight">
                {t('显卡与显存总览')}
              </span>
              <span className="text-[11px] text-muted-foreground font-mono">{gpuName}</span>
            </div>
          </div>

          {isSharedOrIntegrated ? (
            <Badge variant="outline" className="text-xs bg-muted/40 font-normal py-0.5">
              <ShieldCheck className="h-3 w-3 mr-1 text-emerald-600 dark:text-emerald-400" />
              {t('共享加速内存')}
            </Badge>
          ) : (
            <span className="text-xs font-medium text-foreground/80">
              {usedPercentage.toFixed(0)}%
            </span>
          )}
        </div>

        {/* 显存进度条与文本说明 */}
        {isSharedOrIntegrated ? (
          <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-muted/20 border border-border/40 text-xs text-muted-foreground">
            <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <span className="leading-relaxed">
              {t('正在使用系统共享加速内存（智能防卡顿保护已开启）')}
            </span>
          </div>
        ) : (
          <div className="space-y-1.5">
            {/* 复合多段进度条：已用显存 + 系统保底 */}
            <div className="h-2.5 w-full bg-muted/50 rounded-full overflow-hidden flex relative border border-border/40">
              <div
                className="h-full bg-primary rounded-l-full transition-all duration-300"
                style={{ width: `${usedPercentage}%` }}
                title={`${t('已用显存')}: ${usedVramGb.toFixed(1)} GB`}
              />
              <div
                className="h-full bg-amber-500/30 dark:bg-amber-500/20 transition-all duration-300 border-l border-amber-500/30"
                style={{ width: `${safetyPercentage}%` }}
                title={`${t('系统防卡顿保底')}: ${safetyWatermarkGb.toFixed(1)} GB`}
              />
            </div>

            {/* 大白话文案 */}
            <p className="text-xs text-muted-foreground leading-relaxed">
              {t(
                '已用显存: {used} GB / 显存总容量: {total} GB (剩余可用: {free} GB, 系统防卡顿保底: {safety} GB)',
                {
                  used: usedVramGb.toFixed(1),
                  total: totalVramGb.toFixed(1),
                  free: freeVramGb.toFixed(1),
                  safety: safetyWatermarkGb.toFixed(1)
                }
              )}
            </p>
          </div>
        )}
      </div>

      {/* 3. 4 栏 Worker 状态矩阵 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-1">
        {/* 栏 1：大语言模型 */}
        <div className="p-3 rounded-xl border border-border/60 bg-muted/15 flex flex-col justify-between space-y-2">
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-foreground/90 flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5 text-primary shrink-0" />
                {t('大语言模型')}
              </span>
              <span
                className={cn(
                  'h-2 w-2 rounded-full shrink-0',
                  isLLMRunning ? 'bg-emerald-500' : 'bg-sky-500'
                )}
              />
            </div>
            <p className="text-[11px] text-muted-foreground leading-snug">
              {t('深度语义理解与智能重命名')}
            </p>
          </div>
          <div className="pt-1">
            <span
              className={cn(
                'inline-flex items-center text-[11px] font-medium px-2 py-0.5 rounded-md border',
                isLLMRunning
                  ? 'text-emerald-700 bg-emerald-500/10 border-emerald-500/20 dark:text-emerald-400'
                  : 'text-sky-700 bg-sky-500/10 border-sky-500/20 dark:text-sky-400'
              )}
            >
              {isLLMRunning ? t('正在运行') : t('待命就绪')}
            </span>
          </div>
        </div>

        {/* 栏 2：向量计算 */}
        <div className="p-3 rounded-xl border border-border/60 bg-muted/15 flex flex-col justify-between space-y-2">
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-foreground/90 flex items-center gap-1.5">
                <Layers className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                {t('向量计算')}
              </span>
              <span className="h-2 w-2 rounded-full bg-emerald-500 shrink-0" />
            </div>
            <p className="text-[11px] text-muted-foreground leading-snug">
              {t('语义索引与快速搜索')}
            </p>
          </div>
          <div className="pt-1">
            <span className="inline-flex items-center text-[11px] font-medium px-2 py-0.5 rounded-md border text-emerald-700 bg-emerald-500/10 border-emerald-500/20 dark:text-emerald-400 leading-snug">
              {t('独立常驻，显存占用稳定，不参与大模型置换')}
            </span>
          </div>
        </div>

        {/* 栏 3：本地生图（占位） */}
        <div className="p-3 rounded-xl border border-dashed border-border/60 bg-muted/10 opacity-70 flex flex-col justify-between space-y-2">
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-foreground/75 flex items-center gap-1.5">
                <ImageIcon className="h-3.5 w-3.5 text-muted-foreground/70 shrink-0" />
                {t('本地生图')}
              </span>
              <span className="h-2 w-2 rounded-full bg-muted-foreground/40 shrink-0" />
            </div>
            <p className="text-[11px] text-muted-foreground leading-snug">
              {t('图像生成与画面修复')}
            </p>
          </div>
          <div className="pt-1">
            <span className="inline-flex items-center text-[11px] font-medium px-2 py-0.5 rounded-md border text-muted-foreground bg-muted/40 border-border/40">
              {t('即将推出')}
            </span>
          </div>
        </div>

        {/* 栏 4：离线语音合成（占位） */}
        <div className="p-3 rounded-xl border border-dashed border-border/60 bg-muted/10 opacity-70 flex flex-col justify-between space-y-2">
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-foreground/75 flex items-center gap-1.5">
                <Mic className="h-3.5 w-3.5 text-muted-foreground/70 shrink-0" />
                {t('离线语音合成')}
              </span>
              <span className="h-2 w-2 rounded-full bg-muted-foreground/40 shrink-0" />
            </div>
            <p className="text-[11px] text-muted-foreground leading-snug">
              {t('文字朗读与伴音生成')}
            </p>
          </div>
          <div className="pt-1">
            <span className="inline-flex items-center text-[11px] font-medium px-2 py-0.5 rounded-md border text-muted-foreground bg-muted/40 border-border/40">
              {t('即将推出')}
            </span>
          </div>
        </div>
      </div>
    </Card>
  )
}
