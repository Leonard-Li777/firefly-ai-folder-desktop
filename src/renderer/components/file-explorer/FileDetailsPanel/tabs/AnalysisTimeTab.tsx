import React, { useMemo } from 'react'
import { AnalysisStats, MarkitdownBenchmark, Stage1Benchmark } from '@firefly/types'
import { cn } from '../../../../lib/utils'
import { t } from '@app/languages'

/** 内容提取阶段在 phases 中的键 */
const CONTENT_EXTRACTION_KEYS = [
  'contentExtraction',
  'markitdownServerExtraction',
  'textAndThumbnailExtractionSimple'
]

/** 获取阶段 1 细分指标展示列表 */
function getStage1BenchmarkItems(): Array<{
  key: keyof Stage1Benchmark
  label: string
  color: string
}> {
  return [
    { key: 'fingerprintMs', label: t('文件指纹'), color: '#818cf8' }, // 靛蓝
    { key: 'localReuseMs', label: t('本地复用'), color: '#38bdf8' }, // 天蓝
    { key: 'cloudReuseMs', label: t('云端复用'), color: '#06b6d4' } // 青蓝
  ]
}

/** 获取阶段 2 内容提取细分指标展示列表（动态调用 t() 确保多语言即时响应） */
function getBenchmarkItems(): Array<{
  key: keyof MarkitdownBenchmark
  label: string
  color: string
}> {
  return [
    { key: 'magikaMs', label: t('类型识别'), color: '#10b981' }, // 翡翠绿 (Magika 模型)
    { key: 'textMs', label: t('文本'), color: '#a855f7' }, // 炫紫 (原生/anydoc 文本层)
    { key: 'ocrMs', label: t('OCR'), color: '#e11d48' }, // 艳红 (单图/分页 OCR 合计)
    { key: 'metadataMs', label: t('元数据'), color: '#ec4899' }, // 玫红 (Exif/Lofty)
    { key: 'thumbnailMs', label: t('封面图'), color: '#f59e0b' } // 琥珀橙 (封面/缩略图/LO 预转)
  ]
}

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
      return t('阶段 1: 文件指纹与复用判定')
    default:
      return key
  }
}

interface AnalysisTimeTabProps {
  stats: {
    durationMs: number
    phases: Record<string, number>
    stage1Breakdown?: Stage1Benchmark
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
 * 分析耗时 Tab：展示分析时间、各分析阶段耗时，并对阶段 1 与阶段 2 进行细分子指标呈现
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
    stage1Breakdown: stats.stage1Breakdown,
    contentExtractionBreakdown: stats.contentExtractionBreakdown,
    model: stats.model
  }

  const archive = stats.performance?.archive || fresh

  const accelerator = (fresh.accelerator || 'cpu').toLowerCase()
  const isAsyncPipeline = accelerator !== 'cpu'

  // 细分数据解析：严格隔离 fresh 与 archive，严禁将 archive 的历史指标借给 fresh
  const freshStage1Breakdown =
    fresh.stage1Breakdown ||
    stats.performance?.fresh?.stage1Breakdown ||
    (stats.performance ? undefined : stats.stage1Breakdown)
  const archiveStage1Breakdown =
    archive.stage1Breakdown ||
    stats.performance?.archive?.stage1Breakdown ||
    stats.stage1Breakdown ||
    stats.performance?.fresh?.stage1Breakdown

  const freshBreakdown =
    fresh.contentExtractionBreakdown ||
    stats.performance?.fresh?.contentExtractionBreakdown ||
    (stats.performance ? undefined : stats.contentExtractionBreakdown)
  const archiveBreakdown =
    archive.contentExtractionBreakdown ||
    stats.performance?.archive?.contentExtractionBreakdown ||
    stats.contentExtractionBreakdown ||
    stats.performance?.fresh?.contentExtractionBreakdown

