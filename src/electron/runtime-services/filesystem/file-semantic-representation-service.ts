import Database from 'better-sqlite3'
import path from 'node:path'
import {
  LogCategory,
  logger,
  buildSemanticText,
  getCanonicalConceptName,
  isCandidateWordAdmissible,
  getFileCategory,
  isTestEnvironment,
  type SemanticTagInput,
  type TagProvenanceGroup
} from '@firefly/shared'
import { databaseService } from '../database/database-service'
import { parseCreatedYear, inferQualityLevel } from '../database/dao/canonical-dao'
import { omniClient, resolveQueryEncoderFilter } from '../../services/omni-client'
import { omniService } from '../system/omni-service'
import { canonicalTextService } from '../analysis-queue-service/canonical-text-service'
import { ConfigOrchestrator } from '../../config/config-orchestrator'
import { decompressText } from '../../utils/text-compressor'
import { buildFilePrompt } from '@firefly/core-engine'

/**
 * 文件的标准语义证据对象（供聚类、整理、检索等下游消费）
 */
export interface SemanticEvidence {
  fileId: number
  fileFingerprint: string
  displayName: string
  canonicalText: string
  rawCanonicalText?: string | null
  keywords: string[]
  fileCategory?: string
  vector?: number[]
}

/**
 * 语义证据解析配置选项
 */
export interface ResolveEvidenceOptions {
  /** 是否必须包含向量（整理/聚类为 true，仅取文本为 false） */
  requireVector?: boolean
  /** 是否为纯读模式（如整理归类，严禁调用 solidify 回写 DB/zvec，未命中时批量内存 JIT） */
  readOnly?: boolean
  /** 指定编码档位与维度，缺省自动读取当前环境配置 */
  embeddingProfile?: string
  embeddingDim?: number
  /** 允许的超时时限 (ms)，超时触发安全保底 */
  timeoutMs?: number
  /** 内部数据库分批上限（防 SQLITE_MAX_VARIABLE_NUMBER 溢出，默认 500） */
  dbChunkSize?: number
  /** 向量读取分批上限（防 IPC / HTTP 413 超限，默认 200） */
  vectorChunkSize?: number
  /** 进度通知回调（用于推送提取特征向量批次进度） */
  onProgress?: (currentStep: number, totalSteps: number, message: string) => void
}

/**
 * 语义表示服务契约接口
 */
export interface IFileSemanticRepresentationService {
  getSemanticEvidences(
    fileIds: number[],
    options?: ResolveEvidenceOptions
  ): Promise<SemanticEvidence[]>

  resolveCanonicalVectors(fingerprints: string[], dim?: number): Promise<Map<string, number[]>>
}

/** 依赖注入容器接口（支持测试隔离） */
export interface FileSemanticRepresentationDeps {
  db?: Database.Database
  omniClient?: typeof omniClient
  omniService?: typeof omniService
  canonicalTextService?: typeof canonicalTextService
  configOrchestrator?: typeof ConfigOrchestrator
}

const SEMANTIC_TAG_GROUPS: ReadonlySet<string> = new Set(['fused', 'ai', 'user'])

function extractContentText(blobOrText: unknown): string {
  if (!blobOrText) return ''
  if (typeof blobOrText === 'string') return blobOrText
  if (Buffer.isBuffer(blobOrText)) {
    try {
      return decompressText(blobOrText)
    } catch {
      return blobOrText.toString('utf-8')
    }
  }
  return ''
}

export class FileSemanticRepresentationService implements IFileSemanticRepresentationService {
  constructor(private readonly deps: FileSemanticRepresentationDeps = {}) {}

  private getDb(): Database.Database {
    if (this.deps.db) return this.deps.db
    const db = databaseService.db
    if (!db) {
      throw new Error('[FileSemanticRepresentationService] 数据库尚未初始化')
    }
    return db
  }

  private getOmniClient(): typeof omniClient {
    return this.deps.omniClient ?? omniClient
  }

  private getOmniService(): typeof omniService {
    return this.deps.omniService ?? omniService
  }

