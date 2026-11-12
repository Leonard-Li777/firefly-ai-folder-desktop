/**
 * 端侧神经网络工作流语义向量匹配服务 (Stage B)
 * 依据 workflow-extension-ratio-and-semantic-vector-matching-spec.md §2.1, §2.3, §3.2
 *
 * 核心职责：
 * 1. 主进程端侧同源闭环，直读 ConfigDbManager 官方 70 套工作流及生效语言，自闭环计算 workflowsSignature；
 * 2. 仅向 OmniService.batchEmbedText 发起非阻塞批量向量计算（skipAutoStart: true，禁走 /api/text/analyze）；
 * 3. 1200ms 主进程贯穿中止保护与 Singleflight 在途去重防雪崩；
 * 4. 4 槽位官方工作流向量 LRU 缓存与双门禁解锁（rawCosine >= 0.65 && sigma >= 1e-4）+ tanh 软归一化。
 */

import crypto from 'crypto'
import type {
  LocalWorkflowRecord,
  WorkflowSemanticsScoreRequest,
  WorkflowSemanticsScoreResult
} from '@firefly/types'
import { logger, LogCategory, MODALITY_EXTS, canonicalizeExtensionToken } from '@firefly/shared'
import { ConfigDbManager } from '../config/config-db-manager'
import { OmniService } from '../system/omni-service'

interface OfficialVectorsCacheEntry {
  cacheKey: string
  signature: string
  effectiveLang: string
  profile: string
  dim: number
  vectorsById: Map<string, number[]>
  lastAccessed: number
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val))
}

function l2Norm(vec: number[]): number[] {
  let sumSq = 0
  for (let i = 0; i < vec.length; i++) {
    sumSq += vec[i] * vec[i]
  }
  const norm = Math.sqrt(sumSq)
  if (norm < 1e-12) {
    return new Array(vec.length).fill(0)
  }
  return vec.map(x => x / norm)
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
  }
  return clamp(dot, -1, 1)
}

function flattenDirectoryTree(node: any): string[] {
  if (!node) return []
  const texts: string[] = []
  if (Array.isArray(node)) {
    for (const item of node) {
      texts.push(...flattenDirectoryTree(item))
    }
    return texts
  }
  if (typeof node === 'object') {
    if (typeof node.name === 'string' && node.name.trim()) {
      texts.push(node.name.trim())
    }
    if (typeof node.description === 'string' && node.description.trim()) {
      texts.push(node.description.trim())
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        texts.push(...flattenDirectoryTree(child))
      }
    }
  }
  return texts
}

export class WorkflowSemanticMatcherService {
  private static instance: WorkflowSemanticMatcherService | null = null

  private readonly lruCache = new Map<string, OfficialVectorsCacheEntry>()
  private static readonly MAX_CACHE_ENTRIES = 4

  private readonly inflight = new Map<string, Promise<WorkflowSemanticsScoreResult>>()

  private constructor() {}

  public static getInstance(): WorkflowSemanticMatcherService {
    if (!WorkflowSemanticMatcherService.instance) {
      WorkflowSemanticMatcherService.instance = new WorkflowSemanticMatcherService()
    }
    return WorkflowSemanticMatcherService.instance
  }

