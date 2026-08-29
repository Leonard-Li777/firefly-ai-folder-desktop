import { ipcMain } from 'electron'
import { ConfigOrchestrator } from '../../config/config-orchestrator'
import { logger, LogCategory, sanitizeDirectoryName, isTestEnvironment } from '@firefly/shared'
import { userTierService } from '../../runtime-services/user-tier/user-tier-service'
import { databaseService } from '../../runtime-services/database/database-service'
import { analysisQueueService } from '../../runtime-services/analysis-queue-service'
import { t } from '@app/languages'
import {
  analyzedDirectoryService,
  virtualDirectoryService,
  organizeRealDirectoryService,
  reorganizePauseFlags,
  reorganizeEndFlags,
  organizePlanAbortControllers,
  globalLlamaIndexService,
  directoryContextService,
  setDirectoryContextService,
  coreEngine
} from '../state'
import { checkLicenseAndNotify } from '../utils'
import { LicenseStatus } from '../../runtime-services/system/license-service'
import type { LanguageCode, PhysicalExportResult, SelectedTag } from '@firefly/types'
import { UnitRecognitionService, loadPromptParagraph } from '@firefly/core-engine'
import { createCoreEngineAdapters } from '../../adapters'
import fs from 'fs-extra'
import path from 'node:path'
import { VIRTUAL_DIRECTORY_ROOT } from '../../runtime-services/filesystem/virtual-directory-service/utils'
import { NamingDSLEngine } from '../../runtime-services/filesystem/naming-dsl-engine'

async function exportTreeToDirectory(
  tree: any[],
  targetDir: string
): Promise<PhysicalExportResult> {
  let exportedCount = 0
  let failedCount = 0
  const failedFiles: string[] = []

  const walk = async (nodes: any[], currentPath: string) => {
    for (const node of nodes) {
      const dirPath = path.join(currentPath, node.name)
      try {
        await fs.ensureDir(dirPath)
      } catch {
        failedCount++
        continue
      }
      for (const f of node.files || []) {
        const sourcePath = f.originalPath || f.path
        if (!sourcePath || !(await fs.pathExists(sourcePath))) {
          failedCount++
          failedFiles.push(sourcePath || 'Unknown')
          continue
        }
        const swap =
          ConfigOrchestrator.getInstance().getValue<boolean>('SWAP_FILE_NAME_DISPLAY') ?? false
        // 最高优先级：优先直接获取物理磁盘文件绝对路径的真实文件名
        const realDiskName = sourcePath ? path.basename(sourcePath) : ''
        const rawName = realDiskName || f._rawName || f.name || ''
        const rawSmartName = f._rawSmartName || f.smartName || rawName
        const targetFileName = swap ? rawName || rawSmartName : rawSmartName || rawName
        const targetPath = path.join(dirPath, targetFileName)

        logger.info(LogCategory.FILE_ORGANIZATION, '[exportTreeToDirectory] 导出文件', {
          sourcePath,
          swap,
          realDiskName,
          rawName,
          rawSmartName,
          targetFileName,
          targetPath
        })
        try {
          if (await fs.pathExists(targetPath)) {
            exportedCount++
            continue
          }
          await fs.link(sourcePath, targetPath).catch(() => fs.symlink(sourcePath, targetPath))
          exportedCount++
        } catch {
          failedCount++
          failedFiles.push(sourcePath)
        }
      }
      if (node.subdirectories?.length > 0) {
        await walk(node.subdirectories, dirPath)
      }
    }
  }

  await walk(tree, targetDir)
  return {
    success: failedCount === 0,
    exportedCount,
    failedCount,
    failedFiles,
    exportPath: targetDir
  }
}

/**
 * 移动文件到真实目录（适用于「导出真实目录」功能）
 * 与 exportTreeToDirectory 不同，此函数使用 fs.rename 移动文件而非创建链接
 */
async function moveTreeToDirectory(tree: any[], targetDir: string): Promise<PhysicalExportResult> {
  let exportedCount = 0
  let failedCount = 0
  const failedFiles: string[] = []

  const walk = async (nodes: any[], currentPath: string) => {
    for (const node of nodes) {
      const dirPath = path.join(currentPath, node.name)
      try {
        await fs.ensureDir(dirPath)
      } catch {
        failedCount++
        continue
      }
      for (const f of node.files || []) {
        const sourcePath = f.originalPath || f.path
        if (!sourcePath || !(await fs.pathExists(sourcePath))) {
          failedCount++
          failedFiles.push(sourcePath || 'Unknown')
          continue
        }
        const swap =
          ConfigOrchestrator.getInstance().getValue<boolean>('SWAP_FILE_NAME_DISPLAY') ?? false
        // 最高优先级：优先直接获取物理磁盘文件绝对路径的真实文件名
        const realDiskName = sourcePath ? path.basename(sourcePath) : ''
        const rawName = realDiskName || f._rawName || f.name || ''
        const rawSmartName = f._rawSmartName || f.smartName || rawName
        const targetFileName = swap ? rawName || rawSmartName : rawSmartName || rawName
        const targetPath = path.join(dirPath, targetFileName)

        logger.info(LogCategory.FILE_ORGANIZATION, '[moveTreeToDirectory] 移动文件导出真实目录', {
          sourcePath,
          swap,
          realDiskName,
          rawName,
          rawSmartName,
          targetFileName,
          targetPath
        })
        try {
          if (await fs.pathExists(targetPath)) {
            exportedCount++
            continue
          }
          await fs.move(sourcePath, targetPath, { overwrite: false })
          exportedCount++
        } catch (e: any) {
          failedCount++
          failedFiles.push(sourcePath)
          logger.error(LogCategory.FILE_ORGANIZATION, '[导出真实目录] 移动文件失败', {
            sourcePath,
            targetPath,
            error: e.message
          })
        }
      }
      if (node.subdirectories?.length > 0) {
        await walk(node.subdirectories, dirPath)
      }
    }
  }

  await walk(tree, targetDir)
  return {
    success: failedCount === 0,
    exportedCount,
    failedCount,
    failedFiles,
    exportPath: targetDir
  }
}

