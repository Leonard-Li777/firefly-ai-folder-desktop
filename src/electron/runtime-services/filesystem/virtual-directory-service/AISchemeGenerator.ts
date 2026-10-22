import {
  AIDirectoryStructure,
  DirectoryNode,
  FileInfoBase,
  VirtualDirectory,
  VirtualDirectoryFileInput,
  DirectoryReorganizeOptions,
  DirectoryReorganizeResult
} from '@firefly/types'
import {
  LogCategory,
  logger,
  DIMENSION_CODES,
  CANONICAL_NAMES,
  getCanonicalConceptName,
  isCandidateWordAdmissible,
  TagProvenanceGroup
} from '@firefly/shared'
import { sanitizeFolderName } from './utils'

const FILE_QUALITY_NAME = CANONICAL_NAMES.FILE_QUALITY
const DEFAULT_CLUSTER_FALLBACK_NAME = '其他' // locale-invariant-ok: 聚类默认目录名哨兵
/** HAC 聚类默认余弦距离切分阈值（规格 §4.3 IPC 契约） */
const HAC_DEFAULT_DISTANCE_THRESHOLD = 0.4
/** HAC 聚类默认叶簇文件数上限（规格 §4.3 IPC 契约） */
const HAC_DEFAULT_MAX_LEAF_SIZE = 50
/** EmbeddingGemma MRL 支持的弹性维度 */
const GEMMA_MRL_DIMS = new Set([256, 512, 768])
/**
 * 可参与聚类主题词与富文本嵌入的标签来源分组 (ADR-0045)。
 * fact/visual 承载文件类型、来源、分级、归档状态、画质等元数据事实，
 * 它们在同一批候选中往往全量出现（如 .lnk 文件的「lnk」「全年龄」），
 * 既不能区分语义簇，还会劫持目录命名并导致多簇路径碰撞。
 */
const HAC_SEMANTIC_TAG_GROUPS: ReadonlySet<TagProvenanceGroup> = new Set([
  'fused',
  'ai',
  'user'
])
import Database from 'better-sqlite3'
import path from 'node:path'
import { t } from '@app/languages'
import { databaseService } from '../../database/database-service'
// PRD-0044：本地模型身份真相 = 萤核AI引擎桥接快照
import { engineBridgeService } from '../../engine-bridge'
import { ConfigOrchestrator } from '../../../config/config-orchestrator'
import { DirectoryContextService } from '../directory-context-service'
import { unifiedModelManager } from '../../llama/unified-model-manager'
import { omniService, OmniClusterDocument } from '../../system/omni-service'
import { omniClient } from '../../../services/omni-client'
import { decompressJson, decompressText } from '../../../utils/text-compressor'
// Ticket 10 (Spec §4.9)：JIT 向量补全 60ms 软熔断与后台队列异步消费
// 注意：analysis-queue-service 依赖图极重（队列/AI服务/云同步 Worker），
// 缺省入队器在运行时动态导入（enqueueMissingVectorFiles），单测注入 mock 时零加载
import {
  runJitVectorCompletionGate,
  JIT_VECTOR_SYNC_BUDGET_MS,
  JIT_VECTOR_SYNC_MAX_FILES
} from './jit-vector-gate'
import type { EnqueueInput } from '../../analysis-queue-service/types'

/**
 * 判定文本是否含可参与语义嵌入的可见字符。
 *
 * NUL、控制字符、Unicode 替换符与纯空白都不构成有效正文：占位内容（如 `\0`）
 * 若被当作正文送入嵌入模型，会产出与任何主题都无关的垃圾向量并污染聚类。
 */
function hasVisibleText(text: string): boolean {
  for (const ch of text) {
    if (ch === '\uFFFD' || /\s/.test(ch) || /[\u0000-\u001F\u007F-\u009F]/.test(ch)) {
      continue
    }
    return true
  }
  return false
}

/** 兼容 BLOB（压缩文本）与历史明文 string 的可见文本判定 */
function contentHasVisibleText(content: unknown): boolean {
  if (content === null || content === undefined) return false
  const text =
    typeof content === 'string'
      ? content
      : Buffer.isBuffer(content)
        ? decompressText(content)
        : ''
  return hasVisibleText(text)
}

/** 剥掉智能命名模板骨架：扩展名、方括号前缀（如「[程序]」）、尾随自动日期 */
function stripNamingSkeleton(name: string): string {
  return path
    .parse(String(name || '').trim())
    .name.replace(/[\[【][^\]】]*[\]】]/g, ' ')
    .replace(/[_\-]?\d{4}[-_.]\d{1,2}[-_.]\d{1,2}\s*$/, '')
    .trim()
}

/**
 * 组装参与聚类语义嵌入的富文本（证据口径）。
 *
 * 智能命名由模板生成，方括号前缀、尾随日期与扩展名几乎人人相同；把这些格式骨架
 * 与文件名一起送入嵌入模型，会把全库两两余弦相似度垫到同一高位，约束层次聚类
 * 只能在合并高度上切出占据过半样本的巨型簇，表现为「任意提示词都只有一个目录」。
 * 主题词是已过受控准入门禁的真实语义证据，因此有主题词时富文本只由主题词构成；
 * 仅当一份文件拿不到任何主题词时，才回退到剥掉模板骨架后的文件名。
 * 注意：keywords 仍原样交给 Omni 作为目录命名池，本函数只收缩语义证据面。
 */
export function buildClusterEmbeddingText(input: {
  displayName: string
  rawName: string
  keywords: string[]
}): string {
  const { displayName, rawName, keywords } = input
  if (keywords.length > 0) return keywords.join(' ').trim()
  const primary = stripNamingSkeleton(displayName)
  const secondary = rawName !== displayName ? stripNamingSkeleton(rawName) : ''
  return [primary, secondary && secondary !== primary ? secondary : '']
    .filter(Boolean)
    .join(' ')
    .trim()
}

export interface AISchemeProvider {
  db: Database.Database
  createFromStrategy(
    workspaceId: number,
    name: string,
    strategy: string,
    source: string,
    icon?: string,
    perspective?: string
  ): Promise<VirtualDirectory>
  replaceFiles(virtualDirectoryId: number, files: VirtualDirectoryFileInput[]): Promise<void>
  get(id: number): Promise<VirtualDirectory | null>
  getDimensionGroups(options?: any, language?: string): Promise<any>
}

/** AISchemeGenerator 可注入选项（单测隔离 / 行为覆写） */
export interface AISchemeGeneratorOptions {
  /**
   * 缺失向量文件的后台队列入队器（Ticket 10）：
   * 缺省走 analysisQueueService.addItems(missingInputs, false) 低优先级静默消费；
   * 单测可注入 mock 断言入队参数。
   */
  analysisQueueEnqueuer?: (inputs: EnqueueInput[], forceReanalyze: boolean) => Promise<void>
  /** JIT 同步补全软预算（ms），缺省 60 */
  jitVectorBudgetMs?: number
  /** JIT 同步补全文件数配额，缺省 2 */
  jitVectorMaxSyncCount?: number
}

