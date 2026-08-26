import {
  VirtualDirectory,
  VirtualDirectoryFileInput,
  VirtualDirectoryFileRow,
  VirtualDirectoryNode,
  PhysicalExportResult,
  DirectoryReorganizeOptions,
  DirectoryReorganizeResult,
  AIDirectoryStructure
} from '@firefly/types'
import { LogCategory, logger, sanitizeDirectoryName } from '@firefly/shared'
import { t } from '@app/languages'
import Database from 'better-sqlite3'
import { databaseService } from '../../database/database-service'
import fs from 'fs-extra'
import path from 'node:path'
import { DimensionManager } from '../analyzed-directory-service/DimensionManager'
import { FileFilter } from '../analyzed-directory-service/FileFilter'
import { LinkManager } from './LinkManager'
import { PersistenceManager } from './PersistenceManager'
import { VIRTUAL_DIRECTORY_ROOT, copyReadmeFile } from './utils'
import { IconManager, FOLDER_ICONS, EXCLUDED_FOLDER_ICONS } from './IconManager'
import { TreeBuilder } from './TreeBuilder'
import { Exporter } from './Exporter'
import { AISchemeGenerator } from './AISchemeGenerator'
import { PreviewTreeExporter } from './PreviewTreeExporter'
import { ConfigOrchestrator } from '../../../config/config-orchestrator'

export class VirtualDirectoryService {
  private _db: Database.Database | null = null
  private _initialized = false
  private _dimensionManager: DimensionManager | null = null
  private _fileFilter: FileFilter | null = null
  private _linkManager: LinkManager | null = null
  private _persistenceManager: PersistenceManager | null = null

  private _iconManager: IconManager | null = null
  private _treeBuilder: TreeBuilder | null = null
  private _exporter: Exporter | null = null
  private _aiSchemeGenerator: AISchemeGenerator | null = null
  private _previewTreeExporter: PreviewTreeExporter | null = null

  private _customDb = false

  constructor(db?: Database.Database) {
    if (db) {
      this._db = db
      this._customDb = true
      this.initDelegates()
      this._initialized = true
    }
  }

  private ensureInitialized() {
    if (this._customDb && this._db) return
    if (this._initialized && this._db === databaseService.db) return
    this._db = databaseService.db
    if (!this._db) throw new Error('[VirtualDirectoryService] Database not initialized')
    this.initDelegates()
    this._initialized = true
  }

  private initDelegates() {
    const db = this._db!
    this._dimensionManager = new DimensionManager(db)
    this._fileFilter = new FileFilter(db, tag => this._dimensionManager!.getExtensionsForTag(tag))
    this._linkManager = new LinkManager(
      db,
      params => this._fileFilter!.getFilteredFiles(params),
      virtualDirPath => copyReadmeFile(virtualDirPath)
    )
    this._persistenceManager = new PersistenceManager(db)

    this._iconManager = new IconManager(db)
    this._treeBuilder = new TreeBuilder(this)
    this._exporter = new Exporter(this)
    this._aiSchemeGenerator = new AISchemeGenerator(this)
    this._previewTreeExporter = new PreviewTreeExporter(this)
  }

  public get db(): Database.Database {
    this.ensureInitialized()
    return this._db!
  }

  /**
   * 重置服务状态，在数据库重新初始化后调用（如语言切换）
   */
  reset(): void {
    this._db = null
    this._dimensionManager = null
    this._fileFilter = null
    this._linkManager = null
    this._persistenceManager = null
    this._iconManager = null
    this._treeBuilder = null
    this._exporter = null
    this._aiSchemeGenerator = null
    this._previewTreeExporter = null
    this._initialized = false
  }

