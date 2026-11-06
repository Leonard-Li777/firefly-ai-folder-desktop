/**
 * 本地工作流编排与模板服务 (Local Workflow Service)
 * 遵循 Spec v1.1 §5、§6 与 Issue 12d 规范：
 * 负责 .ffw 声明式归档包的流式安全导入导出、插件依赖审查、以及工作流持久化调度
 */
import type {
  WorkflowTemplateManifest,
  WorkflowArchivePackage,
  WorkflowImportResult,
  LocalWorkflowRecord
} from '@firefly/types'
import {
  readWorkflowArchive,
  exportWorkflowArchive,
  inspectPluginDependencies,
  logger,
  LogCategory
} from '@firefly/shared'

export interface ILocalWorkflowDatabase {
  saveLocalWorkflow(
    record: Omit<LocalWorkflowRecord, 'created_at' | 'modified_at'>
  ): Promise<boolean>
  getLocalWorkflowById(id: string): Promise<LocalWorkflowRecord | undefined>
  getAllLocalWorkflows(): Promise<LocalWorkflowRecord[]>
  deleteLocalWorkflow(id: string): Promise<boolean>
}

export class LocalWorkflowService {
  constructor(private dbService?: ILocalWorkflowDatabase) {}

  private getDb(): ILocalWorkflowDatabase {
    if (this.dbService) return this.dbService
    // 惰性加载 DatabaseService 单例，避免纯工具层或单元测试循环引入与启动消耗
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { databaseService } = require('../database/database-service')
    return databaseService
  }

  /**
   * 安全导入 .ffw 工作流归档包
   * 包含：流式按名解压、Zip Slip / Bomb 防御、SVG XSS 拦截、依赖比对与 SQLite 持久化
   */
  async importWorkflowArchive(
    archiveBuffer: Buffer | Uint8Array,
    installedPluginIds: string[] | Set<string> = []
  ): Promise<WorkflowImportResult> {
    logger.info(LogCategory.SYSTEM, '[工作流服务] 开始解析并导入工作流归档包')

    try {
      // 1. 安全解析归档包
      const archivePkg = await readWorkflowArchive(archiveBuffer)
      const { manifest } = archivePkg

      // 2. 检查依赖插件装配状态
      const inspection = inspectPluginDependencies(manifest, installedPluginIds)

      let unifiedConfig = manifest.workspaceConfig
      if (typeof unifiedConfig === 'string') {
        try {
          unifiedConfig = JSON.parse(unifiedConfig)
        } catch {}
      }
      const resolvedWorkflowId =
        manifest.id && manifest.id.trim()
          ? manifest.id.trim()
          : `wf_usr_${Math.random().toString(36).substring(2, 10)}${Date.now().toString(36).slice(-4)}`

      const baseAi =
        (unifiedConfig as any)?.baseAIConfig ||
        (unifiedConfig as any)?.derivedSnapshot ||
        manifest.engineParameters ||
        {}
      const workspaceConfigStr = JSON.stringify({
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: resolvedWorkflowId,
        customIgnoreRules:
          (unifiedConfig as any)?.customIgnoreRules ||
          (manifest.filterMode === 'blacklist' ? manifest.filterPatterns || [] : []),
        customWhitelistRules:
          (unifiedConfig as any)?.customWhitelistRules ||
          (manifest.filterMode === 'whitelist'
            ? manifest.whitelistPatterns || manifest.filterPatterns || []
            : []),
        baseAIConfig: baseAi,
        derivedSnapshot: baseAi,
        advancedAIPrompts: (unifiedConfig as any)?.advancedAIPrompts || undefined,
        unitRecognition: (unifiedConfig as any)?.unitRecognition || undefined,
        namingPattern: manifest.namingPattern || (unifiedConfig as any)?.namingPattern || undefined,
        namingTemplate:
          manifest.namingTemplate || (unifiedConfig as any)?.namingTemplate || undefined,
        configuredAt: Date.now()
      })

      // 3. 落库 SQLite local_workflows 表 (表本身字段即是单一事实源，无需冗余 manifest_json)
      const success = await this.getDb().saveLocalWorkflow({
        id: resolvedWorkflowId,
        user_id: manifest.userId || null,
        author: manifest.author || null,
        name: manifest.name,
        version: manifest.version,
        persona: manifest.persona,
        category: manifest.category || 'entertainment',
        summary: manifest.summary,
        source: manifest.source || 'imported',
        status: manifest.status || 'draft',
        workspace_config: workspaceConfigStr,
        naming_pattern: manifest.namingPattern || null,
        naming_template: manifest.namingTemplate || null,
        preset_directory_tree: manifest.presetDirectoryTree
          ? JSON.stringify(manifest.presetDirectoryTree)
          : null,
        preview_tree: manifest.previewTree ? JSON.stringify(manifest.previewTree) : null,
        icon_svg: archivePkg.iconSvg || manifest.iconSvg || null
      })

      if (!success) {
        throw new Error(`保存工作流记录到数据库失败: ${resolvedWorkflowId}`)
      }

      logger.info(
        LogCategory.SYSTEM,
        `[工作流服务] 成功导入工作流 ${manifest.name} (${resolvedWorkflowId}), 缺失插件数: ${inspection.missingPlugins.length}`
      )

      return {
        success: true,
        workflowId: resolvedWorkflowId,
        manifest,
        missingPlugins: inspection.missingPlugins,
        canProceedWithoutPlugins: true
      }
    } catch (err: any) {
      logger.error(LogCategory.SYSTEM, `[工作流服务] 导入工作流归档包失败: ${err?.message || err}`)
      return {
        success: false,
        canProceedWithoutPlugins: false,
        error: err?.message || String(err)
      }
    }
  }

