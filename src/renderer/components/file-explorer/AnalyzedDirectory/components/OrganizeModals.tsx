import React from 'react'
import {
  WorkspaceDirectory,
  FileInfoForAI,
  OrganizeStatistics,
  FileConflict,
  ConflictResolutionOptions
} from '@firefly/types'
import { ConfirmOrganizeDialog } from '../../../organize/ConfirmOrganizeDialog'
import { OrganizeProgressDialog } from '../../../organize/OrganizeProgressDialog'
import { OrganizeErrorDialog } from '../../../organize/OrganizeErrorDialog'
import { AIOrganizeProgressDialog } from '../../../organize/AIOrganizeProgressDialog'
import { ConflictResolutionDialog } from '../../../organize/ConflictResolutionDialog'
import { OrganizeResultDialog } from '../../../organize/OrganizeResultDialog'
import { OrganizePreview, OrganizeProgress } from '../types'
import { t } from '@app/languages'

interface OrganizeModalsProps {
  currentWorkspaceDirectory: WorkspaceDirectory | null
  showConfirmOrganizeDialog: boolean
  setShowConfirmOrganizeDialog: (show: boolean) => void
  organizePreview: OrganizePreview | null
  aiGeneratedStructure: any
  fileMapForOrganize: Map<number, FileInfoForAI>
  handleConfirmOrganize: (createBackup: boolean) => void
  handleQuickOrganize: (instruction?: string) => void
  handleConfirmOrganizeAnalyzedDirectory: () => void
  showOrganizeProgressDialog: boolean
  organizeProgress: OrganizeProgress
  showOrganizeErrorDialog: boolean
  setShowOrganizeErrorDialog: (show: boolean) => void
  organizeResult: OrganizeStatistics | null
  showAIProgressDialog: boolean
  setShowAIProgressDialog: (show: boolean) => void
  aiBatchProgress: any
  handleCancelAIOrganize: () => void
  showConflictDialog: boolean
  conflicts: FileConflict[]
  handleConflictResolve: (options: ConflictResolutionOptions) => void
  handleConflictCancel: () => void
  showResultDialog: boolean
  setShowResultDialog: (show: boolean) => void
  handleExportLog: () => void
  onPauseToggle?: () => void
  onEnd?: () => void
  isPaused?: boolean
  onDeleteNode?: (nodeKey: string) => void
}

/**
 * 整理相关弹窗组件
 * 包含 AI 整理方案、进度显示、错误处理和结果统计
 */
export const OrganizeModals: React.FC<OrganizeModalsProps> = ({
  currentWorkspaceDirectory,
  showConfirmOrganizeDialog,
  setShowConfirmOrganizeDialog,
  organizePreview,
  aiGeneratedStructure,
  fileMapForOrganize,
  handleConfirmOrganize,
  handleQuickOrganize,
  handleConfirmOrganizeAnalyzedDirectory,
  showOrganizeProgressDialog,
  organizeProgress,
  showOrganizeErrorDialog,
  setShowOrganizeErrorDialog,
  organizeResult,
  showAIProgressDialog,
  aiBatchProgress,
  handleCancelAIOrganize,
  showConflictDialog,
  conflicts,
  handleConflictResolve,
  handleConflictCancel,
  showResultDialog,
  setShowResultDialog,
  handleExportLog,
  onPauseToggle,
  onEnd,
  isPaused = false,
  onDeleteNode
}) => {
  return (
    <>
      {showConfirmOrganizeDialog && organizePreview && (
        <ConfirmOrganizeDialog
          organizeType={aiGeneratedStructure ? 'quickOrganize' : 'byAnalyzedDirectory'}
          fileCount={organizePreview.fileCount}
          directoryStructure={organizePreview.directoryStructure}
          fileMap={fileMapForOrganize}
          onConfirm={handleConfirmOrganize}
          onCancel={() => setShowConfirmOrganizeDialog(false)}
          onRegenerate={instruction => {
            handleQuickOrganize(instruction)
          }}
          onConfirmVirtualDirectory={handleConfirmOrganizeAnalyzedDirectory}
          isReadOnly={aiGeneratedStructure?.isReadOnly}
          onDeleteNode={onDeleteNode}
        />
      )}

      {showOrganizeProgressDialog && <OrganizeProgressDialog {...organizeProgress} />}

      {showOrganizeErrorDialog && organizeResult && (
        <OrganizeErrorDialog
          successCount={organizeResult.movedFiles}
          errors={organizeResult.errors}
          onClose={() => {
            setShowOrganizeErrorDialog(false)
            if (organizeResult) setShowResultDialog(true)
          }}
        />
      )}

      {showAIProgressDialog && (
        <AIOrganizeProgressDialog
          batchProgress={aiBatchProgress}
          fileMap={fileMapForOrganize}
          onCancel={handleCancelAIOrganize}
          onPauseToggle={onPauseToggle}
          onEnd={onEnd}
          isPaused={isPaused}
        />
      )}

      {showConflictDialog && conflicts.length > 0 && (
        <ConflictResolutionDialog
          conflicts={conflicts}
          onResolve={handleConflictResolve}
          onCancel={handleConflictCancel}
        />
      )}

      {showResultDialog && organizeResult && (
        <OrganizeResultDialog
          statistics={organizeResult}
          onClose={() => setShowResultDialog(false)}
          onOpenDirectory={() => {
            if (currentWorkspaceDirectory) {
              window.electronAPI!.organizeRealDirectory.openDirectory(
                currentWorkspaceDirectory.path
              )
            }
          }}
          onExportLog={handleExportLog}
        />
      )}
    </>
  )
}
