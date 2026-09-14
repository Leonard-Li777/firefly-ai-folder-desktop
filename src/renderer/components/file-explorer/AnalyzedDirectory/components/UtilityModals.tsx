import React from 'react'
import { WorkspaceDirectory, DimensionGroup, SelectedTag } from '@firefly/types'
import { GenerateVirtualDirectoriesDialog } from '../../../organize/GenerateVirtualDirectoriesDialog'
import { EmptyFolderCleanupDialog } from '../../../organize/EmptyFolderCleanupDialog'

interface UtilityModalsProps {
  currentWorkspaceDirectory: WorkspaceDirectory | null
  showGenerateAnalyzedDirDialog: boolean
  setShowGenerateAnalyzedDirDialog: (show: boolean) => void
  handleConfirmGenerateAnalyzedDirectories: (options: any) => void
  selectedTags: SelectedTag[]
  dimensionGroups: DimensionGroup[]
  selectionStack: string[]
  showEmptyFolderCleanupDialog: boolean
  setShowEmptyFolderCleanupDialog: (show: boolean) => void
  emptyFolderScanPath: string | null
  setEmptyFolderScanPath: (path: string | null) => void
}

/**
 * 工具类弹窗组件
 * 包含虚拟目录生成、空文件夹清理等工具弹窗
 */
export const UtilityModals: React.FC<UtilityModalsProps> = ({
  currentWorkspaceDirectory,
  showGenerateAnalyzedDirDialog,
  setShowGenerateAnalyzedDirDialog,
  handleConfirmGenerateAnalyzedDirectories,
  selectedTags,
  dimensionGroups,
  selectionStack,
  showEmptyFolderCleanupDialog,
  setShowEmptyFolderCleanupDialog,
  emptyFolderScanPath,
  setEmptyFolderScanPath
}) => {
  return (
    <>
      {showGenerateAnalyzedDirDialog && (
        <GenerateVirtualDirectoriesDialog
          isOpen={showGenerateAnalyzedDirDialog}
          onClose={() => setShowGenerateAnalyzedDirDialog(false)}
          onConfirm={handleConfirmGenerateAnalyzedDirectories}
          selectedTags={selectedTags.map(tag => {
            const group = dimensionGroups.find(g => g.id === tag.dimensionId)
            const tagObj = group?.tags.find(t => t.tagValue === tag.tagValue)
            return {
              dimensionId: tag.dimensionId,
              dimensionName: tag.dimensionName,
              tagValue: tag.tagValue,
              fileCount: tagObj?.fileCount || 0
            }
          })}
          dimensionGroups={dimensionGroups}
          workspaceDirectoryPath={currentWorkspaceDirectory?.path}
          selectionStack={selectionStack}
        />
      )}

      {showEmptyFolderCleanupDialog && currentWorkspaceDirectory && (
        <EmptyFolderCleanupDialog
          isOpen={showEmptyFolderCleanupDialog}
          onClose={() => {
            setShowEmptyFolderCleanupDialog(false)
            setEmptyFolderScanPath(null)
          }}
          workspaceDirectoryPath={currentWorkspaceDirectory?.path}
          scanPath={emptyFolderScanPath || undefined}
        />
      )}
    </>
  )
}
