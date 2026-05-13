import type { Database } from 'better-sqlite3';
import { LogCategory, logger } from '@yonuc/shared';
import * as path from 'path';
import * as fs from 'fs';

export class FileDao {
  constructor(private db: Database) {}

  async getFileAnalysisResult(filePath: string): Promise<any> {
    // 优先通过原生路径查询
    let workspaceFile = this.db.prepare(`
      SELECT
        wf.id, wf.file_fingerprint, wf.path, wf.name, wf.is_analyzed, wf.last_analyzed_at, wf.thumbnail_path,
        wf.created_at, wf.modified_at, wf.accessed_at
      FROM workspace_files wf
      WHERE wf.path = ?`).get(filePath) as any;

    if (!workspaceFile) {
      logger.warn(LogCategory.DATABASE_SERVICE, '未找到文件分析结果', { filePath });
      return null;
    }

    this.db.prepare('UPDATE workspace_files SET accessed_at = CURRENT_TIMESTAMP WHERE id = ?').run(workspaceFile.id);

    let fileData: any = {};
    const fingerprint = workspaceFile.file_fingerprint;

    if (fingerprint && !fingerprint.startsWith('temp_')) {
      const fileStmt = this.db.prepare(`
        SELECT
          f.smart_name, f.size, f.type, f.mime_type, f.author, f.language,
          f.is_hit, f.last_hit_at, f.description,
          fc.content, fc.multimodal_content, fc.lrc, fc.quality_score, fc.quality_confidence, 
          fc.quality_reasoning, fc.quality_criteria, fc.grouping_reason, fc.grouping_confidence,
          fc.metadata, fc.analysis_stats
        FROM files f
        LEFT JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint
        WHERE f.file_fingerprint = ?`);
      const fData = fileStmt.get(fingerprint) as any;
      if (fData) {
        fileData = fData;
      }
    }

    let tags: any[] = [];
    if (fingerprint) {
      const tagsStmt = this.db.prepare(`
        SELECT 
          ft.id, ft.name, ft.dimension_id
        FROM file_tag_relations ftr
        JOIN file_tags ft ON ft.id = ftr.tag_id
        WHERE ftr.file_fingerprint = ? 
      `);
      tags = tagsStmt.all(fingerprint) as any[];
    }

    const dimensionTags: { [dimensionId: string]: any[] } = {};
    tags.forEach(tag => {
      const dimId = tag.dimension_id;
      if (!dimensionTags[dimId]) dimensionTags[dimId] = [];
      dimensionTags[dimId].push({ id: tag.id, name: tag.name });
    });

    const dimensions = this.db.prepare('SELECT id, level, description FROM file_dimensions ORDER BY level ASC').all() as any[];
    const sortedDimensionTags: Array<{ dimension: string; level: number; tags: any[] }> = [];
    
    dimensions.forEach(dim => {
      if (dimensionTags[dim.id]) {
        sortedDimensionTags.push({ dimension: dim.id, level: dim.level, tags: dimensionTags[dim.id] });
        delete dimensionTags[dim.id];
      }
    });

    Object.entries(dimensionTags).forEach(([dimId, remainingTags]) => {
      sortedDimensionTags.push({ dimension: dimId, level: 3, tags: remainingTags as any[] });
    });

    return {
      id: workspaceFile.id,
      path: workspaceFile.path,
      name: workspaceFile.name,
      fileFingerprint: fingerprint,
      smartName: fileData.smart_name,
      size: fileData.size,
      type: fileData.type,
      mimeType: fileData.mime_type,
      createdAt: workspaceFile.created_at,
      modifiedAt: workspaceFile.modified_at,
      accessedAt: workspaceFile.accessed_at,
      description: fileData.description,
      content: fileData.content,
      multimodalContent: fileData.multimodal_content,
      lrc: fileData.lrc,
      qualityScore: fileData.quality_score,
      qualityConfidence: fileData.quality_confidence,
      qualityReasoning: fileData.quality_reasoning,
      qualityCriteria: fileData.quality_criteria ? JSON.parse(fileData.quality_criteria) : undefined,
      author: fileData.author,
      isAnalyzed: Boolean(workspaceFile.is_analyzed),
      lastAnalyzedAt: workspaceFile.last_analyzed_at,
      isHit: Boolean(fileData.is_hit),
      lastHitAt: fileData.last_hit_at ? new Date(fileData.last_hit_at) : undefined,
      analysisStats: fileData.analysis_stats ? JSON.parse(fileData.analysis_stats) : undefined,
      dimensionTags: sortedDimensionTags,
      groupingReason: fileData.grouping_reason,
      groupingConfidence: fileData.grouping_confidence,
      thumbnailPath: workspaceFile.thumbnail_path,
      metadata: fileData.metadata ? JSON.parse(fileData.metadata) : undefined
    };
  }

