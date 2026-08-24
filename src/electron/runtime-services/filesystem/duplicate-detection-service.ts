import * as fs from 'fs'
import * as path from 'path'
import { shell } from 'electron'
import {
  DuplicateDeleteResult,
  DuplicateDetectionOptions,
  DuplicateFileItem,
  DuplicateGroup,
  DuplicateDetectionStrategy
} from '@firefly/types'
import { LogCategory, logger } from '@firefly/shared'
import { databaseService } from '../database'

export class DuplicateDetectionService {
  private omniApiUrl = 'http://127.0.0.1:9190'

  /**
   * 执行双轨并行查重扫描
   */
  public async scanDuplicates(options: DuplicateDetectionOptions): Promise<DuplicateGroup[]> {
    logger.info(LogCategory.FILE_ORGANIZATION, '开始执行双轨查重扫描', options)
    const startTime = Date.now()

    // 1. 获取要扫描的目标文件列表与已有元数据 (从 SQLite 读取)
    const dbFiles = await this.getTargetFilesFromDb(options)
    const filePaths = dbFiles.map(f => f.path).filter(p => fs.existsSync(p))

    if (filePaths.length === 0) {
      return []
    }

    // 2. 双轨并发扫描 (Promise.all)
    const [omniResult, docResult] = await Promise.allSettled([
      this.scanViaOmniRust(filePaths, options),
      this.scanDocSemanticsAndHeuristics(dbFiles, options)
    ])

    const omniGroups = omniResult.status === 'fulfilled' ? omniResult.value : []
    const docGroups = docResult.status === 'fulfilled' ? docResult.value : []

    // 3. 结果合并与数据库元数据富化 (图片分辨率、质量分、缩略图)
    const mergedGroups = this.mergeDuplicateGroups(omniGroups, docGroups, dbFiles)

    // 4. 默认智能推荐保留项打标 (最高分辨率 > 最高质量分 > 最新修改时间)
    this.applySmartRecommendKeep(mergedGroups, 'highest_resolution')

    logger.info(
      LogCategory.FILE_ORGANIZATION,
      `查重扫描完成，发现 ${mergedGroups.length} 个相似/重复组，耗时: ${Date.now() - startTime}ms`
    )

    return mergedGroups
  }

