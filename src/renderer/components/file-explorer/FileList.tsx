import {
  AnalysisStatus,
  FileItem as BaseFileType,
  DirectoryItem,
  getQualityScoreStars
} from '@yonuc/types'
import { LogCategory, logger } from '@yonuc/shared'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatFileSize, getFileIcon } from './FileItem'

import { FileItem } from './FileItem'
import { MaterialIcon } from '../../lib/utils'
import { cn } from '../../lib/utils'
import { t } from '@app/languages'
import { useAnalysisQueueStore } from '../../stores/analysis-queue-store'
import { useFileDisplaySettings } from '../../hooks/useFileDisplaySettings'
import { useFileExplorerStore } from '../../stores/app-store'

// 扩展 FileType 类型，添加 relativePathPrefix 属性
interface FileType extends BaseFileType {
  relativePathPrefix?: string
  thumbnailPath?: string // 添加 thumbnailPath 属性
}






// 动态导入react-window
let ListComponent: any = null
let GridComponent: any = null
let isReactWindowV2 = false
let isReactWindowLoaded = false

if (typeof window !== 'undefined') {
  try {
    // 使用动态导入确保在客户端运行时加载
    import('react-window')
      .then((module: any) => {
        // Log module for debugging
        logger.info(LogCategory.RENDERER, 'Loaded react-window module:', module)
        
        if (module.FixedSizeList || module.default?.FixedSizeList) {
          ListComponent = module.FixedSizeList || module.default?.FixedSizeList
          GridComponent = module.FixedSizeGrid || module.default?.FixedSizeGrid
          isReactWindowV2 = false
        } else {
          // Fallback for react-window v2
          ListComponent = module.List || module.default?.List
          GridComponent = module.Grid || module.default?.Grid
          isReactWindowV2 = true
        }
        
        isReactWindowLoaded = !!(ListComponent && GridComponent)
      })
      .catch(e => {
        logger.warn(LogCategory.RENDERER, 'Failed to load react-window:', e)
        isReactWindowLoaded = false
      })
  } catch (e) {
    logger.warn(LogCategory.RENDERER, 'Failed to dynamically import react-window:', e)
    isReactWindowLoaded = false
  }
}

interface FileListProps {
  files: FileType[]
  directories: DirectoryItem[]
  selectedFiles: FileType[]
  activeItem?: FileType | DirectoryItem | null // 当前在属性面板中显示的文件/目录
  onFileSelect: (files: (FileType | DirectoryItem | string)[], isFromCheckbox?: boolean) => void
  onDirectoryChange: (path: string) => void
  loading?: boolean
  viewMode?: 'list' | 'grid' | 'table'
  currentPath: string
  showAnalysisStatus?: boolean // 是否显示分析状态列（虚拟目录不显示）
  showsmartName?: boolean // 是否显示智能文件名列（虚拟目录显示）
  isRealDirectory?: boolean // 是否是真实目录模式（真实目录不显示AI分析相关字段）
  sortBy?:
    | 'name'
    | 'size'
    | 'modified'
    | 'type'
    | 'smartName'
    | 'analysisStatus'
    | 'author'
    | 'qualityScore'
    | 'language' // 可选的排序字段（虚拟目录传入）
  sortOrder?: 'asc' | 'desc' // 可选的排序顺序（虚拟目录传入）
  disableClientSort?: boolean // 是否禁用客户端排序（虚拟目录已在后端排序）
  onSortChange?: (
    sortBy:
      | 'name'
      | 'size'
      | 'modified'
      | 'type'
      | 'smartName'
      | 'analysisStatus'
      | 'author'
      | 'qualityScore'
      | 'language',
    sortOrder: 'asc' | 'desc'
  ) => void // 排序变化回调
  workspaceDirectoryPath?: string // 工作目录路径（用于解析缩略图路径）
  refreshKey?: number // 用于强制刷新的key
}

interface ListItemData {
  items: (FileType | DirectoryItem)[]
  selectedFiles: FileType[]
  activeItem?: FileType | DirectoryItem | null
  onFileSelect: (files: (FileType | DirectoryItem)[], isFromCheckbox?: boolean) => void
  onDirectoryChange: (path: string) => void
  onToggleDirectory?: (path: string) => void
  viewMode?: 'list' | 'grid' | 'table'
  showAnalysisStatus?: boolean
  showsmartName?: boolean
  shouldShowField?: (
    field: 'qualityScore' | 'description' | 'tags' | 'author' | 'language'
  ) => boolean
  isRealDirectory?: boolean
  columnCount?: number
  getAllFilesInDirectory?: (dirPath: string) => (FileType | DirectoryItem)[]
  isImageFile?: (extension: string) => boolean
  refreshKey?: number
  workspaceDirectoryPath?: string
  isAnalyzedPathSet: Set<string>
}

// 定义RowRenderer组件的props类型
interface RowRendererProps {
  index: number
  style: React.CSSProperties
  data: ListItemData
}

// 缓存目录结构，避免重复计算
const directoryCache = new Map<string, (FileType | DirectoryItem)[]>()