  async getDirectoryAnalysisResult(dirPath: string): Promise<any> {
    const dir = this.db.prepare(`
      SELECT
        id, workspace_id, path, name, context_analysis, is_analyzed, last_analyzed_at, created_at, modified_at
      FROM workspace_directories
      WHERE path = ?
    `).get(dirPath) as any;

    if (!dir) {
      logger.warn(LogCategory.DATABASE_SERVICE, `目录分析结果未找到: ${dirPath}`);
      return null;
    }

    const countResult = this.db.prepare('SELECT COUNT(*) as count FROM workspace_files WHERE directory_id = ?').get(dir.id) as { count: number };
    const analyzedCountResult = this.db.prepare('SELECT COUNT(*) as count FROM workspace_files WHERE directory_id = ? AND is_analyzed = 1').get(dir.id) as { count: number };

    const result = {
      id: dir.id,
      path: dir.path,
      name: dir.name,
      contextAnalysis: dir.context_analysis ? JSON.parse(dir.context_analysis) : null,
      isAnalyzed: dir.is_analyzed === 1,
      lastAnalyzedAt: dir.last_analyzed_at,
      createdAt: dir.created_at,
      updatedAt: dir.modified_at,
      fileCount: countResult.count,
      analyzedFileCount: analyzedCountResult.count
    };

    logger.info(LogCategory.DATABASE_SERVICE, `目录分析结果已加载: ${dirPath}, contextAnalysis: ${result.contextAnalysis ? '存在' : 'null'}, isAnalyzed: ${result.isAnalyzed}`);

    return result;
  }

