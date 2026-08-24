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
  const [duplicateGroups, setDuplicateGroups] = useState<DuplicateGroup[]>([])
  const [isScanning, setIsScanning] = useState(false)
  const [activeStrategyFilter, setActiveStrategyFilter] = useState<string>('all')
  const [checkVideo, setCheckVideo] = useState(false)
  const [recommendRule, setRecommendRule] = useState<RecommendRule>('highest_resolution')

  // 格式化文件大小
  const formatBytes = (bytes: number): string => {
    if (!bytes || bytes <= 0) return '0 B'
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
    return `${bytes} B`
  }

  // 执行双轨扫描
  const handleScan = async () => {
    setIsScanning(true)
    try {
      if (window.electronAPI?.organizeBatch?.scanDuplicates) {
        const fileIds = files.map(f => f.id).filter(Boolean)
        const groups = await window.electronAPI.organizeBatch.scanDuplicates({
          workspaceDirectoryPath,
          fileIds: fileIds.length > 0 ? fileIds : undefined,
          minSimilarity: 85,
          strategies: [
            'exact_hash',
            'image_phash',
            'text_simhash',
            'filename_heuristic',
            ...(checkVideo ? (['video_keyframes'] as DuplicateDetectionStrategy[]) : [])
          ]
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
  }, [workspaceDirectoryPath, files.length, checkVideo])

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
      <div className="w-72 border-r border-border/60 flex flex-col bg-muted/10 shrink-0">
        <div className="p-4 border-b border-border/50 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
              <MaterialIcon icon="analytics" className="text-sm text-primary" />
              {t('查重分析统计')}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={handleScan}
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
              <div className="text-[10px] text-muted-foreground">{t('发现重复组')}</div>
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

          {/* 视频查重选项 */}
          <div className="flex items-center space-x-2 pt-1">
            <Checkbox
              id="check_video_opt"
              checked={checkVideo}
              onCheckedChange={val => setCheckVideo(Boolean(val))}
            />
            <label
              htmlFor="check_video_opt"
              className="text-xs text-foreground cursor-pointer select-none flex items-center gap-1"
            >
              <span>{t('开启视频深度查重')}</span>
              <Badge variant="outline" className="text-[9px] px-1 py-0 h-3.5 text-amber-600">
                {t('耗时较长')}
              </Badge>
            </label>
          </div>
        </div>

        {/* 策略分类筛选 */}
        <div className="p-3 border-b border-border/40 text-xs font-semibold text-muted-foreground">
          {t('查重策略分类')}
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {[
            { key: 'all', label: t('全部发现'), icon: 'list_alt' },
            { key: 'exact_hash', label: t('100% 精确一致'), icon: 'fingerprint' },
            { key: 'image_phash', label: t('视觉相似图片'), icon: 'image' },
            { key: 'text_simhash', label: t('文本语义相似'), icon: 'article' },
            { key: 'filename_heuristic', label: t('文件名副本衍生'), icon: 'copy_all' },
            { key: 'audio_match', label: t('音频相似'), icon: 'audiotrack' },
            { key: 'video_keyframes', label: t('视频关键帧'), icon: 'videocam' }
          ].map(strat => {
            const count =
              strat.key === 'all'
                ? duplicateGroups.length
                : duplicateGroups.filter(g => g.strategy === strat.key).length

            const isActive = activeStrategyFilter === strat.key

            return (
              <button
                key={strat.key}
                type="button"
                onClick={() => setActiveStrategyFilter(strat.key)}
                className={cn(
                  'w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs font-medium transition-all duration-150',
                  isActive
                    ? 'bg-primary/10 text-primary border border-primary/30 font-semibold'
                    : 'text-muted-foreground hover:bg-muted/30 hover:text-foreground border border-transparent'
                )}
              >
                <div className="flex items-center gap-2">
                  <MaterialIcon icon={strat.icon} className="text-sm" />
                  <span>{strat.label}</span>
                </div>
                <Badge variant={isActive ? 'default' : 'secondary'} className="text-[10px] px-1.5 py-0 h-4">
                  {count}
                </Badge>
              </button>
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
                          : group.strategy === 'text_simhash'
                            ? t('文档语义相似')
                            : t('副本衍生文件')}
                    </Badge>
                    <span className="text-xs font-semibold text-foreground">
                      {group.description}
                    </span>
                  </div>
                  <span className="text-xs text-emerald-600 dark:text-emerald-400 font-mono font-medium">
                    {t('相似度 {percent}%', { percent: Math.round(group.similarityPercentage) })}
                  </span>
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