  // ---------- 元数据 ----------
  async list(
    workspaceIdOrPath?: number | string | null,
    options?: { includeDrafts?: boolean }
  ): Promise<VirtualDirectory[]> {
    this.ensureInitialized()

    const selectFields = `
      vd.id, 
      vd.workspace_id AS workspaceId, 
      vd.name, 
      vd.strategy, 
      vd.source, 
      vd.icon, 
      vd.perspective, 
      vd.ai_prompt AS aiPrompt, 
      vd.ai_prompt AS rationale, 
      vd.source_analyzed_directory_id AS sourceAnalyzedDirectoryId, 
      vd.created_at AS createdAt, 
      vd.updated_at AS updatedAt,
      (SELECT COUNT(1) FROM virtual_directory_files vdf WHERE vdf.virtual_directory_id = vd.id AND vdf.relative_path NOT LIKE '%.keep') AS fileCount,
      (SELECT COUNT(1) FROM virtual_directory_files vdf WHERE vdf.virtual_directory_id = vd.id AND vdf.relative_path NOT LIKE '%.keep' AND (vdf.relative_path = '未归类' OR vdf.relative_path LIKE '未归类/%' OR vdf.relative_path LIKE '未归类\\%')) AS unclassifiedCount
    `

    const draftFilter = options?.includeDrafts ? '' : "(vd.source IS NULL OR vd.source != 'draft')"
    const orderBy = `ORDER BY (CASE WHEN vd.source = 'draft' THEN 0 ELSE 1 END) ASC, vd.created_at ASC`

    if (!workspaceIdOrPath) {
      let query = `
        SELECT ${selectFields}
        FROM virtual_directories vd
      `
      if (draftFilter) {
        query += ` WHERE ${draftFilter}`
      }
      query += ` ${orderBy}`
      const rows = this.db.prepare(query).all() as any[]
      return this.enrichDirectoryCounts(rows)
    }

    let wsId: number | null = typeof workspaceIdOrPath === 'number' ? workspaceIdOrPath : null
    let rawPath: string | null = typeof workspaceIdOrPath === 'string' ? workspaceIdOrPath : null
    let cleanPath: string | null = rawPath ? rawPath.replace(/[\\\/]+$/, '') : null

    if (!wsId && cleanPath) {
      const row =
        (this.db
          .prepare("SELECT workspace_id FROM workspaces WHERE RTRIM(path, '/\\') = ? OR path = ?")
          .get(cleanPath, rawPath) as any) ||
        (this.db
          .prepare("SELECT id FROM workspace_directories WHERE RTRIM(path, '/\\') = ? OR path = ?")
          .get(cleanPath, rawPath) as any)
      if (row) wsId = row.workspace_id || row.id
    }

    const whereConditions: string[] = []
    const params: any[] = []

    if (draftFilter) {
      whereConditions.push(draftFilter)
    }

    if (wsId) {
      whereConditions.push(
        `(vd.workspace_id = ? OR vd.workspace_id IN (SELECT id FROM workspace_directories WHERE RTRIM(path, '/\\') = (SELECT RTRIM(path, '/\\') FROM workspaces WHERE workspace_id = ?)))`
      )
      params.push(wsId, wsId)
    } else if (cleanPath) {
      whereConditions.push(
        `(vd.workspace_id IN (SELECT id FROM workspace_directories WHERE RTRIM(path, '/\\') = ? OR path = ?) OR vd.workspace_id IN (SELECT workspace_id FROM workspaces WHERE RTRIM(path, '/\\') = ? OR path = ?))`
      )
      params.push(cleanPath, rawPath, cleanPath, rawPath)
    }

    let query = `
      SELECT ${selectFields}
      FROM virtual_directories vd
    `
    if (whereConditions.length > 0) {
      query += ` WHERE ${whereConditions.join(' AND ')}`
    }
    query += ` ${orderBy}`

    const results = this.db.prepare(query).all(...params) as any[]

    if (results.length === 0) {
      let fallbackQuery = `
        SELECT ${selectFields}
        FROM virtual_directories vd
      `
      if (draftFilter) {
        fallbackQuery += ` WHERE ${draftFilter}`
      }
      fallbackQuery += ` ${orderBy}`
      const fallbackRows = this.db.prepare(fallbackQuery).all() as any[]
      return this.enrichDirectoryCounts(fallbackRows)
    }

    return this.enrichDirectoryCounts(results)
  }

  private enrichDirectoryCounts(results: any[]): any[] {
    if (!results || results.length === 0) return results
    const dirStmt = this.db.prepare(
      'SELECT relative_path FROM virtual_directory_files WHERE virtual_directory_id = ?'
    )

    for (const row of results) {
      const fileRows = dirStmt.all(row.id) as { relative_path: string }[]
      const dirSet = new Set<string>()
      for (const f of fileRows) {
        const rel = f.relative_path || ''
        const parts = rel.split(/[/\\]/)
        const dirParts = parts.slice(0, -1)
        let currentPath = ''
        for (const part of dirParts) {
          if (!part || part === '.' || part === '未归类') continue
          currentPath = currentPath ? `${currentPath}/${part}` : part
          dirSet.add(currentPath)
        }
      }
      row.dirCount = dirSet.size
      row.directoryCount = dirSet.size
    }
    return results
  }

