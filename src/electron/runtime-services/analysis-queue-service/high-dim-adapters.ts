/**
 * high-dim-adapters.ts — Stage 5 高维修正的默认外部适配器（Issue 0046 §5）
 *
 * 提供默认实现，把「WeMM 2048d 嵌入生成」「高维标签二次打分」「5W 名称/描述二次提纯」
 * 「zvec 向量入库」四个外部依赖收敛到此处，使 HighDimCorrectionService 保持可注入、可 Mock。
 *
 * 1. WeMMEmbedder：经 firefly-ai-engine 的 OpenAI 兼容 `/v1/embeddings` 端点计算 2048d 向量；
 * 2. WemmTagScorer：取受控标签展示名（Omni `/api/v1/taxonomy/aliases`，进程级缓存），
 *    用 WeMM 2048d 余弦相似度对候选短语二次打分；
 * 3. OmniFiveWRefiner：经 Omni `/api/text/analyze`（5W 插槽引擎）二次提纯名称与描述；
 * 4. ZvecVectorSink：经 Omni 的 `/api/v1/vector/upsert` 写入 RaBitQ + INT8 量化的 zvec 向量库。
 */

import { LogCategory, logger } from '@firefly/shared'
import { engineBridgeService } from '../engine-bridge'
import { omniService } from '../system/omni-service'
import { WEMM_EMBEDDING_DIM, WEMM_EMBEDDING_PORT } from '@app/shared/constants/high-dim-correction'
import type {
  WemmEmbedder,
  HighDimVectorSink,
  HighDimTagScorer,
  HighDimNameRefiner
} from './high-dim-correction-service'
import type { HighDimTagCandidate } from './high-dim-correction'

/** 单次嵌入请求超时（毫秒） */
const EMBED_TIMEOUT_MS = 30_000
/** 向量入库请求超时（毫秒） */
const UPSERT_TIMEOUT_MS = 15_000
/** 标签展示名与 5W 提纯请求超时（毫秒） */
const OMNI_TIMEOUT_MS = 20_000
/** 短语嵌入进程级缓存上限（避免多文件批量修正时重复推理） */
const PHRASE_CACHE_MAX = 4096

/**
 * 解析 WeMM 嵌入服务基址。
 *
 * 运行时优先复用 Tier 2 引擎（firefly-ai-engine）已绑定的实际端口（38400 段滑动）：
 * 引擎把 `/v1/*` 透明反代给其托管的 llama-server，故嵌入请求与对话共用同一端点。
 * 引擎离线时回退到规范声明的固定端口 `WEMM_EMBEDDING_PORT`。
 *
 * 已知缺口（见 ADR-0046「已知缺口」）：引擎侧尚未提供「以 `--embeddings` 加载
 * WeMM-Embedding 2B」的启动模式，因此 `/v1/embeddings` 只有在用户自行把引擎切到
 * 嵌入模型时才可用；否则请求会失败并抛错（Stage 5 任务转 failed，不影响普通分析）。
 */
function resolveWemmBaseUrl(): string {
  try {
    const snapshot = engineBridgeService.getSnapshot()
    if (snapshot?.port) return `http://127.0.0.1:${snapshot.port}`
  } catch {
    // 引擎桥接未初始化时静默回退
  }
  return `http://127.0.0.1:${WEMM_EMBEDDING_PORT}`
}