// 渲染分析状态
const renderAnalysisStatus = (status?: AnalysisStatus, error?: string) => {
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

const RowRenderer: React.FC<RowRendererProps> = ({ index, style, data }) => {
  const item = data.items[index]
  const { snapshot } = useAnalysisQueueStore()
  // 勾选状态（checkbox选中）
  const isSelected = data.selectedFiles.some((f: any) => {
    // 使用更健壮的路径比较，确保类型正确
    const normalizedPath1 = f?.path ? f.path.replace(/\\/g, '/') : ''
    const normalizedPath2 = item?.path ? item.path.replace(/\\/g, '/') : ''
    return normalizedPath1 && normalizedPath2 && normalizedPath1 === normalizedPath2
  })
  // 活动状态（属性面板选中）
  const isActive =
    data.activeItem && item.path.replace(/\\/g, '/') === data.activeItem.path.replace(/\\/g, '/')

  // 获取文件的分析状态
  const getFileAnalysisStatus = (file: FileType): AnalysisStatus | undefined => {
    const normalizedPath = file.path.replace(/\\/g, '/')
    // 首先检查队列中的状态
    const queueItem = snapshot.items.find(item => item.path.replace(/\\/g, '/') === normalizedPath)
    if (queueItem) {
      return queueItem.status
    }
    // 如果不在队列中，检查文件是否已分析
    if (file.isAnalyzed) {
      return 'completed'
    }
    return undefined
  }

  // 获取文件的失败原因（仅当队列中存在失败记录时可用）
  const getFileAnalysisError = (file: FileType): string | undefined => {
    const normalizedPath = file.path.replace(/\\/g, '/')
    const queueItem = snapshot.items.find(item => item.path.replace(/\\/g, '/') === normalizedPath)
    if (queueItem?.status === 'failed') {
      return queueItem.error || undefined
    }
    return undefined
  }

  // 优化后的递归获取目录下所有文件的函数
  const getAllFilesInDirectory = useCallback(
    (dirPath: string): (FileType | DirectoryItem)[] => {
      // 检查缓存
      if (directoryCache.has(dirPath)) {
        return directoryCache.get(dirPath)!
      }

      // 使用Set避免重复
      const resultSet = new Set<FileType | DirectoryItem>()

      // 添加当前目录本身
      const currentDir = data.items.find(
        item =>
          'isDirectory' in item &&
          item.isDirectory &&
          item.path.replace(/\\/g, '/') === dirPath.replace(/\\/g, '/')
      )
      if (currentDir) {
        resultSet.add(currentDir)
      }

      // 使用队列进行广度优先搜索，避免深度递归
      const queue = [dirPath]
      const visited = new Set<string>()

      while (queue.length > 0) {
        const currentPath = queue.shift()!
        if (visited.has(currentPath.replace(/\\/g, '/'))) continue
        visited.add(currentPath.replace(/\\/g, '/'))

        // 获取当前路径下的所有文件和目录
        const currentFiles = data.items.filter(item => {
          if ('isDirectory' in item && item.isDirectory) {
            // 目录：检查是否是当前路径的直接子目录
            return item.parentPath.replace(/\\/g, '/') === currentPath.replace(/\\/g, '/')
          } else {
            // 文件：检查是否在当前路径下
            const filePath = (item as FileType).path
            // 标准化路径分隔符
            const normalizedFilePath = filePath.replace(/\\/g, '/')
            const normalizedCurrentPath = currentPath.replace(/\\/g, '/')

            // 检查文件路径是否以当前路径开头，并且后面跟着路径分隔符
            return (
              normalizedFilePath.startsWith(normalizedCurrentPath + '/') &&
              normalizedFilePath !== normalizedCurrentPath
            )
          }
        })

        currentFiles.forEach(file => {
          resultSet.add(file)
          // 如果是目录，加入队列继续搜索
          if ('isDirectory' in file && file.isDirectory) {
            queue.push(file.path)
          }
        })
      }

      const result = Array.from(resultSet)
      // 更新缓存
      directoryCache.set(dirPath, result)
      return result
    },
    [data.items]
  )

  if ('isDirectory' in item && item.isDirectory) {
    const rowClass = [
      'transition-colors file-row',
      !isActive && 'hover:bg-accent/40 dark:hover:bg-accent/40',
      isSelected && 'selected bg-accent/70 dark:bg-accent/70',
      isActive && 'active bg-primary/20 dark:bg-primary/30'
    ]
      .filter(Boolean)
      .join(' ')

    return (
      <tr
        className={rowClass}
        onDoubleClick={() => {
          // 双击目录：导航到该目录
          data.onDirectoryChange(item.path)
        }}
      >
        <td className="p-2">
          <input
            className="rounded border-input dark:border-input text-primary dark:text-primary focus:ring-ring focus:border-primary cursor-pointer"
            type="checkbox"
            checked={isSelected}
            onChange={e => {
              const { checked } = e.target
              const allChildItems = getAllFilesInDirectory(item.path)
              const itemsToSelect = [item, ...allChildItems]

              if (checked) {
                // Add the directory and all its children to the selection
                const newSelected = [...new Set([...data.selectedFiles, ...itemsToSelect])]
                data.onFileSelect(newSelected, true)
              } else {
                // Remove the directory and all its children from the selection
                const pathsToRemove = new Set(itemsToSelect.map(i => i.path.replace(/\\/g, '/')))
                const newSelected = data.selectedFiles.filter(
                  f => !pathsToRemove.has(f.path.replace(/\\/g, '/'))
                )
                data.onFileSelect(newSelected, true)
              }
            }}
            onDoubleClick={e => e.stopPropagation()}
          />
        </td>
        {data.showsmartName && (
          <td className="p-2 text-foreground/80 dark:text-foreground/80 whitespace-nowrap min-w-[400px]">
            {/* 目录没有虚拟名称 */}
          </td>
        )}
        {!data.showsmartName && (
          <td className="p-2 flex items-center min-w-[400px]">
            <span className="material-icons text-amber-500 mr-2 text-xl">folder</span>
            <span
              className="font-medium cursor-pointer hover:text-primary dark:text-primary transition-colors"
              onClick={() => {
                // 点击目录名：只显示详情侧边栏，不改变勾选状态
                data.onFileSelect([item], false) // 传递 isFromCheckbox=false
              }}
            >
              {item.name}
            </span>
          </td>
        )}
        {data.shouldShowField && data.shouldShowField('qualityScore') && (
          <td className="p-2 whitespace-nowrap">{/* 目录没有评分 */}</td>
        )}
        {data.shouldShowField && data.shouldShowField('description') && (
          <td className="p-2 whitespace-nowrap">{/* 目录没有描述 */}</td>
        )}
        {data.shouldShowField && data.shouldShowField('tags') && (
          <td className="p-2 whitespace-nowrap">{/* 目录没有标签 */}</td>
        )}
        {data.shouldShowField && data.shouldShowField('author') && (
          <td className="p-2 whitespace-nowrap">{/* 目录没有作者 */}</td>
        )}
        {data.shouldShowField && data.shouldShowField('language') && (
          <td className="p-2 whitespace-nowrap">{/* 目录没有语言 */}</td>
        )}
        {data.showAnalysisStatus && (
          <td className="p-2 whitespace-nowrap">{/* 目录没有分析状态 */}</td>
        )}
        <td className="p-2 text-foreground/80 dark:text-foreground/80 whitespace-nowrap">
          {new Date(item.modifiedAt).toLocaleString('zh-CN')}
        </td>
        <td className="p-2 text-foreground/80 dark:text-foreground/80 whitespace-nowrap">
          {t('文件夹')}
        </td>
        <td className="p-2 text-foreground/80 dark:text-foreground/80 whitespace-nowrap"></td>
      </tr>
    )
  }

  const fileItem = item as FileType
  const rowClass = [
    'transition-colors file-row',
    !isActive && 'hover:bg-accent/40 dark:hover:bg-accent/40',
    isSelected && 'selected bg-accent/70 dark:bg-accent/70',
    isActive && 'active bg-primary/20 dark:bg-primary/30'
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <tr key={item.path || index} className={rowClass}>
        <td className="p-2 w-10 text-center">
          <input
            type="checkbox"
            className="w-4 h-4 rounded border-gray-300 dark:border-gray-600 text-primary focus:ring-primary cursor-pointer"
            checked={isSelected}
            onChange={e => {
              const newSelected = e.target.checked
                ? [...data.selectedFiles, fileItem]
                : data.selectedFiles.filter((f: FileType) => {
                    // 使用更健壮的路径比较
                    const normalizedPath1 = f.path.replace(/\\/g, '/')
                    const normalizedPath2 = fileItem.path.replace(/\\/g, '/')
                    return normalizedPath1 !== normalizedPath2
                  })
              data.onFileSelect(newSelected, true) // 传递 isFromCheckbox=true
            }}
          />
        </td>
      {data.showsmartName && (
        <td
          className="p-2 text-foreground/80 dark:text-foreground/80 whitespace-nowrap min-w-[400px]"
          title={fileItem.description || ''}
        >
          <div className="flex items-start">
            <span className="material-icons text-primary mr-2 text-xl flex-shrink-0">
              description
            </span>
            <div className="flex flex-col min-w-0 flex-1">
              <span
                className="font-medium cursor-pointer hover:text-primary dark:text-primary transition-colors truncate"
                onClick={e => {
                  e.stopPropagation() // 阻止事件冒泡到行点击处理
                  data.onFileSelect([fileItem], false)
                }}
                onDoubleClick={async e => {
                  e.stopPropagation()
                  try {
                    if (window.electronAPI) {
                      await window.electronAPI!.utils.openFileWithDefaultApp(fileItem.path)
                    }
                  } catch (error) {
                    logger.error(LogCategory.RENDERER, '打开文件失败:', error)
                  }
                }}
              >
                {fileItem.smartName || '-'}
              </span>
              <span className="text-xs text-muted-foreground truncate mt-0.5">
                {fileItem.relativePathPrefix
                  ? `${fileItem.relativePathPrefix}/${fileItem.name}`
                  : fileItem.name}
              </span>
            </div>
          </div>
        </td>
      )}
      {!data.showsmartName && (
        <td className="p-2 min-w-[400px]">
          <div className="flex items-center">
            <span className="material-icons text-primary mr-2 text-xl">description</span>
            <span
              className="font-medium cursor-pointer hover:text-primary dark:text-primary transition-colors"
              onClick={e => {
                e.stopPropagation() // 阻止事件冒泡到行点击处理
                data.onFileSelect([fileItem], false)
              }}
              onDoubleClick={async e => {
                e.stopPropagation()
                try {
                  if (window.electronAPI) {
                    await window.electronAPI!.utils.openFileWithDefaultApp(fileItem.path)
                  }
                } catch (error) {
                  logger.error(LogCategory.RENDERER, '打开文件失败:', error)
                }
              }}
            >
              {fileItem.name}
            </span>
          </div>
        </td>
      )}
      {data.shouldShowField && data.shouldShowField('qualityScore') && (
        <td className="p-2 text-foreground/80 dark:text-foreground/80 whitespace-nowrap">
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
          className="p-2 text-foreground/80 dark:text-foreground/80 max-w-xs"
          title={fileItem.description || ''}
        >
          <div className="line-clamp-2 text-sm leading-relaxed">
            {fileItem.description || (
              <span className="text-muted-foreground dark:text-muted-foreground">-</span>
            )}
          </div>
        </td>
      )}
      {data.shouldShowField && data.shouldShowField('tags') && (
        <td className="p-2">
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
        <td className="p-2 text-foreground/80 dark:text-foreground/80 whitespace-nowrap">
          {fileItem.author || (
            <span className="text-muted-foreground dark:text-muted-foreground">-</span>
          )}
        </td>
      )}
      {data.shouldShowField && data.shouldShowField('language') && (
        <td className="p-2 text-foreground/80 dark:text-foreground/80 whitespace-nowrap">
          {fileItem.language || (
            <span className="text-muted-foreground dark:text-muted-foreground">-</span>
          )}
        </td>
      )}
      {data.showAnalysisStatus && (
        <td className="p-2 whitespace-nowrap">
          {renderAnalysisStatus(getFileAnalysisStatus(fileItem), getFileAnalysisError(fileItem))}
        </td>
      )}
      <td className="p-2 text-foreground/80 dark:text-foreground/80 whitespace-nowrap">
        {new Date(fileItem.modifiedAt).toLocaleString('zh-CN')}
      </td>
      <td className="p-2 text-foreground/80 dark:text-foreground/80 whitespace-nowrap">
        {fileItem.extension || t('文件')}
      </td>
      <td className="p-2 text-foreground/80 dark:text-foreground/80 whitespace-nowrap">
        {formatFileSize(fileItem.size)}
      </td>
    </tr>
  )
}

interface GridCellProps {
  columnIndex: number
  rowIndex: number
  style: React.CSSProperties
  data: any
}

const GridCell: React.FC<GridCellProps> = (props) => {
  const { columnIndex, rowIndex, style, data } = props;
  if (!style || !data) return null

  const {
    items,
    columnCount,
    selectedFiles,
    activeItem,
    onFileSelect,
    onDirectoryChange,
    getAllFilesInDirectory,
    isImageFile,
    showsmartName,
    isRealDirectory,
    workspaceDirectoryPath,
    refreshKey
  } = data

  if (!items || !Array.isArray(items)) return <div style={style} />;

  const index = rowIndex * columnCount + columnIndex
  if (index >= items.length) return <div style={style} />

  const item = items[index]
  if (!item) return <div style={style} />

  const itemPath = item.path ? item.path.replace(/\\/g, '/') : ''

  const isSelected = Array.isArray(selectedFiles) && selectedFiles.some((f: any) => {
    const normalizedPath1 = f?.path ? f.path.replace(/\\/g, '/') : ''
    return normalizedPath1 && itemPath && normalizedPath1 === itemPath
  })

  const activePath = activeItem?.path ? activeItem.path.replace(/\\/g, '/') : ''
  const isActive = activePath && itemPath === activePath

  const isDirectory = 'isDirectory' in item && item.isDirectory
  const fileItem = !isDirectory ? (item as FileType) : null
  const showThumbnail = fileItem && typeof isImageFile === 'function' && isImageFile(fileItem.extension)

  // Adjust style to add gap (safely handle react-window v1/v2 style types)
  const itemStyle = {
    ...style,
    left: typeof style?.left === 'number' ? style.left + 8 : (style?.left || 0),
    top: typeof style?.top === 'number' ? style.top + 8 : (style?.top || 0),
    width: typeof style?.width === 'number' ? style.width - 16 : (style?.width || '100%'),
    height: typeof style?.height === 'number' ? style.height - 16 : (style?.height || '100%')
  }

  const containerClass = cn(
    'group relative flex flex-col items-center p-3 rounded-xl  transition-all duration-200 cursor-pointer',
    // Base styles with visible hover backgrounds
    'bg-card border-border/40 shadow-sm',
    !isActive &&
      'hover:bg-accent/40 dark:hover:bg-accent/40 hover:shadow-md hover:border-primary/20 hover:-translate-y-0.5',
    // Dark mode base
    'dark:bg-secondary/10 dark:border-white/5',
    // Checked state (checkbox selection) - visible accent color
    isSelected && 'ring-2 ring-primary/50 bg-accent dark:bg-accent border-transparent',
    // Active state (properties panel selection) - distinct primary color (NOT accent)
    isActive && 'bg-primary/20 dark:bg-primary/20 shadow-lg z-10'
  )

  const safeItemName = item.name || t('未知文件');

  return (
    <div
      style={itemStyle}
      className={containerClass}
      onClick={e => {
        const isCheckboxClick = (e.target as HTMLElement).tagName === 'INPUT'
        if (!isCheckboxClick) {
          onFileSelect([item], false)
        }
      }}
      onDoubleClick={async () => {
        if (!item.path) return;
        if (isDirectory) {
          onDirectoryChange(item.path)
        } else {
          try {
            if (window.electronAPI) {
              await window.electronAPI!.utils.openFileWithDefaultApp(item.path)
            }
          } catch (error) {
            logger.error(LogCategory.RENDERER, '打开文件失败:', error)
          }
        }
      }}
    >
      {/* Checkbox - Visible on hover or selected */}
      <div
        className={cn(
          'absolute top-3 left-3 z-20 transition-opacity duration-200',
          isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        )}
      >
        <input
          className="w-5 h-5 rounded border-gray-300 dark:border-gray-600 text-primary focus:ring-primary cursor-pointer shadow-sm"
          type="checkbox"
          checked={isSelected}
          onChange={e => {
            if (!item.path) return;
            if (isDirectory) {
              if (e.target.checked) {
                const allFilesInDir = typeof getAllFilesInDirectory === 'function' ? getAllFilesInDirectory(item.path) : []
                const newSelected = [...new Set([...(selectedFiles || []), item, ...allFilesInDir])]
                onFileSelect(newSelected, true)
              } else {
                const allFilesInDir = typeof getAllFilesInDirectory === 'function' ? getAllFilesInDirectory(item.path) : []
                const filesToRemove = [item, ...allFilesInDir].map((file: any) =>
                  (file?.path || '').replace(/\\/g, '/')
                )
                const newSelected = (selectedFiles || []).filter((f: any) => {
                  const normalizedPath = (f?.path || '').replace(/\\/g, '/')
                  return normalizedPath && !filesToRemove.includes(normalizedPath)
                })
                onFileSelect(newSelected, true)
              }
            } else {
              const newSelected = e.target.checked
                ? [...(selectedFiles || []), item]
                : (selectedFiles || []).filter((f: any) => {
                    const normalizedPath1 = (f?.path || '').replace(/\\/g, '/')
                    return normalizedPath1 && normalizedPath1 !== itemPath
                  })
              onFileSelect(newSelected, true)
            }
          }}
          onClick={e => e.stopPropagation()}
          onDoubleClick={e => e.stopPropagation()}
        />
      </div>

      {/* Thumbnail Container */}
      <div className="w-full aspect-square flex items-center justify-center mb-3 overflow-hidden rounded-lg bg-gray-50 dark:bg-gray-800/50 relative group-hover:bg-accent/40 dark:group-hover:bg-gray-800 transition-colors">
        {(() => {
          if (!fileItem) return (
            <div className="transform transition-transform duration-300 group-hover:scale-110 drop-shadow-sm flex items-center justify-center w-full h-full">
              <div className="scale-[1.2] opacity-70">
                {getFileIcon('directory', '')}
              </div>
            </div>
          );

          let baseUrl = '';
          if (fileItem.thumbnailPath && workspaceDirectoryPath) {
            baseUrl = `file://${workspaceDirectoryPath.replace(/\\/g, '/')}/${fileItem.thumbnailPath.replace(/\\/g, '/')}`;
          } else if (typeof isImageFile === 'function' && isImageFile(fileItem.extension)) {
            // 【关键修复】对于未分析的图片文件，直接显示原图
            const normalizedPath = fileItem.path.replace(/\\/g, '/');
            baseUrl = `file://${normalizedPath}`;
            logger.debug(LogCategory.RENDERER, `未分析图片，显示原图: ${fileItem.name}, path: ${normalizedPath}, isAnalyzed: ${fileItem.isAnalyzed}`);
          }

          if (baseUrl) {
            const finalUrl = refreshKey ? `${baseUrl}?t=${refreshKey}` : baseUrl;
            return (
              <img
                src={finalUrl}
                alt={safeItemName}
                loading="lazy"
                className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110"
                onError={e => {
                  const target = e.target as HTMLImageElement;
                  target.style.display = 'none';
                  const parent = target.parentElement;
                  if (parent) {
                    const fallbackIcon = document.createElement('div');
                    fallbackIcon.className = 'scale-[1.2] opacity-70';
                    // Fallback to icon rendered natively or simple text/shape if icon missing
                  }
                }}
              />
            );
          }

          return (
            <div className="transform transition-transform duration-300 group-hover:scale-110 drop-shadow-sm flex items-center justify-center w-full h-full">
              <div className="scale-[1.2] opacity-70">
                {getFileIcon('file', fileItem.extension || '')}
              </div>
            </div>
          );
        })()}
      </div>

      {/* File Name */}
      <div
        className="text-sm font-medium text-center truncate w-full px-1 text-gray-700 dark:text-gray-100 group-hover:text-primary transition-colors"
        title={
          showsmartName && fileItem?.smartName
            ? fileItem.smartName
            : fileItem?.relativePathPrefix
              ? `${fileItem.relativePathPrefix}/${safeItemName}`
              : safeItemName
        }
      >
        {showsmartName && fileItem?.smartName ? fileItem.smartName : safeItemName}
      </div>
      {/* File Path - Show relative path in Virtual Directory mode */}
      {showsmartName && fileItem && (
        <div className="text-xs text-muted-foreground mt-1 truncate w-full px-1 text-center">
          {fileItem.relativePathPrefix
            ? `${fileItem.relativePathPrefix}/${safeItemName}`
            : safeItemName}
        </div>
      )}

      {/* File Size */}
      <div className="text-xs text-gray-400 dark:text-gray-500 mt-1 font-medium">
        {isDirectory ? '' : formatFileSize(fileItem?.size)}
      </div>
    </div>
  )
}

// 虚拟化列表行渲染器
const VirtualRowRenderer: React.FC<RowRendererProps> = ({ index, style, data }) => {
  const { 
    items, 
    selectedFiles, 
    activeItem, 
    onFileSelect, 
    onDirectoryChange, 
    showsmartName,
    shouldShowField,
    showAnalysisStatus,
    getAllFilesInDirectory,
    workspaceDirectoryPath
  } = data;

  const item = (items && items.length > index) ? items[index] : null;
  if (!item) return <div style={style} />;

  const itemPath = item.path ? item.path.replace(/\\/g, '/') : '';
  
  const isSelected = Array.isArray(selectedFiles) && selectedFiles.some(f => {
    const fPath = f?.path ? f.path.replace(/\\/g, '/') : '';
    return fPath && itemPath && fPath === itemPath;
  })
  
  const activePath = activeItem?.path ? activeItem.path.replace(/\\/g, '/') : '';
  const isActive = activePath && itemPath === activePath;
  
  const isDirectory = item && 'isDirectory' in item && item.isDirectory
  const fileItem = !isDirectory ? (item as FileType) : null
  
  // 简化的状态获取，避免在行渲染中进行重度计算
  const analysisStatus = fileItem?.isAnalyzed ? 'completed' : undefined;

  const rowClass = cn(
    'flex items-center text-sm border-b border-border/30 transition-colors file-row w-full',
    !isActive && 'hover:bg-accent/40 dark:hover:bg-accent/40',
    isSelected && 'selected bg-accent/70 dark:bg-accent/70',
    isActive && 'active bg-primary/20 dark:bg-primary/30'
  )

  const safeItemName = item.name || t('未知文件');

  return (
    <div 
      style={style} 
      className={rowClass}
      onClick={(e) => {
        const target = e.target as HTMLElement
        if (target.tagName !== 'INPUT' && !target.closest('input')) {
          onFileSelect([item], false)
        }
      }}
      onDoubleClick={() => {
        if (!item.path) return;
        if (isDirectory) {
          onDirectoryChange(item.path)
        } else {
          window.electronAPI!.utils.openFileWithDefaultApp(item.path).catch((e: Error) => {
            logger.error(LogCategory.RENDERER, '打开文件失败:', e)
          })
        }
      }}
    >
      {/* Checkbox */}
      <div className="w-10 flex-shrink-0 flex justify-center p-2">
        <input
          type="checkbox"
          className="w-4 h-4 rounded border-gray-300 dark:border-gray-600 text-primary focus:ring-primary cursor-pointer"
          checked={isSelected}
          onChange={e => {
            if (!item.path) return;
            if (isDirectory) {
              const { checked } = e.target
              const allChildItems = typeof getAllFilesInDirectory === 'function' ? getAllFilesInDirectory(item.path) : []
              const itemsToSelect = [item, ...allChildItems]

              if (checked) {
                const newSelected = [...new Set([...(selectedFiles || []), ...itemsToSelect])]
                onFileSelect(newSelected, true)
              } else {
                const pathsToRemove = new Set(itemsToSelect.map(i => (i.path || '').replace(/\\/g, '/')))
                const newSelected = (selectedFiles || []).filter(f => {
                  const fPath = (f?.path || '').replace(/\\/g, '/');
                  return fPath && !pathsToRemove.has(fPath);
                })
                onFileSelect(newSelected, true)
              }
            } else {
              const newSelected = e.target.checked
                ? [...(selectedFiles || []), fileItem!]
                : (selectedFiles || []).filter(f => {
                    const fPath = (f?.path || '').replace(/\\/g, '/');
                    return fPath && fPath !== itemPath;
                  })
              onFileSelect(newSelected, true)
            }
          }}
          onClick={e => e.stopPropagation()}
        />
      </div>

      {/* Name / SmartName */}
      <div className="flex-1 min-w-[300px] flex items-center p-2 truncate">
        <span className={cn("material-icons mr-2 text-xl flex-shrink-0", isDirectory ? "text-amber-500" : "text-primary")}>
          {isDirectory ? "folder" : "description"}
        </span>
        <div className="flex flex-col min-w-0">
          <span 
            className="font-medium truncate text-primary cursor-pointer transition-colors"
            onClick={(e) => {
              e.stopPropagation()
              onFileSelect([item], false)
            }}
            onDoubleClick={async (e) => {
              e.stopPropagation()
              if (!item.path) return;
              if (isDirectory) {
                onDirectoryChange(item.path)
              } else {
                try {
                  if (window.electronAPI) {
                    await window.electronAPI!.utils.openFileWithDefaultApp(item.path)
                  }
                } catch (error) {
                  logger.error(LogCategory.RENDERER, '打开文件失败:', error)
                }
              }
            }}
          >
            {showsmartName && fileItem?.smartName ? fileItem.smartName : safeItemName}
          </span>
          {showsmartName && fileItem && (            <span className="text-xs text-gray-400 truncate">
              {fileItem.relativePathPrefix ? `${fileItem.relativePathPrefix}/${fileItem.name}` : safeItemName}
            </span>
          )}
        </div>
      </div>

      {/* Optional Fields */}
      {typeof shouldShowField === 'function' && shouldShowField('qualityScore') && (
        <div className="w-22 flex-shrink-0 p-2">
          {fileItem?.qualityScore ? (
            <div className="flex text-primary">
              {getQualityScoreStars(fileItem.qualityScore).stars.map((s, i) => (
                <span key={i}>{s === 'star' ? '★' : '☆'}</span>
              ))}
            </div>
          ) : "-"}
        </div>
      )}
      
      {typeof shouldShowField === 'function' && shouldShowField('description') && (
        <div className="w-48 flex-shrink-0 p-2 truncate text-foreground/70" title={fileItem?.description || ''}>
          {fileItem?.description || "-"}
        </div>
      )}

      {typeof shouldShowField === 'function' && shouldShowField('tags') && (
        <div className="w-64 flex-shrink-0 p-2 truncate">
          {fileItem?.tags && fileItem.tags.length > 0 ? (
            <div className="flex gap-1 overflow-hidden">
              {fileItem.tags.slice(0, 3).map((t, i) => (
                <span key={i} className="text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded">{t}</span>
              ))}
            </div>
          ) : "-"}
        </div>
      )}

      {typeof shouldShowField === 'function' && shouldShowField('author') && (
        <div className="w-32 flex-shrink-0 p-2 truncate">{fileItem?.author || "-"}</div>
      )}

      {typeof shouldShowField === 'function' && shouldShowField('language') && (
        <div className="w-24 flex-shrink-0 p-2 truncate">{fileItem?.language || "-"}</div>
      )}

      {showAnalysisStatus && (
        <div className="w-24 flex-shrink-0 p-2">{isDirectory ? "" : renderAnalysisStatus(analysisStatus as any)}</div>
      )}

      <div className="w-32 flex-shrink-0 p-2 text-xs text-foreground/60">
        {item.modifiedAt ? new Date(item.modifiedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-'}
      </div>
      
      <div className="w-20 flex-shrink-0 p-2 text-xs text-foreground/60 truncate">
        {isDirectory ? t('文件夹') : (fileItem?.extension || t('文件'))}
      </div>

      <div className="w-20 flex-shrink-0 p-2 text-xs text-foreground/60 text-right pr-4">
        {isDirectory ? "" : formatFileSize(fileItem?.size)}
      </div>
    </div>
  )
}

export const FileList: React.FC<FileListProps> = ({
  files,
  directories,
  selectedFiles,
  activeItem,
  onFileSelect,
  onDirectoryChange,
  loading = false,
  viewMode = 'list',
  currentPath,
  showAnalysisStatus = true, // 默认显示分析状态列
  showsmartName = false, // 默认不显示智能文件名列
  isRealDirectory = false, // 默认不是真实目录模式
  sortBy: propSortBy,
  sortOrder: propSortOrder,
  disableClientSort = false,
  onSortChange,
  workspaceDirectoryPath, // 工作目录路径（用于解析缩略图路径）
  refreshKey
}) => {
  const [reactWindowAvailable, setReactWindowAvailable] = useState(false)
  const listRef = useRef<any>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })

  const { expandedDirectories } = useFileExplorerStore()
  const { snapshot } = useAnalysisQueueStore()
  const { shouldShowField, getFieldLabel } = useFileDisplaySettings(isRealDirectory)

  // 性能优化：预先计算已分析文件的路径集合，避免在 RowRenderer 循环中进行 O(n) 查找
  const isAnalyzedPathSet = useMemo(() => {
    const set = new Set<string>()
    // 基础文件的分析状态
    files.forEach(f => {
      if (f.isAnalyzed) set.add(f.path.replace(/\\/g, '/'))
    })
    // 队列中已完成的状态
    snapshot.items.forEach(item => {
      if (item.status === 'completed') {
        set.add(item.path.replace(/\\/g, '/'))
      }
    })
    return set
  }, [files, snapshot.items])

  // 使用传入的 sortBy/sortOrder，如果没有则从 store 中获取
  const storeSortBy = useFileExplorerStore(state => state.sortBy)
  const storeSortOrder = useFileExplorerStore(state => state.sortOrder)
  const sortBy = propSortBy || storeSortBy
  const sortOrder = propSortOrder || storeSortOrder

  // 获取文件的分析状态
  const getFileAnalysisStatus = useCallback(
    (file: FileType): AnalysisStatus | undefined => {
      const normalizedPath = file.path.replace(/\\/g, '/')
      // 首先检查队列中的实时状态
      const queueItem = snapshot.items.find(
        item => item.path.replace(/\\/g, '/') === normalizedPath
      )
      if (queueItem) return queueItem.status
      
      // 降级检查已缓存的静态分析集合
      if (isAnalyzedPathSet.has(normalizedPath)) return 'completed'
      
      return undefined
    },
    [snapshot.items, isAnalyzedPathSet]
  )

  // 检查文件是否是图片
  const isImageFile = useCallback((extension?: string) => {
    if (!extension) return false
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.tiff', '.tif', '.ico', '.avif']
    const isImage = imageExtensions.includes(extension.toLowerCase())
    if (isImage) {
      logger.debug(LogCategory.RENDERER, `文件是图片类型，显示原图: ${extension}`)
    }
    return isImage
  }, [])

  const items = useMemo(() => {
    const dirs = directories.filter(dir => dir.parentPath === currentPath)
    const allItems = [...dirs, ...files]
    if (disableClientSort) return allItems

    // 客户端排序逻辑
    if (sortBy) {
      allItems.sort((a, b) => {
        let valA: any
        let valB: any

        // 统一处理属性获取
        switch (sortBy) {
          case 'name':
            valA = a.name.toLowerCase()
            valB = b.name.toLowerCase()
            break
          case 'size':
            valA = 'isDirectory' in a ? 0 : (a as FileType).size || 0
            valB = 'isDirectory' in b ? 0 : (b as FileType).size || 0
            break
          case 'modified':
            valA = new Date(a.modifiedAt || 0).getTime()
            valB = new Date(b.modifiedAt || 0).getTime()
            break
          case 'type':
            valA = 'isDirectory' in a ? '00_dir' : (a as FileType).extension || ''
            valB = 'isDirectory' in b ? '00_dir' : (b as FileType).extension || ''
            break
          case 'smartName':
            valA = ('isDirectory' in a ? a.name : (a as FileType).smartName || a.name).toLowerCase()
            valB = ('isDirectory' in b ? b.name : (b as FileType).smartName || b.name).toLowerCase()
            break
          case 'qualityScore':
            valA = 'isDirectory' in a ? 0 : (a as FileType).qualityScore || 0
            valB = 'isDirectory' in b ? 0 : (b as FileType).qualityScore || 0
            break
          case 'author':
            valA = 'isDirectory' in a ? '' : (a as FileType).author || ''
            valB = 'isDirectory' in b ? '' : (b as FileType).author || ''
            break
          case 'language':
            valA = 'isDirectory' in a ? '' : (a as FileType).language || ''
            valB = 'isDirectory' in b ? '' : (b as FileType).language || ''
            break
          case 'analysisStatus':
            valA = 'isDirectory' in a ? '' : getFileAnalysisStatus(a as FileType) || ''
            valB = 'isDirectory' in b ? '' : getFileAnalysisStatus(b as FileType) || ''
            break
          default:
            valA = 0
            valB = 0
        }

        if (valA < valB) return sortOrder === 'asc' ? -1 : 1
        if (valA > valB) return sortOrder === 'asc' ? 1 : -1
        return 0
      })
      
      // 保证目录始终在最上方
      allItems.sort((a, b) => {
        const isDirA = 'isDirectory' in a && a.isDirectory
        const isDirB = 'isDirectory' in b && b.isDirectory
        if (isDirA && !isDirB) return -1
        if (!isDirA && isDirB) return 1
        return 0
      })
    }

    return allItems
  }, [directories, files, currentPath, disableClientSort, sortBy, sortOrder, getFileAnalysisStatus])


  // 递归获取目录下所有文件的函数
  const getAllFilesInDirectory = useCallback(
    (dirPath: string): (FileType | DirectoryItem)[] => {
      // 检查缓存
      if (directoryCache.has(dirPath)) {
        return directoryCache.get(dirPath)!
      }

      // 使用Set避免重复
      const resultSet = new Set<FileType | DirectoryItem>()

      // 添加当前目录本身
      const currentDir = items.find(
        item =>
          'isDirectory' in item &&
          item.isDirectory &&
          item.path.replace(/\\/g, '/') === dirPath.replace(/\\/g, '/')
      )
      if (currentDir) {
        resultSet.add(currentDir)
      }

      // 使用队列进行广度优先搜索，避免深度递归
      const queue = [dirPath]
      const visited = new Set<string>()

      while (queue.length > 0) {
        const currentPath = queue.shift()!
        if (visited.has(currentPath.replace(/\\/g, '/'))) continue
        visited.add(currentPath.replace(/\\/g, '/'))

        // 获取当前路径下的所有文件和目录
        const currentFiles = items.filter(item => {
          if ('isDirectory' in item && item.isDirectory) {
            // 目录：检查是否是当前路径的直接子目录
            return item.parentPath.replace(/\\/g, '/') === currentPath.replace(/\\/g, '/')
          } else {
            // 文件：检查是否在当前路径下
            const filePath = (item as FileType).path
            // 标准化路径分隔符
            const normalizedFilePath = filePath.replace(/\\/g, '/')
            const normalizedCurrentPath = currentPath.replace(/\\/g, '/')

            // 检查文件路径是否以当前路径开头，并且后面跟着路径分隔符
            return (
              normalizedFilePath.startsWith(normalizedCurrentPath + '/') &&
              normalizedFilePath !== normalizedCurrentPath
            )
          }
        })

        currentFiles.forEach(file => {
          resultSet.add(file)
          // 如果是目录，加入队列继续搜索
          if ('isDirectory' in file && file.isDirectory) {
            queue.push(file.path)
          }
        })
      }

      const result = Array.from(resultSet)
      // 更新缓存
      directoryCache.set(dirPath, result)
      return result
    },
    [items]
  )

  const itemData: ListItemData = useMemo(
    () => ({
      items,
      selectedFiles,
      activeItem,
      onFileSelect,
      onDirectoryChange,
      viewMode: viewMode,
      showAnalysisStatus,
      showsmartName,
      shouldShowField,
      isRealDirectory,
      getAllFilesInDirectory,
      isImageFile,
      refreshKey,
      workspaceDirectoryPath,
      isAnalyzedPathSet
    }),
    [
      items,
      selectedFiles,
      activeItem,
      onFileSelect,
      onDirectoryChange,
      viewMode,
      showAnalysisStatus,
      showsmartName,
      shouldShowField,
      isRealDirectory,
      getAllFilesInDirectory,
      isImageFile,
      refreshKey,
      workspaceDirectoryPath,
      isAnalyzedPathSet
    ]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        // 使用更高效的全选方式，避免传递大量文件对象
        onFileSelect(
          items.map(item => item.path),
          true
        ) // 传递路径数组而不是文件对象
      } else if (e.key === 'Escape') {
        onFileSelect([], true) // 传递 isFromCheckbox=true
      }
    },
    [items, onFileSelect]
  )

  useEffect(() => {
    // 检查react-window是否已加载
    const checkReactWindow = () => {
      if (isReactWindowLoaded && ListComponent) {
        setReactWindowAvailable(true)
      } else if (!isReactWindowLoaded) {
        // 如果还未加载完成，稍后再检查
        setTimeout(checkReactWindow, 100)
      }
    }

    checkReactWindow()
  }, [])

  useEffect(() => {
    if (!containerRef.current) return

    const observer = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      setContainerSize({ width, height })
    })

    observer.observe(containerRef.current)

    return () => observer.disconnect()
  }, [viewMode])

  useEffect(() => {
    if (listRef.current) {
      try {
        if (viewMode === 'list') {
          if (typeof listRef.current.scrollToItem === 'function') {
            listRef.current.scrollToItem(0)
          } else if (typeof listRef.current.scrollTo === 'function') {
            listRef.current.scrollTo(0)
          }
        } else if (viewMode === 'grid') {
          // Grid组件的滚动方法与List组件不同
          if (typeof listRef.current.scrollToItem === 'function') {
            listRef.current.scrollToItem({ columnIndex: 0, rowIndex: 0 })
          } else if (typeof listRef.current.scrollTo === 'function') {
            listRef.current.scrollTo({ scrollLeft: 0, scrollTop: 0 })
          }
        }
      } catch (error) {
        logger.warn(LogCategory.RENDERER, 'Failed to scroll list to top:', error)
      }
    }
  }, [items, viewMode])

  if (loading) {
    return (
      <div className="file-list-loading">
        <div className="loading-spinner">{t('加载中...')}</div>
      </div>
    )
  }

  if (viewMode === 'list') {
    const getSortIcon = (column: string) => {
      if (sortBy !== column) return null
      return sortOrder === 'asc' ? (
        <MaterialIcon icon="arrow_upward" className="text-xs ml-1" />
      ) : (
        <MaterialIcon icon="arrow_downward" className="text-xs ml-1" />
      )
    }

    const getHeaderClass = (column: string, baseClass: string) => {
      return cn(
        baseClass,
        'cursor-pointer hover:bg-accent/50 transition-colors flex items-center',
        sortBy === column ? 'text-primary font-bold' : ''
      )
    }

    const handleHeaderClick = (
      column:
        | 'name'
        | 'size'
        | 'modified'
        | 'type'
        | 'smartName'
        | 'analysisStatus'
        | 'author'
        | 'qualityScore'
        | 'language'
    ) => {
      if (onSortChange) {
        const newSortOrder = sortBy === column ? (sortOrder === 'asc' ? 'desc' : 'asc') : 'asc'
        onSortChange(column, newSortOrder)
      } else {
        const { setSortBy, toggleSortOrder } = useFileExplorerStore.getState()
        if (sortBy === column) {
          toggleSortOrder()
        } else {
          setSortBy(column as any)
        }
      }
    }

    // 性能优化：不再在渲染时执行复杂的 items.every，而是使用更轻量的方式或延迟计算
    const isAllSelected = items.length > 0 && selectedFiles.length >= items.length;

    return (
      <div className="w-full h-full flex flex-col bg-card overflow-hidden" ref={containerRef}>
        {/* Header - Fixed */}
        <div className="flex items-center text-xs font-medium text-foreground/70 bg-muted/50 border-b border-border sticky top-0 z-10 select-none uppercase tracking-wider">
          <div className="w-10 flex-shrink-0 flex justify-center p-2">
            <input
              type="checkbox"
              className="rounded border-input text-primary focus:ring-ring cursor-pointer"
              checked={isAllSelected}
              onChange={() => {
                if (isAllSelected) {
                  const visiblePaths = new Set(items.map(it => it.path))
                  onFileSelect(selectedFiles.filter(f => f && !visiblePaths.has(f.path)), true)
                } else {
                  onFileSelect(items.filter(it => !!it.path).map(it => it.path!), true)
                }
              }}
            />
          </div>
          <div className={getHeaderClass('name', 'flex-1 min-w-[300px] p-2')} onClick={() => handleHeaderClick(showsmartName ? 'smartName' : 'name')}>
            {showsmartName ? t('智能文件名') : t('名称')} {getSortIcon(showsmartName ? 'smartName' : 'name')}
          </div>
          {shouldShowField('qualityScore') && <div className={getHeaderClass('qualityScore', 'w-22 flex-shrink-0 p-2')} onClick={() => handleHeaderClick('qualityScore')}>{getFieldLabel('qualityScore')} {getSortIcon('qualityScore')}</div>}
          {shouldShowField('description') && <div className="w-48 flex-shrink-0 p-2">{getFieldLabel('description')}</div>}
          {shouldShowField('tags') && <div className="w-64 flex-shrink-0 p-2">{getFieldLabel('tags')}</div>}
          {shouldShowField('author') && <div className={getHeaderClass('author', 'w-32 flex-shrink-0 p-2')} onClick={() => handleHeaderClick('author')}>{getFieldLabel('author')} {getSortIcon('author')}</div>}
          {shouldShowField('language') && <div className={getHeaderClass('language', 'w-24 flex-shrink-0 p-2')} onClick={() => handleHeaderClick('language')}>{getFieldLabel('language')} {getSortIcon('language')}</div>}
          {showAnalysisStatus && <div className={getHeaderClass('analysisStatus', 'w-24 flex-shrink-0 p-2')} onClick={() => handleHeaderClick('analysisStatus')}>{t('分析状态')} {getSortIcon('analysisStatus')}</div>}
          <div className={getHeaderClass('modified', 'w-32 flex-shrink-0 p-2')} onClick={() => handleHeaderClick('modified')}>{t('修改日期')} {getSortIcon('modified')}</div>
          <div className={getHeaderClass('type', 'w-20 flex-shrink-0 p-2')} onClick={() => handleHeaderClick('type')}>{t('类型')} {getSortIcon('type')}</div>
          <div className={getHeaderClass('size', 'w-20 flex-shrink-0 p-2 text-right pr-4')} onClick={() => handleHeaderClick('size')}>{t('大小')} {getSortIcon('size')}</div>
        </div>

        {/* List Body - Virtualized */}
        <div className="flex-1 overflow-hidden">
          {reactWindowAvailable && ListComponent && containerSize.height > 40 ? (
            isReactWindowV2 ? (
              <ListComponent
                height={containerSize.height - 40}
                rowCount={items.length}
                rowHeight={48}
                width={containerSize.width || '100%'}
                className="scrollbar-thin"
                listRef={listRef}
                rowProps={{ data: itemData }}
                rowComponent={VirtualRowRenderer}
              />
            ) : (
              <ListComponent
                height={containerSize.height - 40}
                itemCount={items.length}
                itemSize={48}
                width={containerSize.width || '100%'}
                className="scrollbar-thin"
                ref={listRef}
                itemData={itemData}
              >
                {VirtualRowRenderer}
              </ListComponent>
            )
          ) : (
            <div className="p-4 text-center text-muted-foreground">
              {items.length === 0 ? t('目录为空') : t('正在准备列表...')}
            </div>
          )}
        </div>
      </div>
    )
  }
  if (viewMode === 'grid') {
    const minColumnWidth = 180
    const columnCount = Math.max(1, Math.floor(containerSize.width / minColumnWidth))
    const columnWidth = containerSize.width > 0 ? containerSize.width / columnCount : minColumnWidth
    const rowHeight = 240 // Increased height for better spacing
    const rowCount = Math.ceil(items.length / columnCount)

    return (
      <div className="flex-1 h-full flex flex-col overflow-hidden bg-muted dark:bg-muted" ref={containerRef}>
        {reactWindowAvailable && GridComponent && containerSize.width > 0 && containerSize.height > 0 ? (
          <div className="flex-1 overflow-hidden">
            {isReactWindowV2 ? (
              <GridComponent
                columnCount={columnCount}
                columnWidth={columnWidth}
                height={containerSize.height}
                rowCount={rowCount}
                rowHeight={rowHeight}
                width={containerSize.width}
                gridRef={listRef}
                cellProps={{ data: { ...itemData, columnCount } }}
                cellComponent={GridCell}
              />
            ) : (
              <GridComponent
                columnCount={columnCount}
                columnWidth={columnWidth}
                height={containerSize.height}
                rowCount={rowCount}
                rowHeight={rowHeight}
                width={containerSize.width}
                itemData={{ ...itemData, columnCount }}
                ref={listRef}
              >
                {GridCell}
              </GridComponent>
            )}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-4">
            {/* 仅在明确 react-window 加载失败且有尺寸时才渲染全量后备列表，否则显示准备中以避免全量渲染卡顿 */}
            {!reactWindowAvailable && containerSize.width > 0 ? (
              <div
                className="grid gap-4"
                style={{
                  gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))'
                }}
              >
                {items.map((item, index) => {
                  const isSelected = selectedFiles.some(f => {
                    const normalizedPath1 = f.path.replace(/\\/g, '/')
                    const normalizedPath2 = item.path.replace(/\\/g, '/')
                    return normalizedPath1 === normalizedPath2
                  })
                  const isActive =
                    activeItem && item.path.replace(/\\/g, '/') === activeItem.path.replace(/\\/g, '/')
                  const isDirectory = 'isDirectory' in item && item.isDirectory
                  const fileItem = !isDirectory ? (item as FileType) : null
                  const hasThumbnail = fileItem && fileItem.thumbnailPath
                  const showThumbnail = fileItem && (hasThumbnail || isImageFile(fileItem.extension))

                  return (
                    <div
                      key={item.path || index}
                      className={cn(
                        'relative flex flex-col items-center p-3 rounded-lg border transition-all duration-200 cursor-pointer',
                        'bg-card border-border/40 shadow-sm',
                        !isActive &&
                          'hover:bg-accent/20 dark:hover:bg-accent/40 hover:shadow-md hover:border-primary/20 hover:-translate-y-0.5',
                        'dark:bg-secondary/10 dark:border-white/5',
                        isSelected &&
                          'ring-2 ring-primary/50 bg-accent dark:bg-accent border-transparent',
                        isActive && 'bg-secondary dark:bg-primary/10 shadow-lg z-10 border-primary/50'
                      )}
                      onClick={e => {
                        const isCheckboxClick = (e.target as HTMLElement).tagName === 'INPUT'
                        if (!isCheckboxClick) {
                          onFileSelect([item], false)
                        }
                      }}
                      onDoubleClick={async () => {
                        if (isDirectory) {
                          onDirectoryChange(item.path)
                        } else {
                          try {
                            await window.electronAPI?.utils.openFileWithDefaultApp(item.path)
                          } catch (error) {
                            logger.error(LogCategory.RENDERER, '打开文件失败:', error)
                          }
                        }
                      }}
                    >
                      <div className="absolute top-2 left-2 z-10">
                        <input
                          className="rounded border-input dark:border-input text-primary dark:text-primary focus:ring-ring focus:border-primary cursor-pointer"
                          type="checkbox"
                          checked={isSelected}
                          onChange={e => {
                            if (isDirectory) {
                              if (e.target.checked) {
                                const allFilesInDir = getAllFilesInDirectory(item.path)
                                const newSelected = [...selectedFiles, item, ...allFilesInDir]
                                onFileSelect(newSelected, true)
                              } else {
                                const allFilesInDir = getAllFilesInDirectory(item.path)
                                const filesToRemove = [item, ...allFilesInDir].map(file =>
                                  file.path.replace(/\\/g, '/')
                                )
                                const newSelected = selectedFiles.filter(f => {
                                  const normalizedPath = f.path.replace(/\\/g, '/')
                                  return !filesToRemove.some(removePath => {
                                    const normalizedRemovePath = removePath.replace(/\\/g, '/')
                                    return normalizedPath === normalizedRemovePath
                                  })
                                })
                                onFileSelect(newSelected, true)
                              }
                            } else {
                              const newSelected = e.target.checked
                                ? [...selectedFiles, item]
                                : selectedFiles.filter(f => {
                                    const normalizedPath1 = f.path.replace(/\\/g, '/')
                                    const normalizedPath2 = (item as FileType).path.replace(/\\/g, '/')
                                    return normalizedPath1 !== normalizedPath2
                                  })
                              onFileSelect(newSelected, true)
                            }
                          }}
                          onClick={e => e.stopPropagation()}
                          onDoubleClick={e => e.stopPropagation()}
                        />
                      </div>

                      <div className="w-20 h-20 flex items-center justify-center mb-2 overflow-hidden rounded text-muted-foreground dark:text-muted-foreground">
                        {showThumbnail ? (
                          <img
                            src={
                              hasThumbnail && fileItem!.thumbnailPath && workspaceDirectoryPath
                                ? `file://${workspaceDirectoryPath.replace(/\\/g, '/')}/${fileItem!.thumbnailPath.replace(/\\/g, '/')}${refreshKey ? `?t=${refreshKey}` : ''}`
                                : `file://${fileItem!.path}${refreshKey ? `?t=${refreshKey}` : ''}`
                            }
                            alt={item.name}
                            loading="lazy"
                            className="w-full h-full object-cover"
                            onError={e => {
                              const target = e.target as HTMLImageElement
                              target.style.display = 'none'
                              const parent = target.parentElement
                              if (parent) {
                                const iconContainer = document.createElement('div')
                                iconContainer.className = 'scale-[1.2] opacity-70'
                                parent.appendChild(iconContainer)
                              }
                            }}
                          />
                        ) : (
                          <div className="scale-[1.2] opacity-70">
                            {getFileIcon(isDirectory ? 'directory' : 'file', fileItem?.extension || '')}
                          </div>
                        )}
                      </div>
                      <div
                        className="text-sm font-medium text-center truncate w-full text-primary dark:text-primary"
                        title={showsmartName && fileItem?.smartName ? fileItem.smartName : item.name}
                      >
                        {showsmartName && fileItem?.smartName ? fileItem.smartName : item.name}
                      </div>
                      {showsmartName && fileItem && (
                        <div className="text-xs text-gray-400 text-center truncate w-full mt-0.5">
                          {fileItem.relativePathPrefix
                            ? `${fileItem.relativePathPrefix}/${fileItem.name}`
                            : fileItem.name}
                        </div>
                      )}
                      <div className="text-xs text-muted-foreground dark:text-muted-foreground mt-1">
                        {isDirectory ? '' : formatFileSize(fileItem?.size)}
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="p-4 text-center text-muted-foreground flex items-center justify-center h-full">
                {items.length === 0 ? t('目录为空') : t('正在准备网格...')}
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  // 默认返回列表视图
  return (
    <div className="flex-1 overflow-x-auto overflow-y-auto">
      <table
        className="text-sm text-left"
        style={{ minWidth: showsmartName ? '1400px' : '1000px' }}
      >
        <colgroup>
          <col style={{ width: '32px' }} />
          {showsmartName && <col style={{ minWidth: '400px' }} />}
          {!showsmartName && <col style={{ minWidth: '400px' }} />}
          {shouldShowField('qualityScore') && <col style={{ width: '120px' }} />}
          {shouldShowField('description') && <col style={{ minWidth: '200px' }} />}
          {shouldShowField('tags') && <col style={{ minWidth: '400px' }} />}
          {shouldShowField('author') && <col style={{ width: '120px' }} />}
          {shouldShowField('language') && <col style={{ width: '100px' }} />}
          {showAnalysisStatus && <col style={{ width: '120px' }} />}
          <col style={{ width: '180px' }} />
          <col style={{ width: '100px' }} />
          <col style={{ width: '100px' }} />
        </colgroup>
        <thead className="bg-muted/30 sticky top-0 z-10 border-b border-border/50">
          <tr className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
            <th className="p-2 w-10">
              <input
                type="checkbox"
                className="rounded border-input text-primary focus:ring-ring cursor-pointer"
                checked={selectedFiles.length === items.length && items.length > 0}
                onChange={e => {
                  if (e.target.checked) {
                    onFileSelect(
                      items.map(item => item.path),
                      true
                    )
                  } else {
                    onFileSelect([], true)
                  }
                }}
                title={
                  selectedFiles.length === items.length && items.length > 0
                    ? t('取消全选')
                    : t('全选所有项目')
                }
              />
            </th>
            {showsmartName && (
              <th
                className="p-2 font-medium whitespace-nowrap truncate hover:bg-accent/40 cursor-default transition-colors"
                title={t('AI生成的智能文件名')}
              >
                {t('智能文件名')}
              </th>
            )}
            {!showsmartName && (
              <th
                className="p-2 font-medium truncate hover:bg-accent/40 cursor-default transition-colors"
                title={t('文件名称')}
              >
                {t('名称')}
              </th>
            )}
            {shouldShowField('qualityScore') && (
              <th
                className="p-2 font-medium whitespace-nowrap truncate hover:bg-accent/40 cursor-default transition-colors"
                title={t('AI质量评分')}
              >
                {getFieldLabel('qualityScore')}
              </th>
            )}
            {shouldShowField('description') && (
              <th
                className="p-2 font-medium whitespace-nowrap truncate hover:bg-accent/40 cursor-default transition-colors"
                title={t('文件描述')}
              >
                {getFieldLabel('description')}
              </th>
            )}
            {shouldShowField('tags') && (
              <th
                className="p-2 font-medium whitespace-nowrap truncate hover:bg-accent/40 cursor-default transition-colors"
                title={t('文件标签')}
              >
                {getFieldLabel('tags')}
              </th>
            )}
            {shouldShowField('author') && (
              <th
                className="p-2 font-medium whitespace-nowrap truncate hover:bg-accent/40 cursor-default transition-colors"
                title={t('作者')}
              >
                {getFieldLabel('author')}
              </th>
            )}
            {shouldShowField('language') && (
              <th
                className="p-2 font-medium whitespace-nowrap truncate hover:bg-accent/40 cursor-default transition-colors"
                title={t('语言')}
              >
                {getFieldLabel('language')}
              </th>
            )}
            {showAnalysisStatus && (
              <th
                className="p-2 font-medium whitespace-nowrap truncate hover:bg-accent/40 cursor-default transition-colors"
                title={t('AI分析状态')}
              >
                {t('分析状态')}
              </th>
            )}
            <th
              className="p-2 font-medium whitespace-nowrap truncate hover:bg-accent/40 cursor-default transition-colors"
              title={t('最后修改时间')}
            >
              {t('修改日期')}
            </th>
            <th
              className="p-2 font-medium whitespace-nowrap truncate hover:bg-accent/40 cursor-default transition-colors"
              title={t('文件类型')}
            >
              {t('类型')}
            </th>
            <th
              className="p-2 font-medium whitespace-nowrap truncate hover:bg-accent/40 cursor-default transition-colors"
              title={t('文件大小')}
            >
              {t('大小')}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {items.map((item, index) => (
            <RowRenderer key={item.path || index} index={index} style={{}} data={itemData} />
          ))}
        </tbody>
      </table>
    </div>
  )
}