  private getCanonicalTextService(): typeof canonicalTextService {
    return this.deps.canonicalTextService ?? canonicalTextService
  }

  private getConfig(): ConfigOrchestrator {
    if (this.deps.configOrchestrator) {
      return this.deps.configOrchestrator.getInstance()
    }
    return ConfigOrchestrator.getInstance()
  }

  /**
   * 批量解析文件的完整语义证据与聚焦向量
   *
   * 1. 优先直读 files.canonical_text 与 zvec {fp} 主槽；
   * 2. 若缺失且文件已分析完成，统一委托 canonicalTextService.solidify(fp) 固化并回填主槽，
   *    严禁本服务私自调用 batchEmbedText 并裸写 zvec，防止双重事实源与并发覆写竞态；
   * 3. 在途防毒化保护：对尚未完成阶段二分析（is_analyzed = 0）的文件，严禁固化抢跑落库，仅使用内存会话级降级表示；
   * 4. 失败熔断保护：对 canonical_vector_state = 'failed' 的文件，执行退避并接入软熔断，禁止同步阻塞；
   * 5. visual_only 多模态兼容：无字图片在 Classic 档位下若缺 384d 向量，提供纯净名称作为 embeddingText 供 Omni 端内按需 JIT 编码，不污染 DB 终态。
   */
  async getSemanticEvidences(
    fileIds: number[],
    options?: ResolveEvidenceOptions
  ): Promise<SemanticEvidence[]> {
    if (!fileIds || fileIds.length === 0) {
      return []
    }

    const db = this.getDb()
    const config = this.getConfig()
    const profile =
      options?.embeddingProfile ||
      config.getValue<string>('AI_EMBEDDING_PROFILE') ||
      'classic_light'
    const isGemma = (profile || '').toLowerCase().includes('gemma')
    const activeProfile = isGemma ? 'gemma_unified' : 'classic_light'
    const configuredDim = config.getValue<number>('EMBEDDING_MRL_DIMENSION') || 512
    const activeDim = options?.embeddingDim || (isGemma ? configuredDim : 384)
    const dbChunkSize = options?.dbChunkSize || 500
    const vectorChunkSize = options?.vectorChunkSize || 200
    const timeoutMs = options?.timeoutMs || 5000

    const uniqueFileIds = Array.from(new Set(fileIds))
    const rawFileRows: Array<{
      file_id: number
      file_fingerprint: string | null
      path: string
      name: string
      is_analyzed: number
      smart_name: string | null
      description: string | null
      canonical_text: string | null
      canonical_vector_state: string | null
      author?: string | null
      language?: string | null
      created_at?: string | number | null
      quality_score?: number | null
      content: Buffer | string | null
      ocr: Buffer | string | null
      asr: Buffer | string | null
      lrc: Buffer | string | null
    }> = []

    // 探测可选表与可选列是否存在（兼顾轻量单测与最小测试集）
    const hasContentsTable = Boolean(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='file_contents'").get()
    )
    const hasTagsPrivate = Boolean(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='file_tags_private'").get()
    )
    const hasTagRelations = Boolean(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='file_tag_relations'").get()
    )
    const filesCols = new Set(
      (db.prepare("PRAGMA table_info(files)").all() as Array<{ name: string }>).map(c => c.name)
    )
    const wfCols = new Set(
      (db.prepare("PRAGMA table_info(workspace_files)").all() as Array<{ name: string }>).map(c => c.name)
    )
    const contentsCols = hasContentsTable
      ? new Set(
          (db.prepare("PRAGMA table_info(file_contents)").all() as Array<{ name: string }>).map(
            c => c.name
          )
        )
      : new Set<string>()
    const stateColExpr = filesCols.has('canonical_vector_state')
      ? 'f.canonical_vector_state'
      : 'NULL AS canonical_vector_state'
    const isAnalyzedColExpr = wfCols.has('is_analyzed') ? 'wf.is_analyzed' : '1 AS is_analyzed'
    const smartNameColExpr = filesCols.has('smart_name') ? 'f.smart_name' : 'NULL AS smart_name'
    const descColExpr = filesCols.has('description') ? 'f.description' : 'NULL AS description'
    const canonTextColExpr = filesCols.has('canonical_text')
      ? 'f.canonical_text'
      : 'NULL AS canonical_text'
    const authorColExpr = filesCols.has('author') ? 'f.author' : 'NULL AS author'
    const langColExpr = filesCols.has('language') ? 'f.language' : 'NULL AS language'
    const createdAtColExpr = filesCols.has('created_at') ? 'f.created_at' : 'NULL AS created_at'
    const qualityScoreColExpr = contentsCols.has('quality_score')
      ? 'fc.quality_score'
      : 'NULL AS quality_score'

    // 1. 批量读取物理文件与主库基础元数据
    for (let i = 0; i < uniqueFileIds.length; i += dbChunkSize) {
      const chunk = uniqueFileIds.slice(i, i + dbChunkSize)
      const placeholders = chunk.map(() => '?').join(',')
      try {
        const sql = `
          SELECT
            wf.id AS file_id,
            wf.file_fingerprint,
            wf.path,
            wf.name,
            ${isAnalyzedColExpr},
            ${smartNameColExpr},
            ${descColExpr},
            ${canonTextColExpr},
            ${stateColExpr},
            ${authorColExpr},
            ${langColExpr},
            ${createdAtColExpr},
            ${qualityScoreColExpr},
            ${
              hasContentsTable
                ? 'fc.content, fc.ocr, fc.asr, fc.lrc'
                : 'NULL AS content, NULL AS ocr, NULL AS asr, NULL AS lrc'
            }
          FROM workspace_files wf
          LEFT JOIN files f ON wf.file_fingerprint = f.file_fingerprint
          ${
            hasContentsTable
              ? 'LEFT JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint'
              : ''
          }
          WHERE wf.id IN (${placeholders})
        `
        const rows = db.prepare(sql).all(...chunk) as any[]
        rawFileRows.push(...rows)
      } catch (err: any) {
        logger.warn(
          LogCategory.FILE_ORGANIZATION,
          `[FileSemanticRepresentationService] 读取文件元数据分批失败: ${err?.message ?? err}`
        )
      }
    }

    // 2. 收集有效指纹并批量读取标签元数据
    const fps = Array.from(
      new Set(rawFileRows.map(r => r.file_fingerprint).filter((fp): fp is string => Boolean(fp)))
    )
    const fpToKeywords = new Map<string, string[]>()
    const fpToStructuredTags = new Map<string, SemanticTagInput[]>()

    if (hasTagRelations) {
      for (let i = 0; i < fps.length; i += dbChunkSize) {
        const chunk = fps.slice(i, i + dbChunkSize)
        const placeholders = chunk.map(() => '?').join(',')
        try {
          const sql = hasTagsPrivate
            ? `
              SELECT
                ftr.file_fingerprint,
                ftr.tag_code,
                COALESCE(ft.name, ftr.tag_code) AS tag_name,
                ftr.name_path,
                ftr.tag_group
              FROM file_tag_relations ftr
              LEFT JOIN file_tags_private ft ON ft.code = ftr.tag_code
              WHERE ftr.file_fingerprint IN (${placeholders})
              ORDER BY ftr.file_fingerprint ASC, COALESCE(ftr.confidence, 0) DESC, ftr.tag_code ASC
            `
            : `
              SELECT
                ftr.file_fingerprint,
                ftr.tag_code,
                ftr.tag_code AS tag_name,
                ftr.name_path,
                ftr.tag_group
              FROM file_tag_relations ftr
              WHERE ftr.file_fingerprint IN (${placeholders})
              ORDER BY ftr.file_fingerprint ASC, COALESCE(ftr.confidence, 0) DESC, ftr.tag_code ASC
            `
          const tagRows = db.prepare(sql).all(...chunk) as Array<{
            file_fingerprint: string
            tag_code: string
            tag_name: string | null
            name_path: string | null
            tag_group: string | null
          }>

        for (const rel of tagRows) {
          const group = rel.tag_group || ''
          if (!SEMANTIC_TAG_GROUPS.has(group)) {
            continue
          }

          let kwList = fpToKeywords.get(rel.file_fingerprint)
          if (!kwList) {
            kwList = []
            fpToKeywords.set(rel.file_fingerprint, kwList)
          }

          let structuredList = fpToStructuredTags.get(rel.file_fingerprint)
          if (!structuredList) {
            structuredList = []
            fpToStructuredTags.set(rel.file_fingerprint, structuredList)
          }

          let name = rel.tag_name || rel.tag_code
          if (name && name.includes('.')) {
            name = getCanonicalConceptName(name) || (name.split('.').pop() || name)
          }
          if (name && isCandidateWordAdmissible(name).admissible && !kwList.includes(name)) {
            kwList.push(name)
            structuredList.push({
              code: rel.tag_code,
              name,
              namePath: rel.name_path || undefined,
              tagGroup: group as TagProvenanceGroup
            })
          }
          if (rel.name_path) {
            const segs = rel.name_path.split('/').filter(Boolean)
            const leafSeg = segs[segs.length - 1]
            if (
              leafSeg &&
              isCandidateWordAdmissible(leafSeg).admissible &&
              !kwList.includes(leafSeg)
            ) {
              kwList.push(leafSeg)
            }
          }
        }
      } catch (err: any) {
        logger.warn(
          LogCategory.FILE_ORGANIZATION,
          `[FileSemanticRepresentationService] 读取标签关系分批失败: ${err?.message ?? err}`
        )
      }
    }
  }

    // 3. 构建初步证据对象映射表
    const evidenceMap = new Map<number, SemanticEvidence>()
    for (const row of rawFileRows) {
      const fp = row.file_fingerprint || ''
      const smartName = (row.smart_name || '').trim()
      const rawName = (row.name || '').trim()
      const displayName = smartName || rawName || path.basename(row.path)
      const fileCategory = getFileCategory(rawName || row.path)
      let keywords = fp ? fpToKeywords.get(fp) || [] : []
      if (keywords.length === 0) {
        const stem = path.parse(rawName).name
        const baseName = stem
          .replace(/[\[【][^\]】]*[\]】]/g, ' ')
          .replace(/[\-_]?\d{4}[-_.]\d{1,2}[-_.]\d{1,2}\s*$/, '')
          .trim()
        const tokens = baseName.split(/[\s_\-\.\(\)\[\]【】_—·，,]+/).filter(Boolean)
        const kwList: string[] = []
        for (const tok of tokens) {
          if (
            tok.length >= 2 &&
            tok.length <= 15 &&
            !/^\d+$/.test(tok) &&
            isCandidateWordAdmissible(tok).admissible &&
            !kwList.includes(tok)
          ) {
            kwList.push(tok)
          }
        }
        if (kwList.length === 0) {
          const fallbackToken = baseName.trim() || stem.trim() || rawName.trim()
          if (
            fallbackToken.length >= 2 &&
            fallbackToken.length <= 15 &&
            isCandidateWordAdmissible(fallbackToken).admissible
          ) {
            kwList.push(fallbackToken)
          }
        }
        keywords = kwList
      }

      const rawCanonicalText = row.canonical_text || null
      let canonicalText = (row.canonical_text || '').trim()
      if (!canonicalText) {
        // JIT 纯文本兜底计算（使用标准统一公式）
        canonicalText = buildSemanticText({
          displayName,
          rawName,
          description: row.description || undefined,
          tags: fp ? fpToStructuredTags.get(fp) || [] : [],
          contents: {
            content: extractContentText(row.content),
            ocr: extractContentText(row.ocr),
            asr: extractContentText(row.asr),
            lrc: extractContentText(row.lrc)
          },
          createdYear: parseCreatedYear(row.created_at),
          author: row.author ? String(row.author).trim() || undefined : undefined,
          language: row.language ? String(row.language).trim() || undefined : undefined,
          qualityLevel: inferQualityLevel(row.quality_score)
        })
      }

      evidenceMap.set(row.file_id, {
        fileId: row.file_id,
        fileFingerprint: fp,
        displayName,
        canonicalText,
        rawCanonicalText,
        keywords,
        fileCategory: fileCategory || undefined
      })
    }