/** 默认 WeMM 嵌入器：调用引擎 `/v1/embeddings` 计算 2048d 稠密向量 */
export function createWemmEmbedder(modelId?: string): WemmEmbedder {
  return {
    async embed(text: string, signal?: AbortSignal): Promise<number[]> {
      const baseUrl = resolveWemmBaseUrl()
      const res = await fetch(`${baseUrl}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: text, model: modelId ?? 'wemm-embedding-2b' }),
        signal: signal ?? AbortSignal.timeout(EMBED_TIMEOUT_MS)
      })
      if (!res.ok) {
        throw new Error(`[高维修正] WeMM 嵌入请求失败: HTTP ${res.status}`)
      }
      const json = (await res.json()) as {
        data?: Array<{ embedding?: number[] }>
        embedding?: number[]
      }
      const vector = json.data?.[0]?.embedding ?? json.embedding
      if (!Array.isArray(vector)) {
        throw new Error('[高维修正] WeMM 嵌入响应缺少向量字段')
      }
      if (vector.length !== WEMM_EMBEDDING_DIM) {
        logger.warn(
          LogCategory.SYSTEM,
          `[高维修正] WeMM 向量维度为 ${vector.length}，与预期的 ${WEMM_EMBEDDING_DIM} 不一致`
        )
      }
      return vector
    }
  }
}

/** 默认 zvec 向量入库器：调用 Omni `/api/v1/vector/upsert` 持久化 2048d 向量 */
export function createZvecVectorSink(): HighDimVectorSink {
  return {
    async upsert(fileFingerprint: string, vector: number[]): Promise<void> {
      const baseUrl = omniService.getBaseUrl()
      const res = await fetch(`${baseUrl}/api/v1/vector/upsert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [{ file_fingerprint: fileFingerprint, vector }]
        }),
        signal: AbortSignal.timeout(UPSERT_TIMEOUT_MS)
      })
      if (!res.ok) {
        throw new Error(`[高维修正] zvec 向量入库失败: HTTP ${res.status}`)
      }
    }
  }
}

/** 余弦相似度（双方范数为 0 时返回 0，避免 NaN 污染置信度） */
export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na <= 1e-12 || nb <= 1e-12) return 0
  return dot / Math.sqrt(na * nb)
}

/** 受控标签 code → 当前语言规范展示名（进程级缓存，跨文件复用） */
const aliasLemmaCache = new Map<string, string>()
/** 候选短语 → 2048d 向量（进程级缓存，避免多文件批量修正时重复推理） */
const phraseVectorCache = new Map<string, number[]>()

/** 清空进程级缓存（仅供单测隔离使用） */
export function resetHighDimAdapterCaches(): void {
  aliasLemmaCache.clear()
  phraseVectorCache.clear()
}

/** 从 Omni 拉取指定 code 的规范展示名；失败返回空映射（上层降级为「不产出候选」） */
async function fetchCanonicalLemmas(codes: string[]): Promise<Map<string, string>> {
  const missing = codes.filter(c => !aliasLemmaCache.has(c))
  if (missing.length === 0) {
    return new Map(codes.map(c => [c, aliasLemmaCache.get(c) as string]))
  }
  try {
    const baseUrl = omniService.getBaseUrl()
    const url = `${baseUrl}/api/v1/taxonomy/aliases?codes=${encodeURIComponent(missing.join(','))}`
    const res = await fetch(url, { signal: AbortSignal.timeout(OMNI_TIMEOUT_MS) })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }
    const rows = (await res.json()) as Array<{
      tag_code?: string
      tagCode?: string
      lemma?: string
      is_canonical?: number
      isCanonical?: number
    }>
    for (const row of rows || []) {
      const code = row.tag_code ?? row.tagCode
      const lemma = row.lemma
      if (!code || !lemma) continue
      const isCanonical = (row.is_canonical ?? row.isCanonical ?? 0) === 1
      // 规范名优先；已存在规范名时不被非规范别名覆盖
      const prev = aliasLemmaCache.get(code)
      if (!prev || isCanonical) {
        aliasLemmaCache.set(code, lemma)
      }
    }
  } catch (e) {
    logger.warn(LogCategory.ANALYSIS_QUEUE, '[高维修正] 拉取标签展示名失败，本次不产出高维候选:', e)
  }
  return new Map(
    codes.filter(c => aliasLemmaCache.has(c)).map(c => [c, aliasLemmaCache.get(c) as string])
  )
}

/** 计算候选短语的 2048d 向量（带进程级缓存；失败返回 null 由调用方跳过该候选） */
async function embedPhraseCached(
  embedder: WemmEmbedder,
  phrase: string
): Promise<number[] | null> {
  const cached = phraseVectorCache.get(phrase)
  if (cached) return cached
  try {
    const vec = await embedder.embed(phrase)
    if (!Array.isArray(vec) || vec.length !== WEMM_EMBEDDING_DIM) return null
    if (phraseVectorCache.size >= PHRASE_CACHE_MAX) phraseVectorCache.clear()
    phraseVectorCache.set(phrase, vec)
    return vec
  } catch (e) {
    logger.warn(LogCategory.ANALYSIS_QUEUE, `[高维修正] 候选短语嵌入失败，跳过: ${phrase}`, e)
    return null
  }
}

