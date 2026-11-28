import React from 'react'
import { DuplicateGroup } from '@firefly/types'
import { t } from '@app/languages'
import { MaterialIcon, cn } from '../../../../../lib/utils'
import { Button } from '../../../../ui/button'
import { Badge } from '../../../../ui/badge'
import { Checkbox } from '../../../../ui/checkbox'
import { Switch } from '../../../../ui/switch'
import { DuplicateStatistics, StrategyCategory, StrategyDefinition } from './types'

interface DuplicateSidebarPaneProps {
  isScanning: boolean
  scannedCount: number
  statistics: DuplicateStatistics
  minSimilarity: number
  onMinSimilarityChange: (val: number) => void
  onTriggerScan: (overrideSimilarity?: number) => void
  activeStrategyFilter: string
  onSelectStrategyFilter: (filter: string) => void
  duplicateGroups: DuplicateGroup[]
  strategyCategories: StrategyCategory[]
  strategyDefinitions: StrategyDefinition[]
  collapsedCategories: Record<string, boolean>
  onToggleCategoryCollapse: (catKey: string) => void
  enabledStrategies: string[]
  onToggleStrategy: (stratKey: string) => void
}

/**
 * 批量查重与瘦身左栏：清理分析统计、相似度阈值调节与策略筛选面板
 */