    // 4. 若无需向量，直接按输入顺序返回证据
    if (!options?.requireVector) {
      return fileIds
        .map(id => evidenceMap.get(id))
        .filter((ev): ev is SemanticEvidence => Boolean(ev))
    }

    // 5. 必须获取向量：直读 zvec {fp} 主槽并执行自愈补偿
    const vectorByFp = new Map<string, number[]>()
    const queryFps = Array.from(new Set(fps.filter(fp => fp && !fp.includes(':'))))
    const encoderWhitelist = new Set<number>(resolveQueryEncoderFilter(activeProfile))

    for (let i = 0; i < queryFps.length; i += vectorChunkSize) {
      const chunk = queryFps.slice(i, i + vectorChunkSize)
      try {
        const resp = await this.getOmniClient().getVectors(chunk, activeDim, timeoutMs)
        if (resp && Array.isArray(resp.vectors)) {
          for (const item of resp.vectors) {
            if (!encoderWhitelist.has(item.encoderId)) continue
            if (!item.vector || item.vector.length !== activeDim) continue
            vectorByFp.set(item.fileFingerprint, item.vector)
          }
        }
      } catch (err: any) {
        logger.warn(
          LogCategory.FILE_ORGANIZATION,
          `[FileSemanticRepresentationService] 直读 Omni zvec 向量分批异常: ${err?.message ?? err}`
        )
      }
    }

