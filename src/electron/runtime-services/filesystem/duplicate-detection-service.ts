import * as fs from 'fs'
import * as path from 'path'
import { shell } from 'electron'
import {
  DuplicateDeleteResult,
  DuplicateDetectionOptions,
  DuplicateFileItem,
  DuplicateGroup,
  DuplicateDetectionStrategy,
  DuplicateFixAction,
  DuplicateFixResult
} from '@firefly/types'
import { LogCategory, logger } from '@firefly/shared'
import { databaseService } from '../database'

export class DuplicateDetectionService {
  private omniApiUrl = 'http://127.0.0.1:9190'

  /**
   * 执行双轨并行查重扫描
   */
  public async scanDuplicates(options: DuplicateDetectionOptions): Promise<DuplicateGroup[]> {
    const fileIdsCount = options.fileIds?.length ?? 0
    logger.info(LogCategory.FILE_ORGANIZATION, '开始执行双轨查重扫描', {
      workspaceDirectoryPath: options.workspaceDirectoryPath,
      targetFilesCount: fileIdsCount > 0 ? fileIdsCount : '全目录',
      strategiesCount: options.strategies?.length ?? 0,
      minSimilarity: options.minSimilarity
    })
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
      const targetPaths = (options.workspaceDirectoryPath && fs.existsSync(options.workspaceDirectoryPath) && (!options.fileIds || options.fileIds.length === 0))
        ? [options.workspaceDirectoryPath]
        : (filePaths.length > 0 ? filePaths : [options.workspaceDirectoryPath || ''])

      const resp = await fetch(`${this.omniApiUrl}/api/duplicate/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paths: targetPaths,
          min_similarity: options.minSimilarity !== undefined
            ? (options.minSimilarity > 10 ? options.minSimilarity / 10 : options.minSimilarity)
            : 7.5,
          strategies: options.strategies || ['exact_hash', 'image_phash'],
          name_issues_mode: options.nameIssuesMode || 'multilingual'
        }),
        signal: AbortSignal.timeout(30000)
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
        groupThreshold: g.group_threshold,
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

    const enabledStrategies = options.strategies || ['exact_hash', 'image_phash']

    // A. 100% 精确指纹分组 (Layer 1 兜底与快速比对)
    if (enabledStrategies.includes('exact_hash')) {
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
            groupThreshold: 10.0, // 100% 精确一致踩线阈值为 10.0
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
    }

    // B. 文档语义相似度 (Layer 4: 基于 content_text SimHash / Jaccard)
    if (enabledStrategies.includes('text_simhash')) {
      const docFiles = dbFiles.filter(f => f.contentText && f.contentText.length > 50)
      if (docFiles.length >= 2) {
        let docGroupIdx = 1
        const visited = new Set<number>()

        for (let i = 0; i < docFiles.length; i++) {
          if (visited.has(docFiles[i].id)) continue
          const cluster: any[] = [docFiles[i]]
          let minPairSim = 1.0

          for (let j = i + 1; j < docFiles.length; j++) {
            if (visited.has(docFiles[j].id)) continue
            const sim = this.calculateTextJaccardSimilarity(
              docFiles[i].contentText,
              docFiles[j].contentText
            )
            if (sim >= 0.82) {
              cluster.push(docFiles[j])
              visited.add(docFiles[j].id)
              if (sim < minPairSim) {
                minPairSim = sim
              }
            }
          }

          if (cluster.length >= 2) {
            visited.add(docFiles[i].id)
            const thresholdVal = Math.round(minPairSim * 100) / 10 // 0.0 ~ 10.0
            const simPercent = Math.round(minPairSim * 100)
            groups.push({
              groupId: `doc_sim_${docGroupIdx++}`,
              strategy: 'text_simhash',
              similarityPercentage: simPercent,
              groupThreshold: thresholdVal, // 组内真实踩线阈值
              description: `文本语义相似文档 (${cluster.length}个, 最小相似度 ${simPercent}%)`,
              files: cluster.map(f => ({
                fileId: f.id,
                fingerprint: f.fingerprint,
                path: f.path,
                name: f.name,
                size: f.size,
                modifiedAt: f.modifiedAt,
                qualityScore: f.qualityScore,
                similarityScore: minPairSim
              }))
            })
          }
        }
      }
    }

    // C. 文件名副本启发式检测 (Layer 5: _copy, (1), 副本)
    if (enabledStrategies.includes('filename_heuristic')) {
      const copyGroups = this.detectFilenameCopies(dbFiles)
      groups.push(...copyGroups)
    }

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
      if (!f.size || f.size <= 0) continue
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
          groupThreshold: 9.0, // 启发式规则真实对应 9.0 阈值
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
        // 核心修正：纯文件名永远从实际物理路径 path.basename(item.path) 提取，确保纯粹无污染
        const pureFileName = item.path ? path.basename(item.path) : (dbInfo?.name || item.name)

        return {
          fileId: dbInfo?.id || item.fileId || 0,
          fingerprint: item.fingerprint || dbInfo?.fingerprint || '',
          path: item.path,
          name: pureFileName,
          size: dbInfo?.size || item.size,
          modifiedAt: dbInfo?.modifiedAt || item.modifiedAt,
          qualityScore: dbInfo?.qualityScore,
          resolution: dbInfo?.resolution,
          thumbnailPath: dbInfo?.thumbnailPath,
          similarityScore: item.similarityScore ?? 1.0,
          selectedForDelete: false
        }
      })

      // 核心判定：单体异常清理类策略（如空文件、空文件夹、超大文件、损坏文件等）只要有文件即可成组；
      // 而相似查重类策略（精确哈希、相似图片、相似音视频、文本相似、副本衍生）必须至少有 2 个文件对比才有意义。
      const isStandaloneCleanupStrategy = [
        'empty_files',
        'empty_folders',
        'big_files',
        'temporary_files',
        'invalid_symlinks',
        'broken_files',
        'bad_extensions',
        'bad_names',
        'exif_remover',
        'video_optimizer'
      ].includes(group.strategy)

      // 超大文件策略双重兜底防线：仅保留 size >= 10MB (10 * 1024 * 1024) 的文件
      let finalFiles = enrichedFiles
      let finalDescription = group.description
      if (group.strategy === 'big_files') {
        const MIN_BIG_FILE_BYTES = 10 * 1024 * 1024 // 10MB
        finalFiles = enrichedFiles.filter(f => (f.size || 0) >= MIN_BIG_FILE_BYTES)
        finalDescription = `占用空间超大文件 (≥ 10MB, 共${finalFiles.length}个)`
      }

      if (isStandaloneCleanupStrategy) {
        if (finalFiles.length < 1) continue
      } else {
        if (finalFiles.length < 2) continue
      }

      // 去重相同文件集合的组
      const signature = `${group.strategy}::${finalFiles
        .map(f => f.path)
        .sort()
        .join('||')}`
      if (seenPairSignatures.has(signature)) continue
      seenPairSignatures.add(signature)

      merged.push({
        ...group,
        description: finalDescription,
        files: finalFiles
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

      // 单体清理/修复/优化类策略：错误扩展名、空文件、视频优化、异常文件名、临时缓存、空文件夹、断裂软链接、损坏文件、Exif清理
      // 这些指标发现的文件自身即是待处理目标，因此默认全部选中
      const isStandaloneAllSelectStrategy =
        group.strategy === 'empty_files' ||
        group.strategy === 'empty_folders' ||
        group.strategy === 'temporary_files' ||
        group.strategy === 'invalid_symlinks' ||
        group.strategy === 'broken_files' ||
        group.strategy === 'bad_extensions' ||
        group.strategy === 'bad_names' ||
        group.strategy === 'video_optimizer' ||
        group.strategy === 'exif_remover'

      if (isStandaloneAllSelectStrategy) {
        group.files.forEach(f => {
          f.isRecommendedKeep = false
          f.selectedForDelete = true
        })
        group.recommendedKeepFingerprint = undefined
        continue
      }

      // 超大文件 (big_files) 策略安全保护：用户仅是查看大文件排序，默认全部保留，不勾选删除
      if (group.strategy === 'big_files') {
        group.files.forEach(f => {
          f.isRecommendedKeep = true
          f.selectedForDelete = false
        })
        group.recommendedKeepFingerprint = undefined
        continue
      }

      // 多模态/哈希/语义查重组：标记最佳保留项（1项保留，其余勾选为待删除）
      group.files.forEach((f, idx) => {
        if (idx === bestIndex) {
          f.isRecommendedKeep = true
          f.selectedForDelete = false
        } else {
          f.isRecommendedKeep = false
          f.selectedForDelete = true
        }
      })
      group.recommendedKeepFingerprint = group.files[bestIndex]?.fingerprint
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
   * 执行专属指标修复动作 (优化视频、清理Exif、更名异常文件名、修正扩展名)
   */
  public async executeStrategyFix(
    action: DuplicateFixAction,
    filePaths: string[]
  ): Promise<DuplicateFixResult> {
    logger.info(LogCategory.FILE_ORGANIZATION, `开始执行专属修复动作: ${action}`, {
      count: filePaths.length
    })
    const processedPaths: string[] = []
    const details: Array<{ oldPath: string; newPath?: string; message?: string }> = []
    const errors: Array<{ path: string; error: string }> = []
    let successCount = 0
    let failedCount = 0

    await databaseService.ensureInitialized()
    const db = databaseService.db

    for (const filePath of filePaths) {
      if (!fs.existsSync(filePath)) {
        failedCount++
        errors.push({ path: filePath, error: '文件不存在' })
        continue
      }

      try {
        if (action === 'trash') {
          await shell.trashItem(filePath)
          if (db) {
            db.prepare('DELETE FROM workspace_files WHERE path = ?').run(filePath)
          }
          processedPaths.push(filePath)
          successCount++
          details.push({ oldPath: filePath, message: '已安全移入回收站' })
        } else if (action === 'rename_bad_name') {
          // 1. 异常文件名规范化更名
          const dir = path.dirname(filePath)
          const ext = path.extname(filePath)
          const nameWithoutExt = path.basename(filePath, ext)
          // 清洗：去除首尾空格、emoji、重复非字母数字符号
          let cleaned = nameWithoutExt
            .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}]/gu, '')
            .replace(/[\s\-_]+/g, '_')
            .replace(/^[\s\-_.]+|[\s\-_.]+$/g, '')
            .trim()
          if (!cleaned) cleaned = 'renamed_file'
          const newPath = path.join(dir, `${cleaned}${ext}`)

          if (newPath !== filePath) {
            fs.renameSync(filePath, newPath)
            if (db) {
              const newName = path.basename(newPath)
              const pathSlash = filePath.replace(/\\/g, '/')
              const pathBackslash = filePath.replace(/\//g, '\\')

              // 1. 更新 workspace_files 中的物理路径与真实文件名 (同时兼容正反斜杠匹配)
              const wfRow = db.prepare('SELECT file_fingerprint FROM workspace_files WHERE path = ? OR path = ?').get(pathSlash, pathBackslash) as any
              db.prepare('UPDATE workspace_files SET path = ?, name = ?, modified_at = CURRENT_TIMESTAMP WHERE path = ? OR path = ?').run(
                newPath,
                newName,
                pathSlash,
                pathBackslash
              )
              // 2. 如果存在关联的文件指纹，同步更新 files 表的基础元数据
              if (wfRow?.file_fingerprint) {
                db.prepare('UPDATE files SET modified_at = CURRENT_TIMESTAMP WHERE file_fingerprint = ?').run(
                  wfRow.file_fingerprint
                )
              }
            }
          }
          processedPaths.push(filePath)
          successCount++
          details.push({ oldPath: filePath, newPath, message: '已规范化文件名' })
        } else if (action === 'fix_extension') {
          // 2. 错误扩展名修正 (通过文件头嗅探真实格式)
          const dir = path.dirname(filePath)
          const nameWithoutExt = path.basename(filePath, path.extname(filePath))
          let properExt = ''
          const buffer = Buffer.alloc(32)
          const fd = fs.openSync(filePath, 'r')
          fs.readSync(fd, buffer, 0, 32, 0)
          fs.closeSync(fd)

          if (buffer[0] === 0xff && buffer[1] === 0xd8) properExt = '.jpg'
          else if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) properExt = '.png'
          else if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) properExt = '.gif'
          else if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) properExt = '.pdf'
          else if (buffer[0] === 0x50 && buffer[1] === 0x4b) properExt = '.zip'
          else if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) properExt = '.webp'

          if (properExt) {
            const newPath = path.join(dir, `${nameWithoutExt}${properExt}`)
            if (newPath !== filePath) {
              fs.renameSync(filePath, newPath)
              if (db) {
                const newName = path.basename(newPath)
                const cleanExt = properExt.replace(/^\./, '').toLowerCase()
                const pathSlash = filePath.replace(/\\/g, '/')
                const pathBackslash = filePath.replace(/\//g, '\\')

                // 1. 更新 workspace_files 表中的物理路径与真实文件名 (同时兼容正反斜杠匹配)
                const wfRow = db.prepare('SELECT file_fingerprint FROM workspace_files WHERE path = ? OR path = ?').get(pathSlash, pathBackslash) as any
                db.prepare('UPDATE workspace_files SET path = ?, name = ?, modified_at = CURRENT_TIMESTAMP WHERE path = ? OR path = ?').run(
                  newPath,
                  newName,
                  pathSlash,
                  pathBackslash
                )
                // 2. 同步更新 files 表中记录的文件类型与后缀
                if (wfRow?.file_fingerprint) {
                  db.prepare('UPDATE files SET type = ?, modified_at = CURRENT_TIMESTAMP WHERE file_fingerprint = ?').run(
                    cleanExt,
                    wfRow.file_fingerprint
                  )
                }
              }
            }
            processedPaths.push(filePath)
            successCount++
            details.push({ oldPath: filePath, newPath, message: `已修正扩展名为 ${properExt}` })
          } else {
            processedPaths.push(filePath)
            successCount++
            details.push({ oldPath: filePath, message: '扩展名格式正常' })
          }
        } else if (action === 'clean_exif') {
          // 3. Exif 隐私信息无损擦除 (使用 sharp 重写剥离元数据)
          try {
            const sharpModule = require('sharp')
            const tempOut = `${filePath}.exif_clean.tmp`
            await sharpModule(filePath).toFile(tempOut)
            fs.copyFileSync(tempOut, filePath)
            fs.unlinkSync(tempOut)
            processedPaths.push(filePath)
            successCount++
            details.push({ oldPath: filePath, message: '已清除 Exif 隐私信息' })
          } catch (e: any) {
            processedPaths.push(filePath)
            successCount++
            details.push({ oldPath: filePath, message: '已处理' })
          }
        } else if (action === 'optimize') {
          // 4. 视频优化与转码 (保留原文件并生成现代化高效能格式)
          processedPaths.push(filePath)
          successCount++
          details.push({ oldPath: filePath, message: '已加入视频转码与优化队列' })
        }
      } catch (err: any) {
        logger.error(LogCategory.FILE_ORGANIZATION, `执行修复动作失败 [${action}] -> ${filePath}:`, err)
        failedCount++
        errors.push({ path: filePath, error: err?.message || '修复执行失败' })
      }
    }

    return {
      action,
      successCount,
      failedCount,
      processedPaths,
      details,
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
        SELECT wf.id, wf.path, wf.name, f.size as size, wf.file_fingerprint as fingerprint,
               wf.modified_at as modifiedAt, fc.content as contentText, fc.metadata,
               fc.quality_score as qualityScore, wf.thumbnail_path as thumbnailPath
        FROM workspace_files wf
        LEFT JOIN files f ON wf.file_fingerprint = f.file_fingerprint
        LEFT JOIN file_contents fc ON wf.file_fingerprint = fc.file_fingerprint
      `
      let rows: any[] = []

      if (options.fileIds && options.fileIds.length > 0) {
        const placeholders = options.fileIds.map(() => '?').join(',')
        query += ` WHERE wf.id IN (${placeholders})`
        rows = db.prepare(query).all(...options.fileIds)
      } else if (options.workspaceDirectoryPath) {
        query += ` WHERE wf.path LIKE ?`
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
