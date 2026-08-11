import React, { useMemo } from 'react'
import { AnalysisStats, MarkitdownBenchmark } from '@firefly/types'
import { cn } from '../../../../lib/utils'
import { t } from '@app/languages'

/** 内容提取阶段在 phases 中的键 */
const CONTENT_EXTRACTION_KEYS = [
  'contentExtraction',
  'markitdownServerExtraction',
  'textAndThumbnailExtractionSimple'
]

/** MarkitdownServer 细分指标展示列表（指定固定且高度差异化的专属色彩，避免颜色相近） */
const BENCHMARK_ITEMS: Array<{ key: keyof MarkitdownBenchmark; label: string; color: string }> = [
  { key: 'magikaMs', label: t('类型识别'), color: '#06b6d4' }, // 青蓝
  { key: 'metadataMs', label: t('元数据'), color: '#ec4899' }, // 玫红
  { key: 'textMs', label: t('文本'), color: '#a855f7' }, // 炫紫
  { key: 'documentMs', label: t('正文'), color: '#38bdf8' }, // 冰蓝
  { key: 'ocrMs', label: t('OCR'), color: '#e11d48' }, // 艳红/朱红
  { key: 'htmlMs', label: t('HTML'), color: '#84cc16' }, // 嫩绿
  { key: 'thumbnailMs', label: t('缩略图'), color: '#d946ef' } // 品红
]

/**
 * 阶段键 → 显示 Stage x 标签映射
 */
function getPhaseLabel(key: string): string {
  if (CONTENT_EXTRACTION_KEYS.includes(key)) return t('阶段 2: 内容提取')
  switch (key) {
    case 'thumbnailGeneration':
      return t('缩略图生成')
    case 'qualityScoring':
      return t('阶段 3: AI 文件质量分析')
    case 'directoryAnalysis':
      return t('AI 目录分析')
    case 'dimensionAnalysis':
      return t('阶段 4: AI 标签维度分析')
    case 'textAndThumbnailExtractionSimple':
      return t('阶段 2: 文本与缩略图提取')
    case '哈希与类型识别':
    case 'hashAndTypeIdentification':
      return t('阶段 1: 文件指纹与类型')
    default:
      return key
  }
}

interface AnalysisTimeTabProps {
  stats: {
    durationMs: number
    phases: Record<string, number>
    contentExtractionBreakdown?: MarkitdownBenchmark
    model?: { name?: string }
  }
  maskClass?: string
  /** 文件最近分析时间（渲染进程 lastAnalyzedAt） */
  lastAnalyzedAt?: string
  /** 日期格式化函数（由父级传入） */
  formatDate?: (date: string) => string
}

/**
 * 格式化毫秒为秒（例：1250ms -> 1.25 s，40ms -> 0.04 s，0ms -> 0 s）
 */
function formatSeconds(ms: number): string {
  if (!ms || ms === 0) return '0 s'
  return `${(ms / 1000).toFixed(2)} s`
}

/**
 * 分析耗时 Tab：展示分析时间、各分析阶段耗时，并对内容提取（MarkitdownServer）进行细分
 */
