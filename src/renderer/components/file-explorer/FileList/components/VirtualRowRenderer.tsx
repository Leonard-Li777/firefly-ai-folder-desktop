import { LogCategory, logger, formatDateTimeShort } from '@firefly/shared'

import { Checkbox } from '../../../ui/checkbox'
import { FileType } from '../types'
import React, { useRef, useLayoutEffect } from 'react'
import { cn } from '../../../../lib/utils'
import { AnalysisStatus, getQualityScoreStars } from '@firefly/types'
import { t } from '@app/languages'
import { toast } from '../../../common/Toast'
import { getPreviewRouteType, getExtFromSmartName } from '../../../../lib/preview-utils'
import { usePreviewOverlayStore } from '../../../../stores/preview-overlay-store'
import { useDragSelectStore } from '../../../../stores/drag-select-store'
import { renderAnalysisStatus } from './RowRenderer'
import { PageId } from '../../../../constants/page-ids'
import { checkIsUnit, getUnitTypeLabel, getUnitTheme, getUnitTooltip } from '../utils'
import { useFileQueueState } from '../../../../stores/analysis-queue-store'
import { SystemFileIcon } from '../../../common/SystemFileIcon'

interface VirtualRowRendererInnerProps {
  item: any
  index: number
  isSelected: boolean
  isActive: boolean
  isDirectory: boolean
  fileItem: FileType | null
  safeItemName: string
  showsmartName: boolean
  swapFileNameDisplay: boolean
  shouldShowField: (field: string) => boolean
  showAnalysisStatus: boolean
  formatFileSize: (size?: number) => string
  onItemClick: (index: number, e: React.MouseEvent) => void
  onContextMenu: (e: React.MouseEvent, item: any) => void
  onDirectoryChange: (path: string) => void
  onFileSelect: (files: any[], isFromCheckbox: boolean) => void
  getSelectedFiles?: () => any[]
  getAllFilesInDirectory: (path: string) => any[]
  selectedFiles: any[]
  itemPath: string
  isPathEqual: (p1: string, p2: string) => boolean
  tags: string[]
  columnWidths: Record<string, number>
  totalWidth: number
  selectionEnabled?: boolean
  pageId?: PageId
  gridCardWidth?: number
  listFontSize?: number
}

const areEqual = (
  prevProps: VirtualRowRendererInnerProps,
  nextProps: VirtualRowRendererInnerProps
) => {
  // Check basic properties
  if (
    prevProps.isSelected !== nextProps.isSelected ||
    prevProps.isActive !== nextProps.isActive ||
    prevProps.index !== nextProps.index ||
    prevProps.itemPath !== nextProps.itemPath ||
    prevProps.showsmartName !== nextProps.showsmartName ||
    prevProps.swapFileNameDisplay !== nextProps.swapFileNameDisplay ||
    prevProps.totalWidth !== nextProps.totalWidth ||
    prevProps.item?.name !== nextProps.item?.name ||
    prevProps.item?.modifiedAt !== nextProps.item?.modifiedAt ||
    prevProps.item?.size !== nextProps.item?.size ||
    prevProps.fileItem?.qualityScore !== nextProps.fileItem?.qualityScore ||
    prevProps.onFileSelect !== nextProps.onFileSelect ||
    prevProps.getSelectedFiles !== nextProps.getSelectedFiles ||
    prevProps.selectionEnabled !== nextProps.selectionEnabled ||
    prevProps.listFontSize !== nextProps.listFontSize
  ) {
    return false
  }

  // Optimized columnWidths comparison
  if (prevProps.columnWidths !== nextProps.columnWidths) {
    const prevKeys = Object.keys(prevProps.columnWidths)
    const nextKeys = Object.keys(nextProps.columnWidths)
    if (prevKeys.length !== nextKeys.length) return false
    for (const key of prevKeys) {
      if (prevProps.columnWidths[key] !== nextProps.columnWidths[key]) {
        return false
      }
    }
  }

  return true
}

