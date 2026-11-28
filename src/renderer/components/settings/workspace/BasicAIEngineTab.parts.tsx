/**
 * R-27（W6）超大文件物理拆分片段：原 `BasicAIEngineTab.tsx` 的纯展示/工具前置区。
 * 与主文件同目录，保持全部相对 import 深度不变；由原文件切片生成，既有实现与注释零改动。
 */
import {
  Check,
  Gauge,
  HelpCircle,
  Layers,
  Mic,
  Lock,
  RefreshCw,
  Sparkles,
  ChevronDown,
  ChevronRight,
  Sliders,
  Loader2,
  CheckCircle2,
  RotateCcw
} from 'lucide-react'
import React, { useEffect, useState, useMemo, useRef, useCallback } from 'react'
import { Button } from '../../ui/button'
import { Card } from '../../ui/card'
import { Switch } from '../../ui/switch'
import { Label } from '../../ui/label'
import { TriStateFieldFeedback } from './TriStateFieldFeedback'
import { TriStateCustomFieldsTable, type TriStateCustomFieldRow } from './TriStateCustomFieldsTable'
import {
  BaseAIConfig,
  WorkspaceDirectory,
  WorkspaceConfig,
  TechnicalEngineParameters,
  parseWorkspaceConfig,
  HardwareInfo,
  DEFAULT_UNBOUND_AI_CONFIG
} from '@firefly/types'
import {
  VideoAnalysisProfile,
  VideoCutSensitivity,
  VIDEO_ANALYSIS_PRESETS,
  estimateVideoAnalysisDurationSec,
  isAppleSiliconPlatform,
  isDedicatedGpu,
  mapIntentToParameters
} from '@firefly/shared'
import { captureEvent } from '../../../lib/posthog'
import { useSettingsStore } from '../../../stores/settings-store'
import { usePluginCenterStore } from '../../../stores/plugin-center-store'
import { toast } from '../../common/Toast'
import { t } from '@app/languages'
import {
  ScaleTickItem,
  ScaleTicksBar,
  PolicySliderRow,
  PolicySliderTick,
  useSmoothSlider,
  VIDEO_COVERAGE_GRADIENT
} from './policy-slider-kit'
import { useWorkspacePolicyPatchChannel } from './use-workspace-policy-patch-channel'
import { getIntentDisplayName } from '../WorkspaceConfigPanel'
import { cn } from '../../../lib/utils'

export interface BasicAIEngineTabProps {
  workspace: WorkspaceDirectory
  hardwareInfo?: HardwareInfo | null
  isActive?: boolean
  onConfigSaved?: () => void
  resolvedFields?: Record<
    string,
    import('../../../lib/workspace-policy/workspace-ai-client').ResolvedTriStateField
  >
  hasBoundWorkflow?: boolean
  onFixAction?: (
    action: import('../../../lib/workspace-policy/workspace-ai-client').DegradationFixAction,
    pluginId?: string
  ) => void
  /** 同弹窗内跳转至其它工作目录设置 Tab（例如直达「待补分析文件」） */
  onNavigateTab?: (tabId: 'pending_backfill') => void
}

/**
 * BASIC_AI_KEYS 参数项展示名（渲染期 switch 动态返回静态 t() 以支持语言切换，
 * 严禁置于模块级静态对象字面量——t() 静态对象切换语言后无法刷新）
 */
export function getBasicAiFieldLabel(key: string): string {
  switch (key) {
    case 'analysisMode':
      return t('选择分析模式')
    case 'videoQuotaMax':
      return t('单视频最大抓图数量')
    case 'videoCutSensitivity':
      return t('镜头切换捕捉敏锐度')
    case 'videoSoftTokenBudget':
      return t('画面识别精细度')
    case 'videoAnalyzeDurationSec':
      return t('每个视频分析时长上限')
    case 'videoAsrDurationSec':
      return t('视频伴音台词识别上限')
    case 'audioAnalysisDurationSec':
      return t('纯音频听写时长上限')
    case 'clipTextEnabled':
      return t('文字直接找图')
    case 'reuseBasicAnalysisData':
      return t('重新分析时复用数据')
    default:
      return key
  }
}

