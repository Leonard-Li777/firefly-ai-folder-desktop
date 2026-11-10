/**
 * 设置相关 IPC 处理器
 * 负责处理前端关于系统设置、忽略规则、工作目录管理的请求
 */
import { ipcMain, BrowserWindow } from 'electron'
import { logger, LogCategory } from '@firefly/shared'
import { databaseService } from '../database/database-service'
import { ConfigOrchestrator } from '@app/electron/config/config-orchestrator'
import { ConfigDbManager } from '../config/config-db-manager'
import { loadIgnoreRules, getSystemIgnoreRules } from '../analysis/analysis-exclusion-service'
import type { IIgnoreRule } from '@firefly/types/settings-types'
import type { WorkspaceConfig } from '@firefly/types'
import fs from 'node:fs'
import path from 'node:path'
import { t } from '@app/languages'
import { analysisQueueService } from '../analysis-queue-service'
import { fileWatcherService } from '../filesystem/file-watcher-service'
import { cleanupVirtualDirectoryOnDelete } from '../filesystem/virtual-directory-cleanup'
export { cleanupVirtualDirectoryOnDelete }
import { thumbnailService } from '../filesystem/thumbnail-service'
import { omniClient } from '../../services/omni-client'
import {
  workspaceAdmissionService,
  type WorkspacePolicyMutation
} from '../workspace/workspace-admission-service'
import {
  workspacePolicyCommitService,
  type CommitWorkspacePolicyParams
} from '../workspace/workspace-policy-commit-service'

/** 校验忽略规则类型 */
function isValidIgnoreRuleType(value: unknown): value is IIgnoreRule['type'] {
  return (
    value === 'file' ||
    value === 'directory' ||
    value === 'extension' ||
    value === 'regex' ||
    value === 'wildcard' ||
    value === 'pattern'
  )
}