  /**
   * 评分主入口：带入参防爆、Singleflight 在途去重、1200ms 超时与双门禁解锁
   */
  public async scoreWorkflowSemantics(
    req: WorkflowSemanticsScoreRequest
  ): Promise<WorkflowSemanticsScoreResult> {
    const startMs = Date.now()

    // 1. 入参防爆校验 (Spec §3.2.2)
    if (!this.validateRequest(req)) {
      logger.warn(
        LogCategory.SYSTEM,
        '[WorkflowSemanticMatcherService] 入参校验失败 (超限或非法格式)'
      )
      return {
        status: 'degraded',
        reason: 'invalid_input',
        durationMs: Date.now() - startMs
      }
    }

    // 2. Singleflight 在途去重
    const inflightKey = this.buildInflightKey(req)
    return this.runSingleflight(inflightKey, async () => {
      const abortController = new AbortController()
      const timer = setTimeout(() => {
        abortController.abort()
      }, 1200)

      try {
        const result = await this.doScore(req, abortController.signal, startMs)
        return result
      } catch (err: any) {
        const durationMs = Date.now() - startMs
        if (abortController.signal.aborted || err?.name === 'AbortError') {
          logger.warn(
            LogCategory.SYSTEM,
            `[WorkflowSemanticMatcherService] 1200ms 超时中止: ${err?.message}`
          )
          return { status: 'degraded', reason: 'timeout', durationMs }
        }
        if (err?.message === 'http_503') {
          logger.warn(LogCategory.SYSTEM, '[WorkflowSemanticMatcherService] 引擎 503 瞬态不可用')
          return { status: 'degraded', reason: 'http_503', durationMs }
        }
        if (err?.message === 'engine_not_ready') {
          logger.warn(LogCategory.SYSTEM, '[WorkflowSemanticMatcherService] 引擎尚未就绪')
          return { status: 'degraded', reason: 'engine_not_ready', durationMs }
        }
        logger.warn(
          LogCategory.SYSTEM,
          `[WorkflowSemanticMatcherService] 语义打分内部异常: ${err?.message}`
        )
        return { status: 'degraded', reason: 'internal_error', durationMs }
      } finally {
        clearTimeout(timer)
      }
    })
  }

  /**
   * 后台静默预热：仅在引擎活跃就绪且向导挂载时尝试预热官方向量缓存 (Spec §2.1)
   */
  public async tryPrewarm(): Promise<void> {
    const omni = OmniService.getInstance()
    if (!omni.isReady()) {
      return
    }
    try {
      const target = await omni.resolveEmbeddingTarget({ skipAutoStart: true })
      const configDb = ConfigDbManager.getInstance()
      const effectiveLang = configDb.getCurrentLanguage() || 'zh-CN'
      const officialWorkflows = configDb.getLocalWorkflows()
      if (officialWorkflows.length === 0) return

      const signature = this.computeWorkflowsSignature(officialWorkflows)
      const cacheKey = `${effectiveLang}:${signature}:${target.profile}:${target.dim}`
      if (this.lruCache.has(cacheKey)) {
        return
      }

      await this.getOrComputeOfficialVectors(
        officialWorkflows,
        signature,
        effectiveLang,
        target,
        undefined
      )
    } catch {
      // 预热静默降级
    }
  }

  private validateRequest(req: WorkflowSemanticsScoreRequest): boolean {
    if (!req || typeof req !== 'object') return false
    if (typeof req.dirPath !== 'string' || !req.dirPath.trim()) return false
    if (!req.countsByExt || typeof req.countsByExt !== 'object') return false

    const extKeys = Object.keys(req.countsByExt)
    if (extKeys.length > 64) return false

    if (Array.isArray(req.sampledFileNames)) {
      if (req.sampledFileNames.length > 24) return false
      for (const item of req.sampledFileNames) {
        if (!item || typeof item.stem !== 'string' || item.stem.length > 64) {
          return false
        }
        if (typeof item.count !== 'number' || !Number.isFinite(item.count) || item.count < 0) {
          return false
        }
      }
    }
    return true
  }

  private buildInflightKey(req: WorkflowSemanticsScoreRequest): string {
    const parts = [
      req.dirPath,
      JSON.stringify(req.countsByExt),
      JSON.stringify(req.sampledFileNames || [])
    ]
    return crypto.createHash('sha256').update(parts.join('|')).digest('hex')
  }

