import React, { useMemo, useState } from 'react'
import { AnalysisStats, MarkitdownBenchmark, Stage1Benchmark } from '@firefly/types'
import { cn } from '../../../../lib/utils'
import i18nScope, { t } from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Layers,
  RotateCcw,
  Sparkles,
  Tag,
  FileText
} from 'lucide-react'
import {
  computeGroupedMetrics,
  buildCoaxialTracks,
  FilterConfig,
  MetricGroup,
  SubtaskItem
} from './analysis-time-utils'

interface AnalysisTimeTabProps {
  stats: {
    durationMs: number
    phases: Record<string, number>
    stage1Breakdown?: Stage1Benchmark
    contentExtractionBreakdown?: MarkitdownBenchmark
    model?: { name?: string }
    analysis_stage?: number
    performance?: {
      fresh?: any
      archive?: any
    }
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
 * 通用 SVG 弧线/多环切片渲染器
 */
function renderRingSlice(
  startAngle: number,
  endAngle: number,
  radius: number,
  strokeWidth: number,
  color: string,
  key: string,
  label?: string,
  durationText?: string
) {
  const sweep = Math.max(endAngle - startAngle, 0)
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

/**
 * 分析耗时 Tab：展示分析时间、各分析阶段耗时，支持通用子任务层级分组、显隐控制与同轴轨道呈现
 */
export const AnalysisTimeTab: React.FC<AnalysisTimeTabProps> = ({
  stats: rawStats,
  maskClass,
  lastAnalyzedAt,
  formatDate
}) => {
  const { t, activeLanguage } = useVoerkaI18n(i18nScope)
  const stats = rawStats as AnalysisStats

  // 1. 过滤与显隐状态管理
  const [filter, setFilter] = useState<FilterConfig>({
    hiddenGroupIds: new Set<string>(),
    hideSubItems: new Set<string>(),
    hiddenKeys: new Set<string>(),
    collapsedGroupIds: new Set<string>()
  })

  // 切换组的显隐 (整组隐藏/显示)
  const toggleGroupVisibility = (groupId: string) => {
    setFilter(prev => {
      const nextHidden = new Set(prev.hiddenGroupIds)
      if (nextHidden.has(groupId)) {
        nextHidden.delete(groupId)
      } else {
        nextHidden.add(groupId)
      }
      return { ...prev, hiddenGroupIds: nextHidden }
    })
  }

  // 切换组内子项的显隐 (仅看父级汇总 vs 展开子项)
  const toggleSubItemsVisibility = (groupId: string) => {
    setFilter(prev => {
      const nextHideSub = new Set(prev.hideSubItems)
      if (nextHideSub.has(groupId)) {
        nextHideSub.delete(groupId)
      } else {
        nextHideSub.add(groupId)
      }
      return { ...prev, hideSubItems: nextHideSub }
    })
  }

  // 切换单项指标显隐 (单项过滤)
  const toggleItemVisibility = (key: string) => {
    setFilter(prev => {
      const nextHiddenKeys = new Set(prev.hiddenKeys)
      if (nextHiddenKeys.has(key)) {
        nextHiddenKeys.delete(key)
      } else {
        nextHiddenKeys.add(key)
      }
      return { ...prev, hiddenKeys: nextHiddenKeys }
    })
  }

  // 切换组折叠状态
  const toggleGroupCollapse = (groupId: string) => {
    setFilter(prev => {
      const nextCollapsed = new Set(prev.collapsedGroupIds)
      if (nextCollapsed.has(groupId)) {
        nextCollapsed.delete(groupId)
      } else {
        nextCollapsed.add(groupId)
      }
      return { ...prev, collapsedGroupIds: nextCollapsed }
    })
  }

  // 重置所有过滤与折叠
  const resetFilters = () => {
    setFilter({
      hiddenGroupIds: new Set<string>(),
      hideSubItems: new Set<string>(),
      hiddenKeys: new Set<string>(),
      collapsedGroupIds: new Set<string>()
    })
  }

  const isFiltered =
    filter.hiddenGroupIds.size > 0 ||
    filter.hideSubItems.size > 0 ||
    filter.hiddenKeys.size > 0

  // 2. 提取 fresh 与 archive 数据
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

  // 3. 执行物理分组与动态开闭原则指标计算
  const freshMetrics = useMemo(
    () =>
      computeGroupedMetrics(
        freshStage1Breakdown,
        freshBreakdown,
        fresh.phases || {},
        filter,
        t
      ),
    [freshStage1Breakdown, freshBreakdown, fresh.phases, filter, activeLanguage]
  )

  const archiveMetrics = useMemo(
    () =>
      computeGroupedMetrics(
        archiveStage1Breakdown,
        archiveBreakdown,
        archive.phases || {},
        filter,
        t
      ),
    [archiveStage1Breakdown, archiveBreakdown, archive.phases, filter, activeLanguage]
  )

  // 挂钟物理耗时：发生过滤时实时联动为当前可见项的物理耗时，未过滤时展示完整挂钟耗时
  const freshTotalMs = isFiltered
    ? freshMetrics.visibleTotalMs
    : (fresh.durationMs || stats.durationMs || freshMetrics.visibleTotalMs)
  const archiveTotalMs = isFiltered
    ? archiveMetrics.visibleTotalMs
    : ((archive.durationMs && archive.durationMs >= archiveMetrics.visibleTotalMs)
        ? archive.durationMs
        : archiveMetrics.visibleTotalMs)

  // 计算无过滤状态下的原始可用分组与包含子项的分组列表
  const { availableGroupIds, groupsWithSubItems } = useMemo(() => {
    const emptyFilter: FilterConfig = {
      hiddenGroupIds: new Set(),
      hideSubItems: new Set(),
      hiddenKeys: new Set(),
      collapsedGroupIds: new Set()
    }
    const base = computeGroupedMetrics(
      freshStage1Breakdown || archiveStage1Breakdown,
      freshBreakdown || archiveBreakdown,
      fresh.phases || archive.phases || {},
      emptyFilter,
      t
    )
    return {
      availableGroupIds: new Set(base.groups.map(g => g.id)),
      groupsWithSubItems: base.groups.filter(g => g.items.some(i => i.isSubItem)).map(g => g.id)
    }
  }, [freshStage1Breakdown, archiveStage1Breakdown, freshBreakdown, archiveBreakdown, fresh.phases, archive.phases, activeLanguage])

  const hasTagGroup = availableGroupIds.has('tag_group')
  const hasQualityGroup = availableGroupIds.has('quality_group')
  const hasContentGroup = availableGroupIds.has('content')

  // 检查当前是否所有可用且包含子项的分组均已隐藏细项
  const areAllSubItemsHidden =
    groupsWithSubItems.length > 0 && groupsWithSubItems.every(id => filter.hideSubItems.has(id))

  const toggleAllSubItems = () => {
    setFilter(prev => {
      const nextHideSub = new Set(prev.hideSubItems)
      if (areAllSubItemsHidden) {
        // 全部展开各组细项
        groupsWithSubItems.forEach(id => nextHideSub.delete(id))
      } else {
        // 全部隐藏各组细项
        groupsWithSubItems.forEach(id => nextHideSub.add(id))
      }
      return { ...prev, hideSubItems: nextHideSub }
    })
  }

  // 4. 构建 SVG 同轴多轨道 (主轨道 + 子项外环)
  const freshTracks = useMemo(
    () => buildCoaxialTracks(freshMetrics, accelerator, t),
    [freshMetrics, accelerator, activeLanguage]
  )

  const archiveTracks = useMemo(
    () => buildCoaxialTracks(archiveMetrics, accelerator, t),
    [archiveMetrics, accelerator, activeLanguage]
  )

  // 渲染层级树状图例组件
  const renderTreeLegend = (
    metrics: typeof freshMetrics,
    isArchive: boolean
  ) => {
    return (
      <div className="w-full flex-1 space-y-2 text-left">
        {metrics.groups.map(group => {
          const isCollapsed = filter.collapsedGroupIds.has(group.id)
          const isSubHidden = filter.hideSubItems.has(group.id)
          const hasSubItems = group.items.some(i => i.isSubItem)

          return (
            <div
              key={`grp_${isArchive ? 'arc' : 'frs'}_${group.id}`}
              className="rounded-lg border border-border/30 bg-muted/10 p-2 space-y-1.5 transition-all text-left"
            >
              {/* 分组标题行 */}
              <div className="flex items-center justify-between gap-1 text-xs">
                <div className="flex items-center gap-1.5 min-w-0 text-left">
                  {hasSubItems ? (
                    <button
                      type="button"
                      onClick={() => toggleGroupCollapse(group.id)}
                      className="p-0.5 text-muted-foreground hover:text-foreground rounded transition-colors shrink-0"
                      title={isCollapsed ? t('展开子项') : t('折叠子项')}
                    >
                      {isCollapsed ? (
                        <ChevronRight className="w-3.5 h-3.5" />
                      ) : (
                        <ChevronDown className="w-3.5 h-3.5" />
                      )}
                    </button>
                  ) : (
                    <span className="w-3.5 h-3.5 inline-block shrink-0" />
                  )}

                  <span
                    className="w-2.5 h-2.5 rounded-sm shrink-0"
                    style={{ backgroundColor: group.color }}
                  />

                  <span className="font-semibold text-foreground truncate flex items-center gap-1.5">
                    {group.label}
                    {group.executionType === 'async' ? (
                      <span
                        className="text-[10px] text-amber-500 font-normal px-1 bg-amber-500/10 rounded border border-amber-500/20"
                        title={t('并发执行 (按最大耗时计)')}
                      >
                        ⚡ {t('并发')}
                      </span>
                    ) : (
                      <span
                        className="text-[10px] text-blue-500 font-normal px-1 bg-blue-500/10 rounded border border-blue-500/20"
                        title={t('串行执行 (按累加和计)')}
                      >
                        ⚙️ {t('串行')}
                      </span>
                    )}
                  </span>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  {/* 长尾瓶颈标记 */}
                  {group.isBottleneck && (
                    <span className="text-[10px] px-1 py-0.2 bg-rose-500/10 text-rose-500 rounded border border-rose-500/20 font-bold animate-pulse">
                      ⚡ {t('瓶颈')}
                    </span>
                  )}

                  {/* 耗时与占比 */}
                  <span className="font-mono text-foreground font-semibold">
                    {formatSeconds(group.duration)} (
                    {metrics.phasesSum > 0
                      ? ((group.duration / metrics.phasesSum) * 100).toFixed(1)
                      : '0.0'}
                    %)
                  </span>

                  {/* 组内子项开关 (仅看父级 vs 展开子项) */}
                  {hasSubItems && (
                    <button
                      type="button"
                      onClick={() => toggleSubItemsVisibility(group.id)}
                      className={cn(
                        'p-1 rounded text-xs transition-colors',
                        isSubHidden
                          ? 'text-muted-foreground/60 hover:text-foreground'
                          : 'text-primary hover:bg-primary/10'
                      )}
                      title={isSubHidden ? t('显示各子项') : t('隐藏各子项')}
                    >
                      <Layers className="w-3.5 h-3.5" />
                    </button>
                  )}

                  {/* 整组显隐眼睛按钮 */}
                  <button
                    type="button"
                    onClick={() => toggleGroupVisibility(group.id)}
                    className="p-1 text-muted-foreground hover:text-foreground rounded transition-colors"
                    title={t('隐藏此分组')}
                  >
                    <Eye className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* 展开的子项树状列表 */}
              {!isCollapsed && !isSubHidden && hasSubItems && (
                <div className="space-y-1 pl-4 pt-1 border-l border-border/40 ml-2">
                  {group.items.map(subItem => {
                    // 判断是否复用
                    let isReused = false
                    if (isArchive) {
                      const checkParent = subItem.parentKey
                      const hasFreshVal =
                        (freshStage1Breakdown as any)?.[subItem.key] !== undefined ||
                        (freshBreakdown as any)?.[subItem.key] !== undefined ||
                        (checkParent && (freshBreakdown as any)?.[checkParent] !== undefined) ||
                        (checkParent && (freshBreakdown as any)?.[checkParent.toLowerCase()] !== undefined) ||
                        (fresh.phases as any)?.[subItem.key] !== undefined
                      isReused = !hasFreshVal
                    }

                    return (
                      <div
                        key={`sub_${subItem.key}`}
                        className="group flex items-center justify-between text-[11px] py-0.5 hover:bg-muted/30 px-1 rounded transition-colors"
                      >
                        <div className="flex items-center gap-1.5 truncate">
                          <span
                            className="w-1.5 h-1.5 rounded-full shrink-0"
                            style={{ backgroundColor: subItem.color }}
                          />
                          <span className="text-muted-foreground truncate flex items-center gap-1">
                            <span className="opacity-40">└</span>
                            {subItem.label}
                            {subItem.executionType === 'sync' ? (
                              <span
                                className="text-[9px] text-blue-400 opacity-75"
                                title={t('串行子步骤')}
                              >
                                ⚙️
                              </span>
                            ) : (
                              <span
                                className="text-[9px] text-amber-400 opacity-75"
                                title={t('并发子任务')}
                              >
                                ⚡
                              </span>
                            )}
                          </span>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          {subItem.isBottleneck && (
                            <span className="text-[9px] px-1 bg-rose-500/10 text-rose-400 rounded">
                              {t('长尾')}
                            </span>
                          )}

                          <span className="font-mono text-muted-foreground font-medium">
                            {formatSeconds(subItem.duration)} (
                            {group.duration > 0
                              ? ((subItem.duration / group.duration) * 100).toFixed(1)
                              : '0.0'}
                            %)
                          </span>

                          {isReused && (
                            <span className="text-[9px] px-1 bg-amber-500/10 text-amber-500 rounded border border-amber-500/20">
                              {t('复用')}
                            </span>
                          )}

                          {/* 单项显隐控制按钮 (悬浮可见) */}
                          <button
                            type="button"
                            onClick={() => toggleItemVisibility(subItem.key)}
                            className="opacity-0 group-hover:opacity-100 p-0.5 text-muted-foreground hover:text-foreground rounded transition-opacity"
                            title={t('隐藏此项')}
                          >
                            <EyeOff className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}

        {/* 串行后续阶段 (阶段 3: 质量评分 与 阶段 4: 维度分析) 图例卡片对齐 */}
        {metrics.stage3Ms > 0 && (
          <div
            key={`stage3_${isArchive ? 'arc' : 'frs'}`}
            className="rounded-lg border border-border/30 bg-muted/10 p-2 space-y-1.5 transition-all text-left"
          >
            <div className="flex items-center justify-between gap-1 text-xs">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="w-3.5 h-3.5 inline-block shrink-0" />
                <span
                  className="w-2.5 h-2.5 rounded-sm shrink-0"
                  style={{ backgroundColor: '#f97316' }}
                />
                <span className="font-semibold text-foreground truncate flex items-center gap-1.5">
                  {t('阶段 3: 质量评分')}
                  <span
                    className="text-[10px] text-blue-500 font-normal px-1 bg-blue-500/10 rounded border border-blue-500/20"
                    title={t('串行执行 (按累加和计)')}
                  >
                    ⚙️ {t('串行')}
                  </span>
                </span>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <span className="font-mono text-foreground font-semibold">
                  {formatSeconds(metrics.stage3Ms)} (
                  {metrics.phasesSum > 0
                    ? ((metrics.stage3Ms / metrics.phasesSum) * 100).toFixed(1)
                    : '0.0'}
                  %)
                </span>
                {isArchive &&
                  (fresh.phases as any)?.qualityScoring === undefined &&
                  (fresh.phases as any)?.['质量分析'] === undefined && (
                    <span className="text-[9px] px-1 bg-amber-500/10 text-amber-500 rounded border border-amber-500/20">
                      {t('复用')}
                    </span>
                  )}
              </div>
            </div>
          </div>
        )}

        {metrics.stage4Ms > 0 && (
          <div
            key={`stage4_${isArchive ? 'arc' : 'frs'}`}
            className="rounded-lg border border-border/30 bg-muted/10 p-2 space-y-1.5 transition-all text-left"
          >
            <div className="flex items-center justify-between gap-1 text-xs">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="w-3.5 h-3.5 inline-block shrink-0" />
                <span
                  className="w-2.5 h-2.5 rounded-sm shrink-0"
                  style={{ backgroundColor: '#22c55e' }}
                />
                <span className="font-semibold text-foreground truncate flex items-center gap-1.5">
                  {t('阶段 4: 维度分析')}
                  <span
                    className="text-[10px] text-blue-500 font-normal px-1 bg-blue-500/10 rounded border border-blue-500/20"
                    title={t('串行执行 (按累加和计)')}
                  >
                    ⚙️ {t('串行')}
                  </span>
                </span>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <span className="font-mono text-foreground font-semibold">
                  {formatSeconds(metrics.stage4Ms)} (
                  {metrics.phasesSum > 0
                    ? ((metrics.stage4Ms / metrics.phasesSum) * 100).toFixed(1)
                    : '0.0'}
                  %)
                </span>
                {isArchive &&
                  (fresh.phases as any)?.dimensionAnalysis === undefined &&
                  (fresh.phases as any)?.['维度分析'] === undefined && (
                    <span className="text-[9px] px-1 bg-amber-500/10 text-amber-500 rounded border border-amber-500/20">
                      {t('复用')}
                    </span>
                  )}
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={'text-xs space-y-3.5 @container'}>
      {/* 1. 顶部分析时间/算力流徽章 与 AI 推理模型信息 */}
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

        {/* 第二行：AI 推理模型信息 */}
        {(fresh.model?.name || archive.model?.name || stats.model?.name) && (
          <div className="flex items-center justify-between gap-2 text-xs pt-1.5 border-t border-border/40">
            <span className="text-muted-foreground shrink-0">{t('推理模型')}</span>
            <span className="font-mono text-primary font-medium truncate text-right max-w-[240px]">
              {fresh.model?.name || archive.model?.name || stats.model?.name}
            </span>
          </div>
        )}
      </div>

      {/* 2. 快捷过滤控制胶囊栏 (Quick Filter Bar) */}
      <div className="flex flex-wrap items-center justify-between gap-1.5 p-2 rounded-lg bg-muted/30 border border-border/40 text-xs">
        <div className="flex flex-wrap items-center gap-1.5">
          {/* 标签生成组开关 */}
          <button
            type="button"
            disabled={!hasTagGroup}
            onClick={() => hasTagGroup && toggleGroupVisibility('tag_group')}
            className={cn(
              'flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] transition-all',
              !hasTagGroup
                ? 'opacity-40 cursor-not-allowed border-border/40 text-muted-foreground'
                : filter.hiddenGroupIds.has('tag_group')
                  ? 'bg-muted/40 border-border/40 text-muted-foreground line-through opacity-70'
                  : 'bg-sky-500/10 border-sky-500/30 text-sky-600 dark:text-sky-400 font-medium hover:bg-sky-500/20'
            )}
            title={!hasTagGroup ? t('当前文件未生成标签组数据') : t('切换标签组显隐')}
          >
            <Tag className="w-3 h-3" />
            <span>{t('标签组')}</span>
          </button>

          {/* 细项显示/隐藏开关 */}
          <button
            type="button"
            disabled={groupsWithSubItems.length === 0}
            onClick={toggleAllSubItems}
            className={cn(
              'flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] transition-all',
              groupsWithSubItems.length === 0
                ? 'opacity-40 cursor-not-allowed border-border/40 text-muted-foreground'
                : areAllSubItemsHidden
                  ? 'bg-muted/40 border-border/40 text-muted-foreground opacity-70'
                  : 'bg-indigo-500/10 border-indigo-500/30 text-indigo-600 dark:text-indigo-400 font-medium hover:bg-indigo-500/20'
            )}
            title={groupsWithSubItems.length === 0 ? t('当前各分组暂无细分子项') : (areAllSubItemsHidden ? t('展开显示各分组细分子项') : t('收起隐藏各分组细分子项'))}
          >
            <Layers className="w-3 h-3" />
            <span>{areAllSubItemsHidden ? t('展开细项') : t('收起细项')}</span>
          </button>

          {/* 画质形态组开关 */}
          <button
            type="button"
            disabled={!hasQualityGroup}
            onClick={() => hasQualityGroup && toggleGroupVisibility('quality_group')}
            className={cn(
              'flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] transition-all',
              !hasQualityGroup
                ? 'opacity-40 cursor-not-allowed border-border/40 text-muted-foreground'
                : filter.hiddenGroupIds.has('quality_group')
                  ? 'bg-muted/40 border-border/40 text-muted-foreground line-through opacity-70'
                  : 'bg-teal-500/10 border-teal-500/30 text-teal-600 dark:text-teal-400 font-medium hover:bg-teal-500/20'
            )}
            title={!hasQualityGroup ? t('当前文件无画质形态指标') : t('切换画质形态组显隐')}
          >
            <Sparkles className="w-3 h-3" />
            <span>{t('画质组')}</span>
          </button>

          {/* 基础内容组开关 */}
          <button
            type="button"
            disabled={!hasContentGroup}
            onClick={() => hasContentGroup && toggleGroupVisibility('content')}
            className={cn(
              'flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] transition-all',
              !hasContentGroup
                ? 'opacity-40 cursor-not-allowed border-border/40 text-muted-foreground'
                : filter.hiddenGroupIds.has('content')
                  ? 'bg-muted/40 border-border/40 text-muted-foreground line-through opacity-70'
                  : 'bg-amber-500/10 border-amber-500/30 text-amber-600 dark:text-amber-400 font-medium hover:bg-amber-500/20'
            )}
            title={!hasContentGroup ? t('当前文件无基础内容数据') : t('切换基础内容组显隐')}
          >
            <FileText className="w-3 h-3" />
            <span>{t('基础内容')}</span>
          </button>
        </div>

        {/* 重置过滤按钮 */}
        {isFiltered && (
          <button
            type="button"
            onClick={resetFilters}
            className="flex items-center gap-1 px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground rounded transition-colors ml-auto"
            title={t('重置所有显隐过滤')}
          >
            <RotateCcw className="w-3 h-3" />
            <span>{t('重置')}</span>
          </button>
        )}
      </div>

      {/* 3. 区块一：【本次分析物理耗时】 */}
      <div className="rounded-xl border border-border/60 bg-muted/40 dark:bg-card/90 p-3.5 space-y-3 shadow-sm text-left">
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

        {freshMetrics.groups.length > 0 ? (
          <div className="flex flex-col @sm:flex-row items-start @sm:items-center gap-4 pt-1 w-full text-left">
            {/* SVG 同轴多轨道圆饼图 */}
            <div className="flex flex-col items-center justify-center relative shrink-0 mx-auto @sm:mx-0">
              <svg viewBox="0 0 100 100" className="w-36 h-36 transform -rotate-90">
                {freshTracks.map(track =>
                  track.slices.map(slice =>
                    renderRingSlice(
                      slice.startAngle,
                      slice.endAngle,
                      track.radius,
                      track.strokeWidth,
                      slice.color,
                      `frs_trk_${track.key}_${slice.key}`,
                      slice.label,
                      formatSeconds(slice.duration)
                    )
                  )
                )}
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none text-center leading-tight">
                <span className="text-[10px] text-muted-foreground font-medium">{t('阶段')}</span>
                <span className="text-base font-extrabold font-mono text-foreground">
                  {stats.analysis_stage || (freshMetrics.groups.length > 2 ? 4 : 2)}
                </span>
              </div>
            </div>

            {/* 现代化层级折叠树状图例 */}
            {renderTreeLegend(freshMetrics, false)}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground italic text-center py-2">
            {t('暂无可见阶段指标（所有指标均被过滤隐藏）')}
          </div>
        )}
      </div>

      {/* 4. 区块二：【历史累计耗时 (全量归档)】 */}
      {archiveMetrics.groups.length > 0 && (
        <div className="rounded-xl border border-border/40 bg-muted/20 p-3.5 space-y-3 shadow-sm text-left">
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

          <div className="flex flex-col @sm:flex-row items-start @sm:items-center gap-4 pt-1 w-full text-left">
            {/* 归档 SVG 多轨道圆饼图 */}
            <div className="flex flex-col items-center justify-center relative shrink-0 mx-auto @sm:mx-0">
              <svg viewBox="0 0 100 100" className="w-36 h-36 transform -rotate-90">
                {archiveTracks.map(track =>
                  track.slices.map(slice =>
                    renderRingSlice(
                      slice.startAngle,
                      slice.endAngle,
                      track.radius,
                      track.strokeWidth,
                      slice.color,
                      `arc_trk_${track.key}_${slice.key}`,
                      slice.label,
                      formatSeconds(slice.duration)
                    )
                  )
                )}
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none text-center leading-tight">
                <span className="text-[10px] text-muted-foreground font-medium">{t('阶段')}</span>
                <span className="text-base font-extrabold font-mono text-foreground">
                  {stats.analysis_stage || (archiveMetrics.groups.length > 2 ? 4 : 2)}
                </span>
              </div>
            </div>

            {/* 现代化层级折叠树状归档图例 */}
            {renderTreeLegend(archiveMetrics, true)}
          </div>
        </div>
      )}
    </div>
  )
}
