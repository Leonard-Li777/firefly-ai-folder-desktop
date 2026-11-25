/**
 * Omni 服务化客户端 SDK（ADR-0038 / PRD #679 / Issue #682）
 * apps/desktop/src/electron/services/omni-client.ts
 *
 * 职责：
 * 1. 消费 Omni 暴露的高阶业务 HTTP API（taxonomy / vector）
 * 2. 屏蔽 Desktop 对 OMW 底层 SQLite 与 file_vectors 堆表的直接依赖
 * 3. 供主库语言分表 tag_aliases 初值补录、虚拟目录渲染与分析向量链路统一调用
 *    （TaxonomyAliasCache 内存总线已按主设计废除，展示别名一律分表直查）
 */

import http from 'node:http'
import { LogCategory, logger } from '@firefly/shared'
import type { RetagOutcomeStatus, TextTagChainItem, TextTagRequestPayload } from '@firefly/types'
import { omniService, type OmniFetchOptions } from '../runtime-services/system/omni-service'
import { isTransientStatusFetchError } from '../runtime-services/system/omni-service/mount-verify-classify'
import {
  M5FrameParser,
  type StreamChunkPayload,
  type StreamEndMeta,
  type StreamErrorMeta
} from '../runtime-services/ai/m5-frame-parser'

export type { StreamChunkPayload, StreamEndMeta, StreamErrorMeta }

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

/** inspect-tag 回源单项入参（对齐 Rust InspectTagItem，camelCase） */
export interface OmniInspectTagItem {
  tagName: string
  /** 回源场景无父级约束，传空串；端点仍按受控词表精确匹配 lemma 返回 code */
  targetParentCode: string
}

/** inspect-tag 回源单项结果（对齐 Rust InspectTagItemResult，camelCase） */
export interface OmniInspectTagItemResult {
  tagName: string
  isControlled: boolean
  matchedParent: boolean
  code: string | null
  canonicalName: string | null
  parentCodes: string[]
  ancestryMatchedCode: string | null
}

/** inspect-tag 批量回源响应（对齐 Rust InspectTagBatchResponse） */
export interface OmniInspectTagBatchResponse {
  success: boolean
  results: OmniInspectTagItemResult[]
}

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

/**
 * `/health.clipText` 五字段探活结果（工单 10 引擎侧契约）。
 *
 * `available` 由引擎聚合（图像塔 = chinese_clip && 文本塔就绪 && 词表就绪 &&
 * 首次编码未验证为 false）；desktop 只做消费，不再自行推导。
 */
export interface OmniClipTextHealth {
  available: boolean
  /** 当前激活图像塔标签，只有 `chinese_clip` / `mobileclip` 才可能与对应文本塔同空间 */
  imageEncoder: string | null
  textModelReady: boolean
  vocabReady: boolean
  /** 三态：null = 尚未做过首次编码验证 */
  textOutputVerified: boolean | null
  chineseClip?: OmniClipTextHealth
  mobileClip?: OmniClipTextHealth
}

/**
 * CLIP 文本编码结果（工单 12）。
 *
 * **必须保留 `error`/`status`**：429 `busy` 与超时/传输错误在调用方有截然不同的处理
 * （busy 不清空热态时间戳、不计入熔断），若沿用 `request()` 的 null 语义就无从区分。
 */
export interface OmniEmbedClipTextResult {
  ok: boolean
  /** 引擎业务码或 desktop 侧合成码（`transport` / `timeout` / `bad_shape`） */
  error?: string
  status?: number
  vector?: number[]
  dim?: number
  encoderId?: number
  /** 首次调用是否触发模型加载：**仅用于埋点/UI，不参与超时预算** */
  coldStart?: boolean
  loadMs?: number
  encodeMs?: number
}

/** 探活缓存 TTL：5 分钟（工单 12 AC1） */
const CLIP_TEXT_HEALTH_TTL_MS = 5 * 60 * 1000

const DEFAULT_TIMEOUT_MS = 8000

/**
 * OmniClient：Desktop 侧对 Omni 语义/向量 HTTP 契约的唯一入口
 */