/** 生成唯一的忽略规则 ID */
function generateIgnoreRuleId(): string {
  return `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 保存忽略规则（到统一配置）
 */
async function saveIgnoreRulesToConfig(rules: IIgnoreRule[]): Promise<void> {
  const systemRules = getSystemIgnoreRules()
  const systemIds = new Set(systemRules.map(r => r.id))
  const sanitizedUserRules: IIgnoreRule[] = []

  if (Array.isArray(rules)) {
    for (const rule of rules) {
      if (!rule || typeof rule !== 'object') continue
      if (rule.isSystem) continue

      const id =
        typeof rule.id === 'string' && rule.id.trim().length > 0 ? rule.id : generateIgnoreRuleId()
      if (systemIds.has(id)) continue
      if (!isValidIgnoreRuleType(rule.type)) continue
      if (typeof rule.value !== 'string' || rule.value.trim().length === 0) continue

      sanitizedUserRules.push({
        id,
        type: rule.type,
        value: rule.value,
        isSystem: false,
        isActive: typeof rule.isActive === 'boolean' ? rule.isActive : true,
        description: rule.description
      })
    }
  }

  try {
    const finalRules = [...systemRules, ...sanitizedUserRules]
    await ConfigOrchestrator.getInstance().updateValue('IGNORE_RULES', finalRules)
  } catch (error) {
    logger.error(LogCategory.SETTING, '保存忽略规则到统一配置失败:', error)
    throw error
  }
}

/**
 * 清空/重置工作目录数据时清理 .VirtualDirectory 内部临时产物，
 * 严格保留 .tts 与 .thumbnail 缓存目录，以便后续需要时复用
 */
export async function cleanupVirtualDirectoryOnReset(directoryPath: string): Promise<void> {
  const virtualDirPath = path.join(directoryPath, '.VirtualDirectory')
  if (!fs.existsSync(virtualDirPath)) return

  try {
    const entries = await fs.promises.readdir(virtualDirPath, { withFileTypes: true })
    for (const entry of entries) {
      // 清空工作目录数据时，必须保留 .tts 以及 .thumbnail 目录，以便后续复用
      if (entry.name === '.tts' || entry.name === '.thumbnail') continue
      const fullPath = path.join(virtualDirPath, entry.name)
      await fs.promises.rm(fullPath, { recursive: true, force: true })
    }
    logger.info(
      LogCategory.SETTING,
      '重置工作目录数据：.VirtualDirectory 清理完成（已保留 .tts 与 .thumbnail 缓存）:',
      directoryPath
    )
  } catch (fsError) {
    logger.warn(LogCategory.SETTING, '重置工作目录数据：清理 .VirtualDirectory 失败:', {
      directoryPath,
      fsError
    })
  }
}

/** 注册设置相关的 IPC 处理器 */
export function registerSettingsIPCHandlers(): void {
  // 获取 AI 分析忽略规则
  ipcMain.handle('getAnalysisIgnoreRules', async () => {
    try {
      return loadIgnoreRules()
    } catch (error) {
      logger.error(LogCategory.SETTING, 'IPC 获取忽略规则失败:', error)
      return []
    }
  })

  // 保存 AI 分析忽略规则
  ipcMain.handle('saveAnalysisIgnoreRules', async (event, rules: IIgnoreRule[]) => {
    try {
      // 1. 保存到持久化配置
      await saveIgnoreRulesToConfig(rules)

      // 2. 异步通知其他服务重载（不阻塞 IPC 返回）
      setImmediate(async () => {
        try {
          // 通知分析队列
          if (
            analysisQueueService &&
            typeof analysisQueueService.reloadIgnoreRules === 'function'
          ) {
            analysisQueueService.reloadIgnoreRules()
          }

          // 通知文件监听服务
          if (fileWatcherService && typeof fileWatcherService.reloadIgnoreRules === 'function') {
            await fileWatcherService.reloadIgnoreRules()
          }

          // 向 Omni 服务同步最新排除保护清单
          const { omniService } = await import('../system')
          if (omniService && typeof omniService.syncConfigFromDesktop === 'function') {
            omniService.syncConfigFromDesktop().catch(() => {})
          }

          // 通知渲染进程刷新
          const windows = BrowserWindow.getAllWindows()
          windows.forEach(win => {
            if (!win.isDestroyed()) {
              win.webContents.send('ignore-rules-changed')
            }
          })
        } catch (notifyError) {
          logger.warn(LogCategory.SETTING, '保存规则后的服务通知失败:', notifyError)
        }
      })

      return { success: true }
    } catch (error) {
      logger.error(LogCategory.SETTING, '保存忽略规则 IPC 处理失败:', error)
      throw error
    }
  })

  // 删除工作目录及其关联数据
  ipcMain.handle('delete-workspace-directory', async (event, idOrPath: number | string) => {
    try {
      let workspaceId: number | undefined
      let directoryPath: string | undefined

      if (typeof idOrPath === 'number') {
        workspaceId = idOrPath
        const ws = await databaseService.getWorkspaceDirectoryById(workspaceId)
        directoryPath = ws?.path
      } else {
        directoryPath = idOrPath
        const ws = await databaseService.findRootWorkspaceDirectory(directoryPath)
        workspaceId = ws?.id
      }

      if (!directoryPath) {
        logger.warn(LogCategory.SETTING, '删除工作目录失败：未找到目录路径', { idOrPath })
        return { success: false, error: t('未找到工作区') }
      }

      logger.info(LogCategory.SETTING, '开始删除工作目录:', directoryPath)

      // 步骤 0: 停止文件监听
      if (workspaceId) {
        await fileWatcherService.stopWatching(workspaceId)
      }

      // 步骤 1: 先中止并清空该目录的分析任务。
      //
      // 顺序不可颠倒：在途的缩略图 / 文件处理任务正握着 .VirtualDirectory/.thumbnail 的
      // 写入句柄，若先删物理目录，fs.rm 会撞 EBUSY（errno -4082）；即便侥幸删掉，
      // 也会被在途任务原样重建出来（曾在日志中复现：删后 4 分钟目录重新出现）。
      try {
        if (analysisQueueService) {
          await analysisQueueService.abortAndDeleteItemsByDirectory(directoryPath)
        }
      } catch (queueError) {
        logger.error(LogCategory.SETTING, '删除工作目录：中止分析任务失败:', queueError)
      }

      // 步骤 1.1: 释放 Sharp 缩略图引擎持有的文件句柄与内存缓存，规避 Windows EBUSY (-4082) 占用
      try {
        thumbnailService.releaseSharpMemory()
      } catch (sharpErr) {
        logger.warn(LogCategory.SETTING, '删除工作目录：释放 Sharp 句柄异常:', sharpErr)
      }

      // 步骤 2: 彻底物理删除工作目录下的 .VirtualDirectory 文件夹（失败必须回传，禁止静默）
      const virtualDirectoryCleaned = await cleanupVirtualDirectoryOnDelete(directoryPath)

      // 步骤 3: 从数据库删除记录
      await databaseService.deleteWorkspaceDirectory(directoryPath)

      // 步骤 3.1: 验证删除是否真正生效，防止静默失败导致前端误报成功
      const stillExists = await databaseService.getWorkspaceDirectoryByPath(directoryPath)
      if (stillExists) {
        logger.warn(LogCategory.SETTING, '删除工作目录失败：数据库记录仍存在', {
          path: directoryPath,
          workspaceId: stillExists.id
        })
        return { success: false, error: t('删除工作目录失败，请重试') }
      }

      // 步骤 4: 通知渲染进程刷新
      BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) {
          win.webContents.send('workspace-directories-updated')
        }
      })

      // 数据库记录已删除，主流程算成功；但缓存目录残留必须回传，
      // 由前端明确提示用户，绝不能让「已删除」掩盖磁盘上的脏数据。
      if (!virtualDirectoryCleaned) {
        return {
          success: true,
          warning: t(
            '工作目录已移除，但缓存目录 .VirtualDirectory 删除失败（可能被占用），请稍后手动删除'
          )
        }
      }

      return { success: true }
    } catch (error) {
      logger.error(LogCategory.SETTING, '删除工作目录失败:', error)
      throw error
    }
  })

  // 重置工作目录的 AI 分析数据
  ipcMain.handle('reset-workspace-directory', async (event, idOrPath: number | string) => {
    try {
      let directoryPath: string | undefined

      if (typeof idOrPath === 'number') {
        const ws = await databaseService.getWorkspaceDirectoryById(idOrPath)
        directoryPath = ws?.path
      } else {
        directoryPath = idOrPath
      }

      if (directoryPath) {
        // 步骤 0: 中止该目录下在途分析任务并释放队列句柄，规避 Windows EBUSY 与脏数据死灰复燃
        try {
          await analysisQueueService.abortAndDeleteItemsByDirectory(directoryPath)
        } catch (queueErr) {
          logger.warn(LogCategory.SETTING, '重置工作目录：中止分析任务异常:', queueErr)
        }

        // 步骤 0.1: 释放 Sharp 缩略图引擎句柄与内存，规避 Windows 文件占用
        try {
          thumbnailService.releaseSharpMemory()
        } catch (sharpErr) {
          logger.warn(LogCategory.SETTING, '重置工作目录：释放 Sharp 句柄异常:', sharpErr)
        }

        // Phase 1: SQLite 事务内清空数据并提交
        const resetFingerprints =
          await databaseService.resetWorkspaceDirectoryAnalysis(directoryPath)
        omniClient.clearTaxonomyTreeCache()

        // Phase 2: 严格在 SQLite 事务提交后，在事务外部异步清理 Omni 向量索引 (包含主指纹与分块切片指纹)
        if (resetFingerprints && resetFingerprints.length > 0) {
          omniClient.deleteVectors(resetFingerprints).catch(err => {
            logger.warn(
              LogCategory.DATABASE_SERVICE,
              '重置工作区级联清理 Omni 向量失败（将在下一次重启时自愈）',
              { count: resetFingerprints.length, err }
            )
          })
        }

        // 清理工作目录下的 .VirtualDirectory（严格保留 .tts 与 .thumbnail 缓存供后续复用）
        await cleanupVirtualDirectoryOnReset(directoryPath)

        // 通知渲染进程刷新
        BrowserWindow.getAllWindows().forEach(win => {
          if (!win.isDestroyed()) {
            win.webContents.send('workspace-directories-updated')
          }
        })

        return { success: true }
      }
      return { success: false, error: t('未找到工作区') }
    } catch (error) {
      logger.error(LogCategory.SETTING, '重置工作目录数据失败:', error)
      throw error
    }
  })

  // 扫描工作目录 (旧版别名支持)
  const handleScan = async (event: any, workspaceId: number) => {
    try {
      const workspace = await databaseService.getWorkspaceDirectoryById(workspaceId)
      if (!workspace) return { success: false, error: t('未找到工作区') }

      const { fileWatcherService } = await import('../filesystem/file-watcher-service')
      await fileWatcherService.syncDirectory(workspace.path, true)

      // 更新最后扫描时间
      await databaseService.updateWorkspaceDirectoryLastScan(workspaceId)

      return { success: true }
    } catch (error) {
      logger.error(LogCategory.SETTING, '扫描目录失败:', error)
      throw error
    }
  }

  ipcMain.handle('scan-workspace-directory', handleScan)
  ipcMain.handle('rescanWorkspaceDirectory', handleScan)

  // 更新工作目录的 autoWatch 状态
  ipcMain.handle(
    'update-workspace-directory-auto-watch',
    async (event, workspaceId: number, autoWatch: boolean) => {
      try {
        logger.info(LogCategory.SETTING, '更新工作目录 autoWatch 状态:', { workspaceId, autoWatch })

        // 更新数据库
        await databaseService.updateAutoWatch(workspaceId, autoWatch)

        // 启动或停止文件监听
        const { fileWatcherService } = await import('../filesystem/file-watcher-service')
        const directory = await databaseService.getWorkspaceDirectoryById(workspaceId)

        if (!directory) {
          throw new Error(t('未找到工作目录 ID: {workspaceId}', { workspaceId }))
        }

        if (autoWatch && directory.isActive) {
          await fileWatcherService.startWatching(workspaceId, directory.path)
        } else {
          await fileWatcherService.stopWatching(workspaceId)
        }

        return { success: true }
      } catch (error) {
        logger.error(LogCategory.SETTING, '更新工作目录 autoWatch 状态失败:', error)
        throw error
      }
    }
  )

  // 重置 AI 分析数据库

  // 获取工作区专有配置 (已就绪强类型或待配置对象)
  ipcMain.handle('get-workspace-config', async (_event, workspaceId: number) => {
    try {
      return await databaseService.getWorkspaceConfig(workspaceId)
    } catch (error) {
      logger.error(LogCategory.SETTING, `获取工作区配置失败: ${workspaceId}`, error)
      throw error
    }
  })

  // 获取本地工作流列表（ConfigDbManager 数据中枢缓存，缓存未命中时回退 DB 查询）
  // 该通道此前仅在 preload 暴露而主进程未注册 handler，导致渲染层恒收到空列表，
  // 工作区向导遂在 selectedWorkflow 为 undefined 时解引用 .id 崩溃。
  ipcMain.handle(
    'get-local-workflows',
    async (_event, filter?: { source?: string; category?: string }) => {
      try {
        const data = ConfigDbManager.getInstance().getLocalWorkflows(filter)
        return { success: true, data }
      } catch (error) {
        logger.error(LogCategory.SETTING, '获取本地工作流列表失败:', error)
        return {
          success: false,
          data: [],
          error: (error as Error)?.message || String(error)
        }
      }
    }
  )

  // 更新工作区专有配置 (通过 WorkspaceAdmissionService 单一写入口，自动计算准入指纹并执行版本自增与索引解绑 [M07])
  ipcMain.handle(
    'update-workspace-config',
    async (_event, workspaceId: number, config: WorkspaceConfig) => {
      try {
        if (!config || config.status !== 'ready') {
          // pending 态直接更新数据库
          const success = await databaseService.updateWorkspaceConfig(workspaceId, config)
          if (success) {
            BrowserWindow.getAllWindows().forEach(win => {
              if (!win.isDestroyed()) {
                win.webContents.send('workspace-directories-updated')
              }
            })
          }
          return { success }
        }

        const mutation: WorkspacePolicyMutation = {
          workflowId: config.workflowId,
          includeRules: config.customWhitelistRules,
          excludeRules: config.customIgnoreRules,
          baseAIConfig: config.baseAIConfig,
          derivedSnapshot: config.derivedSnapshot,
          intent: config.intent,
          overrides: config.overrides,
          advancedAIPrompts: config.advancedAIPrompts,
          unitRecognition: config.unitRecognition,
          namingPattern: config.namingPattern,
          namingTemplate: config.namingTemplate
        }

        const result = await workspaceAdmissionService.applyPolicyMutation(workspaceId, mutation)

        BrowserWindow.getAllWindows().forEach(win => {
          if (!win.isDestroyed()) {
            win.webContents.send('workspace-directories-updated')
          }
        })

        // 若更新为已就绪 (ready)，主动唤醒分析队列处理栈，解除静默挂起
        void analysisQueueService.start(workspaceId)

        return {
          success: true,
          policyVersion: result.policyVersion,
          admissionChanged: result.admissionChanged,
          needsRescan: result.needsRescan,
          prunedFilesCount: result.prunedFilesCount,
          cancelledTasksCount: result.cancelledTasksCount
        }
      } catch (error) {
        logger.error(LogCategory.SETTING, `更新工作区配置失败: ${workspaceId}`, error)
        return { success: false, error: (error as any)?.message || String(error) }
      }
    }
  )

  // 提交工作区策略变更 (通过 WorkspacePolicyCommitService 原子递增 policyVersion 并合并规则 [Spec v1.1 §2.2])
  ipcMain.handle('commit-workspace-policy', async (_event, params: CommitWorkspacePolicyParams) => {
    try {
      const result = await workspacePolicyCommitService.commitPolicy(params)
      if (result.success) {
        BrowserWindow.getAllWindows().forEach(win => {
          if (!win.isDestroyed()) {
            win.webContents.send('workspace-directories-updated')
          }
        })
        if (params.workspaceId) {
          void analysisQueueService.start(Number(params.workspaceId))
        }
      }
      return result
    } catch (error) {
      logger.error(
        LogCategory.SETTING,
        `commit-workspace-policy 异常: ${params?.workspaceId}`,
        error
      )
      return {
        success: false,
        policyVersion: 0,
        error: {
          code: 'UNKNOWN',
          message: (error as Error)?.message || String(error)
        }
      }
    }
  })

  const handleUpdateInclusion = async (workspaceId: number, patterns: string[]) => {
    try {
      const result = await workspaceAdmissionService.applyPolicyMutation(workspaceId, {
        includeExts: patterns
      })
      BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) {
          win.webContents.send('workspace-directories-updated')
        }
      })
      return {
        success: true,
        policyVersion: result.policyVersion,
        admissionChanged: result.admissionChanged,
        needsRescan: result.needsRescan,
        prunedFilesCount: result.prunedFilesCount,
        cancelledTasksCount: result.cancelledTasksCount
      }
    } catch (error) {
      logger.error(LogCategory.SETTING, `更新工作区包含规则失败: ${workspaceId}`, error)
      return { success: false, error: (error as any)?.message || String(error) }
    }
  }

  const handlePreviewInclusionImpact = async (workspaceId: number, patterns: string[]) => {
    try {
      let probeExtensionCounts: Record<string, number> | undefined
      const workspace = await databaseService.getWorkspaceDirectoryById(workspaceId)
      if (workspace?.path && fs.existsSync(workspace.path)) {
        try {
          const { directoryProfilerService } =
            await import('../filesystem/directory-profiler-service')
          const profile = await directoryProfilerService.probeProfile(workspace.path)
          if ((profile.stats as any)?.extensionCounts) {
            probeExtensionCounts = (profile.stats as any).extensionCounts
          }
        } catch {
          // 采样探针异常降级
        }
      }

      const impact = await workspaceAdmissionService.previewPolicyImpact(
        workspaceId,
        { includeExts: patterns },
        probeExtensionCounts
      )
      return {
        success: true,
        totalFiles: impact.totalFiles,
        includedFiles: impact.includedFiles,
        excludedFiles: impact.excludedFiles,
        companionFilesProtected: impact.companionFilesProtected,
        isSampled: (impact as any).isSampled ?? false
      }
    } catch (error) {
      logger.error(LogCategory.SETTING, `预览包含规则影响失败: ${workspaceId}`, error)
      return { success: false, error: (error as any)?.message || String(error) }
    }
  }

  // 1. 规范对称命名 IPC 频道
  ipcMain.handle('update-workspace-inclusion', (_event, workspaceId: number, patterns: string[]) =>
    handleUpdateInclusion(workspaceId, patterns)
  )
  ipcMain.handle(
    'preview-workspace-inclusion-impact',
    (_event, workspaceId: number, patterns: string[]) =>
      handlePreviewInclusionImpact(workspaceId, patterns)
  )

  // 2. 兼容旧版命名 IPC 频道
  ipcMain.handle('update-workspace-whitelist', (_event, workspaceId: number, patterns: string[]) =>
    handleUpdateInclusion(workspaceId, patterns)
  )
  ipcMain.handle(
    'preview-workspace-whitelist-impact',
    (_event, workspaceId: number, patterns: string[]) =>
      handlePreviewInclusionImpact(workspaceId, patterns)
  )

  // 更新工作区绑定的工作流 (通过 WorkspaceAdmissionService 单一写入口 [M07])
  ipcMain.handle(
    'update-workspace-bound-workflow',
    async (_event, workspaceId: number, workflowId: string | null) => {
      try {
        const result = await workspaceAdmissionService.applyPolicyMutation(workspaceId, {
          workflowId,
          restoreWorkflowDefault: workflowId !== null // 绑定新工作流时套用模板默认规则，解绑置空时保留规则
        })
        if (workflowId === null) {
          logger.info(
            LogCategory.SETTING,
            `[工作流解绑] 工作区 ${workspaceId} 已成功解除工作流绑定，白名单快照依法保留`
          )
        } else {
          logger.info(
            LogCategory.SETTING,
            `[工作流绑定] 工作区 ${workspaceId} 已成功绑定工作流: ${workflowId}`
          )
        }
        BrowserWindow.getAllWindows().forEach(win => {
          if (!win.isDestroyed()) {
            win.webContents.send('workspace-directories-updated')
          }
        })
        return {
          success: true,
          policyVersion: result.policyVersion,
          admissionChanged: result.admissionChanged,
          needsRescan: result.needsRescan,
          prunedFilesCount: result.prunedFilesCount,
          cancelledTasksCount: result.cancelledTasksCount
        }
      } catch (error) {
        logger.error(LogCategory.SETTING, `更新工作区绑定工作流失败: ${workspaceId}`, error)
        return { success: false, error: (error as any)?.message || String(error) }
      }
    }
  )

  ipcMain.handle('resetAnalysisDatabase', async () => {
    try {
      logger.info(LogCategory.SETTING, '重置 AI 分析数据库...')
      await databaseService.resetAllAnalysisData()
      omniClient.clearTaxonomyTreeCache()

      // 清理所有工作目录的 .VirtualDirectory（严格保留 .tts 与 .thumbnail 缓存供后续复用）
      const workspaces = await databaseService.getAllWorkspaceDirectories()
      for (const ws of workspaces) {
        await cleanupVirtualDirectoryOnReset(ws.path)
      }

      return { success: true }
    } catch (error) {
      logger.error(LogCategory.SETTING, '重置 AI 分析数据库失败:', error)
      throw error
    }
  })
}
