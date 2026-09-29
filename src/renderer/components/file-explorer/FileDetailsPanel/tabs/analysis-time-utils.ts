/**
 * 分析耗时指标通用分组、过滤、显隐控制与同轴轨道计算引擎
 *
 * 核心设计原则：
 * 1. 开闭原则 (OCP)：支持已知子任务及未来动态新增指标自动归组；
 * 2. 物理拓扑真实性：严格区分同步 (⚙️ 串行 Sum) 与异步 (⚡ 并发 Max)；
 * 3. 极速自愈联动：整组隐藏、子项隐藏、单项过滤后，阶段耗时与饼图比例自动重新按物理模型求值。
 */

import { MarkitdownBenchmark, Stage1Benchmark, getSubtaskMs } from '@firefly/types'

/** 子任务执行流拓扑类型 */
export type SubtaskExecutionType = 'sync' | 'async'

/** 子任务/指标条目 */
export interface SubtaskItem {
  key: string
  label: string
  duration: number
  color: string
  groupId: 'stage1' | 'content' | 'tag_group' | 'quality_group' | 'other'
  parentKey?: string
  isSubItem: boolean
  executionType: SubtaskExecutionType
  isBottleneck?: boolean
  weight: number
}

/** 分组结构 */
export interface MetricGroup {
  id: 'stage1' | 'content' | 'tag_group' | 'quality_group' | 'other'
  label: string
  color: string
  executionType: SubtaskExecutionType
  duration: number
  isBottleneck?: boolean
  items: SubtaskItem[]
}

/** 显隐与过滤配置 */
export interface FilterConfig {
  /** 隐藏的整组 ID (例如 'tag_group' | 'quality_group' | 'content') */
  hiddenGroupIds: Set<string>
  /** 隐藏组内子项的组 ID (仅保留父级汇总，隐藏细分条目与外环同轴弧) */
  hideSubItems: Set<string>
  /** 隐藏的具体单项 key (例如 'clipMutualMs' 或 'ocrMs') */
  hiddenKeys: Set<string>
  /** UI 折叠的组 ID */
  collapsedGroupIds: Set<string>
}

/** SVG 同轴切片定义 */
export interface CoaxialSlice {
  key: string
  label: string
  duration: number
  startAngle: number
  endAngle: number
  color: string
  parentKey?: string
}

/** SVG 同轴轨道定义 */
export interface CoaxialTrack {
  key: string
  label: string
  duration: number
  pct: number
  radius: number
  strokeWidth: number
  slices: CoaxialSlice[]
}

/** 动态增项的循环调色盘 (优雅高对比度配色) */
const DYNAMIC_PALETTE = [
  '#06b6d4', // 青蓝
  '#8b5cf6', // 炫紫
  '#f43f5e', // 蔷薇红
  '#10b981', // 翡翠绿
  '#f59e0b', // 琥珀黄
  '#3b82f6', // 皇家蓝
  '#14b8a6', // 绿松石
  '#ec4899', // 玫红
  '#a855f7'  // 蓝紫
]

/**
 * 将 snake_case 或 camelCase 转换为友好展示字符串
 */
function formatKeyToLabel(key: string): string {
  // 移除常见前缀后缀
  let clean = key.replace(/Ms$/, '').replace(/_ms$/, '')
  // 将 camelCase 转换为带空格格式
  clean = clean.replace(/([A-Z])/g, ' $1')
  // 将下划线替换为空格并首字母大写
  clean = clean.replace(/_/g, ' ').trim()
  return clean.charAt(0).toUpperCase() + clean.slice(1)
}

/** 已在阶段 2 各分组中静态消费的保留键 (不再进入动态归组扫描) */
const RESERVED_STAGE2_KEYS: ReadonlySet<string> = new Set([
  'totalMs',
  'officePrePdfMs',
  'tagMs',
  'magikaMs',
  'textMs',
  'ocrMs',
  'metadataMs',
  'thumbnailMs',
  'clipMs',
  'clipEmbedMs',
  'clipMutualMs',
  'ramMs',
  'nsfwMs',
  'aestheticMs',
  'watermarkMs',
  'mosaicMs',
  'textDetectMs',
  'bwMs',
  // 兼容旧字段，避免落入扩展算子组以机器格式展示
  'htmlMs',
  'documentMs'
])