  /**
   * Track 1: 调用 firefly-omni Rust HTTP API 执行多模态查重
   */
  private async scanViaOmniRust(
    filePaths: string[],
    options: DuplicateDetectionOptions
  ): Promise<DuplicateGroup[]> {
    try {
      const resp = await fetch(`${this.omniApiUrl}/api/duplicate/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paths: filePaths,
          min_similarity: options.minSimilarity ?? 85,
          strategies: options.strategies || ['exact_hash', 'image_phash']
        }),
        signal: AbortSignal.timeout(15000)
      })

      if (!resp.ok) {
        logger.warn(LogCategory.FILE_ORGANIZATION, `Omni 查重接口返回非 200: ${resp.status}`)
        return []
      }

      const data: any = await resp.json()
      if (!data?.duplicate_groups || !Array.isArray(data.duplicate_groups)) {
        return []
      }

      return data.duplicate_groups.map((g: any) => ({
        groupId: g.group_id || `omni_${Math.random().toString(36).substring(2, 8)}`,
        strategy: (g.strategy || 'exact_hash') as DuplicateDetectionStrategy,
        similarityPercentage: g.similarity_percentage || 100,
        description: g.description || '多模态特征识别组',
        files: (g.files || []).map((f: any) => ({
          fileId: 0,
          fingerprint: f.fingerprint || '',
          path: f.path,
          name: f.name || path.basename(f.path),
          size: f.size || 0,
          modifiedAt: f.modified_at || '',
          similarityScore: f.similarity_score ?? 1.0
        }))
      }))
    } catch (err) {
      logger.debug(
        LogCategory.FILE_ORGANIZATION,
        'Omni 查重服务未连通或超时，自动无缝回退至本地查重管道',
        err
      )
      return []
    }
  }

  /**
   * Track 2: 基于 SQLite 缓存的 content_text、指纹与副本启发式规则查重
   */
  private async scanDocSemanticsAndHeuristics(
    dbFiles: any[],
    options: DuplicateDetectionOptions
  ): Promise<DuplicateGroup[]> {
    const groups: DuplicateGroup[] = []

    // A. 100% 精确指纹分组 (Layer 1 兜底与快速比对)
    const fpMap = new Map<string, any[]>()
    for (const f of dbFiles) {
      if (f.fingerprint && f.size > 0) {
        if (!fpMap.has(f.fingerprint)) fpMap.set(f.fingerprint, [])
        fpMap.get(f.fingerprint)!.push(f)
      }
    }

    let exactIdx = 1
    for (const [fp, files] of fpMap.entries()) {
      if (files.length >= 2) {
        groups.push({
          groupId: `exact_db_${exactIdx++}`,
          strategy: 'exact_hash',
          similarityPercentage: 100,
          description: `100% 内容精确一致文件 (${files.length}个)`,
          files: files.map(f => ({
            fileId: f.id,
            fingerprint: fp,
            path: f.path,
            name: f.name,
            size: f.size,
            modifiedAt: f.modifiedAt,
            qualityScore: f.qualityScore,
            resolution: f.resolution,
            thumbnailPath: f.thumbnailPath,
            similarityScore: 1.0
          }))
        })
      }
    }

    // B. 文档语义相似度 (Layer 4: 基于 content_text SimHash / Jaccard)
    const docFiles = dbFiles.filter(f => f.contentText && f.contentText.length > 50)
    if (docFiles.length >= 2) {
      let docGroupIdx = 1
      const visited = new Set<number>()

      for (let i = 0; i < docFiles.length; i++) {
        if (visited.has(docFiles[i].id)) continue
        const cluster: any[] = [docFiles[i]]

        for (let j = i + 1; j < docFiles.length; j++) {
          if (visited.has(docFiles[j].id)) continue
          const sim = this.calculateTextJaccardSimilarity(
            docFiles[i].contentText,
            docFiles[j].contentText
          )
          if (sim >= 0.82) {
            cluster.push(docFiles[j])
            visited.add(docFiles[j].id)
          }
        }

        if (cluster.length >= 2) {
          visited.add(docFiles[i].id)
          groups.push({
            groupId: `doc_sim_${docGroupIdx++}`,
            strategy: 'text_simhash',
            similarityPercentage: 88,
            description: `文本语义高度相似文档 (${cluster.length}个)`,
            files: cluster.map(f => ({
              fileId: f.id,
              fingerprint: f.fingerprint,
              path: f.path,
              name: f.name,
              size: f.size,
              modifiedAt: f.modifiedAt,
              qualityScore: f.qualityScore,
              similarityScore: 0.88
            }))
          })
        }
      }
    }

    // C. 文件名副本启发式检测 (Layer 5: _copy, (1), 副本)
    const copyGroups = this.detectFilenameCopies(dbFiles)
    groups.push(...copyGroups)

    return groups
  }

  /**
   * 简单的文本 Jaccard 相似度计算
   */
  private calculateTextJaccardSimilarity(textA: string, textB: string): number {
    if (!textA || !textB) return 0
    const setA = new Set(textA.substring(0, 1000).split(/\s+/))
    const setB = new Set(textB.substring(0, 1000).split(/\s+/))
    let intersection = 0
    for (const word of setA) {
      if (setB.has(word)) intersection++
    }
    const union = setA.size + setB.size - intersection
    return union > 0 ? intersection / union : 0
  }

  /**
   * 文件名副本启发式检测
   */
  private detectFilenameCopies(dbFiles: any[]): DuplicateGroup[] {
    const copyPattern = /[\s_\-(]*(?:copy|\d+|副本|\(\d+\))[^\.]*$/i
    const groups: DuplicateGroup[] = []
    const baseNameMap = new Map<string, any[]>()

    for (const f of dbFiles) {
      const ext = path.extname(f.name)
      const base = path.basename(f.name, ext)
      const normalizedBase = base.replace(copyPattern, '').trim().toLowerCase()
      if (normalizedBase.length > 2) {
        const key = `${normalizedBase}${ext.toLowerCase()}`
        if (!baseNameMap.has(key)) baseNameMap.set(key, [])
        baseNameMap.get(key)!.push(f)
      }
    }

    let groupIdx = 1
    for (const [, files] of baseNameMap.entries()) {
      if (files.length >= 2) {
        groups.push({
          groupId: `copy_name_${groupIdx++}`,
          strategy: 'filename_heuristic',
          similarityPercentage: 90,
          description: `文件名副本/衍生版本 (${files.length}个)`,
          files: files.map(f => ({
            fileId: f.id,
            fingerprint: f.fingerprint,
            path: f.path,
            name: f.name,
            size: f.size,
            modifiedAt: f.modifiedAt,
            qualityScore: f.qualityScore,
            resolution: f.resolution,
            similarityScore: 0.9
          }))
        })
      }
    }

    return groups
  }

  /**
   * 合并两轨查重结果，避免相同文件对在多个组中重复冗余
   */
  private mergeDuplicateGroups(
    omniGroups: DuplicateGroup[],
    docGroups: DuplicateGroup[],
    dbFiles: any[]
  ): DuplicateGroup[] {
    const dbFileMap = new Map<string, any>()
    for (const f of dbFiles) {
      dbFileMap.set(f.path, f)
    }

    const allGroups = [...omniGroups, ...docGroups]
    const merged: DuplicateGroup[] = []
    const seenPairSignatures = new Set<string>()

    for (const group of allGroups) {
      // 补全文件元数据
      const enrichedFiles: DuplicateFileItem[] = group.files.map(item => {
        const dbInfo = dbFileMap.get(item.path)
        return {
          fileId: dbInfo?.id || item.fileId || 0,
          fingerprint: dbInfo?.fingerprint || item.fingerprint || '',
          path: item.path,
          name: dbInfo?.name || item.name,
          size: dbInfo?.size || item.size,
          modifiedAt: dbInfo?.modifiedAt || item.modifiedAt,
          qualityScore: dbInfo?.qualityScore,
          resolution: dbInfo?.resolution,
          thumbnailPath: dbInfo?.thumbnailPath,
          similarityScore: item.similarityScore ?? 1.0,
          selectedForDelete: false
        }
      })

      // 过滤不足2个文件的无效组
      if (enrichedFiles.length < 2) continue

      // 去重相同文件集合的组
      const signature = enrichedFiles
        .map(f => f.path)
        .sort()
        .join('||')
      if (seenPairSignatures.has(signature)) continue
      seenPairSignatures.add(signature)

      merged.push({
        ...group,
        files: enrichedFiles
      })
    }

    return merged
  }

  /**
   * 应用智能推荐保留规则
   */
  public static parseResolution(resStr?: string): number {
    if (!resStr) return 0
    const str = resStr.trim()
    const match = str.match(/(\d+)\s*[xX*×]\s*(\d+)/)
    if (match) {
      return parseInt(match[1], 10) * parseInt(match[2], 10)
    }
    if (/^4k$/i.test(str)) return 3840 * 2160
    if (/^2k$/i.test(str)) return 2560 * 1440
    if (/^1080p?$/i.test(str)) return 1920 * 1080
    if (/^720p?$/i.test(str)) return 1280 * 720
    return 0
  }

  public static formatBytes(bytes: number): string {
    if (!bytes || bytes <= 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    if (i === 0) return `${bytes} B`
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`
  }

  public static applySmartRecommendKeep(
    groups: DuplicateGroup[],
    rule: string
  ): DuplicateGroup[] {
    for (const group of groups) {
      if (!group.files || group.files.length === 0) continue

      let bestIndex = 0

      for (let i = 1; i < group.files.length; i++) {
        const curr = group.files[i]
        const best = group.files[bestIndex]

        if (rule === 'highest_resolution' || rule === 'best_resolution') {
          const currRes = DuplicateDetectionService.parseResolution(curr.resolution)
          const bestRes = DuplicateDetectionService.parseResolution(best.resolution)
          if (currRes > bestRes) {
            bestIndex = i
          } else if (currRes === bestRes && (curr.size || 0) > (best.size || 0)) {
            bestIndex = i
          }
        } else if (rule === 'highest_quality' || rule === 'quality_score') {
          if ((curr.qualityScore || 0) > (best.qualityScore || 0)) {
            bestIndex = i
          }
        } else if (rule === 'newest_modified' || rule === 'latest_modified') {
          const currTime = new Date(curr.modifiedAt || 0).getTime() || 0
          const bestTime = new Date(best.modifiedAt || 0).getTime() || 0
          if (currTime > bestTime) {
            bestIndex = i
          }
        } else if (rule === 'oldest_created' || rule === 'earliest_created') {
          const currTime = new Date(curr.createdAt || curr.modifiedAt || 0).getTime() || 0
          const bestTime = new Date(best.createdAt || best.modifiedAt || 0).getTime() || 0
          if (currTime < bestTime) {
            bestIndex = i
          }
        } else if (rule === 'original_name') {
          // 偏向没有 副本、copy、(1) 等字样的较短基础文件名
          const isCurrCopy = /副本|copy|\(\d+\)|_\d+$/i.test(curr.name)
          const isBestCopy = /副本|copy|\(\d+\)|_\d+$/i.test(best.name)
          if (!isCurrCopy && isBestCopy) {
            bestIndex = i
          } else if (isCurrCopy === isBestCopy && curr.name.length < best.name.length) {
            bestIndex = i
          }
        }
      }

      // 标记保留项与待删除项
      group.files.forEach((f, idx) => {
        if (idx === bestIndex) {
          f.isRecommendedKeep = true
          f.selectedForDelete = false
        } else {
          f.isRecommendedKeep = false
          f.selectedForDelete = true
        }
      })
      group.recommendedKeepFingerprint = group.files[bestIndex].fingerprint
    }
    return groups
  }

  public applySmartRecommendKeep(
    groups: DuplicateGroup[],
    rule: string
  ): DuplicateGroup[] {
    return DuplicateDetectionService.applySmartRecommendKeep(groups, rule)
  }

  /**
   * 安全清理选中的冗余文件 (移入操作系统回收站)
   */
  public async trashDuplicateFiles(filePaths: string[]): Promise<DuplicateDeleteResult> {
    let deletedCount = 0
    let freedBytes = 0
    const errors: Array<{ fileId: number; path: string; error: string }> = []

    await databaseService.ensureInitialized()
    const db = databaseService.db

    for (const filePath of filePaths) {
      try {
        if (fs.existsSync(filePath)) {
          const stat = fs.statSync(filePath)
          const size = stat.size

          // 核心安全操作：移入操作系统回收站
          await shell.trashItem(filePath)
          deletedCount++
          freedBytes += size

          // 从数据库 workspace_files 解绑
          if (db) {
            db.prepare('DELETE FROM workspace_files WHERE path = ?').run(filePath)
          }
        }
      } catch (err: any) {
        logger.error(LogCategory.FILE_ORGANIZATION, `清理冗余文件失败 [${filePath}]:`, err)
        errors.push({
          fileId: 0,
          path: filePath,
          error: err?.message || '移入回收站失败'
        })
      }
    }

    return {
      deletedCount,
      freedBytes,
      errors: errors.length > 0 ? errors : undefined
    }
  }

  /**
   * 从数据库查询待查重文件的元数据与已提取文本
   */
  private async getTargetFilesFromDb(options: DuplicateDetectionOptions): Promise<any[]> {
    await databaseService.ensureInitialized()
    const db = databaseService.db
    if (!db) return []

    try {
      let query = `
        SELECT f.id, f.path, f.name, f.file_size as size, f.file_fingerprint as fingerprint,
               f.modified_at as modifiedAt, fc.content_text as contentText, fc.metadata,
               fc.quality_score as qualityScore, f.thumbnail_path as thumbnailPath
        FROM files f
        LEFT JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint
      `
      let rows: any[] = []

      if (options.fileIds && options.fileIds.length > 0) {
        const placeholders = options.fileIds.map(() => '?').join(',')
        query += ` WHERE f.id IN (${placeholders})`
        rows = db.prepare(query).all(...options.fileIds)
      } else if (options.workspaceDirectoryPath) {
        query += ` WHERE f.path LIKE ?`
        rows = db.prepare(query).all(`${options.workspaceDirectoryPath}%`)
      } else {
        rows = db.prepare(query).all()
      }

      return rows.map(r => {
        let meta: any = {}
        try {
          if (r.metadata) meta = JSON.parse(r.metadata)
        } catch {
          meta = {}
        }
        return {
          ...r,
          resolution: meta.resolution || meta.dimensions,
          duration: meta.duration
        }
      })
    } catch (err) {
      logger.error(LogCategory.DATABASE_SERVICE, '查询查重目标文件数据库元数据失败:', err)
      return []
    }
  }
}

export const duplicateDetectionService = new DuplicateDetectionService()
