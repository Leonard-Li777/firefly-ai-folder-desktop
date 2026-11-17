import React from 'react'
import { t } from '@app/languages'
import { MaterialIcon, cn } from '../../../../../lib/utils'
import { Button } from '../../../../ui/button'
import { Input } from '../../../../ui/input'
import { Badge } from '../../../../ui/badge'
import { TagPill } from './TagPill'
import { getTagPillKey, isMutexSingleGroup } from './dimension-utils'
import type { DimensionGroupCardProps } from './types'

/**
 * 单个维度分组卡片组件 (React.memo)
 * 仅在其自身标签、三态状态或被聚焦文件命中的标签变化时重绘，避免全量维度树重绘
 */
export const DimensionGroupCard: React.FC<DimensionGroupCardProps> = React.memo(
  ({
    group,
    isPan,
    groupNewTags,
    isInputActive,
    isInspecting,
    inputVal,
    tagStates,
    tagFileCounts,
    totalFilesCount,
    inspectedTagSet,
    hasInspected,
    onToggleTag,
    onDeleteExistingTag,
    onBatchSetTags,
    onStartAddNewTag,
    onCancelAddNewTag,
    onInputChange,
    onSubmitAddNewTag,
    onRemoveNewTag
  }) => {
    const groupTags = group.tags || []
    const groupNameLower = group.name.trim().toLowerCase()

    return (
      <div className="space-y-3 p-4 rounded-2xl bg-card/60 border border-border/50 shadow-2xs hover:border-border/80 transition-colors">
        {/* 维度头部与快捷全选 */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs font-bold text-foreground/90">{group.name}</span>
            <Badge
              variant="outline"
              className="text-[10px] h-4.5 px-1.5 font-normal bg-background/80"
            >
              {t('{count} 个标签', {
                count: groupTags.length + groupNewTags.length
              })}
            </Badge>
            {isPan && (
              <Badge
                variant="secondary"
                className="text-[9px] px-1 py-0 h-4 bg-primary/10 text-primary border border-primary/20 font-medium"
              >
                {t('泛维度')}
              </Badge>
            )}
          </div>

          {/* 维度快捷操作 */}
          {groupTags.length > 0 && (
            <div className="flex items-center gap-1 opacity-80 hover:opacity-100 transition-opacity">
              {/* D-02：单选/unknown 维度不渲染「全附」按钮，改为不可点纯文本提示。
                  不用 disabled 按钮——它仍是可聚焦的死控件，读屏会念成「按不动的按钮」。 */}
              {isMutexSingleGroup(group) ? (
                <span
                  className="text-[11px] text-muted-foreground/70 px-1.5 py-0.5 select-none"
                  title={t('该维度为单选维度，一次只能附加一个标签')}
                >
                  {t('选一个')}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => onBatchSetTags(group, 'add_all')}
                  className="text-[11px] text-muted-foreground hover:text-emerald-600 dark:hover:text-emerald-400 px-1.5 py-0.5 rounded-md hover:bg-emerald-500/10 transition-colors cursor-pointer"
                  title={t('全部附加该维度下的所有标签')}
                >
                  {t('全附')}
                </button>
              )}
              <span className="text-muted-foreground/30 text-xs">|</span>
              <button
                type="button"
                onClick={() => onBatchSetTags(group, 'initial')}
                className="text-[11px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded-md hover:bg-muted transition-colors cursor-pointer"
                title={t('恢复该维度默认状态')}
              >
                {t('恢复')}
              </button>
            </div>
          )}
        </div>

        {/* 标签流动排布 */}
        <div className="flex flex-wrap gap-2 items-center">
          {/* 仅泛维度允许新建标签 */}
          {isPan &&
            (isInputActive ? (
              <div className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-background rounded-xl border border-primary/60 shadow-xs animate-in zoom-in-95 duration-150">
                <Input
                  autoFocus
                  disabled={isInspecting}
                  value={inputVal}
                  onChange={e => onInputChange(e.target.value)}
                  onBlur={() => {
                    if (inputVal.trim() && !isInspecting) {
                      onSubmitAddNewTag(group.id)
                    }
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !isInspecting) onSubmitAddNewTag(group.id)
                    if (e.key === 'Escape' && !isInspecting) {
                      onCancelAddNewTag()
                    }
                  }}
                  placeholder={t('输入新标签名...')}
                  className="h-5.5 text-xs w-28 border-0 bg-transparent p-0 focus-visible:ring-0"
                />
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={isInspecting}
                  className="h-5.5 w-5.5 text-primary hover:text-primary hover:bg-primary/10 rounded-md cursor-pointer"
                  onClick={() => !isInspecting && onSubmitAddNewTag(group.id)}
                >
                  {isInspecting ? (
                    <MaterialIcon icon="sync" className="text-xs animate-spin" />
                  ) : (
                    <MaterialIcon icon="check" className="text-xs" />
                  )}
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={isInspecting}
                  className="h-5.5 w-5.5 text-muted-foreground hover:text-foreground rounded-md cursor-pointer"
                  onClick={onCancelAddNewTag}
                >
                  <MaterialIcon icon="close" className="text-xs" />
                </Button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => onStartAddNewTag(group.id)}
                className={cn(
                  'inline-flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs font-semibold',
                  'border border-dashed border-primary/50 hover:border-primary text-primary hover:bg-primary/10',
                  'transition-all duration-200 cursor-pointer shadow-2xs'
                )}
              >
                <MaterialIcon icon="add" className="text-xs" />
                <span>{t('新建标签')}</span>
              </button>
            ))}

          {/* 新建标签徽章 */}
          {groupNewTags.map((name, nIdx) => (
            <span
              key={nIdx}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-emerald-500/15 border border-emerald-500/40 text-emerald-600 dark:text-emerald-400 shadow-2xs animate-in zoom-in-95 duration-150"
            >
              <MaterialIcon icon="add_circle" className="text-xs" />
              <span>{name}</span>
              <Badge
                variant="secondary"
                className="text-[9px] px-1 py-0 h-3.5 bg-emerald-500/20 text-emerald-600 dark:text-emerald-300 font-normal"
              >
                {t('待附加')}
              </Badge>
              <MaterialIcon
                icon="close"
                onClick={() => onRemoveNewTag(group.id, name)}
                className="text-xs cursor-pointer hover:text-destructive transition-colors ml-0.5"
              />
            </span>
          ))}

          {/* 已有标签列表 - 使用 React.memo 的 TagPill 极大提升交互性能 */}
          {groupTags.map((tag: DimensionTag, tagIndex: number) => {
            const tagKey = `${group.id}::${tag.tagValue}`
            const count = tagFileCounts[tag.tagValue] || 0
            const state = tagStates[tagKey] || 'initial'

            const isOwnedByInspected = hasInspected
              ? inspectedTagSet.has(tag.tagValue.trim().toLowerCase()) ||
                inspectedTagSet.has(`${group.id}::${tag.tagValue.trim().toLowerCase()}`) ||
                inspectedTagSet.has(`${groupNameLower}::${tag.tagValue.trim().toLowerCase()}`)
              : false

            return (
              <TagPill
                key={getTagPillKey(group.id, tag, tagIndex)}
                dimId={group.id}
                tagName={tag.tagValue}
                tagKey={tagKey}
                count={count}
                totalFilesCount={totalFilesCount}
                state={state}
                isOwnedByInspected={isOwnedByInspected}
                isPan={isPan}
                onToggle={onToggleTag}
                onDelete={onDeleteExistingTag}
              />
            )
          })}
        </div>
      </div>
    )
  }
)

DimensionGroupCard.displayName = 'DimensionGroupCard'
