/**
 * 批量去重虚拟列表：组头行（R-25 / W5-C）
 *
 * 自 BatchDuplicateView 原组卡片头部原样抽取：策略徽章 + 专属指标 + 组快捷操作。
 * React.memo 隔离：仅当本组数据 / 极值 / 处理态变化时重渲染。
 */
import React, { memo } from 'react'
import { MaterialIcon, cn } from '../../../../../lib/utils'
import { t } from '@app/languages'
import { Button } from '../../../../ui/button'
import { Badge } from '../../../../ui/badge'
import { DuplicateGroup } from '@firefly/types'
import { GroupExtremes } from './virtual-rows'

export interface DuplicateGroupHeaderRowProps {
  group: DuplicateGroup
  groupIndex: number
  extremes: GroupExtremes
  isTrashing: boolean
  trashingGroupId: string | null
  onToggleGroupAction: (
    targetGroup: DuplicateGroup,
    action: 'keep_all' | 'trash_all' | 'invert'
  ) => void
  onExecuteGroupAction: (group: DuplicateGroup, gIdx: number) => void
}

export const DuplicateGroupHeaderRow = memo(function DuplicateGroupHeaderRow({
  group,
  groupIndex,
  extremes,
  isTrashing,
  trashingGroupId,
  onToggleGroupAction,
  onExecuteGroupAction
}: DuplicateGroupHeaderRowProps) {
  const groupSelectedCount = extremes.selectedCount
  const isTrashingThisGroup = trashingGroupId === (group.groupId || String(groupIndex))

  return (
    <div className="flex items-center justify-between flex-wrap gap-2 pb-2.5 border-b border-border/40">
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant="secondary" className="font-bold text-xs gap-1.5 px-2.5 py-1 rounded-lg">
          <MaterialIcon
            icon={
              group.strategy === 'invalid_symlinks' ||
              group.strategy === 'broken_files' ||
              group.strategy === 'bad_extensions' ||
              group.strategy === 'bad_names'
                ? 'error_outline'
                : 'hub'
            }
            className={cn(
              'text-xs',
              group.strategy === 'invalid_symlinks' ||
                group.strategy === 'broken_files' ||
                group.strategy === 'bad_extensions' ||
                group.strategy === 'bad_names'
                ? 'text-amber-500'
                : 'text-primary'
            )}
          />
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
          {/* 专属指标徽章 (根据策略动态呈现贴切文案：相似度、置信度、可优化度等) */}
          {(() => {
            const strat = group.strategy
            const percent = Math.round(group.similarityPercentage || 100)

            if (strat === 'exact_hash') {
              return (
                <span className="text-xs text-emerald-600 dark:text-emerald-400 font-mono font-bold px-2 py-0.5 rounded-md bg-emerald-500/10 border border-emerald-500/20">
                  {t('精确一致 100%')}
                </span>
              )
            }
            if (strat === 'broken_files') {
              return (
                <span className="text-xs text-destructive font-mono font-bold px-2 py-0.5 rounded-md bg-destructive/10 border border-destructive/20">
                  {t('损坏置信度 100%')}
                </span>
              )
            }
            if (strat === 'invalid_symlinks') {
              return (
                <span className="text-xs text-amber-600 dark:text-amber-400 font-mono font-bold px-2 py-0.5 rounded-md bg-amber-500/10 border border-amber-500/20">
                  {t('断裂失效 100%')}
                </span>
              )
            }
            if (strat === 'bad_extensions') {
              return (
                <span className="text-xs text-indigo-600 dark:text-indigo-400 font-mono font-bold px-2 py-0.5 rounded-md bg-indigo-500/10 border border-indigo-500/20">
                  {t('格式置信度 100%')}
                </span>
              )
            }
            if (strat === 'bad_names') {
              return (
                <span className="text-xs text-amber-600 dark:text-amber-400 font-mono font-bold px-2 py-0.5 rounded-md bg-amber-500/10 border border-amber-500/20">
                  {t('命名合规度 100%')}
                </span>
              )
            }
            if (strat === 'video_optimizer') {
              return (
                <span className="text-xs text-primary font-mono font-bold px-2 py-0.5 rounded-md bg-primary/10 border border-primary/20">
                  {t('优化空间 {percent}%', { percent })}
                </span>
              )
            }
            if (strat === 'exif_remover') {
              return (
                <span className="text-xs text-emerald-600 dark:text-emerald-400 font-mono font-bold px-2 py-0.5 rounded-md bg-emerald-500/10 border border-emerald-500/20">
                  {t('隐私敏感度 100%')}
                </span>
              )
            }
            if (strat === 'empty_files') {
              return (
                <span className="text-xs text-muted-foreground font-mono font-bold px-2 py-0.5 rounded-md bg-muted/60 border border-border/40">
                  {t('0 字节空文件')}
                </span>
              )
            }
            if (strat === 'empty_folders') {
              return (
                <span className="text-xs text-muted-foreground font-mono font-bold px-2 py-0.5 rounded-md bg-muted/60 border border-border/40">
                  {t('空文件夹')}
                </span>
              )
            }
            if (strat === 'temporary_files') {
              return (
                <span className="text-xs text-muted-foreground font-mono font-bold px-2 py-0.5 rounded-md bg-muted/60 border border-border/40">
                  {t('临时缓存')}
                </span>
              )
            }
            if (strat === 'big_files') {
              return (
                <span className="text-xs text-amber-600 dark:text-amber-400 font-mono font-bold px-2 py-0.5 rounded-md bg-amber-500/10 border border-amber-500/20">
                  {t('大文件排序')}
                </span>
              )
            }

            // 默认多模态查重（图片、音乐、视频、文档相似度）
            return (
              <span className="text-xs text-emerald-600 dark:text-emerald-400 font-mono font-bold px-2 py-0.5 rounded-md bg-emerald-500/10 border border-emerald-500/20">
                {t('相似度 {percent}%', { percent })}
              </span>
            )
          })()}
        </Badge>
      </div>

      <div className="flex items-center gap-2 flex-wrap ml-auto justify-end">
        {/* 组快捷操作按钮 */}
        <div className="flex items-center gap-1 bg-muted/40 p-0.5 rounded-lg border border-border/40">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onToggleGroupAction(group, 'keep_all')}
            className="h-6 px-2 text-[11px] text-muted-foreground hover:text-emerald-600 rounded-md cursor-pointer font-medium"
            title={t('本组全部保留')}
          >
            {t('全保留')}
          </Button>
          <span className="text-border text-xs">|</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onToggleGroupAction(group, 'invert')}
            className="h-6 px-2 text-[11px] text-muted-foreground hover:text-primary rounded-md cursor-pointer font-medium"
            title={t('反选本组状态')}
          >
            {t('反选')}
          </Button>
        </div>

        {/* 本组专属：执行操作按钮 (针对特殊策略显示 优化/清理/更名/修正，普通查重显示 删除) */}
        {(() => {
          const isVideoOpt = group.strategy === 'video_optimizer'
          const isExif = group.strategy === 'exif_remover'
          const isBadNames = group.strategy === 'bad_names'
          const isBadExt = group.strategy === 'bad_extensions'

          let actionLabel = t('删除')
          let actionIcon = 'delete'
          let actionVariantClass =
            'border-destructive/30 text-destructive hover:bg-destructive hover:text-destructive-foreground'

          if (isVideoOpt) {
            actionLabel = t('优化')
            actionIcon = 'auto_fix_high'
            actionVariantClass =
              'border-primary/30 text-primary hover:bg-primary hover:text-primary-foreground'
          } else if (isExif) {
            actionLabel = t('清理')
            actionIcon = 'cleaning_services'
            actionVariantClass =
              'border-emerald-500/30 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-600 hover:text-white'
          } else if (isBadNames) {
            actionLabel = t('更名')
            actionIcon = 'drive_file_rename_outline'
            actionVariantClass =
              'border-amber-500/30 text-amber-600 dark:text-amber-400 hover:bg-amber-600 hover:text-white'
          } else if (isBadExt) {
            actionLabel = t('修正')
            actionIcon = 'build'
            actionVariantClass =
              'border-indigo-500/30 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-600 hover:text-white'
          }

          const countText =
            groupSelectedCount > 0 ? `${actionLabel} (${groupSelectedCount})` : actionLabel

          return (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => onExecuteGroupAction(group, groupIndex)}
              disabled={isTrashingThisGroup || isTrashing || groupSelectedCount === 0}
              className={cn(
                'h-6.5 px-2.5 text-xs font-bold gap-1 rounded-lg transition-all cursor-pointer shadow-2xs',
                actionVariantClass
              )}
              title={t('对本组选中的文件执行{action}', {
                action: actionLabel
              })}
            >
              <MaterialIcon
                icon={isTrashingThisGroup ? 'sync' : actionIcon}
                className={cn('text-xs', isTrashingThisGroup && 'animate-spin')}
              />
              <span>{isTrashingThisGroup ? t('处理中...') : countText}</span>
            </Button>
          )
        })()}
      </div>
    </div>
  )
})
