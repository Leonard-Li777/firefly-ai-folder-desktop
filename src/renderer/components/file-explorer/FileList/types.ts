import { FileItem as BaseFileType, DirectoryItem, AnalysisStatus } from '@firefly/types'
import { PageId } from '../../../constants/page-ids'

export interface FileType extends BaseFileType {
  relativePathPrefix?: string
  thumbnailPath?: string
  /** 分析完成时间（与 FILE_LIST_EXTRA_FIELDS 中 analyzedAt 字段对应） */
  analyzedAt?: string
}

export interface FileListProps {
  files: FileType[]
  directories: DirectoryItem[]
  selectedFiles: FileType[]
  activeItem?: FileType | DirectoryItem | null
  onFileSelect: (files: (FileType | DirectoryItem | string)[], isFromCheckbox?: boolean) => void
  /** 获取最新的 selectedFiles，避免 React.memo 导致 ref 过时 */
  getSelectedFiles?: () => FileType[]
  onDirectoryChange: (path: string) => void
  onFileDoubleClick?: (file: FileType) => void
  loading?: boolean
  selectionEnabled?: boolean
  viewMode?: 'list' | 'grid' | 'table' | 'waterfall'
  currentPath: string
  showAnalysisStatus?: boolean
  showsmartName?: boolean
  swapFileNameDisplay?: boolean
  gridShowFullFileName?: boolean
  isRealDirectory?: boolean
  sortBy?:
    | 'name'
    | 'size'
    | 'modified'
    | 'type'
    | 'smartName'
    | 'analysisStatus'
    | 'author'
    | 'qualityScore'
    | 'language'
  sortOrder?: 'asc' | 'desc'
  disableClientSort?: boolean
  onSortChange?: (sortBy: any, sortOrder: 'asc' | 'desc') => void
  onLoadMore?: () => void
  hasMore?: boolean
  onUp?: () => void
  onBack?: () => void
  onForward?: () => void
  workspaceDirectoryPath?: string
  refreshKey?: number
  pageId?: PageId
  forceShowAllFields?: boolean
  gridCardWidth?: number
}

export interface ListItemData {
  items: (FileType | DirectoryItem)[]
  selectedFiles: FileType[]
  selectedPathsSet: Set<string>
  activeItem?: FileType | DirectoryItem | null
  onFileSelect: (files: (FileType | DirectoryItem | string)[], isFromCheckbox?: boolean) => void
  getItemDisplayName?: (item: FileType | DirectoryItem) => string
  /** 获取最新的 selectedFiles，避免 React.memo 导致 ref 过时 */
  getSelectedFiles?: () => FileType[]
  onDirectoryChange: (path: string) => void
  getFileIcon: (type: 'file' | 'directory', extension?: string) => React.ReactNode
  formatFileSize: (size?: number) => string
  formatDate: (date?: string | number | Date) => string
  isPathEqual: (p1?: string | null, p2?: string | null) => boolean
  workspaceDirectoryPath: string | null
  normalizeForCache: (path: string) => string
  refreshKey: number
  showAnalysisStatus: boolean
  showsmartName: boolean
  swapFileNameDisplay: boolean
  gridShowFullFileName: boolean
  isImageFile: (ext?: string) => boolean
  getAllFilesInDirectory: (dirPath: string) => (FileType | DirectoryItem)[]
  shouldShowField: (field: string) => boolean
  getFieldLabel: (field: string) => string
  onContextMenu: (e: React.MouseEvent, item: FileType | DirectoryItem) => void
  onItemClick: (index: number, e: React.MouseEvent) => void
  onFileDoubleClick?: (file: FileType) => void
  selectionEnabled?: boolean
  viewMode: string
  t: (key: string, params?: any) => string
  columnCount?: number // for GridCell
  columnWidths: Record<string, number>
  totalWidth: number
  pageId?: PageId
}