  async get(id: number): Promise<VirtualDirectory | null> {
    const selectFields = `
      vd.id, 
      vd.workspace_id AS workspaceId, 
      vd.name, 
      vd.strategy, 
      vd.source, 
      vd.icon, 
      vd.perspective, 
      vd.ai_prompt AS aiPrompt, 
      vd.ai_prompt AS rationale, 
      vd.source_analyzed_directory_id AS sourceAnalyzedDirectoryId, 
      vd.created_at AS createdAt, 
      vd.updated_at AS updatedAt,
      (SELECT COUNT(1) FROM virtual_directory_files vdf WHERE vdf.virtual_directory_id = vd.id AND vdf.relative_path NOT LIKE '%.keep') AS fileCount,
      (SELECT COUNT(1) FROM virtual_directory_files vdf WHERE vdf.virtual_directory_id = vd.id AND vdf.relative_path NOT LIKE '%.keep' AND (vdf.relative_path = '未归类' OR vdf.relative_path LIKE '未归类/%' OR vdf.relative_path LIKE '未归类\\%')) AS unclassifiedCount
    `
    return (
      (this.db
        .prepare(
          `
      SELECT ${selectFields}
      FROM virtual_directories vd WHERE vd.id = ?
    `
        )
        .get(id) as any) || null
    )
  }

  async createFromStrategy(
    workspaceId: number,
    name: string,
    strategy: string,
    source: string,
    icon?: string,
    perspective?: string,
    rationale?: string
  ): Promise<VirtualDirectory> {
    const now = new Date().toISOString()
    // 如果没有指定图标，自动分配一个未被使用的图标
    const resolvedIcon =
      icon ||
      this._iconManager!.pickUniqueIcon(FOLDER_ICONS.filter(i => !EXCLUDED_FOLDER_ICONS.has(i)))
    const insert = this.db.prepare(
      'INSERT INTO virtual_directories (workspace_id, name, strategy, source, icon, perspective, ai_prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )

    // 同工作区内同名冲突时自动追加序号
    let finalName = name
    const match = name.match(/^(.*?)(?:\s*\(\d+\))?$/)
    const rootName = (match && match[1] ? match[1].trim() : name) || name

    let attempt = 0
    const maxAttempts = 100
    while (attempt < maxAttempts) {
      try {
        const result = insert.run(
          workspaceId,
          finalName,
          strategy,
          source,
          resolvedIcon,
          perspective || null,
          rationale || null,
          now,
          now
        )
        return this.get(Number(result.lastInsertRowid)) as any
      } catch (e: any) {
        if (e?.code === 'SQLITE_CONSTRAINT_UNIQUE' || e?.message?.includes('UNIQUE constraint')) {
          attempt++
          finalName = `${rootName} (${attempt})`
        } else {
          throw e
        }
      }
    }

    throw new Error(t('无法创建虚拟目录：名称"{name}"及其所有衍生名称均已被占用', { name }))
  }

  async updateMeta(id: number, meta: Partial<VirtualDirectory>): Promise<void> {
    const vd = await this.get(id)
    if (!vd) throw new Error(t('虚拟目录不存在'))

    const workspaceId = vd.workspaceId

    // 如果尝试更改名称且与旧名称不同，则进行冲突检测与处理
    if (meta.name && meta.name !== vd.name) {
      let finalName = meta.name
      const match = meta.name.match(/^(.*?)(?:\s*\(\d+\))?$/)
      const rootName = (match && match[1] ? match[1].trim() : meta.name) || meta.name

      let attempt = 0
      const maxAttempts = 100
      const insertCheck = this.db.prepare(
        'SELECT 1 FROM virtual_directories WHERE workspace_id = ? AND name = ? AND id != ?'
      )

      while (attempt < maxAttempts) {
        const conflict = insertCheck.get(workspaceId, finalName, id)
        if (conflict) {
          attempt++
          finalName = `${rootName} (${attempt})`
        } else {
          break
        }
      }

      if (attempt >= maxAttempts) {
        throw new Error(t('无法更新名称：名称"{name}"已被占用', { name: meta.name }))
      }

      // 重命名对应的物理目录
      const workspace = await databaseService.getWorkspaceDirectoryById(workspaceId)
      if (workspace) {
        const oldPath = path.join(workspace.path, VIRTUAL_DIRECTORY_ROOT, vd.name)
        const newPath = path.join(workspace.path, VIRTUAL_DIRECTORY_ROOT, finalName)
        if (await fs.pathExists(oldPath)) {
          try {
            await fs.rename(oldPath, newPath)
          } catch (renameErr) {
            logger.error(LogCategory.FILE_ORGANIZATION, '重命名物理目录失败:', renameErr)
          }
        }
      }

      meta.name = finalName
    }

    const columnMapping: Record<string, string> = {
      workspaceId: 'workspace_id',
      aiPrompt: 'ai_prompt',
      rationale: 'ai_prompt',
      perspective: 'perspective',
      strategy: 'strategy',
      source: 'source',
      name: 'name',
      icon: 'icon'
    }

    const updateEntries: Array<{ col: string; val: any }> = []
    for (const key of Object.keys(meta)) {
      if (key === 'id') continue
      const col = columnMapping[key] || key
      updateEntries.push({ col, val: (meta as any)[key] })
    }

    if (updateEntries.length > 0) {
      const fields = updateEntries.map(e => `${e.col} = ?`).join(', ')
      const values = updateEntries.map(e => e.val)
      this.db
        .prepare(`UPDATE virtual_directories SET ${fields}, updated_at = ? WHERE id = ?`)
        .run(...values, new Date().toISOString(), id)
    }
  }

  async delete(id: number, options?: { deletePhysical: boolean }): Promise<void> {
    const vd = await this.get(id)
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM virtual_directory_files WHERE virtual_directory_id = ?').run(id)
      this.db.prepare('DELETE FROM virtual_directories WHERE id = ?').run(id)
    })()