export const DuplicateSidebarPane: React.FC<DuplicateSidebarPaneProps> = ({
  isScanning,
  scannedCount,
  statistics,
  minSimilarity,
  onMinSimilarityChange,
  onTriggerScan,
  activeStrategyFilter,
  onSelectStrategyFilter,
  duplicateGroups,
  strategyCategories,
  strategyDefinitions,
  collapsedCategories,
  onToggleCategoryCollapse,
  enabledStrategies,
  onToggleStrategy
}) => {
  return (
    <div className="h-full flex flex-col bg-card/60 backdrop-blur-xs border-r border-border/60 overflow-hidden">
      <div className="p-4 border-b border-border/50 space-y-3.5 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
              <MaterialIcon icon="cleaning_services" className="text-base" />
            </div>
            <div>
              <div className="text-xs font-bold text-foreground">{t('清理分析统计')}</div>
              <div className="text-[10px] text-muted-foreground">{t('智能查重与冗余分析')}</div>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onTriggerScan()}
            disabled={isScanning}
            className="h-7 text-xs gap-1 rounded-lg border-primary/30 text-primary hover:bg-primary/10 transition-all active:scale-95 shadow-2xs"
          >
            <MaterialIcon icon="refresh" className={cn('text-sm', isScanning && 'animate-spin')} />
            <span>{isScanning ? t('扫描中...') : t('重新扫描')}</span>
          </Button>
        </div>

        {/* 空间与文件统计看板 */}
        <div className="grid grid-cols-3 gap-2">
          <div className="p-2.5 rounded-xl border border-border/50 bg-background/80 flex flex-col justify-between shadow-2xs">
            <div className="text-[10px] text-muted-foreground font-medium">{t('已扫描文件')}</div>
            <div className="text-base font-extrabold text-foreground tabular-nums tracking-tight mt-1">
              {scannedCount}
            </div>
          </div>
          <div className="p-2.5 rounded-xl border border-border/50 bg-background/80 flex flex-col justify-between shadow-2xs">
            <div className="text-[10px] text-muted-foreground font-medium">{t('冗余组数')}</div>
            <div className="text-base font-extrabold text-foreground tabular-nums tracking-tight mt-1">
              {statistics.totalGroups}
            </div>
          </div>
          <div className="p-2.5 rounded-xl border border-emerald-500/20 bg-emerald-500/5 dark:bg-emerald-950/20 flex flex-col justify-between shadow-2xs">
            <div className="text-[10px] text-emerald-600 dark:text-emerald-400 font-medium">
              {t('可释放空间')}
            </div>
            <div
              className="text-base font-extrabold text-emerald-600 dark:text-emerald-400 tabular-nums tracking-tight mt-1 truncate"
              title={statistics.freedBytes}
            >
              {statistics.freedBytes}
            </div>
          </div>
        </div>

        {/* 最小相似度阈值滑块与预设 (0.0 ~ 10.0 动态平滑映射) */}
        <div className="pt-3 border-t border-border/40 space-y-2.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground font-medium flex items-center gap-1">
              <MaterialIcon icon="tune" className="text-xs text-primary" />
              {t('相似度匹配阈值')}
            </span>
            <span className="font-bold text-primary font-mono text-xs px-1.5 py-0.5 rounded-md bg-primary/10 tabular-nums">
              {minSimilarity.toFixed(1)}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={10}
            step={0.1}
            value={minSimilarity}
            onChange={e => onMinSimilarityChange(Number(e.target.value))}
            onMouseUp={() => onTriggerScan(minSimilarity)}
            onTouchEnd={() => onTriggerScan(minSimilarity)}
            className="w-full h-1.5 bg-muted rounded-lg appearance-none cursor-pointer accent-primary hover:accent-primary/80 transition-colors"
          />
          <div className="grid grid-cols-5 gap-1">
            {[
              { label: t('容差'), val: 0.0, tip: t('最大容差') },
              { label: t('连拍'), val: 5.0, tip: t('连拍微移') },
              { label: t('标准'), val: 7.5, tip: t('推荐标准') },
              { label: t('严苛'), val: 9.0, tip: t('高度相似') },
              { label: t('精确'), val: 10.0, tip: t('内容完全一致') }
            ].map(preset => {
              const isSelected = Math.abs(minSimilarity - preset.val) < 0.01
              return (
                <button
                  key={preset.val}
                  type="button"
                  title={preset.tip}
                  onClick={() => {
                    onMinSimilarityChange(preset.val)
                    onTriggerScan(preset.val)
                  }}
                  className={cn(
                    'py-1 rounded-md text-[10px] font-semibold border transition-all duration-150 active:scale-95 cursor-pointer',
                    isSelected
                      ? 'bg-primary text-primary-foreground border-primary shadow-xs'
                      : 'bg-background text-muted-foreground border-border/70 hover:bg-accent hover:text-foreground'
                  )}
                >
                  {preset.label}
                </button>
              )
            })}
          </div>
        </div>
        {/* 全部发现结果 (Switch 控件控制全局筛选) */}
        <div
          onClick={() => onSelectStrategyFilter('all')}
          className={cn(
            'w-full flex items-center justify-between py-1 text-sm font-bold transition-all duration-150 shadow-2xs cursor-pointer select-none',
            activeStrategyFilter === 'all' ? 'text-primary' : 'text-foreground'
          )}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="flex flex-col">
              <span className="truncate">{t('显示所有检出的结果')}</span>
            </div>
            <Badge
              variant="secondary"
              className="text-xs px-2 py-0.5 h-5 font-mono font-bold rounded-md bg-muted text-foreground"
            >
              {duplicateGroups.length}
            </Badge>
          </div>
          <div className="flex items-center gap-2 shrink-0" onClick={e => e.stopPropagation()}>
            <Switch
              checked={activeStrategyFilter === 'all'}
              onCheckedChange={checked => {
                if (checked) {
                  onSelectStrategyFilter('all')
                } else {
                  // 若关闭全选，默认落到第一个有结果的策略或首个策略
                  const firstStrat =
                    duplicateGroups[0]?.strategy || strategyDefinitions[0]?.key || 'all'
                  onSelectStrategyFilter(firstStrat)
                }
              }}
              className="scale-90 data-[state=checked]:bg-primary"
              title={t('切换全部结果视图')}
            />
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2.5 space-y-2.5">
        {strategyCategories.map(category => {
          const catStrategies = strategyDefinitions.filter(s => s.category === category.key)
          const isCollapsed = collapsedCategories[category.key]
          const catCount = duplicateGroups.filter(g =>
            catStrategies.some(s => s.key === g.strategy)
          ).length

          return (
            <div
              key={category.key}
              className="rounded-xl border border-border/60 bg-card/40 overflow-hidden shadow-2xs"
            >
              <div
                onClick={() => onToggleCategoryCollapse(category.key)}
                className="px-3 py-2 bg-muted/40 flex items-center justify-between cursor-pointer hover:bg-muted/70 transition-colors select-none"
              >
                <div className="flex items-center gap-2 text-xs font-bold text-foreground">
                  <MaterialIcon
                    icon={isCollapsed ? 'chevron_right' : 'expand_more'}
                    className="text-sm text-muted-foreground"
                  />
                  <span>{category.name}</span>
                </div>
                {catCount > 0 && (
                  <Badge
                    variant="secondary"
                    className="text-[10px] px-1.5 py-0 h-4 font-mono font-bold bg-primary/10 text-primary"
                  >
                    {catCount}
                  </Badge>
                )}
              </div>

              {!isCollapsed && (
                <div className="p-2 space-y-1.5">
                  {catStrategies.map(strat => {
                    const count = duplicateGroups.filter(g => g.strategy === strat.key).length
                    const isActive = activeStrategyFilter === strat.key
                    const isEnabled = enabledStrategies.includes(strat.key)
                    const isDisabled = strat.disabled === true

                    return (
                      <div
                        key={strat.key}
                        className={cn(
                          'w-full flex items-center justify-between px-3 py-2 rounded-xl text-sm font-semibold transition-all duration-150 group border',
                          isActive
                            ? 'bg-primary/10 text-primary border-primary/40 font-bold shadow-2xs'
                            : 'text-foreground hover:bg-accent/60 hover:text-foreground border-transparent bg-background/50',
                          isDisabled &&
                            'opacity-40 cursor-not-allowed hover:bg-transparent hover:text-muted-foreground'
                        )}
                      >
                        <div
                          className="flex items-center gap-2.5 cursor-pointer flex-1 min-w-0"
                          onClick={() => !isDisabled && onSelectStrategyFilter(strat.key)}
                        >
                          <Checkbox
                            checked={isEnabled}
                            disabled={isDisabled}
                            onCheckedChange={() => onToggleStrategy(strat.key)}
                            onClick={e => e.stopPropagation()}
                            className="h-4 w-4 rounded-md data-[state=checked]:bg-primary data-[state=checked]:border-primary"
                          />
                          <MaterialIcon
                            icon={strat.icon}
                            className="text-base text-primary/80 flex-shrink-0"
                          />
                          <span
                            className="truncate text-xs md:text-sm tracking-tight"
                            title={strat.description}
                          >
                            {strat.label}
                          </span>
                          {strat.description && (
                            <MaterialIcon
                              icon="help_outline"
                              className="text-base text-muted-foreground/50 group-hover:text-primary/70 flex-shrink-0 cursor-help"
                              title={strat.description}
                            />
                          )}
                        </div>

                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          {strat.warning && (
                            <Badge
                              variant="outline"
                              className="text-[11px] px-1.5 py-0 h-4 font-medium text-amber-600 border-amber-600/30 bg-amber-500/5"
                            >
                              {strat.warning}
                            </Badge>
                          )}
                          {isDisabled && (
                            <Badge
                              variant="outline"
                              className="text-[11px] px-1.5 py-0 h-4 text-muted-foreground border-border/40"
                            >
                              {t('即将推出')}
                            </Badge>
                          )}
                          {count > 0 && (
                            <Badge
                              variant={isActive ? 'default' : 'secondary'}
                              className={cn(
                                'text-xs px-2 py-0.5 h-4.5 font-mono font-bold',
                                isActive
                                  ? 'bg-primary text-primary-foreground'
                                  : 'bg-muted text-foreground'
                              )}
                            >
                              {count}
                            </Badge>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