export function registerVirtualDirectoryIPCHandlers() {
  // 已分析目录相关 (原虚拟目录)
  ipcMain.handle(
    'analyzed-directory/get-dimension-groups',
    async (
      event,
      options?:
        | {
            workspaceDirectoryPath?: string
            language?: string
            excludeExtensionDimension?: boolean
            removeEmptyTags?: boolean
            virtualDirectoryId?: number
            selectedTags?: SelectedTag[]
            unionMode?: 'union' | 'intersection'
            includeAllPresetTags?: boolean
          }
        | string
    ) => {
      if (!analyzedDirectoryService) throw new Error(t('已分析目录服务未初始化'))
      // 兼容旧的 string 参数
      const opts = typeof options === 'string' ? { workspaceDirectoryPath: options } : options || {}
      const currentLanguage =
        opts.language ||
        ConfigOrchestrator.getInstance().getValue<string>('DEFAULT_LANGUAGE') ||
        'zh-CN'
      return await analyzedDirectoryService.getDimensionGroups({
        workspaceDirectoryPath: opts.workspaceDirectoryPath,
        language: currentLanguage,
        excludeExtensionDimension: opts.excludeExtensionDimension,
        removeEmptyTags: opts.removeEmptyTags,
        virtualDirectoryId: opts.virtualDirectoryId,
        selectedTags: opts.selectedTags,
        unionMode: opts.unionMode,
        includeAllPresetTags: opts.includeAllPresetTags
      })
    }
  )

  ipcMain.handle(
    'virtual-directory/list',
    async (event, workspaceIdOrPath: number | string, options?: { includeDrafts?: boolean }) => {
      return await virtualDirectoryService.list(workspaceIdOrPath, options)
    }
  )

  ipcMain.handle('virtual-directory/get', async (event, id: number) => {
    return await virtualDirectoryService.get(id)
  })
  ipcMain.handle(
    'virtual-directory/create-from-strategy',
    async (
      event,
      workspaceId: number,
      name: string,
      strategy: string,
      source: any,
      icon?: string,
      perspective?: string,
      rationale?: string
    ) => {
      return await virtualDirectoryService.createFromStrategy(
        workspaceId,
        name,
        strategy,
        source,
        icon,
        perspective,
        rationale
      )
    }
  )
  ipcMain.handle('virtual-directory/update-meta', async (event, id: number, meta: any) => {
    return await virtualDirectoryService.updateMeta(id, meta)
  })
  ipcMain.handle('virtual-directory/delete', async (event, id: number, options: any) => {
    const res = await virtualDirectoryService.delete(id, options)
    try {
      await userTierService.removeVDirEntitlement(id)
    } catch (e) {
      logger.error(LogCategory.MAIN, `[IPC] 级联清理虚拟目录 ${id} 授权失败:`, e)
    }
    return res
  })
  ipcMain.handle('virtual-directory/rename', async (event, id: number, newName: string) => {
    // 过滤目录名中的非法字符，防止文件系统错误
    const safeName = sanitizeDirectoryName(newName)
    return await virtualDirectoryService.rename(id, safeName)
  })
  ipcMain.handle(
    'virtual-directory/replace-files',
    async (event, virtualDirectoryId: number, files: any[]) => {
      return await virtualDirectoryService.replaceFiles(virtualDirectoryId, files)
    }
  )
  ipcMain.handle('virtual-directory/list-files', async (event, virtualDirectoryId: number) => {
    return await virtualDirectoryService.listFiles(virtualDirectoryId)
  })
  ipcMain.handle(
    'virtual-directory/get-tree-snapshot-as-tree',
    async (event, virtualDirectoryId: number) => {
      return await virtualDirectoryService.getTreeSnapshotAsTree(virtualDirectoryId)
    }
  )
  ipcMain.handle(
    'virtual-directory/export-to-physical',
    async (event, virtualDirectoryId: number) => {
      // 费用由 PaymentFlowDialog 在前端扣除，此处不再重复扣费
      return await virtualDirectoryService.exportToPhysical(virtualDirectoryId)
    }
  )
  ipcMain.handle(
    'virtual-directory/export-by-preview-tree',
    async (
      event,
      params: {
        type: 'virtual' | 'real'
        tree: any[]
        options: {
          flattenToRoot: boolean
          flattenDirectories: boolean
          skipEmptyDirectories: boolean
          enableNestedClassification: boolean
          deduplicateFiles: boolean
        }
        virtualDirectoryId: number
        workspaceDirectoryPath?: string
        virtualDirectoryName?: string
      }
    ) => {
      if (params.type === 'virtual') {
        if (params.tree?.length > 0) {
          const vd = await virtualDirectoryService.get(params.virtualDirectoryId)
          if (!vd) return { success: false, message: t('虚拟目录不存在') }
          const workspace = await databaseService.getWorkspaceDirectoryById(vd.workspaceId)
          if (!workspace) return { success: false, message: t('工作目录不存在') }
          const targetDir = path.join(workspace.path, VIRTUAL_DIRECTORY_ROOT, vd.name)
          await fs.ensureDir(targetDir)
          const result = await exportTreeToDirectory(params.tree, targetDir)
          return result
        }
        return await virtualDirectoryService.exportToPhysical(params.virtualDirectoryId)
      } else {
        if (params.tree?.length > 0 && params.workspaceDirectoryPath) {
          // 真实目录导出：直接在工作目录下按标签名建立子目录并移动文件，不创建外层虚拟目录名文件夹
          const result = await moveTreeToDirectory(params.tree, params.workspaceDirectoryPath)
          // 取 previewTree 第一个节点名，构建完整路径供前端选中
          const firstNodeName = params.tree[0]?.name
          const firstDirPath = firstNodeName
            ? path.join(params.workspaceDirectoryPath, firstNodeName)
            : params.workspaceDirectoryPath
          return {
            success: true,
            statistics: {
              exportedCount: result.exportedCount,
              failedCount: result.failedCount,
              exportPath: result.exportPath,
              firstDirPath
            }
          }
        }
        if (!organizeRealDirectoryService || !params.workspaceDirectoryPath) {
          return { success: false, message: t('真实目录服务未初始化') }
        }
        const exportResult = await organizeRealDirectoryService.exportVirtualDirectoryById(
          params.virtualDirectoryId,
          params.workspaceDirectoryPath
        )
        return { success: true, statistics: exportResult }
      }
    }
  )
  // 拷贝模式重试导出失败的文件
  ipcMain.handle(
    'virtual-directory/retry-failed-export',
    async (
      event,
      params: {
        failedOperations: Array<{ source: string; target: string }>
      }
    ) => {
      const { failedOperations } = params
      let retrySuccessCount = 0
      const stillFailed: string[] = []

      for (const op of failedOperations) {
        try {
          await fs.ensureDir(path.dirname(op.target))
          await fs.copy(op.source, op.target)
          retrySuccessCount++
        } catch (err) {
          logger.warn(LogCategory.VIRTUAL_DIRECTORY, `[重试] 拷贝失败: ${op.source}`, err)
          stillFailed.push(op.source)
        }
      }

      return {
        success: stillFailed.length === 0,
        retrySuccessCount,
        stillFailedCount: stillFailed.length,
        stillFailed
      }
    }
  )
  ipcMain.handle(
    'virtual-directory/generate-name-and-strategy-candidates',
    async (
      event,
      workspaceId: number,
      count?: number,
      userHint?: string,
      organizeMode?: string,
      selectedFileIds?: number[]
    ) => {
      if (globalLlamaIndexService?.isSwitchingService()) {
        logger.info(
          LogCategory.MAIN,
          '[IPC] virtual-directory/generate-name-and-strategy-candidates: 模型正在切换中，拒绝请求'
        )
        return {
          success: false,
          status: 'SERVICE_SWITCHING',
          message: t('模型正在切换中，请等待')
        }
      }
      return await virtualDirectoryService.generateNameAndStrategyCandidates(
        workspaceId,
        count,
        userHint,
        organizeMode as any,
        selectedFileIds
      )
    }
  )
  ipcMain.handle('virtual-directory/check-is-limit-predict', async () => {
    return await virtualDirectoryService.checkIsLimitPredict()
  })
  ipcMain.handle(
    'virtual-directory/generate-external-directory-plan-prompt',
    async (
      _event,
      params: {
        fileCount: number | string
        totalDirCount?: number | string
        fileTypeDistribution: string
        tagsSection?: string
        fileStructurePreview: string
      }
    ) => {
      const currentLanguage =
        ConfigOrchestrator.getInstance().getValue<string>('DEFAULT_LANGUAGE') || 'zh-CN'
      const prompt = await loadPromptParagraph('external-directory-plan-prompt', currentLanguage, {
        fileCount: String(params.fileCount || 0),
        totalDirCount: String(params.totalDirCount || 6),
        fileTypeDistribution: params.fileTypeDistribution || '',
        tagsSection: params.tagsSection || '',
        fileStructurePreview: params.fileStructurePreview || ''
      })
      return prompt
    }
  )
  ipcMain.handle(
    'virtual-directory/estimate-reorganize-batches',
    async (_event, virtualDirectoryId: number, options: any) => {
      if (!virtualDirectoryService) throw new Error(t('虚拟目录服务未初始化'))
      // 估算整理批次只做数据库查询与数学计算，不调用 AI，模型切换期间仍可正常估算；
      // 仅当核心引擎尚未创建/初始化完成时返回 0，前端会回退到本地估算
      if (!coreEngine || !coreEngine.isInitialized()) {
        logger.warn(
          LogCategory.MAIN,
          '[IPC] virtual-directory/estimate-reorganize-batches: 核心引擎未就绪，返回 0'
        )
        return 0
      }
      return await virtualDirectoryService.estimateReorganizeBatches(virtualDirectoryId, {
        ...options,
        language: ConfigOrchestrator.getInstance().getValue('DEFAULT_LANGUAGE') as string
      })
    }
  )
  ipcMain.handle(
    'virtual-directory/reorganize',
    async (event, virtualDirectoryId: number, options: any) => {
      if (globalLlamaIndexService?.isSwitchingService()) {
        logger.info(
          LogCategory.MAIN,
          '[IPC] virtual-directory/reorganize: 模型正在切换中，拒绝请求'
        )
        return {
          success: false,
          status: 'SERVICE_SWITCHING',
          message: t('模型正在切换中，请等待')
        }
      }
      // 等待 AI 服务就绪，避免核心引擎尚未创建时抛出“核心引擎未初始化”错误
      if (globalLlamaIndexService) {
        try {
          await globalLlamaIndexService.waitForReady(60000)
        } catch (err) {
          logger.warn(LogCategory.MAIN, '[IPC] virtual-directory/reorganize: AI 服务未就绪:', err)
          return {
            success: false,
            status: 'SERVICE_LOADING',
            message: t('AI 服务正在初始化中，请稍候再试')
          }
        }
      }
      // 核心引擎尚未创建/初始化完成（初始化阶段刚结束存在极短竞争窗口），同样返回未就绪提示
      if (!coreEngine || !coreEngine.isInitialized()) {
        logger.warn(LogCategory.MAIN, '[IPC] virtual-directory/reorganize: 核心引擎未就绪')
        return {
          success: false,
          status: 'SERVICE_LOADING',
          message: t('AI 服务正在初始化中，请稍候再试')
        }
      }
      reorganizePauseFlags.set(virtualDirectoryId, false)
      reorganizeEndFlags.set(virtualDirectoryId, false)
      return await virtualDirectoryService.reorganize(virtualDirectoryId, {
        ...options,
        language: ConfigOrchestrator.getInstance().getValue('DEFAULT_LANGUAGE') as string,
        onProgress: progress => {
          event.sender.send('virtual-directory/reorganize-progress', progress)
        },
        checkPaused: async () => {
          while (reorganizePauseFlags.get(virtualDirectoryId)) {
            if (reorganizeEndFlags.get(virtualDirectoryId)) return false
            await new Promise(resolve => setTimeout(resolve, 200))
          }
          return !reorganizeEndFlags.get(virtualDirectoryId)
        }
      })
    }
  )
  ipcMain.handle(
    'virtual-directory/pause-reorganize',
    async (_event, virtualDirectoryId: number) => {
      reorganizePauseFlags.set(virtualDirectoryId, true)
      return { success: true }
    }
  )
  ipcMain.handle(
    'virtual-directory/resume-reorganize',
    async (_event, virtualDirectoryId: number) => {
      reorganizePauseFlags.set(virtualDirectoryId, false)
      return { success: true }
    }
  )
  ipcMain.handle('virtual-directory/end-reorganize', async (_event, virtualDirectoryId: number) => {
    reorganizePauseFlags.set(virtualDirectoryId, false)
    reorganizeEndFlags.set(virtualDirectoryId, true)
    return { success: true }
  })
  ipcMain.handle(
    'virtual-directory/get-incremental-files-to-organize',
    async (
      _event,
      workspaceDirectoryPath: string,
      virtualDirectoryId: number,
      workspaceId?: number
    ) => {
      if (!virtualDirectoryService) throw new Error(t('虚拟目录服务未初始化'))
      let wsId = workspaceId
      if (!wsId && workspaceDirectoryPath) {
        const ws = await databaseService.findRootWorkspaceDirectory(workspaceDirectoryPath)
        if (ws) wsId = ws.id
      }

      // 获取当前工作区的全量已分析文件
      const files = await analyzedDirectoryService.getFilteredFiles({
        selectedTags: [],
        sortBy: 'name',
        sortOrder: 'asc',
        workspaceDirectoryPath
      })

      return await virtualDirectoryService.getIncrementalFilesToOrganize(
        wsId || 0,
        virtualDirectoryId,
        files || []
      )
    }
  )

  ipcMain.handle(
    'virtual-directory/sync-incremental-directory-tree',
    async (_event, virtualDirectoryId: number, selectedTagsTree: any[]) => {
      if (!virtualDirectoryService) throw new Error(t('虚拟目录服务未初始化'))
      return await virtualDirectoryService.syncIncrementalDirectoryTree(
        virtualDirectoryId,
        selectedTagsTree
      )
    }
  )
  ipcMain.handle(
    'virtual-directory/sync-physical-hardlinks',
    async (_event, virtualDirectoryId: number, workspacePath: string) => {
      if (!virtualDirectoryService) throw new Error(t('虚拟目录服务未初始化'))
      return await virtualDirectoryService.syncPhysicalHardlinks(virtualDirectoryId, workspacePath)
    }
  )
  ipcMain.handle('analyzed-directory/get-filtered-files', async (event, params: any) => {
    if (!analyzedDirectoryService) throw new Error(t('虚拟目录服务未初始化'))
    return await analyzedDirectoryService.getFilteredFiles(params)
  })

  ipcMain.handle('analyzed-directory/get-filtered-files-paged', async (event, params: any) => {
    if (!analyzedDirectoryService) throw new Error(t('虚拟目录服务未初始化'))
    return await analyzedDirectoryService.getFilteredFilesPaged(params)
  })
  ipcMain.handle(
    'analyzed-directory/save-directory',
    async (event, directory: any, workspaceDirectoryPath?: string) => {
      if (!analyzedDirectoryService) throw new Error(t('虚拟目录服务未初始化'))
      return await analyzedDirectoryService.saveDirectory(directory, workspaceDirectoryPath)
    }
  )
  ipcMain.handle(
    'analyzed-directory/batch-save-directories',
    async (event, directories: any[], workspaceDirectoryPath: string) => {
      if (!analyzedDirectoryService) throw new Error(t('虚拟目录服务未初始化'))
      return await analyzedDirectoryService.batchSaveDirectories(
        directories,
        workspaceDirectoryPath
      )
    }
  )
  ipcMain.handle(
    'analyzed-directory/get-saved-directories',
    async (event, workspaceDirectoryPath?: string) => {
      // 使用 analyzedDirectoryService 查询 analyzed_directories 表（generateFromPreviewTree 写入该表）
      if (!analyzedDirectoryService) throw new Error(t('虚拟目录服务未初始化'))
      return await analyzedDirectoryService.getSavedDirectories(workspaceDirectoryPath || '')
    }
  )

  ipcMain.handle(
    'analyzed-directory/delete-directory',
    async (event, id: string, workspaceDirectoryPath?: string) => {
      if (!analyzedDirectoryService) throw new Error(t('虚拟目录服务未初始化'))
      return await analyzedDirectoryService.deleteDirectory(id)
    }
  )
  ipcMain.handle(
    'analyzed-directory/rename-directory',
    async (event, id: string, newName: string) => {
      if (!analyzedDirectoryService) throw new Error(t('虚拟目录服务未初始化'))
      return await analyzedDirectoryService.renameDirectory(id, newName)
    }
  )
  ipcMain.handle('analyzed-directory/is-first', async (event, workspaceDirectoryPath?: string) => {
    if (!analyzedDirectoryService) throw new Error(t('虚拟目录服务未初始化'))
    return await analyzedDirectoryService.isFirstVirtualDirectory(workspaceDirectoryPath || '')
  })
  ipcMain.handle('analyzed-directory/cleanup', async (event, workspaceDirectoryPath: string) => {
    if (!analyzedDirectoryService) throw new Error(t('虚拟目录服务未初始化'))
    return await analyzedDirectoryService.cleanupVirtualDirectory(workspaceDirectoryPath)
  })
  ipcMain.handle(
    'analyzed-directory/get-analyzed-files-count',
    async (event, workspaceDirectoryPath?: string) => {
      if (!analyzedDirectoryService) throw new Error(t('虚拟目录服务未初始化'))
      return await analyzedDirectoryService.getAnalyzedFilesCount(workspaceDirectoryPath)
    }
  )
  ipcMain.handle('analyzed-directory/get-private-analyzed-files-count', async () => {
    if (!analyzedDirectoryService) throw new Error(t('虚拟目录服务未初始化'))
    return await analyzedDirectoryService.getAnalyzedFilesCount()
  })
  ipcMain.handle('analyzed-directory/find-first-hardlink', async (event, filePath: string) => {
    if (!analyzedDirectoryService) throw new Error(t('虚拟目录服务未初始化'))
    const workspaceDir = await databaseService.getCurrentWorkspaceDirectory()
    const workspacePath = workspaceDir?.path
    if (!workspacePath) throw new Error(t('未设置工作目录'))
    return await analyzedDirectoryService.findFirstHardlink(filePath, workspacePath)
  })
  ipcMain.handle('analyzed-directory/generate-from-preview-tree', async (event, params: any) => {
    const license = await checkLicenseAndNotify(true)
    if (license.status !== LicenseStatus.AUTHORIZED) {
      return {
        success: false,
        status: license.status,
        message: license.error || t('授权校验失败，请联网或激活企业版后再执行此操作')
      }
    }
    if (!virtualDirectoryService) throw new Error(t('虚拟目录服务未初始化'))
    const tagFileMapConverted = new Map<string, any>(Object.entries(params.tagFileMap))
    return await virtualDirectoryService.generateFromPreviewTree(
      params.workspaceDirectoryPath,
      params.directoryTree,
      tagFileMapConverted,
      params.options
    )
  })

  // 整理真实目录相关
  ipcMain.handle(
    'organize-real-directory/export-by-vd-id',
    async (
      event,
      params: {
        virtualDirectoryId: number
        workspaceDirectoryPath: string
        virtualDirectoryName: string
      }
    ) => {
      if (!organizeRealDirectoryService) throw new Error(t('整理真实目录服务未初始化'))

      const profile = await userTierService.getProfile()
      const exportCost = (profile.computed_limits?.export_rdir_cost as number) ?? 0
      if (exportCost > 0) {
        const spendResult = await userTierService.spendFirecores(exportCost, 'spend_export_rdir', {
          reference_type: 'virtual_directory',
          reference_id: String(params.virtualDirectoryId),
          virtualDirectoryName: params.virtualDirectoryName,
          virtualDirectoryId: params.virtualDirectoryId,
          workspaceDirectoryPath: params.workspaceDirectoryPath
        })
        if (!spendResult.success) {
          return { success: false, message: spendResult.message || t('萤火不足') }
        }
      }

      const exportResult = await organizeRealDirectoryService.exportVirtualDirectoryById(
        params.virtualDirectoryId,
        params.workspaceDirectoryPath
      )
      return { success: true, statistics: exportResult }
    }
  )
  ipcMain.handle(
    'organize-real-directory/by-virtual-directory',
    async (
      event,
      params: {
        workspaceDirectoryPath: string
        savedDirectories: Array<{ id: string; name: string; filter?: any }>
      }
    ) => {
      if (!organizeRealDirectoryService) throw new Error(t('整理真实目录服务未初始化'))

      const profile = await userTierService.getProfile()
      const unitCost = (profile.computed_limits?.export_rdir_cost as number) ?? 0
      if (unitCost > 0) {
        const count = params.savedDirectories?.length || 1
        const totalCost = unitCost * count
        const vdIds = (params.savedDirectories || []).map((d: any) => d.id).join(',')
        const vdName = params.savedDirectories?.[0]?.name || ''
        const spendResult = await userTierService.spendFirecores(totalCost, 'spend_export_rdir', {
          reference_type: 'virtual_directory',
          reference_id: vdIds,
          virtualDirectoryName: vdName,
          virtualDirectoryIds: vdIds,
          workspaceDirectoryPath: params.workspaceDirectoryPath
        })
        if (!spendResult.success) {
          return { success: false, message: spendResult.message || t('萤火不足') }
        }
      }

      return await organizeRealDirectoryService.organizeByVirtualDirectory(
        params.workspaceDirectoryPath,
        params.savedDirectories as any
      )
    }
  )
  ipcMain.handle('organize-real-directory/get-preview', async (event, params: any) => {
    if (!organizeRealDirectoryService) throw new Error(t('整理真实目录服务未初始化'))
    return await organizeRealDirectoryService.getOrganizePreview(
      params.workspaceDirectoryPath,
      params.savedDirectories
    )
  })
  ipcMain.handle('organize-real-directory/open-directory', async (event, directoryPath: string) => {
    if (!organizeRealDirectoryService) throw new Error(t('整理真实目录服务未初始化'))
    return await organizeRealDirectoryService.openOrganizedDirectory(directoryPath)
  })
  ipcMain.handle(
    'organize-real-directory/delete-all-virtual-directories',
    async (event, workspaceDirectoryPath: string) => {
      if (!organizeRealDirectoryService) throw new Error(t('整理真实目录服务未初始化'))
      return await organizeRealDirectoryService.deleteAllVirtualDirectories(workspaceDirectoryPath)
    }
  )
  ipcMain.handle(
    'organize-real-directory/get-saved-virtual-directories',
    async (event, workspaceDirectoryPath: string) => {
      if (!organizeRealDirectoryService) throw new Error(t('整理真实目录服务未初始化'))
      return await organizeRealDirectoryService.getSavedVirtualDirectories(workspaceDirectoryPath)
    }
  )
  ipcMain.handle(
    'organize-real-directory/get-analyzed-files',
    async (event, workspaceDirectoryPath: string) => {
      if (!organizeRealDirectoryService) throw new Error(t('整理真实目录服务未初始化'))
      return await organizeRealDirectoryService.getAnalyzedFiles(workspaceDirectoryPath)
    }
  )
  ipcMain.handle('organize-real-directory/quick-organize', async (event, params: any) => {
    const license = await checkLicenseAndNotify(true)
    if (license.status !== LicenseStatus.AUTHORIZED)
      return {
        success: false,
        status: license.status,
        message: license.error || t('授权校验失败，请联网或激活企业版后再执行此操作')
      }
    if (!organizeRealDirectoryService) throw new Error(t('整理真实目录服务未初始化'))
    return await organizeRealDirectoryService.quickOrganize(
      params.workspaceDirectoryPath,
      params.aiGeneratedStructure as any
    )
  })

  ipcMain.handle('organize-real-directory/generate-plan', async (event, params: any) => {
    if (globalLlamaIndexService?.isSwitchingService()) {
      logger.info(
        LogCategory.MAIN,
        '[IPC] organize-real-directory/generate-plan: 模型正在切换中，拒绝请求'
      )
      return {
        success: false,
        status: 'SERVICE_SWITCHING',
        message: t('模型正在切换中，请等待')
      }
    }
    const license = await checkLicenseAndNotify(true)
    if (license.status !== LicenseStatus.AUTHORIZED)
      return {
        success: false,
        status: license.status,
        message: license.error || t('授权校验失败，请联网或激活企业版后再执行此操作')
      }
    if (globalLlamaIndexService) {
      // 测试环境下跳过 AI 服务就绪等待（测试环境未初始化真实 AI 服务，
      // 否则 waitForReady 会超时并返回 SERVICE_LOADING，导致 generatePlan 无法执行）
      if (!isTestEnvironment()) {
        try {
          await globalLlamaIndexService.waitForReady(60000)
        } catch (err) {
          return {
            success: false,
            status: 'SERVICE_LOADING',
            message: t('AI 服务正在初始化中，请稍候再试')
          }
        }
      }
    }
    if (!organizeRealDirectoryService)
      return { success: false, message: t('整理真实目录服务未初始化') }
    const controller = new AbortController()
    organizePlanAbortControllers.set(params.workspaceDirectoryPath, controller)
    try {
      const result = await organizeRealDirectoryService.generateOrganizePlan(
        params.workspaceDirectoryPath,
        {
          ...params.options,
          workspaceDirectoryPath: params.workspaceDirectoryPath,
          language: ConfigOrchestrator.getInstance().getValue('DEFAULT_LANGUAGE') as string,
          signal: controller.signal,
          onProgress: (progress: any) => {
            event.sender.send('organize-plan-progress', progress)
          }
        }
      )
      return result
    } catch (error: any) {
      logger.error(LogCategory.FILE_ORGANIZATION, '一键整理生成方案失败:', error)
      return { success: false, message: t('未知错误') }
    } finally {
      organizePlanAbortControllers.delete(params.workspaceDirectoryPath)
    }
  })

  ipcMain.handle(
    'organize-real-directory/cancel-plan',
    async (_event, workspaceDirectoryPath: string) => {
      const controller = organizePlanAbortControllers.get(workspaceDirectoryPath)
      if (controller) {
        controller.abort()
        organizePlanAbortControllers.delete(workspaceDirectoryPath)
        return { success: true }
      }
      return { success: false, message: t('没有正在进行的任务') }
    }
  )

  ipcMain.handle(
    'organize-real-directory/pause-plan',
    async (_event, workspaceDirectoryPath: string) => {
      if (!organizeRealDirectoryService) return { success: false, message: t('服务未初始化') }
      const quickOrganizeService = await (
        organizeRealDirectoryService as any
      ).getQuickOrganizeService()
      quickOrganizeService.pause(workspaceDirectoryPath)
      return { success: true }
    }
  )

  ipcMain.handle(
    'organize-real-directory/resume-plan',
    async (_event, workspaceDirectoryPath: string) => {
      if (!organizeRealDirectoryService) return { success: false, message: t('服务未初始化') }
      const quickOrganizeService = await (
        organizeRealDirectoryService as any
      ).getQuickOrganizeService()
      quickOrganizeService.resume(workspaceDirectoryPath)
      return { success: true }
    }
  )

  ipcMain.handle(
    'organize-real-directory/end-plan',
    async (_event, workspaceDirectoryPath: string) => {
      if (!organizeRealDirectoryService) return { success: false, message: t('服务未初始化') }
      const quickOrganizeService = await (
        organizeRealDirectoryService as any
      ).getQuickOrganizeService()
      quickOrganizeService.end(workspaceDirectoryPath)
      return { success: true }
    }
  )

  ipcMain.handle('analyze-directory-context', async (event, dirPath: string, force?: boolean) => {
    if (globalLlamaIndexService?.isSwitchingService()) {
      logger.info(LogCategory.MAIN, '[IPC] analyze-directory-context: 模型正在切换中，拒绝请求')
      return {
        success: false,
        status: 'SERVICE_SWITCHING',
        message: t('模型正在切换中，请等待')
      }
    }
    if (process.env.IS_INTEGRATION_TEST === 'true') {
      return { success: true, directoryType: 'SPEEDY', confidence: 0.5, status: 'MOCK' }
    }
    if (globalLlamaIndexService) {
      try {
        await globalLlamaIndexService.waitForReady(60000)
      } catch (err) {
        return {
          success: false,
          status: 'SERVICE_LOADING',
          message: t('AI 服务正在初始化中，请稍候再试')
        }
      }
    }

    let activeContextService = directoryContextService
    if (!activeContextService && globalLlamaIndexService) {
      const { DirectoryContextService } =
        await import('../../runtime-services/filesystem/directory-context-service')
      activeContextService = new DirectoryContextService(globalLlamaIndexService)
      setDirectoryContextService(activeContextService)
      logger.info(
        LogCategory.MAIN,
        '[IPC] analyze-directory-context 运行时自愈绑定 directoryContextService 成功'
      )
    }

    if (!activeContextService) throw new Error(t('目录上下文服务未初始化'))
    if (force) {
      analysisQueueService.clearDirectoryContextCache(dirPath)
      // 当用户手动重新分析目录时，如果之前被识别为最小单元，清除单元记录
      try {
        const prevUnit = databaseService.db
          ?.prepare('SELECT id FROM file_units WHERE path = ?')
          .get(dirPath) as any
        if (prevUnit) {
          databaseService.db?.prepare('DELETE FROM file_units WHERE id = ?').run(prevUnit.id)
          logger.info(LogCategory.MAIN, `[IPC] 目录重新分析时清除旧的最小单元记录: ${dirPath}`)
        }
      } catch (e) {
        logger.warn(LogCategory.MAIN, '[IPC] 清除最小单元记录失败:', dirPath, e)
      }
    }
    // 画象时也检测最小单元并创建记录，与 processDirectory 行为一致
    // 开关关闭时跳过可选识别器（设计工程/音频专辑/系列文件），与批量分析路径保持一致
    try {
      const adapters = await createCoreEngineAdapters()
      const recognizer = new UnitRecognitionService(adapters.fileSystem, adapters.logger)
      const enableUnitRecognition =
        ConfigOrchestrator.getInstance().getValue<boolean>('ENABLE_UNIT_RECOGNITION')
      const unitResult = await recognizer.recognizeDirectory(dirPath, !enableUnitRecognition)
      if (unitResult.isUnit) {
        const existingUnit = databaseService.db
          ?.prepare('SELECT id FROM file_units WHERE path = ?')
          .get(dirPath) as any
        if (!existingUnit) {
          const parentPath = path.dirname(dirPath)
          const wsId = (await databaseService.findRootWorkspaceDirectory(dirPath))?.id
          if (wsId) {
            const baseQuality = unitResult.confidence
              ? Math.round(Math.min(unitResult.confidence * 10, 10))
              : undefined
            await databaseService.createUnit({
              name: path.basename(dirPath),
              type: unitResult.unitType || 'unit',
              path: dirPath,
              description: unitResult.reason,
              qualityScore: baseQuality,
              tags: unitResult.unitType ? [unitResult.unitType] : [],
              groupingReason: unitResult.reason,
              groupingConfidence: unitResult.confidence,
              workspaceId: wsId
            })
            logger.info(
              LogCategory.MAIN,
              `[IPC] 画象时识别为最小单元: ${dirPath} (${unitResult.unitType})`
            )
          }
        }
      }
    } catch (e) {
      logger.warn(LogCategory.MAIN, '[IPC] 画象时最小单元检测失败:', dirPath, e)
    }
    const currentLanguage =
      ConfigOrchestrator.getInstance().getValue<string>('DEFAULT_LANGUAGE') || 'zh-CN'
    return await activeContextService.analyzeDirectoryContext(
      dirPath,
      currentLanguage as LanguageCode,
      force
    )
  })

  ipcMain.handle('clear-directory-context', async (event, dirPath: string) => {
    if (process.env.IS_INTEGRATION_TEST === 'true') {
      return { success: true }
    }

    let activeContextService = directoryContextService
    if (!activeContextService && globalLlamaIndexService) {
      const { DirectoryContextService } =
        await import('../../runtime-services/filesystem/directory-context-service')
      activeContextService = new DirectoryContextService(globalLlamaIndexService)
      setDirectoryContextService(activeContextService)
      logger.info(
        LogCategory.MAIN,
        '[IPC] clear-directory-context 运行时自愈绑定 directoryContextService 成功'
      )
    }

    if (!activeContextService) throw new Error(t('目录上下文服务未初始化'))
    analysisQueueService.clearDirectoryContextCache(dirPath)
    return await activeContextService.clearDirectoryContext(dirPath)
  })

  ipcMain.handle(
    'update-directory-context-analysis',
    async (
      event,
      dirPath: string,
      updates: {
        namingPattern?: string
        analysisStrategy?: string
        namingTemplate?: string
        inheritMode?: {
          analysisStrategy?: 'inherit' | 'current_only' | 'broadcast'
          namingPattern?: 'inherit' | 'current_only' | 'broadcast'
          namingTemplate?: 'inherit' | 'current_only' | 'broadcast'
        }
      }
    ) => {
      let activeContextService = directoryContextService
      if (!activeContextService && globalLlamaIndexService) {
        const { DirectoryContextService } =
          await import('../../runtime-services/filesystem/directory-context-service')
        activeContextService = new DirectoryContextService(globalLlamaIndexService)
        setDirectoryContextService(activeContextService)
      }

      if (!activeContextService) throw new Error(t('目录上下文服务未初始化'))
      await activeContextService.updateDirectoryContextAnalysis(dirPath, updates)
      return { success: true }
    }
  )

  ipcMain.handle('get-effective-directory-config', async (event, dirPath: string) => {
    let activeContextService = directoryContextService
    if (!activeContextService && globalLlamaIndexService) {
      const { DirectoryContextService } =
        await import('../../runtime-services/filesystem/directory-context-service')
      activeContextService = new DirectoryContextService(globalLlamaIndexService)
      setDirectoryContextService(activeContextService)
    }

    if (!activeContextService) return null
    return await activeContextService.getEffectiveDirectoryConfig(dirPath)
  })

  ipcMain.handle('apply-directory-naming-template-to-files', async (event, dirPath: string) => {
    let activeContextService = directoryContextService
    if (!activeContextService && globalLlamaIndexService) {
      const { DirectoryContextService } =
        await import('../../runtime-services/filesystem/directory-context-service')
      activeContextService = new DirectoryContextService(globalLlamaIndexService)
      setDirectoryContextService(activeContextService)
    }

    if (!activeContextService) throw new Error(t('目录上下文服务未初始化'))
    return await activeContextService.applyNamingTemplateToDirectoryFiles(dirPath)
  })

  // ─── 批量重命名 IPC 处理程序 ─────────────────────────────────────────────
  ipcMain.handle('batch-rename:preview', async (event, template: string, files: any[]) => {
    return NamingDSLEngine.generatePreview(template, files)
  })

  ipcMain.handle('batch-rename:execute', async (event, template: string, files: any[]) => {
    return await NamingDSLEngine.executeBatchRename(template, files)
  })

  ipcMain.handle('batch-rename:random-template', async () => {
    return NamingDSLEngine.getRandomTemplate()
  })

  // ─── 批量打标签 & 标签全局删除 IPC ───────────────────────────────────────
  ipcMain.handle('batch-tag:apply', async (event, operation: any) => {
    return await databaseService.batchApplyTags(operation)
  })

  ipcMain.handle('delete-tag-globally', async (event, dimensionId: number, tagName: string) => {
    return await databaseService.deleteTagGlobally(dimensionId, tagName)
  })

  // ─── 批量查重与安全清理 IPC ───────────────────────────────────────────────
  ipcMain.handle('duplicate:scan', async (event, options: any) => {
    const { duplicateDetectionService } = await import(
      '../../runtime-services/filesystem/duplicate-detection-service'
    )
    return await duplicateDetectionService.scanDuplicates(options, progressData => {
      try {
        if (!event.sender.isDestroyed()) {
          event.sender.send('duplicate:scan-progress', progressData)
        }
      } catch {}
    })
  })

  ipcMain.handle('duplicate:trash', async (event, filePaths: string[]) => {
    const { duplicateDetectionService } = await import(
      '../../runtime-services/filesystem/duplicate-detection-service'
    )
    return await duplicateDetectionService.trashDuplicateFiles(filePaths)
  })

  ipcMain.handle(
    'duplicate:execute-fix',
    async (event, action: any, filePaths: string[], workspaceDirectoryPath?: string) => {
      const { duplicateDetectionService } = await import(
        '../../runtime-services/filesystem/duplicate-detection-service'
      )
      return await duplicateDetectionService.executeStrategyFix(
        action,
        filePaths,
        workspaceDirectoryPath
      )
    }
  )

  ipcMain.handle('duplicate:apply-keep-rule', async (event, groups: any[], rule: any) => {
    const { duplicateDetectionService } = await import(
      '../../runtime-services/filesystem/duplicate-detection-service'
    )
    duplicateDetectionService.applySmartRecommendKeep(groups, rule)
    return groups
  })
}
