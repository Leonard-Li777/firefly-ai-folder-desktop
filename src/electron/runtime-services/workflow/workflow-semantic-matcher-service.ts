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
  private readonly officialPrewarmInflight = new Map<string, Promise<Map<string, number[]>>>()

  private constructor() {}

  public static getInstance(): WorkflowSemanticMatcherService {
    if (!WorkflowSemanticMatcherService.instance) {
      WorkflowSemanticMatcherService.instance = new WorkflowSemanticMatcherService()
    }
    return WorkflowSemanticMatcherService.instance
  }

  /**
   * 评分主入口：带入参防爆、Singleflight 在途去重、分级超时（热路径 1200ms / 冷启动全量官方向量 4500ms）与双门禁解锁
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
      // 若全量官方工作流(>=16套)尚无缓存（首次冷启动需编码 70 套），放宽单次等待至 4500ms；热路径保持 1200ms 极速熔断
      const officialCount = ConfigDbManager.getInstance().getLocalWorkflows().length
      const hasAnyOfficialCache = this.lruCache.size > 0
      const timeoutBudgetMs = officialCount >= 16 && !hasAnyOfficialCache ? 4500 : 1200

      const abortController = new AbortController()
      const timer = setTimeout(() => {
        abortController.abort()
      }, timeoutBudgetMs)

      try {
        const result = await this.doScore(req, abortController.signal, startMs, timeoutBudgetMs)
        return result
      } catch (err: any) {
        const durationMs = Date.now() - startMs
        if (abortController.signal.aborted || err?.name === 'AbortError') {
          logger.warn(
            LogCategory.SYSTEM,
            `[WorkflowSemanticMatcherService] ${timeoutBudgetMs}ms 超时中止: ${err?.message}`
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
    if (Array.isArray(req.sampledSubDirNames)) {
      if (req.sampledSubDirNames.length > 16) return false
      for (const name of req.sampledSubDirNames) {
        if (typeof name !== 'string' || name.length > 64) {
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
      JSON.stringify(req.sampledFileNames || []),
      JSON.stringify(req.sampledSubDirNames || [])
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
    startMs: number,
    timeoutBudgetMs: number
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

    // 3. 官方向量获取/计算 (LRU 缓存 + 后台独立 Singleflight 预热防中止清零)
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
      const customVectors = await this.embedInBatches(
        omni,
        customTexts,
        target,
        signal,
        timeoutBudgetMs
      )
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
      timeoutMs: timeoutBudgetMs
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
      // 引入有效标准差下限 0.045，防止无主题杂乱目录在各向异性向量空间中因低方差放大随机噪声（Small-Variance Z-Score Explosion）
      const effectiveSigma = Math.max(sigma, 0.045)
      const denom = effectiveSigma * 1.2
      // 解锁所需绝对超额余弦下限：至少同时高于均值 1.5*sigma 与 0.06 绝对间隔
      const unlockThreshold = mean + Math.max(1.5 * sigma, 0.06)
      for (const wId of workflowIds) {
        const cos = rawCosineByWorkflowId[wId]
        const z = (cos - mean) / denom
        const sSem = clamp(0.5 + 0.5 * Math.tanh(z), 0, 1)
        semanticScoresByWorkflowId[wId] = Number(sSem.toFixed(4))

        // 统计显著性严密解锁门禁：绝对余弦 >= 0.52 且同时高出均值 max(1.5*sigma, 0.06)
        if (cos >= 0.52 && cos >= unlockThreshold) {
          unlockedWorkflowIds.push(wId)
        }
      }
    }

    const durationMs = Date.now() - startMs
    const top3Preview = [...workflowIds]
      .sort((a, b) => (rawCosineByWorkflowId[b] ?? 0) - (rawCosineByWorkflowId[a] ?? 0))
      .slice(0, 3)
      .map(id => `${id}=${(rawCosineByWorkflowId[id] ?? 0).toFixed(3)}`)
      .join(', ')
    logger.info(
      LogCategory.SYSTEM,
      `[WorkflowSemanticMatcherService] 语义打分完成 (${durationMs}ms, mean=${mean.toFixed(3)}, sigma=${sigma.toFixed(4)}, unlocked=${unlockedWorkflowIds.length}): top3=[${top3Preview}]`
    )

    return {
      status: 'ok',
      semanticScoresByWorkflowId,
      rawCosineByWorkflowId,
      batchSigma: Number(sigma.toFixed(5)),
      unlockedWorkflowIds,
      effectiveLang,
      durationMs
    }
  }

  private raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise
    if (signal.aborted) {
      const abortErr = new Error('The operation was aborted')
      abortErr.name = 'AbortError'
      return Promise.reject(abortErr)
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        const abortErr = new Error('The operation was aborted')
        abortErr.name = 'AbortError'
        reject(abortErr)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      promise.then(
        val => {
          signal.removeEventListener('abort', onAbort)
          resolve(val)
        },
        err => {
          signal.removeEventListener('abort', onAbort)
          reject(err)
        }
      )
    })
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

    // 生产全量工作流 (>=16套) 采用独立后台 Singleflight 计算与 15s 批超时，
    // 即使某次前台请求因超时提前降级，后台仍会算完并落盘至 lruCache，彻底根治冷启动反复超时死循环
    const isFullOfficialCatalog = workflows.length >= 16
    if (isFullOfficialCatalog) {
      let prewarmTask = this.officialPrewarmInflight.get(cacheKey)
      if (!prewarmTask) {
        const omni = OmniService.getInstance()
        const texts = workflows.map(w => this.buildWorkflowSemanticText(w))
        prewarmTask = this.embedInBatches(omni, texts, target, undefined, 15000)
          .then(rawVectors => {
            const vectorsById = new Map<string, number[]>()
            for (let i = 0; i < workflows.length; i++) {
              vectorsById.set(workflows[i].id, l2Norm(rawVectors[i]))
            }
            this.putOfficialVectorsCache(cacheKey, signature, effectiveLang, target, vectorsById)
            logger.info(
              LogCategory.SYSTEM,
              `[WorkflowSemanticMatcherService] 官方向量缓存预热完成 (${workflows.length} 套, profile=${target.profile}, dim=${target.dim})`
            )
            return vectorsById
          })
          .finally(() => {
            this.officialPrewarmInflight.delete(cacheKey)
          })
        // 挂载静默 catch 防止前台提前超时后出现未捕获拒绝
        prewarmTask.catch(() => {})
        this.officialPrewarmInflight.set(cacheKey, prewarmTask)
      }
      return this.raceWithAbort(prewarmTask, signal)
    }

    // 小型/测试工作流集透传前台 signal，便于快速物理中止
    const omni = OmniService.getInstance()
    const texts = workflows.map(w => this.buildWorkflowSemanticText(w))
    const rawVectors = await this.embedInBatches(omni, texts, target, signal, 1200)

    const vectorsById = new Map<string, number[]>()
    for (let i = 0; i < workflows.length; i++) {
      vectorsById.set(workflows[i].id, l2Norm(rawVectors[i]))
    }

    this.putOfficialVectorsCache(cacheKey, signature, effectiveLang, target, vectorsById)
    return vectorsById
  }

  private putOfficialVectorsCache(
    cacheKey: string,
    signature: string,
    effectiveLang: string,
    target: { profile: string; dim: number },
    vectorsById: Map<string, number[]>
  ): void {
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
  }

  private async embedInBatches(
    omni: OmniService,
    texts: string[],
    target: { profile: string; dim: number },
    signal?: AbortSignal,
    timeoutMs: number = 1200
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
        timeoutMs
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

    // 提取顶层子目录名（最多 12 个），辅助还原多项目/多模块目录的整体业务主题
    const validSubDirs = (req.sampledSubDirNames || [])
      .filter(s => typeof s === 'string' && s.trim())
      .map(s => s.trim())
      .slice(0, 12)

    // 提取 Top 16 词干，防止超长尾部噪声干扰自注意力窗口
    const validStems = (req.sampledFileNames || [])
      .filter(s => s && typeof s.stem === 'string' && s.stem.trim())
      .map(s => s.stem.trim())
      .slice(0, 16)

    const parts: string[] = []
    if (dirName) {
      parts.push(`工作目录：${dirName}`)
    }
    if (validSubDirs.length > 0) {
      parts.push(`包含的子目录有：${validSubDirs.join('、')}`)
    }
    if (validStems.length > 0) {
      parts.push(`包含的主要文件有：${validStems.join('、')}`)
    }
    return parts.join('。').slice(0, 512)
  }
}
