import { useState } from 'react'
import {
  WorkspaceDirectory,
  FileItem as FileType,
  AIServiceStatus,
  SavedAnalyzedDirectory
} from '@firefly/types'

/**
 * 虚拟目录工具逻辑 Hook
 * 处理空文件夹清理等辅助状态
 */
export const useAnalyzedDirectoryFilter = (
  _currentWorkspaceDirectory?: WorkspaceDirectory | null,
  _selectedFiles?: FileType[],
  _modelMode?: string,
  _serviceStatus?: AIServiceStatus,
  _analyzedFilesCount?: number | null,
  _savedDirectories?: SavedAnalyzedDirectory[],
  _loadSavedDirectoriesData?: () => Promise<void>,
  _loadFilteredFiles?: () => Promise<void>
) => {
  const [showEmptyFolderCleanupDialog, setShowEmptyFolderCleanupDialog] = useState(false)
  const [emptyFolderScanPath, setEmptyFolderScanPath] = useState<string | null>(null)

  return {
    showEmptyFolderCleanupDialog,
    setShowEmptyFolderCleanupDialog,
    emptyFolderScanPath,
    setEmptyFolderScanPath
  }
}