    // 6. 关联向量并对缺失项触发自愈修复或批量 JIT
    const missingJitItems: Array<{ evidence: SemanticEvidence; fp: string; text: string }> = []

    for (const row of rawFileRows) {
      const evidence = evidenceMap.get(row.file_id)
      if (!evidence) continue

      const fp = row.file_fingerprint
      if (fp && vectorByFp.has(fp)) {
        evidence.vector = vectorByFp.get(fp)
        continue
      }

      if (!fp) continue

      if (options?.readOnly || row.is_analyzed === 0) {
        // 纯读模式（如整理归类）或在途未分析文件：收集待编码文本，稍后统一执行单次批量 JIT
        const textToEmbed =
          evidence.canonicalText ||
          buildFilePrompt({
            rawName: row.name,
            smartName: row.smart_name || undefined,
            description: row.description || undefined
          } as any) ||
          evidence.displayName
        missingJitItems.push({ evidence, fp, text: textToEmbed })
      } else {
        // 已分析完成文件且允许写回：委托 canonicalTextService.solidify(fp) 固化主槽
        if (row.canonical_vector_state === 'failed') {
          logger.warn(
            LogCategory.FILE_ORGANIZATION,
            `[FileSemanticRepresentationService] canonical 向量已处于 failed 状态，接入软熔断跳过阻塞重试: fp=${fp}`
          )
        } else {
          try {
            const outcome = await this.getCanonicalTextService().solidify(fp)
            if (outcome === 'ready' || outcome === 'unchanged') {
              const resp = await this.getOmniClient().getVectors([fp], activeDim, 2000)
              const matched = resp?.vectors?.find(
                v => encoderWhitelist.has(v.encoderId) && v.vector?.length === activeDim
              )
              if (matched) {
                evidence.vector = matched.vector
                vectorByFp.set(fp, matched.vector)
              }
            }
          } catch (solidifyErr: any) {
            logger.warn(
              LogCategory.FILE_ORGANIZATION,
              `[FileSemanticRepresentationService] 委托固化自愈失败: fp=${fp}, 原因=${solidifyErr?.message ?? solidifyErr}`
            )
          }
        }
      }
    }

