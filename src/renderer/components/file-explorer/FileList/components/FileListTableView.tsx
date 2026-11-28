import React from 'react'
import { DirectoryItem } from '@firefly/types'
import { t } from '@app/languages'
import { cn } from '../../../../lib/utils'
import { Checkbox } from '../../../ui/checkbox'
import { ContextMenu, ContextMenuItem } from '../../../common/ContextMenu'
import { ColumnResizer } from './ColumnResizer'
import { SelectionBox } from './SelectionBox'
import { RowRenderer } from './RowRenderer'
import { FileAdmissionNoticeBar } from './FileAdmissionNoticeBar'
import { FileListViewMode, FileType, ListItemData } from '../types'

interface FileListTableViewProps {
  showNoticeBar: boolean
  containerRef: React.RefObject<HTMLDivElement | null>
  handleKeyDown: (e: React.KeyboardEvent) => void
  handleMouseDown: (e: React.MouseEvent) => void
  viewMode: FileListViewMode
  scrollOffset: number
  items: (DirectoryItem | FileType)[]
  renderEmptyState: (loadingText: string) => React.ReactNode
  handleScroll: (params: any) => void
  totalWidth: number
  columnWidths: Record<string, number>
  shouldShowField: (field: string) => boolean
  showAnalysisStatus: boolean
  isAllSelected: boolean
  onFileSelect: (files: (FileType | DirectoryItem | string)[], isFromCheckbox?: boolean) => void
  selectedFiles: FileType[]
  normalizeForCache: (path: string) => string
  onResize: (column: string, newWidth: number) => void
  swapFileNameDisplay: boolean
  showsmartName: boolean
  getFieldLabel: (field: string) => string
  contextMenu: { x: number; y: number } | null
  contextMenuItems: ContextMenuItem[]
  onCloseContextMenu: () => void
  itemData: ListItemData
  isRealDirectory: boolean
  workspaceId?: number
  onOpenAdmissionRules: () => void
  noticeDismissed: boolean
  onDismissedChange: (dismissed: boolean) => void
}

/**
 * FileList 表格视图（fallback table 模式）独立面板组件
 */
