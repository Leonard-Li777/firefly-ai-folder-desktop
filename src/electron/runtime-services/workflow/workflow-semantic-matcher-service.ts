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
import path from 'path'
import type {
  LocalWorkflowRecord,
  WorkflowSemanticsScoreRequest,
  WorkflowSemanticsScoreResult
} from '@firefly/types'
import { logger, LogCategory, stripTrailingSlash } from '@firefly/shared'
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
  if (typeof node === 'string') {
    try {
      const parsed = JSON.parse(node)
      return flattenDirectoryTree(parsed)
    } catch {
      return [node.trim()].filter(Boolean)
    }
  }
  const texts: string[] = []
  if (Array.isArray(node)) {
    for (const item of node) {
      texts.push(...flattenDirectoryTree(item))
    }
    return texts
  }
  if (typeof node === 'object') {
    // 仅剔除后随分隔符的纯数字标号或括号标号，严格保护 "3D" / "4K" / "2D" 等业务前缀
    if (typeof node.name === 'string' && node.name.trim()) {
      const cleanName = node.name
        .replace(/^\s*(?:[\(（]\s*\d+(?:[.\-_]\d+)*\s*[\)）]|\d+(?:[.\-_]\d+)*[\s\-_.、]+)/, '')
        .trim()
      if (cleanName) {
        texts.push(cleanName)
      }
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
        if (
          err?.message === 'http_503' ||
          err?.message?.startsWith('http_503') ||
          err?.message?.includes('http_503') ||
          err?.code === 'HTTP_503' ||
          err?.code === 'AEAD_DECRYPT_FAILED' ||
          (err as any)?.status === 503
        ) {
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

    // 5. 拼装目录文本并单次整句自注意力编码 (彻底消除均值池化向心坍缩)
    const dirText = this.buildDirectorySemanticText(req)
    if (!dirText.trim()) {
      return {
        status: 'degraded',
        reason: 'invalid_input',
        durationMs: Date.now() - startMs
      }
    }

    const dirBatchResult = await omni.batchEmbedText([dirText], {
      profile: target.profile,
      dim: target.dim,
      skipAutoStart: true,
      signal,
      timeoutMs: 1200
    })
    const vDirNorm = l2Norm(dirBatchResult.vectors[0])

    // 6. 余弦打分、方差计算与双门禁解锁 (Spec §3.3)
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
      // 分母收紧为 1.2，增强中段敏感度
      const denom = Math.max(sigma, 1e-4) * 1.2
      for (const wId of workflowIds) {
        const cos = rawCosineByWorkflowId[wId]
        const z = (cos - mean) / denom
        const sSem = clamp(0.5 + 0.5 * Math.tanh(z), 0, 1)
        semanticScoresByWorkflowId[wId] = Number(sSem.toFixed(4))

        // 统计显著性严密解锁门禁：绝对余弦 >= 0.52 且高出均值 1.5 个标准差 (仅允许顶层约 6.7%)
        if (cos >= 0.52 && cos >= mean + 1.5 * sigma) {
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
    const treeItems = flattenDirectoryTree(w.preset_directory_tree)
    const treeText = treeItems.length > 0 ? `目录结构包含：${treeItems.join('、')}` : ''
    const parts = [w.name, w.summary || '', treeText].filter(Boolean)
    return parts.join('。').slice(0, 1024)
  }

  private buildDirectorySemanticText(req: WorkflowSemanticsScoreRequest): string {
    const cleanPath = stripTrailingSlash(req.dirPath || '')
    // 过滤 Windows 盘符（如 "C:"），提取末尾双级路径作为高密度上下文，优先级高于单级 directoryName
    const segments = cleanPath.split(/[/\\]/).filter(Boolean)
    const realSegments = segments.filter(s => !/^[a-zA-Z]:$/.test(s))
    const dualLevelPath =
      realSegments.length >= 2 ? realSegments.slice(-2).join(' / ') : realSegments[0] || ''
    const dirName =
      dualLevelPath || req.directoryName || path.basename(cleanPath) || cleanPath || ''

    // 提取 Top 16 词干，防止超长尾部噪声干扰自注意力窗口
    const validStems = (req.sampledFileNames || [])
      .filter(s => s && typeof s.stem === 'string' && s.stem.trim())
      .map(s => s.stem.trim())
      .slice(0, 16)

    const parts: string[] = []
    if (dirName) {
      parts.push(`工作目录：${dirName}`)
    }
    if (validStems.length > 0) {
      parts.push(`包含的主要文件有：${validStems.join('、')}`)
    }
    return parts.join('。').slice(0, 512)
  }
}
