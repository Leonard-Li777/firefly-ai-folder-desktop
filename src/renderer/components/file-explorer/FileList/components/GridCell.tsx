import React, { useState, useMemo, useRef, useEffect } from 'react'
import { cn } from '../../../../lib/utils'
import { t } from '@app/languages'
import { FileType } from '../types'
import { LogCategory, logger } from '@firefly/shared'
import { toast } from '../../../common/Toast'
import { Checkbox } from '../../../ui/checkbox'
import { getQualityScoreStars } from '@firefly/types'
import { getPreviewRouteType, getExtFromSmartName } from '../../../../lib/preview-utils'
import { usePreviewOverlayStore } from '../../../../stores/preview-overlay-store'
import { useDragSelectStore } from '../../../../stores/drag-select-store'
import { PageId } from '../../../../constants/page-ids'
import { checkIsUnit, getUnitTypeLabel, getUnitTheme, getUnitTooltip } from '../utils'
import { SystemFileIcon } from '../../../common/SystemFileIcon'

interface GridCellInnerProps {
  item: any
  index: number
  isSelected: boolean
  isActive: boolean
  isDirectory: boolean
  fileItem: FileType | null
  showThumbnail: boolean
  safeItemName: string
  showsmartName: boolean
  swapFileNameDisplay: boolean
  gridShowFullFileName: boolean
  refreshKey: number
  workspaceDirectoryPath: string | null
  getFileIcon: (type: 'file' | 'directory', ext?: string) => React.ReactNode
  formatFileSize: (size?: number) => string
  normalizeForCache: (path: string) => string
  onItemClick: (index: number, e: React.MouseEvent) => void
  onContextMenu: (e: React.MouseEvent, item: any) => void
  onDirectoryChange: (path: string) => void
  onFileSelect: (files: any[], isFromCheckbox: boolean) => void
  onFileDoubleClick?: (file: FileType) => void
  getSelectedFiles?: () => any[]
  getAllFilesInDirectory: (path: string) => any[]
  selectedFiles: any[]
  itemPath: string
  isPathEqual: (p1: string, p2: string) => boolean
  viewMode?: string
  selectionEnabled?: boolean
  pageId?: PageId
  columnWidth?: number
}

const formatShortDate = (date?: string | number | Date): string => {
  if (!date) return '-'
  try {
    const d = new Date(date)
    const year = d.getFullYear()
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    const hour = String(d.getHours()).padStart(2, '0')
    const minute = String(d.getMinutes()).padStart(2, '0')
    const second = String(d.getSeconds()).padStart(2, '0')
    return `${year}/${month}/${day} ${hour}:${minute}:${second}`
  } catch (e) {
    return '-'
  }
}

const areEqual = (prevProps: GridCellInnerProps, nextProps: GridCellInnerProps) => {
  return (
    prevProps.isSelected === nextProps.isSelected &&
    prevProps.isActive === nextProps.isActive &&
    prevProps.index === nextProps.index &&
    prevProps.refreshKey === nextProps.refreshKey &&
    prevProps.viewMode === nextProps.viewMode &&
    prevProps.showsmartName === nextProps.showsmartName &&
    prevProps.swapFileNameDisplay === nextProps.swapFileNameDisplay &&
    prevProps.gridShowFullFileName === nextProps.gridShowFullFileName &&
    prevProps.itemPath === nextProps.itemPath &&
    prevProps.item?.name === nextProps.item?.name &&
    prevProps.item?.modifiedAt === nextProps.item?.modifiedAt &&
    prevProps.item?.size === nextProps.item?.size &&
    prevProps.fileItem?.thumbnailPath === nextProps.fileItem?.thumbnailPath &&
    prevProps.fileItem?.qualityScore === nextProps.fileItem?.qualityScore &&
    prevProps.onFileSelect === nextProps.onFileSelect &&
    prevProps.onFileDoubleClick === nextProps.onFileDoubleClick &&
    prevProps.getSelectedFiles === nextProps.getSelectedFiles &&
    prevProps.selectionEnabled === nextProps.selectionEnabled
  )
}

