import React from 'react'
import { t } from '@app/languages'
import { MaterialIcon, cn } from '../../../../../lib/utils'
import { Button } from '../../../../ui/button'
import { Input } from '../../../../ui/input'
import { Badge } from '../../../../ui/badge'
import { BatchRenamePreviewItem } from '@firefly/types'
import {
  BatchRenamePreviewStats,
  MAX_PREVIEW_ITEMS,
  RenameFilterTab,
  getSegmentColorClass,
  isItemChanged
} from '../useBatchRenameDerived'

/**
 * 结构化色彩渲染新文件名组件（根据 DSL 变量分组语义分段高亮）
 */
const RenderedFilename: React.FC<{
  segments?: Array<{ text: string; type: string }>
  fallbackName: string
  isChanged: boolean
}> = ({ segments, fallbackName, isChanged }) => {
  if (segments && segments.length > 0) {
    return (
      <span className="inline-flex items-center flex-wrap font-sans">
        {segments.map((seg, sIdx) => {
          if (!seg.text) return null
          return (
            <span key={sIdx} className={getSegmentColorClass(seg.type)}>
              {seg.text}
            </span>
          )
        })}
      </span>
    )
  }

  return (
    <span
      className={cn(
        'font-semibold font-sans',
        isChanged ? 'text-primary' : 'text-muted-foreground'
      )}
    >
      {fallbackName}
    </span>
  )
}

interface BatchRenamePreviewPaneProps {
  filteredPreviewList: BatchRenamePreviewItem[]
  displayedPreviewList: BatchRenamePreviewItem[]
  previewStats: BatchRenamePreviewStats
  isLoadingPreview: boolean
  rightViewMode: 'card' | 'table'
  onRightViewModeChange: (mode: 'card' | 'table') => void
  filterTab: RenameFilterTab
  onFilterTabChange: (tab: RenameFilterTab) => void
  previewSearch: string
  onPreviewSearchChange: (kw: string) => void
  isExecuting: boolean
  hasPreviewItems: boolean
  onExecuteRename: () => void
}

/**
 * 批量重命名右栏：实时更名效果对照与差异高亮面板
 */
