import React, { useState, useImperativeHandle, forwardRef, useCallback } from 'react'
import { t } from '@app/languages'
import { toast } from '../../../common/Toast'
import { useTierStore } from '../../../../stores/tier-store'
import { PaymentFlowDialog } from '../../../tier/PaymentFlowDialog'
import { EmptyFolderCleanupDialog } from '../../../organize/EmptyFolderCleanupDialog'
import { ExportFailedDialog } from './ExportFailedDialog'
import { useExportLogic } from '../hooks/useExportLogic'
import { WorkspaceDirectory, VirtualDirectory } from '@firefly/types'

export interface OrganizeModalsRef {
  triggerExportVdir: () => void
  triggerExportReal: () => void
}

interface OrganizeModalsProps {
  selectedId: number | null
  isVdirActive: boolean
  currentWorkspaceDirectory: WorkspaceDirectory | null
  currentVD: VirtualDirectory | undefined
  loadVDirs: () => Promise<void>
  loadTree: () => Promise<void>
  computed_limits: any
  vdirSidebarTab: string
  selectedTags: any[]
  previewTree: any[]
  exportPreviewOptions: any
}

export const OrganizeModals = React.memo(
  forwardRef<OrganizeModalsRef, OrganizeModalsProps>(
    (
      {
        selectedId,
        isVdirActive,
        currentWorkspaceDirectory,
        currentVD,
        loadVDirs,
        loadTree,
        computed_limits,
        vdirSidebarTab,
        selectedTags,
        previewTree,
        exportPreviewOptions
      },
      ref
    ) => {
      const {
        showExportVdirPayment,
        setShowExportVdirPayment,
        showExportRealPayment,
        setShowExportRealPayment,
        showEmptyFolderCleanup,
        setShowEmptyFolderCleanup,
        cleanupScanPath,
        showExportFailedDialog,
        setShowExportFailedDialog,
        exportFailedFiles,
        setExportFailedFiles,
        exportSuccessCount,
        setExportSuccessCount,
        exportFailedOperations,
        handleRetryWithCopy,
        handleExportPhysical,
        executeExportReal
      } = useExportLogic({
        selectedId,
        isVdirActive,
        currentWorkspaceDirectory,
        currentVD,
        loadVDirs,
        loadTree
      })

      const handleExportVdirWithPreview = useCallback(async () => {
        if (!selectedId) return
        const toastId = `export-preview-vdir-${selectedId}`
        toast.loading(t('正在导出虚拟目录...'), 0, toastId)
        const result: any = await window.electronAPI.virtualDirectory.exportByPreviewTree({
          type: 'virtual',
          tree: previewTree,
          options: {
            flattenToRoot: exportPreviewOptions.flattenFiles,
            flattenDirectories: exportPreviewOptions.flattenDirectories,
            skipEmptyDirectories: exportPreviewOptions.skipEmptyDirs,
            enableNestedClassification: true,
            deduplicateFiles: exportPreviewOptions.deduplicateFiles
          },
          virtualDirectoryId: selectedId
        })
        toast.dismiss(toastId)
        if (result.success) {
          toast.success(t('成功导出 {count} 个文件', { count: result.exportedCount ?? 0 }))
          if (result.exportPath) {
            window.electronAPI.utils.openPathInExplorer(result.exportPath)
          }
          useTierStore.getState().fetchProfile()
          // 有失败文件时显示弹窗
          if (result.failedCount > 0 && result.failedFiles?.length > 0) {
            setExportFailedFiles(result.failedFiles)
            setExportSuccessCount(result.exportedCount ?? 0)
            setShowExportFailedDialog(true)
          }
        } else {
          toast.error(result.message || t('导出失败'))
        }
      }, [selectedId, previewTree, exportPreviewOptions, setExportFailedFiles, setExportSuccessCount, setShowExportFailedDialog])

      const handleExportRealWithPreview = useCallback(async () => {
        if (!selectedId || !currentWorkspaceDirectory?.path) return
        const toastId = `export-preview-real-${selectedId}`
        toast.loading(t('正在导出至真实目录...'), 0, toastId)
        const result = await window.electronAPI.virtualDirectory.exportByPreviewTree({
          type: 'real',
          tree: previewTree,
          options: {
            flattenToRoot: exportPreviewOptions.flattenFiles,
            flattenDirectories: exportPreviewOptions.flattenDirectories,
            skipEmptyDirectories: exportPreviewOptions.skipEmptyDirs,
            enableNestedClassification: true,
            deduplicateFiles: exportPreviewOptions.deduplicateFiles
          },
          virtualDirectoryId: selectedId,
          workspaceDirectoryPath: currentWorkspaceDirectory.path,
          virtualDirectoryName: currentVD?.name || ''
        })
        toast.dismiss(toastId)
        if (result.success) {
          toast.success(t('导出成功'))
          // 选中工作目录下第一个导出的子目录，让用户直观看到导出结果
          const firstDirPath = result.statistics?.firstDirPath
          if (firstDirPath) {
            window.electronAPI.utils.showItemInFolder(firstDirPath)
          } else {
            window.electronAPI.utils.openPathInExplorer(currentWorkspaceDirectory.path)
          }
          await loadVDirs()
          await loadTree()
          useTierStore.getState().fetchProfile()
          // 有失败文件时显示弹窗
          const statistics = result.statistics
          if (statistics?.failedCount > 0) {
            setExportFailedFiles(statistics.failedFiles || [])
            setExportSuccessCount(statistics.exportedCount ?? 0)
            setShowExportFailedDialog(true)
          }
        } else {
          toast.error(result.message || t('导出失败'))
        }
      }, [
        selectedId,
        currentWorkspaceDirectory?.path,
        currentVD?.name,
        previewTree,
        exportPreviewOptions,
        loadVDirs,
        loadTree,
        setExportFailedFiles,
        setExportSuccessCount,
        setShowExportFailedDialog
      ])

      useImperativeHandle(ref, () => ({
        triggerExportVdir: () => {
          if (!isVdirActive) {
            toast.error(t('请先返回前一步开通虚拟目录访问权限'))
            return
          }
          if (
            vdirSidebarTab === 'dimensions' &&
            selectedTags.length > 0 &&
            previewTree.length > 0
          ) {
            const cost = (computed_limits?.export_vdir_cost as number) ?? 0
            if (cost > 0) {
              setShowExportVdirPayment(true)
            } else {
              handleExportVdirWithPreview()
            }
          } else {
            const cost = (computed_limits?.export_vdir_cost as number) ?? 0
            if (cost > 0) {
              setShowExportVdirPayment(true)
            } else {
              handleExportPhysical()
            }
          }
        },
        triggerExportReal: () => {
          if (!isVdirActive) {
            toast.error(t('请先返回前一步开通虚拟目录访问权限'))
            return
          }
          if (
            vdirSidebarTab === 'dimensions' &&
            selectedTags.length > 0 &&
            previewTree.length > 0
          ) {
            const cost = (computed_limits?.export_rdir_cost as number) ?? 0
            if (cost > 0) {
              setShowExportRealPayment(true)
            } else {
              handleExportRealWithPreview()
            }
          } else {
            const cost = (computed_limits?.export_rdir_cost as number) ?? 0
            if (cost > 0) {
              setShowExportRealPayment(true)
            } else {
              executeExportReal()
            }
          }
        }
      }))

      return (
        <>
          <PaymentFlowDialog
            open={showExportVdirPayment}
            onOpenChange={setShowExportVdirPayment}
            cost={(computed_limits?.export_vdir_cost as number) ?? 0}
            firecoreOperationType="spend_export_vdir"
            operationName={t('导出虚拟目录')}
            onSuccess={() => {
              useTierStore.getState().fetchProfile()
              if (
                vdirSidebarTab === 'dimensions' &&
                selectedTags.length > 0 &&
                previewTree.length > 0
              ) {
                handleExportVdirWithPreview()
              } else {
                handleExportPhysical()
              }
              setShowExportVdirPayment(false)
            }}
            metadata={{
              reference_type: 'virtual_directory',
              reference_id: selectedId ? String(selectedId) : undefined
            }}
          />

          <PaymentFlowDialog
            open={showExportRealPayment}
            onOpenChange={setShowExportRealPayment}
            cost={(computed_limits?.export_rdir_cost as number) ?? 0}
            firecoreOperationType="spend_export_rdir"
            operationName={t('导出真实目录')}
            onSuccess={() => {
              useTierStore.getState().fetchProfile()
              if (
                vdirSidebarTab === 'dimensions' &&
                selectedTags.length > 0 &&
                previewTree.length > 0
              ) {
                handleExportRealWithPreview()
              } else {
                executeExportReal()
              }
              setShowExportRealPayment(false)
            }}
            metadata={{
              reference_type: 'virtual_directory',
              reference_id: selectedId ? String(selectedId) : undefined,
              virtualDirectoryId: selectedId,
              workspaceDirectoryPath: currentWorkspaceDirectory?.path,
              virtualDirectoryName: currentVD?.name || ''
            }}
          />

          <EmptyFolderCleanupDialog
            isOpen={showEmptyFolderCleanup}
            onClose={() => setShowEmptyFolderCleanup(false)}
            workspaceDirectoryPath={cleanupScanPath}
          />

          <ExportFailedDialog
            isOpen={showExportFailedDialog}
            onClose={() => setShowExportFailedDialog(false)}
            failedFiles={exportFailedFiles}
            exportedCount={exportSuccessCount}
            failedOperations={exportFailedOperations}
            onRetryWithCopy={handleRetryWithCopy}
          />
        </>
      )
    }
  )
)

OrganizeModals.displayName = 'OrganizeModals'