export const FileListTableView: React.FC<FileListTableViewProps> = ({
  showNoticeBar,
  containerRef,
  handleKeyDown,
  handleMouseDown,
  viewMode,
  scrollOffset,
  items,
  renderEmptyState,
  handleScroll,
  totalWidth,
  columnWidths,
  shouldShowField,
  showAnalysisStatus,
  isAllSelected,
  onFileSelect,
  selectedFiles,
  normalizeForCache,
  onResize,
  swapFileNameDisplay,
  showsmartName,
  getFieldLabel,
  contextMenu,
  contextMenuItems,
  onCloseContextMenu,
  itemData,
  isRealDirectory,
  workspaceId,
  onOpenAdmissionRules,
  noticeDismissed,
  onDismissedChange
}) => {
  return (
    <div
      className={cn(
        'flex-1 overflow-hidden flex flex-col focus:outline-none relative',
        showNoticeBar && 'pb-[38px]'
      )}
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onMouseDown={handleMouseDown}
      onClick={e => {
        const target = e.target as HTMLElement
        if (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA') {
          containerRef.current?.focus()
        }
      }}
    >
      <SelectionBox viewMode={viewMode} scrollOffset={scrollOffset} containerRef={containerRef} />
      {items.length === 0 ? (
        renderEmptyState(t('目录为空'))
      ) : (
        <div
          className="flex-1 overflow-x-auto overflow-y-auto scrollbar-thin"
          onScroll={e => handleScroll(e)}
        >
          <table className="text-sm text-left" style={{ width: totalWidth, tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: columnWidths.checkbox }} />
              <col style={{ width: columnWidths.name }} />
              {shouldShowField('qualityScore') && (
                <col style={{ width: columnWidths.qualityScore }} />
              )}
              {shouldShowField('description') && (
                <col style={{ width: columnWidths.description }} />
              )}
              {shouldShowField('tags') && <col style={{ width: columnWidths.tags }} />}
              {shouldShowField('author') && <col style={{ width: columnWidths.author }} />}
              {shouldShowField('language') && <col style={{ width: columnWidths.language }} />}
              {showAnalysisStatus && <col style={{ width: columnWidths.analysisStatus }} />}
              {shouldShowField('analyzedAt') && <col style={{ width: columnWidths.analyzedAt }} />}
              <col style={{ width: columnWidths.modified }} />
              <col style={{ width: columnWidths.type }} />
              <col style={{ width: columnWidths.size }} />
            </colgroup>
            <thead className="bg-muted/30 sticky top-0 z-10 border-b border-border/50">
              <tr className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider h-10">
                <th className="p-2 border-r border-border/50 relative">
                  <Checkbox
                    checked={isAllSelected}
                    onCheckedChange={checked => {
                      if (checked) {
                        onFileSelect(
                          items.filter(item => Boolean(item.path)).map(item => item.path!),
                          true
                        )
                      } else {
                        // 取消全选：仅剔除当前 items 中的文件，保留其它页已选中项
                        const visibleKeys = new Set(
                          items.filter(it => !!it.path).map(it => normalizeForCache(it.path!))
                        )
                        onFileSelect(
                          selectedFiles.filter(
                            f => f && f.path && !visibleKeys.has(normalizeForCache(f.path))
                          ),
                          true
                        )
                      }
                    }}
                  />
                  <ColumnResizer
                    onResize={w => onResize('checkbox', w)}
                    currentWidth={columnWidths.checkbox}
                  />
                </th>
                <th className="p-2 font-medium truncate hover:bg-accent/40 cursor-default transition-colors border-r border-border/50 relative">
                  {!swapFileNameDisplay && showsmartName ? t('智能文件名') : t('名称')}
                  <ColumnResizer
                    onResize={w => onResize('name', w)}
                    currentWidth={columnWidths.name}
                  />
                </th>
                {shouldShowField('qualityScore') && (
                  <th className="p-2 font-medium truncate hover:bg-accent/40 cursor-default transition-colors border-r border-border/50 relative">
                    {getFieldLabel('qualityScore')}{' '}
                    <ColumnResizer
                      onResize={w => onResize('qualityScore', w)}
                      currentWidth={columnWidths.qualityScore}
                    />
                  </th>
                )}
                {shouldShowField('description') && (
                  <th className="p-2 font-medium truncate hover:bg-accent/40 cursor-default transition-colors border-r border-border/50 relative">
                    {getFieldLabel('description')}{' '}
                    <ColumnResizer
                      onResize={w => onResize('description', w)}
                      currentWidth={columnWidths.description}
                    />
                  </th>
                )}
                {shouldShowField('tags') && (
                  <th className="p-2 font-medium truncate hover:bg-accent/40 cursor-default transition-colors border-r border-border/50 relative">
                    {getFieldLabel('tags')}{' '}
                    <ColumnResizer
                      onResize={w => onResize('tags', w)}
                      currentWidth={columnWidths.tags}
                    />
                  </th>
                )}
                {shouldShowField('author') && (
                  <th className="p-2 font-medium truncate hover:bg-accent/40 cursor-default transition-colors border-r border-border/50 relative">
                    {getFieldLabel('author')}{' '}
                    <ColumnResizer
                      onResize={w => onResize('author', w)}
                      currentWidth={columnWidths.author}
                    />
                  </th>
                )}
                {shouldShowField('language') && (
                  <th className="p-2 font-medium truncate hover:bg-accent/40 cursor-default transition-colors border-r border-border/50 relative">
                    {getFieldLabel('language')}{' '}
                    <ColumnResizer
                      onResize={w => onResize('language', w)}
                      currentWidth={columnWidths.language}
                    />
                  </th>
                )}
                {showAnalysisStatus && (
                  <th className="p-2 font-medium truncate hover:bg-accent/40 cursor-default transition-colors border-r border-border/50 relative">
                    {t('分析状态')}{' '}
                    <ColumnResizer
                      onResize={w => onResize('analysisStatus', w)}
                      currentWidth={columnWidths.analysisStatus}
                    />
                  </th>
                )}
                {shouldShowField('analyzedAt') && (
                  <th className="p-2 font-medium truncate hover:bg-accent/40 cursor-default transition-colors border-r border-border/50 relative">
                    {getFieldLabel('analyzedAt')}{' '}
                    <ColumnResizer
                      onResize={w => onResize('analyzedAt', w)}
                      currentWidth={columnWidths.analyzedAt}
                    />
                  </th>
                )}
                <th className="p-2 font-medium truncate hover:bg-accent/40 cursor-default transition-colors border-r border-border/50 relative">
                  {t('修改日期')}{' '}
                  <ColumnResizer
                    onResize={w => onResize('modified', w)}
                    currentWidth={columnWidths.modified}
                  />
                </th>
                <th className="p-2 font-medium truncate hover:bg-accent/40 cursor-default transition-colors border-r border-border/50 relative">
                  {t('类型')}{' '}
                  <ColumnResizer
                    onResize={w => onResize('type', w)}
                    currentWidth={columnWidths.type}
                  />
                </th>
                <th className="p-2 font-medium truncate hover:bg-accent/40 cursor-default transition-colors relative">
                  {t('大小')}{' '}
                  <ColumnResizer
                    onResize={w => onResize('size', w)}
                    currentWidth={columnWidths.size}
                  />
                </th>
              </tr>
            </thead>
            <tbody className="divide-y relative">
              {contextMenu && (
                <ContextMenu
                  x={contextMenu.x}
                  y={contextMenu.y}
                  items={contextMenuItems}
                  onClose={onCloseContextMenu}
                />
              )}
              {items.map((item, index) => (
                <RowRenderer key={item.path || index} index={index} style={{}} data={itemData} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <FileAdmissionNoticeBar
        visible={isRealDirectory}
        workspaceId={workspaceId}
        onOpenAdmissionRules={onOpenAdmissionRules}
        dismissed={noticeDismissed}
        onDismissedChange={onDismissedChange}
      />
    </div>
  )
}