  /**
   * 处理物理文件移动后的数据库更新
   * 保持内容指纹关联，仅迁移路径实体
   */
  async updateFilePath(oldPath: string, newPath: string): Promise<void> {
    const newDir = path.dirname(newPath);

    // 查找原记录
    const wf = this.db.prepare('SELECT * FROM workspace_files WHERE path = ?').get(oldPath) as any;
    if (!wf) {
      logger.warn(LogCategory.DATABASE_SERVICE, '移动文件失败：原路径记录不存在', { oldPath });
      return;
    }

    // 确保新目录记录存在
    let newDirId = this.db.prepare('SELECT id FROM workspace_directories WHERE path = ?').get(newDir) as any;
    if (!newDirId) {
      // 需要在 Service 层创建目录记录，这里只记录警告
      logger.warn(LogCategory.DATABASE_SERVICE, '新路径所属目录记录不存在', { newDir });
      return;
    }
    newDirId = newDirId.id;

    this.db.transaction(() => {
      // 1. 删除旧路径记录（tags 通过 file_fingerprint 关联，不会丢失）
      this.db.prepare('DELETE FROM workspace_files WHERE path = ?').run(oldPath);

      // 2. 插入新路径记录，保留内容指纹
      this.db.prepare(`
        INSERT INTO workspace_files (
          file_fingerprint, workspace_id, directory_id, path, name,
          is_analyzed, analysis_error, last_analyzed_at, thumbnail_path, created_at, modified_at, accessed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(
        wf.file_fingerprint, wf.workspace_id, newDirId, newPath, path.basename(newPath),
        wf.is_analyzed, wf.analysis_error, wf.last_analyzed_at, wf.thumbnail_path, wf.created_at
      );
    })();
  }

  async updateFileAnalysisResult(pathId: string, result: any): Promise<void> {
    const wf = this.db.prepare('SELECT file_fingerprint FROM workspace_files WHERE id = ?').get(pathId) as any;
    if (!wf) throw new Error('文件路径记录不存在');
    
    const fileFingerprint = result.contentHash || wf.file_fingerprint;

    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO files (
          file_fingerprint, smart_name, size, type, mime_type, 
          author, language, is_hit, last_hit_at, description, created_at, modified_at, accessed_at
        ) VALUES (?, ?, ?, '', 'application/octet-stream', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(file_fingerprint) DO UPDATE SET 
          smart_name = COALESCE(?, smart_name),
          size = COALESCE(?, size),
          author = COALESCE(?, author),
          language = COALESCE(?, language),
          modified_at = COALESCE(?, modified_at),
          accessed_at = COALESCE(?, accessed_at),
          is_hit = COALESCE(?, is_hit),
          description = COALESCE(?, description),
          last_hit_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE last_hit_at END
      `).run(
        fileFingerprint, result.smartName || null, result.size || 0,
        result.author || null, result.language || null,
        result.isHit ? 1 : 0, result.isHit ? (result.lastHitAt || new Date().toISOString()) : null,
        result.description || null,
        result.smartName || null, result.size || null,
        result.author || null, result.language || null,
        result.modifiedAt || null, result.accessedAt || null,
        result.isHit !== undefined ? (result.isHit ? 1 : 0) : null,
        result.description || null,
        result.isHit !== undefined ? (result.isHit ? 1 : 0) : null
      );

      this.db.prepare(`
        INSERT INTO file_contents (
          file_fingerprint, content, multimodal_content, lrc, metadata, analysis_stats, 
          quality_score, quality_confidence, quality_criteria, quality_reasoning
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(file_fingerprint) DO UPDATE SET
          content = COALESCE(?, content),
          multimodal_content = COALESCE(?, multimodal_content),
          lrc = COALESCE(?, lrc),
          quality_score = COALESCE(?, quality_score),
          quality_confidence = COALESCE(?, quality_confidence),
          quality_reasoning = COALESCE(?, quality_reasoning),
          quality_criteria = COALESCE(?, quality_criteria),
          metadata = COALESCE(?, metadata),
          analysis_stats = COALESCE(?, analysis_stats)
      `).run(
        fileFingerprint, result.content || null, result.multimodalContent || null, result.lrc || null,
        result.metadata ? JSON.stringify(result.metadata) : null,
        result.analysisStats ? JSON.stringify(result.analysisStats) : null,
        result.qualityScore ?? null, result.qualityConfidence ?? null,
        result.qualityCriteria ? JSON.stringify(result.qualityCriteria) : null,
        result.qualityReasoning || null,
        result.content || null, result.multimodalContent || null, result.lrc || null,
        result.qualityScore ?? null, result.qualityConfidence ?? null, result.qualityReasoning || null,
        result.qualityCriteria ? JSON.stringify(result.qualityCriteria) : null,
        result.metadata ? JSON.stringify(result.metadata) : null,
        result.analysisStats ? JSON.stringify(result.analysisStats) : null
      );

      this.db.prepare(`
        UPDATE workspace_files SET 
          file_fingerprint = ?,
          is_analyzed = 1,
          last_analyzed_at = CURRENT_TIMESTAMP,
          thumbnail_path = COALESCE(?, thumbnail_path),
          modified_at = COALESCE(?, modified_at),
          accessed_at = COALESCE(?, accessed_at)
        WHERE id = ?
      `).run(
        fileFingerprint,
        result.thumbnailPath || null,
        result.modifiedAt || null,
        result.accessedAt || null,
        pathId
      );
    })();
  }