  /**
   * 导出指定工作流为标准 .ffw (ZIP) 归档包
   */
  async exportWorkflowArchive(
    workflowId: string,
    options?: {
      promptClusterMarkdown?: string
      namingTemplatesJson?: Record<string, any>
      iconSvg?: string
    }
  ): Promise<{ buffer: Buffer; sha256: string }> {
    logger.info(LogCategory.SYSTEM, `[工作流服务] 开始导出工作流归档包: ${workflowId}`)

    const record = await this.getDb().getLocalWorkflowById(workflowId)
    if (!record) {
      throw new Error(`未找到指定的工作流记录: ${workflowId}`)
    }

    let workspaceConfig: any = undefined
    if (record.workspace_config) {
      try {
        workspaceConfig = JSON.parse(record.workspace_config)
      } catch {}
    }

    const whitelistRules = workspaceConfig?.customWhitelistRules || []
    const filterPatterns = Array.isArray(whitelistRules)
      ? whitelistRules.map((r: any) => (typeof r === 'string' ? r : r.value)).filter(Boolean)
      : []

    let presetDirectoryTree: any[] | undefined = undefined
    if (record.preset_directory_tree) {
      try {
        presetDirectoryTree = JSON.parse(record.preset_directory_tree)
      } catch {}
    }

    let previewTree: any = undefined
    if (record.preview_tree) {
      try {
        previewTree = JSON.parse(record.preview_tree)
      } catch {}
    }

    const manifest: WorkflowTemplateManifest = {
      id: record.id,
      userId: record.user_id,
      author: record.author || undefined,
      category: record.category as any,
      source: record.source as any,
      status: record.status as any,
      name: record.name,
      version: record.version,
      persona: record.persona,
      summary: record.summary,
      namingPattern: record.naming_pattern || undefined,
      namingTemplate: record.naming_template || undefined,
      workspaceConfig,
      presetDirectoryTree,
      previewTree,
      iconSvg: record.icon_svg || undefined,
      filterPatterns
    }

    let parsedNamingTemplates: Record<string, any> | undefined
    if (options?.namingTemplatesJson) {
      parsedNamingTemplates = options.namingTemplatesJson
    } else if (record.naming_template) {
      try {
        parsedNamingTemplates = JSON.parse(record.naming_template)
      } catch {
        parsedNamingTemplates = { template: record.naming_template }
      }
    }

    const pkg: Omit<WorkflowArchivePackage, 'sha256'> = {
      manifest,
      promptClusterMarkdown: options?.promptClusterMarkdown,
      namingTemplatesJson: parsedNamingTemplates,
      iconSvg: options?.iconSvg ?? (record.icon_svg || undefined)
    }

    return exportWorkflowArchive(pkg)
  }

  /**
   * 获取所有本地工作流
   */
  async getAllWorkflows(): Promise<LocalWorkflowRecord[]> {
    return this.getDb().getAllLocalWorkflows()
  }

  /**
   * 根据 ID 获取工作流
   */
  async getWorkflow(id: string): Promise<LocalWorkflowRecord | undefined> {
    return this.getDb().getLocalWorkflowById(id)
  }

  /**
   * 删除本地工作流
   */
  async deleteWorkflow(id: string): Promise<boolean> {
    return this.getDb().deleteLocalWorkflow(id)
  }
}

export const localWorkflowService = new LocalWorkflowService()
