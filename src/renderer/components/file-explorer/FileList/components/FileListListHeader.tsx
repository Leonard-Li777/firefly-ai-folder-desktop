import React from 'react'
import { DirectoryItem } from '@firefly/types'
import { t } from '@app/languages'
import { MaterialIcon, cn } from '../../../../lib/utils'
import { Checkbox } from '../../../ui/checkbox'
import { ColumnResizer } from './ColumnResizer'
import { FileListProps, FileType } from '../types'

interface FileListListHeaderProps {
  headerRef: React.RefObject<HTMLDivElement | null>
  totalWidth: number
  selectionEnabled: boolean
  columnWidths: Record<string, number>
  isAllSelected: boolean
  items: (DirectoryItem | FileType)[]
  selectedFiles: FileType[]
  normalizeForCache: (path: string) => string
  onFileSelect: (files: (FileType | DirectoryItem | string)[], isFromCheckbox?: boolean) => void
  onResize: (column: string, newWidth: number) => void
  swapFileNameDisplay: boolean
  showsmartName: boolean
  shouldShowField: (field: string) => boolean
  getFieldLabel: (field: string) => string
  showAnalysisStatus: boolean
  sortBy?: FileListProps['sortBy']
  sortOrder?: FileListProps['sortOrder']
  onHeaderClick: (column: string) => void
}

/**
 * List 视图独立横向滚动表头组件
 */
