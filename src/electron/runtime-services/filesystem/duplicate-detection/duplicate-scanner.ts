import * as path from 'path'
import {
  DuplicateDetectionOptions,
  DuplicateFileItem,
  DuplicateGroup,
  DuplicateDetectionStrategy
} from '@firefly/types'
import { LogCategory, logger } from '@firefly/shared'
import { t } from '@app/languages'
import { existsAsync } from '../../../infra/fs'
import {
  formatStrategyDescription,
  getProtectedExcludedItems
} from './duplicate-recommendation'

/**
 * Track 1: 调用 firefly-omni Rust HTTP API 执行多模态查重 (支持 SSE 流式进度与结果回传)
 */
export async function scanViaOmniRust(
  omniApiUrl: string,
  filePaths: string[],
  options: DuplicateDetectionOptions,
  onProgress?: (data: {
    scanned: number
    totalScanned: number
    stage: string
    group?: any
  }) => void
): Promise<DuplicateGroup[]> {
  try {
    const hasWorkspace = options.workspaceDirectoryPath
      ? await existsAsync(options.workspaceDirectoryPath)
      : false
    const targetPaths =
      hasWorkspace &&
      options.workspaceDirectoryPath &&
      (!options.fileIds || options.fileIds.length === 0)
        ? [options.workspaceDirectoryPath]
        : filePaths.length > 0
          ? filePaths
          : [options.workspaceDirectoryPath || '']

    const excludedItems = getProtectedExcludedItems()
    const reqBody = {
      paths: targetPaths,
      min_similarity:
        options.minSimilarity !== undefined
          ? options.minSimilarity > 10
            ? options.minSimilarity / 10
            : options.minSimilarity
          : 7.5,
      strategies: options.strategies || ['exact_hash', 'image_phash'],
      name_issues_mode: options.nameIssuesMode || 'multilingual',
      excluded_items: excludedItems
    }

    // 尝试通过 SSE 流式获取实时动态与线性进度
    const streamResp = await fetch(`${omniApiUrl}/api/duplicate/scan/stream`, {
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
                  stage: t('扫描完成')
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
                description: formatStrategyDescription(g.strategy, (g.files || []).length),
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
                stage: t('发现重复组'),
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
    const resp = await fetch(`${omniApiUrl}/api/duplicate/scan`, {
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
      description: formatStrategyDescription(g.strategy, (g.files || []).length),
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
 * 简单的文本 Jaccard 相似度计算
 */
export function calculateTextJaccardSimilarity(textA: string, textB: string): number {
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
export function detectFilenameCopies(dbFiles: any[]): DuplicateGroup[] {
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
 * Track 2: 基于 SQLite 缓存的 content_text、指纹与副本启发式规则查重
 */
export async function scanDocSemanticsAndHeuristics(
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
          const sim = calculateTextJaccardSimilarity(
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
    const copyGroups = detectFilenameCopies(dbFiles)
    groups.push(...copyGroups)
  }

  return groups
}

/**
 * 合并两轨查重结果，避免相同文件对在多个组中重复冗余
 */
export function mergeDuplicateGroups(
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