export class AISchemeGenerator {
  constructor(private provider: AISchemeProvider, private options?: AISchemeGeneratorOptions) {}

  /**
   * 基于端侧稠密向量与 Omni 约束层次聚类 (HAC) 生成目录整理方案 (Issue #633 / ADR-0056)
   * 纯 CPU 毫秒级运算，零显卡依赖、零 Token 消耗
   */
  async generateHACClusterScheme(
    workspaceId: number,
    selectedFileIds?: number[],
    userPrompt?: string,
    options?: {
      distanceThreshold?: number
      maxLeafSize?: number
      maxDepth?: number
      maxRootDirectories?: number
      maxSubdirectories?: number
      similarityThreshold?: number
      /** 仅测试/内部显式覆盖；缺省读取 ConfigOrchestrator 当前档位 */
      embeddingProfile?: string
      embeddingDim?: number
    }
  ): Promise<AIDirectoryStructure | null> {
    try {
      // 1. 获取工作区文件 (支持精确定位所选文件，避免大型工作区全表扫描)
      //    前置分析门禁：批量整理管线只接纳已完成 AI 语义分析的文件 (规格 §5.3)
      let targetRows: Array<{
        id: number
        path: string
        name: string
        file_fingerprint: string
        smart_name?: string
        content?: Buffer | string
        ocr?: Buffer | string
        asr?: Buffer | string
        lrc?: Buffer | string
        exif?: Buffer | string
        /** file_contents 行存在性：NULL 表示该文件无 AI 分析产物行，是未向量化强证据 (Ticket 10) */
        contents_fp?: string | null
      }>

      if (selectedFileIds && selectedFileIds.length > 0 && selectedFileIds.length <= 1000) {
        const placeholders = selectedFileIds.map(() => '?').join(',')
        targetRows = this.provider.db
          .prepare(`
            SELECT
              wf.id, wf.path, wf.name, wf.file_fingerprint,
              f.smart_name, fc.file_fingerprint AS contents_fp,
              fc.content, fc.ocr, fc.asr, fc.lrc, fc.exif
            FROM workspace_files wf
            JOIN files f ON wf.file_fingerprint = f.file_fingerprint
            LEFT JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint
            WHERE wf.workspace_id = ? AND wf.is_analyzed = 1 AND wf.id IN (${placeholders})
          `)
          .all(workspaceId, ...selectedFileIds) as any[]
      } else {
        const rows = this.provider.db
          .prepare(`
            SELECT
              wf.id, wf.path, wf.name, wf.file_fingerprint,
              f.smart_name, fc.file_fingerprint AS contents_fp,
              fc.content, fc.ocr, fc.asr, fc.lrc, fc.exif
            FROM workspace_files wf
            JOIN files f ON wf.file_fingerprint = f.file_fingerprint
            LEFT JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint
            WHERE wf.workspace_id = ? AND wf.is_analyzed = 1
          `)
          .all(workspaceId) as any[]
        const selectIdSet =
          selectedFileIds && selectedFileIds.length > 0
            ? new Set(selectedFileIds.map(id => String(id)))
            : null
        targetRows = selectIdSet ? rows.filter(r => selectIdSet.has(String(r.id))) : rows
      }

      if (targetRows.length === 0) {
        // 显式上报候选集为空的原因（禁止静默降级）：前端只能看到「未生成有效聚类」，
        // 若无此日志无法区分是工作区 ID 错配、选中文件未入库还是扫描范围问题
        logger.warn(
          LogCategory.FILE_ORGANIZATION,
          `[HAC智能聚类] 工作区 ${workspaceId} 候选文件行数为 0 (选中 fileIds=${selectedFileIds?.length ?? '全量'})，降级回传统方案`
        )
        return null
      }

      // 2. 批量聚合文件标签作为聚类关键词证据源 (ADR-0045 / ADR-0056)
      const fpTagMap = new Map<string, string[]>()
      const uniqueFps = Array.from(
        new Set(targetRows.map(r => r.file_fingerprint).filter(Boolean))
      )
      const chunkSize = 500
      for (let i = 0; i < uniqueFps.length; i += chunkSize) {
        const chunk = uniqueFps.slice(i, i + chunkSize)
        const placeholders = chunk.map(() => '?').join(',')
        try {
          const tagRows = this.provider.db
            .prepare(`
              SELECT ftr.file_fingerprint, COALESCE(ft.name, ftr.tag_code) as tag_name, ftr.name_path, ftr.tag_group
              FROM file_tag_relations ftr
              LEFT JOIN file_tags_private ft ON ft.code = ftr.tag_code
              WHERE ftr.file_fingerprint IN (${placeholders})
              ORDER BY ftr.file_fingerprint ASC, COALESCE(ftr.confidence, 0) DESC, ftr.tag_code ASC
            `)
            .all(...chunk) as Array<{
            file_fingerprint: string
            tag_name: string
            name_path: string
            tag_group: string
          }>

          for (const rel of tagRows) {
            // 元数据事实标签（文件类型/来源/分级/归档状态等）不得作为主题词或嵌入证据
            if (!HAC_SEMANTIC_TAG_GROUPS.has(rel.tag_group as TagProvenanceGroup)) {
              continue
            }
            let list = fpTagMap.get(rel.file_fingerprint)
            if (!list) {
              list = []
              fpTagMap.set(rel.file_fingerprint, list)
            }
            let name = rel.tag_name
            if (name && name.includes('.')) {
              name = getCanonicalConceptName(name) || (name.split('.').pop() || name)
            }
            if (name && isCandidateWordAdmissible(name).admissible && !list.includes(name)) {
              list.push(name)
            }
            if (rel.name_path) {
              const segs = rel.name_path.split('/').filter(Boolean)
              const leafSeg = segs[segs.length - 1]
              if (leafSeg && isCandidateWordAdmissible(leafSeg).admissible && !list.includes(leafSeg)) {
                list.push(leafSeg)
              }
            }
          }
        } catch (err) {
          logger.warn(LogCategory.FILE_ORGANIZATION, '[HAC智能聚类] 查询文件标签元数据失败:', err)
        }
      }

      // 兼顾兼容与单测：从 row.exif 中补充提取元数据关键词
      for (const row of targetRows) {
        if (!row.file_fingerprint) continue
        let list = fpTagMap.get(row.file_fingerprint)
        if (!list) {
          list = []
          fpTagMap.set(row.file_fingerprint, list)
        }
        if (row.exif) {
          try {
            let meta: any = null
            if (typeof row.exif === 'string') {
              try { meta = JSON.parse(row.exif) } catch {}
            }
            if (!meta) {
              try { meta = decompressJson<Record<string, any>>(row.exif) } catch {}
            }
            if (meta && Array.isArray(meta.keywords)) {
              for (const kw of meta.keywords) {
                if (typeof kw !== 'string') continue
                const trimmed = kw.trim()
                if (
                  trimmed &&
                  !list.includes(trimmed) &&
                  isCandidateWordAdmissible(trimmed).admissible
                ) {
                  list.push(trimmed)
                }
              }
            }
          } catch {}
        }
        // 仅当文件既无标签关系又无 exif 关键词时，以文件名/智能命名切词兜底
        if (list.length === 0) {
          const rawName = row.smart_name || row.name || ''
          const stem = path.parse(rawName).name
          // 模板化命名的方括号前缀（如 [程序]）与自动追加的日期都是格式元数据，
          // 直接参与命名会让所有文件坍缩到「程序/2026」这类无区分度目录
          const baseName = stem
            .replace(/[\[【][^\]】]*[\]】]/g, ' ')
            .replace(/[_\-]?\d{4}[-_.]\d{1,2}[-_.]\d{1,2}\s*$/, '')
            .trim()
          const tokens = baseName.split(/[\s_\-\.\(\)\[\]【】_—·，,]+/).filter(Boolean)
          for (const tok of tokens) {
            if (
              tok.length >= 2 &&
              tok.length <= 15 &&
              !/^\d+$/.test(tok) &&
              isCandidateWordAdmissible(tok).admissible &&
              !list.includes(tok)
            ) {
              list.push(tok)
            }
          }
          if (list.length === 0) {
            const fallbackToken = baseName.trim() || stem.trim() || rawName.trim()
            // 兜底词同样必须通过受控候选词准入门禁，杜绝机械噪音词进入目录命名池
            if (
              fallbackToken.length >= 2 &&
              fallbackToken.length <= 15 &&
              isCandidateWordAdmissible(fallbackToken).admissible
            ) {
              list.push(fallbackToken)
            }
          }
        }
      }

      // 收集文件指纹与关键词元数据 (ADR-0054：向量不再存于本地 SQLite exif，传 embedding: [] 由 Omni 进程内从 zvec 384d 槽位直读)
      const docs: OmniClusterDocument[] = []
      const fileMap = new Map<string, Array<{ id: number; name: string; path: string }>>()
      const seenFp = new Set<string>()

      for (const row of targetRows) {
        if (!row.file_fingerprint) continue
        const existing = fileMap.get(row.file_fingerprint) || []
        existing.push({
          id: row.id,
          name: row.smart_name || row.name,
          path: row.path
        })
        fileMap.set(row.file_fingerprint, existing)

        if (!seenFp.has(row.file_fingerprint)) {
          seenFp.add(row.file_fingerprint)
          const keywords = fpTagMap.get(row.file_fingerprint) || []
          const smartName = (row.smart_name || '').trim()
          const rawName = (row.name || '').trim()
          const displayName = smartName || rawName
          // 证据口径见 buildClusterEmbeddingText：主题词优先，杜绝模板骨架垫平相似度导致巨型簇坍缩
          const embeddingText = buildClusterEmbeddingText({ displayName, rawName, keywords })
          // 正文、OCR、ASR、歌词字幕任一含可见语义文本，说明分析产出的向量有内容依据，
          // 不得用文件名富文本替代；全部缺失时才标记为无效正文
          const hasSemanticText =
            contentHasVisibleText(row.content) ||
            contentHasVisibleText(row.ocr) ||
            contentHasVisibleText(row.asr) ||
            contentHasVisibleText(row.lrc)
          docs.push({
            fingerprint: row.file_fingerprint,
            embedding: [],
            keywords,
            embeddingText: embeddingText || undefined,
            // 仅当所有文本载体都无可见字符时，聚类改用富文本证据
            preferEmbeddingText: !hasSemanticText
          })
        }
      }

      // 如果去重后候选文档不足 2 份，无法形成有效聚类，返回 null 降级
      if (docs.length < 2) {
        logger.warn(
          LogCategory.FILE_ORGANIZATION,
          `[HAC智能聚类] 候选去重文档数(${docs.length})不足（总行数 ${targetRows.length}，缺 file_fingerprint 或重复指纹），平滑回退传统方案`
        )
        return null
      }

      // 2.1 向量直读与进程内自愈 (ADR-0054 / ADR-0056):
      // 传 embedding: [] 交由 Omni 端侧在进程内直接读取 zvec 槽位，未命中时由 Omni 原生 JIT 自愈，杜绝跨进程大批量文本嵌入的超时等待

      // 3. 调用 Omni 原生端侧 HAC 聚类
      // 注意：不传伪随机哈希向量作为 promptEmbedding，留空由 Omni 端按当前嵌入档位生成真实语义嵌入
      const config = ConfigOrchestrator.getInstance()
      const configuredProfile =
        options?.embeddingProfile ||
        config.getValue<string>('AI_EMBEDDING_PROFILE') ||
        'classic_light'
      const isGemma = configuredProfile.includes('gemma')
      const embeddingProfile = isGemma ? 'gemma_unified' : 'classic_light'
      const configuredDim = config.getValue<number>('EMBEDDING_MRL_DIMENSION') || 512
      const embeddingDim = isGemma
        ? options?.embeddingDim && GEMMA_MRL_DIMS.has(options.embeddingDim)
          ? options.embeddingDim
          : GEMMA_MRL_DIMS.has(configuredDim)
            ? configuredDim
            : 512
        : 384

      // ===== Ticket 10 (Spec §4.9)：JIT 向量补全 60ms 软熔断与后台队列异步消费 =====
      // 未向量化本地代理口径：桌面端无法直读 Omni zvec 槽位状态，而正常分析链路会在感知阶段
      // 同步写入 zvec 槽位与 file_contents 分析产物行（二者同生共死），因此「无 file_contents 行」
      // 的文件在 Omni 端聚类时必然触发进程内 JIT 串行编码，是单请求 3~6s 首屏卡顿的直接来源。
      const contentsReadyFps = new Set(
        targetRows.filter(r => r.contents_fp).map(r => r.file_fingerprint)
      )
      const missingVectorDocs = docs.filter(d => !contentsReadyFps.has(d.fingerprint))
      const jitGate = await runJitVectorCompletionGate({
        missingItems: missingVectorDocs,
        completeBatch: items =>
          this.completeMissingVectorEmbeddings(items, embeddingProfile, embeddingDim),
        budgetMs: this.options?.jitVectorBudgetMs ?? JIT_VECTOR_SYNC_BUDGET_MS,
        maxSyncCount: this.options?.jitVectorMaxSyncCount ?? JIT_VECTOR_SYNC_MAX_FILES
      })

      // 熔断显式上报（禁止静默降级，AGENTS.md §2.9）：熔断文件排除出本轮同步聚类请求，
      // 转 analysisQueueService 后台低优先级队列静默消费；后台补全完毕后由队列完成回调触发界面增量刷新
      if (jitGate.tripped) {
        logger.warn(
          LogCategory.FILE_ORGANIZATION,
          `[HAC智能聚类] JIT 向量补全触发软熔断 (reason=${jitGate.reason}, elapsed=${jitGate.elapsedMs}ms, missing=${missingVectorDocs.length}, deferred=${jitGate.deferred.length})，本轮聚类仅基于已就绪向量先行渲染，保证首屏 < 100ms`
        )
        await this.enqueueMissingVectorFiles(jitGate.deferred, workspaceId)
      }

      // 本轮实际参与聚类的文档：熔断时剔除未就绪文件（先行基于已有向量完成本轮聚类视图渲染）；
      // 配额内补全成功的文档已在 completeMissingVectorEmbeddings 中内联向量，Omni 端可跳过 JIT
      const clusterDocs = jitGate.tripped
        ? docs.filter(d => !jitGate.deferred.some(item => item.fingerprint === d.fingerprint))
        : docs

      if (clusterDocs.length < 2) {
        logger.warn(
          LogCategory.FILE_ORGANIZATION,
          `[HAC智能聚类] 剔除 JIT 熔断未就绪文件后有效文档数(${clusterDocs.length})不足 2 份，本轮聚类终止（缺失文件已入后台队列，补全完成后可再次触发聚类）`
        )
        return null
      }

      logger.info(
        LogCategory.FILE_ORGANIZATION,
        `[HAC智能聚类] 正在调用 Omni 端侧 HAC 聚类引擎: 文档数=${clusterDocs.length}, prompt=${userPrompt || 'none'}, profile=${embeddingProfile}, dim=${embeddingDim}, jitAdmitted=${jitGate.admitted.length}, jitDeferred=${jitGate.deferred.length}`
      )
      let distanceThreshold = options?.distanceThreshold ?? HAC_DEFAULT_DISTANCE_THRESHOLD
      if (options?.similarityThreshold !== undefined) {
        let sim = options.similarityThreshold
        if (sim > 1.0) sim /= 100
        distanceThreshold = Math.max(0.05, Math.min(0.95, 1.0 - sim))
      }

      const clusterRes = await omniService.clusterDocuments({
        documents: clusterDocs,
        prompt: userPrompt && userPrompt.trim() ? userPrompt.trim() : undefined,
        embeddingProfile,
        embeddingDim,
        distanceThreshold,
        maxLeafSize: options?.maxLeafSize ?? HAC_DEFAULT_MAX_LEAF_SIZE,
        maxDepth: options?.maxDepth,
        maxRootDirectories: options?.maxRootDirectories,
        maxSubdirectories: options?.maxSubdirectories
      })

      if (!clusterRes || !clusterRes.success || !clusterRes.result) {
        logger.warn(
          LogCategory.FILE_ORGANIZATION,
          `[HAC智能聚类] Omni 聚类接口调用未成功:`,
          clusterRes?.error
        )
        return null
      }

      const { clusters, otherFiles, durationMs } = clusterRes.result
      logger.info(
        LogCategory.FILE_ORGANIZATION,
        `[HAC智能聚类] 聚类计算成功: 生成簇数=${clusters.length}, 未归类=${otherFiles.length}, 耗时=${durationMs}ms`
      )

      // 4. 将 OmniClusterTreeResult 转换为系统统一的 AIDirectoryStructure
      // 目录命名已在 Omni Rust 端按规格 §5.1 的 tanh 饱和词频 + 提示词语义提振公式生成，
      // 此处仅做 Omni 返回「其他/空」时的确定性兜底，绝不再用纯文本重叠覆盖语义命名。
      const dirMap = new Map<string, any>()
      const usedLeafKeys = new Set<string>()

      for (const cluster of clusters) {
        // 统计簇内全部文件的关键词频次（仅用于空名兜底，Rust 端已完成正式打分）
        const kwFreq = new Map<string, number>()
        for (const fp of cluster.fingerprints) {
          const kws = fpTagMap.get(fp) || []
          for (const kw of new Set(kws)) {
            kwFreq.set(kw, (kwFreq.get(kw) || 0) + 1)
          }
        }

        const fallbackKeyword =
          Array.from(kwFreq.entries())
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ||
          DEFAULT_CLUSTER_FALLBACK_NAME

        const pathFromRust = (cluster.path || []).filter(Boolean)
        const hasMeaningfulPath =
          pathFromRust.length > 0 &&
          !pathFromRust.every(p => p === DEFAULT_CLUSTER_FALLBACK_NAME)
        const rustFolderName =
          cluster.folderName && cluster.folderName !== DEFAULT_CLUSTER_FALLBACK_NAME
            ? cluster.folderName
            : fallbackKeyword
        let clusterPath = hasMeaningfulPath ? pathFromRust : [rustFolderName]
        let leafKey = clusterPath.join('/')

        // 不同簇可能因共享主题词派生出同一路径；静默并入同一叶节点会吞掉聚类成果
        if (usedLeafKeys.has(leafKey)) {
          const parentPath = clusterPath.slice(0, -1)
          const baseLeaf = clusterPath[clusterPath.length - 1] || DEFAULT_CLUSTER_FALLBACK_NAME
          if (baseLeaf === DEFAULT_CLUSTER_FALLBACK_NAME) {
            // “其他”为受控长尾归并槽，允许多个簇并入同一 [parent, "其他"] 目录，不加序号
          } else {
            let ordinal = 2
            let candidateLeaf = `${baseLeaf} (${ordinal})`
            while (dirMap.has([...parentPath, candidateLeaf].join('/'))) {
              ordinal += 1
              candidateLeaf = `${baseLeaf} (${ordinal})`
            }
            const mergedPath = leafKey
            clusterPath = [...parentPath, candidateLeaf]
            leafKey = clusterPath.join('/')
            logger.warn(
              LogCategory.FILE_ORGANIZATION,
              `[HAC智能聚类] 多个簇派生出相同目录路径 "${mergedPath}"，已追加序号区分为 "${leafKey}"`
            )
          }
        }
        usedLeafKeys.add(leafKey)

        let currentParent = ''
        for (let i = 0; i < clusterPath.length; i++) {
          const dirName = clusterPath[i]
          const dirKey = clusterPath.slice(0, i + 1).join('/')
          if (!dirMap.has(dirKey)) {
            dirMap.set(dirKey, {
              id: dirKey,
              name: dirName,
              parent: currentParent,
              subdirectories: [],
              files: [],
              fileCount: 0
            })
          }
          currentParent = dirKey
        }

        const leafNode = dirMap.get(leafKey)!
        const filesInCluster: any[] = []

        for (const fp of cluster.fingerprints) {
          const fInfos = fileMap.get(fp)
          if (fInfos && fInfos.length > 0) {
            for (const fInfo of fInfos) {
              filesInCluster.push({
                id: fInfo.id,
                fileId: fInfo.id,
                name: fInfo.name,
                smartName: fInfo.name,
                path: fInfo.path,
                originalPath: fInfo.path
              })
            }
          }
        }
        leafNode.files = [...(leafNode.files || []), ...filesInCluster]
      }

      // 未归入主要聚类簇的文件，集中归入「其他文件」
      if (otherFiles && otherFiles.length > 0) {
        const otherFilesList: any[] = []
        for (const fp of otherFiles) {
          const fInfos = fileMap.get(fp)
          if (fInfos && fInfos.length > 0) {
            for (const fInfo of fInfos) {
              otherFilesList.push({
                id: fInfo.id,
                fileId: fInfo.id,
                name: fInfo.name,
                smartName: fInfo.name,
                path: fInfo.path,
                originalPath: fInfo.path
              })
            }
          }
        }
        if (otherFilesList.length > 0) {
          dirMap.set('__other__', {
            id: '__other__',
            name: t('其他文件'),
            parent: '',
            subdirectories: [],
            files: otherFilesList,
            fileCount: otherFilesList.length
          })
        }
      }

      // 5. 将 dirMap 扁平节点转换为标准的嵌套树结构 (Nested Tree) 并自底向上汇总文件数量
      const rootNodes: any[] = []
      for (const [key, node] of dirMap.entries()) {
        if (!node.parent) {
          rootNodes.push(node)
        } else {
          const parentNode = dirMap.get(node.parent)
          if (parentNode) {
            if (!parentNode.subdirectories) {
              parentNode.subdirectories = []
            }
            if (!parentNode.subdirectories.some((s: any) => s.id === node.id)) {
              parentNode.subdirectories.push(node)
            }
          } else {
            rootNodes.push(node)
          }
        }
      }

      const rollupCounts = (node: any): number => {
        let count = (node.files || []).length
        if (node.subdirectories && node.subdirectories.length > 0) {
          for (const sub of node.subdirectories) {
            count += rollupCounts(sub)
          }
        }
        node.fileCount = count
        return count
      }
      for (const root of rootNodes) {
        rollupCounts(root)
      }

      return {
        summary: t('端侧 HAC 智能聚类完成，共识别出 {count} 个主题目录 (耗时 {ms}ms)', {
          count: clusters.length,
          ms: durationMs || 0
        }),
        directories: rootNodes,
        isReadOnly: false
      }
    } catch (error) {
      logger.error(LogCategory.FILE_ORGANIZATION, '[HAC智能聚类] 执行异常:', error)
      return null
    }
  }

  /**
   * Ticket 10：缺失向量文件的同步 JIT 预补全（60ms 软预算内执行）。
   * 桌面端通过 batchEmbedText 先行编码并把向量内联进聚类文档，
   * Omni 端见到文档自带目标维度向量即跳过 zvec 未命中的进程内串行 JIT 编码。
   * 返回「确认完成补全」的文档子集：接口异常或向量缺失的文件不予确认，
   * 由调用方 runJitVectorCompletionGate 一律按熔断转后台队列处理。
   */
  private async completeMissingVectorEmbeddings(
    items: OmniClusterDocument[],
    embeddingProfile: string,
    embeddingDim: number
  ): Promise<OmniClusterDocument[]> {
    const texts = items.map(
      d => (d.embeddingText && d.embeddingText.trim()) || d.keywords.join(' ') || d.fingerprint
    )
    try {
      const resp = await omniService.batchEmbedText(texts, {
        profile: embeddingProfile,
        dim: embeddingDim,
        timeoutMs: 2000
      })
      const completed: OmniClusterDocument[] = []
      if (resp?.vectors) {
        for (let i = 0; i < items.length; i++) {
          const vec = resp.vectors[i]
          if (vec && vec.length > 0) {
            items[i].embedding = vec
            completed.push(items[i])
          }
        }
      }
      return completed
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn(
        LogCategory.FILE_ORGANIZATION,
        `[HAC智能聚类] 缺失向量同步预补全失败（${items.length} 项，转后台队列处理）: ${msg}`
      )
      return []
    }
  }

  /**
   * Ticket 10：将熔断未就绪文件排入后台低优先级分析队列静默消费。
   * addItems(inputs, false) 不强制重析，重复指纹由 queueManager 幂等去重；
   * 入队失败必须显式上报（禁止静默降级），但不阻断聚类主链路。
   * 入队明细按指纹点查 workspace_files/files 组装 EnqueueInput（path/name/size/type），
   * 不侵入主查询 SELECT（部分历史测试 schema 无 size/extension 列，保持向后兼容）。
   */
  private async enqueueMissingVectorFiles(
    deferredDocs: OmniClusterDocument[],
    workspaceId: number
  ): Promise<void> {
    try {
      const missingInputs: EnqueueInput[] = []
      for (const doc of deferredDocs) {
        const row = this.provider.db
          .prepare(
            `SELECT wf.path, wf.name, COALESCE(f.size, 0) AS size, COALESCE(f.extension, '') AS type
             FROM workspace_files wf
             JOIN files f ON wf.file_fingerprint = f.file_fingerprint
             WHERE wf.file_fingerprint = ? AND wf.workspace_id = ?
             LIMIT 1`
          )
          .get(doc.fingerprint, workspaceId) as
          | { path: string; name: string; size: number; type: string }
          | undefined
        if (!row) continue
        missingInputs.push({
          path: row.path,
          name: row.name,
          size: row.size ?? 0,
          type: row.type ?? ''
        })
      }
      if (missingInputs.length === 0) return
      const enqueuer =
        this.options?.analysisQueueEnqueuer ??
        (async (inputs: EnqueueInput[], forceReanalyze: boolean) => {
          const { analysisQueueService } = await import('../../analysis-queue-service/index')
          await analysisQueueService.addItems(inputs, forceReanalyze)
        })
      await enqueuer(missingInputs, false)
      logger.info(
        LogCategory.FILE_ORGANIZATION,
        `[HAC智能聚类] ${missingInputs.length} 个未向量化文件已排入后台低优先级分析队列静默消费 (forceReanalyze=false)`
      )
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn(
        LogCategory.FILE_ORGANIZATION,
        `[HAC智能聚类] 未向量化文件后台队列入队失败: ${msg}`
      )
    }
  }

  /**
   * 获取当前选中模型的 numPredict 值
   * 优先从模型 recommendedConfig 读取，云端模式或无模型时回退到默认值
   */
  private getNumPredict(): number {
    const config = ConfigOrchestrator.getInstance()
    const aiServiceMode = config.getValue<string>('AI_SERVICE_MODE')
    // PRD-0044：SELECTED_MODEL_ID/SOURCE 配置键删除，本地模型身份真相 = 萤核AI引擎桥接快照
    const selectedModelId =
      aiServiceMode === 'cloud'
        ? (config.getValue<string>('AI_CLOUD_SELECTED_MODEL_ID') as string)
        : (engineBridgeService.getSnapshot().model || '')

    if (selectedModelId) {
      let modelConfig = unifiedModelManager.getModelById(selectedModelId)
      if (!modelConfig) {
        const allModels = unifiedModelManager.getAllModels()
        modelConfig = allModels.find(m => m.id === selectedModelId || m.name === selectedModelId)
      }
      if (modelConfig?.recommendedConfig?.numPredict !== undefined) {
        return modelConfig.recommendedConfig.numPredict
      }
    }
    return 8192
  }

  /**
   * 从 AI 整理方案保存为虚拟目录
   */
  async saveFromPlan(
    workspaceId: number,
    name: string,
    structure: AIDirectoryStructure
  ): Promise<VirtualDirectory> {
    // 规格 §5.4：虚拟目录名与所有目录段落库/落盘前必须经过 Windows 路径安全清洗
    const safeVdirName = sanitizeFolderName(name, t('智能聚类整理'))
    const vd = await this.provider.createFromStrategy(
      workspaceId,
      safeVdirName,
      JSON.stringify({ summary: structure.summary }),
      'ai_skill'
    )

    const files: VirtualDirectoryFileInput[] = []
    const directoryPaths = new Map<string, string>()

    // 构建目录路径映射 (与 OrganizeRealDirectoryService 逻辑对齐，防环并统一正斜杠)
    const buildPath = (dirId: string, visited = new Set<string>()): string => {
      if (directoryPaths.has(dirId)) return directoryPaths.get(dirId)!
      if (visited.has(dirId)) return ''
      visited.add(dirId)
      const dir = structure.directories.find(d => (d.id || d.name) === dirId)
      if (!dir) return ''
      const parentPath = dir.parent ? buildPath(dir.parent, visited) : ''
      const safeDirName = sanitizeFolderName(dir.name || '', DEFAULT_CLUSTER_FALLBACK_NAME)
      const joined = parentPath ? `${parentPath}/${safeDirName}` : safeDirName
      const fullPath = joined.replace(/\\/g, '/').replace(/\/+/g, '/')
      directoryPaths.set(dirId, fullPath)
      return fullPath
    }

    for (const dir of structure.directories) {
      const relativeDirPath = buildPath(dir.id || dir.name)
      if (dir.files && Array.isArray(dir.files)) {
        for (const file of dir.files) {
          let fileId: number | undefined
          let fileName: string | undefined

          if (typeof file === 'object' && file && file.id) {
            fileId = file.id
            fileName = file.name || file.smartName || `file_${file.id}`
          } else if (typeof file === 'string') {
            const foundRow = this.provider.db
              .prepare('SELECT id, file_fingerprint FROM workspace_files WHERE workspace_id = ? AND (name = ? OR path LIKE ?) LIMIT 1')
              .get(workspaceId, file, `%/${file}`) as { id: number; file_fingerprint: string } | undefined
            if (foundRow) {
              fileId = foundRow.id
              fileName = file
            }
          }

          if (fileId) {
            const dbFile = this.provider.db
              .prepare('SELECT file_fingerprint FROM workspace_files WHERE id = ?')
              .get(fileId) as { file_fingerprint: string } | undefined
            if (dbFile) {
              const safeName = fileName || `file_${fileId}`
              const rawRel = relativeDirPath ? `${relativeDirPath}/${safeName}` : safeName
              files.push({
                fileId,
                fileFingerprint: dbFile.file_fingerprint,
                relativePath: rawRel.replace(/\\/g, '/').replace(/\/+/g, '/')
              })
            }
          }
        }
      }
    }

    await this.provider.replaceFiles(vd.id, files)
    return vd
  }

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
    const state = await import('../../../main/state')

    let activeDirectoryContextService = state.directoryContextService
    if (!activeDirectoryContextService && state.globalLlamaIndexService) {
      activeDirectoryContextService = new DirectoryContextService(state.globalLlamaIndexService)
      if (typeof state.setDirectoryContextService === 'function') {
        state.setDirectoryContextService(activeDirectoryContextService)
      }
      logger.info(
        LogCategory.FILE_ORGANIZATION,
        'generateNameAndStrategyCandidates 自动修复：自愈绑定 directoryContextService 成功'
      )
    }

    const directoryAnalyzer = activeDirectoryContextService?.getDirectoryAnalyzer()

    // Gathering stats for analyzer
    const allFiles = await databaseService.getFilesByWorkspaceId(workspaceId)
    // 如果提供了 selectedFileIds，仅使用勾选文件的数据构建提示词
    const selectIdSet =
      selectedFileIds && selectedFileIds.length > 0
        ? new Set(selectedFileIds.map(id => String(id)))
        : null
    const files = selectIdSet ? allFiles.filter(f => selectIdSet.has(String(f.id))) : allFiles

    const fileTypeDistribution: Record<string, number> = {}
    const sampleFileNames: string[] = []
    // 随机抽取最多 20 个文件名作为样本，避免以篇概全
    files.forEach(f => {
      const ext = path.extname(f.path).toLowerCase()
      fileTypeDistribution[ext] = (fileTypeDistribution[ext] || 0) + 1
    })
    const shuffledFiles = [...files].sort(() => 0.5 - Math.random())
    shuffledFiles.slice(0, 20).forEach(f => {
      sampleFileNames.push(f.smart_name || path.basename(f.path))
    })

    logger.info(LogCategory.FILE_ORGANIZATION, 'DEBUG generateNameAndStrategyCandidates stats:', {
      hasDirectoryContextService: !!activeDirectoryContextService,
      hasDirectoryAnalyzer: !!directoryAnalyzer,
      filesCount: files.length,
      workspaceId
    })

    if (!directoryAnalyzer) return { candidates: [] }

    // 获取维度标签树信息
    let dimensionTree: any[] = []
    let workspaceDir: any = null
    let skeletonTags: string[] = []
    try {
      workspaceDir = await databaseService.getWorkspaceDirectoryById(workspaceId)
      logger.info(LogCategory.FILE_ORGANIZATION, '获取维度标签:', {
        workspaceId,
        workspaceDirPath: workspaceDir?.path,
        hasProviderDimensionGroups: typeof this.provider.getDimensionGroups === 'function'
      })
      if (workspaceDir && workspaceDir.path && typeof this.provider.getDimensionGroups === 'function') {
        const response = await this.provider.getDimensionGroups(workspaceDir.path)
        const groups = response?.groups || []

        // 如果限制了文件选择，查询这些文件实际拥有的标签，用于过滤维度标签树
        let selectedFileTagSet: Set<string> | null = null
        if (selectIdSet && selectIdSet.size > 0) {
          const fpRows = this.provider.db
            .prepare(
              'SELECT file_fingerprint FROM workspace_files WHERE id IN (' +
                [...selectIdSet].map(() => '?').join(',') +
                ')'
            )
            .all(...[...selectIdSet]) as Array<{ file_fingerprint: string }>
          if (fpRows.length > 0) {
            const fps = fpRows.map(r => r.file_fingerprint)
            const tagRows = this.provider.db
              .prepare(
                'SELECT DISTINCT COALESCE(ft.name, ftr.tag_code) as name FROM file_tag_relations ftr LEFT JOIN file_tags_private ft ON ft.code = ftr.tag_code WHERE ftr.file_fingerprint IN (' +
                  fps.map(() => '?').join(',') +
                  ')'
              )
              .all(...fps) as Array<{ name: string }>
            selectedFileTagSet = new Set(
              tagRows.map(r => {
                if (r.name && r.name.includes('.')) {
                  return getCanonicalConceptName(r.name) || (r.name.split('.').pop() || r.name)
                }
                return r.name
              })
            )
          }
        }

        logger.info(LogCategory.FILE_ORGANIZATION, '维度标签结果:', {
          groupsCount: groups.length,
          tagsCount: groups.reduce((sum: number, g: any) => sum + (g.tags?.length || 0), 0),
          selectedFileTagSet: selectedFileTagSet?.size
        })
        // 过滤掉文件计数为0的标签，只保留有实际文件的标签；如有限制则只保留已勾选文件拥有的标签
        const tagFilter = (tag: any) => {
          if ((tag.fileCount || 0) <= 0) return false
          if (selectedFileTagSet && !selectedFileTagSet.has(tag.tagValue)) return false
          return true
        }
        dimensionTree = groups
          .map((g: any) => ({
            d: g.name,
            t: (g.tags || [])
              .filter(tagFilter)
              .slice(0, 10)
              .map((tag: any) => ({
                v: tag.tagValue,
                c: tag.fileCount || 0
              }))
          }))
          .filter((g: any) => g.t.length > 0)

        // 计算快速整理模式下的骨架高频标签
        const totalFiles = files.length
        let n = Math.round(Math.sqrt(totalFiles))
        if (totalFiles <= 15) n = 2
        n = Math.min(30, Math.max(2, n))
        const x = Math.max(1, Math.round(n * 0.25))
        const skeletonCount = Math.max(n - x, 1)

        const allTags: Array<{ name: string; fileCount: number }> = []
        for (const g of groups) {
          if (
            (g.code && (g.code === DIMENSION_CODES.DOCUMENT_QUALITY || g.code === DIMENSION_CODES.FILE_QUALITY)) ||
            g.name === FILE_QUALITY_NAME ||
            g.name?.toLowerCase() === 'quality' ||
            String(g.id) === 'file_quality' ||
            String(g.id) === 'quality'
          ) {
            continue
          }
          if (g.tags) {
            for (const t of g.tags) {
              if (t.tagValue && (t.fileCount || 0) > 0) {
                if (selectedFileTagSet && !selectedFileTagSet.has(t.tagValue)) continue
                allTags.push({
                  name: t.tagValue,
                  fileCount: t.fileCount
                })
              }
            }
          }
        }
        const sortedTags = allTags.sort((a, b) => b.fileCount - a.fileCount)
        skeletonTags = sortedTags.slice(0, skeletonCount).map(t => t.name)
      } else {
        logger.warn(LogCategory.FILE_ORGANIZATION, '获取维度标签失败:', {
          workspaceDir: !!workspaceDir,
          workspaceDirPath: workspaceDir?.path,
          hasProviderDimensionGroups: typeof this.provider.getDimensionGroups === 'function',
          workspaceId
        })
      }
    } catch (e) {
      logger.error(LogCategory.FILE_ORGANIZATION, '获取维度标签异常:', e)
    }

    // 构建 fileTypeDistribution 字符串，使用 Markdown 表格
    let fileTypeStr = ''
    const fileTypeEntries = Object.entries(fileTypeDistribution)
    if (fileTypeEntries.length > 0) {
      const rows = fileTypeEntries.map(([ext, count]) => `| ${ext} | ${count} |`)
      fileTypeStr = '| 文件扩展名 | 文件数量 |\n| --- | --- |\n' + rows.join('\n')
    }

    // 构建维度标签树字符串，使用 Markdown 表格
    let dimensionTreeStr = ''
    if (dimensionTree.length > 0) {
      const rows: string[] = []
      for (const group of dimensionTree) {
        const dimName = group.d
        for (const tag of group.t || []) {
          rows.push(`| ${dimName} | ${tag.v} | ${tag.c} |`)
        }
      }
      if (rows.length > 0) {
        dimensionTreeStr = '| 维度 | 标签 | 文件数量 |\n| --- | --- | --- |\n' + rows.join('\n')
      }
    }

    const numPredict = this.getNumPredict()
    const isLimitPredict = numPredict <= 2048
    const finalCount = isLimitPredict ? 1 : count

    const config = ConfigOrchestrator.getInstance()
    const appLanguage = (config.getValue<string>('DEFAULT_LANGUAGE') as any) || 'zh-CN'

    const candidates = await directoryAnalyzer.analyzeForVirtualDirectoryNameCandidates(
      {
        directoryPath: workspaceDir?.path || 'Workspace',
        fileTypeDistribution: fileTypeStr as any,
        namingPatterns: [],
        languageDetected: [],
        specialFiles: [],
        fileStructure: sampleFileNames,
        dimensionTree: dimensionTreeStr,
        userHint,
        organizeMode,
        skeletonTags,
        isLimitPredict
      },
      appLanguage,
      finalCount
    )

    return candidates
  }

  async checkIsLimitPredict(): Promise<boolean> {
    const numPredict = this.getNumPredict()
    return numPredict <= 2048
  }

  async reorganize(
    virtualDirectoryId: number,
    options: DirectoryReorganizeOptions
  ): Promise<DirectoryReorganizeResult> {
    const { coreEngine } = await import('../../../main/state')
    if (!coreEngine) throw new Error(t('核心引擎未初始化，请等待初始化完成后再试'))

    const { filesToOrganize, vd } = await this.prepareReorganizeData(
      virtualDirectoryId,
      options,
      virtualDirectoryId > 0
    )

    const result = await (coreEngine as any).directoryReorganizeService.reorganize({
      ...options,
      files: filesToOrganize,
      previousNameAndStrategy: vd ? { name: vd.name, strategy: vd.strategy } : undefined
    })

    return result
  }

  /**
   * 估算整理所需的总批次（与后端实际整理上报的 totalSteps 保持一致，不调用 AI 推理）。
   * 供整理开始前判断是否超过批次告警阈值，避免前端预估（按全部文件数）与实际批次数不一致。
   * 注意：估算阶段即使 virtualDirectoryId 为 0 也会回填标签文件，以便得到真实的骨架直出预分配数量。
   */
  async estimateReorganizeBatches(
    virtualDirectoryId: number,
    options: DirectoryReorganizeOptions
  ): Promise<number> {
    const { coreEngine } = await import('../../../main/state')
    if (!coreEngine) throw new Error(t('核心引擎未初始化，请等待初始化完成后再试'))

    const { filesToOrganize } = await this.prepareReorganizeData(virtualDirectoryId, options, true)

    return (coreEngine as any).directoryReorganizeService.estimateReorganizeBatches({
      ...options,
      files: filesToOrganize
    })
  }

  /**
   * 整理前数据准备：收集待整理文件列表，并按需将文件按标签回填到 selectedTagsTree 的骨架节点上。
   * @param backfillFiles 是否回填标签文件。正式整理与批次估算需要回填（true），预览模式不应回填（false）
   */
  private async prepareReorganizeData(
    virtualDirectoryId: number,
    options: DirectoryReorganizeOptions,
    backfillFiles: boolean
  ): Promise<{ filesToOrganize?: Array<{ id: number; name: string }>; vd: any }> {
    let filesToOrganize: Array<{ id: number; name: string }> | undefined

    // 收集文件列表
    if (options.isRescue && options.files && options.files.length > 0) {
      filesToOrganize = options.files
      logger.info(
        LogCategory.FILE_ORGANIZATION,
        '补救整理批次，直接使用前端传入的待分类文件列表:',
        {
          filesCount: filesToOrganize.length
        }
      )
    } else if (options.selectedFileIds && options.selectedFileIds.length > 0) {
      const placeholders = options.selectedFileIds.map(() => '?').join(',')
      const dbFiles = this.provider.db
        .prepare(
          `
          SELECT wf.id, f.smart_name as name
          FROM workspace_files wf
                 JOIN files f ON wf.file_fingerprint = f.file_fingerprint
          WHERE wf.id IN (${placeholders})
        `
        )
        .all(...options.selectedFileIds) as any[]
      filesToOrganize = dbFiles.map(f => ({ id: f.id, name: f.name }))
    } else if (options.workspaceDirectoryPath) {
      // 预览模式：从工作目录获取所有已分析文件
      const workspaceDir = await databaseService.getWorkspaceDirectoryByPath(
        options.workspaceDirectoryPath
      )
      if (workspaceDir && workspaceDir.id) {
        const allFiles = await databaseService.getFilesByWorkspaceId(workspaceDir.id)
        const analyzedFiles = allFiles.filter(f => f.is_analyzed === 1)
        filesToOrganize = analyzedFiles.map(f => ({
          id: f.id,
          name: f.smart_name || f.name || f.path.split(/[\\/]/).pop() || ''
        }))
        logger.info(LogCategory.FILE_ORGANIZATION, '预览模式获取文件:', {
          totalFiles: allFiles.length,
          analyzedFiles: analyzedFiles.length,
          filesToSend: filesToOrganize.length
        })
      }
    }

    // 预览模式：virtualDirectoryId = 0 时跳过VD查询
    let vd: any = null
    if (virtualDirectoryId > 0) {
      vd = await this.provider.get(virtualDirectoryId)
    }

    // 正式整理或补救整理时（backfillFiles 为 true），由于前端传进来的 selectedTagsTree 各节点的 files 数组通常为空，
    // 我们在此通过查询数据库标签，将 filesToOrganize 中的文件回填到对应的骨架标签节点上，
    // 从而保证底层 fastOrganize 的骨架直出（优先按已有标签自动归类，不经由 AI 分类）逻辑能够正常生效。
    // 在预览模式下（backfillFiles 为 false），我们不应回填文件，以保证只显示目录结构。
    if (
      backfillFiles &&
      options.selectedTagsTree &&
      Array.isArray(options.selectedTagsTree) &&
      filesToOrganize &&
      filesToOrganize.length > 0
    ) {
      const fileIds = filesToOrganize.map(f => f.id)
      const fileTagMap = new Map<number, string[]>()
      const batchSize = 500
      for (let i = 0; i < fileIds.length; i += batchSize) {
        const batchIds = fileIds.slice(i, i + batchSize)
        const placeholders = batchIds.map(() => '?').join(',')
        try {
          const relations = this.provider.db
            .prepare(
              `
              SELECT wf.id as file_id, COALESCE(ft.name, ftr.tag_code) as tag_name
              FROM file_tag_relations ftr
                     LEFT JOIN file_tags_private ft ON ft.code = ftr.tag_code
                     JOIN workspace_files wf ON wf.file_fingerprint = ftr.file_fingerprint
              WHERE wf.id IN (${placeholders})
            `
            )
            .all(...batchIds) as Array<{ file_id: number; tag_name: string }>

          for (const rel of relations) {
            if (!fileTagMap.has(rel.file_id)) {
              fileTagMap.set(rel.file_id, [])
            }
            let name = rel.tag_name
            if (name && name.includes('.')) {
              name = getCanonicalConceptName(name) || (name.split('.').pop() || name)
            }
            fileTagMap.get(rel.file_id)!.push(name)
          }
        } catch (err) {
          logger.error(LogCategory.FILE_ORGANIZATION, '回填标签树文件时查询数据库失败:', err)
        }
      }

      const backfillTree = (nodes: any[]) => {
        for (const node of nodes) {
          if (!node.name) continue

          if (!node.files) {
            node.files = []
          }

          for (const file of filesToOrganize!) {
            const fileTags = fileTagMap.get(file.id) || []
            if (fileTags.includes(node.name)) {
              const exists = node.files.some((f: any) => String(f.id) === String(file.id))
              if (!exists) {
                node.files.push({
                  id: String(file.id),
                  name: file.name
                })
              }
            }
          }

          if (node.subdirectories && node.subdirectories.length > 0) {
            backfillTree(node.subdirectories)
          }
        }
      }

      backfillTree(options.selectedTagsTree)
      logger.info(
        LogCategory.FILE_ORGANIZATION,
        '回填标签树文件成功，已将符合标签的文件关联到骨架节点中'
      )
    }

    return { filesToOrganize, vd }
  }
}