    if (options?.deletePhysical && vd) {
      const workspace = await databaseService.getWorkspaceDirectoryById(vd.workspaceId)
      if (workspace) {
        const physicalPath = path.join(workspace.path, VIRTUAL_DIRECTORY_ROOT, vd.name)
        if (await fs.pathExists(physicalPath)) {
          await fs.remove(physicalPath)
        }
      }
    }
  }

  async rename(id: number, newName: string): Promise<void> {
    await this.updateMeta(id, { name: newName })
  }

  // ---------- 文件映射 ----------
  async replaceFiles(
    virtualDirectoryId: number,
    files: VirtualDirectoryFileInput[]
  ): Promise<void> {
    this.db.transaction(() => {
      // 1. 验证虚拟目录是否存在，如果不存在则直接抛出明确错误
      const vdExists = this.db
        .prepare('SELECT 1 FROM virtual_directories WHERE id = ?')
        .get(virtualDirectoryId)
      if (!vdExists) {
        throw new Error(`Virtual directory with id ${virtualDirectoryId} does not exist`)
      }

      // 2. 清理原有的映射关系
      this.db
        .prepare('DELETE FROM virtual_directory_files WHERE virtual_directory_id = ?')
        .run(virtualDirectoryId)

      // 3. 准备验证与插入操作的 SQL 语句
      const stmt = this.db.prepare(
        'INSERT INTO virtual_directory_files (virtual_directory_id, file_id, file_fingerprint, relative_path, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      const getFpStmt = this.db.prepare('SELECT file_fingerprint FROM workspace_files WHERE id = ?')

      const now = new Date().toISOString()
      const seen = new Set<string>()

      for (const file of files) {
        // 去除重复的 (file_id, relative_path) 条目，防止 UNIQUE 约束冲突
        const key = `${file.fileId}::${file.relativePath}`
        if (seen.has(key)) continue
        seen.add(key)

        // 安全校验：查询 fileId 对应的文件是否存在于数据库中以规避外键约束异常
        const dbFile = getFpStmt.get(file.fileId) as { file_fingerprint?: string } | undefined
        if (!dbFile) {
          logger.warn(
            LogCategory.VIRTUAL_DIRECTORY,
            `replaceFiles: fileId ${file.fileId} 不存在于 workspace_files 中，已被过滤并跳过插入`
          )
          continue
        }

        const fingerprint = dbFile.file_fingerprint || ''
        stmt.run(virtualDirectoryId, file.fileId, fingerprint, file.relativePath, now)
      }

      this.db
        .prepare('UPDATE virtual_directories SET updated_at = ? WHERE id = ?')
        .run(now, virtualDirectoryId)
    })()
  }

  async getVirtualDirectoryFiles(
    virtualDirectoryId: number | string,
    options?: { includeKeepFiles?: boolean }
  ): Promise<VirtualDirectoryFileRow[]> {
    let showMissing = true
    try {
      showMissing = ConfigOrchestrator.getInstance().getValue<boolean>('SHOW_MISSING_FILES') ?? true
    } catch {
      // default true if uninitialized
    }

    const vdIdStr = String(virtualDirectoryId)
    const vdIdNum = parseInt(vdIdStr, 10)

    let query = `
        SELECT
          vdf.file_id as fileId,
          vdf.file_fingerprint as fileFingerprint,
          vdf.relative_path as relativePath,
          vdf.virtual_directory_id as virtualDirectoryId,
          vdf.created_at as createdAt,
          f.smart_name as smartName,
          wf.name,
          wf.path as originalPath,
          f.size,
          f.description,
          f.author,
          f.language,
          fc.quality_score as qualityScore,
          wf.status as status,
          wf.last_analyzed_at as analyzedAt,
          wf.modified_at as modifiedAt,
          (
            SELECT json_group_array(ft.name)
            FROM file_tag_relations ftr
            JOIN file_tags ft ON ft.id = ftr.tag_id
            WHERE ftr.file_fingerprint = f.file_fingerprint
          ) as tags
        FROM virtual_directory_files vdf
               JOIN workspace_files wf ON vdf.file_id = wf.id
               JOIN files f ON vdf.file_fingerprint = f.file_fingerprint
               LEFT JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint
        WHERE vdf.virtual_directory_id = ? OR vdf.virtual_directory_id = ?
    `

    if (!showMissing) {
      query += ' AND wf.status = 1'
    }

    const rows = this.db
      .prepare(query)
      .all(virtualDirectoryId, isNaN(vdIdNum) ? -1 : vdIdNum) as any[]

    logger.info(
      LogCategory.VIRTUAL_DIRECTORY,
      `[后端] getVirtualDirectoryFiles 查出 rows 条数: ${rows.length}, virtualDirectoryId: ${virtualDirectoryId}`
    )

    return rows
      .map(row => {
        if (!options?.includeKeepFiles && row.relativePath) {
          const rel = row.relativePath.trim()
          if (rel.endsWith('.keep') || rel.endsWith('/.keep') || rel.endsWith('\\.keep')) {
            return null
          }
        }
        let currentStatus = row.status ?? 1
        if (currentStatus === 1 && row.originalPath && !fs.existsSync(row.originalPath)) {
          currentStatus = 0
          try {
            this.db.prepare('UPDATE workspace_files SET status = 0 WHERE id = ?').run(row.fileId)
          } catch {
            // ignore
          }
        } else if (currentStatus === 0 && row.originalPath && fs.existsSync(row.originalPath)) {
          currentStatus = 1
          try {
            this.db.prepare('UPDATE workspace_files SET status = 1 WHERE id = ?').run(row.fileId)
          } catch {
            // ignore
          }
        }
        if (!showMissing && currentStatus === 0) {
          return null
        }
        return {
          ...row,
          status: currentStatus
        }
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)
  }

  async listFiles(
    virtualDirectoryId: number | string,
    options?: { includeKeepFiles?: boolean }
  ): Promise<VirtualDirectoryFileRow[]> {
    return this.getVirtualDirectoryFiles(virtualDirectoryId, options)
  }

  /**
   * 增量整理模式下，提取并过滤待整理文件列表
   * 过滤掉已经在该虚拟目录非未归类子目录中整理完毕的文件
   */
  async getIncrementalFilesToOrganize<T extends { id: number | string }>(
    workspaceId: number,
    virtualDirectoryId: number,
    inputFiles: T[]
  ): Promise<T[]> {
    this.ensureInitialized()
    const safeInputFiles = Array.isArray(inputFiles) ? inputFiles : []
    if (!virtualDirectoryId || safeInputFiles.length === 0) {
      return safeInputFiles
    }

    try {
      // 1. 查询该虚拟目录中所有在非未归类目录中的 file_id
      const rows = this.db
        .prepare(
          `SELECT file_id, relative_path
           FROM virtual_directory_files
           WHERE virtual_directory_id = ?`
        )
        .all(virtualDirectoryId) as Array<{ file_id: number; relative_path: string }>

      const classifiedFileIds = new Set<string>()
      for (const row of rows) {
        const rel = (row.relative_path || '').trim()
        // 只要不是未归类开头、为空或占位符 .keep，均视为已归类完毕
        const isUnclassified =
          !rel ||
          rel === '未归类' ||
          rel.startsWith('未归类/') ||
          rel.startsWith('未归类\\') ||
          rel.endsWith('.keep')
        if (!isUnclassified) {
          classifiedFileIds.add(String(row.file_id))
        }
      }

      // 2. 过滤掉处于已归类目录中的文件
      return safeInputFiles.filter(file => file && !classifiedFileIds.has(String(file.id)))
    } catch (error) {
      logger.error(
        LogCategory.VIRTUAL_DIRECTORY,
        'Failed to get incremental files to organize:',
        error
      )
      return safeInputFiles
    }
  }

  /**
   * 增量整理同步目录树：对比提交的新目录树与原有映射
   * 若原存在的目录节点被用户删除，将该节点原有的文件移至 "未归类" 路径
   */
  async syncIncrementalDirectoryTree(
    virtualDirectoryId: number,
    selectedTagsTree: any[]
  ): Promise<void> {
    this.ensureInitialized()
    if (!virtualDirectoryId || !Array.isArray(selectedTagsTree)) return

    // 0. 安全校验：确认该 ID 的虚拟目录在数据库中真实存在
    const vdExists = this.db
      .prepare('SELECT 1 FROM virtual_directories WHERE id = ?')
      .get(virtualDirectoryId)
    if (!vdExists) {
      logger.warn(
        LogCategory.VIRTUAL_DIRECTORY,
        `[syncIncrementalDirectoryTree] 尝试同步不存在或已被删除的虚拟目录 ID: ${virtualDirectoryId}，跳过同步`
      )
      return
    }

    // 1. 递归提取 selectedTagsTree 中每个物理文件的最新 relative_path 映射
    const fileInputs: VirtualDirectoryFileInput[] = []
    const seenMap = new Set<string>()

    let anyFile: { fileId: number; fileFingerprint: string } | undefined
    const findAnchorFile = (nodes: any[]) => {
      for (const n of nodes || []) {
        if (!n) continue
        if (Array.isArray(n.files) && n.files.length > 0) {
          for (const f of n.files) {
            const fid = f.fileId ?? f.file_id ?? f.id
            if (fid != null && Number(fid) > 0) {
              anyFile = {
                fileId: Number(fid),
                fileFingerprint: String(f.fileFingerprint ?? f.file_fingerprint ?? '')
              }
              return
            }
          }
        }
        if (Array.isArray(n.subdirectories) && n.subdirectories.length > 0) {
          findAnchorFile(n.subdirectories)
          if (anyFile) return
        }
      }
    }
    findAnchorFile(selectedTagsTree)

    if (!anyFile) {
      const vd = this.db
        .prepare('SELECT workspace_id FROM virtual_directories WHERE id = ?')
        .get(virtualDirectoryId) as any
      if (vd?.workspace_id) {
        const row = this.db
          .prepare(
            'SELECT id as fileId, file_fingerprint as fileFingerprint FROM workspace_files WHERE workspace_id = ? LIMIT 1'
          )
          .get(vd.workspace_id) as any
        if (row?.fileId) {
          anyFile = {
            fileId: Number(row.fileId),
            fileFingerprint: String(row.fileFingerprint || '')
          }
        }
      }
    }

    const traverseForInputs = (nodes: any[], currentPath: string) => {
      for (const node of nodes) {
        if (!node) continue
        const rawName = node.name || node.id || ''
        const nodeName = sanitizeDirectoryName(rawName).trim()
        if (!nodeName) continue
        const dirPath = currentPath ? `${currentPath}/${nodeName}` : nodeName

        const hasFiles = Array.isArray(node.files) && node.files.length > 0
        const hasSubs = Array.isArray(node.subdirectories) && node.subdirectories.length > 0

        if (hasFiles) {
          for (const f of node.files) {
            if (!f) continue
            const fid = f.fileId ?? f.file_id ?? f.id
            const fileName = f.name || f.smartName || f.originalPath || ''
            if (fid != null && Number(fid) > 0 && fileName) {
              const relPath = `${dirPath}/${fileName}`
              const key = `${fid}::${relPath}`
              if (!seenMap.has(key)) {
                seenMap.add(key)
                fileInputs.push({
                  fileId: Number(fid),
                  fileFingerprint: String(f.fileFingerprint ?? f.file_fingerprint ?? ''),
                  relativePath: relPath
                })
              }
            }
          }
        }

        if (hasSubs) {
          traverseForInputs(node.subdirectories, dirPath)
        }

        if (!hasFiles && !hasSubs && anyFile) {
          const relPath = `${dirPath}/.keep`
          const key = `${anyFile.fileId}::${relPath}`
          if (!seenMap.has(key)) {
            seenMap.add(key)
            fileInputs.push({
              fileId: anyFile.fileId,
              fileFingerprint: anyFile.fileFingerprint,
              relativePath: relPath
            })
          }
        }
      }
    }

    traverseForInputs(selectedTagsTree, '')

    // 2.5 将本次提交树中不再包含的原有文件（即被删除节点上的文件）重分配至 "未归类" 路径，
    //     避免删除目录节点导致文件映射直接丢失
    const retainedFileIds = new Set<number>()
    for (const f of fileInputs) retainedFileIds.add(f.fileId)
    const existingRows = this.db
      .prepare(
        'SELECT file_id, file_fingerprint, relative_path FROM virtual_directory_files WHERE virtual_directory_id = ?'
      )
      .all(virtualDirectoryId) as any[]
    for (const row of existingRows || []) {
      const fid = Number(row.file_id)
      if (!fid || retainedFileIds.has(fid)) continue
      const fileName = row.relative_path ? path.basename(row.relative_path) : ''
      if (!fileName || fileName === '.keep') continue
      const relPath = `未归类/${fileName}`
      const key = `${fid}::${relPath}`
      if (!seenMap.has(key)) {
        seenMap.add(key)
        fileInputs.push({
          fileId: fid,
          fileFingerprint: String(row.file_fingerprint || ''),
          relativePath: relPath
        })
      }
    }

    if (fileInputs.length > 0) {
      // 2. 调用原生的 replaceFiles 原子操作，将整棵树的全量相对路径写入 SQLite 数据库
      await this.replaceFiles(virtualDirectoryId, fileInputs)
      logger.info(
        LogCategory.VIRTUAL_DIRECTORY,
        `[增量/找补同步] 成功全量落库 ${fileInputs.length} 个文件映射到 SQLite, vdirId: ${virtualDirectoryId}`
      )
    }
  }

  /**
   * 物理硬链接差异化增量同步
   * 仅当对应的虚拟目录之前已经物理导出过时，才增量创建/移动硬链接
   */
  async syncPhysicalHardlinks(
    virtualDirectoryId: number,
    workspacePath: string
  ): Promise<{ skipped: boolean; syncedCount?: number }> {
    this.ensureInitialized()
    const vd = await this.get(virtualDirectoryId)
    if (!vd || !workspacePath) {
      return { skipped: true }
    }

    const physicalVdRoot = path.join(workspacePath, VIRTUAL_DIRECTORY_ROOT, vd.name)
    const exists = await fs.pathExists(physicalVdRoot)
    if (!exists) {
      // 若尚未导出，跳过磁盘硬链接更新
      return { skipped: true }
    }

    const files = await this.getVirtualDirectoryFiles(virtualDirectoryId)
    let syncedCount = 0

    for (const file of files) {
      if (!file.originalPath || !fs.existsSync(file.originalPath)) continue

      const fileName = file.smartName || file.name || path.basename(file.originalPath)
      const relPath = file.relativePath || ''
      if (!relPath) continue

      // 提取相对路径的目录部分
      const relDir = path.dirname(relPath)
      const targetDir =
        relDir === '.' || relDir === '' ? physicalVdRoot : path.join(physicalVdRoot, relDir)

      await fs.ensureDir(targetDir)
      const targetLinkPath = path.join(targetDir, fileName)

      // 如果目标硬链接路径尚不存在，创建硬链接
      if (!fs.existsSync(targetLinkPath)) {
        try {
          await fs.link(file.originalPath, targetLinkPath)
          syncedCount++
        } catch (linkErr) {
          // 降级为 fs.copy（兼容 Windows 跨盘符硬链接限制）
          try {
            await fs.copy(file.originalPath, targetLinkPath)
            syncedCount++
          } catch (copyErr: any) {
            logger.warn(
              LogCategory.VIRTUAL_DIRECTORY,
              `Failed to create hardlink (${file.originalPath} -> ${targetLinkPath}): linkErr=${(linkErr as any)?.message}, copyErr=${(copyErr as any)?.message}`
            )
          }
        }
      }
    }

    return { skipped: false, syncedCount }
  }

  async getAnalyzedFilesCount(workspaceDirectoryPath?: string): Promise<number> {
    try {
      let query = ''
      const params: any[] = []

      if (workspaceDirectoryPath) {
        query = 'SELECT COUNT(DISTINCT id) as count FROM workspace_files WHERE is_analyzed = 1'
        const sep = path.sep
        const prefix = workspaceDirectoryPath.endsWith(sep)
          ? workspaceDirectoryPath
          : workspaceDirectoryPath + sep
        query += ` AND (path LIKE ? OR path = ?)`
        params.push(`${prefix}%`, workspaceDirectoryPath)
      } else {
        query = `
          SELECT COUNT(DISTINCT id) as count
          FROM workspace_files
          WHERE is_analyzed = 1
            AND workspace_id IN (SELECT workspace_id FROM workspaces WHERE type = 'PRIVATE')
        `
      }

      const result = this.db.prepare(query).get(...params) as { count: number }
      return result?.count || 0
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, 'Failed to get analyzed files count:', error)
      return 0
    }
  }

  async updateAllVirtualDirectories(workspacePath: string): Promise<void> {
    logger.info(
      LogCategory.VIRTUAL_DIRECTORY,
      `Updating all virtual directories for workspace: ${workspacePath}`
    )
    // This is a placeholder for actual logic that would refresh VD content
    // when files change, but for now we just log it to satisfy the caller.
  }

  /**
   * 从 AI 整理方案保存为虚拟目录
   */
  async saveFromPlan(
    workspaceId: number,
    name: string,
    structure: AIDirectoryStructure
  ): Promise<VirtualDirectory> {
    this.ensureInitialized()
    return this._aiSchemeGenerator!.saveFromPlan(workspaceId, name, structure)
  }

  // ---------- 树形结构查询 ----------
  async getTreeSnapshotAsTree(virtualDirectoryId: number | string): Promise<{
    tree: VirtualDirectoryNode[]
    fileMap: Map<string, VirtualDirectoryFileRow>
    rootNode: VirtualDirectoryNode
  }> {
    this.ensureInitialized()
    return this._treeBuilder!.getTreeSnapshotAsTree(virtualDirectoryId)
  }

  // ---------- 物理导出 ----------
  async exportToPhysical(
    virtualDirectoryId: number,
    options?: { onProgress?: (progress: number) => void }
  ): Promise<PhysicalExportResult> {
    this.ensureInitialized()
    return this._exporter!.exportToPhysical(virtualDirectoryId, options)
  }

  // ---------- AI 相关 ----------
  async generateNameAndStrategyCandidates(
    workspaceId: number,
    count = 3,
    userHint?: string,
    organizeMode?: 'fast-organize' | 'fine-organize',
    /** 可选：仅限这些文件ID的数据用于构建提示词 */
    selectedFileIds?: number[]
  ): Promise<{
    candidates: Array<{
      name: string
      strategy: string
      perspective: string
      rationale: string
    }>
  }> {
    this.ensureInitialized()
    return this._aiSchemeGenerator!.generateNameAndStrategyCandidates(
      workspaceId,
      count,
      userHint,
      organizeMode,
      selectedFileIds
    )
  }

  async checkIsLimitPredict(): Promise<boolean> {
    this.ensureInitialized()
    return this._aiSchemeGenerator!.checkIsLimitPredict()
  }

  async reorganize(
    virtualDirectoryId: number,
    options: DirectoryReorganizeOptions
  ): Promise<DirectoryReorganizeResult> {
    this.ensureInitialized()
    return this._aiSchemeGenerator!.reorganize(virtualDirectoryId, options)
  }

  /**
   * 估算整理所需的总批次（与后端实际整理上报的 totalSteps 保持一致，不调用 AI 推理）
   * 用于整理开始前判断是否超过批次告警阈值
   */
  async estimateReorganizeBatches(
    virtualDirectoryId: number,
    options: DirectoryReorganizeOptions
  ): Promise<number> {
    this.ensureInitialized()
    return this._aiSchemeGenerator!.estimateReorganizeBatches(virtualDirectoryId, options)
  }

  // ─── 预览树导出 (兼容旧集成测试) ────────────────────────────────────────────────────
  async generateFromPreviewTree(
    workspaceDirectoryPath: string,
    directoryTree: any[],
    tagFileMap: Map<string, any[]>,
    options: any
  ): Promise<any> {
    this.ensureInitialized()
    return this._previewTreeExporter!.generateFromPreviewTree(
      workspaceDirectoryPath,
      directoryTree,
      tagFileMap,
      options
    )
  }

  public async copyReadmeFile(virtualDirPath: string): Promise<void> {
    return copyReadmeFile(virtualDirPath)
  }
}

export const virtualDirectoryService = new VirtualDirectoryService()
