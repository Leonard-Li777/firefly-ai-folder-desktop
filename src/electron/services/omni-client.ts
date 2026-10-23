/**
 * Omni 服务化客户端 SDK（ADR-0038 / PRD #679 / Issue #682）
 * apps/desktop/src/electron/services/omni-client.ts
 *
 * 职责：
 * 1. 消费 Omni 暴露的高阶业务 HTTP API（taxonomy / vector）
 * 2. 屏蔽 Desktop 对 OMW 底层 SQLite 与 file_vectors 堆表的直接依赖
 * 3. 供主库语言分表 tag_aliases_{lang} 初值补录、虚拟目录渲染与分析向量链路统一调用
 *    （TaxonomyAliasCache 内存总线已按主设计废除，展示别名一律分表直查）
 */

import { LogCategory, logger } from '@firefly/shared'
import { omniService } from '../runtime-services/system/omni-service'

/** 分类树多叉树节点（对齐 Omni taxonomy.rs TaxonomyNode） */
export interface OmniTaxonomyNode {
  code: string
  name: string
  parentCode?: string | null
  parentCodes: string[]
  source: string
  sortOrder: number
  fileCount?: number
  files?: string[]
  codePath?: string
  namePath?: string
  depth?: number
  children: OmniTaxonomyNode[]
}

/** 分类树响应 */
export interface OmniTaxonomyTreeResponse {
  locale: string
  rootNodes: OmniTaxonomyNode[]
  totalNodes: number
}

/** 多语言别名单行（对齐 Rust TagAliasRow：snake_case；is_canonical 为 INTEGER 0/1） */
export interface OmniTagAliasRow {
  tag_code: string
  lemma: string
  is_canonical: number
  n: number
  count: number
}

/** 多语言别名响应：Vec<TagAliasRow>（对齐 Rust Vec<TagAliasRow>，Slice 7） */
export type OmniTaxonomyAliasesResponse = OmniTagAliasRow[]

/**
 * zvec v3 编码器身份（对齐 apps/omni/crates/omni-core/src/lib.rs `pub mod encoder_id`
 * 与方案 §3.5）：0=Unknown/Legacy, 1=Bekko, 2=ChineseCLIP, 3=MobileCLIP, 4=Gemma。
 * 写入时必须携带向量真实出处，禁止按档位或界面语言猜测。
 */
export const ENCODER_ID = {
  UNKNOWN: 0,
  BEKKO: 1,
  CHINESE_CLIP: 2,
  MOBILE_CLIP: 3,
  GEMMA: 4
} as const

/**
 * 查询侧编码器白名单（方案 §3.5 查询通路表，与引擎 `encoder_id::CLASSIC_384_ALLOWED` 对齐）：
 * classic_light 384 槽只有 Bekko，放行 UNKNOWN 仅为 v2 旧记录过渡。
 */
export const ENCODER_FILTER_CLASSIC_384: readonly number[] = [ENCODER_ID.UNKNOWN, ENCODER_ID.BEKKO]

/**
 * 查询侧编码器白名单：gemma_unified 的 256/512/768 槽。
 * 512 槽与 classic CLIP 共用，v2 记录无法区分编码器，故严格只放行 GEMMA。
 */
export const ENCODER_FILTER_GEMMA: readonly number[] = [ENCODER_ID.GEMMA]

/** 预留：CLIP 文本通道（工单 12），只与 ChineseCLIP 图像塔配对，当前无调用点 */
export const ENCODER_FILTER_CHINESE_CLIP: readonly number[] = [ENCODER_ID.CHINESE_CLIP]

/** 预留：MobileCLIP 诊断（非 zh 界面不启用检索），当前全仓无调用点 */
export const ENCODER_FILTER_MOBILE_CLIP: readonly number[] = [ENCODER_ID.MOBILE_CLIP]

/**
 * 按当前生效嵌入档位解析查询白名单：classic_light → [0, 1]；gemma_unified → [4]。
 * 不提供「缺省不过滤」语义：档位缺失或未知时按 classic_light 处理。
 */
export function resolveQueryEncoderFilter(profile: string | null | undefined): number[] {
  return (profile || '').toLowerCase().includes('gemma')
    ? [...ENCODER_FILTER_GEMMA]
    : [...ENCODER_FILTER_CLASSIC_384]
}