/** 设置值四态表格各值列的大白话渲染：布尔转「开启/关闭」、枚举转 UI 命名、数值带单位（渲染期动态 t()） */
export function formatTriStateCellValue(key: string, v: unknown): string {
  if (typeof v === 'boolean') return v ? t('开启') : t('关闭')
  switch (key) {
    case 'analysisMode':
      return v === 'simple'
        ? t('标准分析')
        : v === 'quick_name'
          ? t('增强分析')
          : v === 'full'
            ? t('全面分析')
            : String(v ?? '')
    case 'videoCutSensitivity':
      return v === 'low'
        ? t('常规')
        : v === 'medium'
          ? t('灵敏 (推荐)')
          : v === 'high'
            ? t('极高 (防吞噬)')
            : String(v ?? '')
    case 'videoSoftTokenBudget': {
      const n = Number(v)
      if (!Number.isFinite(n)) return String(v ?? '')
      return n <= 48 ? t('流畅极速') : t('高清精细')
    }
    case 'videoQuotaMax': {
      const n = Number(v)
      if (!Number.isFinite(n)) return String(v ?? '')
      return `${n} ${t('张')}`
    }
    case 'videoAnalyzeDurationSec': {
      const n = Number(v)
      if (!Number.isFinite(n)) return String(v ?? '')
      return `${Math.round(n / 60)} ${t('分钟')}`
    }
    case 'videoAsrDurationSec':
    case 'audioAnalysisDurationSec': {
      const n = Number(v)
      if (!Number.isFinite(n)) return String(v ?? '')
      return `${n} ${t('秒')}`
    }
    default:
      return String(v ?? '')
  }
}

/** 属于基础AI引擎 Tab 专管的参数键列表 (与文件内容萃取隔离，严格剥离全局向量底座键) */
export const BASIC_AI_KEYS: (keyof BaseAIConfig)[] = [
  'analysisMode',
  'videoCutSensitivity',
  'videoSoftTokenBudget',
  'videoQuotaMax',
  'videoAnalyzeDurationSec',
  'videoAsrDurationSec',
  'audioAnalysisDurationSec',
  'clipTextEnabled',
  'reuseBasicAnalysisData'
]

/**
 * 辅助悬浮气泡组件
 */
export const HelpTooltip: React.FC<{ content: string }> = ({ content }) => {
  const [visible, setVisible] = useState(false)
  return (
    <span
      className="relative inline-flex items-center ml-1 cursor-pointer text-muted-foreground hover:text-foreground"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
    >
      <HelpCircle className="h-3.5 w-3.5" />
      {visible && (
        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 p-2 text-xs bg-popover text-popover-foreground border rounded-lg shadow-md z-50 pointer-events-none whitespace-normal normal-case leading-normal font-normal">
          {content}
        </span>
      )}
    </span>
  )
}

/** 3 小时统一分段标尺断点定义（0 → 5分钟 → 30分钟 → 1小时 → 3小时 垂直对齐） */
export const VIDEO_SCALE_BREAKPOINTS = [
  { sec: 0, pct: 0 },
  { sec: 300, pct: 25 },
  { sec: 1800, pct: 50 },
  { sec: 3600, pct: 75 },
  { sec: 10800, pct: 100 }
] as const

/**
 * 将时长/耗时秒数映射到统一 3 小时非线性分段标尺百分比 [minPct..100]
 */
export function durationSecToScalePct(sec: number, minPct = 2): number {
  if (!Number.isFinite(sec) || sec <= 0) return minPct
  if (sec >= 10800) return 100
  for (let i = 0; i < VIDEO_SCALE_BREAKPOINTS.length - 1; i++) {
    const bp0 = VIDEO_SCALE_BREAKPOINTS[i]
    const bp1 = VIDEO_SCALE_BREAKPOINTS[i + 1]
    if (sec <= bp1.sec) {
      const pct = bp0.pct + ((sec - bp0.sec) / (bp1.sec - bp0.sec)) * (bp1.pct - bp0.pct)
      return Math.min(100, Math.max(minPct, Number(pct.toFixed(2))))
    }
  }
  return 100
}

/**
 * 将分段标尺上的百分比位置反解为 5 分钟步进（300s 整数倍）的合法分析时长上限 [300..10800]
 */
