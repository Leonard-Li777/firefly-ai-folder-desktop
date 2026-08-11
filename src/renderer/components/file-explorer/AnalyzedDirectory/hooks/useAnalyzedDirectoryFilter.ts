import { useState } from 'react'
import {
  WorkspaceDirectory,
  FileItem as FileType,
  OrganizeStatistics,
  BatchProgress,
  AIDirectoryStructure,
  FileInfoForAI,
  AIServiceStatus,
  SavedAnalyzedDirectory,
  DirectoryNode,
  FileConflict,
  ConflictResolutionOptions
} from '@firefly/types'
import { LogCategory, logger, deepClone } from '@firefly/shared'
import { toast } from '../../../common/Toast'
import { t } from '@app/languages'
import { captureEvent } from '../../../../lib/posthog'
import { OrganizePreview, OrganizeProgress } from '../types'

/**
 * 虚拟目录整理逻辑 Hook
 * 处理一键整理、按虚拟目录整理和 AI 整理方案生成
 */
export const useAnalyzedDirectoryFilter = (
  currentWorkspaceDirectory: WorkspaceDirectory | null,
  selectedFiles: FileType[],
  modelMode: string,
  serviceStatus: AIServiceStatus,
  analyzedFilesCount: number | null,
  savedDirectories: SavedAnalyzedDirectory[],
  loadSavedDirectoriesData: () => Promise<void>,
  loadFilteredFiles: () => Promise<void>
) => {
  const [showConfirmOrganizeDialog, setShowConfirmOrganizeDialog] = useState(false)
  const [showOrganizeProgressDialog, setShowOrganizeProgressDialog] = useState(false)
  const [showOrganizeErrorDialog, setShowOrganizeErrorDialog] = useState(false)
  const [organizePreview, setOrganizePreview] = useState<OrganizePreview | null>(null)
  const [organizeProgress, setOrganizeProgress] = useState<OrganizeProgress>({
    currentFile: '',
    processedCount: 0,
    totalCount: 0,
    percentage: 0,
    estimatedTimeRemaining: 0
  })
  const [organizeResult, setOrganizeResult] = useState<OrganizeStatistics | null>(null)

  const [showAIProgressDialog, setShowAIProgressDialog] = useState(false)
  const [aiBatchProgress, setAIBatchProgress] = useState<BatchProgress>({
    currentBatch: 0,
    totalBatches: 0,
    processedFiles: 0,
    totalFiles: 0
  })
  const [aiGeneratedStructure, setAIGeneratedStructure] = useState<AIDirectoryStructure | null>(
    null
  )
  const [fileMapForOrganize, setFileMapForOrganize] = useState<Map<number, FileInfoForAI>>(
    new Map()
  )

  const [showConflictDialog, setShowConflictDialog] = useState(false)
  const [conflicts, setConflicts] = useState<FileConflict[]>([])

  const [showResultDialog, setShowResultDialog] = useState(false)
  const [showEmptyFolderCleanupDialog, setShowEmptyFolderCleanupDialog] = useState(false)
  const [emptyFolderScanPath, setEmptyFolderScanPath] = useState<string | null>(null)

  const [isPaused, setIsPaused] = useState(false)

  /**
   * 删除目录节点
   * @param nodeKey 要删除的节点标识，格式为 "name::parent"
   */
  const handleDeleteNode = (nodeKey: string) => {
    if (!organizePreview) return

    // 解析nodeKey获取name和parent
    const [name, parent] = nodeKey.split('::')

    // 递归收集要删除节点及其所有子节点的文件
    const collectFilesFromNodeAndChildren = (
      nodes: DirectoryNode[],
      targetName: string,
      targetParent: string
    ): string[] => {
      const files: string[] = []

      for (const node of nodes) {
        // 检查当前节点是否匹配
        if (node.name === targetName && (node.parent || '') === targetParent) {
          // 收集当前节点的文件
          if (node.files) {
            files.push(...node.files.map(f => (typeof f === 'string' ? f : f.name)))
          }
        }

        // 检查子节点（parent === 当前节点name 的节点）
        // 如果当前节点是目标节点的子节点（即parent === targetName），递归收集
        if (node.parent === targetName) {
          files.push(...collectFilesFromNodeAndChildren(nodes, node.name, node.parent))
        }
      }

      return files
    }

    // 收集被删除节点及其所有子节点的文件
    const deletedFiles = collectFilesFromNodeAndChildren(
      organizePreview.directoryStructure,
      name,
      parent
    )

    // 递归删除节点及其子节点
    const deleteNodeAndChildren = (
      nodes: DirectoryNode[],
      targetName: string,
      targetParent: string
    ): DirectoryNode[] => {
      return nodes
        .filter(node => {
          // 保留不匹配的节点
          if (node.name === targetName && (node.parent || '') === targetParent) {
            return false
          }
          // 保留不是目标节点子节点的节点
          if (node.parent === targetName) {
            return false
          }
          return true
        })
        .map(node => ({ ...node }))
    }

    const newDirectoryStructure = deleteNodeAndChildren(
      organizePreview.directoryStructure,
      name,
      parent
    )

    // 将被删除的文件移到"未分类文件"目录
    if (deletedFiles.length > 0) {
      let unclassifiedDir = newDirectoryStructure.find(d => d.name === '未分类文件')
      if (!unclassifiedDir) {
        unclassifiedDir = {
          name: '未分类文件',
          parent: '',
          files: [],
          fileCount: 0
        }
        newDirectoryStructure.push(unclassifiedDir)
      }
      if (!unclassifiedDir.files) {
        unclassifiedDir.files = []
      }
      unclassifiedDir.files.push(...deletedFiles)
      unclassifiedDir.fileCount = unclassifiedDir.files.length
    }

    // 更新预览
    setOrganizePreview({
      ...organizePreview,
      directoryStructure: newDirectoryStructure,
      fileCount: newDirectoryStructure.reduce((sum, dir) => sum + (dir.files?.length || 0), 0)
    })

    toast.success(t('目录已删除，文件已移至"未分类文件"'))
  }

  const onPauseToggle = async () => {
    if (!currentWorkspaceDirectory) return
    const path = currentWorkspaceDirectory.path
    if (isPaused) {
      await window.electronAPI!.organizeRealDirectory.resumePlan(path)
      setIsPaused(false)
    } else {
      await window.electronAPI!.organizeRealDirectory.pausePlan(path)
      setIsPaused(true)
    }
  }

  const onEnd = async () => {
    if (!currentWorkspaceDirectory) return
    const path = currentWorkspaceDirectory.path
    await window.electronAPI!.organizeRealDirectory.endPlan(path)
    setIsPaused(false)
  }

  /**
   * 一键整理真实目录
   * @param userInstruction 用户指令
   */
  const handleQuickOrganize = async (userInstruction?: string) => {
    console.log('[AnalyzedDirectory] handleQuickOrganize called', { userInstruction })
    if (!currentWorkspaceDirectory) {
      toast.warning(t('请先选择工作目录'))
      return
    }

    if (selectedFiles.length === 0) {
      toast.warning(t('请先勾选要整理的文件。'))
      return
    }

    // 核心修正：如果本地 AI 引擎异常崩溃，则直接前置拦截以防陷入无效卡死状态
    if (modelMode === 'local' && serviceStatus === AIServiceStatus.ERROR) {
      toast.error(t('本地 AI 服务异常，请在设置中检查模型运行状态或切换模型'))
      return
    }

    captureEvent('点击一键整理', {
      analyzedFilesCount,
      hasUserInstruction: !!userInstruction,
      selectedFilesCount: selectedFiles.length
    })

    // Populate fileMapForOrganize
    const newFileMap = new Map<number, FileInfoForAI>()
    selectedFiles.forEach(f => {
      const numericId = typeof f.id === 'string' ? parseInt(f.id, 10) : f.id
      newFileMap.set(numericId, {
        id: numericId,
        name: f.name,
        smartName: f.smartName,
        path: f.path,
        type: (f as any).type || f.category || '',
        tags: [],
        dimensionTags: []
      })
    })
    setFileMapForOrganize(newFileMap)
    setIsPaused(false)

    try {
      // 显示AI分析进度对话框
      setShowAIProgressDialog(true)
      setAIBatchProgress({
        currentBatch: 0,
        totalBatches: 0,
        processedFiles: 0,
        totalFiles: 0
      })

      // 监听进度更新
      window.electronAPI!.organizeRealDirectory.onPlanProgress((progress: any) => {
        setAIBatchProgress({
          currentBatch: progress.currentBatch,
          totalBatches: progress.totalBatches,
          processedFiles: progress.processedFiles,
          totalFiles: progress.totalFiles,
          currentResult: progress.currentResult,
          message: progress.message
        })
      })

      const generateOptions: any = {
        batchSize: 7,
        temperature: 0.4,
        filePaths: selectedFiles.map(f => f.path)
      }

      if (userInstruction && typeof userInstruction === 'string' && userInstruction.trim() !== '') {
        generateOptions.userInstruction = userInstruction
      }

      const safeOptions = deepClone(generateOptions)

      const structure = await window.electronAPI!.organizeRealDirectory.generatePlan({
        workspaceDirectoryPath: currentWorkspaceDirectory.path,
        options: safeOptions
      })

      // 移除进度监听器
      window.electronAPI!.organizeRealDirectory.removePlanProgressListener()
      setShowAIProgressDialog(false)

      if (structure && (structure as any).success === false) {
        if (
          (structure as any).status === 'SERVICE_SWITCHING' ||
          (structure as any).message?.includes('切换中')
        ) {
          toast.warning((structure as any).message || t('模型正在切换中，请等待'))
        } else {
          toast.error((structure as any).message || t('生成一键整理方案失败'))
        }
        return
      }

      // 二次弹窗循环确认机制
      let finalStructure = structure
      let unclassifiedDir = finalStructure.directories.find((d: any) => d.name === '未分类文件')
      let unclassifiedCount = unclassifiedDir?.files?.length || 0

      while (unclassifiedCount > 0) {
        const confirmResult = await window.electronAPI!.utils.showMessageBox({
          type: 'question',
          buttons: [t('确认'), t('取消/跳过')],
          defaultId: 0,
          cancelId: 1,
          title: t('AI 补救归类'),
          message: t('当前仍有 {count} 个文件未成功归类，是否再次进行 AI 补救归类？', {
            count: unclassifiedCount
          })
        })

        if (confirmResult.response === 0) {
          const unclassifiedFileNames = new Set(
            unclassifiedDir.files.map((f: any) => (typeof f === 'string' ? f : f.name))
          )
          const unclassifiedFilesForAI = selectedFiles
            .filter(f => unclassifiedFileNames.has(f.smartName || f.name))
            .map(f => {
              const numericId = typeof f.id === 'string' ? parseInt(f.id, 10) : f.id
              return (
                newFileMap.get(numericId) || {
                  id: numericId,
                  name: f.name,
                  smartName: f.smartName,
                  path: f.path,
                  type: (f as any).type || f.category || '',
                  tags: [],
                  dimensionTags: []
                }
              )
            })

          if (unclassifiedFilesForAI.length === 0) {
            break
          }

          setShowAIProgressDialog(true)
          setIsPaused(false)
          setAIBatchProgress({
            currentBatch: 0,
            totalBatches: 0,
            processedFiles: 0,
            totalFiles: unclassifiedFilesForAI.length,
            message: t('正在自动补救未分类文件...')
          })

          // 重新添加进度监听
          window.electronAPI!.organizeRealDirectory.onPlanProgress((progress: any) => {
            setAIBatchProgress({
              currentBatch: progress.currentBatch,
              totalBatches: progress.totalBatches,
              processedFiles: progress.processedFiles,
              totalFiles: progress.totalFiles,
              currentResult: progress.currentResult,
              message: progress.message || t('正在自动补救未分类文件...')
            })
          })

          const remedyResult = await window.electronAPI!.organizeRealDirectory.generatePlan({
            workspaceDirectoryPath: currentWorkspaceDirectory.path,
            options: {
              ...safeOptions,
              filePaths: unclassifiedFilesForAI.map(f => f.path),
              previousStructure: finalStructure
            }
          })

          window.electronAPI!.organizeRealDirectory.removePlanProgressListener()
          setShowAIProgressDialog(false)

          if (remedyResult && (remedyResult as any).success === false) {
            if (
              (remedyResult as any).status === 'SERVICE_SWITCHING' ||
              (remedyResult as any).message?.includes('切换中')
            ) {
              toast.warning((remedyResult as any).message || t('模型正在切换中，请等待'))
            } else {
              toast.error((remedyResult as any).message || t('补救归类失败'))
            }
            break
          }

          finalStructure = remedyResult
          unclassifiedDir = finalStructure.directories.find((d: any) => d.name === '未分类文件')
          unclassifiedCount = unclassifiedDir?.files?.length || 0
        } else {
          break
        }
      }

      // AI分析完成，保存结果
      setAIGeneratedStructure(finalStructure as any)

      // 显示预览对话框
      setOrganizePreview({
        fileCount: finalStructure.directories.reduce(
          (sum: number, dir: any) => sum + (dir.files?.length || 0),
          0
        ),
        directoryStructure: Array.isArray(finalStructure.directories)
          ? (finalStructure.directories as any)
          : []
      })
      setShowConfirmOrganizeDialog(true)
    } catch (error: any) {
      if (error && error.message && error.message.includes('CancellationRequested')) {
        logger.info(LogCategory.RENDERER, 'AI organize plan generation cancelled by user')
        return
      }

      logger.error(LogCategory.RENDERER, 'Failed to quick organize:', error)
      window.electronAPI!.organizeRealDirectory.removePlanProgressListener()
      setShowAIProgressDialog(false)

      const message =
        error?.message?.replace(/^Error invoking remote method.*?: Error: /, '') || String(error)
      toast.error(t('一键整理失败: {message}', { message }))
    }
  }

  /**
   * 确认整理
   * @param createBackup 是否创建备份
   */
  const handleConfirmOrganize = async (createBackup: boolean) => {
    if (!currentWorkspaceDirectory || !organizePreview) return

    setShowConfirmOrganizeDialog(false)
    setShowOrganizeProgressDialog(true)

    try {
      let result: any

      if (aiGeneratedStructure) {
        result = await window.electronAPI!.organizeRealDirectory.quickOrganize({
          workspaceDirectoryPath: currentWorkspaceDirectory.path,
          aiGeneratedStructure: aiGeneratedStructure as any
        })
      } else {
        result = await window.electronAPI!.organizeRealDirectory.byVirtualDirectory({
          workspaceDirectoryPath: currentWorkspaceDirectory.path,
          savedDirectories
        })
      }

      logger.info(LogCategory.RENDERER, '[AnalyzedDirectory] 整理结果:', result)

      if (result && (result as any).success === false && (result as any).status !== undefined) {
        setShowOrganizeProgressDialog(false)
        if ((result as any).message) {
          toast.error((result as any).message)
        }
        return
      }

      setOrganizeResult(result)
      setShowOrganizeProgressDialog(false)

      if (result.failedFiles > 0) {
        setShowOrganizeErrorDialog(true)
      } else {
        toast.success(t('成功移动 {count} 个文件', { count: result.movedFiles }))
        await window.electronAPI!.organizeRealDirectory.openDirectory(
          currentWorkspaceDirectory.path
        )

        if (!aiGeneratedStructure && savedDirectories.length > 0) {
          const shouldDelete = await window.electronAPI!.utils.showMessageBox({
            type: 'question',
            title: t('整理完成'),
            message: t('整理完成！是否删除所有虚拟目录？'),
            buttons: [t('是'), t('否')],
            defaultId: 1
          })

          if (shouldDelete.response === 0) {
            await window.electronAPI!.organizeRealDirectory.deleteAllVirtualDirectories(
              currentWorkspaceDirectory.path
            )
            await loadSavedDirectoriesData()
            toast.success(t('虚拟目录已删除'))
          }
        }

        try {
          const scanResult = await window.electronAPI!.emptyFolder.scan(
            currentWorkspaceDirectory.path
          )
          if (scanResult && Array.isArray(scanResult) && scanResult.length > 0) {
            setEmptyFolderScanPath(currentWorkspaceDirectory.path)
            setShowEmptyFolderCleanupDialog(true)
          }
        } catch (error: any) {
          logger.error(LogCategory.RENDERER, '扫描空文件夹失败:', error)
        }
      }

      loadFilteredFiles()
      setAIGeneratedStructure(null)
    } catch (error: any) {
      logger.error(LogCategory.RENDERER, 'Failed to organize directory:', error)
      setShowOrganizeProgressDialog(false)
      const message =
        error?.message?.replace(/^Error invoking remote method.*?: Error: /, '') || String(error)
      toast.error(t('整理失败: {message}', { message }))
    }
  }

  /**
   * 取消 AI 整理方案生成
   */
  const handleCancelAIOrganize = async () => {
    if (currentWorkspaceDirectory) {
      try {
        await (window.electronAPI!.organizeRealDirectory as any).cancelPlan?.(
          currentWorkspaceDirectory.path
        )
        setShowAIProgressDialog(false)
        window.electronAPI!.organizeRealDirectory.removePlanProgressListener()
        toast.info(t('已取消 AI 整理方案生成'))
      } catch (error) {
        logger.error(LogCategory.RENDERER, 'Failed to cancel AI organize plan:', error)
      }
    }
  }

  /**
   * 处理冲突解决
   */
  const handleConflictResolve = async (options: ConflictResolutionOptions) => {
    setShowConflictDialog(false)
    toast.info(t('冲突解决功能开发中，将在后续版本支持'))
  }

  /**
   * 取消冲突解决
   */
  const handleConflictCancel = () => {
    setShowConflictDialog(false)
    setConflicts([])
    toast.info(t('已取消整理'))
  }

  return {
    showConfirmOrganizeDialog,
    setShowConfirmOrganizeDialog,
    showOrganizeProgressDialog,
    setShowOrganizeProgressDialog,
    showOrganizeErrorDialog,
    setShowOrganizeErrorDialog,
    organizePreview,
    setOrganizePreview,
    organizeProgress,
    setOrganizeProgress,
    organizeResult,
    setOrganizeResult,
    showAIProgressDialog,
    setShowAIProgressDialog,
    aiBatchProgress,
    setAIBatchProgress,
    aiGeneratedStructure,
    setAIGeneratedStructure,
    fileMapForOrganize,
    setFileMapForOrganize,
    showConflictDialog,
    setShowConflictDialog,
    conflicts,
    setConflicts,
    showResultDialog,
    setShowResultDialog,
    showEmptyFolderCleanupDialog,
    setShowEmptyFolderCleanupDialog,
    emptyFolderScanPath,
    setEmptyFolderScanPath,
    handleQuickOrganize,
    handleConfirmOrganize,
    handleCancelAIOrganize,
    handleConflictResolve,
    handleConflictCancel,
    handleDeleteNode,
    onPauseToggle,
    onEnd,
    isPaused
  }
}