/** 向量写入条目 */
export interface OmniVectorUpsertItem {
  fileFingerprint: string
  vector: number[]
  /** zvec v3 编码器身份（ENCODER_ID），必填：缺失即被 Omni 以 400 encoder_id_required 拒绝 */
  encoderId: number
}

export interface OmniVectorUpsertResponse {
  success: boolean
  count: number
  error?: string
}

export interface OmniVectorMatchItem {
  fileFingerprint: string
  score: number
  rank: number
  /** 命中记录的 zvec v3 编码器身份 */
  encoderId: number
}

export interface OmniVectorSearchResponse {
  matches: OmniVectorMatchItem[]
  durationUs: number
  count: number
  error?: string
}

export interface OmniVectorDeleteResponse {
  success: boolean
  deletedCount: number
  error?: string
}

export interface OmniVectorGetItem {
  fileFingerprint: string
  vector: number[]
  /** 该向量落盘时携带的 zvec v3 编码器身份，供探活/白名单判定 */
  encoderId: number
}

export interface OmniVectorGetResponse {
  vectors: OmniVectorGetItem[]
  count: number
  error?: string
}

/** 真实目录快速文件名检索命中项 */
export interface OmniSearchFsItem {
  path: string
  name: string
  fileFingerprint?: string | null
  isAnalyzed?: boolean
}

/** 真实目录快速文件名检索响应 */
export interface OmniSearchFsResponse {
  items: OmniSearchFsItem[]
  count: number
  durationMs: number
}

/** 段落级语义对齐请求项 */
export interface OmniMatchPassagesItem {
  fileFingerprint: string
  passages: string[]
}

/** 段落级语义对齐匹配结果 */
export interface OmniPassageMatch {
  fileFingerprint: string
  bestPassageIndex: number
  bestPassage: string
  similarity: number
}

/** 段落级语义对齐响应 */
export interface OmniMatchPassagesResponse {
  matches: OmniPassageMatch[]
  durationMs: number
}

const DEFAULT_TIMEOUT_MS = 8000

/**
 * OmniClient：Desktop 侧对 Omni 语义/向量 HTTP 契约的唯一入口
 */
export class OmniClient {
  private static instance: OmniClient

  static getInstance(): OmniClient {
    if (!OmniClient.instance) {
      OmniClient.instance = new OmniClient()
    }
    return OmniClient.instance
  }

  /** 解析当前 Omni 服务基址（随 omni-service 端口探测同步） */
  getBaseUrl(): string {
    return omniService.getBaseUrl()
  }

  private static readonly TAXONOMY_CACHE_TTL = 10_000 // 10秒TTL（防组件多重挂载并发重复请求，同时保证文件分析入库后敏捷刷新）
  private _taxonomyTreeCache = new Map<string, { data: OmniTaxonomyTreeResponse; time: number }>()
  private _inFlightTaxonomyTree = new Map<string, Promise<OmniTaxonomyTreeResponse | null>>()