export const AnalysisTimeTab: React.FC<AnalysisTimeTabProps> = ({
  stats: rawStats,
  maskClass,
  lastAnalyzedAt,
  formatDate
}) => {
  const stats = rawStats as AnalysisStats

  // 1. 提取 fresh 与 archive 数据
  const fresh = stats.performance?.fresh || {
    accelerator: (stats as any).accelerator || 'cpu',
    durationMs: stats.durationMs || 0,
    phases: stats.phases || {},
    contentExtractionBreakdown: stats.contentExtractionBreakdown,
    model: stats.model
  }

  const archive = stats.performance?.archive || fresh

  const accelerator = (fresh.accelerator || 'cpu').toLowerCase()
  const isAsyncPipeline = accelerator !== 'cpu'

  // fresh/archive 各自只读取自身携带的细分数据（fresh 为本次实际执行指标，archive 为历史累计指标）
  // 不再回退到顶层兼容字段，避免复用跳过 CPU 时将历史细分指标混入本次耗时
  const freshBreakdown = fresh.contentExtractionBreakdown
  const archiveBreakdown = archive.contentExtractionBreakdown

  // 计算 phases 阶段之和
  const getPhaseSum = (phases: Record<string, number>) =>
    Object.values(phases).reduce((a, b) => a + (Number(b) || 0), 0)

  // 1. 本次物理耗时 (Fresh): 还原为测量的真实物理挂钟耗时 durationMs
  const freshPhaseEntries = Object.entries(fresh.phases || {})
  const freshPhasesSum = getPhaseSum(fresh.phases || {})
  const freshTotalMs = fresh.durationMs || stats.durationMs || freshPhasesSum

  // 2. 历史全量累计耗时 (Archive): 汇总全量阶段累计耗时
  const archivePhaseEntries = Object.entries(archive.phases || {})
  const archivePhasesSum = getPhaseSum(archive.phases || {})
  const archiveTotalMs =
    archive.durationMs && archive.durationMs >= archivePhasesSum
      ? archive.durationMs
      : archivePhasesSum

  // 内容提取阶段细分条目获取
  const getBreakdownItems = (breakdown?: MarkitdownBenchmark) => {
    if (!breakdown) return []
    return BENCHMARK_ITEMS.map(item => {
      const mergedDuration =
        item.key === 'ocrMs'
          ? (Number(breakdown?.[item.key]) || 0) + (Number(breakdown?.officePrePdfMs) || 0)
          : Number(breakdown?.[item.key]) || 0
      return {
        key: item.key,
        label: item.label,
        duration: mergedDuration,
        color: item.color
      }
    }).filter(item => breakdown?.[item.key] !== undefined && breakdown?.[item.key] !== null)
  }

  const freshBreakdownItems = getBreakdownItems(freshBreakdown)
  const archiveBreakdownItems = getBreakdownItems(archiveBreakdown)

  // 专业高对比度调色板 (色彩全波段强区隔)
  const AI_PALETTE = ['#10b981', '#3b82f6', '#8b5cf6'] // Stage 3: 翡翠绿 (#10b981) / Stage 4: 皇家蓝 (#3b82f6)
  const CONTENT_COLOR = '#f59e0b' // 阶段 2 内容提取: 暖琥珀橙 (#f59e0b)
  // 辅助函数：将 phases 记录转化为符合 Specification 的饼图/同轴轨道
  const buildTracksFromPhases = (
    phaseEntries: Array<[string, number]>,
    totalMs: number,
    breakdownItems: typeof freshBreakdownItems,
    labelPrefix: string,
    currentAccelerator: string
  ) => {
    const isCpuMode = currentAccelerator.toLowerCase() === 'cpu'

    // 1. 拆解阶段数据
    // 阶段 1: 指纹识别
    const p1Duration =
      phaseEntries.find(
        ([k]) => k === 'hashAndTypeIdentification' || k === '哈希与类型识别'
      )?.[1] || 0
    // 阶段 2: 内容提取
    const p2Duration =
      freshBreakdown?.totalMs ||
      phaseEntries.find(([k]) => CONTENT_EXTRACTION_KEYS.includes(k))?.[1] ||
      0
    // 阶段 3: AI 质量
    const p3Duration =
      phaseEntries.find(([k]) => k === 'qualityScoring' || k.includes('质量'))?.[1] || 0
    // 阶段 4: AI 维度
    const p4Duration =
      phaseEntries.find(([k]) => k === 'dimensionAnalysis' || k.includes('维度'))?.[1] || 0

    const groupSimpleTotal = p1Duration + p2Duration
    const groupAiTotal = p3Duration + p4Duration

    const tracksList: Array<{
      key: string
      label: string
      duration: number
      pct: number
      radius: number
      strokeWidth: number
      slices: Array<{
        key: string
        label: string
        duration: number
        startAngle: number
        endAngle: number
        color: string
      }>
    }> = []

    // 记录 Stage 2 的真实起始角度 startAngle 与占用的轨半径, 供第3、4、5... 轨细分指标定位
    let stage2StartAngle = 0
    let stage2SpanAngle = 0

    if (isCpuMode) {
      // ============================================================
      // 分支 1：SELECTED_ACCELERATION === 'cpu' (同步模式)
      // 饼图最内圈整圆 (R=18) 由四个阶段的各耗时部分组成 (1 -> 2 -> 3 -> 4)
      // ============================================================
      const allPhases = [
        {
          key: 'hashAndTypeIdentification',
          label: getPhaseLabel('hashAndTypeIdentification'),
          duration: p1Duration,
          color: '#6366f1'
        },
        {
          key: 'contentExtraction',
          label: getPhaseLabel('contentExtraction'),
          duration: p2Duration,
          color: CONTENT_COLOR
        },
        {
          key: 'qualityScoring',
          label: getPhaseLabel('qualityScoring'),
          duration: p3Duration,
          color: AI_PALETTE[0]
        },
        {
          key: 'dimensionAnalysis',
          label: getPhaseLabel('dimensionAnalysis'),
          duration: p4Duration,
          color: AI_PALETTE[1]
        }
      ].filter(p => p.duration > 0)

      const sumAll = allPhases.reduce((s, p) => s + p.duration, 0)
      if (sumAll > 0) {
        let acc = 0
        const slices = allPhases.map(p => {
          const startAngle = acc * 360
          const span = (p.duration / sumAll) * 360
          acc += p.duration / sumAll
          const endAngle = acc * 360

          if (p.key === 'contentExtraction') {
            stage2StartAngle = startAngle
            stage2SpanAngle = span
          }

          return {
            key: p.key,
            label: p.label,
            duration: p.duration,
            startAngle,
            endAngle,
            color: p.color
          }
        })

        tracksList.push({
          key: `${labelPrefix}_cpu_main`,
          label: `${labelPrefix} (${t('CPU同步全阶段')})`,
          duration: sumAll,
          pct: totalMs > 0 ? (sumAll / totalMs) * 100 : 100,
          radius: 18,
          strokeWidth: 6,
          slices
        })
      }
    } else {
      // ============================================================
      // 分支 2：SELECTED_ACCELERATION !== 'cpu' (GPU/并发模式)
      // 最内圈整圆 (R=18 轨道1) = (阶段1+2) > (阶段3+4) ? (阶段1+2) : (阶段3+4)
      // 第2轨道 (R=27) 为较小一方：也同时包含两个阶段
      // ============================================================
      const simpleItems = [
        {
          key: 'hashAndTypeIdentification',
          label: getPhaseLabel('hashAndTypeIdentification'),
          duration: p1Duration,
          color: '#6366f1'
        },
        {
          key: 'contentExtraction',
          label: getPhaseLabel('contentExtraction'),
          duration: p2Duration,
          color: CONTENT_COLOR
        }
      ].filter(p => p.duration > 0)

      const aiItems = [
        {
          key: 'qualityScoring',
          label: getPhaseLabel('qualityScoring'),
          duration: p3Duration,
          color: AI_PALETTE[0]
        },
        {
          key: 'dimensionAnalysis',
          label: getPhaseLabel('dimensionAnalysis'),
          duration: p4Duration,
          color: AI_PALETTE[1]
        }
      ].filter(p => p.duration > 0)

      const isSimpleLonger = groupSimpleTotal >= groupAiTotal
      const longerGroupTotal = Math.max(groupSimpleTotal, groupAiTotal, 1)

      // --- 第 1 轨道 (R=18 满圆 360°): 较大一方 ---
      const track1Items = isSimpleLonger ? simpleItems : aiItems
      const track1GroupTotal = isSimpleLonger ? groupSimpleTotal : groupAiTotal

      if (track1GroupTotal > 0) {
        let acc1 = 0
        const slices1 = track1Items.map(p => {
          const startAngle = acc1 * 360
          const span = (p.duration / track1GroupTotal) * 360
          acc1 += p.duration / track1GroupTotal
          const endAngle = acc1 * 360

          if (p.key === 'contentExtraction') {
            stage2StartAngle = startAngle
            stage2SpanAngle = span
          }

          return {
            key: p.key,
            label: p.label,
            duration: p.duration,
            startAngle,
            endAngle,
            color: p.color
          }
        })

        tracksList.push({
          key: `${labelPrefix}_gpu_t1`,
          label: isSimpleLonger ? t('简单分析 (阶段1+2)') : t('AI分析 (阶段3+4)'),
          duration: track1GroupTotal,
          pct: totalMs > 0 ? (track1GroupTotal / totalMs) * 100 : 100,
          radius: 18,
          strokeWidth: 6,
          slices: slices1
        })
      }

      // --- 第 2 轨道 (R=27 弧形): 较小一方 ---
      const track2Items = isSimpleLonger ? aiItems : simpleItems
      const track2GroupTotal = isSimpleLonger ? groupAiTotal : groupSimpleTotal

      if (track2GroupTotal > 0) {
        const track2MaxAngle = Math.min((track2GroupTotal / longerGroupTotal) * 360, 359.9)
        let acc2 = 0
        const slices2 = track2Items.map(p => {
          const startAngle = acc2 * track2MaxAngle
          const span = (p.duration / track2GroupTotal) * track2MaxAngle
          acc2 += p.duration / track2GroupTotal
          const endAngle = acc2 * track2MaxAngle

          if (p.key === 'contentExtraction') {
            stage2StartAngle = startAngle
            stage2SpanAngle = span
          }

          return {
            key: p.key,
            label: p.label,
            duration: p.duration,
            startAngle,
            endAngle,
            color: p.color
          }
        })

        tracksList.push({
          key: `${labelPrefix}_gpu_t2`,
          label: isSimpleLonger ? t('AI分析 (阶段3+4)') : t('简单分析 (阶段1+2)'),
          duration: track2GroupTotal,
          pct:
            totalMs > 0
              ? (track2GroupTotal / totalMs) * 100
              : (track2GroupTotal / longerGroupTotal) * 100,
          radius: 27,
          strokeWidth: 5,
          slices: slices2
        })
      }
    }

    // ============================================================
    // 第 3、4、5... 轨道：显示 stage2 的细分指标耗时
    // 每个指标一个轨道，起点为 stage2 的起点 (stage2StartAngle)
    // ============================================================
    if (breakdownItems.length > 0 && p2Duration > 0) {
      breakdownItems.forEach((item, idx) => {
        // 允许细分指标耗时超过内容提取 p2Duration 时显示实际延伸长度
        const itemRatio = item.duration / p2Duration
        const itemSpanAngle = Math.min(Math.max(itemRatio * stage2SpanAngle, 2), 360)
        const startAngle = stage2StartAngle
        const endAngle = startAngle + itemSpanAngle

        tracksList.push({
          key: `${labelPrefix}_breakdown_${item.key}`,
          label: item.label,
          duration: item.duration,
          pct: totalMs > 0 ? (item.duration / totalMs) * 100 : itemRatio * 100,
          radius: 34 + idx * 5,
          strokeWidth: 3,
          slices: [
            {
              key: item.key,
              label: item.label,
              duration: item.duration,
              startAngle,
              endAngle,
              color: item.color
            }
          ]
        })
      })
    }

    return { tracks: tracksList }
  }

  // 计算 Fresh 轨道 (如实显示)
  const { tracks: freshTracks } = useMemo(
    () =>
      buildTracksFromPhases(
        freshPhaseEntries,
        freshTotalMs,
        freshBreakdownItems,
        t('本次分析各阶段'),
        accelerator
      ),
    [freshPhaseEntries, freshTotalMs, freshBreakdownItems, accelerator]
  )

  // 计算 Archive 轨道 (如实显示)
  const { tracks: archiveTracks } = useMemo(
    () =>
      buildTracksFromPhases(
        archivePhaseEntries,
        archiveTotalMs,
        archiveBreakdownItems,
        t('历史分析各阶段'),
        accelerator
      ),
    [archivePhaseEntries, archiveTotalMs, archiveBreakdownItems, accelerator]
  )
  // 按照 阶段1 -> 阶段2 -> 阶段2细分 -> 阶段3 -> 阶段4 排序阶段指标列表，并标记 Stage 2 子项
  const getSortedSlices = (tracks: typeof freshTracks) => {
    const allSlices: Array<{
      key: string
      label: string
      duration: number
      color: string
      weight: number
      isSubItem: boolean
    }> = []

    const seenKeys = new Set<string>()

    tracks.forEach((track, trackIdx) => {
      track.slices.forEach((slice, sliceIdx) => {
        if (seenKeys.has(slice.key)) return
        seenKeys.add(slice.key)

        let weight = 999
        let isSubItem = false

        if (slice.key === 'hashAndTypeIdentification' || slice.key === '哈希与类型识别') {
          weight = 10
        } else if (slice.key === 'contentExtraction' || slice.key === '内容与缩略图提取') {
          weight = 20
        } else if (slice.key === 'qualityScoring' || slice.key.includes('质量')) {
          weight = 30
        } else if (slice.key === 'dimensionAnalysis' || slice.key.includes('维度')) {
          weight = 40
        } else {
          weight = 21 + sliceIdx + trackIdx * 0.1
          isSubItem = true
        }

        allSlices.push({
          key: slice.key,
          label: slice.label,
          duration: slice.duration,
          color: slice.color,
          weight,
          isSubItem
        })
      })
    })

    return allSlices.sort((a, b) => a.weight - b.weight)
  }

  // 通用 SVG 弧线/多环渲染器
  const renderRingSlice = (
    startAngle: number,
    endAngle: number,
    radius: number,
    strokeWidth: number,
    color: string,
    key: string
  ) => {
    const pct = (endAngle - startAngle) / 360
    if (pct >= 0.999) {
      return (
        <circle
          key={key}
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
        />
      )
    }
    const startRad = ((startAngle - 90) * Math.PI) / 180
    const endRad = ((endAngle - 90) * Math.PI) / 180
    const x1 = 50 + radius * Math.cos(startRad)
    const y1 = 50 + radius * Math.sin(startRad)
    const x2 = 50 + radius * Math.cos(endRad)
    const y2 = 50 + radius * Math.sin(endRad)
    const largeArcFlag = endAngle - startAngle > 180 ? 1 : 0
    const d = `M ${x1} ${y1} A ${radius} ${radius} 0 ${largeArcFlag} 1 ${x2} ${y2}`
    return (
      <path
        key={key}
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        className="transition-all duration-300 hover:opacity-80 cursor-pointer"
      />
    )
  }

  // 计算最大外圈视口尺寸
  const freshSvgViewBoxSize = Math.max(100, 50 + 34 + freshBreakdownItems.length * 5 + 6)
  const archiveSvgViewBoxSize = Math.max(100, 50 + 34 + archiveBreakdownItems.length * 5 + 6)

  return (
    <div className={'text-xs space-y-3.5 @container'}>
      {/* 1. 顶部分析时间与算力流徽章 */}
      <div className="p-3 rounded-xl border border-border/40 bg-muted/20 flex items-center justify-between">
        {lastAnalyzedAt && (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">{t('分析时间')}</span>
            <span className="font-mono text-foreground font-medium">
              {formatDate ? formatDate(lastAnalyzedAt) : lastAnalyzedAt}
            </span>
          </div>
        )}
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-primary/10 border border-primary/20 text-[11px] font-mono font-semibold text-primary">
          <span>{accelerator.toUpperCase()}</span>
          {isAsyncPipeline ? (
            <span className="flex items-center gap-1 text-emerald-500 font-sans text-[10px] font-bold">
              <span>⚡</span>
              <span>{t('异步流')}</span>
            </span>
          ) : (
            <span className="flex items-center gap-1 text-blue-500 font-sans text-[10px] font-bold">
              <span>⚙️</span>
              <span>{t('同步流')}</span>
            </span>
          )}
        </div>
      </div>

      {/* 2. 区块一：【本次分析耗时】 */}
      <div className="rounded-xl border border-border/60 bg-muted/40 dark:bg-card/90 p-3.5 space-y-3 shadow-sm">
        <div className="text-xs font-semibold text-foreground flex items-center justify-between border-b border-border/40 pb-2">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" />
            {t('本次分析耗时')}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="text-[11px] font-normal text-muted-foreground">
              {t('本次物理耗时')}
            </span>
            <span className="font-mono text-sm font-bold text-emerald-500 bg-emerald-500/10 px-2 py-0.5 rounded-full">
              {formatSeconds(freshTotalMs)}
            </span>
          </span>
        </div>

        {freshPhaseEntries.length > 0 ? (
          <div className="flex flex-col @sm:flex-row items-center gap-4 pt-1">
            {/* SVG 同轴多轨道圆饼图 */}
            <div className="flex flex-col items-center justify-center relative shrink-0 mx-auto">
              <svg viewBox="0 0 100 100" className="w-36 h-36 transform -rotate-90">
                {/* 遍历多同轴轨道：从最内圈 (R=18 满圆) 到最外轨 */}
                {freshTracks.map(track =>
                  track.slices.map(slice =>
                    renderRingSlice(
                      slice.startAngle,
                      slice.endAngle,
                      track.radius,
                      track.strokeWidth,
                      slice.color,
                      `fresh_track_${track.key}_${slice.key}`
                    )
                  )
                )}
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none text-center leading-tight">
                <span className="text-[10px] text-muted-foreground font-medium">{t('阶段')}</span>
                <span className="text-base font-extrabold font-mono text-foreground">
                  {stats.analysis_stage || (freshPhaseEntries.length > 2 ? 4 : 2)}
                </span>
              </div>
            </div>

            {/* 精简统一图例：色彩点 指标名称 耗时s(百分比)，并按 阶段1 -> 阶段2 -> 阶段2细分 -> 阶段3 -> 阶段4 自然顺序展现 (阶段2子项层级缩进) */}
            <div className="w-full flex-1 space-y-1.5">
              {getSortedSlices(freshTracks).map(slice => (
                <div
                  key={`legend_fresh_${slice.key}`}
                  className={cn(
                    'flex items-center justify-between text-xs py-0.5 transition-all',
                    slice.isSubItem &&
                      'pl-4 text-[11px] opacity-90 border-l border-amber-500/30 ml-1'
                  )}
                >
                  <div className="flex items-center gap-2 truncate">
                    <span
                      className={cn(
                        'rounded-sm shrink-0',
                        slice.isSubItem ? 'w-1.5 h-1.5 rounded-full' : 'w-2.5 h-2.5'
                      )}
                      style={{ backgroundColor: slice.color }}
                    />
                    <span className="text-muted-foreground truncate">
                      {slice.isSubItem && <span className="opacity-50 mr-1 text-[10px]">└</span>}
                      {slice.label}
                    </span>
                  </div>
                  <span className="font-mono text-foreground font-medium">
                    {formatSeconds(slice.duration)} (
                    {freshPhasesSum > 0
                      ? ((slice.duration / freshPhasesSum) * 100).toFixed(1)
                      : '0.0'}
                    %)
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground italic text-center py-2">
            {t('本次分析阶段耗时已在并行线程中完成')}
          </div>
        )}
      </div>

      {/* 3. 区块二：【历史耗时 (全量归档)】 */}
      {archivePhaseEntries.length > 0 && (
        <div className="rounded-xl border border-border/40 bg-muted/20 p-3.5 space-y-3 shadow-sm">
          <div className="text-xs font-semibold text-foreground flex items-center justify-between border-b border-border/30 pb-2">
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-primary inline-block" />
              {t('历史耗时')}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="text-[11px] font-normal text-muted-foreground">
                {t('全量累计耗时')}
              </span>
              <span className="font-mono text-sm font-bold text-primary bg-primary/10 px-2 py-0.5 rounded-full">
                {formatSeconds(archiveTotalMs)}
              </span>
            </span>
          </div>

          <div className="flex flex-col @sm:flex-row items-center gap-4 pt-1">
            {/* 归档 SVG 多轨道圆饼图 */}
            <div className="flex flex-col items-center justify-center relative shrink-0 mx-auto">
              <svg viewBox="0 0 100 100" className="w-36 h-36 transform -rotate-90">
                {archiveTracks.map(track =>
                  track.slices.map(slice =>
                    renderRingSlice(
                      slice.startAngle,
                      slice.endAngle,
                      track.radius,
                      track.strokeWidth,
                      slice.color,
                      `arc_track_${track.key}_${slice.key}`
                    )
                  )
                )}
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none text-center leading-tight">
                <span className="text-[10px] text-muted-foreground font-medium">{t('阶段')}</span>
                <span className="text-base font-extrabold font-mono text-foreground">
                  {stats.analysis_stage || (archivePhaseEntries.length > 2 ? 4 : 2)}
                </span>
              </div>
            </div>

            {/* 精简统一归档图例：色彩点 指标名称 耗时s(百分比)，按 (Archive - Fresh) 集合差精准标注【复用】 */}
            <div className="w-full flex-1 space-y-1.5">
              {getSortedSlices(archiveTracks).map(slice => {
                // 判断是否属于 (Archive - Fresh) 差集 (即本次物理运行未执行、从历史归档复用的指标)
                let isReused = false
                if (slice.isSubItem) {
                  // Stage 2 细分指标
                  const hasFreshStage2 = CONTENT_EXTRACTION_KEYS.some(
                    k => fresh.phases && fresh.phases[k] !== undefined && fresh.phases[k] > 0
                  )
                  const hasFreshBreakdownKey =
                    freshBreakdown &&
                    (freshBreakdown as any)[slice.key] !== undefined &&
                    (freshBreakdown as any)[slice.key] > 0
                  isReused = !hasFreshStage2 && !hasFreshBreakdownKey
                } else if (
                  slice.key === 'hashAndTypeIdentification' ||
                  slice.key === '哈希与类型识别'
                ) {
                  // 阶段 1: 文件指纹与类型
                  const p1 =
                    fresh.phases?.hashAndTypeIdentification ?? fresh.phases?.['哈希与类型识别']
                  isReused = p1 === undefined || p1 <= 0
                } else if (CONTENT_EXTRACTION_KEYS.includes(slice.key)) {
                  // 阶段 2: 内容提取
                  const hasFreshStage2 = CONTENT_EXTRACTION_KEYS.some(
                    k => fresh.phases && fresh.phases[k] !== undefined && fresh.phases[k] > 0
                  )
                  isReused = !hasFreshStage2
                } else {
                  // 阶段 3 / 阶段 4 / 其他主阶段
                  const val = fresh.phases?.[slice.key]
                  isReused = val === undefined || val <= 0
                }

                return (
                  <div
                    key={`arc_legend_${slice.key}`}
                    className={cn(
                      'flex items-center justify-between text-xs py-0.5 transition-all',
                      slice.isSubItem &&
                        'pl-4 text-[11px] opacity-90 border-l border-amber-500/30 ml-1'
                    )}
                  >
                    <div className="flex items-center gap-2 truncate">
                      <span
                        className={cn(
                          'rounded-sm shrink-0',
                          slice.isSubItem ? 'w-1.5 h-1.5 rounded-full' : 'w-2.5 h-2.5'
                        )}
                        style={{ backgroundColor: slice.color }}
                      />
                      <span className="text-muted-foreground truncate">
                        {slice.isSubItem && <span className="opacity-50 mr-1 text-[10px]">└</span>}
                        {slice.label}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 font-mono text-foreground font-medium">
                      <span>
                        {formatSeconds(slice.duration)} (
                        {archiveTotalMs > 0
                          ? ((slice.duration / archiveTotalMs) * 100).toFixed(1)
                          : '0.0'}
                        %)
                      </span>
                      {isReused && (
                        <span className="text-[9px] px-1 bg-amber-500/10 border border-amber-500/20 rounded text-amber-600 dark:text-amber-400 font-sans font-normal">
                          {t('复用')}
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* 4. AI 推理模型信息（优先读本次 fresh.model，兼容旧数据根级 model） */}
      {(fresh.model?.name || archive.model?.name || stats.model?.name) && (
        <div className="p-2.5 rounded-xl border border-border/40 bg-muted/20 flex items-center justify-between text-xs">
          <span className="text-muted-foreground">{t('推理模型')}</span>
          <span className="font-mono text-primary font-medium truncate max-w-[180px]">
            {fresh.model?.name || archive.model?.name || stats.model?.name}
          </span>
        </div>
      )}
    </div>
  )
}
