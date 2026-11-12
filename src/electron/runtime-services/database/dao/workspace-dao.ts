import type { Database } from 'better-sqlite3'
import {
  WorkspaceDirectory,
  parseWorkspaceConfig,
  serializeWorkspaceConfig,
  isWorkspaceConfigReady,
  type WorkspaceConfig
} from '@firefly/types'
import {
  LogCategory,
  logger,
  isSubPath,
  isPathEqual,
  stripTrailingSlash,
  mapIntentToParameters,
  invalidateWorkspacePolicyCache
} from '@firefly/shared'
import { t } from '@app/languages'
import * as path from 'node:path'
import { WorkspaceAdmissionService } from '../../workspace/workspace-admission-service'

function extractWhitelistPatterns(parsedConfig: WorkspaceConfig | undefined): string[] {
  if (!parsedConfig || parsedConfig.status !== 'ready') return []
  const rules = parsedConfig.customIncludeRules || []
  return rules.map((r: any) => (typeof r === 'string' ? r : r.value)).filter(Boolean)
}

export class WorkspaceDao {
  constructor(private db: Database) {}
  async getAll(): Promise<WorkspaceDirectory[]> {
    const rows = this.db.prepare('SELECT * FROM workspaces ORDER BY created_at ASC').all() as any[]
    return rows.map(row => {
      const parsedConfig = parseWorkspaceConfig(row.workspace_config)
      const whitelistRules = (parsedConfig as any).customIncludeRules || []
      const whitelistPatterns = Array.isArray(whitelistRules)
        ? whitelistRules.map((r: any) => (typeof r === 'string' ? r : r.value)).filter(Boolean)
        : []

      return {
        id: row.workspace_id,
        workspace_id: row.workspace_id,
        path: row.path,
        name: row.name,
        type: row.type as 'SPEEDY' | 'PRIVATE',
        recursive: true, // 为了兼容前端旧版类型
        isActive: Boolean(row.is_active),
        autoWatch: Boolean(row.auto_watch),
        workspace_config: parsedConfig,
        lastScanAt: null,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.created_at),
        whitelist_patterns: whitelistPatterns,
        bound_workflow_id: row.bound_workflow_id ?? null
      }
    })
  }

  async getAllWithStats(): Promise<
    Array<
      WorkspaceDirectory & {
        pendingCount: number
        totalCount: number
        analyzedCount: number
      }
    >
  > {
    const rows = this.db.prepare('SELECT * FROM workspaces ORDER BY created_at ASC').all() as any[]
    const stmt = this.db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN is_analyzed = 1 THEN 1 ELSE 0 END) as analyzed
      FROM workspace_files
      WHERE workspace_id = ?
    `)

    return rows.map(row => {
      const stats = stmt.get(row.workspace_id) as
        | { total: number; analyzed: number | null }
        | undefined
      const totalCount = stats?.total || 0
      const analyzedCount = stats?.analyzed || 0
      const pendingCount = totalCount - analyzedCount
      const parsedConfig = row.workspace_config
        ? parseWorkspaceConfig(row.workspace_config)
        : undefined

      return {
        id: row.workspace_id,
        path: row.path,
        name: row.name,
        type: row.type as 'SPEEDY' | 'PRIVATE',
        recursive: true,
        isActive: Boolean(row.is_active),
        autoWatch: Boolean(row.auto_watch),
        lastScanAt: null,
        workspace_config: parsedConfig,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.created_at),
        whitelist_patterns: extractWhitelistPatterns(parsedConfig),
        bound_workflow_id: row.bound_workflow_id ?? null,
        totalCount,
        analyzedCount,
        pendingCount
      }
    })
  }

  async getCurrent(): Promise<WorkspaceDirectory | null> {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE is_active = 1 LIMIT 1').get() as any
    if (!row) return null
    const parsedConfig = parseWorkspaceConfig(row.workspace_config)
    return {
      id: row.workspace_id,
      workspace_id: row.workspace_id,
      path: row.path,
      name: row.name,
      type: row.type as 'SPEEDY' | 'PRIVATE',
      recursive: true,
      isActive: Boolean(row.is_active),
      autoWatch: Boolean(row.auto_watch),
      workspace_config: parsedConfig,
      lastScanAt: null,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.created_at),
      whitelist_patterns: extractWhitelistPatterns(parsedConfig),
      bound_workflow_id: row.bound_workflow_id ?? null
    }
  }

  async getById(id: number): Promise<WorkspaceDirectory | null> {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE workspace_id = ?').get(id) as any
    if (!row) return null
    const parsedConfig = parseWorkspaceConfig(row.workspace_config)
    return {
      id: row.workspace_id,
      workspace_id: row.workspace_id,
      path: row.path,
      name: row.name,
      type: row.type as 'SPEEDY' | 'PRIVATE',
      recursive: true,
      isActive: Boolean(row.is_active),
      autoWatch: Boolean(row.auto_watch),
      workspace_config: parsedConfig,
      lastScanAt: null,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.created_at),
      whitelist_patterns: extractWhitelistPatterns(parsedConfig),
      bound_workflow_id: row.bound_workflow_id ?? null
    }
  }

  async getByPath(dirPath: string): Promise<WorkspaceDirectory | null> {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE path = ?').get(dirPath) as any
    if (row) {
      const parsedConfig = parseWorkspaceConfig(row.workspace_config)
      return {
        id: row.workspace_id,
        path: row.path,
        name: row.name,
        type: row.type as 'SPEEDY' | 'PRIVATE',
        recursive: true,
        isActive: Boolean(row.is_active),
        autoWatch: Boolean(row.auto_watch),
        lastScanAt: null,
        workspace_config: parsedConfig,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.created_at),
        whitelist_patterns: extractWhitelistPatterns(parsedConfig),
        bound_workflow_id: row.bound_workflow_id ?? null
      }
    }
    const all = await this.getAll()
    const matched = all.find(w => isPathEqual(w.path, dirPath))
    return matched || null
  }

  async add(directory: WorkspaceDirectory): Promise<number> {
    const allDirectories = await this.getAll()
    const sep = path.sep
    const newPath = directory.path
    const newType = directory.type || 'SPEEDY'
    // 用于子路径匹配的前缀：确保以斜杠结尾
    const newPathPrefix = newPath.endsWith(sep) ? newPath : newPath + sep

    for (const existing of allDirectories) {
      const existingPath = existing.path
      const existingType = existing.type

      if (isPathEqual(newPath, existingPath)) {
        if (existingType !== newType) {
          const typeName = existingType === 'SPEEDY' ? '极速目录' : '私有目录'
          throw new Error(t('该目录已创建为{typeName}', { typeName }))
        }
        return existing.id!
      }

      const isSubDir = isSubPath(existingPath, newPath)
      const isParentDir = isSubPath(newPath, existingPath)

      if (isSubDir || isParentDir) {
        if (newType !== existingType) {
          const newTypeName = newType === 'SPEEDY' ? '极速目录' : '私有目录'
          const existingTypeName = existingType === 'SPEEDY' ? '极速目录' : '私有目录'

          if (isSubDir) {
            throw new Error(
              `添加失败：${newTypeName}不能包含在已有的${existingTypeName} "${existing.name}" 中`
            )
          } else {
            throw new Error(
              `添加失败：${newTypeName}包含了已有的${existingTypeName} "${existing.name}"`
            )
          }
        }
      }
    }

    const result = this.db
      .prepare(
        `
      INSERT INTO workspaces 
      (path, name, type, is_active, auto_watch, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        directory.path,
        directory.name,
        newType,
        directory.isActive ? 1 : 0,
        directory.autoWatch ? 1 : 0,
        new Date().toISOString()
      )
    return result.lastInsertRowid as number
  }

  /**
   * 获取目录分析结果
   */
  async getDirectoryAnalysisResult(dirPath: string): Promise<any | null> {
    const row = this.db
      .prepare(
        `
      SELECT * FROM workspace_directories WHERE path = ?
    `
      )
      .get(dirPath) as any
    if (!row) return null

    // 聚合统计信息
    const stats = this.db
      .prepare(
        `
      SELECT COUNT(*) as total, SUM(is_analyzed) as analyzed
      FROM workspace_files
      WHERE directory_id = ?
    `
      )
      .get(row.id) as { total: number; analyzed: number }

    return {
      id: row.id,
      path: row.path,
      name: row.name,
      contextAnalysis: row.context_analysis ? JSON.parse(row.context_analysis) : null,
      isAnalyzed: row.is_analyzed === 1,
      lastAnalyzedAt: row.last_analyzed_at,
      createdAt: row.created_at,
      updatedAt: row.modified_at,
      fileCount: stats.total,
      analyzedFileCount: stats.analyzed || 0
    }
  }

  /**
   * 更新目录分析结果
   */
  async updateDirectoryAnalysisResult(dirPath: string, analysis: any): Promise<void> {
    this.db
      .prepare(
        `
      UPDATE workspace_directories
      SET context_analysis = ?, is_analyzed = 1, last_analyzed_at = ?, modified_at = ?
      WHERE path = ?
    `
      )
      .run(JSON.stringify(analysis), new Date().toISOString(), new Date().toISOString(), dirPath)
  }

  async setCurrent(dirPath: string): Promise<void> {
    this.db.transaction(() => {
      this.db.prepare('UPDATE workspaces SET is_active = 0').run()
      // 优先精确匹配；未命中时忽略大小写/尾斜杠兜底匹配（与 getByPath/findRoot 行为一致）
      let target = this.db
        .prepare('SELECT workspace_id FROM workspaces WHERE path = ?')
        .get(dirPath) as { workspace_id: number } | undefined
      if (!target) {
        const all = this.db.prepare('SELECT workspace_id, path FROM workspaces').all() as {
          workspace_id: number
          path: string
        }[]
        const matched = all.find(ws =>
          isPathEqual(stripTrailingSlash(ws.path), stripTrailingSlash(dirPath))
        )
        if (matched) target = { workspace_id: matched.workspace_id }
      }
      if (target) {
        this.db
          .prepare('UPDATE workspaces SET is_active = 1 WHERE workspace_id = ?')
          .run(target.workspace_id)
      }
    })()
  }

  async delete(directoryPath: string): Promise<void> {
    // 优先精确匹配；未命中时忽略大小写/尾斜杠兜底匹配（与 getByPath/findRoot 行为一致）
    let targetWorkspace = this.db
      .prepare(
        `
      SELECT workspace_id FROM workspaces
      WHERE path = ?
    `
      )
      .get(directoryPath) as { workspace_id: number } | undefined

    if (!targetWorkspace) {
      const allWorkspaces = this.db.prepare(`SELECT workspace_id, path FROM workspaces`).all() as {
        workspace_id: number
        path: string
      }[]
      const matched = allWorkspaces.find(ws =>
        isPathEqual(stripTrailingSlash(ws.path), stripTrailingSlash(directoryPath))
      )
      if (matched) {
        targetWorkspace = { workspace_id: matched.workspace_id }
        logger.info(
          LogCategory.DATABASE_SERVICE,
          '删除工作目录：精确路径未匹配，已忽略大小写/尾斜杠差异匹配',
          { path: directoryPath, matchedPath: matched.path }
        )
      }
    }

    if (!targetWorkspace) {
      logger.warn(LogCategory.DATABASE_SERVICE, '工作目录不存在，无需删除', { path: directoryPath })
      return
    }

    const workspaceId = targetWorkspace.workspace_id

    logger.info(LogCategory.DATABASE_SERVICE, '开始删除工作目录', {
      path: directoryPath,
      workspaceId
    })

    // 1. 在事务开始前，通过单次集合子查询提取该工作区独占的孤儿指纹（不再被任何其他工作区引用）
    // 依赖 (workspace_id, file_fingerprint) 复合索引，毫秒级完成差集计算
    const orphanFingerprints: string[] = this.db
      .prepare(
        `SELECT DISTINCT wf.file_fingerprint
         FROM workspace_files wf
         WHERE wf.workspace_id = ?
           AND wf.file_fingerprint IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM workspace_files other
             WHERE other.file_fingerprint = wf.file_fingerprint
               AND other.workspace_id != ?
           )`
      )
      .all(workspaceId, workspaceId)
      .map((r: any) => r.file_fingerprint)

    // 收集所有需要通知 Omni 向量引擎物理清理的指纹（主指纹 + 视频切片指纹）
    const allFingerprintsToDelete: string[] = []
    if (orphanFingerprints.length > 0) {
      allFingerprintsToDelete.push(...orphanFingerprints)
      // 分批查出孤儿切片指纹
      const batchSize = 500
      for (let i = 0; i < orphanFingerprints.length; i += batchSize) {
        const batch = orphanFingerprints.slice(i, i + batchSize)
        const placeholders = batch.map(() => '?').join(',')
        try {
          const chunkRows = this.db
            .prepare(
              `SELECT file_fingerprint, chunk_index FROM file_video_chunks WHERE file_fingerprint IN (${placeholders})`
            )
            .all(...batch) as Array<{ file_fingerprint: string; chunk_index: number }>
          const chunkFingerprints = chunkRows.map(r => `${r.file_fingerprint}:c${r.chunk_index}`)
          allFingerprintsToDelete.push(...chunkFingerprints)
        } catch (chunkErr) {
          logger.warn(LogCategory.DATABASE_SERVICE, '查询孤儿切片指纹失败:', chunkErr)
        }
      }
    }

    // 2. 单次事务原子物理清除数据库记录
    this.db.transaction(() => {
      // 2.1 清理分析队列（直接基于集合子查询）
      this.db
        .prepare(
          `DELETE FROM analysis_queue WHERE item_type = 'file' AND item_id IN (
             SELECT id FROM workspace_files WHERE workspace_id = ?
           )`
        )
        .run(workspaceId)

      // 2.2 清理孤儿 files 主表（级联触发 file_contents, file_tag_relations, file_video_chunks）
      if (orphanFingerprints.length > 0) {
        const batchSize = 500
        for (let i = 0; i < orphanFingerprints.length; i += batchSize) {
          const batch = orphanFingerprints.slice(i, i + batchSize)
          const placeholders = batch.map(() => '?').join(',')
          this.db
            .prepare(`DELETE FROM files WHERE file_fingerprint IN (${placeholders})`)
            .run(...batch)
        }
      }

      // 2.3 删除工作区相关记录
      this.db.prepare(`DELETE FROM workspace_files WHERE workspace_id = ?`).run(workspaceId)
      this.db.prepare(`DELETE FROM workspace_directories WHERE workspace_id = ?`).run(workspaceId)
      this.db.prepare(`DELETE FROM virtual_directories WHERE workspace_id = ?`).run(workspaceId)
      this.db.prepare(`DELETE FROM workspaces WHERE workspace_id = ?`).run(workspaceId)

      logger.info(LogCategory.DATABASE_SERVICE, `工作区及其关联文件已彻底清空`, {
        workspaceId,
        path: directoryPath,
        orphanCount: orphanFingerprints.length
      })
    })()

    // 3. 严格在 SQLite 事务提交成功后，再在事务外部触发异步网络物理清理，杜绝单向脏数据
    if (allFingerprintsToDelete.length > 0) {
      import('../../../services/omni-client')
        .then(({ omniClient }) => {
          return omniClient.deleteVectors(allFingerprintsToDelete)
        })
        .catch(err => {
          logger.warn(
            LogCategory.DATABASE_SERVICE,
            '级联清理 Omni 孤儿向量失败（将在下一次重启时自愈）',
            { count: allFingerprintsToDelete.length, err }
          )
        })
    }

    logger.info(LogCategory.DATABASE_SERVICE, '工作目录删除完成', { path: directoryPath })
  }

  async updateAutoWatch(workspaceId: number, autoWatch: boolean): Promise<void> {
    this.db
      .prepare('UPDATE workspaces SET auto_watch = ? WHERE workspace_id = ?')
      .run(autoWatch ? 1 : 0, workspaceId)
  }

  /**
   * 更新目录的最后扫描时间
   */
  async updateLastScan(workspaceId: number): Promise<void> {
    this.db
      .prepare('UPDATE workspaces SET last_scan_at = ? WHERE workspace_id = ?')
      .run(new Date().toISOString(), workspaceId)
  }

  async findRoot(filePath: string): Promise<WorkspaceDirectory | null> {
    try {
      const roots = await this.getAll()

      let bestMatch: WorkspaceDirectory | null = null
      let maxLen = -1

      for (const root of roots) {
        if (isSubPath(root.path, filePath)) {
          if (root.path.length > maxLen) {
            maxLen = root.path.length
            bestMatch = root
          }
        }
      }
      return bestMatch
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, '查找根工作目录失败', { error, filePath })
      return null
    }
  }

  /**
   * 根据 ID 更新 workspace_files 的 status 状态
   */
  async updateFileStatus(fileId: number, status: number): Promise<void> {
    try {
      this.db
        .prepare('UPDATE workspace_files SET status = ?, modified_at = ? WHERE id = ?')
        .run(status, new Date().toISOString(), fileId)
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, '更新文件状态失败', { error, fileId, status })
    }
  }

  /**
   * 根据路径更新 workspace_files 的 status 状态
   */
  async updateFileStatusByPath(filePath: string, status: number): Promise<void> {
    try {
      this.db
        .prepare('UPDATE workspace_files SET status = ?, modified_at = ? WHERE path = ?')
        .run(status, new Date().toISOString(), filePath)
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, '根据路径更新文件状态失败', {
        error,
        filePath,
        status
      })
    }
  }
  /**
   * 获取工作区专有配置 (已解析强类型)
   */
  async getConfig(workspaceId: number): Promise<WorkspaceConfig> {
    const row = this.db
      .prepare('SELECT workspace_config FROM workspaces WHERE workspace_id = ?')
      .get(workspaceId) as any
    return parseWorkspaceConfig(row?.workspace_config)
  }

  /**
   * 更新工作区专有配置
   */
  async updateConfig(workspaceId: number, config: WorkspaceConfig): Promise<boolean> {
    if (config.status === 'ready' && !isWorkspaceConfigReady(config)) {
      throw new Error(
        '[WorkspaceDao] 拒绝写入非法 ready 配置: 缺少必要基础 AI 配置 (baseAIConfig) 或过滤规则数组'
      )
    }
    const serialized = serializeWorkspaceConfig(config)
    const result = this.db
      .prepare('UPDATE workspaces SET workspace_config = ? WHERE workspace_id = ?')
      .run(serialized, workspaceId)
    invalidateWorkspacePolicyCache(workspaceId)
    return result.changes > 0
  }

  /**
   * 检查工作区是否已配置就绪 (调度前置门闩硬校验)
   */
  async isConfigReady(workspaceId: number): Promise<boolean> {
    const config = await this.getConfig(workspaceId)
    return isWorkspaceConfigReady(config)
  }

  async updateWhitelistPatterns(workspaceId: number, patterns: string[]): Promise<boolean> {
    const admission = new WorkspaceAdmissionService({ db: this.db })
    await admission.applyPolicyMutation(workspaceId, { customWhitelistExts: patterns || [] })
    return true
  }

  /**
   * 应用工作流配置到工作区 (直接填入 local_workflows.workspace_config 并绑定)
   */
  async applyWorkflowConfig(workspaceId: number, workflowId: string): Promise<boolean> {
    const template = this.db
      .prepare('SELECT workspace_config FROM local_workflows WHERE id = ?')
      .get(workflowId) as { workspace_config: string } | undefined

    if (!template || !template.workspace_config) {
      throw new Error(`WORKFLOW_TEMPLATE_NOT_FOUND: ${workflowId}`)
    }

    const currentConfig = await this.getConfig(workspaceId)
    const nextPolicyVersion =
      (currentConfig.status === 'ready' ? currentConfig.policyVersion : 0) + 1

    const changed = this.db.transaction(() => {
      const stmt = this.db.prepare(`
        UPDATE workspaces
        SET 
          bound_workflow_id = ?,
          workspace_config = json_set(
            (SELECT workspace_config FROM local_workflows WHERE id = ?),
            '$.policyVersion', ?,
            '$.configuredAt', ?
          )
        WHERE workspace_id = ?
      `)
      const res = stmt.run(workflowId, workflowId, nextPolicyVersion, Date.now(), workspaceId)
      try {
        this.db
          .prepare('UPDATE workspace_directories SET bound_workflow_id = ? WHERE workspace_id = ?')
          .run(workflowId, workspaceId)
      } catch {}
      return res.changes > 0
    })()
    invalidateWorkspacePolicyCache(workspaceId)
    return changed
  }

  /**
   * 一键恢复工作区配置为绑定的工作流初始预设 (单调递增 policyVersion 防倒退，原子执行)
   */
  async restoreWorkflowConfig(workspaceId: number): Promise<boolean> {
    const row = this.db
      .prepare('SELECT bound_workflow_id, workspace_config FROM workspaces WHERE workspace_id = ?')
      .get(workspaceId) as
      | { bound_workflow_id: string | null; workspace_config: string }
      | undefined

    if (!row || !row.bound_workflow_id) {
      throw new Error('BOUND_WORKFLOW_NOT_FOUND')
    }

    const currentConfig = parseWorkspaceConfig(row.workspace_config)
    const nextPolicyVersion =
      (currentConfig.status === 'ready' ? currentConfig.policyVersion : 0) + 1

    const stmt = this.db.prepare(`
      UPDATE workspaces 
      SET 
        workspace_config = json_set(
          (SELECT workspace_config FROM local_workflows WHERE id = workspaces.bound_workflow_id),
          '$.policyVersion', ?,
          '$.configuredAt', ?
        )
      WHERE workspace_id = ? AND bound_workflow_id IS NOT NULL
    `)

    const result = stmt.run(nextPolicyVersion, Date.now(), workspaceId)
    invalidateWorkspacePolicyCache(workspaceId)
    return result.changes > 0
  }

  /**
   * 测算白名单规则在当前工作区文件中的命中影响（支持同目录伴生文件保护计数）
   */
  async calculateWhitelistImpact(
    workspaceId: number,
    patterns: string[]
  ): Promise<{ totalFiles: number; includedFiles: number; excludedFiles: number; companionFilesProtected?: number }> {
    const admission = new WorkspaceAdmissionService({ db: this.db })
    return admission.previewPolicyImpact(workspaceId, { customWhitelistExts: patterns || [] })
  }

  async updateBoundWorkflow(workspaceId: number, workflowId: string | null): Promise<boolean> {
    const result = this.db
      .prepare('UPDATE workspaces SET bound_workflow_id = ? WHERE workspace_id = ?')
      .run(workflowId, workspaceId)
    try {
      this.db
        .prepare('UPDATE workspace_directories SET bound_workflow_id = ? WHERE workspace_id = ?')
        .run(workflowId, workspaceId)
    } catch (err) {
      logger.warn(
        LogCategory.DATABASE,
        `同步更新子目录 bound_workflow_id 异常: ${workspaceId}`,
        err
      )
    }
    invalidateWorkspacePolicyCache(workspaceId)
    return result.changes > 0
  }
}
