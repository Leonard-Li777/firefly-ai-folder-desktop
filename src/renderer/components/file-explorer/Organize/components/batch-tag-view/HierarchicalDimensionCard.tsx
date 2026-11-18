import type { DimensionTag } from '@firefly/types'
import React from 'react'
import { t } from '@app/languages'
import { MaterialIcon, cn } from '../../../../../lib/utils'
import { Badge } from '../../../../ui/badge'
import { TagPill } from './TagPill'
import { getTagPillKey, isMutexSingleGroup } from './dimension-utils'
import type { HierarchicalDimensionCardProps } from './types'

/**
 * 分类维度树形层级嵌套卡片组件 (React.memo)
 * 根维度卡片 -> 直属标签 -> 树形引导线 -> 子维度分组卡片 (如安全等级、处理状态)
 * 支持平滑折叠/展开、直属标签与子维度独立批量全附/恢复、命中高亮徽章
 */
export const HierarchicalDimensionCard: React.FC<HierarchicalDimensionCardProps> = React.memo(
  ({
    item,
    isExpanded,
    onToggleExpand,
    tagStates,
    tagFileCounts,
    totalFilesCount,
    inspectedTagSet,
    hasInspected,
    onToggleTag,
    onBatchSetTags
  }) => {
    const { root, children, hasActiveFileHits } = item
    const rootKey = root.code || `dim_${root.id}`
    const rootTags = root.tags || []
    const rootNameLower = root.name.trim().toLowerCase()

    // 根据维度特征选择代表性图标
    const getDimensionIcon = (code?: string, name?: string) => {
      if (code?.includes('file_purpose') || name?.includes('用途')) return 'folder_shared'
      if (code?.includes('file_source') || name?.includes('来源')) return 'cloud_download'
      if (code?.includes('document_quality') || name?.includes('质量')) return 'verified'
      if (code?.includes('geographical') || name?.includes('地理')) return 'place'
      if (code?.includes('financial') || name?.includes('财务')) return 'payments'
      if (code?.includes('travel') || name?.includes('旅行')) return 'flight'
      if (code?.includes('publication') || name?.includes('出版')) return 'auto_stories'
      if (code?.includes('family') || name?.includes('家庭')) return 'family_restroom'
      if (code?.includes('game') || name?.includes('游戏')) return 'sports_esports'
      if (code?.includes('music') || name?.includes('音乐')) return 'music_note'
      return 'category'
    }

    return (
      <div className="rounded-2xl border border-border/60 bg-card/70 overflow-hidden shadow-2xs hover:border-border/90 transition-all duration-150">
        {/* 根维度卡片头部：点击整栏切换展开/折叠 */}
        <div
          onClick={() => onToggleExpand(rootKey)}
          className={cn(
            'flex items-center justify-between gap-2 px-4 py-3 cursor-pointer select-none',
            'hover:bg-muted/30 transition-colors',
            isExpanded ? 'bg-muted/15 border-b border-border/40' : ''
          )}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            {/* 展开/折叠箭头 */}
            <MaterialIcon
              icon="expand_more"
              className={cn(
                'text-sm text-muted-foreground transition-transform duration-200 shrink-0',
                !isExpanded && '-rotate-90'
              )}
            />

            {/* 根维度图标 */}
            <div className="w-5 h-5 rounded-md bg-primary/10 text-primary flex items-center justify-center shrink-0">
              <MaterialIcon icon={getDimensionIcon(root.code, root.name)} className="text-xs" />
            </div>

            {/* 根维度名称 */}
            <span className="text-xs font-bold text-foreground truncate">{root.name}</span>

            {/* 直属标签数徽章 */}
            {rootTags.length > 0 && (
              <Badge
                variant="outline"
                className="text-[10px] h-4.5 px-1.5 font-normal bg-background/80 shrink-0"
              >
                {t('{count} 个直属标签', { count: rootTags.length })}
              </Badge>
            )}

            {/* 子维度数量徽章 */}
            {children.length > 0 && (
              <Badge
                variant="secondary"
                className="text-[10px] h-4.5 px-1.5 font-medium bg-primary/10 text-primary border border-primary/20 shrink-0"
              >
                {t('{count} 个子维度', { count: children.length })}
              </Badge>
            )}

            {/* 待整理文件命中提示 */}
            {hasActiveFileHits && (
              <span className="inline-flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400 font-medium shrink-0">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                {t('已命中')}
              </span>
            )}
          </div>

          {/* 快捷全选操作与展开折叠切换 */}
          <div className="flex items-center gap-2 shrink-0" onClick={e => e.stopPropagation()}>
            {rootTags.length > 0 && (
              <div className="flex items-center gap-1 opacity-80 hover:opacity-100 transition-opacity">
                {/* D-02：单选/unknown 维度不渲染「全附」按钮，改为不可点纯文本提示 */}
                {isMutexSingleGroup(root) ? (
                  <span
                    className="text-[11px] text-muted-foreground/70 px-1.5 py-0.5 select-none"
                    title={t('该维度为单选维度，一次只能附加一个标签')}
                  >
                    {t('选一个')}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => onBatchSetTags(root, 'add_all')}
                    className="text-[11px] text-muted-foreground hover:text-emerald-600 dark:hover:text-emerald-400 px-1.5 py-0.5 rounded-md hover:bg-emerald-500/10 transition-colors cursor-pointer"
                    title={t('全部附加该维度直属标签')}
                  >
                    {t('全附')}
                  </button>
                )}
                <span className="text-muted-foreground/30 text-xs">|</span>
                <button
                  type="button"
                  onClick={() => onBatchSetTags(root, 'initial')}
                  className="text-[11px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded-md hover:bg-muted transition-colors cursor-pointer"
                  title={t('恢复该维度默认状态')}
                >
                  {t('恢复')}
                </button>
              </div>
            )}
            <button
              type="button"
              onClick={() => onToggleExpand(rootKey)}
              className="text-muted-foreground hover:text-foreground text-xs p-1 rounded-md hover:bg-muted transition-colors cursor-pointer"
              title={isExpanded ? t('折叠') : t('展开')}
            >
              <MaterialIcon icon={isExpanded ? 'unfold_less' : 'unfold_more'} className="text-xs" />
            </button>
          </div>
        </div>

        {/* 展开内容区域 */}
        {isExpanded && (
          <div className="p-4 pt-3 space-y-4">
            {/* 1. 根维度直属标签区 */}
            {rootTags.length > 0 && (
              <div className="space-y-2">
                {children.length > 0 && (
                  <div className="text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-wider flex items-center gap-1">
                    <MaterialIcon icon="label_outline" className="text-xs" />
                    <span>{t('直属标签')}</span>
                  </div>
                )}
                <div className="flex flex-wrap gap-2 items-center">
                  {rootTags.map((tag: DimensionTag, tagIndex: number) => {
                    const tagKey = `${root.id}::${tag.tagValue}`
                    const count = tagFileCounts[tag.tagValue] || 0
                    const state = tagStates[tagKey] || 'initial'
                    const isOwnedByInspected = hasInspected
                      ? inspectedTagSet.has(tag.tagValue.trim().toLowerCase()) ||
                        inspectedTagSet.has(`${root.id}::${tag.tagValue.trim().toLowerCase()}`) ||
                        inspectedTagSet.has(
                          `${rootNameLower}::${tag.tagValue.trim().toLowerCase()}`
                        )
                      : false

                    return (
                      <TagPill
                        key={getTagPillKey(root.id, tag, tagIndex)}
                        dimId={root.id}
                        tagName={tag.tagValue}
                        tagKey={tagKey}
                        count={count}
                        totalFilesCount={totalFilesCount}
                        state={state}
                        isOwnedByInspected={isOwnedByInspected}
                        isPan={false}
                        onToggle={onToggleTag}
                      />
                    )
                  })}
                </div>
              </div>
            )}

            {/* 2. 子维度树形嵌套分组区 */}
            {children.length > 0 && (
              <div
                className={cn(
                  'space-y-3',
                  rootTags.length > 0 ? 'pt-3 border-t border-border/40' : ''
                )}
              >
                <div className="text-[11px] font-semibold text-muted-foreground flex items-center gap-1.5 px-0.5">
                  <MaterialIcon
                    icon="subdirectory_arrow_right"
                    className="text-xs text-primary/70"
                  />
                  <span>{t('子维度 ({count})', { count: children.length })}</span>
                </div>

                <div className="space-y-2.5 pl-2 sm:pl-3 border-l-2 border-primary/20">
                  {children.map(subGroup => {
                    const subTags = subGroup.tags || []
                    const subNameLower = subGroup.name.trim().toLowerCase()

                    return (
                      <div
                        key={subGroup.id}
                        className="p-3 rounded-xl bg-muted/25 border border-border/40 hover:border-border/70 transition-colors space-y-2.5"
                      >
                        {/* 子维度头部 */}
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="text-xs font-semibold text-foreground/90">
                              {subGroup.name}
                            </span>
                            <Badge
                              variant="outline"
                              className="text-[9px] h-4 px-1 font-normal bg-background/80"
                            >
                              {subTags.length}
                            </Badge>
                          </div>

                          {subTags.length > 0 && (
                            <div className="flex items-center gap-1 opacity-80 hover:opacity-100 transition-opacity">
                              {/* D-02：单选/unknown 维度不渲染「全附」按钮，改为不可点纯文本提示 */}
                              {isMutexSingleGroup(subGroup) ? (
                                <span
                                  className="text-[10px] text-muted-foreground/70 px-1 py-0.5 select-none"
                                  title={t('该维度为单选维度，一次只能附加一个标签')}
                                >
                                  {t('选一个')}
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => onBatchSetTags(subGroup, 'add_all')}
                                  className="text-[10px] text-muted-foreground hover:text-emerald-600 dark:hover:text-emerald-400 px-1 py-0.5 rounded hover:bg-emerald-500/10 transition-colors cursor-pointer"
                                  title={t('全部附加该子维度标签')}
                                >
                                  {t('全附')}
                                </button>
                              )}
                              <span className="text-muted-foreground/30 text-xs">|</span>
                              <button
                                type="button"
                                onClick={() => onBatchSetTags(subGroup, 'initial')}
                                className="text-[10px] text-muted-foreground hover:text-foreground px-1 py-0.5 rounded hover:bg-muted transition-colors cursor-pointer"
                                title={t('恢复该子维度默认状态')}
                              >
                                {t('恢复')}
                              </button>
                            </div>
                          )}
                        </div>

                        {/* 子维度标签排布 */}
                        <div className="flex flex-wrap gap-1.5 items-center">
                          {subTags.map((tag: DimensionTag, subTagIdx: number) => {
                            const tagKey = `${subGroup.id}::${tag.tagValue}`
                            const count = tagFileCounts[tag.tagValue] || 0
                            const state = tagStates[tagKey] || 'initial'
                            const isOwnedByInspected = hasInspected
                              ? inspectedTagSet.has(tag.tagValue.trim().toLowerCase()) ||
                                inspectedTagSet.has(
                                  `${subGroup.id}::${tag.tagValue.trim().toLowerCase()}`
                                ) ||
                                inspectedTagSet.has(
                                  `${subNameLower}::${tag.tagValue.trim().toLowerCase()}`
                                )
                              : false

                            return (
                              <TagPill
                                key={getTagPillKey(subGroup.id, tag, subTagIdx)}
                                dimId={subGroup.id}
                                tagName={tag.tagValue}
                                tagKey={tagKey}
                                count={count}
                                totalFilesCount={totalFilesCount}
                                state={state}
                                isOwnedByInspected={isOwnedByInspected}
                                isPan={false}
                                onToggle={onToggleTag}
                              />
                            )
                          })}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }
)

HierarchicalDimensionCard.displayName = 'HierarchicalDimensionCard'