export function scalePctToDurationSec(pct: number): number {
  if (!Number.isFinite(pct)) return 300
  const clamped = Math.min(100, Math.max(25, pct))
  for (let i = 0; i < VIDEO_SCALE_BREAKPOINTS.length - 1; i++) {
    const bp0 = VIDEO_SCALE_BREAKPOINTS[i]
    const bp1 = VIDEO_SCALE_BREAKPOINTS[i + 1]
    if (clamped <= bp1.pct) {
      const rawSec = bp0.sec + ((clamped - bp0.pct) / (bp1.pct - bp0.pct)) * (bp1.sec - bp0.sec)
      return Math.min(10800, Math.max(300, Math.round(rawSec / 300) * 300))
    }
  }
  return 10800
}

/** 耗时进度条固定空间渐变（翠绿 → 琥珀橙 → 警示红，越长越有时间成本感） */
export const VIDEO_COST_GRADIENT =
  'linear-gradient(90deg, #10b981 0%, #22c55e 25%, #f59e0b 55%, #f97316 78%, #ef4444 100%)'

export interface VideoScaleTicksProps {
  /** 可选：点击刻度跳转（仅第 1 项控制源滑块使用） */
  onSelect?: (sec: number) => void
  /** 可选：当前选中的时长秒数，用于高亮命中刻度 */
  activeSec?: number
}

/** 三项共用的 3 小时统一分段刻度标尺（像素级垂直对齐） */
export const VideoScaleTicks: React.FC<VideoScaleTicksProps> = ({ onSelect, activeSec }) => {
  const ticks: ReadonlyArray<ScaleTickItem> = [
    { value: 0, pct: 0, label: '0', clickable: false },
    { value: 300, pct: 25, label: t('5 分钟'), clickable: true },
    { value: 1800, pct: 50, label: t('30 分钟'), clickable: true },
    { value: 3600, pct: 75, label: t('1 小时'), clickable: true },
    { value: 10800, pct: 100, label: t('3 小时'), clickable: true }
  ]
  return <ScaleTicksBar ticks={ticks} onSelect={onSelect} activeValue={activeSec} />
}

/** 语音听写时长停靠点：0..180 秒，每 15 秒一档（共 13 档） */
export const ASR_CAP_STOPS: ReadonlyArray<number> = Array.from({ length: 13 }, (_, i) => i * 15)

export interface AsrDurationCapSliderProps {
  testIdPrefix: 'video-asr-cap' | 'audio-analysis-cap'
  mode: 'video_asr' | 'audio_asr'
  title: string
  value: number
  zeroHintText: string
  onChange: (sec: number) => void
  className?: string
}

/**
 * 语音听写与台词提取时长上限平滑滑块（与「每个视频分析时长上限」同构四行视觉 + 无闪回状态机）
 */
export const AsrDurationCapSlider: React.FC<AsrDurationCapSliderProps> = React.memo(
  ({ testIdPrefix, mode, title, value, zeroHintText, onChange, className }) => {
    const ticks: ReadonlyArray<PolicySliderTick> = [
      { value: 0, label: '0' },
      { value: 45, label: t('45 秒') },
      { value: 90, label: t('90 秒') },
      { value: 135, label: t('135 秒') },
      { value: 180, label: t('3 分钟') }
    ]

    const renderValue = (sec: number) => (
      <>
        <span className="text-sm font-extrabold font-mono text-primary">
          {sec} {t('秒')}
        </span>
        {sec === 0 ? (
          <span className="text-[11px] text-muted-foreground font-mono">({zeroHintText})</span>
        ) : (
          sec >= 60 && (
            <span className="text-[11px] text-muted-foreground font-mono">
              ({t('约 {min} 分钟', { min: (sec / 60).toFixed(1) })})
            </span>
          )
        )}
      </>
    )

    const renderLegend = (sec: number) => {
      if (mode === 'video_asr') {
        return {
          left:
            sec === 0
              ? t('设为 0 则不提取伴音台词')
              : t('仅提取视频开头前 {sec} 秒的音轨台词（不影响纯音频），识别越长台词标签越全', {
                  sec
                }),
          badge:
            sec === 0
              ? { paused: true, text: t('已关闭伴音台词提取') }
              : sec <= 60
                ? { paused: false, text: t('涵盖短视频与片头核心台词') }
                : { paused: false, text: t('深度覆盖长视频对白与旁白') }
        }
      }
      return {
        left: t('仅听写音频文件开头前 {sec} 秒的内容，设为 0 则不听写', { sec }),
        badge:
          sec === 0
            ? { paused: true, text: t('已关闭纯音频听写') }
            : sec <= 60
              ? { paused: false, text: t('涵盖语音备忘与短录音') }
              : { paused: false, text: t('深度覆盖播客与会议长录音') }
      }
    }

    return (
      <PolicySliderRow
        testIdPrefix={testIdPrefix}
        title={title}
        capsuleText={t('15 秒一档 · 最长 3 分钟')}
        renderValue={renderValue}
        stops={ASR_CAP_STOPS}
        value={value}
        onChange={onChange}
        ticks={ticks}
        renderLegend={renderLegend}
        className={className}
      />
    )
  }
)