  async getAllFiles(): Promise<any[]> {
    const rows = this.db.prepare(`
      SELECT f.*, wf.path, wf.name, wf.modified_at as wf_mod, wf.id, fc.quality_score
      FROM workspace_files wf
      LEFT JOIN files f ON wf.file_fingerprint = f.file_fingerprint
      LEFT JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint
      ORDER BY wf.modified_at DESC
    `).all() as any[];
    
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      path: row.path,
      size: row.size || 0,
      type: row.type || '',
      extension: row.type || '',
      mimeType: row.mime_type || '',
      createdAt: new Date(row.created_at || Date.now()),
      modifiedAt: new Date(row.wf_mod),
      qualityScore: row.quality_score
    }));
  }

  async searchFilesFTS(query: string, workspaceId?: number): Promise<any[]> {
    if (!query || query.trim().length === 0) return [];

    const trimmedQuery = query.trim();
    
    if (trimmedQuery.length < 3) {
      let sql = `
        SELECT f.*, wf.id, wf.path, wf.name, wf.is_analyzed, wf.modified_at as wf_mod, fc.quality_score
        FROM workspace_files wf
        LEFT JOIN files f ON wf.file_fingerprint = f.file_fingerprint
        LEFT JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint
        WHERE (wf.name LIKE ? OR f.smart_name LIKE ? OR f.description LIKE ? OR fc.content LIKE ? OR fc.multimodal_content LIKE ? OR fc.lrc LIKE ?)
      `;
      const likeQuery = `%${trimmedQuery}%`;
      const params: any[] = [likeQuery, likeQuery, likeQuery, likeQuery, likeQuery, likeQuery];

      if (workspaceId) {
        sql += ` AND wf.workspace_id = ?`;
        params.push(workspaceId);
      }
      sql += ` ORDER BY wf.modified_at DESC LIMIT 100`;

      const rows = this.db.prepare(sql).all(...params) as any[];
      return rows.map(row => ({
        ...row,
        id: row.id,
        modifiedAt: new Date(row.wf_mod),
        isAnalyzed: row.is_analyzed === 1,
        isHit: row.is_hit === 1,
        qualityScore: row.quality_score,
        rank: 0
      }));
    }

    const sanitizedQuery = `"${trimmedQuery.replace(/["]/g, '""')}"`;
    let sql = `
      SELECT 
        f.*, wf.id, wf.path, wf.name, wf.is_analyzed, wf.modified_at as wf_mod,
        fc.quality_score,
        bm25(files_fts, 10.0, 5.0, 1.0, 2.0) as rank
      FROM files f
      JOIN files_fts ON f.file_fingerprint = files_fts.file_fingerprint
      JOIN workspace_files wf ON f.file_fingerprint = wf.file_fingerprint
      LEFT JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint
      WHERE files_fts MATCH ?
    `;
    const params: any[] = [sanitizedQuery];

    if (workspaceId) {
      sql += ` AND wf.workspace_id = ?`;
      params.push(workspaceId);
    }

    sql += ` ORDER BY rank ASC LIMIT 100`;

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(row => ({
      ...row,
      id: row.id,
      modifiedAt: new Date(row.wf_mod),
      isAnalyzed: row.is_analyzed === 1,
      isHit: row.is_hit === 1,
      qualityScore: row.quality_score
    }));
  }

  async getAnalyzedFileByContentHash(contentHash: string): Promise<any> {
    try {
      const row = this.db.prepare(`
        SELECT f.*, fc.*, (SELECT 1 FROM workspace_files wf WHERE wf.file_fingerprint = f.file_fingerprint AND wf.is_analyzed = 1 LIMIT 1) as is_analyzed
        FROM files f
        LEFT JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint
        WHERE f.file_fingerprint = ? 
      `).get(contentHash) as any;
      
      if (!row || !row.is_analyzed) return null;
      
      return {
        id: row.file_fingerprint,
        name: row.name,
        smartName: row.smart_name,
        contentHash: row.file_fingerprint,
        size: row.size,
        extension: row.type,
        mimeType: row.mime_type,
        isAnalyzed: true,
        qualityScore: row.quality_score,
        qualityConfidence: row.quality_confidence,
        qualityReasoning: row.quality_reasoning,
        qualityCriteria: row.quality_criteria ? JSON.parse(row.quality_criteria) : undefined,
        description: row.description,
        content: row.content,
        multimodalContent: row.multimodal_content,
        lrc: row.lrc,
        groupingReason: row.grouping_reason,
        groupingConfidence: row.grouping_confidence,
        author: row.author,
        language: row.language,
        metadata: row.metadata
      };
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, '根据内容哈希获取分析文件失败', { error, contentHash });
      return null;
    }
  }

  async getFileByPath(filePath: string): Promise<any> {
    try {
      const wf = this.db.prepare(`
        SELECT * FROM workspace_files 
        WHERE path = ?`).get(filePath) as any;
      
      if (!wf) return null;
      
      let fileData: any = {};
      if (wf.file_fingerprint) {
        const fileStmt = this.db.prepare('SELECT * FROM files LEFT JOIN file_contents USING(file_fingerprint) WHERE file_fingerprint = ?');
        const f = fileStmt.get(wf.file_fingerprint) as any;
        if (f) fileData = f;
      }
      
      return {
        id: wf.id,
        name: wf.name,
        path: wf.path,
        contentHash: wf.file_fingerprint, 
        parentPath: path.dirname(wf.path),
        size: fileData.size || 0,
        extension: fileData.type,
        mimeType: fileData.mime_type,
        createdAt: new Date(wf.created_at),
        modifiedAt: new Date(wf.modified_at),
        isSelected: false,
        isAnalyzed: wf.is_analyzed === 1,
        lastAnalyzedAt: wf.last_analyzed_at ? new Date(wf.last_analyzed_at) : undefined,
        qualityScore: fileData.quality_score,
        description: fileData.description,
        content: fileData.content,
        multimodalContent: fileData.multimodal_content,
        lrc: fileData.lrc
      };
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, '根据路径获取文件失败', { error, filePath });
      throw error;
    }
  }

  async updateFileMetadata(filePath: string, stats: fs.Stats): Promise<void> {
    this.db.transaction(() => {
      this.db.prepare(`UPDATE workspace_files SET modified_at = ? WHERE path = ?`)
        .run(stats.mtime.toISOString(), filePath);
        
      this.db.prepare(`
        UPDATE files SET modified_at = ?, size = ? 
        WHERE file_fingerprint = (SELECT file_fingerprint FROM workspace_files WHERE path = ?)
      `).run(stats.mtime.toISOString(), stats.size, filePath);
    })();
  }

  async updateFileHitStatus(fileFingerprint: string, isHit: boolean): Promise<void> {
    try {
      this.db.prepare(`
        UPDATE files 
        SET is_hit = ?, last_hit_at = ?, modified_at = CURRENT_TIMESTAMP 
        WHERE file_fingerprint = ?
      `).run(isHit ? 1 : 0, isHit ? new Date().toISOString() : null, fileFingerprint);
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, '更新缓存命中状态失败', { error, fileFingerprint });
    }
  }

  async updateFileThumbnail(filePath: string, thumbnailPath: string | null): Promise<void> {
    this.db.prepare('UPDATE workspace_files SET thumbnail_path = ?, modified_at = CURRENT_TIMESTAMP WHERE path = ?').run(thumbnailPath, filePath);
  }

  async resetFileAnalysis(filePath: string): Promise<void> {
    try {
      const fileRecord = this.db.prepare(`
        SELECT wf.id, wf.file_fingerprint, wf.path, wf.is_analyzed
        FROM workspace_files wf
        WHERE wf.path = ?
      `).get(filePath) as { id: number, file_fingerprint: string, path: string, is_analyzed: number } | undefined;

      if (!fileRecord) {
        logger.warn(LogCategory.DATABASE_SERVICE, '重置文件分析状态失败：数据库中未找到匹配路径', { 
          inputPath: filePath
        });
        return;
      }

      const actualId = fileRecord.id;
      const actualPath = fileRecord.path;
      const fileFingerprint = fileRecord.file_fingerprint;

      logger.info(LogCategory.DATABASE_SERVICE, '找到匹配记录，准备清空数据', { 
        actualPath, 
        id: actualId, 
        isAnalyzed: fileRecord.is_analyzed 
      });

      this.db.transaction(() => {
        // 1. 重置 workspace_files 表
        const res1 = this.db.prepare(`
          UPDATE workspace_files
          SET is_analyzed = 0,
              last_analyzed_at = NULL,
              analysis_error = NULL
          WHERE id = ?
        `).run(actualId);

        // 2. 清空 files 表中的分析数据
        this.db.prepare(`
          UPDATE files
          SET smart_name = (SELECT name FROM workspace_files WHERE id = ?),
              description = NULL,
              author = NULL,
              language = NULL,
              is_hit = 0,
              last_hit_at = NULL
          WHERE file_fingerprint = ?
        `).run(actualId, fileFingerprint);

        // 3. 清空 file_contents 表中的分析数据
        this.db.prepare(`
          UPDATE file_contents
          SET content = NULL,
              multimodal_content = NULL,
              lrc = NULL,
              metadata = NULL,
              analysis_stats = NULL,
              quality_score = NULL,
              quality_confidence = NULL,
              quality_criteria = NULL,
              quality_reasoning = NULL,
              grouping_reason = NULL,
              grouping_confidence = NULL
          WHERE file_fingerprint = ?
        `).run(fileFingerprint);

        // 4. 清除文件的标签关联
        this.db.prepare(`
          DELETE FROM file_tag_relations
          WHERE file_fingerprint = ?
        `).run(fileFingerprint);

        // 5. 从分析队列中移除该项目，确保下次添加时是全新状态
        const res4 = this.db.prepare(`
          DELETE FROM analysis_queue 
          WHERE item_id = ? AND item_type = 'file'
        `).run(actualId);
        
        logger.debug(LogCategory.DATABASE_SERVICE, `事务内部操作完成: workspace_files更新=${res1.changes}, analysis_queue删除=${res4.changes}`);
      })();

      logger.info(LogCategory.DATABASE_SERVICE, '文件分析数据已完全清空', { filePath: actualPath });
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, '重置文件分析数据失败', { error, filePath });
      throw error;
    }
  }

  /**
   * 获取指定目录下的所有文件记录
   * @param dirPath 目录路径
   * @param workspaceId 工作区 ID
   * @returns 文件记录列表
   */
  async getFilesByParentPath(dirPath: string, workspaceId: number): Promise<any[]> {
    const sep = path.sep;
    // 补全分隔符逻辑
    const prefix = dirPath.endsWith(sep) ? dirPath : dirPath + sep;
    
    // 不再使用复杂且危险的 LIKE 转义，而是结合路径深度判断
    const rows = this.db.prepare(`
      SELECT
        wf.id,
        wf.path,
        wf.name,
        wf.is_analyzed,
        wf.last_analyzed_at,
        wf.thumbnail_path,
        wf.modified_at,
        wf.accessed_at,
        f.smart_name,
        f.size,
        f.type,
        f.mime_type,
        f.description,
        f.is_hit,
        f.last_hit_at,
        fc.quality_score,
        fc.quality_confidence
      FROM workspace_files wf
      LEFT JOIN files f ON wf.file_fingerprint = f.file_fingerprint
      LEFT JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint
      WHERE wf.workspace_id = ?
        AND (wf.path LIKE ? OR wf.path = ?)
        -- 确保只获取直接子级：在 prefix 之后不再包含更多的分隔符
        AND INSTR(SUBSTR(wf.path, LENGTH(?) + 1), ?) = 0
      ORDER BY wf.name ASC
    `).all(workspaceId, prefix + '%', dirPath, prefix, sep) as any[];

    return rows.map(row => ({
      id: row.id,
      path: row.path,
      name: row.name,
      smartName: row.smart_name,
      size: row.size,
      type: row.type,
      extension: row.type,
      mimeType: row.mime_type,
      isAnalyzed: row.is_analyzed === 1,
      lastAnalyzedAt: row.last_analyzed_at ? new Date(row.last_analyzed_at) : undefined,
      thumbnailPath: row.thumbnail_path,
      modifiedAt: new Date(row.modified_at),
      accessedAt: row.accessed_at ? new Date(row.accessed_at) : undefined,
      qualityScore: row.quality_score,
      qualityConfidence: row.quality_confidence,
      description: row.description,
      isHit: row.is_hit === 1,
      lastHitAt: row.last_hit_at ? new Date(row.last_hit_at) : undefined
    }));
  }
}