export interface TTSChunkResult {
  buffer: ArrayBuffer
  hitCap: boolean
  steps: number
}

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
  private _lastTaxonomyAliasesError: { status: number; errorCode?: string; at: number } | null =
    null

  /** 获取最近一次 getTaxonomyAliases 的 HTTP 错误元信息（用于识别 503 MODULE_NOT_INSTALLED） */
  getLastTaxonomyAliasesError(): { status: number; errorCode?: string; at: number } | null {
    return this._lastTaxonomyAliasesError
  }

  /** 统一走 OmniService.omniFetch（兼容仅 mock 基础方法的既有单测） */
  private fetchOmni(url: string, init?: OmniFetchOptions): Promise<Response> {
    if (typeof omniService.omniFetch === 'function') {
      return omniService.omniFetch(url, init)
    }
    const { kind: _k, timeoutMs, internal: _i, signal, ...rest } = init ?? {}
    const effectiveSignal =
      signal ??
      (typeof timeoutMs === 'number' && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined)
    return fetch(url, {
      ...rest,
      ...(effectiveSignal ? { signal: effectiveSignal } : {})
    })
  }

  private async request<T>(
    path: string,
    init?: RequestInit,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
    retries: number = 2,
    options?: {
      bypassEnsureRunning?: boolean
      onErrorResponse?: (status: number, errorCode?: string) => void
    }
  ): Promise<T | null> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        if (!options?.bypassEnsureRunning) {
          await omniService.ensureRunning()
        }
        const res = await this.fetchOmni(`${this.getBaseUrl()}${path}`, {
          ...init,
          kind: 'call',
          timeoutMs,
          headers: {
            'Content-Type': 'application/json',
            ...(init?.headers ?? {})
          }
        })
        if (!res.ok) {
          let errorCode: string | undefined
          if (res.status === 503 || options?.onErrorResponse) {
            const errBody = (await res.json().catch(() => null)) as Record<string, unknown> | null
            if (typeof errBody?.error === 'string') errorCode = errBody.error
            else if (typeof errBody?.code === 'string') errorCode = errBody.code
            options?.onErrorResponse?.(res.status, errorCode)
          }
          logger.warn(
            LogCategory.DIMENSION_SERVICE,
            `[OmniClient] HTTP ${res.status} ${path} (第 ${attempt + 1}/${retries + 1} 次尝试)`
          )
          // 503 MODULE_NOT_INSTALLED 属确定性缺模错误，立即停试不再无谓退避
          if (res.status === 503 && errorCode === 'MODULE_NOT_INSTALLED') {
            return null
          }
          if (attempt < retries) {
            await new Promise(r => setTimeout(r, 400 * (attempt + 1)))
            continue
          }
          return null
        }
        return (await res.json()) as T
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.debug(
          LogCategory.DIMENSION_SERVICE,
          `[OmniClient] 请求失败 ${path} (第 ${attempt + 1}/${retries + 1} 次尝试):`,
          msg
        )
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
    const wsPart =
      options?.workspaceId !== undefined && options?.workspaceId !== null
        ? String(options.workspaceId)
        : ''
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
        const res = await this.request<OmniTaxonomyTreeResponse>(
          `/api/v1/taxonomy/tree?${params.toString()}`
        )
        if (res && res.rootNodes && res.rootNodes.length > 0) {
          this._taxonomyTreeCache.set(cacheKey, { data: res, time: Date.now() })
          return res
        }
        // 降级兜底：若网络请求偶发失败但存在历史缓存，优先使用历史缓存，杜绝受控维度根坍塌
        if (cached) {
          logger.warn(
            LogCategory.DIMENSION_SERVICE,
            `[OmniClient] getTaxonomyTree 请求失败，降级使用历史缓存数据`
          )
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
    options?: {
      source?: string
      codes?: string[]
      prefix?: string
      timeoutMs?: number
      retries?: number
      bypassEnsureRunning?: boolean
    }
  ): Promise<OmniTagAliasRow[] | null> {
    const params = new URLSearchParams({ locale })
    if (options?.source) params.set('source', options.source)
    if (options?.codes?.length) params.set('codes', options.codes.join(','))
    if (options?.prefix) params.set('prefix', options.prefix)
    this._lastTaxonomyAliasesError = null
    return this.request<OmniTagAliasRow[]>(
      `/api/v1/taxonomy/aliases?${params.toString()}`,
      undefined,
      options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      options?.retries ?? 2,
      {
        bypassEnsureRunning: options?.bypassEnsureRunning,
        onErrorResponse: (status, errorCode) => {
          this._lastTaxonomyAliasesError = { status, errorCode, at: Date.now() }
        }
      }
    )
  }

  /**
   * 按 lemma 批量回源语义包受控词：POST /api/v1/taxonomy/inspect-tag
   *
   * 运行时「首见回源」专用：本地 tag_aliases 镜像未命中的 lemma，用本端点查 pack。
   * 端点内部按 lemma 精确匹配 pack 别名表（omw > hownet > builtin 权威优先级），
   * 只返回受控 code（is_controlled_code 校验），**永不返回 _ext**。
   * 回源场景无父级约束，targetParentCode 传空串即可（端点仍按 lemma 匹配返回 code）。
   *
   * @param items 批量 lemma 项
   * @param locale 语言区域代码，如 zh-CN
   * @param timeoutMs 单次请求预算，回源走打标主链路前置，默认 5000ms
   */
  async inspectTags(
    items: OmniInspectTagItem[],
    locale = 'zh-CN',
    timeoutMs = 5000
  ): Promise<OmniInspectTagBatchResponse | null> {
    if (!items.length) return { success: true, results: [] }
    return this.request<OmniInspectTagBatchResponse>(
      '/api/v1/taxonomy/inspect-tag',
      {
        method: 'POST',
        body: JSON.stringify({ items, language: locale })
      },
      timeoutMs
    )
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
    return this.request<OmniVectorUpsertResponse>(
      '/api/v1/vector/upsert',
      {
        method: 'POST',
        body: JSON.stringify(payload)
      },
      timeoutMs
    )
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
    options: {
      encoderFilter: number[]
      threshold?: number
      /**
       * 单次请求预算（毫秒）。缺省沿用 `DEFAULT_TIMEOUT_MS`。
       * CLIP 第 5 路必须显式传冷/热态预算，否则 phase2 会被这条链路拖到
       * `timeoutMs × (retries + 1) + 退避` 的量级，与「热态 ≤800ms」的契约冲突。
       */
      timeoutMs?: number
      /** 重试次数。CLIP 路传 0：预算已按冷/热态给定，重试会成倍放大首屏等待。 */
      retries?: number
    }
  ): Promise<OmniVectorSearchResponse | null> {
    return this.request<OmniVectorSearchResponse>(
      '/api/v1/vector/search',
      {
        method: 'POST',
        body: JSON.stringify({
          vector,
          topK,
          threshold: options.threshold,
          encoderFilter: options.encoderFilter
        })
      },
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      options.retries ?? 2
    )
  }

  /**
   * 批量按指纹与维度读取反量化向量：POST /api/v1/vector/get
   *
   * Spec §2.2 硬约束：直接委托 `this.fetchOmni`（kind: 'call', timeoutMs, retries: 0），
   * 避免默认 `this.request()` 8s 假超时触发引擎重启误杀。
   */
  async getVectors(
    fileFingerprints: string[],
    dim = 384,
    timeoutMs = 10000
  ): Promise<OmniVectorGetResponse | null> {
    if (!fileFingerprints.length) return { vectors: [], count: 0 }
    try {
      const res = await this.fetchOmni(`${this.getBaseUrl()}/api/v1/vector/get`, {
        method: 'POST',
        kind: 'call',
        timeoutMs,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileFingerprints, dim })
      })
      if (!res.ok) {
        logger.warn(
          LogCategory.DIMENSION_SERVICE,
          `[OmniClient] HTTP ${res.status} /api/v1/vector/get`
        )
        return null
      }
      return (await res.json()) as OmniVectorGetResponse
    } catch (err) {
      logger.warn(
        LogCategory.DIMENSION_SERVICE,
        `[OmniClient] /api/v1/vector/get 请求异常: ${err instanceof Error ? err.message : String(err)}`
      )
      return null
    }
  }

  /**
   * 批前主动预热底座与感知塔：POST /api/v1/engine/warmup（Spec §2.1 / §3.1）
   *
   * - 走 `fetchOmni` `kind: 'long'` + 60s 预算 + `retries: 0`；
   * - 若信号主动 Abort，则原样上抛供队列栅栏识别抢占/暂停/排空；
   * - 非 Abort 异常 / 非 2xx 均 Fail-Open 记录 warn 返回 null。
   */
  async warmupEngine(
    plan: {
      textAndLexicon: boolean
      visionTower: boolean
      nsfwDetector: boolean
      imageOcr: boolean
      ocrModelSize?: 'tiny' | 'small'
    },
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<{
    ready: boolean
    textReady: boolean
    trieReady: boolean
    vectorTableReady: boolean
    semanticGraphReady: boolean
    visionReady: boolean
    nsfwReady: boolean
    ocrReady: boolean
    warmupMs: number
    warnings: string[]
  } | null> {
    if (options?.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : Object.assign(new Error('Aborted'), { name: 'AbortError' })
    }
    try {
      const res = await this.fetchOmni(`${this.getBaseUrl()}/api/v1/engine/warmup`, {
        method: 'POST',
        kind: 'long',
        timeoutMs: options?.timeoutMs ?? 60_000,
        signal: options?.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(plan)
      })
      if (!res.ok) {
        logger.warn(
          LogCategory.ANALYSIS_QUEUE,
          `[OmniClient] HTTP ${res.status} /api/v1/engine/warmup 失败，Fail-Open 放行`
        )
        return null
      }
      return await res.json()
    } catch (err) {
      if (options?.signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
        throw err
      }
      logger.warn(
        LogCategory.ANALYSIS_QUEUE,
        `[OmniClient] /api/v1/engine/warmup 请求异常，Fail-Open 放行: ${err instanceof Error ? err.message : String(err)}`
      )
      return null
    }
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
   * CLIP 文本塔探活：GET /health → `clipText` 五字段（工单 12 AC1）。
   *
   * 5 分钟缓存：探活本身要打一次 HTTP，若每次查询都探活会把首屏延迟抬高一个量级；
   * 缓存按**成功响应**写入，失败不缓存（引擎热启动完成后应立即恢复）。
   */
  private _clipTextHealthCacheMap: Map<string, { data: OmniClipTextHealth; time: number }> =
    new Map()
  private _clipTextHealthInFlightMap: Map<string, Promise<OmniClipTextHealth | null>> = new Map()

  async getClipTextHealth(options?: {
    lang?: string | null
    forceRefresh?: boolean
  }): Promise<OmniClipTextHealth | null> {
    const langKey = (options?.lang || '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
    const now = Date.now()
    const cached = this._clipTextHealthCacheMap.get(langKey)
    if (!options?.forceRefresh && cached && now - cached.time < CLIP_TEXT_HEALTH_TTL_MS) {
      return cached.data
    }
    // Singleflight：并发查询按语言键共用同一次探活
    const inFlight = this._clipTextHealthInFlightMap.get(langKey)
    if (inFlight) return inFlight

    const task = (async () => {
      try {
        await omniService.ensureRunning()
        const query = options?.lang ? `?lang=${encodeURIComponent(options.lang)}` : ''
        const res = await this.fetchOmni(`${this.getBaseUrl()}/health${query}`, {
          kind: 'probe',
          timeoutMs: 2000
        })
        if (!res.ok) {
          logger.warn(
            LogCategory.SYSTEM,
            `[omni-client] CLIP 文本探活响应异常 (HTTP ${res.status})，本轮按不可用处理`
          )
          return null
        }
        const data = (await res.json()) as { clipText?: Partial<OmniClipTextHealth> }
        const raw = data?.clipText
        if (!raw || typeof raw !== 'object') {
          logger.warn(
            LogCategory.SYSTEM,
            '[omni-client] CLIP 文本探活响应缺少 clipText 载荷，本轮按不可用处理'
          )
          return null
        }
        const health: OmniClipTextHealth = {
          available: raw.available === true,
          imageEncoder: typeof raw.imageEncoder === 'string' ? raw.imageEncoder : null,
          textModelReady: raw.textModelReady === true,
          vocabReady: raw.vocabReady === true,
          textOutputVerified:
            raw.textOutputVerified === true
              ? true
              : raw.textOutputVerified === false
                ? false
                : null,
          chineseClip: raw.chineseClip as OmniClipTextHealth | undefined,
          mobileClip: raw.mobileClip as OmniClipTextHealth | undefined
        }
        this._clipTextHealthCacheMap.set(langKey, { data: health, time: Date.now() })
        return health
      } catch (err) {
        // AGENTS §2.9：检索链路的降级必须留痕，禁止静默吞异常。
        // 频次天然受 CLIP_TEXT_HEALTH_TTL_MS（5 分钟缓存）限制，不会把热路刷成告警风暴。
        logger.warn(
          LogCategory.SYSTEM,
          '[omni-client] CLIP 文本探活失败，本轮按不可用处理:',
          err instanceof Error ? err.message : String(err)
        )
        return null
      } finally {
        this._clipTextHealthInFlightMap.delete(langKey)
      }
    })()
    this._clipTextHealthInFlightMap.set(langKey, task)
    return task
  }

  /** 清空 CLIP 文本探活缓存（档位切换/引擎重启后调用） */
  clearClipTextHealthCache(): void {
    this._clipTextHealthCacheMap.clear()
    this._clipTextHealthInFlightMap.clear()
  }

  /**
   * CLIP 文本塔编码：POST /api/v1/vector/embed-clip-text（工单 12）。
   *
   * 与 `request()` 的区别（**不可合并**）：
   * - 不重试：超时预算由调用方按冷/热态给定，重试会成倍放大首屏等待；
   * - 不吞状态码：429 `busy` 与 503 必须可区分（前者不计熔断失败、不清空热态时间戳）；
   * - 超时由 `AbortSignal.timeout` 施加，`coldStart` 只回传给埋点，不参与预算判定。
   *
   * `encoderId` 留痕（R4-5，ADR-0054）：本接口与向量检索侧的 `encoderId` 是引擎硬编码常量，
   * 不是「这个向量确实来自当前模型」的身份证明；跨嵌入空间唯一真实防护是
   * `getClipTextHealth().imageEncoder === 'chinese_clip'` 门禁。不要因为拿到 `encoderId` 就认为
   * 空间一致已被保证（也不要因此新增字段解析）。
   */
  async embedClipText(
    text: string,
    options: { lang?: string; timeoutMs: number }
  ): Promise<OmniEmbedClipTextResult> {
    const payload = (text ?? '').trim()
    if (!payload) return { ok: false, error: 'empty_text', status: 422 }
    try {
      await omniService.ensureRunning()
      const reqBody: { text: string; lang?: string } = { text: payload }
      if (options?.lang) {
        reqBody.lang = options.lang
      }
      const res = await this.fetchOmni(`${this.getBaseUrl()}/api/v1/vector/embed-clip-text`, {
        kind: 'call',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        timeoutMs: options.timeoutMs
      })
      let body: any = null
      try {
        body = await res.json()
      } catch {
        body = null
      }
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          error: typeof body?.error === 'string' ? body.error : `http_${res.status}`
        }
      }
      if (!body || !Array.isArray(body.vector) || body.vector.length === 0) {
        return { ok: false, status: res.status, error: 'bad_shape' }
      }
      return {
        ok: true,
        status: res.status,
        vector: body.vector as number[],
        dim: typeof body.dim === 'number' ? body.dim : body.vector.length,
        encoderId: typeof body.encoderId === 'number' ? body.encoderId : undefined,
        coldStart: body.coldStart === true,
        loadMs: typeof body.loadMs === 'number' ? body.loadMs : undefined,
        encodeMs: typeof body.encodeMs === 'number' ? body.encodeMs : undefined
      }
    } catch (err: unknown) {
      const name = err instanceof Error ? err.name : ''
      const error = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'transport'
      return { ok: false, error }
    }
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
    // 关键防御：若 Omni 尚未完全就绪（未拉起/拉起中/崩溃恢复中），绝不死等 40s，立即返回 null 走本地 FTS5 毫秒级兜底并静默预热
    if (!omniService.isReady()) {
      void omniService.ensureRunning().catch(() => {})
      return null
    }
    const params = new URLSearchParams({ dir: dir, q: query, limit: String(limit) })
    return this.request<OmniSearchFsResponse>(
      `/api/v1/search/fs?${params.toString()}`,
      undefined,
      1500,
      0,
      { bypassEnsureRunning: true }
    )
  }

  /**
   * 段落级语义对齐：POST /api/v1/vector/match-passages
   * 将查询向量与候选文件的前置分段列表对齐，返回每文件最契合段落与相似度，
   * 用于对无字面命中候选生成语义召回摘要。
   *
   * `profile`/`dim` 必须随当前嵌入档位传入：gemma_unified 下由 Omni 端 EmbeddingGemma
   * 文本塔编码（与库内 gemma 槽位同空间）；缺省按 classic_light（bekko-a8m 384d）处理。
   * 严禁在 gemma 档位下省略 profile——那会让 Omni 端回退加载 bekko-a8m。
   */
  async matchPassages(
    query: string,
    items: OmniMatchPassagesItem[],
    options?: { profile?: string; dim?: number }
  ): Promise<OmniMatchPassagesResponse | null> {
    if (!items.length) return { matches: [], durationMs: 0 }
    return this.request<OmniMatchPassagesResponse>('/api/v1/vector/match-passages', {
      method: 'POST',
      body: JSON.stringify({
        query,
        items,
        profile: options?.profile,
        dim: options?.dim
      })
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
   * 返回 48kHz WAV 格式的 ArrayBuffer；按 6 级优先级显式上抛结构化错误，不再静默吞错
   */
  async synthesizeTTSChunk(
    text: string,
    voiceId: string | number,
    speed: number,
    sid?: number,
    signal?: AbortSignal,
    timeoutMs?: number
  ): Promise<TTSChunkResult | null> {
    let combinedSignal: AbortSignal | undefined = signal
    if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      const timeoutSignal = AbortSignal.timeout(timeoutMs)
      combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    }
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
      const res = await this.fetchOmni(`${this.getBaseUrl()}/api/audio/tts/chunk`, {
        kind: 'long',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
        signal: combinedSignal
      })
      if (res.status === 409) {
        logger.warn(
          LogCategory.MAIN,
          '[OmniClient] TTS 分块合成遭遇流式会话占用冲突 HTTP 409 (ENGINE_BUSY_STREAMING)'
        )
        throw new Error('ENGINE_BUSY_STREAMING')
      }
      if (res.status === 503) {
        logger.warn(LogCategory.MAIN, '[OmniClient] TTS 合成服务暂不可用 HTTP 503')
        throw new Error('ENGINE_UNAVAILABLE')
      }
      if (!res.ok) {
        logger.warn(LogCategory.MAIN, `[OmniClient] TTS 合成确定性失败 HTTP ${res.status}`)
        throw new Error('INFERENCE_FAILED')
      }
      const hitCap = res.headers.get('X-Moss-Hit-Cap') === 'true'
      const steps = parseInt(res.headers.get('X-Moss-Steps') || '0', 10)
      if (hitCap) {
        logger.warn(
          LogCategory.MAIN,
          `[OmniClient] ⚠️ TTS 分句触发 375 帧上限截断 (hitCap=true, steps=${steps}): "${text.slice(0, 30)}..."`
        )
      }
      const buffer = await res.arrayBuffer()
      return { buffer, hitCap, steps }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      // 1. 既有显式业务错误直接透传
      if (
        msg === 'ENGINE_BUSY_STREAMING' ||
        msg === 'ENGINE_UNAVAILABLE' ||
        msg === 'INFERENCE_FAILED' ||
        msg === 'TIMEOUT' ||
        msg === 'ABORTED'
      ) {
        throw err
      }
      // 2. HTTP 409 裸错误形态兜底
      const status = (err as any)?.status ?? (err as any)?.statusCode
      if (status === 409) {
        throw new Error('ENGINE_BUSY_STREAMING')
      }
      // 3. 超时判定（必须在 isTransientStatusFetchError 之前）
      const errName = (err as any)?.name
      const reasonName = (combinedSignal?.reason as any)?.name
      if (errName === 'TimeoutError' || reasonName === 'TimeoutError') {
        logger.warn(LogCategory.MAIN, '[OmniClient] TTS 分块合成超时 (TIMEOUT)')
        throw new Error('TIMEOUT')
      }
      // 4. 主动中止判定（必须在 isTransientStatusFetchError 之前）
      if (errName === 'AbortError' || signal?.aborted) {
        logger.debug(LogCategory.MAIN, '[OmniClient] TTS 合成请求已中止 (ABORTED)')
        throw new Error('ABORTED')
      }
      // 5. 网络瞬态故障判定（严禁使用 isTransientStatusHttpCode 以防下游 500 混入 503）
      if (isTransientStatusFetchError(err)) {
        logger.warn(LogCategory.MAIN, '[OmniClient] TTS 合成网络瞬态不可用:', msg)
        throw new Error('ENGINE_UNAVAILABLE')
      }
      // 6. 其余确定性失败统一归入 INFERENCE_FAILED
      logger.warn(LogCategory.MAIN, '[OmniClient] TTS 合成请求异常:', msg)
      throw new Error('INFERENCE_FAILED')
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
      const res = await this.fetchOmni(`${this.getBaseUrl()}/api/audio/analyze-voice`, {
        kind: 'long',
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
      const res = await this.fetchOmni(`${this.getBaseUrl()}/api/audio/tts/register-voice`, {
        kind: 'call',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          voice_id: voiceId,
          frames,
          codes
        }),
        signal: signal ?? AbortSignal.timeout(5000),
        timeoutMs: 5000
      })

      if (res.status === 501) {
        const errText = await res.text().catch(() => '')
        throw new Error(`NOT_IMPLEMENTED: ${errText || '当前激活的语音合成引擎不支持音色克隆'}`)
      }

      if (!res.ok) {
        logger.warn(LogCategory.MAIN, `[OmniClient] registerVoice HTTP ${res.status}`)
        return { success: false, error: `HTTP ${res.status}` }
      }

      return (await res.json()) as { success: boolean; error?: string }
    } catch (err: any) {
      logger.warn(LogCategory.MAIN, '[OmniClient] registerVoice 失败:', err?.message || String(err))
      if (err?.message?.includes('NOT_IMPLEMENTED') || err?.status === 501) {
        throw err
      }
      return null
    }
  }

  /**
   * 获取 TTS 引擎状态：GET /api/audio/tts/status
   */
  async getTTSStatus(signal?: AbortSignal): Promise<{
    ready: boolean
    total_voices?: number
    sample_rate?: number
    engine?: string
  } | null> {
    return this.request<{
      ready: boolean
      total_voices?: number
      sample_rate?: number
      engine?: string
    }>('/api/audio/tts/status', {
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
      const res = await this.fetchOmni(url, {
        kind: 'call',
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

  /**
   * 纯流式语音合成：POST /api/audio/tts/stream
   * 严格对齐 docs/specs/m5-tts-pure-streaming-session-spec.md v1.7.2 §3.4 / §4.2
   * 建立 HTTP Chunked 连接，通过 M5FrameParser 实时解帧，并提供 pause/resume 反压控制
   */
  async startTTSStream(
    params: {
      text: string
      voiceId: string | number
      speed: number
      resumeCharStart?: number
    },
    callbacks: {
      onChunk: (payload: StreamChunkPayload) => void
      onEnd: (meta: StreamEndMeta) => void
      onError: (meta: StreamErrorMeta) => void
    },
    signal?: AbortSignal
  ): Promise<{
    sessionId: string
    pause: () => void
    resume: () => void
    abort: () => void
  }> {
    await omniService.ensureRunning()

    const rawBaseUrl = this.getBaseUrl()
    const url = new URL(`${rawBaseUrl}/api/audio/tts/stream`)
    const port = parseInt(url.port, 10) || 80
    // 强制使用 127.0.0.1 字面量，消除 Windows DNS / IPv6 延迟
    const hostname = url.hostname === 'localhost' ? '127.0.0.1' : url.hostname

    const requestBody = JSON.stringify({
      text: params.text,
      voice_id: String(params.voiceId),
      speed: params.speed,
      resume_char_start: params.resumeCharStart
    })

    return new Promise((resolve, reject) => {
      let isSettled = false
      let sessionId = ''
      let incomingRes: http.IncomingMessage | null = null
      let hasTerminalFrame = false
      let terminalNotified = false
      let abortedByCaller = Boolean(signal?.aborted)
      const parser = new M5FrameParser()

      const emitTerminalError = (code: string, message: string) => {
        if (terminalNotified) return
        terminalNotified = true
        hasTerminalFrame = true
        callbacks.onError({ code, message })
      }

      // 独立 3000ms 建连超时定时器（严禁依赖 socket 空闲超时）
      const connectTimeout = setTimeout(() => {
        if (!isSettled) {
          isSettled = true
          req.destroy(new Error('CONNECT_TIMEOUT'))
          reject(new Error('TTS_STREAM_CONNECT_TIMEOUT'))
        }
      }, 3000)

      const req = http.request(
        {
          hostname,
          port,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(requestBody)
          }
        },
        res => {
          clearTimeout(connectTimeout)
          incomingRes = res

          // 提取会话 ID
          sessionId = (res.headers['x-session-id'] as string) || `sess_${Date.now()}`

          // 冲突处理：409 Conflict 拒绝并发流（Scheme A/B 互斥）
          if (res.statusCode === 409) {
            let errBuf = Buffer.alloc(0)
            res.on('data', chunk => {
              errBuf = Buffer.concat([errBuf, chunk])
            })
            res.on('end', () => {
              try {
                const errObj = JSON.parse(errBuf.toString('utf-8'))
                logger.warn(
                  LogCategory.MAIN,
                  `[OmniClient] TTS 流式请求冲突 409 (ENGINE_BUSY_STREAMING): ${errObj.message || ''}`
                )
                if (!isSettled) {
                  isSettled = true
                  reject(new Error(errObj.code || 'ENGINE_BUSY_STREAMING'))
                }
              } catch {
                if (!isSettled) {
                  isSettled = true
                  reject(new Error('ENGINE_BUSY_STREAMING'))
                }
              }
            })
            return
          }

          if (res.statusCode !== 200) {
            if (!isSettled) {
              isSettled = true
              reject(new Error(`TTS_STREAM_HTTP_${res.statusCode}`))
            }
            return
          }

          if (!isSettled) {
            isSettled = true
            resolve({
              sessionId,
              pause: () => {
                if (incomingRes && !incomingRes.destroyed) {
                  incomingRes.pause()
                }
              },
              resume: () => {
                if (incomingRes && !incomingRes.destroyed) {
                  incomingRes.resume()
                }
              },
              abort: () => {
                abortedByCaller = true
                if (!req.destroyed) {
                  req.destroy()
                }
              }
            })
          }

          res.on('data', (chunk: Buffer) => {
            const frames = parser.push(chunk)
            if (frames === 'FATAL_DESYNC') {
              logger.error(
                LogCategory.MAIN,
                `[OmniClient] M5SF 帧解析致命脱节 FATAL_DESYNC: sessionId=${sessionId}`
              )
              emitTerminalError('FATAL_DESYNC', 'Stream frame protocol desync detected')
              req.destroy()
              return
            }

            for (const frame of frames) {
              if (frame.type === 'AUDIO') {
                frame.payload.sessionId = sessionId
                callbacks.onChunk(frame.payload)
              } else if (frame.type === 'END') {
                if (!terminalNotified) {
                  terminalNotified = true
                  hasTerminalFrame = true
                  callbacks.onEnd(frame.meta)
                }
              } else if (frame.type === 'ERROR') {
                emitTerminalError(frame.meta.code, frame.meta.message)
              }
            }
          })

          res.on('end', () => {
            logger.debug(
              LogCategory.MAIN,
              `[OmniClient] TTS 流式连接结束: sessionId=${sessionId}, hasTerminalFrame=${hasTerminalFrame}`
            )
            if (!hasTerminalFrame && !abortedByCaller && !terminalNotified) {
              emitTerminalError('PREMATURE_EOF', 'TTS 流式连接在收到 END/ERROR 终态帧前意外断开')
            }
          })

          res.on('close', () => {
            if (!hasTerminalFrame && !abortedByCaller && !terminalNotified) {
              emitTerminalError(
                'PREMATURE_EOF',
                'TTS 流式底层连接在收到 END/ERROR 终态帧前提前关闭'
              )
            }
          })

          res.on('error', (err: Error) => {
            logger.warn(
              LogCategory.MAIN,
              `[OmniClient] TTS 流式响应流异常: sessionId=${sessionId}`,
              err
            )
            emitTerminalError('RESPONSE_STREAM_ERROR', err.message)
          })
        }
      )

      // 开启 TCP_NODELAY，消除 40ms Nagle 算法等待
      req.setNoDelay(true)

      req.on('error', (err: Error) => {
        clearTimeout(connectTimeout)
        if (!isSettled) {
          isSettled = true
          reject(err)
        } else if (!abortedByCaller) {
          emitTerminalError('REQUEST_ERROR', err.message)
        }
      })

      // 接入外部 AbortSignal
      if (signal) {
        if (signal.aborted) {
          abortedByCaller = true
          clearTimeout(connectTimeout)
          req.destroy()
          reject(new Error('ABORTED'))
          return
        }
        signal.addEventListener(
          'abort',
          () => {
            abortedByCaller = true
            clearTimeout(connectTimeout)
            req.destroy()
          },
          { once: true }
        )
      }

      req.write(requestBody)
      req.end()
    })
  }

  /**
   * 统一文本返送打标接口：POST /api/text/tag（Spec §2.3 / §3.3）
   *
   * 硬约束：直接走 `this.fetchOmni`（kind: 'call', timeoutMs, retries: 0），
   * 绕开 `this.request()` 的默认重试，避免瞬态/重负载误触发引擎重启；
   * 返回严格 6 态权威映射（ok === (status === 'success_with_tags' || status === 'authoritative_empty')）。
   */
  async tagText(
    payload: TextTagRequestPayload,
    timeoutMs = 5000,
    signal?: AbortSignal
  ): Promise<{ ok: boolean; status: RetagOutcomeStatus; items: TextTagChainItem[] }> {
    if (signal?.aborted) {
      return { ok: false, status: 'aborted', items: [] }
    }

    try {
      const res = await this.fetchOmni(`${this.getBaseUrl()}/api/text/tag`, {
        method: 'POST',
        kind: 'call',
        timeoutMs,
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })

      if (signal?.aborted) {
        return { ok: false, status: 'aborted', items: [] }
      }

      if (!res.ok) {
        logger.warn(
          LogCategory.ANALYSIS_QUEUE,
          `[返送打标] omni 返回 HTTP ${res.status}，保留存量 AI 标签: fp=${payload.fileFingerprint}`
        )
        return { ok: false, status: 'failed', items: [] }
      }

      let data: unknown
      try {
        data = await res.json()
      } catch (parseErr) {
        logger.warn(
          LogCategory.ANALYSIS_QUEUE,
          `[返送打标] omni 响应体解析失败，保留存量 AI 标签: fp=${payload.fileFingerprint}, error=${
            parseErr instanceof Error ? parseErr.message : String(parseErr)
          }`
        )
        return { ok: false, status: 'failed', items: [] }
      }

      if (!Array.isArray(data)) {
        logger.warn(
          LogCategory.ANALYSIS_QUEUE,
          `[返送打标] omni 响应体非数组，保留存量 AI 标签: fp=${payload.fileFingerprint}`
        )
        return { ok: false, status: 'failed', items: [] }
      }

      const items = data as TextTagChainItem[]
      const degradedHeader = res.headers?.get?.('x-omni-tag-degraded')?.toLowerCase()
      const gateEvaluatedHeader = res.headers?.get?.('x-omni-tag-gate-evaluated')?.toLowerCase()

      if (degradedHeader !== 'false') {
        return { ok: false, status: 'degraded', items }
      }

      if (payload.allowNewTags !== true || gateEvaluatedHeader !== 'true') {
        return { ok: false, status: 'no_replacement', items }
      }

      if (items.length > 0) {
        return { ok: true, status: 'success_with_tags', items }
      }
      return { ok: true, status: 'authoritative_empty', items: [] }
    } catch (err) {
      if (signal?.aborted) {
        return { ok: false, status: 'aborted', items: [] }
      }
      logger.warn(
        LogCategory.ANALYSIS_QUEUE,
        `[返送打标] omni 请求失败/超时，保留存量 AI 标签: fp=${payload.fileFingerprint}, error=${
          err instanceof Error ? err.message : String(err)
        }`
      )
      return { ok: false, status: 'failed', items: [] }
    }
  }
}

export const omniClient = OmniClient.getInstance()