/** 标签生成组的动态归类关键词 (唯一事实源，tag/other 扫描共用) */
const TAG_GROUP_KEYWORDS = ['clip', 'ram', 'nsfw', 'tag'] as const

/** 画质与形态组的动态归类关键词 (唯一事实源，quality/other 扫描共用) */
const QUALITY_GROUP_KEYWORDS = ['watermark', 'mosaic', 'aesthetic', 'quality', 'detect', 'blur', 'bw'] as const

/**
 * 动态子任务键路由 (开闭原则唯一归类入口):
 * 按关键词将未知算子键路由到标签生成组 / 画质与形态组 / 扩展算子组。
 * 新增分类关键词只需修改对应关键词表，无需改动任何扫描调用方。
 */
function classifySubtaskKey(rawKey: string): 'tag_group' | 'quality_group' | 'other' {
  const lowerKey = rawKey.toLowerCase()
  if (TAG_GROUP_KEYWORDS.some(kw => lowerKey.includes(kw))) return 'tag_group'
  if (QUALITY_GROUP_KEYWORDS.some(kw => lowerKey.includes(kw))) return 'quality_group'
  return 'other'
}

/**
 * 计算阶段 1、阶段 2 及各子组的分组过滤与耗时
 */
export function computeGroupedMetrics(
  stage1Breakdown: Stage1Benchmark | undefined,
  contentBreakdown: MarkitdownBenchmark | undefined,
  phases: Record<string, number>,
  filter: FilterConfig,
  t: (k: string) => string
): {
  groups: MetricGroup[]
  stage1TotalMs: number
  stage2TotalMs: number
  stage3Ms: number
  stage4Ms: number
  visibleTotalMs: number
  allVisibleItems: SubtaskItem[]
  phasesSum: number
} {
  const groups: MetricGroup[] = []

  // ----------------------------------------------------
  // 1. 阶段 1: 文件指纹与复用判定 (⚙️ 严格串行 Sum)
  // ----------------------------------------------------
  let stage1TotalMs = 0
  if (!filter.hiddenGroupIds.has('stage1')) {
    const rawP1Items: SubtaskItem[] = [
      {
        key: 'fingerprintMs',
        label: t('文件指纹'),
        duration: Number(stage1Breakdown?.fingerprintMs) || 0,
        color: '#818cf8',
        groupId: 'stage1',
        isSubItem: true,
        executionType: 'sync',
        weight: 11
      },
      {
        key: 'localReuseMs',
        label: t('本地复用'),
        duration: Number(stage1Breakdown?.localReuseMs) || 0,
        color: '#38bdf8',
        groupId: 'stage1',
        isSubItem: true,
        executionType: 'sync',
        weight: 12
      },
      {
        key: 'cloudReuseMs',
        label: t('云端复用'),
        duration: Number(stage1Breakdown?.cloudReuseMs) || 0,
        color: '#06b6d4',
        groupId: 'stage1',
        isSubItem: true,
        executionType: 'sync',
        weight: 13
      }
    ]

    const validP1Items = rawP1Items.filter(
      item => item.duration > 0 && !filter.hiddenKeys.has(item.key)
    )

    stage1TotalMs = validP1Items.reduce((acc, it) => acc + it.duration, 0)
    // 兼容旧数据中只有 phases 耗时
    if (stage1TotalMs === 0 && !filter.hiddenKeys.has('hashAndTypeIdentification')) {
      stage1TotalMs = Number(phases['hashAndTypeIdentification'] || phases['哈希与类型识别'] || 0)
    }

    if (stage1TotalMs > 0 || validP1Items.length > 0) {
      groups.push({
        id: 'stage1',
        label: t('阶段 1: 文件指纹与复用判定'),
        color: '#6366f1',
        executionType: 'sync',
        duration: stage1TotalMs,
        items: validP1Items
      })
    }
  }

  // ----------------------------------------------------
  // 2. 阶段 2: 细分子任务解析与动态归组
  // ----------------------------------------------------
  if (contentBreakdown) {
    // 2.1 基础内容组 (content)
    if (!filter.hiddenGroupIds.has('content')) {
      // Office 预转 PDF 作为串行前缀已独立成项，封面图渲染仅统计自身耗时
      const rawContentItems: SubtaskItem[] = [
        {
          // Magika 类型识别在分支分发前串行执行，标注 sync
          key: 'magikaMs',
          label: t('类型识别'),
          duration: Number(contentBreakdown.magikaMs) || 0,
          color: '#10b981',
          groupId: 'content',
          isSubItem: false,
          executionType: 'sync',
          weight: 21
        },
        {
          key: 'officePrePdfMs',
          label: t('Office预转PDF'),
          duration: Number(contentBreakdown.officePrePdfMs) || 0,
          color: '#d97706',
          groupId: 'content',
          isSubItem: false,
          executionType: 'sync',
          weight: 24
        },
        {
          key: 'textMs',
          label: t('文本提取'),
          duration: Number(contentBreakdown.textMs) || 0,
          color: '#a855f7',
          groupId: 'content',
          isSubItem: false,
          executionType: 'async',
          weight: 22
        },
        {
          key: 'ocrMs',
          label: t('OCR识别'),
          duration: Number(contentBreakdown.ocrMs) || 0,
          color: '#e11d48',
          groupId: 'content',
          isSubItem: false,
          executionType: 'async',
          weight: 23
        },
        {
          key: 'metadataMs',
          label: t('元数据提取'),
          duration: Number(contentBreakdown.metadataMs) || 0,
          color: '#ec4899',
          groupId: 'content',
          isSubItem: false,
          executionType: 'async',
          weight: 24
        },
        {
          key: 'thumbnailMs',
          label: t('封面图渲染'),
          duration: Number(contentBreakdown.thumbnailMs) || 0,
          color: '#f59e0b',
          groupId: 'content',
          isSubItem: false,
          executionType: 'async',
          weight: 25
        }
      ]

      const validContentItems = rawContentItems.filter(
        item => item.duration > 0 && !filter.hiddenKeys.has(item.key)
      )

      if (validContentItems.length > 0) {
        const contentMax = Math.max(...validContentItems.map(it => it.duration), 0)
        groups.push({
          id: 'content',
          label: t('基础内容组'),
          color: '#f59e0b',
          executionType: 'async',
          duration: contentMax,
          items: validContentItems
        })
      }
    }

    // 2.2 标签生成组 (tag_group)
    if (!filter.hiddenGroupIds.has('tag_group')) {
      const isSubItemsHidden = filter.hideSubItems.has('tag_group')
      const tagSubItems: SubtaskItem[] = []

      // 已知静态标签生成子项
      const knownTagKeys = [
        { key: 'clipMs', label: t('CLIP视觉打标'), color: '#60a5fa', type: 'async' as const, weight: 31 },
        { key: 'clipEmbedMs', label: t('CLIP图像嵌入'), color: '#818cf8', type: 'sync' as const, weight: 32 },
        { key: 'clipMutualMs', label: t('CLIP互斥分类'), color: '#93c5fd', type: 'sync' as const, weight: 33 },
        { key: 'ramMs', label: t('RAM++实体打标'), color: '#2dd4bf', type: 'async' as const, weight: 34 },
        { key: 'nsfwMs', label: t('NSFW敏感鉴定'), color: '#f43f5e', type: 'async' as const, weight: 35 }
      ]

      for (const k of knownTagKeys) {
        const dur = getSubtaskMs(contentBreakdown, k.key)
        if (dur > 0 && !filter.hiddenKeys.has(k.key)) {
          tagSubItems.push({
            key: k.key,
            label: k.label,
            duration: dur,
            color: k.color,
            groupId: 'tag_group',
            parentKey: 'tagMs',
            isSubItem: true,
            executionType: k.type,
            weight: k.weight
          })
        }
      }

      // 动态增项扫描: 经 classifySubtaskKey 路由进标签生成组
      let dynPaletteIdx = 0
      for (const [rawKey, val] of Object.entries(contentBreakdown)) {
        if (!val || typeof val !== 'number' || val <= 0) continue
        if (RESERVED_STAGE2_KEYS.has(rawKey)) continue
        if (knownTagKeys.some(k => k.key === rawKey)) continue
        if (classifySubtaskKey(rawKey) !== 'tag_group') continue

        if (!filter.hiddenKeys.has(rawKey)) {
          const lowerKey = rawKey.toLowerCase()
          const isSync =
            lowerKey.includes('embed') || lowerKey.includes('mutual') || lowerKey.includes('sync')
          tagSubItems.push({
            key: rawKey,
            label: formatKeyToLabel(rawKey),
            duration: val,
            color: DYNAMIC_PALETTE[dynPaletteIdx++ % DYNAMIC_PALETTE.length],
            groupId: 'tag_group',
            parentKey: 'tagMs',
            isSubItem: true,
            executionType: isSync ? 'sync' : 'async',
            weight: 36 + dynPaletteIdx
          })
        }
      }

      // 父级 tagMs 耗时：如果原数据有 tagMs 优先，且保证 >= 关键串行路径及并发最大值
      // 物理流水线特性: clipEmbedMs (串行) -> clipMutualMs (串行)，二者为局部串行链路，需累加
      const rawTagMs = Number(contentBreakdown.tagMs) || 0
      const embedMs = getSubtaskMs(contentBreakdown, 'clipEmbedMs') || 0
      const mutualMs = getSubtaskMs(contentBreakdown, 'clipMutualMs') || 0
      const clipChainMs = embedMs + mutualMs
      const otherSubItemsMax = tagSubItems
        .filter(it => it.key !== 'clipEmbedMs' && it.key !== 'clipMutualMs')
        .reduce((max, it) => Math.max(max, it.duration), 0)
      const effectiveTagDuration = Math.max(rawTagMs, clipChainMs, otherSubItemsMax)

      if (effectiveTagDuration > 0 && !filter.hiddenKeys.has('tagMs')) {
        let finalTagItems: SubtaskItem[] = []
        if (isSubItemsHidden) {
          // 仅保留父级汇总
          finalTagItems = [
            {
              key: 'tagMs',
              label: t('标签生成总计'),
              duration: effectiveTagDuration,
              color: '#38bdf8',
              groupId: 'tag_group',
              isSubItem: false,
              executionType: 'async',
              weight: 30
            }
          ]
        } else {
          // 展开子项并按耗时给最大子项标注瓶颈
          tagSubItems.sort((a, b) => a.weight - b.weight)
          if (tagSubItems.length > 0) {
            const maxSubDur = Math.max(...tagSubItems.map(it => it.duration))
            tagSubItems.forEach(it => {
              if (it.duration === maxSubDur) {
                it.isBottleneck = true
              }
            })
          }
          finalTagItems = tagSubItems
        }

        groups.push({
          id: 'tag_group',
          label: t('标签生成组'),
          color: '#38bdf8',
          executionType: 'async',
          duration: effectiveTagDuration,
          items: finalTagItems
        })
      }
    }

    // 2.3 画质与形态组 (quality_group)
    if (!filter.hiddenGroupIds.has('quality_group')) {
      const isSubItemsHidden = filter.hideSubItems.has('quality_group')
      const qualitySubItems: SubtaskItem[] = []

      const knownQualityKeys = [
        { key: 'aestheticMs', label: t('美学画质评分'), color: '#06b6d4', weight: 41 },
        { key: 'watermarkMs', label: t('频域水印检测'), color: '#0ea5e9', weight: 42 },
        { key: 'mosaicMs', label: t('打码检测'), color: '#6366f1', weight: 43 },
        { key: 'textDetectMs', label: t('文本探活'), color: '#8b5cf6', weight: 44 },
        { key: 'bwMs', label: t('黑白全彩判定'), color: '#64748b', weight: 45 }
      ]

      for (const k of knownQualityKeys) {
        const dur = getSubtaskMs(contentBreakdown, k.key)
        if (dur > 0 && !filter.hiddenKeys.has(k.key)) {
          qualitySubItems.push({
            key: k.key,
            label: k.label,
            duration: dur,
            color: k.color,
            groupId: 'quality_group',
            parentKey: 'quality_group',
            isSubItem: true,
            executionType: 'async',
            weight: k.weight
          })
        }
      }

      // 动态增项扫描: 经 classifySubtaskKey 路由进画质与形态组
      let qPaletteIdx = 3
      for (const [rawKey, val] of Object.entries(contentBreakdown)) {
        if (!val || typeof val !== 'number' || val <= 0) continue
        if (RESERVED_STAGE2_KEYS.has(rawKey)) continue
        if (knownQualityKeys.some(k => k.key === rawKey)) continue
        if (classifySubtaskKey(rawKey) !== 'quality_group') continue

        if (!filter.hiddenKeys.has(rawKey)) {
          qualitySubItems.push({
            key: rawKey,
            label: formatKeyToLabel(rawKey),
            duration: val,
            color: DYNAMIC_PALETTE[qPaletteIdx++ % DYNAMIC_PALETTE.length],
            groupId: 'quality_group',
            parentKey: 'quality_group',
            isSubItem: true,
            executionType: 'async',
            weight: 46 + qPaletteIdx
          })
        }
      }

      if (qualitySubItems.length > 0) {
        const qualityMax = Math.max(...qualitySubItems.map(it => it.duration), 0)
        let finalQualityItems: SubtaskItem[] = []
        if (isSubItemsHidden) {
          finalQualityItems = [
            {
              key: 'quality_group_total',
              label: t('画质与形态组'),
              duration: qualityMax,
              color: '#14b8a6',
              groupId: 'quality_group',
              isSubItem: false,
              executionType: 'async',
              weight: 40
            }
          ]
        } else {
          qualitySubItems.sort((a, b) => a.weight - b.weight)
          finalQualityItems = qualitySubItems
        }

        groups.push({
          id: 'quality_group',
          label: t('画质与形态组'),
          color: '#14b8a6',
          executionType: 'async',
          duration: qualityMax,
          items: finalQualityItems
        })
      }
    }

    // 2.4 其他未匹配扩展项 (开闭原则 other 组)
    if (!filter.hiddenGroupIds.has('other')) {
      const otherSubItems: SubtaskItem[] = []

      let oPaletteIdx = 5
      for (const [rawKey, val] of Object.entries(contentBreakdown)) {
        if (!val || typeof val !== 'number' || val <= 0) continue
        if (RESERVED_STAGE2_KEYS.has(rawKey)) continue
        if (classifySubtaskKey(rawKey) !== 'other') continue

        if (!filter.hiddenKeys.has(rawKey)) {
          otherSubItems.push({
            key: rawKey,
            label: formatKeyToLabel(rawKey),
            duration: val,
            color: DYNAMIC_PALETTE[oPaletteIdx++ % DYNAMIC_PALETTE.length],
            groupId: 'other',
            isSubItem: true,
            executionType: 'async',
            weight: 60 + oPaletteIdx
          })
        }
      }

      if (otherSubItems.length > 0) {
        const otherMax = Math.max(...otherSubItems.map(it => it.duration), 0)
        groups.push({
          id: 'other',
          label: t('扩展算子组'),
          color: '#8b5cf6',
          executionType: 'async',
          duration: otherMax,
          items: otherSubItems
        })
      }
    }
  }

  // ----------------------------------------------------
  // 3. 阶段 2 并发长尾瓶颈计算
  // ----------------------------------------------------
  // 阶段 2 所有可见并发分支 (content, tag_group, quality_group, other)
  const stage2Groups = groups.filter(g => g.id !== 'stage1')
  let stage2TotalMs = 0
  if (stage2Groups.length > 0) {
    stage2TotalMs = Math.max(...stage2Groups.map(g => g.duration), 0)
    // 找出耗时最长的大项，标记为瓶颈 (Bottleneck)
    stage2Groups.forEach(g => {
      if (g.duration === stage2TotalMs && stage2TotalMs > 0) {
        g.isBottleneck = true
        // 若为单项展示（如 content 组内各项），找到耗时最高的一项标记
        if (g.id === 'content') {
          g.items.forEach(it => {
            if (it.duration === stage2TotalMs) {
              it.isBottleneck = true
            }
          })
        }
      }
    })
  }

  // 4. 阶段 3 与阶段 4 耗时 (串行阶段，独立于饼图并发分组，但计入总挂钟)
  const stage3Ms = Number(phases['qualityScoring'] || phases['质量分析'] || 0)
  const stage4Ms = Number(phases['dimensionAnalysis'] || phases['维度分析'] || 0)

  const phasesSum = stage1TotalMs + stage2TotalMs + stage3Ms + stage4Ms
  const visibleTotalMs = phasesSum

  // 汇聚所有扁平化可见条目
  const allVisibleItems: SubtaskItem[] = []
  groups.forEach(g => {
    allVisibleItems.push(...g.items)
  })

  return {
    groups,
    stage1TotalMs,
    stage2TotalMs,
    stage3Ms,
    stage4Ms,
    visibleTotalMs,
    allVisibleItems,
    phasesSum
  }
}