  private async request<T>(
    path: string,
    init?: RequestInit,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
    retries: number = 2
  ): Promise<T | null> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await omniService.ensureRunning()
        const res = await fetch(`${this.getBaseUrl()}${path}`, {
          ...init,
          headers: {
            'Content-Type': 'application/json',
            ...(init?.headers ?? {})
          },
          signal: AbortSignal.timeout(timeoutMs)
        })
        if (!res.ok) {
          logger.warn(LogCategory.DIMENSION_SERVICE, `[OmniClient] HTTP ${res.status} ${path} (第 ${attempt + 1}/${retries + 1} 次尝试)`)
          if (attempt < retries) {
            await new Promise(r => setTimeout(r, 400 * (attempt + 1)))
            continue
          }
          return null
        }
        return (await res.json()) as T
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.debug(LogCategory.DIMENSION_SERVICE, `[OmniClient] 请求失败 ${path} (第 ${attempt + 1}/${retries + 1} 次尝试):`, msg)
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 400 * (attempt + 1)))
          continue
        }
        return null
      }
    }
    return null
  }

  /** 清除分类树内存缓存（文件分析入库后或强制刷新时调用） */
  clearTaxonomyTreeCache(): void {
    this._taxonomyTreeCache.clear()
    this._inFlightTaxonomyTree.clear()
  }

  /**
   * 拉取分类树：GET /api/v1/taxonomy/tree?locale={lang}&db_path={dbPath}
   * 供虚拟目录标签树渲染消费（内置 5 分钟轻量内存缓存与网络抖动过期降级兜底）
   * @param locale 语言代码，如 zh-CN
   * @param root 可选限定子树根 code
   * @param dbPath 主数据库路径，供 Omni 挂载只读关联
   * @param options 可选作用域过滤参数（workspaceId / directoryPrefix / includeFiles）
   */
  async getTaxonomyTree(
    locale = 'zh-CN',
    root?: string,
    dbPath?: string,
    options?: { workspaceId?: number | string; directoryPrefix?: string; includeFiles?: boolean }
  ): Promise<OmniTaxonomyTreeResponse | null> {
    const wsPart = options?.workspaceId !== undefined && options?.workspaceId !== null ? String(options.workspaceId) : ''
    const dirPart = options?.directoryPrefix || ''
    const incPart = options?.includeFiles ? '1' : '0'
    const cacheKey = `${locale}::${root || ''}::${dbPath || ''}::${wsPart}::${dirPart}::${incPart}`
    const cached = this._taxonomyTreeCache.get(cacheKey)
    if (cached && Date.now() - cached.time < OmniClient.TAXONOMY_CACHE_TTL) {
      return cached.data
    }

    // 并发合并 (Singleflight / In-Flight Request Coalescing)：
    // 若同一 cacheKey 的请求正在在途执行，直接复用该 Promise，彻底杜绝并发惊群击穿打向 Omni
    const inFlight = this._inFlightTaxonomyTree.get(cacheKey)
    if (inFlight) {
      return inFlight
    }

    const fetchPromise = (async () => {
      try {
        // 冷启动不得阻塞调用方（已分析目录 / 虚拟目录左侧「分类维度」面板首屏会 await 本方法）：
        // 原实现经 request() 内的 omniService.ensureRunning() 同步等待引擎 spawn 后的探活轮询
        // （最长 200×200ms = 40s），叠加请求本身 3×8s 超时重试，会让面板长时间停在"加载中"。
        // 此处改为：探活不通 ⇒ 触发后台预热并立即降级（返回历史缓存或 null），
        // 引擎就绪后由渲染进程监听 omni:status-changed 主动重取，用户无感补齐受控维度树。
        //
        // 注意：探活必须放在 IIFE 内部（而非创建 fetchPromise 之前）——否则 await 会打开
        // 并发窗口，使下面的 inFlight 登记失去原子性，Singleflight 合并随之失效。
        if (!(await omniService.checkHealth())) {
          void omniService.start().catch((err: unknown) => {
            logger.warn(LogCategory.DIMENSION_SERVICE, '[OmniClient] Omni 引擎后台预热失败:', err)
          })
          if (cached) {
            logger.warn(
              LogCategory.DIMENSION_SERVICE,
              '[OmniClient] Omni 引擎未就绪，taxonomy 树降级使用历史缓存（已触发后台预热）'
            )
            return cached.data
          }
          logger.warn(
            LogCategory.DIMENSION_SERVICE,
            '[OmniClient] Omni 引擎未就绪，taxonomy 树本次降级为空树（已触发后台预热，就绪后自动重取）'
          )
          return null
        }

        const params = new URLSearchParams({ locale })
        if (root) params.set('root', root)
        if (dbPath) {
          params.set('dbPath', dbPath)
        }
        if (wsPart) {
          params.set('workspaceId', wsPart)
        }
        if (dirPart) {
          params.set('directoryPrefix', dirPart)
        }
        if (options?.includeFiles) {
          params.set('includeFiles', 'true')
        }
        const res = await this.request<OmniTaxonomyTreeResponse>(`/api/v1/taxonomy/tree?${params.toString()}`)
        if (res && res.rootNodes && res.rootNodes.length > 0) {
          this._taxonomyTreeCache.set(cacheKey, { data: res, time: Date.now() })
          return res
        }
        // 降级兜底：若网络请求偶发失败但存在历史缓存，优先使用历史缓存，杜绝受控维度根坍塌
        if (cached) {
          logger.warn(LogCategory.DIMENSION_SERVICE, `[OmniClient] getTaxonomyTree 请求失败，降级使用历史缓存数据`)
          return cached.data
        }
        return res
      } finally {
        this._inFlightTaxonomyTree.delete(cacheKey)
      }
    })()

    this._inFlightTaxonomyTree.set(cacheKey, fetchPromise)
    return fetchPromise
  }

  /**
   * 拉取多语言别名行：GET /api/v1/taxonomy/aliases?locale={lang}&source={source}&codes={codes}
   * 供主库语言分表初值写入（Fix-01 首建拉全集 / Fix-02 切语言 codes= 补漏）。
   * @param locale 语言区域代码，如 zh-CN
   * @param options.source 受控 source 列表（逗号分隔，如 'tag,dimension'），仅返回 file_tags.source 命中的行
   * @param options.codes 精确 tag_code 列表（内部自动逗号拼接），未命中 code 不出行
   * @param options.prefix 兼容保留的旧前缀过滤（builtin / omw）
   */
  async getTaxonomyAliases(
    locale = 'zh-CN',
    options?: { source?: string; codes?: string[]; prefix?: string }
  ): Promise<OmniTagAliasRow[] | null> {
    const params = new URLSearchParams({ locale })
    if (options?.source) params.set('source', options.source)
    if (options?.codes?.length) params.set('codes', options.codes.join(','))
    if (options?.prefix) params.set('prefix', options.prefix)
    return this.request<OmniTagAliasRow[]>(`/api/v1/taxonomy/aliases?${params.toString()}`)
  }

  /**
   * 向量批量写入/更新：POST /api/v1/vector/upsert
   * AI 分析提取 dense embedding 后由 Desktop 调用，向量由 Omni zvec 托管。
   * `encoderId` 必填：Omni 侧缺省即 400 `encoder_id_required`，禁止由本层补默认值。
   */
  async upsertVectors(
    items: OmniVectorUpsertItem[],
    timeoutMs = 15000
  ): Promise<OmniVectorUpsertResponse | null> {
    if (!items.length) return { success: true, count: 0 }
    const payload = {
      items: items.map(item => ({
        fileFingerprint: item.fileFingerprint,
        vector: item.vector,
        encoderId: item.encoderId
      }))
    }
    return this.request<OmniVectorUpsertResponse>('/api/v1/vector/upsert', {
      method: 'POST',
      body: JSON.stringify(payload)
    }, timeoutMs)
  }

  /** 便捷写入单文件向量（`encoderId` 必填，语义同 upsertVectors） */
  async upsertVector(
    fileFingerprint: string,
    vector: number[],
    encoderId: number
  ): Promise<OmniVectorUpsertResponse | null> {
    return this.upsertVectors([{ fileFingerprint, vector, encoderId }])
  }

  /**
   * 以向量搜文件：POST /api/v1/vector/search
   * 以文搜图、搜文档、相似文件推荐统一入口。
   * `options.encoderFilter` 必填（无默认值、无「缺省不过滤」兜底）：Omni 侧缺省或空数组即
   * 400 `encoder_filter_required`；白名单由 `resolveQueryEncoderFilter` 按当前档位给出。
   */
  async searchVectors(
    vector: number[],
    topK: number,
    options: { encoderFilter: number[]; threshold?: number }
  ): Promise<OmniVectorSearchResponse | null> {
    return this.request<OmniVectorSearchResponse>('/api/v1/vector/search', {
      method: 'POST',
      body: JSON.stringify({
        vector,
        topK,
        threshold: options.threshold,
        encoderFilter: options.encoderFilter
      })
    })
  }

  /**
   * 批量按指纹与维度读取反量化向量：POST /api/v1/vector/get
   */
  async getVectors(
    fileFingerprints: string[],
    dim = 384,
    timeoutMs = 10000
  ): Promise<OmniVectorGetResponse | null> {
    if (!fileFingerprints.length) return { vectors: [], count: 0 }
    return this.request<OmniVectorGetResponse>('/api/v1/vector/get', {
      method: 'POST',
      body: JSON.stringify({ fileFingerprints, dim })
    }, timeoutMs)
  }

  /** 批量删除向量：DELETE /api/v1/vector/delete */
  async deleteVectors(fileFingerprints: string[]): Promise<OmniVectorDeleteResponse | null> {
    if (!fileFingerprints.length) return { success: true, deletedCount: 0 }
    return this.request<OmniVectorDeleteResponse>('/api/v1/vector/delete', {
      method: 'DELETE',
      body: JSON.stringify({ fileFingerprints })
    })
  }

  /**
   * 真实目录快速文件名检索：GET /api/v1/search/fs?dir={dir}&q={q}&limit={limit}
   * 由 Omni 内在 walker 直接扫描磁盘目录返回实时命中（含未 AI 分析文件），
   * 结果中带 fileFingerprint 的项即为已分析文件，可与向量/FTS 候选去重
   */
  async searchFastFs(
    dir: string,
    query: string,
    limit = 100
  ): Promise<OmniSearchFsResponse | null> {
    const params = new URLSearchParams({ dir: dir, q: query, limit: String(limit) })
    return this.request<OmniSearchFsResponse>(`/api/v1/search/fs?${params.toString()}`)
  }

  /**
   * 段落级语义对齐：POST /api/v1/vector/match-passages
   * 将查询向量与候选文件的前置分段列表对齐，返回每文件最契合段落与相似度，
   * 用于对无字面命中候选生成语义召回摘要
   */
  async matchPassages(
    query: string,
    items: OmniMatchPassagesItem[]
  ): Promise<OmniMatchPassagesResponse | null> {
    if (!items.length) return { matches: [], durationMs: 0 }
    return this.request<OmniMatchPassagesResponse>('/api/v1/vector/match-passages', {
      method: 'POST',
      body: JSON.stringify({ query, items })
    })
  }

  /**
   * 触发 Omni 热重载维度执行策略：POST /api/taxonomy/reload-policies (DEC-04)
   * Omni 会重新从主库 system_config 只读读取 DIMENSION_POLICIES 并刷新内存索引
   */
  async reloadDimensionPolicies(): Promise<{ success: boolean; error?: string } | null> {
    return this.request<{ success: boolean; error?: string }>('/api/taxonomy/reload-policies', {
      method: 'POST'
    })
  }

  /**
   * 分句语音合成：POST /api/audio/tts/chunk
   * 返回 48kHz WAV 格式的 ArrayBuffer，若失败或被取消返回 null
   */
  async synthesizeTTSChunk(
    text: string,
    voiceId: string | number,
    speed: number,
    sid?: number,
    signal?: AbortSignal
  ): Promise<ArrayBuffer | null> {
    try {
      await omniService.ensureRunning()
      const payload: Record<string, any> = {
        text,
        voice_id: String(voiceId),
        speed
      }
      if (typeof sid === 'number') {
        payload.sid = sid
      }
      const res = await fetch(`${this.getBaseUrl()}/api/audio/tts/chunk`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
        signal
      })
      if (!res.ok) {
        logger.warn(LogCategory.MAIN, `[OmniClient] TTS 合成失败 HTTP ${res.status}`)
        return null
      }
      return await res.arrayBuffer()
    } catch (err: unknown) {
      if ((err as any)?.name === 'AbortError') {
        logger.debug(LogCategory.MAIN, '[OmniClient] TTS 合成请求已中止')
        return null
      }
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn(LogCategory.MAIN, '[OmniClient] TTS 合成请求异常:', msg)
      return null
    }
  }

  /**
   * 音频声学特征分析与提取：POST /api/audio/analyze-voice
   */
  async analyzeVoice(
    filePath: string,
    signal?: AbortSignal
  ): Promise<{
    success: boolean
    lang?: 'zh' | 'en' | 'ja'
    emotion?: string
    text?: string
    frames?: number
    codes?: number[][]
    error?: string
  } | null> {
    try {
      await omniService.ensureRunning()
      const res = await fetch(`${this.getBaseUrl()}/api/audio/analyze-voice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_path: filePath }),
        signal: signal || AbortSignal.timeout(60000)
      })
      const data = (await res.json().catch(() => null)) as any
      if (data) {
        return data
      }
      return { success: false, error: `HTTP ${res.status} ${res.statusText}` }
    } catch (err: any) {
      logger.warn(LogCategory.MAIN, '[OmniClient] analyzeVoice 失败:', err)
      return { success: false, error: err?.message || '请求 Omni 服务失败' }
    }
  }

  /**
   * 内存热注册用户自定义音色：POST /api/audio/tts/register-voice
   */
  async registerVoice(
    voiceId: string,
    frames: number,
    codes: number[][],
    signal?: AbortSignal
  ): Promise<{ success: boolean; error?: string } | null> {
    try {
      await omniService.ensureRunning()
      return await this.request('/api/audio/tts/register-voice', {
        method: 'POST',
        body: JSON.stringify({
          voice_id: voiceId,
          frames,
          codes
        }),
        signal
      })
    } catch (err) {
      logger.warn(LogCategory.MAIN, '[OmniClient] registerVoice 失败:', err)
      return null
    }
  }

  /**
   * 获取 TTS 引擎状态：GET /api/audio/tts/status
   */
  async getTTSStatus(signal?: AbortSignal): Promise<{ ready: boolean; total_voices?: number; sample_rate?: number; engine?: string } | null> {
    return this.request<{ ready: boolean; total_voices?: number; sample_rate?: number; engine?: string }>('/api/audio/tts/status', {
      method: 'GET',
      signal
    })
  }

  /**
   * 极速音频保音调倍速转换：POST /api/audio/tts/scale?speed=1.25
   * 基于纯 Rust WSOLA 算法在内存中毫秒级（< 30ms）派生目标倍率 WAV
   */
  async scaleWavSpeed(
    wavBuffer: Buffer | Uint8Array,
    speed: number,
    signal?: AbortSignal
  ): Promise<Buffer | null> {
    try {
      await omniService.ensureRunning()
      const url = `${this.getBaseUrl()}/api/audio/tts/scale?speed=${encodeURIComponent(speed)}`
      const rawBuffer = Buffer.isBuffer(wavBuffer) ? wavBuffer : Buffer.from(wavBuffer)
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'audio/wav'
        },
        body: rawBuffer as unknown as BodyInit,
        signal
      })
      if (!res.ok) {
        logger.warn(LogCategory.MAIN, `[OmniClient] scaleWavSpeed 失败 HTTP ${res.status}`)
        return null
      }
      const arrayBuf = await res.arrayBuffer()
      return Buffer.from(arrayBuf)
    } catch (err: unknown) {
      if ((err as any)?.name === 'AbortError') {
        logger.debug(LogCategory.MAIN, '[OmniClient] scaleWavSpeed 请求已中止')
        return null
      }
      logger.warn(LogCategory.MAIN, '[OmniClient] scaleWavSpeed 请求异常:', err)
      return null
    }
  }

  /**
   * 纯文本分词：POST /api/v1/text/tokenize
   * 返回由 Omni 结巴搜索切词提取的 tokens 列表（失败时安全降级返回空数组）
   */
  async tokenizeText(text: string, signal?: AbortSignal): Promise<string[]> {
    if (!text || !text.trim()) return []
    try {
      await omniService.ensureRunning()
      const data = await this.request<{ tokens: string[] }>('/api/v1/text/tokenize', {
        method: 'POST',
        body: JSON.stringify({ text }),
        signal
      })
      return data?.tokens ?? []
    } catch (err: unknown) {
      logger.debug(LogCategory.MAIN, '[OmniClient] 文本分词降级:', err)
      return []
    }
  }

  /**
   * 智能分句切片：POST /api/audio/tts/split-chunks
   */
  async splitTTSChunks(
    text: string,
    options?: {
      targetChunkChars?: number
      minChunkChars?: number
      maxChunkChars?: number
      language?: string
    },
    signal?: AbortSignal
  ): Promise<{ chunks: string[]; totalChunks: number; totalChars: number } | null> {
    if (!text || !text.trim()) {
      return { chunks: [], totalChunks: 0, totalChars: 0 }
    }
    try {
      await omniService.ensureRunning()
      return await this.request<{ chunks: string[]; totalChunks: number; totalChars: number }>(
        '/api/audio/tts/split-chunks',
        {
          method: 'POST',
          body: JSON.stringify({
            text,
            targetChunkChars: options?.targetChunkChars,
            minChunkChars: options?.minChunkChars,
            maxChunkChars: options?.maxChunkChars,
            language: options?.language
          }),
          signal
        }
      )
    } catch (err: unknown) {
      if ((err as any)?.name === 'AbortError') {
        logger.debug(LogCategory.MAIN, '[OmniClient] splitTTSChunks 请求已中止')
        return null
      }
      logger.warn(LogCategory.MAIN, '[OmniClient] splitTTSChunks 请求异常:', err)
      return null
    }
  }
}

export const omniClient = OmniClient.getInstance()