const VirtualRowRendererInner = React.memo((props: VirtualRowRendererInnerProps) => {
  const {
    item,
    index,
    isSelected,
    isActive,
    isDirectory,
    fileItem,
    safeItemName,
    showsmartName,
    swapFileNameDisplay,
    shouldShowField,
    showAnalysisStatus,
    formatFileSize,
    onItemClick,
    onContextMenu,
    onDirectoryChange,
    onFileSelect,
    getSelectedFiles,
    getAllFilesInDirectory,
    selectedFiles,
    itemPath,
    isPathEqual,
    tags,
    columnWidths,
    totalWidth,
    selectionEnabled,
    pageId
  } = props

  const selectedFilesRef = useRef(selectedFiles)
  useLayoutEffect(() => {
    selectedFilesRef.current = selectedFiles
  }, [selectedFiles])

  /** 获取最新的 selectedFiles，优先使用 getSelectedFiles 函数避免 stale ref */
  const getLatestSelectedFiles = () => {
    if (typeof getSelectedFiles === 'function') return getSelectedFiles()
    return selectedFilesRef.current || []
  }

  const handleToggleCheckbox = (checked: boolean) => {
    if (!item.path) return
    const currentSelected = getLatestSelectedFiles()
    if (isDirectory) {
      const allChildItems =
        typeof getAllFilesInDirectory === 'function' ? getAllFilesInDirectory(item.path) : []
      const itemsToToggle = [item, ...allChildItems]

      if (checked) {
        const newSelected = [...currentSelected]
        itemsToToggle.forEach(newItem => {
          if (!newSelected.some(f => isPathEqual(f.path, newItem.path))) {
            newSelected.push(newItem)
          }
        })
        onFileSelect(newSelected, true)
      } else {
        const pathsToRemove = itemsToToggle.map(i => i.path || '')
        const newSelected = currentSelected.filter((f: any) => {
          return f?.path && !pathsToRemove.some(p => isPathEqual(p, f.path))
        })
        onFileSelect(newSelected, true)
      }
    } else {
      const newSelected = checked
        ? [...currentSelected, item]
        : currentSelected.filter((f: any) => {
            return f?.path && !isPathEqual(f.path, itemPath)
          })
      onFileSelect(newSelected, true)
    }
  }

  const { status: queueStatus, error: queueError } = useFileQueueState(
    isDirectory ? '' : item?.id || fileItem?.id || itemPath,
    !isDirectory && !!fileItem?.isAnalyzed
  )

  const isLost = (item && item.status === 0) || (fileItem && fileItem.status === 0)
  const isUnit = !isLost && checkIsUnit(item, fileItem)
  const unitType = isUnit ? item?.unitType || fileItem?.unitType : undefined
  const unitLabel = getUnitTypeLabel(unitType)
  const unitReason = item?.unitReason || fileItem?.unitReason || ''
  const unitConfidence = item?.unitConfidence || fileItem?.unitConfidence
  const unitTheme = isUnit ? getUnitTheme(unitType) : undefined
  const unitTooltip = isUnit ? getUnitTooltip(unitLabel, unitReason, unitConfidence) : ''

  const rowClass = cn(
    'flex items-center border-b border-border/30 transition-colors file-row h-full select-none',
    isLost
      ? 'bg-red-500/10 dark:bg-red-950/30 hover:bg-red-500/20'
      : isUnit && unitTheme
        ? `${unitTheme.bg} ${unitTheme.darkBg} hover:bg-white/80 dark:hover:bg-gray-900/30`
        : !isActive && 'hover:bg-secondary',
    isSelected && 'selected bg-accent/70 dark:bg-accent/70',
    isActive && 'active bg-primary/20 dark:bg-primary/30'
  )

  const listFontSize = props.listFontSize || 14

  return (
    <div
      className={rowClass}
      data-index={index}
      style={{ width: totalWidth, fontSize: `${listFontSize}px` }}
      onClick={e => {
        const target = e.target as HTMLElement
        // If clicking the checkbox cell, do not trigger row click selection
        if (!target.closest('.checkbox-cell')) {
          onItemClick(index, e)
          // 分栏模式下，单击可预览文件则切换预览，不可预览则回到提示页
          const splitState = usePreviewOverlayStore.getState()
          const pageMode = pageId ? (splitState.pageStates[pageId]?.mode ?? 'split') : undefined
          if (pageMode === 'split' && fileItem) {
            const ext =
              fileItem.extension ||
              getExtFromSmartName(fileItem.smartName || item.name) ||
              item.path.split('.').pop() ||
              ''
            const routeType = getPreviewRouteType(ext)
            logger.info(LogCategory.RENDERER, `[VirtualRowRenderer] 虚拟列表项被点击`, {
              path: item.path,
              ext,
              routeType,
              pageId,
              pageMode
            })
            if (routeType !== 'unsupported') {
              splitState.openPreview(item.path, fileItem.smartName || item.name, ext, pageId)
            } else {
              logger.info(
                LogCategory.RENDERER,
                `[VirtualRowRenderer] 文件类型不支持预览，触发 clearPreview`,
                { path: item.path, ext }
              )
              splitState.clearPreview(pageId)
            }
          }
        }
      }}
      onContextMenu={e => onContextMenu(e, item)}
      onDoubleClick={() => {
        if (!item.path) return
        if (isDirectory) {
          onDirectoryChange(item.path)
        } else if (fileItem) {
          // 使用统一的预览路由判断，与 RowRenderer 保持一致
          const ext =
            fileItem.extension ||
            getExtFromSmartName(fileItem.smartName || fileItem.name || '') ||
            fileItem.path.split('.').pop() ||
            ''
          const routeType = getPreviewRouteType(ext)
          if (routeType !== 'unsupported') {
            usePreviewOverlayStore
              .getState()
              .openPreview(fileItem.path, fileItem.smartName || fileItem.name || '', ext, pageId)
          } else {
            window.electronAPI!.utils.openFileWithDefaultApp(item.path).catch((error: Error) => {
              logger.error(LogCategory.RENDERER, '打开文件失败:', error)
              const message =
                error?.message?.replace(/^Error invoking remote method.*?: Error: /, '') ||
                String(error)
              toast.error(t('打开文件失败: {message}', { message }))
            })
          }
        }
      }}
    >
      {selectionEnabled !== false && (
        <div
          className="checkbox-cell flex-shrink-0 flex justify-center p-2 border-r border-border/30 h-full items-center cursor-pointer hover:bg-black/5 dark:hover:bg-white/5"
          style={{ width: columnWidths.checkbox }}
          onClick={e => {
            e.stopPropagation()
            handleToggleCheckbox(!isSelected)
          }}
        >
          <Checkbox
            checked={isSelected}
            onCheckedChange={checked => handleToggleCheckbox(checked as boolean)}
            onClick={e => e.stopPropagation()}
          />
        </div>
      )}

      <div
        className="flex-shrink-0 flex items-center p-2 truncate border-r border-border/30 h-full"
        style={{ width: columnWidths.name }}
      >
        {isDirectory ? (
          <span
            className={cn(
              'material-icons mr-2 text-xl flex-shrink-0',
              isUnit && unitTheme ? `${unitTheme.color} ${unitTheme.darkColor}` : 'text-amber-500'
            )}
          >
            {isUnit && unitTheme ? unitTheme.icon : 'folder'}
          </span>
        ) : (
          <SystemFileIcon
            path={fileItem?.path}
            extension={fileItem?.extension}
            className="w-5 h-5 object-contain mr-2 flex-shrink-0"
            fallback={
              <span className="material-icons mr-2 text-xl flex-shrink-0 text-primary">
                description
              </span>
            }
          />
        )}
        <div className="flex flex-col min-w-0">
          <div className="flex items-center gap-1.5">
            {(() => {
              if (!fileItem) return <span className="font-medium truncate">{safeItemName}</span>
              const isSwapped = swapFileNameDisplay
              const primaryName = isSwapped ? safeItemName : fileItem.smartName || safeItemName
              return (
                <>
                  <span className="font-medium truncate text-primary cursor-pointer transition-colors">
                    {primaryName}
                  </span>
                  {isLost && (
                    <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-red-600 dark:text-red-400 bg-red-100 dark:bg-red-950/80 px-1.5 py-0.5 rounded border border-red-300 dark:border-red-800 shrink-0">
                      {t('已丢失')}
                    </span>
                  )}
                  {isUnit && unitTheme && (
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 text-[10px] font-semibold',
                        unitTheme.color,
                        unitTheme.darkColor,
                        'bg-white/90 dark:bg-gray-900/90',
                        'px-1.5 py-0.5 rounded-md',
                        'border shadow-sm backdrop-blur-sm shrink-0',
                        unitTheme.border,
                        unitTheme.darkBorder
                      )}
                      title={unitTooltip}
                    >
                      <span className="material-icons text-[12px]">{unitTheme.icon}</span>
                      {t(unitLabel)}
                    </span>
                  )}
                </>
              )
            })()}
          </div>
          {fileItem && (
            <span className="text-xs text-gray-400 truncate">
              {(() => {
                const isSwapped = swapFileNameDisplay
                const secondaryName = isSwapped ? fileItem.smartName || '' : safeItemName
                if (!secondaryName) return null
                return fileItem.relativePathPrefix
                  ? window.electronAPI?.utils?.normalizePath(
                      `${fileItem.relativePathPrefix}/${secondaryName}`
                    )
                  : secondaryName
              })()}
            </span>
          )}
        </div>
      </div>

      {typeof shouldShowField === 'function' && shouldShowField('qualityScore') && (
        <div
          className="flex-shrink-0 p-2 border-r border-border/30 h-full flex items-center"
          style={{ width: columnWidths.qualityScore }}
        >
          {fileItem?.qualityScore ? (
            <div className="flex text-primary">
              {getQualityScoreStars(fileItem.qualityScore).stars.map((s, i) => (
                <span key={i}>{s === 'star' ? '★' : '☆'}</span>
              ))}
            </div>
          ) : (
            <span className="text-muted-foreground dark:text-muted-foreground">-</span>
          )}
        </div>
      )}

      {typeof shouldShowField === 'function' && shouldShowField('description') && (
        <div
          className="flex-shrink-0 p-2 truncate text-foreground/70 dark:text-foreground/70 border-r border-border/30 h-full flex items-center"
          title={fileItem?.description || ''}
          style={{ width: columnWidths.description }}
        >
          {fileItem?.description || (
            <span className="text-muted-foreground dark:text-muted-foreground">-</span>
          )}
        </div>
      )}

      {typeof shouldShowField === 'function' && shouldShowField('tags') && (
        <div
          className="flex-shrink-0 p-2 truncate border-r border-border/30 h-full flex items-center"
          style={{ width: columnWidths.tags }}
        >
          {tags.length > 0 ? (
            <div className="flex gap-1 overflow-hidden">
              {tags.slice(0, 3).map((t, i) => (
                <span
                  key={i}
                  className="text-xs bg-primary/10 dark:bg-primary/20 text-primary dark:text-primary px-1.5 py-0.5 rounded"
                >
                  {t}
                </span>
              ))}
            </div>
          ) : (
            <span className="text-muted-foreground dark:text-muted-foreground">-</span>
          )}
        </div>
      )}

      {typeof shouldShowField === 'function' && shouldShowField('author') && (
        <div
          className="flex-shrink-0 p-2 truncate text-foreground/80 dark:text-foreground/80 border-r border-border/30 h-full flex items-center"
          style={{ width: columnWidths.author }}
        >
          {fileItem?.author || (
            <span className="text-muted-foreground dark:text-muted-foreground">-</span>
          )}
        </div>
      )}

      {typeof shouldShowField === 'function' && shouldShowField('language') && (
        <div
          className="flex-shrink-0 p-2 truncate text-foreground/80 dark:text-foreground/80 border-r border-border/30 h-full flex items-center"
          style={{ width: columnWidths.language }}
        >
          {fileItem?.language || (
            <span className="text-muted-foreground dark:text-muted-foreground">-</span>
          )}
        </div>
      )}

      {showAnalysisStatus && (
        <div
          className="flex-shrink-0 p-2 border-r border-border/30 h-full flex items-center"
          style={{ width: columnWidths.analysisStatus }}
        >
          {fileItem && renderAnalysisStatus(queueStatus, queueError)}
        </div>
      )}

      {typeof shouldShowField === 'function' && shouldShowField('analyzedAt') && (
        <div
          className="flex-shrink-0 p-2 text-foreground/60 border-r border-border/30 h-full flex items-center"
          style={{ width: columnWidths.analyzedAt }}
        >
          {(() => {
            const date =
              fileItem?.lastAnalyzedAt ||
              fileItem?.analyzedAt ||
              (item as any)?.lastAnalyzedAt ||
              (item as any)?.analyzedAt
            return date ? formatDateTimeShort(date) : '-'
          })()}
        </div>
      )}

      <div
        className="flex-shrink-0 p-2 text-foreground/60 border-r border-border/30 h-full flex items-center"
        style={{ width: columnWidths.modified }}
      >
        {item.modifiedAt ? formatDateTimeShort(item.modifiedAt) : '-'}
      </div>

      <div
        className="flex-shrink-0 p-2 text-foreground/60 truncate border-r border-border/30 h-full flex items-center"
        style={{ width: columnWidths.type }}
      >
        {isDirectory ? t('文件夹') : fileItem?.extension || t('文件')}
      </div>

      <div
        className="flex-shrink-0 p-2 text-foreground/60 text-right pr-4 h-full flex items-center justify-end"
        style={{ width: columnWidths.size }}
      >
        {isDirectory ? '' : formatFileSize(fileItem?.size)}
      </div>
    </div>
  )
}, areEqual)