  private runSingleflight(
    key: string,
    factory: () => Promise<WorkflowSemanticsScoreResult>
  ): Promise<WorkflowSemanticsScoreResult> {
    const existing = this.inflight.get(key)
    if (existing) return existing
    const p = factory().finally(() => this.inflight.delete(key))
    this.inflight.set(key, p)
    return p
  }

  private async doScore(
    req: WorkflowSemanticsScoreRequest,
    signal: AbortSignal,
    startMs: number
  ): Promise<WorkflowSemanticsScoreResult> {
    const omni = OmniService.getInstance()
    const configDb = ConfigDbManager.getInstance()
    const effectiveLang = configDb.getCurrentLanguage() || 'zh-CN'

    // 1. 获取嵌入档位与维度
    const target = await omni.resolveEmbeddingTarget({ skipAutoStart: true })

    // 2. 读取并去重工作流：官方 70 套从 ConfigDbManager 读，合并 customWorkflows (DB 已有同名 ID 拒绝覆盖)
    const officialWorkflows = configDb.getLocalWorkflows()
    const officialIdSet = new Set(officialWorkflows.map(w => w.id))
    const customWorkflows = (req.customWorkflows || []).filter(w => !officialIdSet.has(w.id))

    // 3. 官方向量获取/计算 (LRU 缓存)
    const officialSignature = this.computeWorkflowsSignature(officialWorkflows)
    const officialVectorsMap = await this.getOrComputeOfficialVectors(
      officialWorkflows,
      officialSignature,
      effectiveLang,
      target,
      signal
    )

    // 4. 自定义工作流现算向量 (不存全局缓存)
    const allVectorsMap = new Map<string, number[]>(officialVectorsMap)
    if (customWorkflows.length > 0) {
      const customTexts = customWorkflows.map(w => this.buildWorkflowSemanticText(w))
      const customVectors = await this.embedInBatches(omni, customTexts, target, signal)
      for (let i = 0; i < customWorkflows.length; i++) {
        allVectorsMap.set(customWorkflows[i].id, l2Norm(customVectors[i]))
      }
    }

    // 5. 拼装目录画像文本与 Top 24 词干向量
    const summaryText = this.buildDirectorySummaryText(req, effectiveLang)
    const validStems = (req.sampledFileNames || []).filter(s => s.stem && s.stem.trim())

    if (!summaryText && validStems.length === 0) {
      return {
        status: 'degraded',
        reason: 'invalid_input',
        durationMs: Date.now() - startMs
      }
    }

    // 单批编码目录画像：[summaryText (若有), ...stems] (最多 1 + 24 = 25 条 <= 32)
    const textsToEmbed: string[] = []
    let hasSummary = false
    if (summaryText) {
      textsToEmbed.push(summaryText)
      hasSummary = true
    }
    for (const s of validStems) {
      textsToEmbed.push(s.stem.trim())
    }

    const dirBatchResult = await omni.batchEmbedText(textsToEmbed, {
      profile: target.profile,
      dim: target.dim,
      skipAutoStart: true,
      signal,
      timeoutMs: 1200
    })

    let vSummaryNorm: number[] | null = null
    let stemVectorsStartIndex = 0
    if (hasSummary) {
      vSummaryNorm = l2Norm(dirBatchResult.vectors[0])
      stemVectorsStartIndex = 1
    }

    let vDirNorm: number[]
    if (validStems.length === 0) {
      // 纯词干为空兜底：直接使用 summaryText 向量，返回 status: 'ok'
      logger.debug(
        LogCategory.SYSTEM,
        '[WorkflowSemanticMatcherService] names_pool_skipped (词干为空)'
      )
      vDirNorm = vSummaryNorm!
    } else {
      // 词干加权池化: w_i = 1 + ln(max(1, count_i))
      const stemVectors = dirBatchResult.vectors.slice(stemVectorsStartIndex)
      let totalWeight = 0
      const dim = target.dim
      const pooled = new Array(dim).fill(0)

      for (let i = 0; i < validStems.length; i++) {
        const count = Math.max(1, Math.floor(validStems[i].count))
        const w = 1 + Math.log(count)
        totalWeight += w
        const sVec = stemVectors[i]
        for (let d = 0; d < dim; d++) {
          pooled[d] += w * sVec[d]
        }
      }

      const vNamesNorm = totalWeight > 0 ? l2Norm(pooled.map(x => x / totalWeight)) : pooled

      if (!hasSummary) {
        vDirNorm = vNamesNorm
      } else {
        // 融合: L2Norm(0.45 * L2Norm(v_summary) + 0.55 * L2Norm(v_names))
        const fused = new Array(dim).fill(0)
        for (let d = 0; d < dim; d++) {
          fused[d] = 0.45 * vSummaryNorm![d] + 0.55 * vNamesNorm[d]
        }
        vDirNorm = l2Norm(fused)
      }
    }

    // 6. 余弦打分、方差计算与双门禁解锁 (Spec §2.2.2)
    const rawCosineByWorkflowId: Record<string, number> = {}
    const workflowIds = Array.from(allVectorsMap.keys())
    const cosines: number[] = []

    for (const wId of workflowIds) {
      const wVec = allVectorsMap.get(wId)!
      const cos = cosineSimilarity(vDirNorm, wVec)
      rawCosineByWorkflowId[wId] = cos
      cosines.push(cos)
    }

    const n = cosines.length
    let mean = 0
    for (let i = 0; i < n; i++) mean += cosines[i]
    mean = n > 0 ? mean / n : 0

    let varianceSum = 0
    for (let i = 0; i < n; i++) {
      const diff = cosines[i] - mean
      varianceSum += diff * diff
    }
    const sigma = n > 0 ? Math.sqrt(varianceSum / n) : 0

    const semanticScoresByWorkflowId: Record<string, number> = {}
    const unlockedWorkflowIds: string[] = []

    if (sigma < 1e-4 || n < 2) {
      // 总体方差过小或样本不足：全部置 0.5，零解锁
      for (const wId of workflowIds) {
        semanticScoresByWorkflowId[wId] = 0.5
      }
    } else {
      const denom = Math.max(sigma, 1e-4) * 1.5
      for (const wId of workflowIds) {
        const cos = rawCosineByWorkflowId[wId]
        const z = (cos - mean) / denom
        const sSem = clamp(0.5 + 0.5 * Math.tanh(z), 0, 1)
        semanticScoresByWorkflowId[wId] = Number(sSem.toFixed(4))

        // 解锁条件: cos >= 0.65 && sigma >= 1e-4
        if (cos >= 0.65) {
          unlockedWorkflowIds.push(wId)
        }
      }
    }

    return {
      status: 'ok',
      semanticScoresByWorkflowId,
      rawCosineByWorkflowId,
      batchSigma: Number(sigma.toFixed(5)),
      unlockedWorkflowIds,
      effectiveLang,
      durationMs: Date.now() - startMs
    }
  }

