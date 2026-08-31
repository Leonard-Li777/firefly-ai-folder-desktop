import React from 'react'
import { FileItem, DirectoryItem } from '@firefly/types'
import { PageId } from '../../../constants/page-ids'

export type ViewMode = 'grid' | 'list' | 'waterfall' | 'table'

export interface FileExplorerLayoutContext {
  viewMode: ViewMode
  setViewMode: (mode: ViewMode) => void
  gridCardWidth: number
  setGridCardWidth: (width: number) => void
  selectedFiles: FileItem[]
  activeItem: FileItem | DirectoryItem | null
  totalCount: number
}

export interface FileExplorerLayoutProps {
  /** 标准数据源：文件列表 */
  files: FileItem[]
  /** 标准数据源：目录列表（可选） */
  directories?: DirectoryItem[]
  /** 是否允许选择文件与多选框 (默认 true) */
  selectionEnabled?: boolean
  /** 外部控制的受控视图模式 (可选) */
  viewMode?: ViewMode
  /** 视图模式变更回调 (可选) */
  onViewModeChange?: (mode: ViewMode) => void
  /** 外部选中的文件列表 ID 集合 */
  selectedFileIds?: string[]
  /** 外部选中的完整文件对象列表 (优先使用以避免重复过滤与映射) */
  selectedFiles?: (FileItem | DirectoryItem)[]
  /** 外部指定的当前激活/高亮项目 */
  activeItem?: FileItem | DirectoryItem | null
  /** 关联页面标识 (用于 SplitPreviewPanel 状态隔离) */
  pageId?: PageId
  /** 文件选中回调 */
  onFileSelect?: (filesOrItem: any, isFromCheckbox?: boolean) => void
  /** 文件双击回调 */
  onFileDoubleClick?: (file: FileItem) => void
  /** 选区或勾选变更回调 */
  onSelectionChange?: (selectedFiles: FileItem[]) => void
  /** 目录变更回调 */
  onDirectoryChange?: (path: string) => void
  /** 路径后退 */
  onBack?: () => void
  /** 路径前进 */
  onForward?: () => void
  /** 路径向上 */
  onUp?: () => void
  /** 当前工作区路径 */
  workspaceDirectoryPath?: string
  /** 工作区类型 */
  workspaceDirectoryType?: 'SPEEDY' | 'PRIVATE' | 'VDIR'
  /** 当前浏览物理路径 */
  currentPath?: string
  /** 是否为物理真实目录 */
  isRealDirectory?: boolean
  /** 刷新标识 */
  refreshKey?: number
  /** 文件删除回调 */
  onFileDeleted?: () => void
  /** 文件更新回调 */
  onFileUpdated?: () => void
  /** 关闭属性面板回调 */
  onCloseDetailsPanel?: () => void
  /** 是否显示文件属性/元数据面板 FileDetailsPanel (默认 true) */
  showDetailsPanel?: boolean
  /** 是否显示独立文件预览区块 FilePreviewPanel / SplitPreviewPanel (默认 false) */
  showPreviewPanel?: boolean
  /** 初始视图模式 (默认 'grid') */
  defaultViewMode?: ViewMode
  /** 自定义顶栏工具栏渲染函数插槽 */
  renderToolbar?: (context: FileExplorerLayoutContext) => React.ReactNode
  /** 自定义底部状态栏插槽 */
  renderFooter?: (context: FileExplorerLayoutContext) => React.ReactNode
  /** 是否正在加载 */
  isLoading?: boolean
  /** 是否有更多数据 (无限滚动) */
  hasMore?: boolean
  /** 加载更多数据回调 */
  onLoadMore?: () => void
  /** 排序字段 */
  sortBy?: string
  /** 排序顺序 */
  sortOrder?: 'asc' | 'desc'
  /** 是否禁用客户端排序 */
  disableClientSort?: boolean
  /** 排序变更回调 */
  onSortChange?: (sortBy: string, sortOrder: 'asc' | 'desc') => void
  /** 是否显示智能名称 */
  showsmartName?: boolean
  /** 是否互换智能文件名和真实文件名的显示位置 */
  swapFileNameDisplay?: boolean
  /** 是否显示 AI 分析状态标号 */
  showAnalysisStatus?: boolean
  /** 自定义获取已选择文件回调 */
  getSelectedFiles?: () => FileItem[]
  /** 容器 ID 或标识 */
  id?: string
  /** 自定义 class 样式名 */
  className?: string
}