interface RowRendererProps {
  index: number
  style: React.CSSProperties
  data: any
}

const areVirtualRowPropsEqual = (prevProps: RowRendererProps, nextProps: RowRendererProps) => {
  if (prevProps.index !== nextProps.index) return false

  const prevStyle = prevProps.style || {}
  const nextStyle = nextProps.style || {}
  if (
    prevStyle.top !== nextStyle.top ||
    prevStyle.height !== nextStyle.height ||
    prevStyle.width !== nextStyle.width
  ) {
    return false
  }

  const prevItems = prevProps.data?.items
  const nextItems = nextProps.data?.items
  if (!prevItems || !nextItems) return false

  const prevItem = prevItems[prevProps.index]
  const nextItem = nextItems[nextProps.index]
  if (prevItem !== nextItem) return false
  if (!prevItem || !nextItem) return true

  if (prevItem.name !== nextItem.name) return false
  if (prevItem.modifiedAt !== nextItem.modifiedAt) return false
  if (prevItem.size !== nextItem.size) return false
  if (prevItem.path !== nextItem.path) return false

  const prevIsActive = !!(
    prevProps.data?.activeItem?.path &&
    prevProps.data?.isPathEqual?.(prevItem.path, prevProps.data.activeItem.path)
  )
  const nextIsActive = !!(
    nextProps.data?.activeItem?.path &&
    nextProps.data?.isPathEqual?.(nextItem.path, nextProps.data.activeItem.path)
  )
  if (prevIsActive !== nextIsActive) return false

  const prevIsSelected = prevProps.data?.selectedPathsSet?.has(prevItem.path) ?? false
  const nextIsSelected = nextProps.data?.selectedPathsSet?.has(nextItem.path) ?? false
  if (prevIsSelected !== nextIsSelected) return false

  if (prevProps.data?.refreshKey !== nextProps.data?.refreshKey) return false
  if (prevProps.data?.viewMode !== nextProps.data?.viewMode) return false
  if (prevProps.data?.showsmartName !== nextProps.data?.showsmartName) return false
  if (prevProps.data?.swapFileNameDisplay !== nextProps.data?.swapFileNameDisplay) return false
  if (prevProps.data?.totalWidth !== nextProps.data?.totalWidth) return false
  if (prevProps.data?.listRowHeight !== nextProps.data?.listRowHeight) return false
  if (prevProps.data?.listFontSize !== nextProps.data?.listFontSize) return false

  if (prevProps.data?.columnWidths !== nextProps.data?.columnWidths) {
    const prevWidths = prevProps.data?.columnWidths || {}
    const nextWidths = nextProps.data?.columnWidths || {}
    const keys = Object.keys(prevWidths)
    if (keys.length !== Object.keys(nextWidths).length) return false
    for (const k of keys) {
      if (prevWidths[k] !== nextWidths[k]) return false
    }
  }

  return true
}

