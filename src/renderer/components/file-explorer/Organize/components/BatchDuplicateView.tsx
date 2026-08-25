import React, { useState, useEffect, useMemo } from 'react'
import { MaterialIcon, cn } from '../../../../lib/utils'
import { t } from '@app/languages'
import { Button } from '../../../ui/button'
import { Badge } from '../../../ui/badge'
import { Checkbox } from '../../../ui/checkbox'
import {
  DuplicateGroup,
  DuplicateFileItem,
  DuplicateDetectionStrategy
} from '@firefly/types'
import { toast } from '../../../common/Toast'

interface BatchDuplicateViewProps {
  files: any[]
  workspaceDirectoryPath: string
  onExecuteTrash: (filePaths: string[]) => Promise<void>
  isTrashing?: boolean
}

type RecommendRule =
  | 'highest_resolution'
  | 'highest_quality'
  | 'newest_modified'
  | 'oldest_created'
  | 'original_name'

export const BatchDuplicateView: React.FC<BatchDuplicateViewProps> = ({
  files,
  workspaceDirectoryPath,
  onExecuteTrash,
  isTrashing = false
}) => {
  const [minSimilarity, setMinSimilarity] = useState<number>(7.5)
  const [duplicateGroups, setDuplicateGroups] = useState<DuplicateGroup[]>([])
  const [isScanning, setIsScanning] = useState(false)
  const [activeStrategyFilter, setActiveStrategyFilter] = useState<string>('all')
  const [enabledStrategies, setEnabledStrategies] = useState<string[]>([
    'exact_hash',
    'image_phash',
    'audio_hash',
    'text_simhash',
    'filename_heuristic'
  ])
  const [recommendRule, setRecommendRule] = useState<RecommendRule>('highest_resolution')

  // 格式化文件大小
  const formatBytes = (bytes: number): string => {
    if (!bytes || bytes <= 0) return '0 B'
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
    return `${bytes} B`
  }

  // 执行双轨扫描 (支持全 14 种策略调度)
  const handleScan = async (overrideSimilarity?: number, overrideStrategies?: string[]) => {
    setIsScanning(true)
    setDuplicateGroups([])
    const sim = overrideSimilarity ?? minSimilarity
    const currentStrategies = overrideStrategies ?? enabledStrategies

    try {
      if (window.electronAPI?.organizeBatch?.scanDuplicates) {
        const groups = await window.electronAPI.organizeBatch.scanDuplicates({
          workspaceDirectoryPath,
          minSimilarity: sim,
          strategies: currentStrategies as DuplicateDetectionStrategy[]
        })
        setDuplicateGroups(groups || [])
        toast.success(t('查重扫描完成，发现 {count} 个相似组', { count: groups?.length || 0 }))
      }
    } catch (err: any) {
      toast.error(err?.message || t('查重扫描失败'))
    } finally {
      setIsScanning(false)
    }
  }

  // 组件挂载时自动扫描
  useEffect(() => {
    handleScan()
  }, [workspaceDirectoryPath])

  const toggleStrategy = (stratKey: string) => {
    const updated = enabledStrategies.includes(stratKey)
      ? enabledStrategies.filter(s => s !== stratKey)
      : [...enabledStrategies, stratKey]
    setEnabledStrategies(updated)
    handleScan(minSimilarity, updated)
  }

  // 切换保留规则
  const handleApplyRule = (rule: RecommendRule) => {
    setRecommendRule(rule)
    setDuplicateGroups(prev => {
      const updated = [...prev]
      if (window.electronAPI?.organizeBatch?.applyKeepRule) {
        window.electronAPI.organizeBatch.applyKeepRule(updated, rule)
      }
      return updated
    })
  }

  // 手动切换单个组内文件的保留状态
  const handleSetKeepFile = (groupIndex: number, fileIndex: number) => {
    setDuplicateGroups(prev => {
      const updated = [...prev]
      const group = updated[groupIndex]
      if (!group) return prev

      group.files = group.files.map((f, idx) => ({
        ...f,
        isRecommendedKeep: idx === fileIndex,
        selectedForDelete: idx !== fileIndex
      }))
      group.recommendedKeepFingerprint = group.files[fileIndex]?.fingerprint
      return updated
    })
  }

  // 统计信息计算
  const statistics = useMemo(() => {
    let redundantCount = 0
    let freedBytes = 0

    for (const group of duplicateGroups) {
      const forDelete = group.files.filter(f => f.selectedForDelete)
      redundantCount += forDelete.length
      freedBytes += forDelete.reduce((sum, f) => sum + (f.size || 0), 0)
    }

    return {
      totalGroups: duplicateGroups.length,
      redundantCount,
      freedBytes: formatBytes(freedBytes)
    }
  }, [duplicateGroups])

  // 14 大核心策略定义表
  const STRATEGY_DEFINITIONS = useMemo(() => [
    { key: 'exact_hash', label: t('精确内容一致 (Duplicates)'), icon: 'fingerprint' },
    { key: 'image_phash', label: t('相似图片 (Similar Images)'), icon: 'image' },
    { key: 'audio_hash', label: t('相似音乐 (Same Music)'), icon: 'audiotrack' },
    { key: 'video_phash', label: t('相似视频 (Similar Videos)'), icon: 'videocam', warning: t('耗时较长') },
    { key: 'empty_folders', label: t('空文件夹 (Empty Folders)'), icon: 'folder_open' },
    { key: 'big_files', label: t('超大文件 (Big Files)'), icon: 'save' },
    { key: 'empty_files', label: t('空文件 (Empty Files)'), icon: 'draft' },
    { key: 'temporary_files', label: t('临时缓存 (Temporary Files)'), icon: 'auto_delete' },
    { key: 'invalid_symlinks', label: t('断裂软链接 (Invalid Symlinks)'), icon: 'link_off' },
    { key: 'broken_files', label: t('损坏文件 (Broken Files)'), icon: 'broken_image' },
    { key: 'bad_extensions', label: t('错误扩展名 (Bad Extensions)'), icon: 'extension_off' },
    { key: 'bad_names', label: t('异常文件名 (Bad Names)'), icon: 'edit_attributes' },
    { key: 'exif_remover', label: t('Exif隐私清理 (Exif Remover)'), icon: 'privacy_tip' },
    { key: 'video_optimizer', label: t('视频优化转换 (Video Optimizer)'), icon: 'smart_display' },
    { key: 'text_simhash', label: t('文本语义相似 (Text SimHash)'), icon: 'article' },
    { key: 'filename_heuristic', label: t('副本衍生文件 (Copy Heuristics)'), icon: 'copy_all' }
  ], [])

  // 过滤后的组
  const filteredGroups = useMemo(() => {
    if (activeStrategyFilter === 'all') return duplicateGroups
    return duplicateGroups.filter(g => g.strategy === activeStrategyFilter)
  }, [duplicateGroups, activeStrategyFilter])

  // 待删除文件列表
  const filesToDelete = useMemo(() => {
    const list: string[] = []
    for (const group of duplicateGroups) {
      for (const f of group.files) {
        if (f.selectedForDelete && f.path) {
          list.push(f.path)
        }
      }
    }
    return list
  }, [duplicateGroups])

  return (
    <div className="flex-1 flex overflow-hidden bg-background">
      {/* ─── 左栏：统计面板与策略筛选器 ────────────────────────────────────────── */}
      <div className="w-80 border-r border-border/60 flex flex-col bg-muted/10 shrink-0">
        <div className="p-4 border-b border-border/50 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
              <MaterialIcon icon="cleaning_services" className="text-sm text-primary" />
              {t('清理分析统计')}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleScan()}
              disabled={isScanning}
              className="h-7 text-xs gap-1 rounded-lg border-primary/30 text-primary hover:bg-primary/10"
            >
              <MaterialIcon icon="refresh" className={cn('text-sm', isScanning && 'animate-spin')} />
              <span>{isScanning ? t('扫描中...') : t('重新扫描')}</span>
            </Button>
          </div>

          {/* 空间与文件统计看板 */}
          <div className="grid grid-cols-2 gap-2">
            <div className="p-2.5 rounded-xl border border-border/50 bg-card">
              <div className="text-[10px] text-muted-foreground">{t('发现清理/冗余组')}</div>
              <div className="text-base font-bold text-foreground tabular-nums">
                {statistics.totalGroups}
              </div>
            </div>
            <div className="p-2.5 rounded-xl border border-border/50 bg-card">
              <div className="text-[10px] text-muted-foreground">{t('可释放空间')}</div>
              <div className="text-base font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">
                {statistics.freedBytes}
              </div>
            </div>
          </div>

          {/* 最小相似度阈值滑块与预设 (0.0 ~ 10.0 动态平滑映射) */}
          <div className="pt-2 border-t border-border/40 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground font-medium">{t('最小相似度阈值')}</span>
              <span className="font-bold text-primary tabular-nums">{minSimilarity.toFixed(1)}</span>
            </div>
            <input
              type="range"
              min={0}
              max={10}
              step={0.1}
              value={minSimilarity}
              onChange={e => setMinSimilarity(Number(e.target.value))}
              onMouseUp={() => handleScan(minSimilarity)}
              onTouchEnd={() => handleScan(minSimilarity)}
              className="w-full h-1.5 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
            />
            <div className="flex gap-1">
              {[
                { label: t('最大容差(0.0)'), val: 0.0 },
                { label: t('连拍微移(5.0)'), val: 5.0 },
                { label: t('标准(7.5)'), val: 7.5 },
                { label: t('严苛(9.0)'), val: 9.0 },
                { label: t('精确(10.0)'), val: 10.0 }
              ].map(preset => (
                <button
                  key={preset.val}
                  type="button"
                  onClick={() => {
                    setMinSimilarity(preset.val)
                    handleScan(preset.val)
                  }}
                  className={cn(
                    'flex-1 py-1 rounded-md text-[10px] font-medium border transition-colors',
                    Math.abs(minSimilarity - preset.val) < 0.01
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-card text-muted-foreground border-border hover:bg-accent'
                  )}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* 策略分类筛选与启用列表 */}
        <div className="p-3 border-b border-border/40 flex items-center justify-between">
          <span className="text-xs font-semibold text-muted-foreground">{t('清理与查重策略')}</span>
          <span className="text-[10px] text-muted-foreground/80">{t('勾选以启用扫描')}</span>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          <button
            type="button"
            onClick={() => setActiveStrategyFilter('all')}
            className={cn(
              'w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs font-medium transition-all duration-150',
              activeStrategyFilter === 'all'
                ? 'bg-primary/10 text-primary border border-primary/30 font-semibold'
                : 'text-muted-foreground hover:bg-muted/30 hover:text-foreground border border-transparent'
            )}
          >
            <div className="flex items-center gap-2">
              <MaterialIcon icon="list_alt" className="text-sm" />
              <span>{t('全部发现结果')}</span>
            </div>
            <Badge variant={activeStrategyFilter === 'all' ? 'default' : 'secondary'} className="text-[10px] px-1.5 py-0 h-4">
              {duplicateGroups.length}
            </Badge>
          </button>

          {STRATEGY_DEFINITIONS.map(strat => {
            const count = duplicateGroups.filter(g => g.strategy === strat.key).length
            const isActive = activeStrategyFilter === strat.key
            const isEnabled = enabledStrategies.includes(strat.key)

            return (
              <div
                key={strat.key}
                className={cn(
                  'w-full flex items-center justify-between px-2.5 py-1.5 rounded-xl text-xs font-medium transition-all duration-150 group border',
                  isActive
                    ? 'bg-primary/10 text-primary border-primary/30 font-semibold'
                    : 'text-muted-foreground hover:bg-muted/30 hover:text-foreground border-transparent'
                )}
              >
                <div
                  className="flex items-center gap-2 cursor-pointer flex-1 min-w-0"
                  onClick={() => setActiveStrategyFilter(strat.key)}
                >
                  <Checkbox
                    checked={isEnabled}
                    onCheckedChange={() => toggleStrategy(strat.key)}
                    onClick={e => e.stopPropagation()}
                    className="h-3.5 w-3.5"
                  />
                  <MaterialIcon icon={strat.icon} className="text-sm flex-shrink-0" />
                  <span className="truncate">{strat.label}</span>
                </div>

                <div className="flex items-center gap-1 flex-shrink-0">
                  {strat.warning && (
                    <Badge variant="outline" className="text-[8px] px-1 py-0 h-3.5 text-amber-600 border-amber-600/30">
                      {strat.warning}
                    </Badge>
                  )}
                  {count > 0 && (
                    <Badge variant={isActive ? 'default' : 'secondary'} className="text-[10px] px-1.5 py-0 h-4">
                      {count}
                    </Badge>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* ─── 右栏：对比卡片与智能推荐保留 ─────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden bg-card/20">
        {/* 顶部保留规则切换 */}
        <div className="p-3 border-b border-border/50 bg-background/80 flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
              <MaterialIcon icon="tune" className="text-sm text-primary" />
              {t('智能推荐保留规则：')}
            </span>
            <select
              value={recommendRule}
              onChange={e => handleApplyRule(e.target.value as RecommendRule)}
              className="text-xs font-medium h-7 rounded-lg border border-border bg-background px-2 focus:ring-1 focus:ring-primary outline-hidden"
            >
              <option value="highest_resolution">{t('最高分辨率优先 (推荐)')}</option>
              <option value="highest_quality">{t('最高质量分优先')}</option>
              <option value="newest_modified">{t('最新修改时间优先')}</option>
              <option value="oldest_created">{t('最早创建时间优先')}</option>
              <option value="original_name">{t('原始简洁文件名优先')}</option>
            </select>
          </div>

          <div className="text-xs text-muted-foreground flex items-center gap-1">
            <MaterialIcon icon="delete_sweep" className="text-sm text-destructive" />
            <span>
              {t('已选定 {count} 个文件待清理', { count: filesToDelete.length })}
            </span>
          </div>
        </div>

        {/* 查重组列表 */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {filteredGroups.length === 0 ? (
            <div className="h-60 flex flex-col items-center justify-center text-muted-foreground space-y-2">
              <MaterialIcon icon="verified" className="text-4xl text-emerald-500/60" />
              <div className="text-sm font-semibold">{t('未发现重复或冗余文件')}</div>
              <div className="text-xs">{t('当前工作区文件非常整洁，无多余副本')}</div>
            </div>
          ) : (
            filteredGroups.map((group, gIdx) => (
              <div
                key={group.groupId || gIdx}
                className="rounded-2xl border border-border/60 bg-card p-4 space-y-3 shadow-xs"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="font-semibold text-xs gap-1">
                      <MaterialIcon icon="hub" className="text-xs" />
                      {group.strategy === 'exact_hash'
                        ? t('100% 精确一致')
                        : group.strategy === 'image_phash'
                          ? t('视觉相似图片')
                          : group.strategy === 'audio_hash' || group.strategy === 'audio_match'
                            ? t('相似音乐')
                            : group.strategy === 'video_phash' || group.strategy === 'video_keyframes'
                              ? t('相似视频')
                              : group.strategy === 'empty_folders'
                                ? t('空文件夹')
                                : group.strategy === 'big_files'
                                  ? t('超大文件')
                                  : group.strategy === 'empty_files'
                                    ? t('空文件')
                                    : group.strategy === 'temporary_files'
                                      ? t('临时缓存')
                                      : group.strategy === 'invalid_symlinks'
                                        ? t('断裂软链接')
                                        : group.strategy === 'broken_files'
                                          ? t('损坏文件')
                                          : group.strategy === 'bad_extensions'
                                            ? t('错误扩展名')
                                            : group.strategy === 'bad_names'
                                              ? t('异常文件名')
                                              : group.strategy === 'exif_remover'
                                                ? t('Exif隐私清理')
                                                : group.strategy === 'video_optimizer'
                                                  ? t('视频优化')
                                                  : group.strategy === 'text_simhash'
                                                    ? t('文档语义相似')
                                                    : t('副本衍生文件')}
                    </Badge>
                    <span className="text-xs font-semibold text-foreground">
                      {group.description}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    {group.groupThreshold !== undefined && group.groupThreshold !== null && (
                      <Badge variant="outline" className="text-[10px] font-mono border-amber-500/40 text-amber-600 dark:text-amber-400 bg-amber-500/5">
                        {t('踩线阈值 ≥ {thresh}', { thresh: group.groupThreshold.toFixed(1) })}
                      </Badge>
                    )}
                    <span className="text-xs text-emerald-600 dark:text-emerald-400 font-mono font-medium">
                      {t('相似度 {percent}%', { percent: Math.round(group.similarityPercentage) })}
                    </span>
                  </div>
                </div>

                {/* 并排比对卡片 */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {group.files.map((file, fIdx) => {
                    const isKeep = file.isRecommendedKeep

                    return (
                      <div
                        key={file.fileId || fIdx}
                        onClick={() => handleSetKeepFile(gIdx, fIdx)}
                        className={cn(
                          'rounded-xl border p-3 cursor-pointer transition-all duration-200 relative overflow-hidden',
                          'flex flex-col justify-between space-y-2',
                          isKeep
                            ? 'border-emerald-500/60 bg-emerald-500/5 ring-1 ring-emerald-500/20'
                            : 'border-destructive/40 bg-destructive/5 hover:border-destructive/60'
                        )}
                      >
                        <div className="space-y-1.5">
                          <div className="flex items-start justify-between gap-1">
                            <span
                              className="font-semibold text-xs text-foreground truncate max-w-[180px]"
                              title={file.name}
                            >
                              {file.name}
                            </span>
                            {isKeep ? (
                              <Badge className="bg-emerald-500 text-white text-[10px] h-4.5 px-1.5 shrink-0">
                                {t('★ 保留')}
                              </Badge>
                            ) : (
                              <Badge
                                variant="destructive"
                                className="text-[10px] h-4.5 px-1.5 shrink-0"
                              >
                                {t('🗑️ 回收站')}
                              </Badge>
                            )}
                          </div>

                          <div className="text-[11px] text-muted-foreground space-y-0.5 font-mono">
                            <div>{t('大小: {size}', { size: formatBytes(file.size) })}</div>
                            {file.resolution && (
                              <div>{t('分辨率: {res}', { res: file.resolution })}</div>
                            )}
                            {file.qualityScore && (
                              <div>{t('质量评分: {score}', { score: file.qualityScore })}</div>
                            )}
                            <div className="truncate" title={file.path}>
                              {t('路径: {path}', { path: file.path })}
                            </div>
                          </div>
                        </div>

                        <div className="text-[10px] text-muted-foreground/80 flex items-center justify-between pt-2 border-t border-border/40">
                          <span>{t('点击切换保留/删除')}</span>
                          <MaterialIcon
                            icon={isKeep ? 'check_circle' : 'delete'}
                            className={cn('text-xs', isKeep ? 'text-emerald-500' : 'text-destructive')}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))
          )}
        </div>

        {/* 底部操作区 */}
        <div className="p-3 border-t border-border/50 bg-muted/10 flex items-center justify-between shrink-0">
          <span className="text-xs text-muted-foreground">
            {t('已选定 {count} 个冗余文件待清理', { count: filesToDelete.length })}
          </span>
          <Button
            id="btn-trash-duplicates-trigger"
            size="sm"
            variant="destructive"
            onClick={() => onExecuteTrash(filesToDelete)}
            disabled={isTrashing || filesToDelete.length === 0}
            className="h-8 px-4 text-xs font-bold gap-1.5 shadow-xs"
          >
            <MaterialIcon
              icon={isTrashing ? 'sync' : 'delete_sweep'}
              className={cn('text-sm', isTrashing && 'animate-spin')}
            />
            <span>{isTrashing ? t('正在清理...') : t('执行清理')}</span>
          </Button>
        </div>
      </div>
    </div>
  )
}
