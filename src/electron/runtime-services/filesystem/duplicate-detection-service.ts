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
import { ConfigOrchestrator } from '../../config/config-orchestrator'

export class DuplicateDetectionService {
  private omniApiUrl = 'http://127.0.0.1:9190'

  /**
   * 获取当前系统与配置中不可被清理的受保护排除项名单 (严格依据 IGNORE_RULES 中的 isCzkawka 配置)
   */
  public getProtectedExcludedItems(): string[] {
    const rawProtectedItems: string[] = [
      '.VirtualDirectory',
      '.thumbnail',
      'desktop.ini',
      'thumbs.db',
      '.DS_Store',
      '.localized',
      '.git',
      '.ssh',
      '.vscode',
      '.idea',
      'node_modules',
      '__pycache__',
      '.venv',
      'venv',
      '.cache',
      'vendor',
      '.bundle',
      '.pnpm-store',
      '.npm',
      '.yarn',
      'coverage',
      '.nyc_output',
      'bootmgr',
      'bootnxt',
      'pagefile.sys',
      'hiberfil.sys',
      'swapfile.sys',
      '$RECYCLE.BIN',
      'System Volume Information',
      'Config.Msi',
      '$WinREAgent',
      'Recovery',
      '$GetCurrent',
      'DumpStack.log.tmp'
    ]

    try {
      const userRules = ConfigOrchestrator.getInstance().getValue<any[]>('IGNORE_RULES') || []
      for (const rule of userRules) {
        if (!rule.isActive || !rule.value) continue
        const val = String(rule.value).trim()
        if (!val) continue

        // 显式配置了 isCzkawka 字段
        if (rule.isCzkawka === true) {
          if (!rawProtectedItems.includes(val)) {
            rawProtectedItems.push(val)
          }
        } else if (rule.isCzkawka === false) {
          // 若用户或系统显式标记 isCzkawka = false，则从保护名单剔除
          const idx = rawProtectedItems.indexOf(val)
          if (idx !== -1) {
            rawProtectedItems.splice(idx, 1)
          }
        } else {
          // 老数据兼容：未设置 isCzkawka 时，非待清理扩展名/构建目录的目录与文件规则默认纳入保护
          const isCleanTarget = ['.tmp', '.log', '.bak', '.old', '.dmp', 'dist', 'build', 'out', 'target'].some(t => val.toLowerCase().includes(t))
          if ((rule.type === 'directory' || rule.type === 'file') && !isCleanTarget) {
            if (!rawProtectedItems.includes(val)) {
              rawProtectedItems.push(val)
            }
          }
        }
      }
    } catch {}

    // 将原始规则项格式化为 czkawka 所要求的双向通配符格式（确保目录、子目录与文件名均能命中）
    const formattedPatterns = new Set<string>()
    for (const item of rawProtectedItems) {
      if (!item) continue
      if (item.includes('*')) {
        formattedPatterns.add(item)
      } else {
        // 对于目录和文件模式，生成标准跨平台通配符表达式
        formattedPatterns.add(`*${item}*`)
        formattedPatterns.add(`*/${item}/*`)
        formattedPatterns.add(`*\\${item}\\*`)
        formattedPatterns.add(`*/${item}`)
        formattedPatterns.add(`*\\${item}`)
      }
    }

    return Array.from(formattedPatterns)
  }