export const VirtualRowRenderer = React.memo(({ index, style, data }: RowRendererProps) => {
  const {
    items,
    selectedFiles,
    activeItem,
    onFileSelect,
    getSelectedFiles,
    onDirectoryChange,
    showsmartName,
    swapFileNameDisplay: swapFileNameDisplayRaw,
    shouldShowField,
    showAnalysisStatus,
    getAllFilesInDirectory,
    onContextMenu,
    formatFileSize,
    onItemClick,
    columnWidths,
    totalWidth,
    selectionEnabled,
    pageId
  } = data
  const swapFileNameDisplay = swapFileNameDisplayRaw ?? false

  const item = items && items.length > index ? items[index] : null
  const itemPath = item?.path ?? ''
  // 拖拽框选高亮：通过 selector 订阅 store，仅当本行进入/退出框选时才重渲染
  const isDragSelected = useDragSelectStore(s => s.dragSelectionPaths.has(itemPath))
  if (!item) return <div style={style} />

  const { isPathEqual } = window.electronAPI!.utils

  const isSelected = (data.selectedPathsSet?.has(itemPath) ?? false) || isDragSelected

  const isActive = activeItem?.path && isPathEqual(itemPath, activeItem.path)
  const isDirectory = item && 'isDirectory' in item && item.isDirectory
  const fileItem = !isDirectory ? (item as FileType) : null
  const tags = fileItem?.tags || []
  const safeItemName = item.name || t('未知文件')

  return (
    <div style={{ ...style, width: totalWidth }}>
      <VirtualRowRendererInner
        item={item}
        index={index}
        isSelected={isSelected}
        isActive={isActive}
        isDirectory={isDirectory}
        fileItem={fileItem}
        safeItemName={safeItemName}
        showsmartName={showsmartName}
        swapFileNameDisplay={swapFileNameDisplay}
        shouldShowField={shouldShowField}
        showAnalysisStatus={showAnalysisStatus}
        formatFileSize={formatFileSize}
        onItemClick={onItemClick}
        onContextMenu={onContextMenu}
        onDirectoryChange={onDirectoryChange}
        onFileSelect={onFileSelect}
        getSelectedFiles={getSelectedFiles}
        getAllFilesInDirectory={getAllFilesInDirectory}
        selectedFiles={selectedFiles}
        itemPath={itemPath}
        isPathEqual={isPathEqual}
        tags={tags}
        columnWidths={columnWidths}
        totalWidth={totalWidth}
        selectionEnabled={selectionEnabled}
        pageId={pageId}
        gridCardWidth={data.gridCardWidth}
        listFontSize={data.listFontSize}
      />
    </div>
  )
}, areVirtualRowPropsEqual)

VirtualRowRenderer.displayName = 'VirtualRowRenderer'
VirtualRowRendererInner.displayName = 'VirtualRowRendererInner'