/**
 * 默认高维标签打分器（Issue 0046 §5 §2：以 2048 维向量计算候选短语与全文的余弦相似度）。
 *
 * 候选集 = Stage 3 现有受控标签 ∪ 它们的父级标签（受控标签树的局部邻域）：
 * 全量受控标签有上万条，逐条嵌入不可行；而「修正/补齐」的语义本就限定在已有标签的邻域内。
 * 打分结果交给 `fuseHighDimTags` 做阈值去噪与同键取高置信合并——因此
 * **未能被 2048d 模型复核到阈值的既有标签会被剔除**（正是「噪点标签被剔除」的落点）。
 *
 * 展示名经 Omni `/api/v1/taxonomy/aliases` 获取并缓存；任一环节失败都返回空数组，
 * 上层据此跳过标签变更（绝不把「打分失败」当成「标签是噪点」）。
 */
export function createWemmTagScorer(embedder: WemmEmbedder): HighDimTagScorer {
  return {
    async score(
      _text: string,
      vector: number[],
      existingTags: HighDimTagCandidate[]
    ): Promise<HighDimTagCandidate[]> {
      if (!Array.isArray(vector) || vector.length !== WEMM_EMBEDDING_DIM) return []
      if (!existingTags || existingTags.length === 0) return []

      const codes = new Set<string>()
      for (const tag of existingTags) {
        if (tag?.code) codes.add(tag.code)
        if (tag?.parentCode) codes.add(tag.parentCode)
      }
      const lemmas = await fetchCanonicalLemmas([...codes])
      if (lemmas.size === 0) return []

      const scored: HighDimTagCandidate[] = []
      for (const tag of existingTags) {
        const lemma = lemmas.get(tag.code)
        if (!lemma) continue
        const phraseVec = await embedPhraseCached(embedder, lemma)
        if (!phraseVec) continue
        scored.push({
          code: tag.code,
          parentCode: tag.parentCode ?? '',
          confidence: Math.max(0, Math.min(1, cosineSimilarity(vector, phraseVec)))
        })
      }
      return scored
    }
  }
}

/**
 * 默认 5W 名称/描述二次提纯器（Issue 0046 §5 §3）。
 *
 * 调用 Omni `/api/text/analyze`（5W 槽位插槽引擎），以高维精修后的标签与事实
 * 重新生成智能名称与一句话描述。**调用方已保证仅在机器命名时调用**。
 * 失败时抛错，由 `HighDimCorrectionService` 降级为「本次不更新名称/描述」。
 */
export function createOmniFiveWRefiner(): HighDimNameRefiner {
  return {
    async refine(input: {
      facts: string
      tags: Array<{ code: string; parentCode: string; confidence: number }>
      fileName: string
    }): Promise<{ smartName?: string | null; description?: string | null }> {
      const baseUrl = omniService.getBaseUrl()
      // 标签以「展示名 + 置信度」注入事实文本，供插槽引擎按主题聚类填充 5W 槽位
      const tagHint = input.tags
        .map(t => `${t.code}(${t.confidence.toFixed(2)})`)
        .join(' ')
      const text = tagHint ? `${input.facts}\n[tags] ${tagHint}` : input.facts

      const res = await fetch(`${baseUrl}/api/text/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, file_name: input.fileName || null }),
        signal: AbortSignal.timeout(OMNI_TIMEOUT_MS)
      })
      if (!res.ok) {
        throw new Error(`[高维修正] 5W 提纯请求失败: HTTP ${res.status}`)
      }
      const json = (await res.json()) as {
        smart_name?: string | null
        smartName?: string | null
        one_sentence_desc?: string | null
        oneSentenceDesc?: string | null
      }
      return {
        smartName: json.smart_name ?? json.smartName ?? null,
        description: json.one_sentence_desc ?? json.oneSentenceDesc ?? null
      }
    }
  }
}