// 核心渲染组件，只有在选中状态或关键属性变化时才重绘
export const GridCellInner = React.memo((props: GridCellInnerProps) => {
  const {
    item,
    index,
    isSelected,
    isActive,
    isDirectory,
    fileItem,
    showThumbnail,
    safeItemName,
    showsmartName,
    swapFileNameDisplay,
    gridShowFullFileName,
    refreshKey,
    workspaceDirectoryPath,
    getFileIcon,
    formatFileSize,
    normalizeForCache,
    onItemClick,
    onContextMenu,
    onDirectoryChange,
    onFileSelect,
    onFileDoubleClick,
    getSelectedFiles,
    getAllFilesInDirectory,
    selectedFiles,
    itemPath,
    isPathEqual,
    viewMode,
    selectionEnabled,
    pageId,
    columnWidth
  } = props

  const [isHovered, setIsHovered] = useState(false)
  // 缩略图加载失败标记：失败后回退到系统图标/默认文件图标分支，避免空白占位
  const [imgError, setImgError] = useState(false)

  // 拖拽框选高亮：通过 selector 订阅 store，仅当本卡片进入/退出框选时才重渲染
  const isDragSelected = useDragSelectStore(s => s.dragSelectionPaths.has(itemPath))
  // isSelected 为静态选中（selectedPathsSet），拖选高亮单独订阅，避免框选时全部卡片重渲染
  const finalSelected = isSelected || isDragSelected

  // 文件路径/缩略图/刷新键变化时重置错误状态，重新尝试加载
  useEffect(() => {
    setImgError(false)
  }, [fileItem?.path, fileItem?.thumbnailPath, refreshKey])

  /** 获取最新的 selectedFiles，优先使用 getSelectedFiles 函数避免 stale ref */
  const getLatestSelectedFiles = () => {
    if (typeof getSelectedFiles === 'function') return getSelectedFiles()
    return selectedFiles || []
  }

  const handleToggleCheckbox = (checked: boolean) => {
    if (!item.path) return
    const currentSelected = getLatestSelectedFiles()
    if (isDirectory) {
      const allFilesInDir =
        typeof getAllFilesInDirectory === 'function' ? getAllFilesInDirectory(item.path) : []
      const itemsToToggle = [item, ...allFilesInDir]
      if (checked) {
        // 合并并去重
        const newSelected = [...currentSelected]
        itemsToToggle.forEach(newItem => {
          if (!newSelected.some(f => isPathEqual(f.path, newItem.path))) {
            newSelected.push(newItem)
          }
        })
        onFileSelect(newSelected, true)
      } else {
        const pathsToRemove = itemsToToggle.map(i => i.path)
        const newSelected = currentSelected.filter(
          f => !pathsToRemove.some(p => isPathEqual(p, f.path))
        )
        onFileSelect(newSelected, true)
      }
    } else {
      const newSelected = checked
        ? [...currentSelected, item]
        : currentSelected.filter(f => !isPathEqual(f.path, itemPath))
      onFileSelect(newSelected, true)
    }
  }

  const isLost = (item && item.status === 0) || (fileItem && fileItem.status === 0)
  const isUnit = !isLost && checkIsUnit(item, fileItem)
  const unitType = isUnit ? item?.unitType || fileItem?.unitType : undefined
  const unitLabel = getUnitTypeLabel(unitType)
  const unitReason = item?.unitReason || fileItem?.unitReason || ''
  const unitConfidence = item?.unitConfidence || fileItem?.unitConfidence
  const unitTheme = isUnit ? getUnitTheme(unitType) : undefined
  const unitTooltip = isUnit ? getUnitTooltip(unitLabel, unitReason, unitConfidence) : ''

  return (
    <div
      data-index={index}
      className={cn(
        'group relative flex flex-col items-center p-2 rounded-xl transition-all duration-200 cursor-pointer w-full select-none',
        viewMode === 'waterfall' ? 'h-auto' : 'h-full',
        !isActive && isHovered && 'bg-primary/20',
        isLost
          ? 'bg-red-500/10 dark:bg-red-950/30 border border-red-500/30 hover:bg-red-500/20'
          : isUnit && unitTheme
            ? `${unitTheme.bg} ${unitTheme.darkBg} border ${unitTheme.border} ${unitTheme.darkBorder}`
            : 'bg-secondary/50 dark:bg-secondary',
        finalSelected && 'ring-1 ring-primary/90 bg-primary/30 dark:bg-primary/30 ring-inset',
        isActive && 'bg-primary/20 dark:bg-primary/20 z-10'
      )}
      title={isLost ? t('原文件已在磁盘上丢失或被移动') : isUnit ? unitTooltip : undefined}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={e => {
        const isCheckboxClick = !!(e.target as HTMLElement).closest('.checkbox-cell')
        if (!isCheckboxClick) {
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
            logger.debug(LogCategory.RENDERER, `[GridCell] 网格单元格被点击`, {
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
                `[GridCell] 文件类型不支持预览，触发 clearPreview`,
                { path: item.path, ext }
              )
              splitState.clearPreview(pageId)
            }
          }
        }
      }}
      onContextMenu={e => onContextMenu(e, item)}
      onDoubleClick={async () => {
        if (!item.path) return
        if (isDirectory) {
          onDirectoryChange(item.path)
        } else if (typeof onFileDoubleClick === 'function' && fileItem) {
          onFileDoubleClick(fileItem)
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
            try {
              if (window.electronAPI!) {
                await window.electronAPI!.utils.openFileWithDefaultApp(item.path)
              }
            } catch (error: any) {
              logger.error(LogCategory.RENDERER, '打开文件失败:', error)
              const message =
                error?.message?.replace(/^Error invoking remote method.*?: Error: /, '') ||
                String(error)
              toast.error(t('打开文件失败: {message}', { message }))
            }
          }
        }
      }}
    >
      {selectionEnabled !== false && (
        <div
          className={cn(
            'checkbox-cell absolute top-[-6px] left-[-4px] p-2 z-20 transition-opacity duration-200 cursor-pointer',
            finalSelected || isHovered ? 'opacity-100' : 'opacity-0'
          )}
          onClick={e => {
            e.stopPropagation()
            handleToggleCheckbox(!finalSelected)
          }}
        >
          <Checkbox
            checked={finalSelected}
            onCheckedChange={checked => handleToggleCheckbox(checked as boolean)}
            onClick={e => e.stopPropagation()}
            onDoubleClick={e => e.stopPropagation()}
          />
        </div>
      )}

      {isLost && (
        <div className="absolute top-2 right-2 z-20 pointer-events-none">
          <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-red-600 dark:text-red-400 bg-red-100/90 dark:bg-red-950/90 px-1.5 py-0.5 rounded-md border border-red-300 dark:border-red-800 shadow-sm backdrop-blur-sm">
            {t('已丢失')}
          </span>
        </div>
      )}
      {isUnit && unitTheme && (
        <div className="absolute top-2 left-2 z-20 pointer-events-none">
          <span
            className={cn(
              'inline-flex items-center gap-1 text-[10px] font-semibold',
              unitTheme.color,
              unitTheme.darkColor,
              'bg-white/90 dark:bg-gray-900/90',
              'px-1.5 py-0.5 rounded-md',
              'border shadow-sm backdrop-blur-sm',
              unitTheme.border,
              unitTheme.darkBorder
            )}
          >
            <span className="material-icons text-[12px]">{unitTheme.icon}</span>
            {t(unitLabel)}
          </span>
        </div>
      )}

      <div
        className={cn(
          'w-full flex items-center justify-center mb-2 overflow-hidden rounded-lg relative transition-colors flex-shrink-0',
          viewMode === 'waterfall' ? 'h-auto min-h-[100px]' : 'aspect-square',
          isHovered ? 'bg-background/80' : ''
        )}
      >
        {(() => {
          if (!fileItem)
            return (
              // p-[5%] 预留缩放空间：内容区为容器的 90%，scale-110 放大后仍不超出容器，避免被 overflow-hidden 截断边缘
              <div className="transform transition-transform duration-300 group-hover:scale-110 drop-shadow-sm flex items-center justify-center w-full h-full p-[15%]">
                {isUnit && unitTheme ? (
                  <span
                    className={`material-icons ${unitTheme.color} ${unitTheme.darkColor}`}
                    style={{ fontSize: 48 }}
                  >
                    {unitTheme.icon}
                  </span>
                ) : (
                  getFileIcon('directory', '')
                )}
              </div>
            )

          let baseUrl = ''
          if (fileItem.thumbnailPath) {
            const thumbPath = fileItem.thumbnailPath
            const isAbs =
              /^[a-zA-Z]:[\\/]/.test(thumbPath) ||
              thumbPath.startsWith('/') ||
              thumbPath.startsWith('\\')
            let absPath = ''
            if (isAbs) {
              absPath = thumbPath
            } else if (workspaceDirectoryPath) {
              absPath = `${workspaceDirectoryPath.replace(/[\\/]+$/, '')}/${thumbPath.replace(/^[\\/]+/, '')}`
            }
            if (absPath) {
              const normalized = normalizeForCache(absPath).replace(/\\/g, '/')
              const cleanPath = normalized.startsWith('/') ? normalized : `/${normalized}`
              baseUrl = `file://${cleanPath}`
            }
          } else if (typeof showThumbnail === 'boolean' && showThumbnail) {
            const normalized = normalizeForCache(fileItem.path).replace(/\\/g, '/')
            const cleanPath = normalized.startsWith('/') ? normalized : `/${normalized}`
            baseUrl = `file://${cleanPath}`
          }

          if (baseUrl && !imgError) {
            const finalUrl = refreshKey ? `${baseUrl}?t=${refreshKey}` : baseUrl
            return (
              <div
                className={cn(
                  'w-full overflow-hidden flex items-center justify-center',
                  viewMode === 'waterfall' ? 'h-auto' : 'h-full'
                )}
              >
                <img
                  src={finalUrl}
                  alt={safeItemName}
                  loading="lazy"
                  className={cn(
                    'w-full',
                    viewMode === 'waterfall'
                      ? 'h-auto object-contain transition-transform duration-500 ease-out will-change-transform'
                      : 'h-full object-contain grid-thumbnail-image'
                  )}
                  onError={() => {
                    // 缩略图加载失败（如 .json 等非图片文件直接以 file:// 加载、或缩略图缺失），
                    // 标记后回退到下方系统图标/默认文件图标分支，避免空白占位
                    setImgError(true)
                  }}
                />
              </div>
            )
          }

          return (
            // p-[5%] 预留缩放空间：内容区为容器的 90%，scale-110 放大后仍不超出容器，避免被 overflow-hidden 截断边缘
            <div className="transform transition-transform duration-300 group-hover:scale-110 drop-shadow-sm flex items-center justify-center w-full h-full p-[15%]">
              <SystemFileIcon
                path={fileItem.path}
                extension={fileItem.extension}
                iconSize="normal"
                className="max-w-full max-h-full object-contain object-center"
                fallback={
                  <div className="relative flex flex-col items-center justify-center gap-1 max-w-full max-h-full">
                    {/* 默认文件图标上层居中显示扩展名（无缩略图且获取不到系统图标时） */}
                    {fileItem.extension ? (
                      <span className="px-1.5 py-0.5 rounded-md text-[10px] leading-none font-semibold text-muted-foreground dark:text-muted-foreground bg-background/80 border border-border/40">
                        {fileItem.extension.toUpperCase()}
                      </span>
                    ) : null}
                    {getFileIcon('file', fileItem.extension || '')}
                  </div>
                }
              />
            </div>
          )
        })()}

        {/* 瀑布流专有：Hover 动画滑出文件详细信息面板 */}
        {viewMode === 'waterfall' && fileItem && (
          <div className="absolute inset-x-0 bottom-[-1px] pb-1 pl-2 pr-2 bg-background/95 backdrop-blur-md text-[10px] gap-1 flex flex-col z-20 select-none pointer-events-none rounded-b-lg waterfall-info-overlay">
            {/* 标签 */}
            {fileItem.tags && fileItem.tags.length > 0 && (
              <div className="flex flex-wrap gap-0.5 max-h-[20px] overflow-hidden line-clamp-2">
                {fileItem.tags.map((tag: string, i: number) => (
                  <span
                    key={i}
                    className="px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium text-[9px] whitespace-nowrap"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
            {/* 作者 & 语言 */}
            {(fileItem.author || fileItem.language) && (
              <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                {fileItem.author && (
                  <span className="truncate max-w-[50%]" title={fileItem.author}>
                    👤 {fileItem.author}
                  </span>
                )}
                {fileItem.language && (
                  <span className="truncate max-w-[45%] text-right" title={fileItem.language}>
                    🌐 {fileItem.language}
                  </span>
                )}
              </div>
            )}
            {/* 大小 & 评分 & 修改日期 */}
            <div className="flex items-center justify-between text-[10px] border-t border-border/30 mt-0.5">
              <div className="flex flex-col gap-0.5 text-muted-foreground">
                <span>💾 {formatFileSize(fileItem.size)}</span>
              </div>
              {typeof fileItem.qualityScore === 'number' && fileItem.qualityScore >= 0 ? (
                <span className="flex items-center gap-0.5 font-bold text-amber-500 self-end">
                  {getQualityScoreStars(fileItem.qualityScore)
                    .stars.map((s, i) => (s === 'star' ? '★' : '☆'))
                    .join('')}{' '}
                  ({fileItem.qualityScore})
                </span>
              ) : (
                fileItem.modifiedAt && (
                  <span className="ml-auto text-muted-foreground">
                    📅 {formatShortDate(fileItem.modifiedAt)}
                  </span>
                )
              )}
            </div>
          </div>
        )}
      </div>

      {(() => {
        // 目录项没有 fileItem，直接显示目录名称
        if (!fileItem) {
          return (
            <div
              className={cn(
                'text-sm font-medium text-center break-all line-clamp-3 w-full px-1 transition-colors',
                isHovered ? 'text-primary' : 'text-gray-700 dark:text-gray-100'
              )}
              title={safeItemName}
            >
              {safeItemName}
            </div>
          )
        }
        const isSwapped = swapFileNameDisplay
        // 网格视图是否完整显示文件名：开启按 break-all 完整换行，关闭时超出宽度省略
        const showFullName = gridShowFullFileName
        const primaryName = isSwapped ? safeItemName : fileItem.smartName || safeItemName
        const secondaryName = isSwapped ? fileItem.smartName || '' : safeItemName
        return (
          <div className="flex flex-col items-center w-full gap-1.5 mt-0.5 pb-1.5">
            <div
              className={cn(
                'text-xs sm:text-sm font-medium text-center w-full px-0.5 transition-colors leading-tight',
                showFullName ? 'break-all line-clamp-3 whitespace-normal' : 'truncate',
                isHovered ? 'text-primary' : 'text-gray-700 dark:text-gray-100'
              )}
              title={
                isSwapped
                  ? fileItem?.relativePathPrefix
                    ? window.electronAPI?.utils?.normalizePath(
                        `${fileItem.relativePathPrefix}/${safeItemName}`
                      )
                    : safeItemName
                  : fileItem?.smartName || safeItemName
              }
            >
              {primaryName}
            </div>
            {secondaryName && (
              <div
                className={cn(
                  'text-[10px] sm:text-xs text-muted-foreground w-full px-0.5 text-center leading-tight',
                  showFullName ? 'break-all line-clamp-1 whitespace-normal' : 'truncate'
                )}
              >
                {fileItem.relativePathPrefix
                  ? window.electronAPI?.utils?.normalizePath(
                      `${fileItem.relativePathPrefix}/${secondaryName}`
                    )
                  : secondaryName}
              </div>
            )}
          </div>
        )
      })()}
    </div>
  )
}, areEqual)

interface GridCellProps {
  columnIndex: number
  rowIndex: number
  style: React.CSSProperties
  data: any
}

// GridCell 的 data 引用在组件重渲染时可能变化；自定义比较：仅当影响当前单元格渲染的字段变化时才重渲染。
// 拖拽框选高亮由 GridCellInner 内部订阅 store 独立驱动，不依赖 data 的 dragSelectionPaths
const gridCellAreEqual = (prevProps: GridCellProps, nextProps: GridCellProps): boolean => {
  if (prevProps.columnIndex !== nextProps.columnIndex) return false
  if (prevProps.rowIndex !== nextProps.rowIndex) return false
  if (prevProps.style !== nextProps.style) return false

  const prevData = prevProps.data
  const nextData = nextProps.data
  if (prevData === nextData) return true

  const index = nextProps.rowIndex * (nextData?.columnCount ?? 1) + nextProps.columnIndex
  const prevItem = prevData?.items?.[index]
  const nextItem = nextData?.items?.[index]
  if (prevItem !== nextItem) return false
  if (!prevItem || !nextItem) return true

  if (prevItem.name !== nextItem.name) return false
  if (prevItem.path !== nextItem.path) return false
  if (prevItem.modifiedAt !== nextItem.modifiedAt) return false
  if (prevItem.size !== nextItem.size) return false
  if (prevItem.thumbnailPath !== nextItem.thumbnailPath) return false
  if ((prevItem as any).qualityScore !== (nextItem as any).qualityScore) return false

  const isPathEqualFn = window.electronAPI?.utils?.isPathEqual
  const prevIsActive = !!(
    prevData?.activeItem?.path && isPathEqualFn?.(prevItem.path, prevData.activeItem.path)
  )
  const nextIsActive = !!(
    nextData?.activeItem?.path && isPathEqualFn?.(nextItem.path, nextData.activeItem.path)
  )
  if (prevIsActive !== nextIsActive) return false

  const prevIsSelected = prevData?.selectedPathsSet?.has(prevItem.path) ?? false
  const nextIsSelected = nextData?.selectedPathsSet?.has(nextItem.path) ?? false
  if (prevIsSelected !== nextIsSelected) return false

  if (prevData?.refreshKey !== nextData?.refreshKey) return false
  if (prevData?.viewMode !== nextData?.viewMode) return false
  if (prevData?.showsmartName !== nextData?.showsmartName) return false
  if (prevData?.swapFileNameDisplay !== nextData?.swapFileNameDisplay) return false
  if (prevData?.gridShowFullFileName !== nextData?.gridShowFullFileName) return false
  if (prevData?.columnWidth !== nextData?.columnWidth) return false
  if (prevData?.selectionEnabled !== nextData?.selectionEnabled) return false

  return true
}

export const GridCell = React.memo((props: GridCellProps) => {
  const { columnIndex, rowIndex, style, data } = props
  if (!style || !data) return null

  const {
    items,
    columnCount,
    selectedFiles,
    getSelectedFiles,
    activeItem,
    onFileSelect,
    onDirectoryChange,
    getAllFilesInDirectory,
    isImageFile,
    showsmartName,
    swapFileNameDisplay: swapFileNameDisplayRaw,
    gridShowFullFileName,
    workspaceDirectoryPath,
    refreshKey,
    onContextMenu,
    getFileIcon,
    formatFileSize,
    normalizeForCache,
    onItemClick,
    onFileDoubleClick,
    selectionEnabled,
    pageId
  } = data
  const swapFileNameDisplay = swapFileNameDisplayRaw ?? false

  if (!items || !Array.isArray(items)) return <div style={style} />

  const index = rowIndex * columnCount + columnIndex
  if (index >= items.length) return <div style={style} />

  const item = items[index]
  if (!item) return <div style={style} />

  const { isPathEqual } = window.electronAPI!.utils
  const itemPath = item.path ? item.path : ''

  // 静态选中状态由 selectedPathsSet 判断；拖拽框选高亮由 GridCellInner 内部订阅 store 实现，
  // 避免框选时每帧生成新 Set 导致全部可见卡片重渲染
  const isSelected = data.selectedPathsSet?.has(itemPath) ?? false

  const isActive = activeItem?.path && isPathEqual(itemPath, activeItem.path)
  const isDirectory = 'isDirectory' in item && item.isDirectory
  const fileItem = !isDirectory ? (item as FileType) : null
  const showThumbnail = !!(
    fileItem &&
    typeof isImageFile === 'function' &&
    isImageFile(fileItem.extension)
  )
  const safeItemName = item.name || t('未知文件')

  // 卡片内容宽度固定为滑块值（刻度线性连续）；水平间隙由单元格宽度与卡片宽度之差决定，
  // 剩余空间被卡片间水平间隙吸收，实现无右侧留白的弹性填满布局
  const cardWidth = data.columnWidth || 120
  const cellWidth = typeof style?.width === 'number' ? style.width : cardWidth
  const gapX = Math.max(0, cellWidth - cardWidth)
  const halfGapX = gapX / 2
  // 垂直方向使用独立的小间隙，避免水平间隙过大时行距被同步放大、每行相隔很远
  const gapY = Math.max(4, Math.round(cardWidth * 0.05))
  const halfGapY = gapY / 2

  const itemStyle = {
    ...style,
    left: typeof style?.left === 'number' ? style.left + halfGapX : style?.left || 0,
    top: typeof style?.top === 'number' ? style.top + halfGapY : style?.top || 0,
    width: typeof style?.width === 'number' ? style.width - gapX : style?.width || '100%',
    height: typeof style?.height === 'number' ? style.height - gapY : style?.height || '100%'
  }

  return (
    <div style={itemStyle}>
      <GridCellInner
        item={item}
        index={index}
        isSelected={isSelected}
        isActive={isActive}
        isDirectory={isDirectory}
        fileItem={fileItem}
        showThumbnail={showThumbnail}
        safeItemName={safeItemName}
        showsmartName={showsmartName}
        swapFileNameDisplay={swapFileNameDisplay}
        gridShowFullFileName={gridShowFullFileName}
        refreshKey={refreshKey}
        workspaceDirectoryPath={workspaceDirectoryPath}
        getFileIcon={getFileIcon}
        formatFileSize={formatFileSize}
        normalizeForCache={normalizeForCache}
        onItemClick={onItemClick}
        onContextMenu={onContextMenu}
        onDirectoryChange={onDirectoryChange}
        onFileSelect={onFileSelect}
        onFileDoubleClick={onFileDoubleClick}
        getSelectedFiles={getSelectedFiles}
        getAllFilesInDirectory={getAllFilesInDirectory}
        selectedFiles={selectedFiles}
        itemPath={itemPath}
        isPathEqual={isPathEqual}
        viewMode={data.viewMode || 'grid'}
        selectionEnabled={selectionEnabled}
        pageId={pageId}
        columnWidth={data.columnWidth}
      />
    </div>
  )
}, gridCellAreEqual)

GridCell.displayName = 'GridCell'
GridCellInner.displayName = 'GridCellInner'