export interface VideoCostLegendProps {
  testId: string
  visualSec: number
  framesCount: number
  asrSec: number
  asrCapSec: number
  fixedSec: number
  rightText: React.ReactNode
}

/** 耗时预估三项细分无色差图例行 */
export const VideoCostLegend: React.FC<VideoCostLegendProps> = ({
  testId,
  visualSec,
  framesCount,
  asrSec,
  asrCapSec,
  fixedSec,
  rightText
}) => (
  <div
    data-testid={testId}
    className="flex items-center justify-between text-[11px] text-muted-foreground pt-0.5 flex-wrap gap-2"
  >
    <div className="flex items-center gap-3 flex-wrap">
      <span>
        🖼️ {t('画面 AI 理解')}:{' '}
        <strong className="text-foreground">{t('约 {sec} 秒', { sec: visualSec })}</strong> (
        {t('{count} 张', { count: framesCount })})
      </span>
      <span>
        🎙️ {t('台词识别')}:{' '}
        <strong className="text-foreground">{t('约 {sec} 秒', { sec: asrSec })}</strong> (
        {t('{sec} 秒音轨', { sec: asrCapSec })})
      </span>
      <span>
        ⚙️ {t('基础开销')}:{' '}
        <strong className="text-foreground">{t('约 {sec} 秒', { sec: fixedSec })}</strong>
      </span>
    </div>
    <span className="text-[10px] font-semibold font-mono">{rightText}</span>
  </div>
)

export interface VideoAnalysisEstimateCardProps {
  videoQuotaMax: number
  localVideoSoftTokenBudget: 48 | 140
  videoAsrCap: number
  hasGpuPower: boolean
  videoAnalyzeDurationSec: number
  onDurationChange: (sec: number) => void
  onNavigateTab?: (tabId: 'pending_backfill') => void
}

/**
 * 实时整理分析耗时预估图形化卡片与每个视频分析时长上限设置卡片（耗时对比组）
 * 独立隔离子组件：维持局部即时状态以实现滑块 60fps+ 丝滑跟随，在拖拽结束后统一防抖提交，
 * 拖拽中屏蔽 transition 避免 CSS 动画与高频布局回流严重卡顿。
 */