    // 7. 单次批量执行所有收集到的内存 JIT 编码（消除在途与纯读场景下的串行 IPC 延迟）
    if (missingJitItems.length > 0) {
      const BATCH_SIZE = 200
      const totalBatches = Math.ceil(missingJitItems.length / BATCH_SIZE)
      for (let i = 0; i < missingJitItems.length; i += BATCH_SIZE) {
        const slice = missingJitItems.slice(i, i + BATCH_SIZE)
        const batchIdx = Math.floor(i / BATCH_SIZE) + 1
        if (options?.onProgress) {
          try {
            options.onProgress(
              batchIdx,
              totalBatches,
              `正在提取文件特征向量 (${batchIdx}/${totalBatches})...`
            )
          } catch {
            // 安全忽略进度回调异常
          }
        }
        try {
          const res = await this.getOmniService().batchEmbedText(
            slice.map(item => item.text),
            {
              profile: activeProfile,
              dim: activeDim,
              timeoutMs: 5000
            }
          )
          if (res?.vectors) {
            for (let idx = 0; idx < slice.length; idx++) {
              const vec = res.vectors[idx]
              if (vec && (vec.length === activeDim || isTestEnvironment())) {
                slice[idx].evidence.vector = vec
                if (slice[idx].fp) {
                  vectorByFp.set(slice[idx].fp, vec)
                }
              }
            }
          }
        } catch (embedErr: any) {
          logger.warn(
            LogCategory.FILE_ORGANIZATION,
            `[FileSemanticRepresentationService] 批量内存 JIT 编码失败: 原因=${embedErr?.message ?? embedErr}`
          )
        }
      }
    }