  // 计算 phases 阶段之和 (各阶段 1/2/3/4 的实际耗时求和，阶段 2 取并行最大耗时)
  const getPhaseSum = (
    phases: Record<string, number>,
    p2Max?: number,
    p1Max?: number
  ) => {
    let sum = 0
    let hasStage2 = false
    let hasStage1 = false

    for (const [k, v] of Object.entries(phases)) {
      if (CONTENT_EXTRACTION_KEYS.includes(k)) {
        if (!hasStage2) {
          sum += (p2Max !== undefined && p2Max > 0) ? p2Max : (Number(v) || 0)
          hasStage2 = true
        }
      } else if (k === 'hashAndTypeIdentification' || k === '哈希与类型识别') {
        if (!hasStage1) {
          sum += (p1Max !== undefined && p1Max > 0) ? p1Max : (Number(v) || 0)
          hasStage1 = true
        }
      } else if (k === 'qualityScoring' || k.includes('质量') || k === 'dimensionAnalysis' || k.includes('维度')) {
        sum += Number(v) || 0
      } else {
        // 其他独立阶段
        sum += Number(v) || 0
      }
    }
    return sum
  }

  // 阶段 1 细分条目获取 (仅保留耗时 > 0 的有效条目)
  const getStage1BreakdownItems = (breakdown?: Stage1Benchmark) => {
    if (!breakdown) return []
    return getStage1BenchmarkItems()
      .map(item => ({
        key: item.key,
        label: item.label,
        duration: Number(breakdown?.[item.key]) || 0,
        color: item.color,
        stage: 'stage1' as const
      }))
      .filter(item => breakdown?.[item.key] !== undefined && breakdown?.[item.key] !== null && item.duration > 0)
  }

  // 阶段 2 内容提取细分条目获取 (合并 Office pre-pdf 耗时至封面图，并仅保留耗时 > 0 的有效条目)
  const getBreakdownItems = (breakdown?: MarkitdownBenchmark) => {
    if (!breakdown) return []
    return getBenchmarkItems()
      .map(item => {
        let mergedDuration = Number(breakdown?.[item.key]) || 0
        if (item.key === 'thumbnailMs' && breakdown?.officePrePdfMs) {
          mergedDuration += Number(breakdown.officePrePdfMs) || 0
        }
        return {
          key: item.key,
          label: item.label,
          duration: mergedDuration,
          color: item.color,
          stage: 'stage2' as const
        }
      })
      .filter(item => breakdown?.[item.key] !== undefined && breakdown?.[item.key] !== null && item.duration > 0)
  }

  const freshStage1Items = getStage1BreakdownItems(freshStage1Breakdown)
  const archiveStage1Items = getStage1BreakdownItems(archiveStage1Breakdown)
  const freshBreakdownItems = getBreakdownItems(freshBreakdown)
  const archiveBreakdownItems = getBreakdownItems(archiveBreakdown)

  // 1. 本次物理耗时 (Fresh): 还原为测量的真实物理挂钟耗时 durationMs
  const freshPhaseEntries = Object.entries(fresh.phases || {})
  const freshP1Max = freshStage1Breakdown?.totalMs || freshStage1Items.reduce((acc, it) => acc + (it.duration || 0), 0)
  const freshP2Max = freshBreakdown?.totalMs || (freshBreakdownItems.length > 0 ? Math.max(...freshBreakdownItems.map(it => it.duration || 0), 0) : undefined)
  const freshPhasesSum = getPhaseSum(fresh.phases || {}, freshP2Max, freshP1Max)
  const freshTotalMs = fresh.durationMs || stats.durationMs || freshPhasesSum

  // 2. 历史全量累计耗时 (Archive): 汇总全量阶段累计耗时
  const archivePhaseEntries = Object.entries(archive.phases || {})
  const archiveP1Max = archiveStage1Breakdown?.totalMs || archiveStage1Items.reduce((acc, it) => acc + (it.duration || 0), 0)
  const archiveP2Max = archiveBreakdown?.totalMs || (archiveBreakdownItems.length > 0 ? Math.max(...archiveBreakdownItems.map(it => it.duration || 0), 0) : undefined)
  const archivePhasesSum = getPhaseSum(archive.phases || {}, archiveP2Max, archiveP1Max)
  const archiveTotalMs =
    archive.durationMs && archive.durationMs >= archivePhasesSum
      ? archive.durationMs
      : archivePhasesSum

  // 专业高对比度调色板 (色彩全波段强区隔)
  const AI_PALETTE = ['#10b981', '#3b82f6', '#8b5cf6'] // Stage 3: 翡翠绿 (#10b981) / Stage 4: 皇家蓝 (#3b82f6)
  const CONTENT_COLOR = '#f59e0b' // 阶段 2 内容提取: 暖琥珀橙 (#f59e0b)
  
