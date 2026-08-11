import { useState, useCallback } from 'react'
import { t } from '@app/languages'
import { toast } from '../../../common/Toast'
import { useTierStore } from '../../../../stores/tier-store'
import { VirtualDirectory, WorkspaceDirectory } from '@firefly/types'

interface UseExportLogicProps {
  selectedId: number | null
  isVdirActive: boolean
  currentWorkspaceDirectory: WorkspaceDirectory | null
  currentVD: VirtualDirectory | undefined
  loadVDirs: () => Promise<void>
  loadTree: () => Promise<void>
}

export const useExportLogic = ({
  selectedId,
  isVdirActive,
  currentWorkspaceDirectory,
  currentVD,
  loadVDirs,
  loadTree
}: UseExportLogicProps) => {
  const [showExportVdirPayment, setShowExportVdirPayment] = useState(false)
  const [showExportRealPayment, setShowExportRealPayment] = useState(false)
  const [showEmptyFolderCleanup, setShowEmptyFolderCleanup] = useState(false)
  const [cleanupScanPath, setCleanupScanPath] = useState<string>('')
  const [showExportFailedDialog, setShowExportFailedDialog] = useState(false)
  const [exportFailedFiles, setExportFailedFiles] = useState<string[]>([])
  const [exportSuccessCount, setExportSuccessCount] = useState(0)
  const [exportFailedOperations, setExportFailedOperations] = useState<
    Array<{ source: string; target: string }>
  >([])

  /** 拷贝模式重试失败文件 */
  const handleRetryWithCopy = useCallback(
    async (operations: Array<{ source: string; target: string }>) => {
      const toastId = 'retry-copy-failed'
      toast.loading(t('正在通过拷贝模式重试...'), 0, toastId)
      try {
        const result = await window.electronAPI.virtualDirectory.retryFailedExport({
          failedOperations: operations
        })
        toast.dismiss(toastId)
        if (result.success) {
          toast.success(t('所有失败文件已通过拷贝模式成功导出'))
        } else {
          toast.warning(
            t('拷贝模式重试完成，仍有 {count} 个文件失败', { count: result.stillFailedCount })
          )
        }
        setShowExportFailedDialog(false)
      } catch (e) {
        toast.dismiss(toastId)
        toast.error(t('重试失败'))
      }
    },
    []
  )

  const handleExportPhysical = useCallback(async () => {
    if (!selectedId) return
    if (!isVdirActive) {
      toast.error(t('请先开通虚拟目录访问权限'))
      return
    }
    const toastId = `export-physical-${selectedId}`
    toast.loading(t('正在导出虚拟目录...'), 0, toastId)
    const result = await window.electronAPI.virtualDirectory.exportToPhysical(selectedId)
    toast.dismiss(toastId)
    if (result.success) {
      toast.success(t('成功导出 {count} 个文件', { count: result.exportedCount }))
      if (result.exportPath) {
        window.electronAPI.utils.openPathInExplorer(result.exportPath)
      }
      useTierStore.getState().fetchProfile()

      // 导出后扫描空文件夹，提示用户清理
      if (result.exportPath) {
        const emptyScanResult = await window.electronAPI!.emptyFolder.scan(result.exportPath)
        const emptyFolders = Array.isArray(emptyScanResult) ? emptyScanResult : []
        if (emptyFolders.some((f: any) => f.isEmpty)) {
          setCleanupScanPath(result.exportPath)
          setShowEmptyFolderCleanup(true)
        }
      }
    } else {
      if (result.failedCount > 0 && result.failedFiles?.length > 0) {
        setExportFailedFiles(result.failedFiles)
        setExportSuccessCount(result.exportedCount)
        setExportFailedOperations(result.failedOperations || [])
        setShowExportFailedDialog(true)
      } else {
        toast.error(result.message || t('部分文件导出失败'))
      }
    }
  }, [selectedId, isVdirActive])

  const executeExportReal = useCallback(async () => {
    if (!selectedId || !currentWorkspaceDirectory?.path) return
    if (!isVdirActive) {
      toast.error(t('请先开通虚拟目录访问权限'))
      return
    }

    const toastId = `export-real-${selectedId}`
    toast.loading(t('正在导出至真实目录...'), 0, toastId)
    try {
      const result = await window.electronAPI.organizeRealDirectory.exportByVirtualDirectoryId({
        virtualDirectoryId: selectedId,
        workspaceDirectoryPath: currentWorkspaceDirectory.path,
        virtualDirectoryName: currentVD?.name || ''
      })
      toast.dismiss(toastId)
      if (!result.success) {
        toast.error(result.message || t('导出失败'))
        return
      }

      const statistics = result.statistics
      // 有失败文件时显示弹窗
      if (statistics?.failedFiles > 0 && statistics?.errors?.length > 0) {
        const failedFilePaths = statistics.errors.map(
          (e: any) => e.filePath || e.error || 'Unknown'
        )
        setExportFailedFiles(failedFilePaths)
        setExportSuccessCount(statistics.movedFiles ?? 0)
        setShowExportFailedDialog(true)
      } else {
        toast.success(t('导出成功'))
      }
      window.electronAPI.utils.openPathInExplorer(currentWorkspaceDirectory.path)
      await loadVDirs()
      await loadTree()
      useTierStore.getState().fetchProfile()

      // 导出后扫描空文件夹，提示用户清理
      const emptyScanResult = await window.electronAPI!.emptyFolder.scan(
        currentWorkspaceDirectory.path
      )
      const emptyFolders = Array.isArray(emptyScanResult) ? emptyScanResult : []
      if (emptyFolders.some((f: any) => f.isEmpty)) {
        setCleanupScanPath(currentWorkspaceDirectory.path)
        setShowEmptyFolderCleanup(true)
      }
    } catch (e) {
      toast.dismiss(toastId)
      toast.error(t('导出失败'))
    }
  }, [
    selectedId,
    currentWorkspaceDirectory?.path,
    isVdirActive,
    currentVD?.name,
    loadVDirs,
    loadTree
  ])

  return {
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
  }
}