  /**
   * 执行双轨并行查重扫描 (支持已分析与未分析的全量工作区物理文件)
   */
  public async scanDuplicates(
    options: DuplicateDetectionOptions,
    onProgress?: (data: { scanned: number; totalScanned: number; stage: string; group?: any }) => void
  ): Promise<DuplicateGroup[]> {
    const fileIdsCount = options.fileIds?.length ?? 0
    const hasWorkspacePath = !!(options.workspaceDirectoryPath && fs.existsSync(options.workspaceDirectoryPath))

    logger.info(LogCategory.FILE_ORGANIZATION, '开始执行双轨查重扫描', {
      workspaceDirectoryPath: options.workspaceDirectoryPath,
      targetFilesCount: fileIdsCount > 0 ? fileIdsCount : '全目录全量物理文件',
      strategiesCount: options.strategies?.length ?? 0,
      minSimilarity: options.minSimilarity
    })
    const startTime = Date.now()

    // 1. 获取要扫描的目标文件列表与已有元数据 (从 SQLite 读取已分析记录，用于后续元数据富化)
    const dbFiles = await this.getTargetFilesFromDb(options)
    const filePaths = dbFiles.map(f => f.path).filter(p => fs.existsSync(p))

    // 若既没有指定文件且工作区目录无效，则无目标可扫
    if (filePaths.length === 0 && !hasWorkspacePath) {
      return []
    }

    // 2. 双轨并发扫描 (Promise.all)
    // Omni 负责对全量物理目录进行全策略扫描，DocSemantics 负责对已有数据库文本进行语义对比
    const [omniResult, docResult] = await Promise.allSettled([
      this.scanViaOmniRust(filePaths, options, onProgress),
      dbFiles.length > 0 ? this.scanDocSemanticsAndHeuristics(dbFiles, options) : Promise.resolve([])
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
   * Track 1: 调用 firefly-omni Rust HTTP API 执行多模态查重 (支持 SSE 流式进度与结果回传)
   */
  private async scanViaOmniRust(
    filePaths: string[],
    options: DuplicateDetectionOptions,
    onProgress?: (data: { scanned: number; totalScanned: number; stage: string; group?: any }) => void
  ): Promise<DuplicateGroup[]> {
    try {
      const targetPaths = (options.workspaceDirectoryPath && fs.existsSync(options.workspaceDirectoryPath) && (!options.fileIds || options.fileIds.length === 0))
        ? [options.workspaceDirectoryPath]
        : (filePaths.length > 0 ? filePaths : [options.workspaceDirectoryPath || ''])

      const excludedItems = this.getProtectedExcludedItems()
      const reqBody = {
        paths: targetPaths,
        min_similarity: options.minSimilarity !== undefined
          ? (options.minSimilarity > 10 ? options.minSimilarity / 10 : options.minSimilarity)
          : 7.5,
        strategies: options.strategies || ['exact_hash', 'image_phash'],
        name_issues_mode: options.nameIssuesMode || 'multilingual',
        excluded_items: excludedItems
      }

      // 尝试通过 SSE 流式获取实时动态与线性进度
      const streamResp = await fetch(`${this.omniApiUrl}/api/duplicate/scan/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(180000)
      })

      if (streamResp.ok && streamResp.body) {
        const groups: DuplicateGroup[] = []
        const reader = streamResp.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        let maxTotalScanned = 0
        let maxScanned = 0

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n\n')
          buffer = lines.pop() || ''

          for (const block of lines) {
            let eventType = ''
            let dataStr = ''
            for (const line of block.split('\n')) {
              if (line.startsWith('event:')) {
                eventType = line.replace('event:', '').trim()
              } else if (line.startsWith('data:')) {
                dataStr = line.replace('data:', '').trim()
              }
            }

            if (eventType === 'progress' && dataStr) {
              try {
                const p = JSON.parse(dataStr)
                if (p.scanned) maxScanned = Math.max(maxScanned, p.scanned)
                if (p.total_scanned) maxTotalScanned = Math.max(maxTotalScanned, p.total_scanned)
                onProgress?.({
                  scanned: maxScanned,
                  totalScanned: maxTotalScanned,
                  stage: p.stage || ''
                })
              } catch {}
            } else if (eventType === 'done' && dataStr) {
              try {
                const d = JSON.parse(dataStr)
                if (d.total_scanned) {
                  maxTotalScanned = Math.max(maxTotalScanned, d.total_scanned)
                  maxScanned = Math.max(maxScanned, d.total_scanned)
                  onProgress?.({
                    scanned: maxScanned,
                    totalScanned: maxTotalScanned,
                    stage: '扫描完成'
                  })
                }
              } catch {}
            } else if (eventType === 'group' && dataStr) {
              try {
                const g = JSON.parse(dataStr)
                const mappedGroup: DuplicateGroup = {
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
                }
                groups.push(mappedGroup)
                onProgress?.({
                  scanned: maxScanned,
                  totalScanned: maxTotalScanned,
                  stage: '发现重复组',
                  group: mappedGroup
                })
              } catch {}
            }
          }
        }

        if (groups.length > 0) {
          return groups
        }
      }

      // 普通阻塞请求作为备用
      const resp = await fetch(`${this.omniApiUrl}/api/duplicate/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(60000)
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
    const dbFileLowerMap = new Map<string, any>()
    for (const f of dbFiles) {
      if (f.path) {
        dbFileMap.set(f.path, f)
        dbFileLowerMap.set(f.path.toLowerCase(), f)
      }
    }

    const allGroups = [...omniGroups, ...docGroups]
    const merged: DuplicateGroup[] = []
    const seenPairSignatures = new Set<string>()

    for (const group of allGroups) {
      // 补全文件元数据
      const enrichedFiles: DuplicateFileItem[] = group.files.map(item => {
        const dbInfo = dbFileMap.get(item.path) || dbFileLowerMap.get(item.path?.toLowerCase())
        // 核心规范：路径与文件名严格采用真实原生路径大小写（以数据库或真实物理存在路径为准）
        const realPath = dbInfo?.path || item.path
        const pureFileName = dbInfo?.name || (realPath ? path.basename(realPath) : item.name)

        return {
          fileId: dbInfo?.id || item.fileId || 0,
          fingerprint: item.fingerprint || dbInfo?.fingerprint || '',
          path: realPath,
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

        const currRes = DuplicateDetectionService.parseResolution(curr.resolution)
        const bestRes = DuplicateDetectionService.parseResolution(best.resolution)
        const currQuality = curr.qualityScore || 0
        const bestQuality = best.qualityScore || 0
        const currSize = curr.size || 0
        const bestSize = best.size || 0
        const currModTime = new Date(curr.modifiedAt || 0).getTime() || 0
        const bestModTime = new Date(best.modifiedAt || 0).getTime() || 0
        const currCreateTime = new Date(curr.createdAt || curr.modifiedAt || 0).getTime() || 0
        const bestCreateTime = new Date(best.createdAt || best.modifiedAt || 0).getTime() || 0
        const isCurrCopy = /副本|copy|\(\d+\)|_\d+$/i.test(curr.name)
        const isBestCopy = /副本|copy|\(\d+\)|_\d+$/i.test(best.name)

        if (rule === 'highest_resolution' || rule === 'best_resolution') {
          if (currRes !== bestRes) {
            if (currRes > bestRes) bestIndex = i
          } else if (currQuality !== bestQuality && (currQuality > 0 || bestQuality > 0)) {
            if (currQuality > bestQuality) bestIndex = i
          } else if (currSize !== bestSize) {
            if (currSize > bestSize) bestIndex = i
          } else if (currCreateTime !== bestCreateTime) {
            if (currCreateTime < bestCreateTime) bestIndex = i
          }
        } else if (rule === 'highest_quality' || rule === 'quality_score') {
          if (currQuality !== bestQuality && (currQuality > 0 || bestQuality > 0)) {
            if (currQuality > bestQuality) bestIndex = i
          } else if (currRes !== bestRes) {
            if (currRes > bestRes) bestIndex = i
          } else if (currSize !== bestSize) {
            if (currSize > bestSize) bestIndex = i
          } else if (currCreateTime !== bestCreateTime) {
            if (currCreateTime < bestCreateTime) bestIndex = i
          }
        } else if (rule === 'newest_modified' || rule === 'latest_modified') {
          if (currModTime !== bestModTime) {
            if (currModTime > bestModTime) bestIndex = i
          } else if (currSize !== bestSize) {
            if (currSize > bestSize) bestIndex = i
          }
        } else if (rule === 'oldest_created' || rule === 'earliest_created') {
          if (currCreateTime !== bestCreateTime) {
            if (currCreateTime < bestCreateTime) bestIndex = i
          } else if (currSize !== bestSize) {
            if (currSize > bestSize) bestIndex = i
          }
        } else if (rule === 'original_name') {
          if (!isCurrCopy && isBestCopy) {
            bestIndex = i
          } else if (isCurrCopy && !isBestCopy) {
            // 保留最佳
          } else if (curr.name.length !== best.name.length) {
            if (curr.name.length < best.name.length) bestIndex = i
          } else if (currCreateTime !== bestCreateTime) {
            if (currCreateTime < bestCreateTime) bestIndex = i
          }
        }
      }

      // 单体清理/修复/优化类策略：空文件、视频优化、异常文件名、临时缓存、空文件夹、断裂软链接、损坏文件
      // 这些指标发现的文件自身即是待处理目标，因此默认全部选中
      const isStandaloneAllSelectStrategy =
        group.strategy === 'empty_files' ||
        group.strategy === 'empty_folders' ||
        group.strategy === 'temporary_files' ||
        group.strategy === 'invalid_symlinks' ||
        group.strategy === 'broken_files' ||
        group.strategy === 'bad_names' ||
        group.strategy === 'video_optimizer'

      if (isStandaloneAllSelectStrategy) {
        group.files.forEach(f => {
          f.isRecommendedKeep = false
          f.selectedForDelete = true
        })
        group.recommendedKeepFingerprint = undefined
        continue
      }

      // 超大文件 (big_files)、Exif隐私清理 (exif_remover)、错误扩展名 (bad_extensions) 策略安全保护：默认全部保留，不勾选
      if (
        group.strategy === 'big_files' ||
        group.strategy === 'exif_remover' ||
        group.strategy === 'bad_extensions'
      ) {
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
    fileTargets: Array<string | { path: string; newName?: string }>,
    workspaceDirectoryPath?: string
  ): Promise<DuplicateFixResult> {
    logger.info(LogCategory.FILE_ORGANIZATION, `开始执行专属修复动作: ${action}`, {
      count: fileTargets.length,
      workspaceDirectoryPath
    })
    const processedPaths: string[] = []
    const details: Array<{ oldPath: string; newPath?: string; message?: string }> = []
    const errors: Array<{ path: string; error: string }> = []
    let successCount = 0
    let failedCount = 0
    let targetOutputDirectory: string | undefined = undefined

    // 格式化当前日期为 YYYYMMDD
    const now = new Date()
    const yyyymmdd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`

    await databaseService.ensureInitialized()
    const db = databaseService.db

    for (const item of fileTargets) {
      const filePath = typeof item === 'string' ? item : item.path
      const suggestedNewName = typeof item === 'object' ? item.newName : undefined

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
          // 1. 异常文件名更名：严格优先采用 Omni 计算并返回的推荐名 (suggestedNewName)
          const dir = path.dirname(filePath)
          let newPath = ''

          if (suggestedNewName && suggestedNewName.trim() && suggestedNewName.trim() !== path.basename(filePath)) {
            newPath = path.join(dir, suggestedNewName.trim())
          } else {
            // 兜底方案：清洗去除首尾空格、emoji、特殊符号、重复下划线
            const ext = path.extname(filePath)
            const nameWithoutExt = path.basename(filePath, ext)
            let cleaned = nameWithoutExt
              .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
              .replace(/[\s\-_]+/g, '_')
              .replace(/^[\s\-_.]+|[\s\-_.]+$/g, '')
              .trim()
            if (!cleaned) cleaned = 'renamed_file'
            newPath = path.join(dir, `${cleaned}${ext}`)
          }

          if (newPath && newPath !== filePath) {
            // 在 Windows NTFS 文件系统下，同名大小写变更必须通过临时中转名进行两步重命名
            if (process.platform === 'win32' && newPath.toLowerCase() === filePath.toLowerCase()) {
              const tempPath = path.join(dir, `__temp_rename_${Date.now()}_${path.basename(filePath)}`)
              fs.renameSync(filePath, tempPath)
              fs.renameSync(tempPath, newPath)
            } else {
              fs.renameSync(filePath, newPath)
            }

            if (db) {
              const newName = path.basename(newPath)
              const newExt = path.extname(newPath).toLowerCase()
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
                db.prepare('UPDATE files SET type = ?, modified_at = CURRENT_TIMESTAMP WHERE file_fingerprint = ?').run(
                  newExt,
                  wfRow.file_fingerprint
                )
              }
            }
          }
          processedPaths.push(filePath)
          successCount++
          details.push({ oldPath: filePath, newPath, message: '已按推荐名更名' })
        } else if (action === 'fix_extension') {
          // 2. 错误扩展名修正 (通过文件头嗅探真实格式，并在数据库中同步更新真实文件名与智能文件名的扩展名)
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
              if (process.platform === 'win32' && newPath.toLowerCase() === filePath.toLowerCase()) {
                const tempPath = path.join(dir, `__temp_fixext_${Date.now()}_${path.basename(filePath)}`)
                fs.renameSync(filePath, tempPath)
                fs.renameSync(tempPath, newPath)
              } else {
                fs.renameSync(filePath, newPath)
              }
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
                // 2. 同步更新 files 表中记录的文件类型与后缀，并顺带更新智能文件名 (smart_name) 的扩展名
                if (wfRow?.file_fingerprint) {
                  const fileRow = db.prepare('SELECT smart_name FROM files WHERE file_fingerprint = ?').get(wfRow.file_fingerprint) as any
                  let updatedSmartName = fileRow?.smart_name
                  if (updatedSmartName && typeof updatedSmartName === 'string') {
                    const oldSmartExt = path.extname(updatedSmartName)
                    if (oldSmartExt) {
                      const smartBase = path.basename(updatedSmartName, oldSmartExt)
                      updatedSmartName = `${smartBase}${properExt}`
                    } else {
                      updatedSmartName = `${updatedSmartName}${properExt}`
                    }
                  }
                  db.prepare('UPDATE files SET type = ?, smart_name = ?, modified_at = CURRENT_TIMESTAMP WHERE file_fingerprint = ?').run(
                    cleanExt,
                    updatedSmartName || null,
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
          // 3. Exif 隐私信息擦除 (保存为无损副本到 .VirtualDirectory\.cleaned_exif\{YYYYMMDD}，保持原文件名，绝不修改原文件)
          const baseWorkspace = workspaceDirectoryPath || path.dirname(filePath)
          const outDir = path.join(baseWorkspace, '.VirtualDirectory', '.cleaned_exif', yyyymmdd)
          targetOutputDirectory = outDir
          if (!fs.existsSync(outDir)) {
            fs.mkdirSync(outDir, { recursive: true })
          }

          const originalFileName = path.basename(filePath)
          const outFilePath = path.join(outDir, originalFileName)

          let cleanExifSucceeded = false

          // 方式一：尝试调用 Omni 服务
          try {
            const resp = await fetch(`${this.omniApiUrl}/api/cleanup/fix`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'clean_exif', paths: [filePath] }),
              signal: AbortSignal.timeout(15000)
            })
            if (resp.ok) {
              const fixRes = (await resp.json()) as any
              if (fixRes.success_count > 0) {
                // 探测同目录下 czkawka 生成的 *.czkawka_cleaned_exif.* 副本文件
                const srcDir = path.dirname(filePath)
                const ext = path.extname(filePath)
                const stem = path.basename(filePath, ext)
                const cleanedCandidates = [
                  path.join(srcDir, `${stem}.czkawka_cleaned_exif${ext}`),
                  path.join(srcDir, `${stem.toLowerCase()}.czkawka_cleaned_exif${ext.toLowerCase()}`),
                  path.join(srcDir, `${stem.toUpperCase()}.czkawka_cleaned_exif${ext.toUpperCase()}`)
                ]
                for (const cand of cleanedCandidates) {
                  if (fs.existsSync(cand)) {
                    // 若目标目录已存在同名文件，直接覆盖
                    if (fs.existsSync(outFilePath)) {
                      try { fs.unlinkSync(outFilePath) } catch {}
                    }
                    fs.copyFileSync(cand, outFilePath)
                    try { fs.unlinkSync(cand) } catch {}
                    cleanExifSucceeded = true
                    break
                  }
                }
              }
            }
          } catch {}

          // 方式二：若 Omni 未输出，使用本地 Sharp 强力生成去 Exif 副本
          if (!cleanExifSucceeded) {
            try {
              const sharpModule = require('sharp')
              const inputBuffer = fs.readFileSync(filePath)
              const ext = path.extname(filePath).toLowerCase()
              let cleanBuffer: Buffer
              if (ext === '.jpg' || ext === '.jpeg') {
                cleanBuffer = await sharpModule(inputBuffer).withMetadata({ exif: {} }).jpeg().toBuffer()
              } else if (ext === '.png') {
                cleanBuffer = await sharpModule(inputBuffer).withMetadata({ exif: {} }).png().toBuffer()
              } else if (ext === '.webp') {
                cleanBuffer = await sharpModule(inputBuffer).withMetadata({ exif: {} }).webp().toBuffer()
              } else {
                cleanBuffer = await sharpModule(inputBuffer).rotate().toBuffer()
              }
              // 直接覆盖已有同名文件
              if (fs.existsSync(outFilePath)) {
                try { fs.unlinkSync(outFilePath) } catch {}
              }
              fs.writeFileSync(outFilePath, cleanBuffer)
              cleanExifSucceeded = true
            } catch (sharpErr: any) {
              logger.warn(LogCategory.FILE_ORGANIZATION, `本地 Sharp 擦除 Exif 副本生成异常 [${filePath}]:`, sharpErr)
            }
          }

          if (cleanExifSucceeded && fs.existsSync(outFilePath)) {
            processedPaths.push(filePath)
            successCount++
            details.push({ oldPath: filePath, newPath: outFilePath, message: `已成功生成去 Exif 副本至: ${outFilePath}` })
          } else {
            failedCount++
            errors.push({ path: filePath, error: '生成去 Exif 副本失败' })
          }
        } else if (action === 'optimize') {
          // 4. 视频优化与转码 (保存优化后的视频到 .VirtualDirectory\.video_optimizer\{YYYYMMDD}，保持原文件名，不修改原文件)
          const baseWorkspace = workspaceDirectoryPath || path.dirname(filePath)
          const outDir = path.join(baseWorkspace, '.VirtualDirectory', '.video_optimizer', yyyymmdd)
          targetOutputDirectory = outDir
          if (!fs.existsSync(outDir)) {
            fs.mkdirSync(outDir, { recursive: true })
          }

          const ext = path.extname(filePath)
          const stem = path.basename(filePath, ext)
          const originalFileName = path.basename(filePath)
          const outFilePath = path.join(outDir, originalFileName)

          let omniTranscoded = false
          let finalTranscodedPath = ''
          let failMessage = ''

          // 步骤 1：直接调用 Omni Czkawka 引擎服务执行视频转码
          logger.info(LogCategory.FILE_ORGANIZATION, `[视频优化] 向 Omni 发起转码请求: ${filePath}`)
          try {
            const resp = await fetch(`${this.omniApiUrl}/api/cleanup/fix`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'optimize', paths: [filePath] }),
              signal: AbortSignal.timeout(600000)
            })
            if (resp.ok) {
              const fixRes = (await resp.json()) as any
              logger.info(LogCategory.FILE_ORGANIZATION, `[视频优化] Omni 转码返回结果:`, fixRes)
              if (fixRes.success_count > 0) {
                // czkawka 在 overwrite_original = false 时，生成的优化视频位于同目录，名为 *.czkawka_optimized.mp4
                const srcDir = path.dirname(filePath)
                const ext = path.extname(filePath)
                const stem = path.basename(filePath, ext)
                const optimizedCandidate = path.join(srcDir, `${stem}.czkawka_optimized.mp4`)
                const actualOutFile = path.join(outDir, `${stem}.mp4`)

                if (fs.existsSync(optimizedCandidate) && fs.statSync(optimizedCandidate).size > 0) {
                  if (fs.existsSync(actualOutFile)) {
                    try { fs.unlinkSync(actualOutFile) } catch {}
                  }
                  fs.copyFileSync(optimizedCandidate, actualOutFile)
                  try { fs.unlinkSync(optimizedCandidate) } catch {}
                  finalTranscodedPath = actualOutFile
                  omniTranscoded = true
                  logger.info(LogCategory.FILE_ORGANIZATION, `[视频优化] 捕获并移动优化视频成功: ${actualOutFile}`)
                } else {
                  // 尝试扫描同目录下以 stem 开头且不为原文件的生成文件
                  const candFiles = fs.readdirSync(srcDir).filter(f => f.startsWith(stem) && f !== originalFileName)
                  for (const candName of candFiles) {
                    const candFull = path.join(srcDir, candName)
                    if (fs.existsSync(candFull) && fs.statSync(candFull).isFile()) {
                      const candExt = path.extname(candName) || '.mp4'
                      const targetOut = path.join(outDir, `${stem}${candExt}`)
                      if (fs.existsSync(targetOut)) {
                        try { fs.unlinkSync(targetOut) } catch {}
                      }
                      fs.copyFileSync(candFull, targetOut)
                      try { fs.unlinkSync(candFull) } catch {}
                      finalTranscodedPath = targetOut
                      omniTranscoded = true
                      logger.info(LogCategory.FILE_ORGANIZATION, `[视频优化] 捕获候选转码文件成功: ${targetOut}`)
                      break
                    }
                  }
                }
              } else if (fixRes.errors && fixRes.errors.length > 0) {
                failMessage = fixRes.errors.join('; ')
                logger.warn(LogCategory.FILE_ORGANIZATION, `[视频优化] Omni 转码返回错误: ${failMessage}`)
              }
            } else {
              logger.warn(LogCategory.FILE_ORGANIZATION, `[视频优化] Omni 转码 HTTP 请求失败: status=${resp.status}`)
              failMessage = `Omni 服务响应异常 (HTTP ${resp.status})`
            }
          } catch (e: any) {
            logger.warn(LogCategory.FILE_ORGANIZATION, `[视频优化] Omni 视频转码接口调用异常 [${filePath}]:`, e)
            failMessage = e?.message || '请求 Omni 视频转码服务超时或失败'
          }

          if (omniTranscoded && finalTranscodedPath && fs.existsSync(finalTranscodedPath)) {
            processedPaths.push(filePath)
            successCount++
            details.push({ oldPath: filePath, newPath: finalTranscodedPath, message: `已完成视频高效能转码优化并导出至: ${finalTranscodedPath}` })
          } else {
            failedCount++
            errors.push({ path: filePath, error: failMessage || 'Czkawka 视频转码未产出物理文件' })
          }
        }
      } catch (err: any) {
        logger.error(LogCategory.FILE_ORGANIZATION, `执行修复动作失败 [${action}] -> ${filePath}:`, err)
        failedCount++
        errors.push({ path: filePath, error: err?.message || '修复执行失败' })
      }
    }

    // 执行成功且存在输出目录时，自动使用系统文件管理器打开对应目标目录
    if (successCount > 0 && targetOutputDirectory && fs.existsSync(targetOutputDirectory)) {
      try {
        await shell.openPath(targetOutputDirectory)
        logger.info(LogCategory.FILE_ORGANIZATION, `已使用系统文件管理器打开生成目录: ${targetOutputDirectory}`)
      } catch (openErr: any) {
        logger.warn(LogCategory.FILE_ORGANIZATION, `自动打开输出目录失败:`, openErr)
      }
    }

    return {
      action,
      successCount,
      failedCount,
      processedPaths,
      outputDirectory: targetOutputDirectory,
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