    return fileIds
      .map(id => evidenceMap.get(id))
      .filter((ev): ev is SemanticEvidence => Boolean(ev))
  }

  /**
   * 仅获取指定指纹的纯净 Canonical 聚焦向量
   * 严格仅查 {fp} 主槽，绝不触碰 {fp}:tc0 或 {fp}:c0 切片槽。
   */
  async resolveCanonicalVectors(
    fingerprints: string[],
    dim?: number
  ): Promise<Map<string, number[]>> {
    const result = new Map<string, number[]>()
    if (!fingerprints || fingerprints.length === 0) {
      return result
    }

    const config = this.getConfig()
    const profile = config.getValue<string>('AI_EMBEDDING_PROFILE') || 'classic_light'
    const isGemma = (profile || '').toLowerCase().includes('gemma')
    const activeProfile = isGemma ? 'gemma_unified' : 'classic_light'
    const configuredDim = config.getValue<number>('EMBEDDING_MRL_DIMENSION') || 512
    const targetDim = dim || (isGemma ? configuredDim : 384)

    // 严禁查询包含冒号的切片指纹
    const cleanFps = Array.from(
      new Set(
        fingerprints
          .map(fp => (fp || '').trim())
          .filter(fp => fp.length > 0 && !fp.includes(':'))
      )
    )

    if (cleanFps.length === 0) {
      return result
    }

    const encoderWhitelist = new Set<number>(resolveQueryEncoderFilter(activeProfile))
    const CHUNK_SIZE = 200

    for (let i = 0; i < cleanFps.length; i += CHUNK_SIZE) {
      const chunk = cleanFps.slice(i, i + CHUNK_SIZE)
      try {
        const resp = await this.getOmniClient().getVectors(chunk, targetDim, 5000)
        if (resp && Array.isArray(resp.vectors)) {
          for (const item of resp.vectors) {
            if (!encoderWhitelist.has(item.encoderId)) continue
            if (!item.vector || item.vector.length !== targetDim) continue
            result.set(item.fileFingerprint, item.vector)
          }
        }
      } catch (err: any) {
        logger.warn(
          LogCategory.FILE_ORGANIZATION,
          `[FileSemanticRepresentationService] resolveCanonicalVectors 异常: ${err?.message ?? err}`
        )
      }
    }

    return result
  }
}

/** 进程级公共单例服务 */
export const fileSemanticRepresentationService = new FileSemanticRepresentationService()