  private computeWorkflowsSignature(workflows: LocalWorkflowRecord[]): string {
    const sorted = [...workflows].sort((a, b) => a.id.localeCompare(b.id))
    const hashes: string[] = []
    for (const w of sorted) {
      const treeStr =
        typeof w.preset_directory_tree === 'string'
          ? w.preset_directory_tree
          : JSON.stringify(w.preset_directory_tree || null)
      const weightsStr = JSON.stringify(w.extensionWeights || null)
      const content = `${w.id}|${w.name}|${w.summary}|${w.persona || ''}|${treeStr}|${weightsStr}`
      hashes.push(crypto.createHash('sha256').update(content).digest('hex'))
    }
    return crypto.createHash('sha256').update(hashes.join('')).digest('hex')
  }

  private async getOrComputeOfficialVectors(
    workflows: LocalWorkflowRecord[],
    signature: string,
    effectiveLang: string,
    target: { profile: string; dim: number },
    signal?: AbortSignal
  ): Promise<Map<string, number[]>> {
    const cacheKey = `${effectiveLang}:${signature}:${target.profile}:${target.dim}`
    const existing = this.lruCache.get(cacheKey)
    if (existing) {
      existing.lastAccessed = Date.now()
      return existing.vectorsById
    }

    // 编码所有官方工作流 (分批 <= 32)
    const omni = OmniService.getInstance()
    const texts = workflows.map(w => this.buildWorkflowSemanticText(w))
    const rawVectors = await this.embedInBatches(omni, texts, target, signal)

    const vectorsById = new Map<string, number[]>()
    for (let i = 0; i < workflows.length; i++) {
      vectorsById.set(workflows[i].id, l2Norm(rawVectors[i]))
    }

    // 写入 LRU 缓存 (上限 4 条)
    if (this.lruCache.size >= WorkflowSemanticMatcherService.MAX_CACHE_ENTRIES) {
      let oldestKey: string | null = null
      let oldestTime = Infinity
      for (const [k, v] of this.lruCache.entries()) {
        if (v.lastAccessed < oldestTime) {
          oldestTime = v.lastAccessed
          oldestKey = k
        }
      }
      if (oldestKey) {
        this.lruCache.delete(oldestKey)
      }
    }

    this.lruCache.set(cacheKey, {
      cacheKey,
      signature,
      effectiveLang,
      profile: target.profile,
      dim: target.dim,
      vectorsById,
      lastAccessed: Date.now()
    })

    return vectorsById
  }