  // 辅助函数：将 phases 记录转化为符合 Specification 的饼图/同轴轨道
  const buildTracksFromPhases = (
    phaseEntries: Array<[string, number]>,
    totalMs: number,
    stage1Items: typeof freshStage1Items,
    breakdownItems: typeof freshBreakdownItems,
    labelPrefix: string,
    currentAccelerator: string
  ) => {
    const isCpuMode = currentAccelerator.toLowerCase() === 'cpu'

    // 1. 拆解阶段数据
    // 阶段 1: 文件指纹与复用判定
    const p1Duration =
      phaseEntries.find(
        ([k]) => k === 'hashAndTypeIdentification' || k === '哈希与类型识别'
      )?.[1] ??
      (stage1Items.length > 0
        ? stage1Items.reduce((acc, it) => acc + (it.duration || 0), 0)
        : 0)
    // 阶段 2: 内容提取 (严格取并行最大值，若有细分指标优先使用细分指标最大耗时)
    const p2BreakdownMax =
      breakdownItems.length > 0
        ? Math.max(...breakdownItems.map(it => it.duration || 0), 0)
        : undefined
    const p2Duration =
      p2BreakdownMax !== undefined && p2BreakdownMax > 0
        ? p2BreakdownMax
        : (phaseEntries.find(([k]) => CONTENT_EXTRACTION_KEYS.includes(k))?.[1] ?? 0)
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

    let stage1StartAngle = 0
    let stage1SpanAngle = 0
    let stage2StartAngle = 0
    let stage2SpanAngle = 0

    if (isCpuMode) {
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
      ].filter(p => p.duration > 0 || (p.key === 'hashAndTypeIdentification' && stage1Items.length > 0))

      const sumAll = allPhases.reduce((s, p) => s + p.duration, 0)
      if (sumAll > 0) {
        let acc = 0
        const slices = allPhases.map(p => {
          const startAngle = acc * 360
          const span = (p.duration / sumAll) * 360
          acc += p.duration / sumAll
          const endAngle = acc * 360

          if (p.key === 'hashAndTypeIdentification') {
            stage1StartAngle = startAngle
            stage1SpanAngle = span
          } else if (p.key === 'contentExtraction') {
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

      const track1Items = isSimpleLonger ? simpleItems : aiItems
      const track1GroupTotal = isSimpleLonger ? groupSimpleTotal : groupAiTotal

      if (track1GroupTotal > 0) {
        let acc1 = 0
        const slices1 = track1Items.map(p => {
          const startAngle = acc1 * 360
          const span = (p.duration / track1GroupTotal) * 360
          acc1 += p.duration / track1GroupTotal
          const endAngle = acc1 * 360

          if (p.key === 'hashAndTypeIdentification') {
            stage1StartAngle = startAngle
            stage1SpanAngle = span
          } else if (p.key === 'contentExtraction') {
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

          if (p.key === 'hashAndTypeIdentification') {
            stage1StartAngle = startAngle
            stage1SpanAngle = span
          } else if (p.key === 'contentExtraction') {
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

    // 阶段 1 细分指标轨道 (同轴弧线，严格对准阶段 1 在主轨道的起始角度与真实跨度)
    let currentBreakdownRadius = 30
    if (stage1Items.length > 0) {
      const effectiveP1 = p1Duration > 0 ? p1Duration : 1
      const baseSpan1 = stage1SpanAngle > 0 ? stage1SpanAngle : 360
      stage1Items.forEach(item => {
        if (item.duration <= 0) return
        const itemRatio = Math.min(Math.max(item.duration / effectiveP1, 0), 1)
        const itemSpanAngle = Math.max(itemRatio * baseSpan1, 2)
        const startAngle = stage1StartAngle
        const endAngle = startAngle + itemSpanAngle

        tracksList.push({
          key: `${labelPrefix}_stage1_${item.key}`,
          label: item.label,
          duration: item.duration,
          pct: totalMs > 0 ? (item.duration / totalMs) * 100 : itemRatio * 100,
          radius: currentBreakdownRadius,
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
        currentBreakdownRadius += 4
      })
    }

    // 阶段 2 细分指标轨道 (同轴弧线，严格对准阶段 2 在主轨道的起始角度与真实跨度，与阶段 2 长度完全等长)
    if (breakdownItems.length > 0) {
      const effectiveP2 = p2Duration > 0 ? p2Duration : 1
      const baseSpan2 = stage2SpanAngle > 0 ? stage2SpanAngle : 360
      breakdownItems.forEach(item => {
        if (item.duration <= 0) return
        const itemRatio = Math.min(Math.max(item.duration / effectiveP2, 0), 1)
        const itemSpanAngle = Math.max(itemRatio * baseSpan2, 2)
        const startAngle = stage2StartAngle
        const endAngle = startAngle + itemSpanAngle

        tracksList.push({
          key: `${labelPrefix}_breakdown_${item.key}`,
          label: item.label,
          duration: item.duration,
          pct: totalMs > 0 ? (item.duration / totalMs) * 100 : itemRatio * 100,
          radius: currentBreakdownRadius,
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
        currentBreakdownRadius += 4
      })
    }

    return { tracks: tracksList }
  }

  // 计算 Fresh 轨道
  const { tracks: freshTracks } = useMemo(
    () =>
      buildTracksFromPhases(
        freshPhaseEntries,
        freshTotalMs,
        freshStage1Items,
        freshBreakdownItems,
        t('本次分析各阶段'),
        accelerator
      ),
    [freshPhaseEntries, freshTotalMs, freshStage1Items, freshBreakdownItems, accelerator]
  )

  // 计算 Archive 轨道
  const { tracks: archiveTracks } = useMemo(
    () =>
      buildTracksFromPhases(
        archivePhaseEntries,
        archiveTotalMs,
        archiveStage1Items,
        archiveBreakdownItems,
        t('历史全量累计'),
        accelerator
      ),
    [archivePhaseEntries, archiveTotalMs, archiveStage1Items, archiveBreakdownItems, accelerator]
  )

  // 提取阶段与细分指标并保持标准排序
  const getSortedSlices = (tracks: typeof freshTracks) => {
    const allSlices: Array<{
      key: string
      label: string
      duration: number
      color: string
      weight: number
      isSubItem: boolean
      stage?: 'stage1' | 'stage2'
    }> = []

    const seenKeys = new Set<string>()

    tracks.forEach((track, trackIdx) => {
      track.slices.forEach((slice, sliceIdx) => {
        if (seenKeys.has(slice.key)) return
        seenKeys.add(slice.key)

        let weight = 999
        let isSubItem = false
        let stage: 'stage1' | 'stage2' | undefined = undefined

        if (slice.key === 'hashAndTypeIdentification' || slice.key === '哈希与类型识别') {
          weight = 10
        } else if (slice.key === 'fingerprintMs' || slice.key === '文件指纹') {
          weight = 11
          isSubItem = true
          stage = 'stage1'
        } else if (slice.key === 'localReuseMs' || slice.key === '本地复用') {
          weight = 12
          isSubItem = true
          stage = 'stage1'
        } else if (slice.key === 'cloudReuseMs' || slice.key === '云端复用') {
          weight = 13
          isSubItem = true
          stage = 'stage1'
        } else if (CONTENT_EXTRACTION_KEYS.includes(slice.key) || slice.key === '阶段 2: 内容提取') {
          weight = 20
        } else if (slice.key === 'magikaMs' || slice.key === '类型识别') {
          weight = 21
          isSubItem = true
          stage = 'stage2'
        } else if (slice.key === 'textMs' || slice.key === '文本') {
          weight = 22
          isSubItem = true
          stage = 'stage2'
        } else if (slice.key === 'ocrMs' || slice.key === 'OCR') {
          weight = 23
          isSubItem = true
          stage = 'stage2'
        } else if (slice.key === 'metadataMs' || slice.key === '元数据') {
          weight = 24
          isSubItem = true
          stage = 'stage2'
        } else if (slice.key === 'thumbnailMs' || slice.key === '封面图') {
          weight = 25
          isSubItem = true
          stage = 'stage2'
        } else if (slice.key === 'qualityScoring' || slice.key.includes('质量')) {
          weight = 30
        } else if (slice.key === 'dimensionAnalysis' || slice.key.includes('维度')) {
          weight = 40
        } else {
          weight = 50 + sliceIdx + trackIdx * 0.1
          isSubItem = true
        }

        allSlices.push({
          key: slice.key,
          label: slice.label,
          duration: slice.duration,
          color: slice.color,
          weight,
          isSubItem,
          stage
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
    key: string,
    label?: string,
    durationText?: string
  ) => {
    const sweep = endAngle - startAngle
    const pct = sweep / 360
    const tooltipText = label ? `${label}: ${durationText || ''}` : ''

    if (pct >= 0.99 || sweep >= 359.9) {
      return (
        <circle
          key={key}
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          className="transition-all duration-300 hover:opacity-80 cursor-pointer"
        >
          {tooltipText && <title>{tooltipText}</title>}
        </circle>
      )
    }
    const startRad = ((startAngle - 90) * Math.PI) / 180
    const endRad = ((endAngle - 90) * Math.PI) / 180
    const x1 = 50 + radius * Math.cos(startRad)
    const y1 = 50 + radius * Math.sin(startRad)
    const x2 = 50 + radius * Math.cos(endRad)
    const y2 = 50 + radius * Math.sin(endRad)
    const largeArcFlag = sweep > 180 ? 1 : 0
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
      >
        {tooltipText && <title>{tooltipText}</title>}
      </path>
    )
  }

  // 计算最大外圈视口尺寸
  const freshSvgViewBoxSize = Math.max(100, 50 + 34 + freshBreakdownItems.length * 5 + 6)
  const archiveSvgViewBoxSize = Math.max(100, 50 + 34 + archiveBreakdownItems.length * 5 + 6)

  return (
    <div className={'text-xs space-y-3.5 @container'}>
      {/* 1. 顶部分析时间/算力流徽章 与 AI 推理模型信息 组合为同一区块（上下两行） */}
      <div className="p-3 rounded-xl border border-border/40 bg-muted/20 space-y-2">
        {/* 第一行：分析时间 + 算力流徽章 */}
        <div className="flex items-center justify-between gap-3">
          {lastAnalyzedAt && (
            <div className="flex items-center gap-2 text-xs whitespace-nowrap">
              <span className="text-muted-foreground">{t('分析时间')}</span>
              <span className="font-mono text-foreground font-medium">
                {formatDate ? formatDate(lastAnalyzedAt) : lastAnalyzedAt}
              </span>
            </div>
          )}
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-primary/10 border border-primary/20 text-[11px] font-mono font-semibold text-primary shrink-0">
            <span>{accelerator.toUpperCase()}</span>
            {isAsyncPipeline ? (
              <span className="flex items-center gap-1 text-emerald-500 font-sans text-[10px] font-bold">
                <span>⚡</span>
                <span>{t('同时')}</span>
              </span>
            ) : (
              <span className="flex items-center gap-1 text-blue-500 font-sans text-[10px] font-bold">
                <span>⚙️</span>
                <span>{t('顺序')}</span>
              </span>
            )}
          </div>
        </div>
        {/* 第二行：AI 推理模型信息（优先读本次 fresh.model，兼容旧数据根级 model） */}
        {(fresh.model?.name || archive.model?.name || stats.model?.name) && (
          <div className="flex items-center justify-between gap-2 text-xs pt-1.5 border-t border-border/40">
            <span className="text-muted-foreground shrink-0">{t('推理模型')}</span>
            <span className="font-mono text-primary font-medium truncate text-right max-w-[240px]">
              {fresh.model?.name || archive.model?.name || stats.model?.name}
            </span>
          </div>
        )}
      </div>
      {/* 2. 区块一：【本次分析物理耗时】 */}
      <div className="rounded-xl border border-border/60 bg-muted/40 dark:bg-card/90 p-3.5 space-y-3 shadow-sm">
        <div className="text-xs font-semibold text-foreground flex items-center justify-between border-b border-border/40 pb-2">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" />
            {t('本次物理耗时')}
          </span>
          <span className="flex items-center gap-1.5">
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
                      `fresh_track_${track.key}_${slice.key}`,
                      slice.label,
                      formatSeconds(slice.duration)
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

            {/* 精简统一图例：色彩点 指标名称 耗时s(百分比)，并按 阶段1 -> 阶段1细分 -> 阶段2 -> 阶段2细分 -> 阶段3 -> 阶段4 展现 */}
            <div className="w-full flex-1 space-y-1.5">
              {getSortedSlices(freshTracks).map(slice => {
                // 阶段 2 耗时显示为并行最大耗时 (p2Duration) 而非串行累加
                const displayDuration =
                  slice.key === 'contentExtraction' || slice.key === 'markitdownServerExtraction'
                    ? freshP2Max || slice.duration
                    : slice.key === 'hashAndTypeIdentification'
                    ? freshP1Max || slice.duration
                    : slice.duration

                return (
                  <div
                    key={`legend_fresh_${slice.key}`}
                    className={cn(
                      'flex items-center justify-between text-xs py-0.5 transition-all',
                      slice.isSubItem &&
                        (slice.stage === 'stage1'
                          ? 'pl-4 text-[11px] opacity-90 border-l border-indigo-500/30 ml-1'
                          : 'pl-4 text-[11px] opacity-90 border-l border-amber-500/30 ml-1')
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
                      {formatSeconds(displayDuration)} (
                      {freshPhasesSum > 0
                        ? ((displayDuration / freshPhasesSum) * 100).toFixed(1)
                        : '0.0'}
                      %)
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground italic text-center py-2">
            {t('本次分析阶段耗时已在并行线程中完成')}
          </div>
        )}
      </div>

      {/* 3. 区块二：【历史累计耗时 (全量归档)】 */}
      {archivePhaseEntries.length > 0 && (
        <div className="rounded-xl border border-border/40 bg-muted/20 p-3.5 space-y-3 shadow-sm">
          <div className="text-xs font-semibold text-foreground flex items-center justify-between border-b border-border/30 pb-2">
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-primary inline-block" />
              {t('历史累计耗时')}
            </span>
            <span className="flex items-center gap-1.5">
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
                      `arc_track_${track.key}_${slice.key}`,
                      slice.label,
                      formatSeconds(slice.duration)
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
                  if (slice.stage === 'stage1') {
                    const hasFreshStage1 =
                      fresh.phases &&
                      (fresh.phases['hashAndTypeIdentification'] !== undefined ||
                        fresh.phases['哈希与类型识别'] !== undefined)
                    const hasFreshKey =
                      freshStage1Breakdown &&
                      (freshStage1Breakdown as any)[slice.key] !== undefined &&
                      (freshStage1Breakdown as any)[slice.key] > 0
                    isReused = !hasFreshStage1 && !hasFreshKey
                  } else {
                    const hasFreshStage2 = CONTENT_EXTRACTION_KEYS.some(
                      k => fresh.phases && fresh.phases[k] !== undefined && fresh.phases[k] > 0
                    )
                    const hasFreshBreakdownKey =
                      freshBreakdown &&
                      (freshBreakdown as any)[slice.key] !== undefined &&
                      (freshBreakdown as any)[slice.key] > 0
                    isReused = !hasFreshStage2 && !hasFreshBreakdownKey
                  }
                } else if (
                  slice.key === 'hashAndTypeIdentification' ||
                  slice.key === '哈希与类型识别'
                ) {
                  const p1 =
                    fresh.phases?.hashAndTypeIdentification ?? fresh.phases?.['哈希与类型识别']
                  isReused = p1 === undefined || p1 <= 0
                } else if (CONTENT_EXTRACTION_KEYS.includes(slice.key)) {
                  const hasFreshStage2 = CONTENT_EXTRACTION_KEYS.some(
                    k => fresh.phases && fresh.phases[k] !== undefined && fresh.phases[k] > 0
                  )
                  isReused = !hasFreshStage2
                } else {
                  const val = fresh.phases?.[slice.key]
                  isReused = val === undefined || val <= 0
                }

                // 阶段 2 耗时显示为并行最大耗时 (p2Duration) 而非串行累加
                const displayDuration =
                  slice.key === 'contentExtraction' || slice.key === 'markitdownServerExtraction'
                    ? archiveP2Max || slice.duration
                    : slice.key === 'hashAndTypeIdentification'
                    ? archiveP1Max || slice.duration
                    : slice.duration

                return (
                  <div
                    key={`legend_archive_${slice.key}`}
                    className={cn(
                      'flex items-center justify-between text-xs py-0.5 transition-all',
                      slice.isSubItem &&
                        (slice.stage === 'stage1'
                          ? 'pl-4 text-[11px] opacity-90 border-l border-indigo-500/30 ml-1'
                          : 'pl-4 text-[11px] opacity-90 border-l border-amber-500/30 ml-1')
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
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className="font-mono text-foreground font-medium">
                        {formatSeconds(displayDuration)} (
                        {archivePhasesSum > 0
                          ? ((displayDuration / archivePhasesSum) * 100).toFixed(1)
                          : '0.0'}
                        %)
                      </span>
                      {isReused && (
                        <span className="text-[10px] px-1 py-0.2 bg-amber-500/10 text-amber-500 rounded border border-amber-500/20 font-medium">
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


    </div>
  )
}