/**
 * 构建 SVG 同轴多轨道 (主轨道 + 子项同轴弧)
 */
export function buildCoaxialTracks(
  metricsResult: ReturnType<typeof computeGroupedMetrics>,
  currentAccelerator: string,
  t: (k: string) => string
): CoaxialTrack[] {
  const tracksList: CoaxialTrack[] = []
  const { groups, stage1TotalMs, stage2TotalMs, stage3Ms, stage4Ms, visibleTotalMs } = metricsResult
  const totalMs = Math.max(visibleTotalMs, 1)

  // 主轨道切片
  const mainSlices: CoaxialSlice[] = []
  let accAngle = 0

  // 1. 阶段 1 切片 (主内环)
  const stage1Group = groups.find(g => g.id === 'stage1')
  let stage1StartAngle = 0
  let stage1SpanAngle = 0
  if (stage1Group && stage1TotalMs > 0) {
    stage1StartAngle = accAngle
    stage1SpanAngle = (stage1TotalMs / totalMs) * 360
    mainSlices.push({
      key: 'stage1_main',
      label: stage1Group.label,
      duration: stage1TotalMs,
      startAngle: stage1StartAngle,
      endAngle: stage1StartAngle + stage1SpanAngle,
      color: stage1Group.color
    })
    accAngle += stage1SpanAngle
  }

  // 2. 阶段 2 各并发组/分支切片 (主内环)
  // 各并发分支在主环上的总分配角度等于 (stage2TotalMs / totalMs) * 360
  const stage2Groups = groups.filter(g => g.id !== 'stage1')
  const stage2TotalAngleSpan = (stage2TotalMs / totalMs) * 360

  // 记录每个组的起始角和跨度角，供同轴外环精准对齐
  const groupAngleMap = new Map<string, { startAngle: number; spanAngle: number; groupDuration: number }>()

  if (stage2Groups.length > 0 && stage2TotalAngleSpan > 0) {
    // 阶段 2 内部各分支根据其物理耗时比例在 stage2TotalAngleSpan 内部划分
    const groupSum = stage2Groups.reduce((acc, g) => acc + g.duration, 0)
    const effectiveGroupSum = groupSum > 0 ? groupSum : 1

    stage2Groups.forEach(g => {
      const gSpan = (g.duration / effectiveGroupSum) * stage2TotalAngleSpan
      const gStart = accAngle
      const gEnd = gStart + gSpan
      accAngle = gEnd

      groupAngleMap.set(g.id, {
        startAngle: gStart,
        spanAngle: gSpan,
        groupDuration: g.duration
      })

      mainSlices.push({
        key: `stage2_${g.id}_main`,
        label: g.label,
        duration: g.duration,
        startAngle: gStart,
        endAngle: gEnd,
        color: g.color
      })
    })
  }

  // 3. 阶段 3 / 阶段 4 串行切片 (主内环): 补齐后内环各切片占比相加精确等于 100%
  const serialTailPhases: Array<{ key: string; label: string; duration: number; color: string }> = [
    { key: 'stage3_main', label: t('阶段 3: 质量评分'), duration: stage3Ms, color: '#f97316' },
    { key: 'stage4_main', label: t('阶段 4: 维度分析'), duration: stage4Ms, color: '#22c55e' }
  ]
  serialTailPhases.forEach(p => {
    if (p.duration > 0) {
      const span = (p.duration / totalMs) * 360
      mainSlices.push({
        key: p.key,
        label: p.label,
        duration: p.duration,
        startAngle: accAngle,
        endAngle: accAngle + span,
        color: p.color
      })
      accAngle += span
    }
  })

  // 添加内环主轨道 (Radius 18, StrokeWidth 6)
  if (mainSlices.length > 0) {
    tracksList.push({
      key: 'main_inner_track',
      label: t('阶段物理主轨道'),
      duration: totalMs,
      pct: 100,
      radius: 18,
      strokeWidth: 6,
      slices: mainSlices
    })
  }

  // 3. 构建外层同轴子轨道 (对齐父级起始角度，直观显示各子项耗时占比)
  // 半径封顶保护: 极端多子任务时轨道可能突破 viewBox (50) 被裁切，
  // 超出上限后不再绘制外环，降级为仅图例展示
  const MAX_SUBTRACK_RADIUS = 44
  let currentRadius = 28
  stage2Groups.forEach(g => {
    const angleInfo = groupAngleMap.get(g.id)
    if (!angleInfo || g.items.length <= 1) return

    // 仅当包含子项时绘制外环同轴弧
    const hasRealSubItems = g.items.some(i => i.isSubItem)
    if (!hasRealSubItems) return

    const { startAngle, spanAngle, groupDuration } = angleInfo
    const effectiveGroupDuration = groupDuration > 0 ? groupDuration : 1

    // 仅对有实际弧长的可见子项绘制外环
    const visibleSubItems = g.items.filter(it => it.duration > 0)

    // 最小可见弧长按父组剩余空间均摊钳制: 当父组扇区极窄时, 防止多个 2° 硬下限
    // 累加溢出父组扇区边界, 与相邻组的外环弧发生视觉重叠
    const minVisibleSpan = Math.min(2, spanAngle / Math.max(visibleSubItems.length, 1))

    visibleSubItems.forEach(subItem => {
      // 半径超出 viewBox 上限则停止绘制外环，防止轨道被裁切
      if (currentRadius > MAX_SUBTRACK_RADIUS) return

      const subRatio = Math.min(Math.max(subItem.duration / effectiveGroupDuration, 0), 1)
      // 跨度 = (子项耗时 / 父组耗时) * 父组弧长跨度, 并钳制在父组扇区内
      const subSpan = Math.max(subRatio * spanAngle, minVisibleSpan)

      tracksList.push({
        key: `sub_${g.id}_${subItem.key}`,
        label: subItem.label,
        duration: subItem.duration,
        pct: (subItem.duration / totalMs) * 100,
        radius: currentRadius,
        strokeWidth: 3.5,
        slices: [
          {
            key: subItem.key,
            label: subItem.label,
            duration: subItem.duration,
            startAngle: startAngle,
            endAngle: startAngle + subSpan,
            color: subItem.color,
            parentKey: g.id
          }
        ]
      })
      currentRadius += 4.5
    })
  })

  return tracksList
}