export const FileListListHeader: React.FC<FileListListHeaderProps> = ({
  headerRef,
  totalWidth,
  selectionEnabled,
  columnWidths,
  isAllSelected,
  items,
  selectedFiles,
  normalizeForCache,
  onFileSelect,
  onResize,
  swapFileNameDisplay,
  showsmartName,
  shouldShowField,
  getFieldLabel,
  showAnalysisStatus,
  sortBy,
  sortOrder,
  onHeaderClick
}) => {
  const getSortIcon = (column: string) => {
    if (sortBy !== column) return null
    return sortOrder === 'asc' ? (
      <MaterialIcon icon="arrow_upward" className="text-xs ml-1" />
    ) : (
      <MaterialIcon icon="arrow_downward" className="text-xs ml-1" />
    )
  }

  const getHeaderClass = (column: string, baseClass?: string) => {
    return cn(
      baseClass,
      'cursor-pointer hover:bg-accent/50 transition-colors flex items-center relative border-r border-border/50 px-2 h-full',
      sortBy === column ? 'text-primary font-bold' : ''
    )
  }

  return (
    <div
      ref={headerRef}
      className="overflow-x-auto overflow-y-hidden bg-muted/50 border-b border-border/50 flex-shrink-0 scrollbar-none"
      style={{ scrollbarWidth: 'none' }}
    >
      <div
        className="flex items-center text-xs font-medium text-foreground/70 select-none uppercase tracking-wider h-10"
        style={{ width: totalWidth }}
      >
        {selectionEnabled !== false && (
          <div
            className="flex-shrink-0 flex justify-center items-center border-r border-border/50 h-full relative"
            style={{ width: columnWidths.checkbox }}
          >
            <Checkbox
              checked={isAllSelected}
              onCheckedChange={checked => {
                // 以事件回调的 checked 参数为准，避免使用渲染期闭包中的 isAllSelected 造成状态滞后
                if (!checked) {
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
                } else {
                  onFileSelect(
                    items.filter(it => !!it.path).map(it => it.path!),
                    true
                  )
                }
              }}
            />
            <ColumnResizer
              onResize={w => onResize('checkbox', w)}
              currentWidth={columnWidths.checkbox}
            />
          </div>
        )}
        <div
          className={getHeaderClass('name', 'flex-shrink-0')}
          style={{ width: columnWidths.name }}
          onClick={() => onHeaderClick(swapFileNameDisplay ? 'name' : 'smartName')}
        >
          <span className="truncate">
            {!swapFileNameDisplay && showsmartName ? t('智能文件名') : t('名称')}
          </span>{' '}
          {getSortIcon(swapFileNameDisplay ? 'name' : 'smartName')}
          <ColumnResizer onResize={w => onResize('name', w)} currentWidth={columnWidths.name} />
        </div>
        {shouldShowField('qualityScore') && (
          <div
            className={getHeaderClass('qualityScore', 'flex-shrink-0')}
            style={{ width: columnWidths.qualityScore }}
            onClick={() => onHeaderClick('qualityScore')}
          >
            <span className="truncate">{getFieldLabel('qualityScore')}</span>{' '}
            {getSortIcon('qualityScore')}
            <ColumnResizer
              onResize={w => onResize('qualityScore', w)}
              currentWidth={columnWidths.qualityScore}
            />
          </div>
        )}
        {shouldShowField('description') && (
          <div
            className="flex-shrink-0 px-2 flex items-center border-r border-border/50 h-full relative"
            style={{ width: columnWidths.description }}
          >
            <span className="truncate">{getFieldLabel('description')}</span>
            <ColumnResizer
              onResize={w => onResize('description', w)}
              currentWidth={columnWidths.description}
            />
          </div>
        )}
        {shouldShowField('tags') && (
          <div
            className="flex-shrink-0 px-2 flex items-center border-r border-border/50 h-full relative"
            style={{ width: columnWidths.tags }}
          >
            <span className="truncate">{getFieldLabel('tags')}</span>
            <ColumnResizer onResize={w => onResize('tags', w)} currentWidth={columnWidths.tags} />
          </div>
        )}
        {shouldShowField('author') && (
          <div
            className={getHeaderClass('author', 'flex-shrink-0')}
            style={{ width: columnWidths.author }}
            onClick={() => onHeaderClick('author')}
          >
            <span className="truncate">{getFieldLabel('author')}</span> {getSortIcon('author')}
            <ColumnResizer
              onResize={w => onResize('author', w)}
              currentWidth={columnWidths.author}
            />
          </div>
        )}
        {shouldShowField('language') && (
          <div
            className={getHeaderClass('language', 'flex-shrink-0')}
            style={{ width: columnWidths.language }}
            onClick={() => onHeaderClick('language')}
          >
            <span className="truncate">{getFieldLabel('language')}</span> {getSortIcon('language')}
            <ColumnResizer
              onResize={w => onResize('language', w)}
              currentWidth={columnWidths.language}
            />
          </div>
        )}
        {showAnalysisStatus && (
          <div
            className={getHeaderClass('analysisStatus', 'flex-shrink-0')}
            style={{ width: columnWidths.analysisStatus }}
            onClick={() => onHeaderClick('analysisStatus')}
          >
            <span className="truncate">{t('分析状态')}</span> {getSortIcon('analysisStatus')}
            <ColumnResizer
              onResize={w => onResize('analysisStatus', w)}
              currentWidth={columnWidths.analysisStatus}
            />
          </div>
        )}
        {shouldShowField('analyzedAt') && (
          <div
            className={getHeaderClass('analyzedAt', 'flex-shrink-0')}
            style={{ width: columnWidths.analyzedAt }}
            onClick={() => onHeaderClick('analyzedAt')}
          >
            <span className="truncate">{getFieldLabel('analyzedAt')}</span>{' '}
            {getSortIcon('analyzedAt')}
            <ColumnResizer
              onResize={w => onResize('analyzedAt', w)}
              currentWidth={columnWidths.analyzedAt}
            />
          </div>
        )}
        <div
          className={getHeaderClass('modified', 'flex-shrink-0')}
          style={{ width: columnWidths.modified }}
          onClick={() => onHeaderClick('modified')}
        >
          <span className="truncate">{t('修改日期')}</span> {getSortIcon('modified')}
          <ColumnResizer
            onResize={w => onResize('modified', w)}
            currentWidth={columnWidths.modified}
          />
        </div>
        <div
          className={getHeaderClass('type', 'flex-shrink-0')}
          style={{ width: columnWidths.type }}
          onClick={() => onHeaderClick('type')}
        >
          <span className="truncate">{t('类型')}</span> {getSortIcon('type')}
          <ColumnResizer onResize={w => onResize('type', w)} currentWidth={columnWidths.type} />
        </div>
        <div
          className={getHeaderClass('size', 'flex-shrink-0 justify-end')}
          style={{ width: columnWidths.size }}
          onClick={() => onHeaderClick('size')}
        >
          <span className="truncate">{t('大小')}</span> {getSortIcon('size')}
          <ColumnResizer onResize={w => onResize('size', w)} currentWidth={columnWidths.size} />
        </div>
      </div>
    </div>
  )
}