  private async embedInBatches(
    omni: OmniService,
    texts: string[],
    target: { profile: string; dim: number },
    signal?: AbortSignal
  ): Promise<number[][]> {
    const result: number[][] = []
    const BATCH_SIZE = 32
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const chunk = texts.slice(i, i + BATCH_SIZE)
      const res = await omni.batchEmbedText(chunk, {
        profile: target.profile,
        dim: target.dim,
        skipAutoStart: true,
        signal,
        timeoutMs: 1200
      })
      result.push(...res.vectors)
    }
    return result
  }

  private buildWorkflowSemanticText(w: {
    name: string
    summary?: string | null
    preset_directory_tree?: any
  }): string {
    const treeText = flattenDirectoryTree(w.preset_directory_tree).join('、')
    const parts = [w.name, w.summary || '']
    if (treeText) {
      parts.push(treeText)
    }
    return parts.filter(Boolean).join('。').slice(0, 1024)
  }

  private buildDirectorySummaryText(req: WorkflowSemanticsScoreRequest, lang: string): string {
    const dirName =
      req.directoryName || req.dirPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || ''

    // 统计前 5 模态占比
    const counts = req.countsByExt || {}
    let total = 0
    const modalityCounts: Record<string, number> = {}

    for (const [rawExt, count] of Object.entries(counts)) {
      if (typeof count !== 'number' || count <= 0) continue
      total += count
      const dotted = canonicalizeExtensionToken(rawExt, { withDot: true })
      let matchedMod: string | null = null
      for (const [mod, exts] of Object.entries(MODALITY_EXTS)) {
        if ((exts as readonly string[]).includes(dotted as any)) {
          matchedMod = mod
          break
        }
      }
      const finalMod = matchedMod || 'other'
      modalityCounts[finalMod] = (modalityCounts[finalMod] || 0) + count
    }

    const sortedMods = Object.entries(modalityCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)

    const modLabels = sortedMods.map(([m, c]) => {
      const pct = total > 0 ? Math.round((c / total) * 100) : 0
      return `${m}: ${pct}%`
    })

    const summaryParts: string[] = []
    if (dirName) {
      summaryParts.push(dirName)
    }
    if (modLabels.length > 0) {
      summaryParts.push(modLabels.join(', '))
    }
    return summaryParts.join(' - ').slice(0, 512)
  }
}
