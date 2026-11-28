import React, { useState, useEffect } from 'react'
import { MaterialIcon, cn } from '../../../../lib/utils'
import { t } from '@app/languages'
import { Button } from '../../../ui/button'
import { Input } from '../../../ui/input'
import { DuplicateGroup, DuplicateFileItem, DuplicateDetectionStrategy } from '@firefly/types'
import { toast } from '../../../common/Toast'
import { SplitPane } from '../../../common/SplitPane'
import { SplitPreviewPanel } from '../../SplitPreviewPanel'
import { PAGE_IDS } from '../../../../constants/page-ids'
import { ContextMenu } from '../../../common/ContextMenu'
import { DuplicateVirtualList } from './batch-duplicate-view/DuplicateVirtualList'
import { RecommendRule } from './batch-duplicate-view/types'
import { DuplicateSidebarPane } from './batch-duplicate-view/DuplicateSidebarPane'
import { DuplicateConfirmDialog } from './batch-duplicate-view/DuplicateConfirmDialog'
import { useDuplicateActions } from './useDuplicateActions'

interface BatchDuplicateViewProps {
  files: any[]
  workspaceDirectoryPath: string
  onExecuteTrash: (filePaths: string[]) => Promise<void>
  isTrashing?: boolean
  onSelectedCountChange?: (count: number) => void
  onProcessingStateChange?: (isProcessing: boolean) => void
  onFilesChanged?: () => Promise<void> | void
}