export const BatchRenamePreviewPane: React.FC<BatchRenamePreviewPaneProps> = ({
  filteredPreviewList,
  displayedPreviewList,
  previewStats,
  isLoadingPreview,
  rightViewMode,
  onRightViewModeChange,
  filterTab,
  onFilterTabChange,
  previewSearch,
  onPreviewSearchChange,
  isExecuting,
  hasPreviewItems,
  onExecuteRename
}) => {
  return (
    <div className="h-full flex flex-col bg-background overflow-hidden">
      {/* 右栏顶部看板与搜索 */}
      <div className="p-3 border-b border-border/40 space-y-2.5 shrink-0 bg-background">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
              <MaterialIcon icon="preview" className="text-sm text-primary" />
              {t('更名效果实时对照')}
            </span>
            {filteredPreviewList.length > MAX_PREVIEW_ITEMS && (
              <span
                className="text-[10px] text-amber-600 dark:text-amber-400 font-mono bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.2 rounded-full"
                title={t('为保证性能，实时对照列表仅展示前 {max} 个文件（共 {total} 个）', {
                  max: MAX_PREVIEW_ITEMS,
                  total: filteredPreviewList.length
                })}
              >
                {t('仅展示前 {max} 项', { max: MAX_PREVIEW_ITEMS })}
              </span>
            )}
            {previewStats.total > 0 && (
              <span className="text-[10px] text-muted-foreground font-mono bg-muted/60 px-1.5 py-0.2 rounded-full">
                {t('变更率: {rate}%', { rate: previewStats.changeRate })}
              </span>
            )}
          </div>
          {isLoadingPreview ? (
            <span className="text-[11px] text-muted-foreground flex items-center gap-1">
              <MaterialIcon icon="sync" className="text-xs animate-spin" />
              {t('计算中...')}
            </span>
          ) : (
            <div className="flex items-center gap-1">
              <Button
                variant={rightViewMode === 'card' ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => onRightViewModeChange('card')}
                className="h-6 w-6 p-0 cursor-pointer"
                title={t('卡片对照视图')}
              >
                <MaterialIcon icon="view_agenda" className="text-xs" />
              </Button>
              <Button
                variant={rightViewMode === 'table' ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => onRightViewModeChange('table')}
                className="h-6 w-6 p-0 cursor-pointer"
                title={t('表格视图')}
              >
                <MaterialIcon icon="table_rows" className="text-xs" />
              </Button>
            </div>
          )}
        </div>

        {/* 状态统计 Filter Tabs 与搜索框 */}
        <div className="flex items-center justify-between gap-2 pt-1">
          <div className="flex items-center gap-1 bg-muted/30 p-0.5 rounded-md border border-border/40">
            <button
              type="button"
              onClick={() => onFilterTabChange('all')}
              className={cn(
                'px-2 py-0.5 rounded text-[11px] font-medium transition-colors cursor-pointer',
                filterTab === 'all'
                  ? 'bg-background text-foreground shadow-2xs font-semibold'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {t('全部 ({count})', { count: previewStats.total })}
            </button>
            <button
              type="button"
              onClick={() => onFilterTabChange('changed')}
              className={cn(
                'px-2 py-0.5 rounded text-[11px] font-medium transition-colors flex items-center gap-1 cursor-pointer',
                filterTab === 'changed'
                  ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 font-semibold'
                  : 'text-muted-foreground hover:text-emerald-600'
              )}
            >
              <span>{t('已变动')}</span>
              <span className="font-mono text-[10px]">({previewStats.changed})</span>
            </button>
            <button
              type="button"
              onClick={() => onFilterTabChange('unchanged')}
              className={cn(
                'px-2 py-0.5 rounded text-[11px] font-medium transition-colors flex items-center gap-1 cursor-pointer',
                filterTab === 'unchanged'
                  ? 'bg-background text-foreground shadow-2xs font-semibold'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <span>{t('未改变')}</span>
              <span className="font-mono text-[10px]">({previewStats.unchanged})</span>
            </button>
          </div>

          <div className="relative w-36">
            <Input
              value={previewSearch}
              onChange={e => onPreviewSearchChange(e.target.value)}
              placeholder={t('搜索文件名...')}
              className="h-6 text-[11px] pl-6 bg-background shadow-2xs border-border/40"
            />
            <MaterialIcon
              icon="search"
              className="absolute left-1.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground"
            />
          </div>
        </div>
      </div>

      {/* 实时更名对照内容列表（单线条细分隔线，轻量化极简风格，增加内边距与行间距） */}
      <div className="flex-1 overflow-y-auto">
        {displayedPreviewList.length === 0 ? (
          <div className="h-40 flex flex-col items-center justify-center text-xs text-muted-foreground gap-1.5">
            <MaterialIcon icon="folder_open" className="text-2xl text-muted-foreground/50" />
            <span>{t('没有符合筛选条件的待重命名文件')}</span>
          </div>
        ) : rightViewMode === 'card' ? (
          <div className="divide-y divide-border/30">
            {displayedPreviewList.map((item, idx) => {
              const isChanged = isItemChanged(item)
              const cleanSmartName = (item.rawSmartName || '').replace(/\.[a-zA-Z0-9]{1,10}$/i, '')
              return (
                <div
                  key={item.fileId || idx}
                  className={cn(
                    'py-3 px-3.5 hover:bg-muted/25 transition-colors text-xs space-y-1.5 text-left',
                    item.hasError && 'bg-destructive/5'
                  )}
                >
                  {/* 1. 原文件名 */}
                  <div className="flex items-center justify-between text-muted-foreground/60 text-[11px]">
                    <div className="flex items-center gap-1.5 truncate max-w-full font-sans">
                      <MaterialIcon
                        icon="insert_drive_file"
                        className="text-xs shrink-0 text-muted-foreground/60"
                      />
                      <span className="truncate" title={item.currentName}>
                        {item.currentName}
                      </span>
                    </div>
                    {item.hasError && (
                      <Badge variant="destructive" className="text-[10px] h-4 px-1.5 shrink-0 ml-2">
                        {t('异常')}
                      </Badge>
                    )}
                  </div>

                  {/* 2. 原始智能文件名（左对齐，纯文本，无背景色框，展示不带扩展名的 rawSmartName） */}
                  {cleanSmartName && (
                    <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground font-sans">
                      <MaterialIcon
                        icon="psychology"
                        className="text-xs text-primary/70 shrink-0"
                      />
                      <span className="truncate" title={cleanSmartName}>
                        {cleanSmartName}
                      </span>
                    </div>
                  )}

                  {/* 3. 拟更名新名称（左对齐，按变量标签分组色彩结构化渲染） */}
                  <div className="font-sans font-medium text-foreground text-xs break-all flex items-center gap-1.5 pt-1">
                    <MaterialIcon
                      icon="drive_file_rename_outline"
                      className={cn(
                        'text-sm shrink-0',
                        isChanged ? 'text-primary' : 'text-muted-foreground/60'
                      )}
                    />
                    <RenderedFilename
                      segments={item.segments}
                      fallbackName={item.newName}
                      isChanged={isChanged}
                    />
                  </div>

                  {item.hasError && (
                    <div className="text-[10px] text-destructive flex items-center gap-1 pt-1">
                      <MaterialIcon icon="error" className="text-xs" />
                      <span>{item.errorMessage}</span>
                    </div>
                  )}
                </div>
              )
            })}

            {/* 超出 200 项时的底部提示条 */}
            {filteredPreviewList.length > MAX_PREVIEW_ITEMS && (
              <div className="py-3 px-3.5 bg-muted/20 text-center text-xs text-muted-foreground flex items-center justify-center gap-1.5">
                <MaterialIcon icon="info" className="text-xs text-amber-500 shrink-0" />
                <span>
                  {t('为保证性能，实时对照列表仅展示前 {max} 个文件（共 {total} 个）', {
                    max: MAX_PREVIEW_ITEMS,
                    total: filteredPreviewList.length
                  })}
                </span>
              </div>
            )}
          </div>
        ) : (
          // 紧凑表格视图
          <div className="text-xs">
            <table className="w-full text-left border-collapse">
              <thead className="bg-muted/30 border-b border-border/40 text-[11px] text-muted-foreground">
                <tr>
                  <th className="p-2.5 font-medium">{t('原文件名')}</th>
                  <th className="p-2.5 font-medium">{t('原始智能文件名')}</th>
                  <th className="p-2.5 font-medium">{t('拟更名新名称')}</th>
                  <th className="p-2.5 font-medium w-16 text-right">{t('状态')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/30 font-mono text-[11px]">
                {displayedPreviewList.map((item, idx) => {
                  const isChanged = isItemChanged(item)
                  const cleanSmartName = (item.rawSmartName || '').replace(
                    /\.[a-zA-Z0-9]{1,10}$/i,
                    ''
                  )
                  return (
                    <tr key={item.fileId || idx} className="hover:bg-muted/20 transition-colors">
                      <td
                        className="p-2.5 truncate max-w-[120px] text-muted-foreground"
                        title={item.currentName}
                      >
                        {item.currentName}
                      </td>
                      <td
                        className="p-2.5 truncate max-w-[120px] text-muted-foreground font-sans"
                        title={cleanSmartName || '-'}
                      >
                        {cleanSmartName || '-'}
                      </td>
                      <td className="p-2.5 truncate max-w-[160px]" title={item.newName}>
                        <RenderedFilename
                          segments={item.segments}
                          fallbackName={item.newName}
                          isChanged={isChanged}
                        />
                      </td>
                      <td className="p-2.5 text-right">
                        {item.hasError ? (
                          <span className="text-destructive font-bold">{t('异常')}</span>
                        ) : isChanged ? (
                          <span className="text-emerald-500 font-bold">{t('变更')}</span>
                        ) : (
                          <span className="text-muted-foreground/60">{t('同名')}</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>

            {/* 超出 200 项时的底部提示条 */}
            {filteredPreviewList.length > MAX_PREVIEW_ITEMS && (
              <div className="py-3 px-3.5 bg-muted/20 text-center text-xs text-muted-foreground border-t border-border/30 flex items-center justify-center gap-1.5">
                <MaterialIcon icon="info" className="text-xs text-amber-500 shrink-0" />
                <span>
                  {t('为保证性能，实时对照列表仅展示前 {max} 个文件（共 {total} 个）', {
                    max: MAX_PREVIEW_ITEMS,
                    total: filteredPreviewList.length
                  })}
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 隐藏的更名执行触发挂载点（供顶部统一操作栏触发） */}
      <button
        id="btn-execute-rename-trigger"
        type="button"
        onClick={onExecuteRename}
        disabled={isExecuting || !hasPreviewItems}
        className="hidden"
        aria-hidden="true"
      />
    </div>
  )
}
