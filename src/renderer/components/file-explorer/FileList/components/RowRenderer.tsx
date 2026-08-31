import React, { useCallback } from 'react'
import { AnalysisStatus, getQualityScoreStars } from '@firefly/types'
import { LogCategory, logger, formatDateTime } from '@firefly/shared'
import { getPreviewRouteType, getExtFromSmartName } from '../../../../lib/preview-utils'
import { usePreviewOverlayStore } from '../../../../stores/preview-overlay-store'
import { MaterialIcon } from '../../../../lib/utils'
import { t } from '@app/languages'
import { FileType, ListItemData } from '../types'
import { Checkbox } from '../../../ui/checkbox'
import { toast } from '../../../common/Toast'
import { useFileQueueState } from '../../../../stores/analysis-queue-store'
import { useDragSelectStore } from '../../../../stores/drag-select-store'
import { checkIsUnit, getUnitTypeLabel, getUnitTheme, getUnitTooltip } from '../utils'
import { SystemFileIcon } from '../../../common/SystemFileIcon'

interface RowRendererProps {
  index: number
  style: React.CSSProperties
  data: ListItemData
}

// 点击/框选选中时 itemData 引用会变化；自定义比较：仅当影响当前行渲染的字段变化时才重渲染，
// 避免每次点击切换选中都导致全部行重渲染造成卡顿
const areRowPropsEqual = (prevProps: RowRendererProps, nextProps: RowRendererProps) => {
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
  if ((prevItem as any).size !== (nextItem as any).size) return false
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
  if (prevProps.data?.showAnalysisStatus !== nextProps.data?.showAnalysisStatus) return false
  if (prevProps.data?.selectionEnabled !== nextProps.data?.selectionEnabled) return false

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

export const renderAnalysisStatus = (status?: AnalysisStatus, error?: string) => {
  if (!status) return null

  const title = status === 'failed' ? error || t('未知失败原因') : undefined

  switch (status) {
    case 'completed':
      return (
        <div className="flex items-center space-x-1 text-green-600" title={title}>
          <MaterialIcon icon="check_circle" className="text-sm" />
          <span className="text-xs font-medium">{t('已分析')}</span>
        </div>
      )
    case 'pending':
      return (
        <div
          className="flex items-center space-x-1 text-yellow-600 dark:text-yellow-500"
          title={title}
        >
          <MaterialIcon icon="pending" className="text-sm" />
          <span className="text-xs font-medium">{t('分析队列中')}</span>
        </div>
      )
    case 'analyzing':
      return (
        <div className="flex items-center space-x-1 text-primary dark:text-primary" title={title}>
          <MaterialIcon icon="sync" className="text-sm animate-spin" />
          <span className="text-xs font-medium">{t('分析中')}</span>
        </div>
      )
    case 'failed':
      return (
        <div className="flex items-center space-x-1 text-red-600" title={title}>
          <MaterialIcon icon="error" className="text-sm" />
          <span className="text-xs font-medium">{t('失败')}</span>
        </div>
      )
    default:
      return null
  }
}

export const RowRenderer = React.memo(({ index, style, data }: RowRendererProps) => {
  const item = data.items[index]
  const isDirectory = 'isDirectory' in item && item.isDirectory

  const { status: queueStatus, error: queueError } = useFileQueueState(
    isDirectory ? '' : item.id || (item as any).fileId || item.path || '',
    !isDirectory && !!(item as FileType).isAnalyzed
  )
  const { isPathEqual } = window.electronAPI!.utils

  // 拖拽框选高亮：通过 selector 订阅 store，仅当本行进入/退出框选时才重渲染
  const isDragSelected = useDragSelectStore(s => s.dragSelectionPaths.has(item.path))

  // 这里的计算极其轻量：O(1) 查找
  const isSelected = (data.selectedPathsSet?.has(item.path) ?? false) || isDragSelected

  // 活动状态（属性面板选中）
  const isActive = data.activeItem && isPathEqual(item.path, data.activeItem.path)

  if ('isDirectory' in item && item.isDirectory) {
    // 检测最小单元
    const isUnit = checkIsUnit(item)
    const unitType = (item as any).unitType
    const unitLabel = getUnitTypeLabel(unitType)
    const unitReason = (item as any).unitReason || ''
    const unitConfidence = (item as any).unitConfidence
    const unitTheme = isUnit ? getUnitTheme(unitType) : undefined
    const unitTooltip = isUnit ? getUnitTooltip(unitLabel, unitReason, unitConfidence) : ''

    const isRowEffectiveSelected = Boolean(isSelected || isActive)

    const rowClass = [
      'file-row select-none',
      !isRowEffectiveSelected && 'hover:bg-accent/40 dark:hover:bg-accent/40',
      isRowEffectiveSelected && 'selected active bg-primary/20 dark:bg-primary/30',
      isUnit && unitTheme ? `${unitTheme.bg} ${unitTheme.darkBg}` : ''
    ]
      .filter(Boolean)
      .join(' ')

    return (
      <tr
        className={rowClass}
        data-index={index}
        onClick={e => {
          const target = e.target as HTMLElement
          if (!target.closest('.checkbox-cell')) {
            data.onItemClick(index, e)
            // 分栏模式下，单击可预览文件则切换预览，不可预览则回到提示页
            const splitState = usePreviewOverlayStore.getState()
            const pageMode = data.pageId
              ? (splitState.pageStates[data.pageId]?.mode ?? 'split')
              : undefined
            if (pageMode === 'split' && fileItem) {
              const ext =
                fileItem.extension ||
                getExtFromSmartName(fileItem.smartName || item.path.split('/').pop() || '') ||
                item.path.split('.').pop() ||
                ''
              const routeType = getPreviewRouteType(ext)
              logger.info(LogCategory.RENDERER, `[RowRenderer] 文件夹列表项被点击`, {
                path: item.path,
                ext,
                routeType,
                pageId: data.pageId,
                pageMode
              })
              if (routeType !== 'unsupported') {
                splitState.openPreview(
                  item.path,
                  data.getItemDisplayName?.(item) || item.name,
                  ext,
                  data.pageId
                )
              } else {
                logger.info(
                  LogCategory.RENDERER,
                  `[RowRenderer] 文件类型不支持预览，触发 clearPreview`,
                  { path: item.path, ext }
                )
                splitState.clearPreview(data.pageId)
              }
            }
          }
        }}
        onDoubleClick={() => {
          data.onDirectoryChange(item.path)
        }}
        onContextMenu={e => data.onContextMenu(e, item)}
      >
        {data.selectionEnabled !== false && (
          <td
            className="checkbox-cell p-2 border-r border-border/30 cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 text-center"
            style={{ width: data.columnWidths.checkbox }}
            onClick={e => {
              e.stopPropagation()
              const checked = !isRowEffectiveSelected
              const allChildItems = data.getAllFilesInDirectory(item.path)
              const itemsToToggle = [item as any, ...allChildItems]
              const currentSelected =
                typeof data.getSelectedFiles === 'function'
                  ? data.getSelectedFiles()
                  : data.selectedFiles

              if (checked) {
                const newSelected = [...currentSelected]
                itemsToToggle.forEach(newItem => {
                  if (!newSelected.some(f => isPathEqual(f.path, newItem.path))) {
                    newSelected.push(newItem)
                  }
                })
                data.onFileSelect(newSelected, true)
              } else {
                const pathsToRemove = itemsToToggle.map(i => i.path)
                const newSelected = currentSelected.filter(
                  (f: any) => !pathsToRemove.some(p => isPathEqual(p, f.path))
                )
                data.onFileSelect(newSelected, true)
              }
            }}
          >
            <Checkbox
              checked={isRowEffectiveSelected}
              onCheckedChange={checked => {
                const allChildItems = data.getAllFilesInDirectory(item.path)
                const itemsToToggle = [item as any, ...allChildItems]
                const currentSelected =
                  typeof data.getSelectedFiles === 'function'
                    ? data.getSelectedFiles()
                    : data.selectedFiles

                if (checked) {
                  const newSelected = [...currentSelected]
                  itemsToToggle.forEach(newItem => {
                    if (!newSelected.some(f => isPathEqual(f.path, newItem.path))) {
                      newSelected.push(newItem)
                    }
                  })
                  data.onFileSelect(newSelected, true)
                } else {
                  const pathsToRemove = itemsToToggle.map(i => i.path)
                  const newSelected = currentSelected.filter(
                    (f: any) => !pathsToRemove.some(p => isPathEqual(p, f.path))
                  )
                  data.onFileSelect(newSelected, true)
                }
              }}
              onClick={e => e.stopPropagation()}
              onDoubleClick={e => e.stopPropagation()}
            />
          </td>
        )}
        <td
          className="p-2 flex items-center gap-1.5 border-r border-border/30"
          style={{ width: data.columnWidths.name }}
        >
          <span
            className={`material-icons mr-2 text-xl flex-shrink-0 ${
              isUnit && unitTheme ? `${unitTheme.color} ${unitTheme.darkColor}` : 'text-primary'
            }`}
          >
            {isUnit && unitTheme ? unitTheme.icon : 'folder'}
          </span>
          <span className="font-medium cursor-pointer hover:text-primary dark:text-primary transition-colors truncate">
            {item.name}
          </span>
          {isUnit && unitTheme && (
            <span
              className={[
                'inline-flex items-center gap-1 text-[10px] font-semibold',
                unitTheme.color,
                unitTheme.darkColor,
                'bg-white/90 dark:bg-gray-900/90',
                'px-1.5 py-0.5 rounded-md',
                'border shadow-sm backdrop-blur-sm shrink-0',
                unitTheme.border,
                unitTheme.darkBorder
              ].join(' ')}
              title={unitTooltip}
            >
              <span className="material-icons text-[12px]">{unitTheme.icon}</span>
              {t(unitLabel)}
            </span>
          )}
        </td>
        {data.shouldShowField && data.shouldShowField('qualityScore') && (
          <td
            className="p-2 whitespace-nowrap border-r border-border/30"
            style={{ width: data.columnWidths.qualityScore }}
          ></td>
        )}
        {data.shouldShowField && data.shouldShowField('description') && (
          <td
            className="p-2 whitespace-nowrap border-r border-border/30"
            style={{ width: data.columnWidths.description }}
          ></td>
        )}
        {data.shouldShowField && data.shouldShowField('tags') && (
          <td
            className="p-2 whitespace-nowrap border-r border-border/30"
            style={{ width: data.columnWidths.tags }}
          ></td>
        )}
        {data.shouldShowField && data.shouldShowField('author') && (
          <td
            className="p-2 whitespace-nowrap border-r border-border/30"
            style={{ width: data.columnWidths.author }}
          ></td>
        )}
        {data.shouldShowField && data.shouldShowField('language') && (
          <td
            className="p-2 whitespace-nowrap border-r border-border/30"
            style={{ width: data.columnWidths.language }}
          ></td>
        )}
        {data.showAnalysisStatus && (
          <td
            className="p-2 whitespace-nowrap border-r border-border/30"
            style={{ width: data.columnWidths.analysisStatus }}
          ></td>
        )}
        <td
          className="p-2 text-foreground/80 dark:text-foreground/80 whitespace-nowrap border-r border-border/30"
          style={{ width: data.columnWidths.modified }}
        >
          {formatDateTime(item.modifiedAt)}
        </td>
        <td
          className="p-2 text-foreground/80 dark:text-foreground/80 whitespace-nowrap border-r border-border/30"
          style={{ width: data.columnWidths.type }}
        >
          {t('文件夹')}
        </td>
        <td
          className="p-2 text-foreground/80 dark:text-foreground/80 whitespace-nowrap"
          style={{ width: data.columnWidths.size }}
        ></td>
      </tr>
    )
  }

  const fileItem = item as FileType
  const isLost = (item && (item as any).status === 0) || (fileItem && fileItem.status === 0)
  const rowClass = [
    'transition-colors file-row select-none',
    isLost
      ? 'bg-red-500/10 dark:bg-red-950/30 hover:bg-red-500/20'
      : !isActive && 'hover:bg-accent/40 dark:hover:bg-accent/40',
    isSelected && 'selected bg-accent/70 dark:bg-accent/70',
    isActive && 'active bg-secondary'
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <tr
      key={item.path || index}
      className={rowClass}
      data-index={index}
      onClick={e => {
        const target = e.target as HTMLElement
        if (!target.closest('.checkbox-cell')) {
          data.onItemClick(index, e)
          // 分栏模式下，单击可预览文件则切换预览，不可预览则回到提示页
          const splitState = usePreviewOverlayStore.getState()
          const pageMode = data.pageId
            ? (splitState.pageStates[data.pageId]?.mode ?? 'split')
            : undefined
          if (pageMode === 'split' && fileItem) {
            const ext =
              fileItem.extension ||
              getExtFromSmartName(fileItem.smartName || item.name) ||
              fileItem.path.split('.').pop() ||
              ''
            const routeType = getPreviewRouteType(ext)
            logger.info(LogCategory.RENDERER, `[RowRenderer] 智能整理列表项被点击`, {
              path: item.path,
              ext,
              routeType,
              pageId: data.pageId,
              pageMode
            })
            if (routeType !== 'unsupported') {
              splitState.openPreview(
                item.path,
                data.getItemDisplayName?.(item) || item.name,
                ext,
                data.pageId
              )
            } else {
              logger.info(
                LogCategory.RENDERER,
                `[RowRenderer] 文件类型不支持预览，触发 clearPreview`,
                { path: item.path, ext }
              )
              splitState.clearPreview(data.pageId)
            }
          }
        }
      }}
      onContextMenu={e => data.onContextMenu(e, item)}
      onDoubleClick={async () => {
        if (!fileItem.path) return
        // 使用 getPreviewRouteType 判断文件是否可预览
        const ext =
          fileItem.extension ||
          getExtFromSmartName(fileItem.smartName || fileItem.name) ||
          fileItem.path.split('.').pop() ||
          ''
        const routeType = getPreviewRouteType(ext)
        if (routeType !== 'unsupported') {
          // 可预览 → 打开全局覆盖层
          usePreviewOverlayStore
            .getState()
            .openPreview(fileItem.path, fileItem.smartName || fileItem.name || '', ext, data.pageId)
        } else {
          // 不可预览 → 使用系统默认程序打开
          try {
            if (window.electronAPI!) {
              await window.electronAPI!.utils.openFileWithDefaultApp(fileItem.path)
            }
          } catch (error: any) {
            logger.error(LogCategory.RENDERER, '打开文件失败:', error)
            const message =
              error?.message?.replace(/^Error invoking remote method.*?: Error: /, '') ||
              String(error)
            toast.error(t('打开文件失败: {message}', { message }))
          }
        }
      }}
    >
      {data.selectionEnabled !== false && (
        <td
          className="checkbox-cell p-2 text-center border-r border-border/30 cursor-pointer hover:bg-black/5 dark:hover:bg-white/5"
          style={{ width: data.columnWidths.checkbox }}
          onClick={e => {
            e.stopPropagation()
            const checked = !isSelected
            const currentSelected =
              typeof data.getSelectedFiles === 'function'
                ? data.getSelectedFiles()
                : data.selectedFiles
            const newSelected = checked
              ? [...currentSelected, fileItem]
              : currentSelected.filter((f: FileType) => {
                  return !isPathEqual(f.path, fileItem.path)
                })
            data.onFileSelect(newSelected, true)
          }}
        >
          <Checkbox
            checked={isSelected}
            onCheckedChange={checked => {
              const currentSelected =
                typeof data.getSelectedFiles === 'function'
                  ? data.getSelectedFiles()
                  : data.selectedFiles
              const newSelected = checked
                ? [...currentSelected, fileItem]
                : currentSelected.filter((f: FileType) => {
                    return !isPathEqual(f.path, fileItem.path)
                  })
              data.onFileSelect(newSelected, true)
            }}
            onClick={e => e.stopPropagation()}
          />
        </td>
      )}
      {(() => {
        const isSwapped = data.swapFileNameDisplay
        const primaryName = isSwapped
          ? fileItem.name || ''
          : fileItem.smartName || fileItem.name || '-'
        const secondaryName = isSwapped ? fileItem.smartName || '' : fileItem.name || ''
        return (
          <td
            className="p-2 text-foreground/80 dark:text-foreground/80 whitespace-nowrap border-r border-border/30"
            title={fileItem.description || ''}
            style={{ width: data.columnWidths.name }}
          >
            <div className="flex items-start">
              <SystemFileIcon
                path={fileItem.path}
                extension={fileItem.extension}
                className="w-5 h-5 object-contain mr-2 flex-shrink-0"
                fallback={
                  <span className="material-icons text-primary mr-2 text-xl flex-shrink-0">
                    description
                  </span>
                }
              />
              <div className="flex flex-col min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="font-medium cursor-pointer hover:text-primary dark:text-primary transition-colors truncate">
                    {primaryName}
                  </span>
                  {isLost && (
                    <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-red-600 dark:text-red-400 bg-red-100 dark:bg-red-950/80 px-1.5 py-0.5 rounded border border-red-300 dark:border-red-800 shrink-0">
                      {t('已丢失')}
                    </span>
                  )}
                  {!isLost &&
                    checkIsUnit(null, fileItem) &&
                    (() => {
                      const ft = fileItem as any
                      const fileUnitType = ft.unitType
                      const fileUnitLabel = getUnitTypeLabel(fileUnitType)
                      const fileUnitTheme = getUnitTheme(fileUnitType)
                      const fileUnitTooltip = getUnitTooltip(
                        fileUnitLabel,
                        ft.unitReason || '',
                        ft.unitConfidence
                      )
                      return (
                        <span
                          className={[
                            'inline-flex items-center gap-1 text-[10px] font-semibold',
                            fileUnitTheme.color,
                            fileUnitTheme.darkColor,
                            'bg-white/90 dark:bg-gray-900/90',
                            'px-1.5 py-0.5 rounded-md',
                            'border shadow-sm backdrop-blur-sm shrink-0',
                            fileUnitTheme.border,
                            fileUnitTheme.darkBorder
                          ].join(' ')}
                          title={fileUnitTooltip}
                        >
                          <span className="material-icons text-[12px]">{fileUnitTheme.icon}</span>
                          {t(fileUnitLabel)}
                        </span>
                      )
                    })()}
                </div>
                {secondaryName && (
                  <span className="text-xs text-muted-foreground truncate mt-0.5">
                    {fileItem.relativePathPrefix
                      ? window.electronAPI?.utils?.normalizePath(
                          `${fileItem.relativePathPrefix}/${secondaryName}`
                        )
                      : secondaryName}
                  </span>
                )}
              </div>
            </div>
          </td>
        )
      })()}
      {data.shouldShowField && data.shouldShowField('qualityScore') && (
        <td
          className="p-2 text-foreground/80 dark:text-foreground/80 whitespace-nowrap border-r border-border/30"
          style={{ width: data.columnWidths.qualityScore }}
        >
          {fileItem.qualityScore ? (
            <div className="flex items-center">
              {getQualityScoreStars(fileItem.qualityScore).stars.map((star, index) => (
                <span key={index} className="text-primary">
                  {star === 'star' ? '★' : star === 'star_half' ? '☆' : '☆'}
                </span>
              ))}
            </div>
          ) : (
            <span className="text-muted-foreground dark:text-muted-foreground">-</span>
          )}
        </td>
      )}
      {data.shouldShowField && data.shouldShowField('description') && (
        <td
          className="p-2 text-foreground/80 dark:text-foreground/80 max-w-xs border-r border-border/30"
          title={fileItem.description || ''}
          style={{ width: data.columnWidths.description }}
        >
          <div className="line-clamp-2 text-sm leading-relaxed">
            {fileItem.description || (
              <span className="text-muted-foreground dark:text-muted-foreground">-</span>
            )}
          </div>
        </td>
      )}
      {data.shouldShowField && data.shouldShowField('tags') && (
        <td className="p-2 border-r border-border/30" style={{ width: data.columnWidths.tags }}>
          {fileItem.tags && fileItem.tags.length > 0 ? (
            <div className="flex gap-1 flex-wrap max-h-20 overflow-hidden">
              {fileItem.tags.slice(0, 6).map((tag, tagIndex) => (
                <span
                  key={tagIndex}
                  className="text-xs bg-primary/10 dark:bg-primary/20 text-primary dark:text-primary px-2 py-1 rounded whitespace-nowrap"
                >
                  {tag}
                </span>
              ))}
              {fileItem.tags.length > 6 && (
                <span className="text-xs text-muted-foreground dark:text-muted-foreground self-center">
                  +{fileItem.tags.length - 6}
                </span>
              )}
            </div>
          ) : (
            <span className="text-muted-foreground dark:text-muted-foreground">-</span>
          )}
        </td>
      )}
      {data.shouldShowField && data.shouldShowField('author') && (
        <td
          className="p-2 text-foreground/80 dark:text-foreground/80 whitespace-nowrap border-r border-border/30"
          style={{ width: data.columnWidths.author }}
        >
          {fileItem.author || (
            <span className="text-muted-foreground dark:text-muted-foreground">-</span>
          )}
        </td>
      )}
      {data.shouldShowField && data.shouldShowField('language') && (
        <td
          className="p-2 text-foreground/80 dark:text-foreground/80 whitespace-nowrap border-r border-border/30"
          style={{ width: data.columnWidths.language }}
        >
          {fileItem.language || (
            <span className="text-muted-foreground dark:text-muted-foreground">-</span>
          )}
        </td>
      )}
      {data.showAnalysisStatus && (
        <td
          className="p-2 whitespace-nowrap border-r border-border/30"
          style={{ width: data.columnWidths.analysisStatus }}
        >
          {renderAnalysisStatus(queueStatus, queueError)}
        </td>
      )}
      {data.shouldShowField && data.shouldShowField('analyzedAt') && (
        <td
          className="p-2 text-foreground/80 dark:text-foreground/80 whitespace-nowrap border-r border-border/30"
          style={{ width: data.columnWidths.analyzedAt }}
        >
          {(() => {
            const date =
              fileItem?.lastAnalyzedAt ||
              fileItem?.analyzedAt ||
              (item as any)?.lastAnalyzedAt ||
              (item as any)?.analyzedAt
            return date ? formatDateTime(date) : '-'
          })()}
        </td>
      )}
      <td
        className="p-2 text-foreground/80 dark:text-foreground/80 whitespace-nowrap border-r border-border/30"
        style={{ width: data.columnWidths.modified }}
      >
        {formatDateTime(fileItem.modifiedAt)}
      </td>
      <td
        className="p-2 text-foreground/80 dark:text-foreground/80 whitespace-nowrap border-r border-border/30"
        style={{ width: data.columnWidths.type }}
      >
        {fileItem.extension || t('文件')}
      </td>
      <td
        className="p-2 text-foreground/80 dark:text-foreground/80 whitespace-nowrap"
        style={{ width: data.columnWidths.size }}
      >
        {data.formatFileSize(fileItem.size)}
      </td>
    </tr>
  )
}, areRowPropsEqual)

RowRenderer.displayName = 'RowRenderer'