export const VideoAnalysisEstimateCard: React.FC<VideoAnalysisEstimateCardProps> = React.memo(
  ({
    videoQuotaMax,
    localVideoSoftTokenBudget,
    videoAsrCap,
    hasGpuPower,
    videoAnalyzeDurationSec,
    onDurationChange,
    onNavigateTab
  }) => {
    const {
      safeValue: safeDurationSec,
      isDragging,
      trackRef,
      inputRef,
      handleSliderChange,
      applyQuickSelect: applyQuickSelectSec,
      handleTrackPointerDown,
      handleTrackPointerMove,
      handleTrackPointerUp,
      handleTrackPointerCancel
    } = useSmoothSlider({
      value: videoAnalyzeDurationSec,
      min: 300,
      max: 10800,
      fallbackValue: 300,
      pctToValue: scalePctToDurationSec,
      onCommit: onDurationChange
    })

    const safeQuotaMax =
      typeof videoQuotaMax === 'number' && Number.isFinite(videoQuotaMax) && videoQuotaMax > 0
        ? videoQuotaMax
        : 60

    const est = estimateVideoAnalysisDurationSec(
      safeQuotaMax,
      localVideoSoftTokenBudget,
      videoAsrCap,
      hasGpuPower,
      300
    )
    const totalMins = (est.totalSec / 60).toFixed(1)

    const fullEst = estimateVideoAnalysisDurationSec(
      safeQuotaMax,
      localVideoSoftTokenBudget,
      videoAsrCap,
      hasGpuPower,
      safeDurationSec
    )
    const fullMins = (fullEst.totalSec / 60).toFixed(1)
    const fullVideoMins = Math.round(safeDurationSec / 60)

    const sliderFillPct = durationSecToScalePct(safeDurationSec, 25)
    const firstSliceFillPct = durationSecToScalePct(est.totalSec, 2)
    const fullFillPct = durationSecToScalePct(fullEst.totalSec, 2)

    const numChunks = Math.max(1, Math.ceil(safeDurationSec / 300))
    const totalFrames = numChunks * safeQuotaMax

    const coverageBadgeText =
      fullVideoMins <= 15
        ? t('涵盖短视频与日常片段')
        : fullVideoMins <= 60
          ? t('涵盖完整剧集与长视频')
          : t('涵盖整部电影与超长录屏')

    return (
      <div className="p-4 rounded-xl bg-card border border-border shadow-xs space-y-4">
        {/* 第 1 项（控制源）：每个视频分析时长上限 */}
        <div className="space-y-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-foreground">{t('每个视频分析时长上限')}</span>
              <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-500/20">
                {t('5 分钟一档 · 最长 3 小时')}
              </span>
            </div>
            <div className="flex items-baseline gap-1">
              <span className="text-sm font-extrabold font-mono text-primary">
                {fullVideoMins} {t('分钟')}
              </span>
              {fullVideoMins >= 60 && (
                <span className="text-[11px] text-muted-foreground font-mono">
                  ({t('约 {hours} 小时', { hours: (safeDurationSec / 3600).toFixed(1) })})
                </span>
              )}
            </div>
          </div>

          <div
            ref={trackRef}
            data-testid="video-analyze-duration-track"
            onPointerDown={handleTrackPointerDown}
            onPointerMove={handleTrackPointerMove}
            onPointerUp={handleTrackPointerUp}
            onPointerCancel={handleTrackPointerCancel}
            className="relative h-3 w-full bg-muted/60 rounded-full flex p-0.5 border border-border/40 cursor-pointer touch-none select-none focus-within:ring-2 focus-within:ring-primary/40"
          >
            <div
              data-testid="duration-cap-fill"
              style={{
                width: `${sliderFillPct}%`,
                backgroundImage: VIDEO_COVERAGE_GRADIENT
              }}
              className={cn('h-full rounded-full', !isDragging && 'transition-all duration-300')}
            />
            <span
              style={{ left: `${sliderFillPct}%` }}
              className={cn(
                'pointer-events-none absolute top-1/2 -translate-y-1/2 -translate-x-1/2 h-4 w-4 rounded-full bg-background border-2 border-indigo-500 shadow-sm',
                !isDragging && 'transition-all duration-300'
              )}
            />
            <input
              ref={inputRef}
              type="range"
              data-testid="video-analyze-duration-slider"
              aria-label={t('每个视频分析时长上限')}
              min={300}
              max={10800}
              step={300}
              value={safeDurationSec}
              onChange={handleSliderChange}
              className="sr-only"
            />
          </div>

          <VideoScaleTicks onSelect={applyQuickSelectSec} activeSec={safeDurationSec} />

          <div
            data-testid="duration-cap-legend"
            className="flex items-center justify-between text-[11px] text-muted-foreground pt-0.5 flex-wrap gap-2"
          >
            <span>
              🎯 {t('覆盖收益：可检索视频前 {mins} 分钟全部画面与台词', { mins: fullVideoMins })}
            </span>
            <span className="text-[10px] font-semibold font-mono text-indigo-600 dark:text-indigo-400">
              ✨ {coverageBadgeText}
            </span>
          </div>
        </div>

        {/* 第 2 项（对比项 A）：单视频首次整理耗时预估 */}
        <div className="space-y-2 pt-3 border-t border-border/30">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-foreground">
                {t('单视频首次整理耗时预估')}
              </span>
              <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-primary/10 text-primary border border-primary/20">
                {t('以每 5 分钟视频分析基准测算')}
              </span>
            </div>
            <div className="flex items-baseline gap-1">
              <span className="text-sm font-extrabold font-mono text-primary">
                {est.minSec} ~ {est.maxSec} {t('秒')}
              </span>
              <span className="text-[11px] text-muted-foreground font-mono">
                ({t('约 {min} 分钟', { min: totalMins })})
              </span>
            </div>
          </div>

          <div className="relative h-3 w-full bg-muted/60 rounded-full flex p-0.5 border border-border/40 overflow-hidden">
            <div
              data-testid="benchmark-video-fill"
              style={{
                width: `${firstSliceFillPct}%`,
                backgroundImage: VIDEO_COST_GRADIENT,
                backgroundSize: `${(100 / Math.max(1, firstSliceFillPct)) * 100}% 100%`
              }}
              className="h-full rounded-full transition-all duration-300"
            />
          </div>

          <VideoScaleTicks />

          <VideoCostLegend
            testId="benchmark-video-legend"
            visualSec={est.visualSec}
            framesCount={safeQuotaMax}
            asrSec={est.asrSec}
            asrCapSec={videoAsrCap}
            fixedSec={est.fixedSec}
            rightText={
              <span className="text-emerald-600 dark:text-emerald-400">
                ⚡ {t('首次整理发生一次 · 搜索毫秒级瞬发')}
              </span>
            }
          />
        </div>

        {/* 第 3 项（对比项 B）：按整片时长测算 */}
        <div className="space-y-2 pt-3 border-t border-border/30">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-foreground">{t('按整片时长测算')}</span>
              <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-sky-500/10 text-sky-600 dark:text-sky-400 border border-sky-500/20">
                {t('上限 {mins} 分钟', { mins: fullVideoMins })}
              </span>
            </div>
            <div className="flex items-baseline gap-1">
              <span className="text-sm font-extrabold font-mono text-primary">
                {fullEst.minSec} ~ {fullEst.maxSec} {t('秒')}
              </span>
              <span className="text-[11px] text-muted-foreground font-mono">
                ({t('约 {min} 分钟', { min: fullMins })})
              </span>
            </div>
          </div>

          <div className="relative h-3 w-full bg-muted/60 rounded-full flex p-0.5 border border-border/40 overflow-hidden">
            <div
              data-testid="full-video-fill"
              style={{
                width: `${fullFillPct}%`,
                backgroundImage: VIDEO_COST_GRADIENT,
                backgroundSize: `${(100 / Math.max(1, fullFillPct)) * 100}% 100%`
              }}
              className={cn('h-full rounded-full', !isDragging && 'transition-all duration-300')}
            />
          </div>

          <VideoScaleTicks />

          <VideoCostLegend
            testId="full-video-legend"
            visualSec={fullEst.visualSec}
            framesCount={totalFrames}
            asrSec={fullEst.asrSec}
            asrCapSec={videoAsrCap}
            fixedSec={fullEst.fixedSec}
            rightText={
              <span className="text-sky-600 dark:text-sky-400">
                ⚡ {t('约 {speed}x 实时处理', { speed: fullEst.speedMultiplier })}
              </span>
            }
          />
        </div>

        {/* 辅助贴心提示与待补分析直达引导 */}
        {est.perChunkSec >= 300 && (
          <div className="p-2.5 rounded-lg bg-purple-500/10 border border-purple-500/20 text-xs text-purple-700 dark:text-purple-300 flex items-center gap-2">
            <span>💡</span>
            <span>
              {t(
                '这个档位对电脑算力要求高：普通轻薄本整理会比视频播放更慢，建议放后台慢慢整理；有独立显卡的电脑大约能快 2~3 倍，多数情况能比实时播放更快完成（具体快多少因显卡型号而异）。'
              )}
            </span>
          </div>
        )}

        {safeDurationSec > 300 && (
          <div
            data-testid="video-fast-first-slice-guide"
            className="p-2.5 rounded-lg bg-sky-500/10 border border-sky-500/20 text-[11px] text-sky-700 dark:text-sky-300 flex items-start justify-between gap-3"
          >
            <p className="leading-relaxed">
              {t(
                '为避免长视频卡住其它文件，超过 5 分钟的视频首次会先分析开头 5 分钟并快速出结果；剩余部分（至您设定的 {mins} 分钟上限）会在电脑空闲时自动补全，导入新文件时会自动让路。',
                { mins: fullVideoMins }
              )}
            </p>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px] text-sky-700 dark:text-sky-300 hover:bg-sky-500/15 shrink-0 font-semibold"
              onClick={() => onNavigateTab?.('pending_backfill')}
            >
              {t('查看待补分析文件')} →
            </Button>
          </div>
        )}
      </div>
    )
  }
)

/**
 * 工作区专有：基础AI引擎设置 Tab (原 basic-ai-engine-config-settings 100% 完整原味还原版)
 */