export const BatchDuplicateView: React.FC<BatchDuplicateViewProps> = ({
  files,
  workspaceDirectoryPath,
  onExecuteTrash,
  isTrashing = false,
  onSelectedCountChange,
  onProcessingStateChange,
  onFilesChanged
}) => {
  const [minSimilarity, setMinSimilarity] = useState<number>(7.5)
  const [duplicateGroups, setDuplicateGroups] = useState<DuplicateGroup[]>([])
  const [isScanning, setIsScanning] = useState(false)
  const [hasScanned, setHasScanned] = useState(false)
  const [scannedCount, setScannedCount] = useState<number>(0)
  const [activeStrategyFilter, setActiveStrategyFilter] = useState<string>('all')
  const [searchKeyword, setSearchKeyword] = useState<string>('')
  const [collapsedCategories, setCollapsedCategories] = useState<Record<string, boolean>>({})
  const [enabledStrategies, setEnabledStrategies] = useState<string[]>([
    'exact_hash',
    'image_phash',
    'audio_hash',
    'empty_folders',
    'big_files',
    'empty_files',
    'temporary_files',
    'invalid_symlinks',
    'broken_files',
    'bad_extensions',
    'bad_names',
    'exif_remover',
    'video_optimizer'
  ])
  const [recommendRule, setRecommendRule] = useState<RecommendRule>('highest_resolution')
  const [previewingPath, setPreviewingPath] = useState<string>('')
  const [trashingGroupId, setTrashingGroupId] = useState<string | null>(null)
  const [isBatchProcessing, setIsBatchProcessing] = useState<boolean>(false)
  const [isDestructiveConfirmOpen, setIsDestructiveConfirmOpen] = useState<boolean>(false)
  const [streamingScannedCount, setStreamingScannedCount] = useState<number>(0)
  const [streamingTotalCount, setStreamingTotalCount] = useState<number>(0)
  const [currentScanStage, setCurrentScanStage] = useState<string>('')

  // ffprobe 可用性检测：随包内置（lock.resources.ffprobe），仅精简/裁剪包会缺失。
  // 缺失时置灰"相似视频"与"视频优化转换"，杜绝静默 0 结果假阴性
  const [ffprobeAvailable, setFfprobeAvailable] = useState<boolean>(true)

  useEffect(() => {
    let cancelled = false
    const probe = async () => {
      try {
        const res = await window.electronAPI?.utils?.detectFfprobe?.()
        if (!cancelled) setFfprobeAvailable(Boolean(res?.available))
      } catch {
        if (!cancelled) setFfprobeAvailable(false)
      }
    }
    probe()
    return () => {
      cancelled = true
    }
  }, [])

  // Issue #738: ffprobe 缺失时将视频类策略从默认勾选中剔除，保持 UI 与实际能力一致
  useEffect(() => {
    if (!ffprobeAvailable) {
      setEnabledStrategies(prev => prev.filter(s => s !== 'video_phash' && s !== 'video_optimizer'))
    }
  }, [ffprobeAvailable])

  // 将批量处理执行状态即时同步给顶栏操作按钮
  useEffect(() => {
    if (onProcessingStateChange) {
      onProcessingStateChange(isBatchProcessing)
    }
  }, [isBatchProcessing, onProcessingStateChange])

  // 右键菜单状态（对齐 FileList 组件）
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    file: DuplicateFileItem
  } | null>(null)

  const {
    fileMetaMap,
    formatBytes,
    handleApplyRule,
    getFileThumbnailUrl,
    handleToggleFileSelection,
    handleSelectFileForPreview,
    handleContextMenu,
    contextMenuItems,
    handleToggleGroupAction,
    handleGlobalToggleAction,
    handleExecuteGroupAction,
    statistics,
    STRATEGY_CATEGORIES,
    STRATEGY_DEFINITIONS,
    filteredGroups,
    totalSelectedCount,
    selectedActionSummary,
    confirmDialogConfig,
    executeBatchProcessConfirmed
  } = useDuplicateActions({
    files,
    workspaceDirectoryPath,
    duplicateGroups,
    setDuplicateGroups,
    setRecommendRule,
    setPreviewingPath,
    setTrashingGroupId,
    setIsBatchProcessing,
    contextMenu,
    setContextMenu,
    activeStrategyFilter,
    searchKeyword,
    ffprobeAvailable,
    onExecuteTrash,
    onFilesChanged
  })

  // 执行双轨扫描 (支持全 16 种策略调度，全量覆盖工作区物理文件，支持实时流式进度)
  const handleScan = async (overrideSimilarity?: number, overrideStrategies?: string[]) => {
    setIsScanning(true)
    setDuplicateGroups([])
    setStreamingScannedCount(0)
    setStreamingTotalCount(files.length || 0)
    setCurrentScanStage(t('初始化多模态引擎...'))

    const sim = overrideSimilarity ?? minSimilarity
    const currentStrategies = overrideStrategies ?? enabledStrategies

    // 订阅流式进度
    let cleanupProgress: (() => void) | undefined = undefined
    let localMaxScanned = 0
    let localMaxTotal = 0

    if (window.electronAPI?.organizeBatch?.onScanProgress) {
      cleanupProgress = window.electronAPI.organizeBatch.onScanProgress(data => {
        if (data.scanned !== undefined && data.scanned > 0) {
          localMaxScanned = Math.max(localMaxScanned, data.scanned)
          setStreamingScannedCount(localMaxScanned)
          setScannedCount(localMaxScanned)
        }
        if (data.totalScanned !== undefined && data.totalScanned > 0) {
          localMaxTotal = Math.max(localMaxTotal, data.totalScanned)
          setStreamingTotalCount(localMaxTotal)
          if (!localMaxScanned) {
            setScannedCount(localMaxTotal)
          }
        }
        if (data.stage) {
          setCurrentScanStage(data.stage)
        }
        if (data.group) {
          setDuplicateGroups(prev => {
            if (prev.some(g => g.groupId === data.group.groupId)) return prev
            return [...prev, data.group]
          })
        }
      })
    }

    try {
      if (window.electronAPI?.organizeBatch?.scanDuplicates) {
        const groups = await window.electronAPI.organizeBatch.scanDuplicates({
          workspaceDirectoryPath,
          minSimilarity: sim,
          strategies: currentStrategies as DuplicateDetectionStrategy[]
        })
        const normalizedGroups: DuplicateGroup[] = (groups || []).map(
          (g: DuplicateGroup, idx: number) => ({
            ...g,
            groupId: g.groupId || `${g.strategy}_${idx}`,
            files: (g.files || []).map((f: DuplicateFileItem) => ({ ...f }))
          })
        )
        setDuplicateGroups(normalizedGroups)
        const finalCount = localMaxScanned || localMaxTotal || streamingScannedCount || 0
        setScannedCount(finalCount)
        setHasScanned(true)
        toast.success(t('查重扫描完成，发现 {count} 个相似组', { count: normalizedGroups.length }))
      }
    } catch (err: any) {
      toast.error(err?.message || t('查重扫描失败'))
    } finally {
      cleanupProgress?.()
      setIsScanning(false)
    }
  }

  // 移除组件挂载时的自动扫描 (避免 Keep-Alive 导致切换目录后静默在后台扫描整个工作区)
  useEffect(() => {
    // 切换工作区目录时，重置扫描状态，等待用户主动点击开始扫描
    setDuplicateGroups([])
    setHasScanned(false)
    setScannedCount(0)
  }, [workspaceDirectoryPath])

  const toggleStrategy = (stratKey: string) => {
    // Issue #738: 缺少外部 ffprobe 时禁止启用视频类策略，避免静默 0 结果假阴性
    if (!ffprobeAvailable && (stratKey === 'video_phash' || stratKey === 'video_optimizer')) {
      toast.warning(t('需安装外部 ffprobe 依赖'))
      return
    }
    const updated = enabledStrategies.includes(stratKey)
      ? enabledStrategies.filter(s => s !== stratKey)
      : [...enabledStrategies, stratKey]
    setEnabledStrategies(updated)
    // 如果用户勾选了策略，自动将筛选视角重置回全部结果，确保能立即看到所有勾选策略的扫描结果
    if (activeStrategyFilter !== 'all') {
      setActiveStrategyFilter('all')
    }
    if (hasScanned) {
      handleScan(minSimilarity, updated)
    }
  }

  const toggleCategoryCollapse = (catKey: string) => {
    setCollapsedCategories(prev => ({
      ...prev,
      [catKey]: !prev[catKey]
    }))
  }

  // 当勾选待处理文件数量变动时，即时同步给父组件（用于顶栏按钮显示：批量处理全部勾选 (N)）
  useEffect(() => {
    if (onSelectedCountChange) {
      onSelectedCountChange(totalSelectedCount)
    }
  }, [totalSelectedCount, onSelectedCountChange])

  // 批量处理全部勾选执行逻辑：
  // 破坏性操作前置二次确认弹窗防误触，确认后按策略分组依次执行
  const handleExecuteBatchProcessAll = () => {
    let hasAnySelected = false
    for (const g of duplicateGroups) {
      if (g.files.some(f => f.selectedForDelete && f.path)) {
        hasAnySelected = true
        break
      }
    }
    if (!hasAnySelected) {
      toast.warning(t('未勾选任何需要处理的文件'))
      return
    }

    // 弹出破坏性二次确认安全弹窗 (Spec §4.4 / §7.1.1)
    setIsDestructiveConfirmOpen(true)
  }

  return (
    <div data-testid="batch-duplicate-view" className="flex-1 flex overflow-hidden bg-background">
      <SplitPane
        direction="horizontal"
        storageKey="organize-batch-duplicate-main"
        className="flex-1"
        sections={[
          // ─── 1. 左栏：清理分析统计与策略筛选器 ──────────────────────────────
          {
            id: 'duplicate-sidebar',
            type: 'pixel',
            defaultSize: 330,
            minSize: 280,
            content: (
              <DuplicateSidebarPane
                isScanning={isScanning}
                scannedCount={scannedCount}
                statistics={statistics}
                minSimilarity={minSimilarity}
                onMinSimilarityChange={setMinSimilarity}
                onTriggerScan={sim => handleScan(sim)}
                activeStrategyFilter={activeStrategyFilter}
                onSelectStrategyFilter={setActiveStrategyFilter}
                duplicateGroups={duplicateGroups}
                strategyCategories={STRATEGY_CATEGORIES}
                strategyDefinitions={STRATEGY_DEFINITIONS}
                collapsedCategories={collapsedCategories}
                onToggleCategoryCollapse={toggleCategoryCollapse}
                enabledStrategies={enabledStrategies}
                onToggleStrategy={toggleStrategy}
              />
            )
          },
          // ─── 2. 中栏：对比工作台 ──────────────────────────────
          {
            id: 'duplicate-content',
            type: 'flex',
            defaultSize: 2,
            minSize: 420,
            content: (
              <div className="h-full flex flex-col overflow-hidden bg-background">
                <div className="p-3 border-b border-border/50 bg-card/40 backdrop-blur-xs flex items-center justify-between flex-wrap gap-2.5 shrink-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-bold text-foreground flex items-center gap-1.5">
                      <MaterialIcon icon="auto_fix_high" className="text-sm text-primary" />
                      {t('推荐保留规则：')}
                    </span>
                    <select
                      value={recommendRule}
                      onChange={e => handleApplyRule(e.target.value as RecommendRule)}
                      className="text-xs font-semibold h-7.5 rounded-lg border border-border bg-background px-2.5 focus:ring-1 focus:ring-primary outline-hidden shadow-2xs cursor-pointer"
                    >
                      <option value="highest_resolution">
                        {t('★ 最高分辨率优先 (多模态推荐)')}
                      </option>
                      <option value="highest_quality">{t('★ 最佳 AI 质量评分优先')}</option>
                      <option value="newest_modified">{t('🕒 最新修改时间优先')}</option>
                      <option value="oldest_created">{t('📅 最早创建时间优先 (保留母本)')}</option>
                      <option value="original_name">{t('📝 原始简短文件名优先')}</option>
                    </select>
                  </div>

                  <div className="flex items-center gap-3">
                    <div className="relative w-44 md:w-56">
                      <MaterialIcon
                        icon="search"
                        className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground"
                      />
                      <Input
                        value={searchKeyword}
                        onChange={e => setSearchKeyword(e.target.value)}
                        placeholder={t('搜索组名或文件名...')}
                        className="h-7.5 text-xs pl-7 pr-6 rounded-lg bg-background"
                      />
                      {searchKeyword && (
                        <button
                          type="button"
                          onClick={() => setSearchKeyword('')}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        >
                          <MaterialIcon icon="close" className="text-xs" />
                        </button>
                      )}
                    </div>

                    <div className="flex items-center gap-1.5">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleGlobalToggleAction('keep_all')}
                        disabled={duplicateGroups.length === 0 || totalSelectedCount === 0}
                        className="h-7.5 text-xs font-semibold px-2.5 gap-1.5 rounded-lg border-border hover:bg-accent/60 cursor-pointer shadow-2xs"
                        title={t('取消所有选中项，全部标记为保留')}
                      >
                        <MaterialIcon
                          icon="done_all"
                          className="text-sm text-emerald-600 dark:text-emerald-400"
                        />
                        <span>{t('全保留')}</span>
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleGlobalToggleAction('invert')}
                        disabled={duplicateGroups.length === 0}
                        className="h-7.5 text-xs font-semibold px-2.5 gap-1.5 rounded-lg border-border hover:bg-accent/60 cursor-pointer shadow-2xs"
                        title={t('全局反向选择所有文件')}
                      >
                        <MaterialIcon icon="swap_horiz" className="text-sm text-primary" />
                        <span>{t('反选')}</span>
                      </Button>
                    </div>
                  </div>
                </div>

                {/* 扫描中顶部流式状态 Banner：固定在列表上方，不随结果滚动 (不遮挡下方的实时流式结果) */}
                {isScanning && (
                  <div className="px-4 pt-4 shrink-0">
                    <div className="relative overflow-hidden rounded-2xl border border-primary/25 bg-gradient-to-r from-primary/10 via-card to-background p-4 shadow-sm space-y-3">
                      {/* 背景动态流光 */}
                      <div className="absolute top-0 right-0 w-48 h-full bg-primary/5 rounded-full blur-2xl pointer-events-none -z-10 animate-pulse" />

                      <div className="flex items-center justify-between flex-wrap gap-3">
                        <div className="flex items-center gap-3">
                          <div className="relative w-10 h-10 rounded-xl bg-primary/15 border border-primary/30 flex items-center justify-center text-primary shadow-xs shrink-0">
                            <MaterialIcon icon="fingerprint" className="text-xl animate-pulse" />
                            <span className="absolute -top-1 -right-1 flex h-2.5 w-2.5">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-primary"></span>
                            </span>
                          </div>
                          <div className="space-y-0.5">
                            <div className="text-xs md:text-sm font-bold text-foreground flex items-center gap-2">
                              <span>{t('Omni 多模态双轨扫描中...')}</span>
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-primary/10 text-primary border border-primary/20">
                                <MaterialIcon icon="sync" className="text-xs animate-spin" />
                                {currentScanStage || t('特征比对中')}
                              </span>
                            </div>
                            <div className="text-[11px] text-muted-foreground">
                              {streamingScannedCount > 0
                                ? t(
                                    '已扫描 {scanned} / {total} 个文件，已流式发现 {found} 个待处理组',
                                    {
                                      scanned: streamingScannedCount,
                                      total: streamingTotalCount || files.length,
                                      found: duplicateGroups.length
                                    }
                                  )
                                : t('正在对 {count} 个文件进行多模态哈希比对与启发式规则分析...', {
                                    count: files.length
                                  })}
                            </div>
                          </div>
                        </div>

                        {/* 右侧阶段徽标与取消/刷新 */}
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-mono font-bold text-primary tabular-nums">
                            {streamingTotalCount > 0 && streamingScannedCount > 0
                              ? `${Math.min(100, Math.round((streamingScannedCount / streamingTotalCount) * 100))}%`
                              : ''}
                          </span>
                        </div>
                      </div>

                      {/* 线性微进度条 */}
                      <div className="h-1.5 w-full bg-muted/60 rounded-full overflow-hidden relative">
                        {streamingTotalCount > 0 && streamingScannedCount > 0 ? (
                          <div
                            className="h-full bg-primary rounded-full transition-all duration-300"
                            style={{
                              width: `${Math.min(100, Math.round((streamingScannedCount / streamingTotalCount) * 100))}%`
                            }}
                          />
                        ) : (
                          <div className="absolute inset-y-0 left-0 right-0 bg-gradient-to-r from-transparent via-primary to-transparent rounded-full animate-pulse opacity-90" />
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {!hasScanned && !isScanning ? (
                  <div className="flex-1 overflow-y-auto p-4">
                    <div className="h-full min-h-[380px] flex flex-col items-center justify-center p-6 text-center select-none">
                      <div className="relative max-w-md w-full p-8 rounded-3xl border border-border/60 bg-gradient-to-b from-card/80 via-card/50 to-background/90 backdrop-blur-md shadow-lg shadow-black/5 dark:shadow-black/20 flex flex-col items-center space-y-6 transition-all duration-300 hover:border-primary/30">
                        {/* 装饰性背景微光晕 */}
                        <div className="absolute -top-10 left-1/2 -translate-x-1/2 w-48 h-48 bg-primary/10 rounded-full blur-3xl pointer-events-none -z-10" />

                        {/* 图标容器 */}
                        <div className="relative">
                          <div className="w-20 h-20 rounded-3xl bg-gradient-to-br from-primary/20 via-primary/10 to-primary/5 border border-primary/25 flex items-center justify-center text-primary shadow-inner shadow-primary/10">
                            <MaterialIcon
                              icon="cleaning_services"
                              className="text-4xl drop-shadow-xs"
                            />
                          </div>
                          <span className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-background border border-primary/30 flex items-center justify-center shadow-xs text-primary">
                            <MaterialIcon icon="auto_awesome" className="text-sm" />
                          </span>
                        </div>

                        {/* 主文案与说明 */}
                        <div className="space-y-2 max-w-sm">
                          <h3 className="text-lg font-bold text-foreground tracking-tight">
                            {t('尚未开始分析此工作区')}
                          </h3>
                          <p className="text-xs text-muted-foreground leading-relaxed">
                            {t(
                              '深度检测当前工作区内的重复文件、图像相似副本、大文件及异常文件，并提供一键智能瘦身方案'
                            )}
                          </p>
                        </div>

                        {/* 能力特性胶囊 */}
                        <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-medium bg-muted/60 text-muted-foreground border border-border/40">
                            <MaterialIcon icon="fingerprint" className="text-xs text-primary" />
                            {t('多模态哈希查重')}
                          </span>
                          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-medium bg-muted/60 text-muted-foreground border border-border/40">
                            <MaterialIcon icon="image_search" className="text-xs text-primary" />
                            {t('视觉感知相似度')}
                          </span>
                          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-medium bg-muted/60 text-muted-foreground border border-border/40">
                            <MaterialIcon
                              icon="report_problem"
                              className="text-xs text-amber-500"
                            />
                            {t('异常与断链排查')}
                          </span>
                        </div>

                        {/* 主操作按钮 */}
                        <div className="pt-2 w-full flex flex-col items-center gap-2">
                          <Button
                            size="lg"
                            onClick={() => handleScan()}
                            className="w-full max-w-xs h-11 text-sm font-bold gap-2.5 rounded-xl bg-gradient-to-r from-primary to-primary/90 text-primary-foreground hover:brightness-105 active:scale-[0.98] shadow-md shadow-primary/20 transition-all duration-200 cursor-pointer"
                          >
                            <span>{t('开始清理分析与查重')}</span>
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : filteredGroups.length === 0 ? (
                  <div className="flex-1 overflow-y-auto p-4">
                    <div className="h-72 flex flex-col items-center justify-center text-muted-foreground space-y-3">
                      <div
                        className={cn(
                          'w-14 h-14 rounded-2xl flex items-center justify-center shadow-xs',
                          isScanning
                            ? 'bg-primary/10 text-primary'
                            : 'bg-emerald-500/10 text-emerald-500'
                        )}
                      >
                        <MaterialIcon
                          icon={isScanning ? 'search' : 'verified'}
                          className={cn('text-3xl', isScanning && 'animate-pulse')}
                        />
                      </div>
                      <div className="text-center space-y-1">
                        <div className="text-sm font-bold text-foreground">
                          {isScanning
                            ? t('正在持续比对文件特征...')
                            : activeStrategyFilter !== 'all' && duplicateGroups.length > 0
                              ? t('当前所选策略下无重复文件')
                              : t('未发现重复或冗余文件')}
                        </div>
                        <div className="text-xs text-muted-foreground max-w-sm">
                          {isScanning
                            ? t('扫描中一旦发现重复或相似组将即刻呈现在下方，请稍候')
                            : searchKeyword
                              ? t('没有找到与搜索关键词匹配的重复文件组')
                              : activeStrategyFilter !== 'all' && duplicateGroups.length > 0
                                ? t(
                                    '其他策略分类中发现了 {count} 个待处理组，点击下方按钮可查看全部',
                                    { count: duplicateGroups.length }
                                  )
                                : t('当前工作区文件非常整洁，无冗余副本或多余碎片')}
                        </div>
                        {activeStrategyFilter !== 'all' && duplicateGroups.length > 0 && (
                          <div className="pt-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setActiveStrategyFilter('all')}
                              className="text-xs gap-1.5 rounded-lg border-primary/40 text-primary hover:bg-primary/10"
                            >
                              <MaterialIcon icon="dashboard" className="text-sm" />
                              <span>
                                {t('查看全部 {count} 个发现结果', {
                                  count: duplicateGroups.length
                                })}
                              </span>
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ) : (
                  <DuplicateVirtualList
                    groups={filteredGroups}
                    fileMetaMap={fileMetaMap}
                    previewingPath={previewingPath}
                    trashingGroupId={trashingGroupId}
                    isTrashing={isTrashing}
                    formatBytes={formatBytes}
                    getFileThumbnailUrl={getFileThumbnailUrl}
                    onToggleFileSelection={handleToggleFileSelection}
                    onSelectFileForPreview={handleSelectFileForPreview}
                    onContextMenu={handleContextMenu}
                    onToggleGroupAction={handleToggleGroupAction}
                    onExecuteGroupAction={handleExecuteGroupAction}
                  />
                )}
                {/* 隐藏的批量处理执行触发挂载点（供顶部统一操作栏触发） */}
                <button
                  id="btn-trash-duplicates-trigger"
                  type="button"
                  onClick={handleExecuteBatchProcessAll}
                  disabled={isTrashing || isBatchProcessing || totalSelectedCount === 0}
                  className="hidden"
                  aria-hidden="true"
                />
              </div>
            )
          },
          // ─── 3. 右栏：文件预览面板 ──────────────────────────────
          {
            id: 'duplicate-preview',
            type: 'pixel',
            defaultSize: 360,
            minSize: 260,
            content: (
              <div className="h-full flex flex-col overflow-hidden bg-card/40 border-l border-border/60">
                <SplitPreviewPanel pageId={PAGE_IDS.ORGANIZE} />
              </div>
            )
          }
        ]}
      />

      {/* 4. 文件右键菜单 (对齐 FileList 组件) */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* 5. 二次确认安全弹窗 (根据勾选项目类型智能适配准确描述) */}
      <DuplicateConfirmDialog
        open={isDestructiveConfirmOpen}
        onOpenChange={setIsDestructiveConfirmOpen}
        confirmDialogConfig={confirmDialogConfig}
        selectedActionSummary={selectedActionSummary}
        onConfirm={executeBatchProcessConfirmed}
      />
    </div>
  )
}
