/**
 * 混合检索仲裁器（Hybrid Search Arbiter）
 * apps/desktop/src/electron/runtime-services/filesystem/virtual-directory-service/HybridSearchArbiter.ts
 *
 * 依据 ADR-0039 / PRD #679（Issue #682 分卷，Hybrid Search Everything 融合检索）：
 * 1. 加权 RRF（Reciprocal Rank Fusion）融合打分：
 *    Score(d) = W_FTS * RRF_fts(d) + W_VEC * RRF_vec(d) + W_NAME * NameMatch(d)
 *    RRF_x(d) = 1 / (K + rank_x(d))，rank 从 1 计
 * 2. 三重候选源（并行/近并行）：
 *    - 本地 FTS5 BM25（files_fts，bm25 列权对齐 file-dao.ts）
 *    - Omni 向量检索（omniClient.searchVectors，embedding 来自 omniService.analyzeText）
 *    - 文件名提升（NameMatch：name/smart_name 全子串 = 1.0，否则 token 覆盖率）
 * 3. 真实目录实时 FS 快速文件名检索（searchFastFs）：未分析命中去重后追加至结果尾部
 * 4. 端点级熔断（EndpointCircuitBreaker）：连续失败达到阈值后进入冷却期，平滑降级
 *
 * 权重配置与层级期望：
 *   K = 60, W_FTS = 2.2, W_VEC = 1.6, W_NAME = 0.9
 *   期望层级：双轨命中（name 全子串 + 向量 top1）≈ 0.926 > FTS top1 ≈ 0.036 > 纯向量 top1 ≈ 0.026
 *   （已分析且仅文件名命中的文件分数 = 0.9，会高于纯向量 FTS 未命中的语义召回，属预期取舍）
 */

import Database from 'better-sqlite3'
import {
  LogCategory,
  logger,
  tokenize,
  isUsefulToken,
  normalizeForCache,
  isTestEnvironment,
  isStopwordOrGenericWord,
  hasValidNameMinLength,
  CONTROLLED_CONCEPTS
} from '@firefly/shared'
import {
  omniClient,
  resolveQueryEncoderFilter,

  OmniMatchPassagesItem,
  OmniPassageMatch,
  OmniSearchFsItem,
  type OmniClipTextHealth
} from '../../../services/omni-client'
import { omniService } from '../../system/omni-service'
import { ConfigOrchestrator } from '../../../config/config-orchestrator'
import { calculateFzfScore } from './pinyin-fzf'
import { PinyinQueryPlanner, type PinyinQueryPlan } from './pinyin-query-expander'
import { verifyTextPinyin, type PinyinMatchType } from '../../utils/pinyin-text'
import { FileDao } from '../../database/dao/file-dao'

/** RRF 平滑常量 K（避免 top-rank 分数悬殊、稳定融合放缩） */
export const HYBRID_SEARCH_RRF_K = 60
/** 加权 RRF 四路权重：精确标识符 > 文件名提升 / FTS 字面 / 向量语义（跨媒体量纲统一平权） */
export const HYBRID_SEARCH_WEIGHTS = {
  fts: 2.2,
  vector: 2.0,
  name: 2.4,
  exact: 2.8
} as const
/**
 * 拼音正排索引第 6 路权重（Pinyin Forward Index）。
 *
 * 与 CLIP 第 5 路同模式：缺省 0 完全退化，只有显式配置才生效。
 * 取 1.6 与 CLIP 同量级：拼音路召回的是「字面等价的拼音命中」，是精确匹配的扩展，
 * 不应压过 FTS 字面路（2.2），但应高于无差别语义召回。
 */
export const HYBRID_SEARCH_PINYIN_WEIGHT = 1.6
/** 单源候选池大小（FTS / 向量 / FS 各自的上限，也是融合池的上限） */
export const HYBRID_SEARCH_POOL_SIZE = 200
/**
 * 视频切片跳轴绝对最小置信度阈值（低于此分数的切片视为非目标噪点，杜绝假阳性时间戳下发）。
 * 标定口径：视频切片向量由视觉塔产出（仍为 sentence_embedding 空间），文本查询已切换为内容
 * token 池化空间。以存量 14 条图像/视频向量实测 9 组语义查询：真实跨模态命中 0.33~0.77
 * （均值 0.445），无关分 p95≈0.43。历史 0.65 是旧对称空间标定值，在新空间会阻断几乎全部
 * 真实切片命中；此处取真命中下沿 0.35。切片候选绕过通用纯向量门限，故本值是唯一绝对下限，
 * 假阳性主要由 TEMPORAL_CHUNK_MIN_PROMINENCE 显著性门禁拦截。
 */
export const TEMPORAL_CHUNK_MIN_CONFIDENCE = 0.35
/** 视频切片跳轴相对显著性差值阈值（最高切片得分必须高出全视频所有切片均值至少此裕度，证明为目标瞬间而非全局背景色偏） */
export const TEMPORAL_CHUNK_MIN_PROMINENCE = 0.015
/**
 * 通用多模态/文档纯向量检索最低语义置信度门限（防止 KNN 强制截取无关文件造成的假阳性噪点）。
 *
 * 标定口径（canonical 空间，ADR-0039 附录 B + `__fixtures__/search-regression/calibration.json`）：
 * - **旧值 0.58** → **新值 0.30**（2026-10-23 随文本嵌入空间修正重标，未沿用未经测量的旧值）；
 * - 旧空间 ONNX 全 1 attention_mask 对 `<bos>/<eos>` 均值池化，把无关文本余弦抬到 0.6~0.9
 *   （库内 66 个 `.lnk` 对「跑车」66/66 ≥0.58，最高 0.845），0.58 形同虚设；
 * - canonical 空间改为内容 token 池化后：真实语义命中 top-1 约 0.30~0.55，
 *   无关概念对 p90≈0.21 / p99≈0.40，同一批 66 个 `.lnk` 最高仅 0.275、0/66 越过 0.30；
 * - 取真命中下沿 0.30 作为纯向量准入线。0.85 会把仅剩的语义通道清零（如 股票≈0.303）。
 * 假阳性主要由 TEMPORAL_CHUNK_MIN_PROMINENCE 显著性门禁拦截。
 *
 * 回归夹具：66 负样本 vecScore 最大值必须 < 本值（AC7 硬门槛，见 search-regression-ac7 测试）。
 */
export const MIN_GENERIC_VECTOR_SCORE = 0.30

/**
 * CLIP 文本第 5 路准入分（已按 B2 数据集完成实测标定）。
 *
 * 标定报告详见 `docs/issues/clip-threshold-calibration-report.md` (2026-10-25)：
 * - 数据集：B2 50 张真实照片 + 16 组标注 Query (COCO-CN MIT & MS-COCO)；
 * - 负样本余弦中位数 0.3074，p90 0.3763，p95 0.3957；正样本余弦中位数 0.4423，p5 0.3840；
 * - 0.38 位于抗噪稳健带（截断 90% 负样本噪声，正样本 Recall 93.75%，Precision 39.69%，F1 0.5577）；
 * - 历史初值 0.22 严重偏低（负样本中位数即达 0.3074，会导致 90% 无关负样本涌入 Top 10）。
 */
export const MIN_CLIP_VECTOR_SCORE = 0.38

/**
 * CLIP 文本第 5 路 RRF 权重（**初值，待标定**）。
 *
 * **B2 阻塞**：与 `MIN_CLIP_VECTOR_SCORE` 同步标定（同一份授权图片集），当前值未经验证；
 * 协议见 `docs/specs/classic-light-clip-text-image-search-spec.md` §11。
 *
 * 取 1.6 与向量路（2.0）同量级但略低：CLIP 文本召回的是「视觉语义相似」，
 * 在 classic_light 档下应与既有向量路同权参与融合，但不能压过字面命中。
 * 权重为 0 时第 5 路完全退化（weightedRrfScore 的默认行为）。
 */
export const HYBRID_SEARCH_CLIP_WEIGHT = 1.6

/**
 * 五路权重（四路基线 + CLIP 第 5 路）。
 *
 * 单独导出的原因：`weightedRrfScore` 的 `weights.clip` 缺省为 0（保证不传时完全退化），
 * 只有显式使用这份权重表第 5 路才生效；这样「默认退化」与「启用第 5 路」是两处独立可测的行为。
 */
export const HYBRID_SEARCH_WEIGHTS_WITH_CLIP = {
  ...HYBRID_SEARCH_WEIGHTS,
  clip: HYBRID_SEARCH_CLIP_WEIGHT
} as const
/** 六路权重（四路基线 + CLIP 第 5 路 + 拼音第 6 路） */
export const HYBRID_SEARCH_WEIGHTS_WITH_PINYIN = {
  ...HYBRID_SEARCH_WEIGHTS_WITH_CLIP,
  pinyin: HYBRID_SEARCH_PINYIN_WEIGHT
} as const

/** 热态判定窗口：距上次成功编码超过此值即视为冷态（模型可能已被看门狗释放） */
export const CLIP_TEXT_WARM_WINDOW_MS = 300_000
/**
 * Chinese-CLIP 文本塔输出维度（与图像塔同处 512d 空间）。
 *
 * 用途：检索前校验引擎回传向量维度。若引擎因配置错误返回 384/768，
 * 直接送进 512 槽会被引擎判 400 或静默零命中——两种都表现为「搜不到图」且日志无线索。
 */
export const CLIP_TEXT_EMBED_DIM = 512
/** 冷态编码超时预算（ms）：包含模型加载，故显著长于热态 */
export const CLIP_TEXT_TIMEOUT_COLD_MS = 6000
/** 热态编码超时预算（ms）：模型常驻，只覆盖一次前向 */
export const CLIP_TEXT_TIMEOUT_WARM_MS = 800
/** CLIP 文本熔断器参数：连续 3 次失败 → 打开 60s，指数退避 */
export const CLIP_BREAKER_THRESHOLD = 3
export const CLIP_BREAKER_COOLDOWN_MS = 60_000
/** 退避倍率：第 n 次打开 = 60s * 2^(n-1)，避免模型长期缺失时每 60s 反复重试 */
export const CLIP_BREAKER_BACKOFF_FACTOR = 2

/**
 * CLIP 文本热态纪元（**进程内全局**，不是实例状态）。
 *
 * 背景：`HybridSearchArbiter` 在 `src` 内有 3 个长生命周期实例（`VirtualDirectoryService` /
 * `DimensionManager` / `FileFilter` 各自的 `TagTreeQuery`），而 CLIP 文本塔的 session 住在
 * **同一个** `firefly-omni` 进程里。因此「引擎（重）启动 ⇒ 所有实例的热态都失效」这个事实
 * 天然是进程级的，用一个单调递增的纪元表达最直接：一次 bump 对全部实例同时生效，
 * 既不需要跨服务注册表，也不需要枚举实例。
 *
 * 计数器使用 `let`（模块级可变）而不是 `var` 全局挂载到 window：主进程 Node 环境下模块单例即可。
 */
let clipWarmEpoch = 0

/**
 * 让所有 arbiter 实例的 CLIP 文本热态判定同时失效（Omni 进程（重）启动时调用）。
 *
 * 只清「热态」：熔断计数保持不动。重启后的首次编码即便超时也只记 1 次失败，
 * 下一次必然回到冷态 6000ms 预算并成功，随即 `recordSuccess()` 清零——为清一个
 * 「最多 1 次」的计数而引入跨实例注册表属于过度设计（方案 W2 第 2 条）。
 */
export function invalidateClipTextWarmState(): void {
  clipWarmEpoch += 1
}

/** 只读：当前热态纪元（供诊断与单测断言，不改变状态） */
export function getClipTextWarmEpoch(): number {
  return clipWarmEpoch
}

/**
 * `/health.clipText` 五字段快照。
 *
 * **单一事实源**：直接复用 `omni-client` 的 `OmniClipTextHealth`。
 * 此前在此处内联了一份同构定义，注释给的理由（「以免循环依赖」）不成立——
 * 本文件本就从同一模块 import `omniClient`，类型导入不新增依赖边；
 * 两份结构一旦漂移，赋值处因结构兼容不会报错，属静默失配。
 */
export type ClipTextHealthSnapshot = OmniClipTextHealth

/**
 * CLIP 第 5 路**零成本前置**门禁（纯函数）。
 *
 * 这三条判定不需要任何网络往返，因此必须在探活**之前**执行：
 * 否则档位不对 / 开关关闭 / 非中文界面时仍会打一次 `/health`，违反 AC1「零请求」。
 */
export const ENCODER_FILTER_CHINESE_CLIP = [2] as const
export const ENCODER_FILTER_MOBILE_CLIP = [3] as const

export function evaluateClipChannelPrecondition(input: {
  profile: string | null | undefined
  enabled: boolean
  lang: string | null | undefined
}): { run: boolean; reason?: string } {
  if ((input.profile || '') !== 'classic_light') return { run: false, reason: 'profile_not_classic_light' }
  if (!input.enabled) return { run: false, reason: 'disabled_by_config' }
  // classic_light 现已支持双模态文本检索：zh 走 Chinese-CLIP，非 zh 走 MobileCLIP
  return { run: true }
}

/**
 * CLIP 第 5 路**探活结果**门禁（纯函数）。
 *
 * 只有前置已通过才轮到这几条：它们决定「探活已拿到，但文本塔实际不可用」。
 * 支持双语分流：中文要求 chinese_clip 图像塔，非中文要求 mobileclip 图像塔。
 */
export function evaluateClipTextHealthGate(
  health: ClipTextHealthSnapshot | null | undefined,
  lang?: string | null
): { run: boolean; reason?: string } {
  if (!health) return { run: false, reason: 'health_unavailable' }
  if (!health.available) return { run: false, reason: 'health_unavailable' }
  const isZh = (lang || 'zh').toLowerCase().startsWith('zh')
  const expectedEncoder = isZh ? 'chinese_clip' : 'mobileclip'
  if (health.imageEncoder !== expectedEncoder) {
    return { run: false, reason: `image_encoder_not_${expectedEncoder}` }
  }
  if (!health.textModelReady) return { run: false, reason: 'health_unavailable' }
  if (!health.vocabReady) return { run: false, reason: 'health_unavailable' }
  // 三态：null = 尚未验证过，允许尝试（首次成功后会转 true）
  if (health.textOutputVerified === false) return { run: false, reason: 'text_output_unverified' }
  return { run: true }
}

/**
 * CLIP 第 5 路门禁全集（纯函数，便于穷举不满足场景）。
 *
 * 本函数是**门禁语义的唯一权威定义**；热路径为了省掉探活会分两段调用
 * （precondition → 探活 → healthGate），但两段之并必须与本函数逐项等价。
 *
 * 任一不满足都**零请求**：不编码、不检索，既有四路结果与延迟完全不变。
 */
export function evaluateClipChannelGate(input: {
  profile: string | null | undefined
  enabled: boolean
  lang: string | null | undefined
  health: ClipTextHealthSnapshot | null
}): { run: boolean; reason?: string } {
  const pre = evaluateClipChannelPrecondition(input)
  if (!pre.run) return pre
  return evaluateClipTextHealthGate(input.health, input.lang)
}

/**
 * CLIP 文本 query 是否剥离中文结构助词（`的/之/得/地`）。
 *
 * A/B 定稿在工单 14：默认 **false**（保留修饰词），因为 CLIP 文本塔在自然语言上训练，
 * 「红色的跑车」正是它优于 Bekko 的地方；剥离后与既有向量路的清洗口径趋同，第 5 路就没有独立价值。
 * 保留开关是为了让 14 能用同一份夹具跑 A/B 并回填结论，而不是把猜测写死。
 */
export const CLIP_TEXT_STRIP_PARTICLES = false

/**
 * CLIP 文本 query 清洗（**独立于 Bekko 向量路**，工单 12 AC2）。
 *
 * 与 `queryVectorCandidates` 的清洗差异（刻意不同，不可合并）：
 * - **保留自然短语与方位/色彩修饰词**：CLIP 文本塔就是吃自然语言训练的，
 *   「红色的跑车」「左边的沙发」这类修饰正是它的强项，剥离反而降低召回；
 * - **纯拼音/字母 query 不做语义替代**：正排索引架构下纯拼音查询在路由层即跳过 CLIP 路
 *   （拼音串送入中文 RoBERTa-wwm 只会切成碎片 token），本函数不再承接展开词替换；
 * - 基础清洗只剔除非法符号与规整空白；助词剥离由 `CLIP_TEXT_STRIP_PARTICLES` 控制。
 */
export function cleanClipTextQuery(keyword: string): string {
  const raw = (keyword || '').trim()
  if (!raw) return ''
  // 基础清洗：只剔除控制字符与常见代码符号，规整空白；不剥助词、不去修饰词
  let cleaned = raw
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/[\\/{}<>|`"^~*\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (CLIP_TEXT_STRIP_PARTICLES) {
    cleaned = cleaned
      .replace(/(?<=[\u4e00-\u9fa5]{2,})[的之得地](?=[\u4e00-\u9fa5]{2,})/g, '')
      .trim()
  }
  return cleaned
}

/** BM25 完整 10 列列权（第 0 列为 file_fingerprint UNINDEXED 赋 0.0，随后 9 列对齐 files_fts 架构：name, smart_name, description, content, multimodal_content, ocr, lrc, asr, tags） */
export const HYBRID_BM25_COLUMN_WEIGHTS = [0.0, 4.0, 4.0, 3.0, 3.0, 3.5, 3.5, 3.0, 3.5, 3.5] as const

/**
 * 中文双字短词倒排点查快道的高置信度采纳阈值（Ticket 09 / Spec §4.8）：
 * 点查命中数 >= 此阈值时直接采用倒排召回集合（跳过 9 列 LIKE 全表扫描）；
 * 低于此阈值时无缝并入 LIKE 安全降级候选，保证低频生僻短词不漏召回。
 */
export const SHORT_HAN_INVERTED_MIN_HITS = 5

/** 中文双字纯汉字短词判定（FTS5 trigram 物理上无法为 <3 字符建索引的唯一快道适用窗口） */
const SHORT_HAN_TOKEN_PATTERN = /^[\u4e00-\u9fa5]{2}$/

/** 列权名字典：恪守第一性原理，终结文件名在 BM25 中的超额膨胀，使图片 OCR、音频 ASR、视觉实体与文档正文健康平权 */
export const DEFAULT_COLUMN_WEIGHT_MAP: Record<string, number> = {
  name: 4.0,
  smart_name: 4.0,
  tags: 3.5,
  multimodal_content: 3.5,
  ocr: 3.5,
  asr: 3.5,
  content: 3.0,
  description: 3.0,
  lrc: 3.0
}

/** 已融合的已分析候选 */
export interface HybridRankedCandidate {
  fileFingerprint: string
  /** 1-based FTS5 BM25 排名 */
  ftsRank?: number
  /** 1-based 向量排名（经基础过滤后重排） */
  vecRank?: number
  /** 1-based 精确标识符匹配排名 */
  exactRank?: number
  /** 向量相似度（0~1） */
  vecScore?: number
  /** 工单 12：CLIP 文本第 5 路排名（1-based，缺失即该路未命中） */
  clipRank?: number
  /**
   * 工单 12：CLIP 文本相似度（0~1）。
   * **只用于准入判定**，绝不写入 `vecScore`——两者是不同嵌入空间的余弦，混算会污染向量路语义。
   */
  clipScore?: number
  /** 拼音正排索引第 6 路排名（1-based，缺失即该路未命中） */
  pinyinRank?: number
  /**
   * 拼音路校验回填的命中中文词（音节边界对齐，供 `<mark>` 高亮与 matchedPinyinCandidate 回显）。
   * 跨音节假阳性（如 anxiao 对 kehuanxiaoshuo）在回填阶段即被丢弃，不会出现在此。
   */
  matchedPinyinText?: string
  /** 文件名提升分（0~1） */
  nameBoost: number
  /** 加权 RRF 融合分数 */
  score: number
  /** 是否存在字面命中（FTS 命中或文件名全子串命中） */
  hasLiteral: boolean
  /** 命中的视频时序切片（最高分切片，向前兼容跳轴） */
  matchedChunk?: {
    chunkIndex: number
    startSec: number
    endSec: number
    similarity?: number
  }
  /** 命中的多个视频时序切片（同视频多片段命中，抽帧预览 Grid 模式） */
  matchedChunks?: Array<{
    chunkIndex: number
    startSec: number
    endSec: number
    similarity?: number
  }>
}

/**
 * 拼音路校验回填命中（verifyPinyinCandidates 产物）。
 *
 * 分级口径（设计文档 §5.3）：全拼精确 > 全拼音节切片 > 首字母缩写；
 * 列间口径：name / smart_name / tags > description。
 */
export interface PinyinVerifyHit {
  /** 音节边界对齐的命中中文词（<mark> 高亮与 matchedPinyinCandidate 回显目标） */
  matchedText: string
  /** 命中类型 */
  type: PinyinMatchType
  /** 命中列（列间优先级排序用） */
  column: 'name' | 'smart_name' | 'tags' | 'description'
  /** 产生该命中的查询 token */
  token: string
}

/** 真实目录实时 FS 检索到的未分析文件命中 */
export interface HybridUnanalyzedHit {
  path: string
  name: string
  fileFingerprint?: string
}

/** 三路候选源的降级状态（true = 该路失败/被熔断跳过） */
export interface HybridSearchFailures {
  fts: boolean
  vector: boolean
  fs: boolean
  /**
   * 工单 12：CLIP 文本第 5 路是否失败/熔断。
   * 可选字段，且**不影响**既有四路的失败语义——第 5 路是可选增强，
   * 它的失败不应让调用方把整次检索标成降级。
   */
  clip?: boolean
}

/** 混合检索融合池结果 */
export interface VideoChunkCandidateInterval {
  chunkIndex: number
  startSec: number
  endSec: number
  similarity: number
}

export function applyWingTrimming(
  intervals: VideoChunkCandidateInterval[],
  maxChunkIndex?: number
): VideoChunkCandidateInterval[] {
  if (!intervals || intervals.length === 0) return []

  const sorted = [...intervals].sort((a, b) => a.startSec - b.startSec || a.chunkIndex - b.chunkIndex)
  // Ticket 09 (Spec §4.4)：分组跨度上限与候选切片自身窗口自适应联动，废除固定 12s 硬编码。
  // 长视频自适应切片窗口可达 14s~60s，单个切片长度即可超过旧固定上限，
  // 若仍用固定 12s 会把本应连续命中的重叠切片机械拆组，导致侧翼剥离静默失效。
  // 联动公式：max(12.0, maxChunkLen * 2.5)，短窗口切片行为与旧版完全一致（下限 12.0 托底）。
  const maxChunkLen = sorted.reduce((m, c) => Math.max(m, c.endSec - c.startSec), 0)
  const maxChunkSpanSeconds = Math.max(12.0, maxChunkLen * 2.5)
  const groups: VideoChunkCandidateInterval[][] = []
  let currentGroup: VideoChunkCandidateInterval[] = []

  for (const curr of sorted) {
    if (currentGroup.length === 0) {
      currentGroup.push(curr)
    } else {
      const prev = currentGroup[currentGroup.length - 1]
      const rawSpan = Math.max(curr.endSec, ...currentGroup.map(c => c.endSec)) - currentGroup[0].startSec
      if (curr.startSec < prev.endSec - 0.2 && rawSpan <= maxChunkSpanSeconds) {
        currentGroup.push(curr)
      } else {
        groups.push(currentGroup)
        currentGroup = [curr]
      }
    }
  }
  if (currentGroup.length > 0) {
    groups.push(currentGroup)
  }

  const mergedIntervals: VideoChunkCandidateInterval[] = []

  for (const group of groups) {
    if (group.length === 1) {
      mergedIntervals.push({ ...group[0] })
      continue
    }

    const rawStart = group[0].startSec
    const rawEnd = Math.max(...group.map(c => c.endSec))
    let trimmedStart = rawStart
    let trimmedEnd = rawEnd

    const isHead = group[0].chunkIndex === 0 || group[0].startSec <= 1.0
    const isLeftPeak = group[0].similarity - group[1].similarity >= 0.05
    if (!isHead && !isLeftPeak) {
      trimmedStart = Math.max(group[0].startSec, group[1].startSec - 1.0)
    }

    const last = group.length - 1
    const secondLast = group.length - 2
    const isTail = maxChunkIndex !== undefined && group[last].chunkIndex === maxChunkIndex
    const isRightPeak = group[last].similarity - group[secondLast].similarity >= 0.05
    if (!isTail && !isRightPeak) {
      trimmedEnd = Math.min(rawEnd, group[secondLast].endSec + 1.0)
    }

    if (trimmedEnd - trimmedStart < 2.0 || trimmedStart >= trimmedEnd) {
      trimmedStart = rawStart
      trimmedEnd = rawEnd
    }

    let bestSimilarity = -Infinity
    let bestChunkIndex = group[0].chunkIndex
    for (const c of group) {
      if (c.similarity > bestSimilarity) {
        bestSimilarity = c.similarity
        bestChunkIndex = c.chunkIndex
      }
    }

    mergedIntervals.push({
      chunkIndex: bestChunkIndex,
      startSec: trimmedStart,
      endSec: trimmedEnd,
      similarity: bestSimilarity
    })
  }

  return mergedIntervals
}

export interface HybridRankPool {
  /** 已分析候选（按分数降序） */
  candidates: HybridRankedCandidate[]
  /** 真实目录未分析命中（已去重，按 fs 顺序） */
  unanalyzedHits: HybridUnanalyzedHit[]
  failures: HybridSearchFailures
  /** 融合池总数（candidates + unanalyzedHits，供分页 total 近似） */
  total: number
  /**
   * 工单 13：冷态 CLIP 第 5 路的**延迟结果句柄**（phase3 追加用）。
   *
   * 冷态下第 5 路要等模型加载（预算 6000ms），绝不能并入 phase2 —— 否则首屏被拖慢一个量级。
   * 但它也不该被丢掉：把 promise 交给上层，由 session 在 phase2 派发之后异步等待并作为 phase3 追加。
   *
   * - 热态：undefined（结果已并入 phase2，不需要二次刷新）
   * - 冷态：Promise，resolve 为 null 表示本路失败/熔断（不派发 phase3）
   */
  pendingClip?: Promise<Array<{ fileFingerprint: string; rank: number; score: number }> | null>
}

/** 混合检索上下文（基础过滤条件由 TagTreeQuery.buildFilterQuery 提供，不含 searchKeyword 自身的 LIKE 条件） */
export interface HybridSearchContext {
  /** 已 trim 且非空的搜索词 */
  keyword: string
  /** 基础过滤条件（可选标签、工作区路径、includeUnanalyzed、状态等） */
  whereClauses: string[]
  queryParams: any[]
  /** 仅真实目录模式提供：触发 FS 实时文件名检索并追加未分析命中 */
  workspaceDirectoryPath?: string
  /**
   * 当前工作区 ID（Ticket 09 / Spec §4.8）：
   * 中文双字短词倒排点查快道的工作区隔离过滤依据。
   * 未提供时若能从 workspaceDirectoryPath 解析出根工作区则自动回填，解析失败则安全跳过快道走 LIKE 兜底。
   */
  workspaceId?: number
  poolSize?: number
  /** 调用方可直接注入查询向量（测试复用 / 避免重复 analyzeText） */
  queryEmbedding?: number[]
}

/**
 * 严格标识符特征探针（Strict Identifier Probe）
 * 依据 Spec §3.3.1：
 * 1. 中英混排纯净抽取：使用 match 直接抽取纯净子串，杜绝中文字串污染捕获；
 * 2. 防日期误判：Hash 规则明确要求包含十六进制字母（[a-fA-F]），严禁将纯数字日期误判为短 Hash；
 * 3. 显式排除公历年份与纯数字。
 */
export class IdentifierProbe {
  // 1. 下划线编程变量与错误码 (支持 handle_auth_token, ERR_403, STATUS_TIMEOUT): 至少包含一个下划线且长度 >= 5
  private static readonly RE_UNDERSCORE_IDENTIFIER = /[A-Za-z0-9]{2,}_[A-Za-z0-9_]{2,}/g

  // 2. 发票号与业务流水单号 (支持多段连字符与后缀，绝不截断 INV-2026-088, PO-99120)
  private static readonly RE_INVOICE_SERIAL = /[A-Za-z]{2,5}-\d{2,}(?:-[A-Za-z0-9]+)*/g

  // 3. 严格小驼峰编程变量/函数 (前缀至少2个小写字母，紧随大写字母，排除 iPhone/iPad): getUserInfo, parseTokens
  private static readonly RE_CAMEL_CASE = /\b[a-z]{2,}(?:[A-Z][a-z0-9]+)+\b/g

  // 4. 标准 UUID 与十六进制短 Hash (要求至少包含一个十六进制字母 a-f，防止 20251016 等纯数字日期误判):
  private static readonly RE_UUID = /[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}/g
  private static readonly RE_HEX_HASH =
    /\b(?=[0-9a-fA-F]{7,40}\b)(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]+\b/g

  /** 判定查询串中是否存在强标识符模式，返回抽取的纯净标识符列表 */
  public static extractIdentifiers(query: string): string[] {
    const trimmed = query.trim()
    if (!trimmed) return []

    // 显式排除公历年份与纯短数字 (如 2024, 2025, 2026)
    if (/^\b(19|20)\d{2}\b$/.test(trimmed) || /^\d+$/.test(trimmed)) {
      return []
    }

    const matches = new Set<string>()

    // 使用 match 全局匹配直接抽取纯净子串，杜绝中英混排污染
    const underscores = query.match(this.RE_UNDERSCORE_IDENTIFIER) || []
    const invoices = query.match(this.RE_INVOICE_SERIAL) || []
    const camelCases = query.match(this.RE_CAMEL_CASE) || []
    const uuids = query.match(this.RE_UUID) || []

    // 剔除已抽取的复合标识符与 UUID，避免将其子串误判为独立 Hash
    let queryForHash = query
    for (const token of [...uuids, ...invoices, ...underscores]) {
      queryForHash = queryForHash.replace(token, ' ')
    }
    const hexHashes = queryForHash.match(this.RE_HEX_HASH) || []

    for (const m of [...underscores, ...invoices, ...camelCases, ...uuids, ...hexHashes]) {
      if (!/^\d+$/.test(m) && !/^(19|20)\d{2}$/.test(m)) {
        matches.add(m)
      }
    }

    return Array.from(matches)
  }
}

/**
 * 包装精确短语查询字符串，转义内部引号并包裹双引号
 */
export function formatExactPhraseQuery(id: string): string {
  const safe = id.replace(/"/g, '""')
  return `"${safe}"`
}

/**
 * 清洗 FTS5 MATCH 查询语法干扰字符，避免 trigram 索引语法异常
 * 若输入为已转义且成对包装的精确短语查询（如 "INV-2026-088"），予以安全保留
 */
export function sanitizeFtsQuery(query: string): string {
  const trimmed = query.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 2) {
    const inner = trimmed.slice(1, -1)
    const innerQuotes = inner.match(/"/g)?.length ?? 0
    if (innerQuotes === 0 || innerQuotes % 2 === 0) {
      const safeInner = inner.replace(/[*^()]/g, ' ')
      return `"${safeInner}"`
    }
  }
  const cleaned = query
    .replace(/["*^()\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || query.trim()
}

/**
 * 剥离常见数量词与冠词前缀（如 "一辆", "两只", "三部", "几个", "一张", "一段", "一个", "a ", "the " 等），
 * 提取纯净核心实体概念，避免量词与冠词分散多模态多语言分词器对核心实体的注意力权重。
 */
export function cleanSearchQueryEntities(text: string): string {
  if (!text) return text
  // 1. 中文常见数词+量词前缀剥离
  const quantifierRegex = /^[一两三四五六七八九十几]+[个只辆张部条架顶本套根群首座栋双把台副所顶间支件块面扇道头匹段幅尾]\s*/
  let cleaned = text.replace(quantifierRegex, '').trim()
  // 2. 国际化英文常见冠词/数词前缀剥离 (a, an, the, one)
  cleaned = cleaned.replace(/^(?:a|an|the|one)\s+/i, '').trim()
  return cleaned || text
}

/**
 * RRF 单路得分：rank 不存在或非法时返回 0
 */
export function rrfScore(rank: number | undefined, k: number = HYBRID_SEARCH_RRF_K): number {
  if (rank === undefined || rank === null || !Number.isFinite(rank) || rank <= 0) return 0
  return 1 / (k + rank)
}

/**
 * 加权 RRF 融合得分（纯函数，便于单测）：
 * 恪守第一性原理彻底统一所有检索源的数学度量衡，杜绝裸加分项产生数量级压制：
 * 1. 向量通道注入模型真实语义相似度物理量 vecScore (0.0~1.0)，在保持 RRF 单调性的同时奖励高置信度多模态实体；
 * 2. 文件名提升分经过 (k+1) 归一化对齐到 RRF 标准尺度，杜绝 0.9 裸分对正文、图片与音频产生数十倍暴力碾压；
 * 3. 严格包含防 NaN、防负数安全守卫。
 */
export function weightedRrfScore(
  opts: {
    ftsRank?: number
    vecRank?: number
    nameBoost?: number
    exactRank?: number
    vecScore?: number
    vectorDamping?: number
    ftsDamping?: number
    maxScoreCap?: number
    /** 工单 12：CLIP 文本第 5 路的 rank（缺失即该路不参与，完全退化为四路行为） */
    clipRank?: number
    /** 拼音正排索引第 6 路的 rank（缺失即该路不参与，完全退化为五路行为） */
    pinyinRank?: number
  },
  weights: { fts: number; vector: number; name: number; exact?: number; clip?: number; pinyin?: number } = HYBRID_SEARCH_WEIGHTS,
  k: number = HYBRID_SEARCH_RRF_K
): number {
  const wExact = weights.exact ?? HYBRID_SEARCH_WEIGHTS.exact
  // 工单 12：第 5 路权重缺省 0 —— 默认完全退化，只有显式配置才生效
  const wClip = weights.clip ?? 0
  // 拼音第 6 路同样缺省 0：未传 weights.pinyin 时行为与旧版完全一致
  const wPinyin = weights.pinyin ?? 0
  const baseVec = rrfScore(opts.vecRank, k)
  // 当存在有效向量相似度时，按 (1.0 + clamp(vecScore, 0, 1)) 注入多模态语义置信度
  const scoreMultiplier =
    opts.vecScore !== undefined && Number.isFinite(opts.vecScore)
      ? 1.0 + Math.max(0, Math.min(1, opts.vecScore))
      : 1.0
  const vecDamping = Number.isFinite(opts.vectorDamping) ? Math.max(0, opts.vectorDamping!) : 1.0
  const vecContrib = weights.vector * baseVec * scoreMultiplier * vecDamping

  const ftsDamping = Number.isFinite(opts.ftsDamping) ? Math.max(0, opts.ftsDamping!) : 1.0
  const ftsContrib = weights.fts * rrfScore(opts.ftsRank, k) * ftsDamping

  const safeNameBoost = Number.isFinite(opts.nameBoost) ? Math.max(0, opts.nameBoost ?? 0) : 0
  const nameRrf = safeNameBoost / (k + 1)
  const nameContrib = weights.name * nameRrf

  // CLIP 第 5 路：**不注入 clipScore 作为乘子**——AC 明确 clipScore 只用于准入，
  // 一旦进打分就会与 vecScore 的量纲混算（两者是不同嵌入空间的余弦）。
  const clipContrib = wClip * rrfScore(opts.clipRank, k)

  const rawScore = (
    ftsContrib +
    vecContrib +
    nameContrib +
    clipContrib +
    wPinyin * rrfScore(opts.pinyinRank, k) +
    wExact * rrfScore(opts.exactRank, k)
  )

  if (opts.maxScoreCap !== undefined && Number.isFinite(opts.maxScoreCap)) {
    return Math.min(rawScore, opts.maxScoreCap)
  }
  return rawScore
}

/**
 * 文件名提升分（NameMatch）：
 * - name / smart_name 任意一个含查询全串（不区分大小写）→ 1.0 (强字面置顶)
 * - 否则取核心有效 token 覆盖率并施加平滑阻尼（封顶 0.035），防止无意义单字虚假命中暴打向量与 FTS
 */
export function computeNameBoost(
  name: string | undefined,
  smartName: string | undefined,
  query: string
): number {
  const q = (query || '').trim().toLowerCase()
  if (!q) return 0
  const candidates = [name, smartName]
    .filter((s): s is string => !!s && typeof s === 'string')
  if (candidates.length === 0) return 0

  // 1. 全串完全包含 / fzf 边界加权 / 拼音首字母匹配
  let bestFzf = 0
  for (const cand of candidates) {
    const fzfScore = calculateFzfScore(q, cand)
    if (fzfScore > bestFzf) bestFzf = fzfScore
  }

  // 若 fzf / 拼音首字母缩写匹配达到高置信度（>= 0.85，对应完全子串包含、紧凑包含、拼音首字母或缩写命中），直接返回高提升分
  if (bestFzf >= 0.85) {
    return bestFzf
  }

  // 2. 严格 token 抽取：结合标签过滤方案（tag-admissibility SSOT）与国际化最小字数门禁
  // 2.1 依赖 tag-admissibility 体系过滤中英文停用词、通用文件系统泛词（temp/copy/新建等）、元保留字与抽象空洞壳名词
  // 2.2 结合 hasValidNameMinLength（支持 10 种国际化语言最小字数要求：东亚 CJK >= 2，拉丁等纯字母 >= 2，4K 等规格放行）
  const rawTokens = Array.from(new Set(tokenize(q))).filter(isUsefulToken)
  const effectiveTokens = rawTokens.filter(t => {
    // 结合标签准入门禁：过滤停用词、抽象空洞词与通用文件系统占位词
    if (isStopwordOrGenericWord(t).matched) return false
    // 结合 10 语最小字数门禁：仅当查询全串自身满足最小长度要求时，才剔除不满足最小长度的子词片段
    if (hasValidNameMinLength(q) && !hasValidNameMinLength(t)) return false
    return true
  })

  // 若全部有效词均被过滤（如极端停用词检索），平滑退化使用原始 useful tokens
  const tokensToScore = effectiveTokens.length > 0 ? effectiveTokens : rawTokens
  if (tokensToScore.length === 0) {
    return Math.round(bestFzf * 0.035 * 1000) / 1000
  }

  let bestTokenScore = 0
  for (const cand of candidates) {
    const candLower = cand.toLowerCase()
    let hitTokens = 0
    for (const t of tokensToScore) {
      if (candLower.includes(t.toLowerCase())) hitTokens += 1
    }
    const ratio = hitTokens / tokensToScore.length
    // 部分匹配平滑阻尼，上限 0.035（加权后为 0.9 * 0.035 = 0.0315），
    // 确保与高质量向量 Top 1（0.0328）同级良性竞争，绝不暴力碾压纯多模态语义召回
    const score = ratio * 0.035
    if (score > bestTokenScore) bestTokenScore = score
  }

  const dampenedFzf = Math.round(bestFzf * 0.035 * 1000) / 1000
  return Math.round(Math.max(bestTokenScore, dampenedFzf) * 1000) / 1000
}

/**
 * 统一顺序分页切片（纯函数）：返回当前页条目与全池总数
 */
export function slicePage<T>(pool: T[], limit: number, offset: number): { items: T[]; total: number } {
  const safeLimit = Math.max(0, Number.isFinite(limit) ? Math.floor(limit) : 0)
  const safeOffset = Math.max(0, Number.isFinite(offset) ? Math.floor(offset) : 0)
  return {
    items: pool.slice(safeOffset, safeOffset + safeLimit),
    total: pool.length
  }
}

/** passage 切片选项 */
export interface SplitPassagesOptions {
  maxPassages?: number
  windowChars?: number
}

/**
 * 将正文切分为用于段落级语义对齐的候选片段：
 * 1. 优先按自然段落（空行分隔），
 * 2. 退化为按句子（中英文句号/问号/叹号/分号）切分，
 * 3. 超长段落以滑动窗口截断，总量封顶 maxPassages。
 */
export function splitPassages(text: string, options: SplitPassagesOptions = {}): string[] {
  const maxPassages = Math.max(1, Math.floor(options.maxPassages ?? 15))
  const windowChars = Math.max(50, Math.floor(options.windowChars ?? 200))
  if (!text || typeof text !== 'string') return []
  const cleanText = text
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .trim()
  if (!cleanText) return []

  // 1. 自然段落优先
  let units = cleanText
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(v => !!v && v.length > 0)
  if (units.length < 2) {
    // 2. 退化按句子切分
    const sentences: string[] = []
    for (const part of cleanText.split(/(?<=[。！？!?；;])\s*/)) {
      const s = part.trim()
      if (s) sentences.push(s)
    }
    units = sentences.length >= 2 ? sentences : [cleanText]
  }

  // 3. 长单元滑窗截断
  const passages: string[] = []
  for (const unit of units) {
    if (passages.length >= maxPassages) break
    if (unit.length <= windowChars) {
      passages.push(unit)
      continue
    }
    let idx = 0
    while (idx < unit.length) {
      if (passages.length >= maxPassages) break
      passages.push(unit.slice(idx, idx + windowChars))
      idx += windowChars
    }
  }
  return passages.slice(0, maxPassages)
}

/**
 * 端点级熔断器（Endpoint Circuit Breaker）：
 * - 连续失败达到阈值后进入冷却期（isOpen = true），期间跳过调用方请求；
 * - 冷却期结束自动半开复位（连续失败计数清零）；
 * - 任意成功调用立即关闭熔断。
 */
export class EndpointCircuitBreaker {
  private consecutiveFailures = 0
  private openUntil = 0
  /** 累计「打开」次数（仅用于指数退避；成功一次即清零） */
  private openCount = 0

  constructor(
    private readonly threshold: number = 3,
    private readonly cooldownMs: number = 30_000,
    private readonly now: () => number = () => Date.now(),
    /**
     * 退避倍率：第 n 次打开时冷却 = cooldownMs * factor^(n-1)。
     * 缺省 1 ⇒ `factor^anything === 1`，冷却恒为 cooldownMs，**与引入本参数前的行为逐位一致**，
     * 既有 FTS/向量/FS 三路不受影响（工单 12 要求不得改动四路既有阈值结构）。
     */
    private readonly backoffFactor: number = 1
  ) {}

  /** 是否处于熔断打开状态（打开期间跳过网络请求） */
  get isOpen(): boolean {
    if (this.consecutiveFailures < this.threshold) return false
    if (this.openUntil <= this.now()) {
      // 冷却到期自动复位（半开）
      this.consecutiveFailures = 0
      this.openUntil = 0
      return false
    }
    return true
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0
    this.openUntil = 0
    this.openCount = 0
  }

  recordFailure(): void {
    this.consecutiveFailures += 1
    if (this.consecutiveFailures >= this.threshold) {
      const factor = Number.isFinite(this.backoffFactor) && this.backoffFactor > 0 ? this.backoffFactor : 1
      this.openUntil = this.now() + this.cooldownMs * Math.pow(factor, this.openCount)
      this.openCount += 1
    }
  }

  get failureCount(): number {
    return this.consecutiveFailures
  }
}

/** 向量命中（经基础过滤裁剪后的重排结果） */
interface VectorMatch {
  fileFingerprint: string
  score: number
  rank: number
  matchedChunk?: {
    chunkIndex: number
    startSec: number
    endSec: number
    similarity?: number
  }
  matchedChunks?: Array<{
    chunkIndex: number
    startSec: number
    endSec: number
    similarity?: number
  }>
}

/**
 * 生产 reconciler 定时器工厂：setInterval + unref。
 * unref 是承重件——arbiter 为长生命周期对象且无销毁时点，若定时器引用事件循环，
 * 进程退出会被无限期挂住（人工裁定项③的生命周期要求）。
 */
const defaultPinyinReconcileTimerFactory = (
  cb: () => void,
  ms: number
): { clear: () => void } => {
  const handle = setInterval(cb, ms)
  ;(handle as { unref?: () => void }).unref?.()
  return { clear: () => clearInterval(handle) }
}

/**
 * 混合检索仲裁器：编排 FTS5 / 向量 / 文件名三路信号并按加权 RRF 融合，
 * 真实目录模式下补充 FS 实时未分析命中。构造函数支持注入熔断器便于单测。
 */
export class HybridSearchArbiter {
  private readonly vectorBreaker: EndpointCircuitBreaker
  private readonly fsBreaker: EndpointCircuitBreaker
  /**
   * 工单 12：CLIP 文本第 5 路**独立熔断器**。
   * 绝不复用 `vectorBreaker`：文本塔缺模型/未加载是常态（可选能力），
   * 若共用熔断器，CLIP 连续失败会连带关掉既有 Bekko 向量路，属严重回归。
   */
  private readonly clipBreaker: EndpointCircuitBreaker
  private readonly networkSignals: boolean
  /** 上次 CLIP 文本编码成功的时间戳（0 = 从未成功 ⇒ 冷态） */
  private lastClipSuccessAt = 0
  /** 上次成功时的热态纪元（与当前纪元不一致 ⇒ 已发生引擎重启 ⇒ 冷态） */
  private lastClipWarmEpoch = -1

  constructor(
    private readonly db: Database.Database,
    options?: {
      vectorBreaker?: EndpointCircuitBreaker
      fsBreaker?: EndpointCircuitBreaker
      clipBreaker?: EndpointCircuitBreaker
      /** 是否启用 Omni 网络信号（向量/FS/段落对齐）。默认测试环境关闭，避免真实 38200 端口请求拖慢单测 */
      networkSignals?: boolean
      /**
       * 是否启用 reconciler 定时器驱动（人工裁定项③）。默认非测试环境开启——
       * 无搜索会话时（如后台无检索的纯索引写入路径）也能周期性刷新拼音索引。
       * 测试环境默认关闭（由 searchHybrid 内的节流 tick 驱动，行为与既有用例一致）。
       */
      enablePinyinReconcileTimer?: boolean
      /** 测试注入：假定时器工厂（生产用 setInterval，句柄 unref 防常驻） */
      pinyinReconcileTimerFactory?: (
        cb: () => void,
        ms: number
      ) => { clear: () => void }
    }
  ) {
    this.vectorBreaker = options?.vectorBreaker ?? new EndpointCircuitBreaker()
    this.fsBreaker = options?.fsBreaker ?? new EndpointCircuitBreaker()
    this.clipBreaker =
      options?.clipBreaker ??
      new EndpointCircuitBreaker(
        CLIP_BREAKER_THRESHOLD,
        CLIP_BREAKER_COOLDOWN_MS,
        () => Date.now(),
        CLIP_BREAKER_BACKOFF_FACTOR
      )
    this.networkSignals = options?.networkSignals ?? !isTestEnvironment()

    const timerEnabled = options?.enablePinyinReconcileTimer ?? !isTestEnvironment()
    if (timerEnabled) {
      const factory = options?.pinyinReconcileTimerFactory ?? defaultPinyinReconcileTimerFactory
      this.pinyinReconcileTimer = factory(
        () => this.reconcilePinyinIndexTick(),
        HybridSearchArbiter.PINYIN_RECONCILE_INTERVAL_MS
      )
    }
  }

  /**
   * 释放 arbiter 持有的 reconciler 定时器。
   * 生产实例为长生命周期（不调用）；测试与热重载路径调用，防止定时器持有已关闭的 db 连接。
   */
  dispose(): void {
    if (this.pinyinReconcileTimer) {
      this.pinyinReconcileTimer.clear()
      this.pinyinReconcileTimer = null
    }
  }

  /**
   * 文本塔是否热态：仅**成功**编码会刷新时间戳（工单 12 AC4）。
   *
   * 冷/热态决定超时预算（6000 vs 800ms），`coldStart` 响应字段只用于埋点、不参与判定——
   * 引擎侧「是否冷」与 desktop 侧「上次成功多久」是两件事，后者才是首屏延迟的真实预测器。
   */
  private isClipWarm(now: number = Date.now()): boolean {
    return (
      this.lastClipSuccessAt > 0 &&
      // 纪元不一致 ⇒ 期间发生过 Omni（重）启动，模型可能已重新冷加载
      this.lastClipWarmEpoch === clipWarmEpoch &&
      now - this.lastClipSuccessAt <= CLIP_TEXT_WARM_WINDOW_MS
    )
  }

  /**
   * 执行混合检索并返回融合池（不包含分页切片，分页由调用方基于 total/candidates 执行）
   */
  /**
   * 内部构建加权 RRF 排序候选
   */
  private buildRankedCandidates(opts: {
    keyword: string
    ftsRankMap: Map<string, number>
    exactRankMap: Map<string, number>
    vecRankMap: Map<string, {
      rank: number
      score: number
      matchedChunk?: VectorMatch['matchedChunk']
      matchedChunks?: VectorMatch['matchedChunks']
    }>
    /** 工单 12：CLIP 文本第 5 路候选（fingerprint → rank/score） */
    clipRankMap?: Map<string, { rank: number; score: number }>
    /** 拼音正排索引第 6 路候选（fingerprint → bm25 排名） */
    pinyinRankMap?: Map<string, number>
    /** 拼音路校验回填结果（fingerprint → 音节边界对齐的中文命中词），供高亮与回显 */
    pinyinVerifyMap?: Map<string, PinyinVerifyHit>
    existingNameMap?: Map<string, { name?: string; smartName?: string; path?: string }>
  }): {
    candidates: HybridRankedCandidate[]
    nameMap: Map<string, { name?: string; smartName?: string; path?: string }>
  } {
    const {
      keyword,
      ftsRankMap,
      exactRankMap,
      vecRankMap,
      clipRankMap,
      pinyinRankMap,
      pinyinVerifyMap,
      existingNameMap
    } = opts
    const fpSet = new Set<string>()
    for (const fp of ftsRankMap.keys()) fpSet.add(fp)
    for (const fp of vecRankMap.keys()) fpSet.add(fp)
    for (const fp of exactRankMap.keys()) fpSet.add(fp)
    // 工单 12：CLIP 命中的指纹必须并入 fpSet，否则 nameMap 不会为它们补全名称
    if (clipRankMap) for (const fp of clipRankMap.keys()) fpSet.add(fp)
    // 拼音第 6 路同理：不回填 nameMap 会导致 Phase 1 回调缺名称
    if (pinyinRankMap) for (const fp of pinyinRankMap.keys()) fpSet.add(fp)

    let nameMap: Map<string, { name?: string; smartName?: string; path?: string }>
    if (existingNameMap) {
      nameMap = new Map(existingNameMap)
      const missingFps = Array.from(fpSet).filter(fp => !nameMap.has(fp))
      if (missingFps.length > 0) {
        const deltaMap = this.queryNameMap(missingFps)
        for (const [k, v] of deltaMap) nameMap.set(k, v)
      }
    } else {
      nameMap = this.queryNameMap(Array.from(fpSet))
    }

    const candidates: HybridRankedCandidate[] = []
    for (const fp of fpSet) {
      const ftsRank = ftsRankMap.get(fp)
      const vec = vecRankMap.get(fp)
      const exactRank = exactRankMap.get(fp)
      const clip = clipRankMap?.get(fp)
      // §5.3-4：未通过音节边界校验的候选（跨音节假阳性 / 超出 Top-30 回填限额）不得加权、不计 literal——
      // 假阳性在索引侧必然被 trigram 召回，但校验层按音节边界硬约束判负时其拼音贡献必须剥离
      const pinyinRank = pinyinVerifyMap?.get(fp) ? pinyinRankMap?.get(fp) : undefined
      const { name, smartName } = nameMap.get(fp) ?? {}
      const nameBoost = computeNameBoost(name, smartName, keyword)

      // 防倒挂公理：若由拼音路召回（拼音索引实际命中），但文件物理名称并未匹配原词（nameBoost < 0.85），
      // 1. 对其向量与 FTS 贡献同步施加安全阻尼 alpha_expand = 0.50；
      // 2. 施加数学天花板 maxScoreCap = (HYBRID_SEARCH_WEIGHTS.name * 0.82) / (HYBRID_SEARCH_RRF_K + 1)，
      //    确保原词物理文件名命中（如 khxs.txt，nameBoost >= 0.85）在任何通道叠加下总分绝对第一。
      // 闸条件以「拼音索引实际命中」为准（R1 盲审 B-H1）：planner 无词库、无法凭输入形态区分拼音串与
      // 英文词，若按 plan.isPinyin 判定，则 budget/docker 等零命中的纯英文查询也会被阻尼+封顶，
      // 违反 §5.4「英文查询既有语义检索完全不受影响」——零命中时不存在拼音路候选，阻尼前提不成立。
      const isExpandedNonLiteral =
        pinyinRankMap !== undefined && pinyinRankMap.size > 0 && nameBoost < 0.85
      const vectorDamping = isExpandedNonLiteral ? 0.5 : 1.0
      const ftsDamping = isExpandedNonLiteral ? 0.5 : 1.0
      const maxScoreCap = isExpandedNonLiteral
        ? (HYBRID_SEARCH_WEIGHTS.name * 0.82) / (HYBRID_SEARCH_RRF_K + 1)
        : undefined

      // 拼音路命中是字面等价命中（索引侧拼音串即原文拼音），计入 literal 依据，
      // 避免纯拼音召回的候选被「纯向量假阳性」门限误杀
      const hasLiteral =
        exactRank !== undefined ||
        ftsRank !== undefined ||
        pinyinRank !== undefined ||
        nameBoost >= 0.85
      // 工单 12：CLIP 命中只有达到准入分才算「有语义依据」，否则等同未命中，
      // 避免引擎端阈值被绕过（desktop 侧不做后过滤，只做准入判定）
      const hasClip = clip !== undefined && clip.score >= MIN_CLIP_VECTOR_SCORE
      // 纯向量假阳性过滤：如果一个文件完全没有字面匹配（无 FTS、无 exact、无文件名命中）、
      // 无 CLIP 准入命中，且无有效时序切片命中，向量得分又低于 MIN_GENERIC_VECTOR_SCORE，
      // 坚决不参与排序，防止假阳性污染
      if (!hasLiteral && !hasClip && (!vec?.matchedChunks || vec.matchedChunks.length === 0)) {
        if (!vec?.score || vec.score < MIN_GENERIC_VECTOR_SCORE) {
          continue
        }
      }

      candidates.push({
        fileFingerprint: fp,
        ftsRank,
        vecRank: vec?.rank,
        exactRank,
        vecScore: vec?.score,
        // 工单 12：clipScore 只落到 clipScore，**绝不写入 vecScore**
        clipRank: hasClip ? clip!.rank : undefined,
        clipScore: hasClip ? clip!.score : undefined,
        pinyinRank,
        // 校验回填命中词：仅音节边界对齐的候选有回填词（假阳性/超限额候选的拼音贡献已在上面剥离）
        matchedPinyinText: pinyinVerifyMap?.get(fp)?.matchedText,
        nameBoost,
        score: weightedRrfScore({
          ftsRank,
          vecRank: vec?.rank,
          nameBoost,
          exactRank,
          vecScore: vec?.score,
          vectorDamping,
          ftsDamping,
          maxScoreCap,
          clipRank: hasClip ? clip!.rank : undefined,
          pinyinRank
        }, HYBRID_SEARCH_WEIGHTS_WITH_PINYIN),
        hasLiteral,
        matchedChunk: vec?.matchedChunk,
        matchedChunks: vec?.matchedChunks
      })
    }
    candidates.sort((a, b) => {
      const diff = b.score - a.score
      if (diff !== 0) return diff
      const exactDiff =
        (a.exactRank ?? Number.MAX_SAFE_INTEGER) - (b.exactRank ?? Number.MAX_SAFE_INTEGER)
      if (exactDiff !== 0) return exactDiff
      const nameDiff = b.nameBoost - a.nameBoost
      if (nameDiff !== 0) return nameDiff
      const aMin = Math.min(a.ftsRank ?? Number.MAX_SAFE_INTEGER, a.vecRank ?? Number.MAX_SAFE_INTEGER)
      const bMin = Math.min(b.ftsRank ?? Number.MAX_SAFE_INTEGER, b.vecRank ?? Number.MAX_SAFE_INTEGER)
      if (aMin !== bMin) return aMin - bMin
      return a.fileFingerprint.localeCompare(b.fileFingerprint)
    })
    return { candidates, nameMap }
  }

  /**
   * 内部构建 FS 未分析命中去重列表
   */
  private buildUnanalyzedHits(opts: {
    fsResult: OmniSearchFsItem[] | null
    candidates: HybridRankedCandidate[]
    nameMap: Map<string, { name?: string; smartName?: string; path?: string }>
    poolSize: number
  }): HybridUnanalyzedHit[] {
    const { fsResult, candidates, nameMap, poolSize } = opts
    if (!fsResult || !fsResult.length) return []
    const unanalyzedHits: HybridUnanalyzedHit[] = []
    const seenFp = new Set(candidates.map(c => c.fileFingerprint))
    const seenPath = new Set<string>()
    for (const c of candidates) {
      const p = nameMap.get(c.fileFingerprint)?.path
      if (p) seenPath.add(normalizeForCache(p))
    }
    for (const hit of fsResult) {
      if (!hit || !hit.path || !hit.name) continue
      if (hit.fileFingerprint && seenFp.has(hit.fileFingerprint)) continue
      const key = normalizeForCache(hit.path)
      if (seenPath.has(key)) continue
      seenFp.add(hit.fileFingerprint ?? '')
      seenPath.add(key)
      unanalyzedHits.push({
        path: hit.path,
        name: hit.name,
        fileFingerprint: hit.fileFingerprint ?? undefined
      })
      if (unanalyzedHits.length >= poolSize) break
    }
    return unanalyzedHits
  }

  private static lastPinyinReconcileAt = 0

  /** reconciler tick 间隔（与 searchHybrid 内节流同一常量） */
  private static readonly PINYIN_RECONCILE_INTERVAL_MS = 30_000

  /** 定时器句柄（可 clear；生产为 setInterval 的 Timeout，测试为注入的假定时器） */
  private pinyinReconcileTimer: { clear: () => void } | null = null

  /**
   * 拼音索引 reconciler tick（设计文档 §4.3）：30s 节流批量补写缺失/陈旧拼音行。
   *
   * 取代 10-18 的 syncWorkspaceEntities（向封闭词库注册工作区实体）——正排索引架构下
   * 不再有内存词库，工作区标签/路径名的拼音由索引侧 write-through 承载，
   * 此处只兜底覆盖不走 syncFTSTags 的变更路径（如触发器维护的 smart_name 更新）。
   */
  private reconcilePinyinIndexTick(): void {
    const now = Date.now()
    if (
      now - HybridSearchArbiter.lastPinyinReconcileAt <
      HybridSearchArbiter.PINYIN_RECONCILE_INTERVAL_MS
    ) {
      return
    }
    HybridSearchArbiter.lastPinyinReconcileAt = now
    try {
      this.getFileDao().syncPinyinIndexDirty(300)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn(LogCategory.VIRTUAL_DIRECTORY, '[HybridSearchArbiter] 拼音索引 reconciler tick 失败:', msg)
    }
  }

  /** 懒构造 FileDao（与数据库服务共享同一 db 连接；仅用于拼音源字段收集与 reconciler） */
  private fileDaoInstance: FileDao | null = null
  private getFileDao(): FileDao {
    if (!this.fileDaoInstance) {
      this.fileDaoInstance = new FileDao(this.db)
    }
    return this.fileDaoInstance
  }

  /**
   * 执行混合检索并返回融合池（支持 Phase 1 流式快速回调）
   */
  async searchHybrid(
    context: HybridSearchContext,
    onPhase1?: (phase1Pool: HybridRankPool) => Promise<void> | void
  ): Promise<HybridRankPool> {
    const {
      keyword,
      whereClauses,
      queryParams,
      workspaceDirectoryPath,
      poolSize = HYBRID_SEARCH_POOL_SIZE,
      queryEmbedding
    } = context

    // Ticket 09：解析双字短词倒排点查快道的工作区隔离 ID。
    // 优先采用调用方显式注入的 workspaceId；否则尝试从 workspaceDirectoryPath 反查根工作区；
    // 两路皆不可得时快道安全跳过（走 LIKE 兜底），绝不放宽工作区隔离边界。
    const shortHanWorkspaceId =
      context.workspaceId ?? this.resolveWorkspaceIdFromPath(workspaceDirectoryPath)

    const failures: HybridSearchFailures = { fts: false, vector: false, fs: false }
    const attemptedFs = !!workspaceDirectoryPath

    // 0. 拼音索引 reconciler tick（30s 节流兜底）+ 查询分类规划（PinyinQueryPlanner）
    this.reconcilePinyinIndexTick()
    const plan = PinyinQueryPlanner.getInstance().plan(keyword)

    // 1. 并发启动快速字面三路与慢速向量路
    const fsPromise = attemptedFs
      ? this.queryFastFs(workspaceDirectoryPath!, keyword, poolSize)
      : Promise.resolve(null)
    const identifiers = IdentifierProbe.extractIdentifiers(keyword)
    const exactPromise =
      identifiers.length > 0
        ? Promise.resolve(
            this.queryExactPhraseCandidates(identifiers, whereClauses, queryParams, poolSize)
          )
        : Promise.resolve([])
    const ftsPromise = this.queryFtsCandidates(
      keyword,
      whereClauses,
      queryParams,
      poolSize,
      shortHanWorkspaceId
    )
    // 拼音第 6 路：纯字母查询直接 MATCH files_pinyin_fts（设计文档 §5.2）。
    // 同步点查 <3ms，归入 Phase 1 快路——向量路的启动决策依赖它的命中结果。
    const pinyinPromise = plan.isPinyin
      ? Promise.resolve(this.queryPinyinCandidates(plan, whereClauses, queryParams, poolSize))
      : Promise.resolve([])

    // Phase 1: 等待快速字面三路 + 拼音路完成 (通常 10~25ms)
    const [ftsResult, fsResult, exactResult, pinyinResult] = await Promise.all([
      ftsPromise,
      fsPromise,
      exactPromise,
      pinyinPromise
    ])

    if (ftsResult === null) failures.fts = true
    const ftsRankMap = new Map<string, number>()
    for (const [idx, fp] of (ftsResult ?? []).entries()) ftsRankMap.set(fp, idx + 1)

    const exactRankMap = new Map<string, number>()
    for (const [idx, fp] of (exactResult ?? []).entries()) exactRankMap.set(fp, idx + 1)

    const pinyinRankMap = new Map<string, number>()
    for (const [idx, fp] of (pinyinResult ?? []).entries()) pinyinRankMap.set(fp, idx + 1)

    if (attemptedFs && fsResult === null) failures.fs = true

    // 设计文档 §5.4：**拼音索引确有命中**才跳过向量路——拼音串送入中文 CLIP 无语义，
    // 由拼音 FTS 路 + 原生路承载。纯字母但拼音零命中的查询（如英文单词 budget）
    // 保持原行为走向量路（planner 无词库，无法凭输入形态区分拼音与英文单词，
    // 以索引命中为判据是唯一可靠信号）。
    const pinyinHit = pinyinRankMap.size > 0
    const vectorPromise = pinyinHit
      ? Promise.resolve(null)
      : this.queryVectorCandidates(keyword, queryEmbedding, whereClauses, queryParams, poolSize)
    // 工单 12：CLIP 第 5 路。**热态才并入 phase2**；冷态照常发起但不等待，
    // 避免 6000ms 冷启动预算把首屏拖垮（phase3 由工单 13 消费该结果）。
    // 拼音命中时同样跳过（拼音串无语义可编码）。
    const clipWarmAtStart = this.isClipWarm()
    const clipPromise = pinyinHit
      ? Promise.resolve(null)
      : this.queryClipVectorCandidates(keyword, whereClauses, queryParams, poolSize)

    // 拼音路校验回填（设计文档 §5.3；二轮 review 红线：Top-30 限量，主线程阻塞压在 10ms 内）。
    // 跨音节假阳性（anxiao 对 kehuanxiaoshuo）在此按音节边界硬约束判负，其拼音贡献在
    // buildRankedCandidates 中被剥离（R1 盲审 B-M1：不得加权、不计 literal、不进首屏）。
    // 提前到 Phase 1 之前执行：拼音命中是字面等价命中，首屏融合池必须带权重与回填词。
    const pinyinVerifyMap =
      pinyinRankMap.size > 0
        ? this.verifyPinyinCandidates(plan, Array.from(pinyinRankMap.keys()))
        : undefined

    // 若注册了 Phase 1 回调，立即基于字面三路构建 Phase 1 融合池并向上回调
    let p1NameMap: Map<string, { name?: string; smartName?: string; path?: string }> | undefined
    if (onPhase1) {
      const p1 = this.buildRankedCandidates({
        keyword,
        ftsRankMap,
        exactRankMap,
        vecRankMap: new Map(),
        pinyinRankMap,
        pinyinVerifyMap
      })
      p1NameMap = p1.nameMap
      const p1Unanalyzed = this.buildUnanalyzedHits({
        fsResult,
        candidates: p1.candidates,
        nameMap: p1.nameMap,
        poolSize
      })
      await onPhase1({
        candidates: p1.candidates,
        unanalyzedHits: p1Unanalyzed,
        failures: { ...failures },
        total: p1.candidates.length + p1Unanalyzed.length
      })
    }

    // Phase 2: 等待慢速向量计算完成
    // 工单 12：热态时把 CLIP 第 5 路与 Bekko 向量路同池等待（两者都是网络+模型路径，
    // 并行等待不会增加延迟）；冷态时只等 Bekko，CLIP 结果本轮丢弃。
    let clipResult: Array<{ fileFingerprint: string; rank: number; score: number }> | null = null
    /** 本轮是否真正等待并采纳了 CLIP 结果——只有采纳过才谈得上「失败」 */
    let clipJoined = false
    let vectorResult: VectorMatch[] | null
    if (pinyinHit) {
      // 拼音索引命中：向量/CLIP 两路本轮未启动（策略性跳过，非故障）——不计 failures
      vectorResult = null
    } else if (clipWarmAtStart) {
      const [v, c] = await Promise.all([vectorPromise, clipPromise])
      vectorResult = v
      clipResult = c
      clipJoined = true
    } else {
      void clipPromise.catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        logger.warn(
          LogCategory.VIRTUAL_DIRECTORY,
          '[HybridSearchArbiter] CLIP 冷态后台编码异常（本轮不参与 phase2）: ',
          msg
        )
      })
      vectorResult = await vectorPromise
    }
    if (vectorResult === null && !pinyinHit) failures.vector = true
    const vecRankMap = new Map<
      string,
      {
        rank: number
        score: number
        matchedChunk?: VectorMatch['matchedChunk']
        matchedChunks?: VectorMatch['matchedChunks']
      }
    >()
    for (const v of vectorResult ?? []) {
      vecRankMap.set(v.fileFingerprint, {
        rank: v.rank,
        score: v.score,
        matchedChunk: v.matchedChunk,
        matchedChunks: v.matchedChunks
      })
    }

    // 工单 12：CLIP 命中转成 rankMap（null = 本路熔断/失败，空数组 = 门禁未过或无命中）
    const clipRankMap = new Map<string, { rank: number; score: number }>()
    // 冷态本轮根本没等待 CLIP，谈不上失败：标成 failures.clip 会让每一次首屏检索
    // 都上报「降级」，把可选增强的常态误报成故障。
    if (clipJoined && clipResult === null) failures.clip = true
    for (const c of clipResult ?? []) {
      clipRankMap.set(c.fileFingerprint, { rank: c.rank, score: c.score })
    }

    // 拼音路校验回填已在 Phase 1 前完成（见上）；此处直接消费 pinyinVerifyMap

    const p2 = this.buildRankedCandidates({
      keyword,
      ftsRankMap,
      exactRankMap,
      vecRankMap,
      clipRankMap,
      pinyinRankMap,
      pinyinVerifyMap,
      existingNameMap: p1NameMap
    })
    const unanalyzedHits = this.buildUnanalyzedHits({
      fsResult,
      candidates: p2.candidates,
      nameMap: p2.nameMap,
      poolSize
    })

    return {
      candidates: p2.candidates,
      unanalyzedHits,
      failures,
      total: p2.candidates.length + unanalyzedHits.length,
      // 工单 13：冷态把第 5 路的 promise 交出去做 phase3；热态结果为 undefined（已并入 phase2）
      pendingClip: clipJoined ? undefined : clipPromise
    }
  }

  /**
   * 段落级语义对齐（matchPassages）：为无字面命中的候选生成最契合段落摘要。
   * 失败/熔断时返回空映射，由调用方降级为语义首段摘要。
   */
  async alignPassages(
    keyword: string,
    items: OmniMatchPassagesItem[]
  ): Promise<Record<string, OmniPassageMatch>> {
    if (!items.length) return {}
    if (!this.networkSignals) return {}
    try {
      const resp = await omniClient.matchPassages(keyword, items)
      const map: Record<string, OmniPassageMatch> = {}
      if (resp && Array.isArray(resp.matches)) {
        for (const m of resp.matches) {
          if (m && m.fileFingerprint) map[m.fileFingerprint] = m
        }
      }
      return map
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn(
        LogCategory.VIRTUAL_DIRECTORY,
        '[HybridSearchArbiter] 段落语义对齐失败，降级为语义首段摘要:',
        msg
      )
      return {}
    }
  }

  get isVectorSearchOpen(): boolean {
    return this.vectorBreaker.isOpen
  }

  get isFastFsSearchOpen(): boolean {
    return this.fsBreaker.isOpen
  }

  /** 精确标识符候选（按 FTS5 短语 BM25 + 文件名精确匹配），返回匹配指纹列表 */
  private queryExactPhraseCandidates(
    identifiers: string[],
    whereClauses: string[],
    queryParams: any[],
    poolSize: number
  ): string[] {
    if (identifiers.length === 0) return []
    try {
      const ftsTable = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='files_fts'")
        .get()
      const results: string[] = []
      const seen = new Set<string>()

      const extraWhere = whereClauses.length > 0 ? `AND ${whereClauses.join(' AND ')}` : ''

      for (const id of identifiers) {
        if (ftsTable) {
          const phraseQuery = sanitizeFtsQuery(formatExactPhraseQuery(id))
          const rows = this.db
            .prepare(`
              SELECT f.file_fingerprint AS file_fingerprint
              FROM files_fts
              JOIN files f ON f.rowid = files_fts.rowid
              JOIN workspace_files wf ON wf.file_fingerprint = f.file_fingerprint
              WHERE files_fts MATCH ?
                ${extraWhere}
              ORDER BY bm25(files_fts, ${HYBRID_BM25_COLUMN_WEIGHTS.join(', ')}) ASC
              LIMIT ?
            `)
            .all(phraseQuery, ...queryParams, poolSize) as Array<{ file_fingerprint: string }>
          for (const r of rows) {
            if (!seen.has(r.file_fingerprint)) {
              seen.add(r.file_fingerprint)
              results.push(r.file_fingerprint)
            }
          }
        }

        const escapedId = `%${id.replace(/([%_\\])/g, '\\$1')}%`
        const nameRows = this.db
          .prepare(`
            SELECT wf.file_fingerprint AS file_fingerprint
            FROM workspace_files wf
            LEFT JOIN files f ON f.file_fingerprint = wf.file_fingerprint
            WHERE (wf.name LIKE ? ESCAPE '\\' OR f.smart_name LIKE ? ESCAPE '\\')
              ${extraWhere}
            LIMIT ?
          `)
          .all(escapedId, escapedId, ...queryParams, poolSize) as Array<{ file_fingerprint: string }>
        for (const r of nameRows) {
          if (!seen.has(r.file_fingerprint)) {
            seen.add(r.file_fingerprint)
            results.push(r.file_fingerprint)
          }
        }
      }
      return results.slice(0, poolSize)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn(LogCategory.VIRTUAL_DIRECTORY, '[HybridSearchArbiter] 精确标识符候选查询失败: ', msg)
      return []
    }
  }

  /**
   * 从目录路径解析工作区 ID（双字短词倒排点查快道的隔离依据，Ticket 09 / Spec §4.8）。
   * 依次尝试 workspaces 根路径与 workspace_directories 子目录路径精确匹配；
   * 查询失败时显式上报并返回 undefined（调用方安全跳过快道走 LIKE 兜底，禁止静默降级）。
   */
  private resolveWorkspaceIdFromPath(workspaceDirectoryPath?: string): number | undefined {
    if (!workspaceDirectoryPath) return undefined
    try {
      const rootRow = this.db
        .prepare('SELECT workspace_id FROM workspaces WHERE path = ? LIMIT 1')
        .get(workspaceDirectoryPath) as { workspace_id: number } | undefined
      if (rootRow?.workspace_id !== undefined) return rootRow.workspace_id
      const dirRow = this.db
        .prepare('SELECT workspace_id FROM workspace_directories WHERE path = ? LIMIT 1')
        .get(workspaceDirectoryPath) as { workspace_id: number } | undefined
      return dirRow?.workspace_id
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn(
        LogCategory.VIRTUAL_DIRECTORY,
        '[HybridSearchArbiter] 解析工作区 ID 失败，双字短词倒排点查快道安全跳过（走 LIKE 兜底）: ',
        msg
      )
      return undefined
    }
  }

  /**
   * 中文双字受控概念倒排点查快道（Ticket 09 / Spec §4.8，严格遵循 AGENTS.md §2.3 受控概念铁律）：
   * Step 1: TS 内存 Ingress 归一化 —— 从静态强类型 CONTROLLED_CONCEPTS 字典点查受控 code，
   *         禁止任何数据库层自然语言模糊比对；
   * Step 2: 私有标签映射点查 —— `SELECT code FROM file_tags_private WHERE name = ?`；
   * Step 3: 带工作区隔离的高性能倒排点查 —— 命中物理索引 idx_file_tag_relations_tag(tag_code, file_fingerprint)，
   *         耗时 <3ms，结果严格限定当前 workspace_id。
   * 返回 null 表示快道失败（调用方继续 LIKE 兜底），空数组表示确认无受控码可用。
   */
  private queryShortHanInvertedIndexCandidates(
    shortHanTokens: string[],
    workspaceId: number,
    poolSize: number
  ): string[] | null {
    try {
      const targetCodes = new Set<string>()
      for (const token of shortHanTokens) {
        // Step 1: 受控概念内存字典点查（Ingress 归一化为受控 code，绝不落入 SQL 模糊比对）
        const conceptCode = CONTROLLED_CONCEPTS[token as keyof typeof CONTROLLED_CONCEPTS]
        if (conceptCode) targetCodes.add(conceptCode)
        // Step 2: 私有标签映射点查（用户自定义/动态扩展标签的显示名 → 受控 code）
        const privRow = this.db
          .prepare('SELECT code FROM file_tags_private WHERE name = ? LIMIT 1')
          .get(token) as { code: string } | undefined
        if (privRow?.code) targetCodes.add(privRow.code)
      }
      if (targetCodes.size === 0) return []

      // Step 3: 带工作区隔离的倒排点查（DISTINCT 去重同指纹多路径引用，严格 workspace_id 边界）
      const codes = Array.from(targetCodes)
      const placeholders = codes.map(() => '?').join(',')
      const rows = this.db
        .prepare(
          `SELECT DISTINCT r.file_fingerprint AS file_fingerprint
           FROM file_tag_relations r
           JOIN workspace_files wf ON wf.file_fingerprint = r.file_fingerprint
           WHERE r.tag_code IN (${placeholders}) AND wf.workspace_id = ?
           LIMIT ?`
        )
        .all(...codes, workspaceId, poolSize) as Array<{ file_fingerprint: string }>
      return rows.map(r => r.file_fingerprint)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn(
        LogCategory.VIRTUAL_DIRECTORY,
        '[HybridSearchArbiter] 双字短词倒排点查快道失败，降级进入多列 LIKE 召回: ',
        msg
      )
      return null
    }
  }

  /** FTS5 快速字面候选（按 bm25 权重升序 = 相关度降序），包含短词/多词智能 LIKE 安全降级召回，返回 null 表示该路失败 */
  /**
   * 原生 FTS5 字面路（files_fts）。
   *
   * 正排索引架构下不再接收拼音展开词——纯字母/拼音查询由 queryPinyinCandidates
   * （files_pinyin_fts 第 6 路）承载，本路只处理原生字面检索（设计文档 §5.1 闸 1）。
   */
  private queryFtsCandidates(
    keyword: string,
    whereClauses: string[],
    queryParams: any[],
    poolSize: number,
    shortHanWorkspaceId?: number
  ): string[] | null {
    try {
      const ftsCols = this.db
        .prepare("PRAGMA table_info(files_fts)")
        .all() as Array<{ name: string }>
      if (!ftsCols || ftsCols.length === 0) return []

      const indexedCols = ftsCols.filter(c => c.name !== 'file_fingerprint').map(c => c.name)
      const colSet = new Set(indexedCols)
      const extraWhere = whereClauses.length > 0 ? `AND ${whereClauses.join(' AND ')}` : ''

      const trimmed = (keyword || '').trim()
      if (!trimmed) return []

      let rows: Array<{ file_fingerprint: string }> = []
      const tokens = trimmed.split(/\s+/).filter(Boolean)
      const hasLongToken = tokens.some(t => t.length >= 3)

      // 1. 若存在 >=3 字符的有效 token，优先尝试 FTS5 trigram MATCH
      if (hasLongToken) {
        try {
          // 安全分项清洗转义并安全组装 OR 查询表达式
          const safeTerms = [trimmed]
            .map(w => {
              const cleaned = w.replace(/[*^()"\\-]/g, ' ').trim()
              return cleaned.length >= 3 ? `"${cleaned}"` : ''
            })
            .filter(Boolean)
          const safeQuery = safeTerms.length > 0 ? safeTerms.join(' OR ') : sanitizeFtsQuery(trimmed)
          if (safeQuery) {
            // FTS5 bm25 严格按虚拟表物理声明列顺序（从 0 开始）赋值，包含 UNINDEXED 列
            // 第 0 列 file_fingerprint UNINDEXED 必须赋予 0.0 占位，避免后续列权向左整体错位！
            const weights = ftsCols.map(c =>
              c.name === 'file_fingerprint' ? 0.0 : (DEFAULT_COLUMN_WEIGHT_MAP[c.name] ?? 1.0)
            )
            rows = this.db
              .prepare(`
                SELECT f.file_fingerprint AS file_fingerprint
                FROM files_fts
                JOIN files f ON f.rowid = files_fts.rowid
                JOIN workspace_files wf ON wf.file_fingerprint = f.file_fingerprint
                WHERE files_fts MATCH ?
                  ${extraWhere}
                ORDER BY bm25(files_fts, ${weights.join(', ')}) ASC
                LIMIT ?
              `)
              .all(safeQuery, ...queryParams, poolSize) as Array<{ file_fingerprint: string }>
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          logger.warn(LogCategory.VIRTUAL_DIRECTORY, '[HybridSearchArbiter] FTS MATCH 异常，降级进入多列 LIKE 召回: ', msg)
        }
      }

      // 2. 若 MATCH 未能召回任何候选（短词 <3 字符、空格分隔多词或未命中），执行多列 LIKE 安全降级召回
      const combinedTokens = Array.from(new Set(tokens))

      // 1.5 中文双字受控概念倒排点查快道 (Ticket 09 / Spec §4.8)：
      // FTS5 trigram 物理上无法为 2 字符建索引，"合同/发票/图片/视频"等高频双字词在此前
      // 会直接落入 9 列 LIKE 全表扫描（大库 80~150ms）。快道三阶段点查 <3ms：
      // 受控概念内存字典 → file_tags_private 映射 → idx_file_tag_relations_tag 物理倒排（带 workspace_id 隔离）。
      // 命中 >= SHORT_HAN_INVERTED_MIN_HITS 直接采用（高置信度召回）；不足阈值无缝并入 LIKE 降级（低频不漏召回）。
      let invertedHeadHits: string[] = []
      if (rows.length === 0 && shortHanWorkspaceId !== undefined) {
        const shortHanTokens = combinedTokens.filter(t => SHORT_HAN_TOKEN_PATTERN.test(t))
        if (shortHanTokens.length > 0) {
          const invertedHits = this.queryShortHanInvertedIndexCandidates(
            shortHanTokens,
            shortHanWorkspaceId,
            poolSize
          )
          if (invertedHits && invertedHits.length >= SHORT_HAN_INVERTED_MIN_HITS) {
            return invertedHits
          }
          if (invertedHits && invertedHits.length > 0) {
            invertedHeadHits = invertedHits
          }
        }
      }

      if (rows.length === 0 && combinedTokens.length > 0) {
        // 保守防 DoS 截断：最多取前 8 个有效词
        const safeTokens = combinedTokens.slice(0, 8)
        const targetSearchCols = [
          'name',
          'smart_name',
          'description',
          'content',
          'multimodal_content',
          'ocr',
          'asr',
          'lrc',
          'tags'
        ].filter(c => colSet.has(c))

        if (targetSearchCols.length > 0) {
          const likeConditions: string[] = []
          const likeParams: any[] = []
          for (const token of safeTokens) {
            const colLikes = targetSearchCols.map(c => `files_fts.${c} LIKE ? ESCAPE '\\'`).join(' OR ')
            likeConditions.push(`(${colLikes})`)
            const p = `%${token.replace(/([%_\\])/g, '\\$1')}%`
            for (let i = 0; i < targetSearchCols.length; i++) {
              likeParams.push(p)
            }
          }

          const exactNameParam = `%${trimmed.replace(/([%_\\])/g, '\\$1')}%`
          // GROUP BY f.file_fingerprint 防止多工作区/多路径文件重复占用 LIMIT 并干扰 RRF rank
          const fallbackSql = `
            SELECT f.file_fingerprint AS file_fingerprint
            FROM files_fts
            JOIN files f ON f.rowid = files_fts.rowid
            JOIN workspace_files wf ON wf.file_fingerprint = f.file_fingerprint
            WHERE ${likeConditions.join(' AND ')}
              ${extraWhere}
            GROUP BY f.file_fingerprint
            ORDER BY
              MIN(
                CASE
                  WHEN wf.name LIKE ? ESCAPE '\\' THEN 0
                  ${colSet.has('smart_name') ? "WHEN files_fts.smart_name LIKE ? ESCAPE '\\' THEN 0" : ''}
                  ${colSet.has('tags') ? "WHEN files_fts.tags LIKE ? ESCAPE '\\' THEN 1" : ''}
                  ${colSet.has('ocr') ? "WHEN files_fts.ocr LIKE ? ESCAPE '\\' THEN 1" : ''}
                  ${colSet.has('asr') ? "WHEN files_fts.asr LIKE ? ESCAPE '\\' THEN 1" : ''}
                  ${colSet.has('multimodal_content') ? "WHEN files_fts.multimodal_content LIKE ? ESCAPE '\\' THEN 1" : ''}
                  ${colSet.has('content') ? "WHEN files_fts.content LIKE ? ESCAPE '\\' THEN 2" : ''}
                  ${colSet.has('description') ? "WHEN files_fts.description LIKE ? ESCAPE '\\' THEN 2" : ''}
                  ${colSet.has('lrc') ? "WHEN files_fts.lrc LIKE ? ESCAPE '\\' THEN 2" : ''}
                  ELSE 3
                END
              ) ASC,
              wf.id DESC
            LIMIT ?
          `
          const orderParams = [exactNameParam]
          if (colSet.has('smart_name')) orderParams.push(exactNameParam)
          if (colSet.has('tags')) orderParams.push(exactNameParam)
          if (colSet.has('ocr')) orderParams.push(exactNameParam)
          if (colSet.has('asr')) orderParams.push(exactNameParam)
          if (colSet.has('multimodal_content')) orderParams.push(exactNameParam)
          if (colSet.has('content')) orderParams.push(exactNameParam)
          if (colSet.has('description')) orderParams.push(exactNameParam)
          if (colSet.has('lrc')) orderParams.push(exactNameParam)

          rows = this.db.prepare(fallbackSql).all(
            ...likeParams,
            ...queryParams,
            ...orderParams,
            poolSize
          ) as Array<{ file_fingerprint: string }>
        }
      }

      // 双字短词低频点查结果并入 LIKE 召回头部（保序去重，点查命中优先，绝不漏召回）
      if (invertedHeadHits.length > 0) {
        const seen = new Set(invertedHeadHits)
        for (const row of rows) {
          if (!seen.has(row.file_fingerprint)) {
            invertedHeadHits.push(row.file_fingerprint)
            seen.add(row.file_fingerprint)
          }
        }
        return invertedHeadHits.slice(0, poolSize)
      }

      return rows.map(r => r.file_fingerprint)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn(LogCategory.VIRTUAL_DIRECTORY, '[HybridSearchArbiter] FTS5 检索失败，降级: ', msg)
      return null
    }
  }

  /**
   * 拼音正排索引第 6 路候选（files_pinyin_fts，设计文档 §5.2）。
   *
   * 纯字母查询直接 MATCH 拼音索引——不经过任何「拼音→中文」封闭词表：
   * - len >= 3 token → trigram 子串匹配（全拼与首字母缩写通用）；
   * - len == 2 token → 独立双字词精确匹配（索引侧同词 run 存为首尾补空格的 token，
   *   故 " cw " 只命中独立成词的「财务」；句子内部缩写仍受 >=3 约束——已裁决边界）。
   *
   * bm25 权重按虚拟表物理声明列顺序赋值（file_fingerprint/name_py/smart_name_py/
   * description_py/tags_py/src_hash），UNINDEXED 两列必须赋 0.0 占位防错位。
   */
  private queryPinyinCandidates(
    plan: PinyinQueryPlan,
    whereClauses: string[],
    queryParams: any[],
    poolSize: number
  ): string[] {
    if (!plan.isPinyin || plan.pinyinTokens.length === 0) return []
    try {
      const tableExists = this.db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='files_pinyin_fts'`
        )
        .get()
      if (!tableExists) return []

      // token → FTS5 MATCH 询项（2 字符加首尾空格做独立词精确匹配）
      const orTerms = plan.pinyinTokens.map(t => (t.length >= 3 ? `"${t}"` : `" ${t} "`))
      const matchExpr = orTerms.join(' OR ')
      const extraWhere = whereClauses.length > 0 ? `AND ${whereClauses.join(' AND ')}` : ''

      // 同一文件在 workspace_files 多行（多工作区/多路径）会重复占用 LIMIT 名额并扭曲 rank 分布：
      // 子查询按 fp 去重（MIN(rowid) 定代表行）后回连做 bm25 排序（R1 盲审 B-M3）。
      // 约束：SQLite 禁止 bm25 辅助函数进入聚合上下文——MIN(bm25(...)) 与 GROUP BY + ORDER BY bm25
      // 均实测报 "unable to use function bm25 in the requested context"，故采用两段式。
      // files 按 rowid 连接（拼音行 rowid = files.rowid，A-H1 对齐，与 files_fts 路径同构）。
      const rows = this.db
        .prepare(
          `
          SELECT fp AS file_fingerprint FROM (
            SELECT f.file_fingerprint AS fp, MIN(files_pinyin_fts.rowid) AS rid
            FROM files_pinyin_fts
            JOIN files f ON f.rowid = files_pinyin_fts.rowid
            JOIN workspace_files wf ON wf.file_fingerprint = f.file_fingerprint
            WHERE files_pinyin_fts MATCH ?
              ${extraWhere}
            GROUP BY f.file_fingerprint
          )
          JOIN files_pinyin_fts ON files_pinyin_fts.rowid = rid
          ORDER BY bm25(files_pinyin_fts, 0.0, 4.0, 4.0, 3.0, 3.5, 0.0) ASC
          LIMIT ?
        `
        )
        .all(matchExpr, ...queryParams, poolSize) as Array<{ file_fingerprint: string }>
      return rows.map(r => r.file_fingerprint)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn(LogCategory.VIRTUAL_DIRECTORY, '[HybridSearchArbiter] 拼音索引检索失败，降级: ', msg)
      return []
    }
  }

  /**
   * 拼音路候选校验回填（设计文档 §5.3；二轮 review 红线：Top-30 限量）。
   *
   * 对召回候选读回四源字段（与索引写入严格同源），复用 pinyin-text.ts 构造器现算拼音：
   * - 音节边界对齐硬约束：跨音节截断（anxiao 对 kehuanxiaoshuo）判假阳性丢弃，
   *   绝不生成 <mark> 高亮（从机制上杜绝错误高亮）；
   * - 命中分级：全拼精确 > 全拼音节切片 > 首字母缩写；列间 name/smart_name/tags > description；
   * - token 越长越优先（更具体的查询项胜出）。
   *
   * 返回 fingerprint → 最优命中；无命中（假阳性被滤光）的指纹不出现在 map 中。
   */
  private verifyPinyinCandidates(
    plan: PinyinQueryPlan,
    fingerprints: string[],
    limit = 30
  ): Map<string, PinyinVerifyHit> {
    const out = new Map<string, PinyinVerifyHit>()
    if (!plan.isPinyin || plan.pinyinTokens.length === 0) return out
    const dao = this.getFileDao()
    const columnRank: Record<PinyinVerifyHit['column'], number> = {
      name: 0,
      smart_name: 0,
      tags: 0,
      description: 1
    }
    const typeRank: Record<PinyinMatchType, number> = {
      full: 3,
      'full-slice': 2,
      initials: 1
    }

    for (const fp of fingerprints.slice(0, limit)) {
      const fields = dao.getPinyinSourceFields(fp)
      if (!fields) continue
      let best: PinyinVerifyHit | null = null
      for (const token of plan.pinyinTokens) {
        const columns: Array<[PinyinVerifyHit['column'], string]> = [
          ['name', fields.name],
          ['smart_name', fields.smartName],
          ['tags', fields.tagsText],
          ['description', fields.description]
        ]
        for (const [column, text] of columns) {
          const hit = verifyTextPinyin(text, token)
          if (!hit) continue
          const candidate: PinyinVerifyHit = {
            matchedText: hit.matchedText,
            type: hit.type,
            column,
            token
          }
          if (
            !best ||
            typeRank[candidate.type] > typeRank[best.type] ||
            (typeRank[candidate.type] === typeRank[best.type] &&
              (columnRank[candidate.column] < columnRank[best.column] ||
                (columnRank[candidate.column] === columnRank[best.column] &&
                  candidate.token.length > best.token.length)))
          ) {
            best = candidate
          }
        }
      }
      if (best) out.set(fp, best)
    }
    return out
  }

  /**
   * 工单 12：CLIP 文本塔第 5 路候选（文字 query → 文本塔向量 → 512 视觉槽检索）。
   *
   * 返回 null 表示熔断/失败，空数组表示「门禁未通过」或「无命中」——
   * 二者对调用方语义不同（前者计入 failures，后者只是本路为空）。
   *
   * 全链路硬约束：
   * - 门禁不通过时**零请求**（不编码、不检索），既有四路结果与延迟完全不变；
   * - 检索白名单固定 `[2]`（ChineseCLIP），**不做 desktop 后过滤**，
   *   阈值随请求下推给引擎，由引擎在 truncate(top_k) 之前剪枝；
   * - 视频切片指纹（`fp:cN`）一律丢弃：v1 不检索视频切片；
   * - 429 `busy` 不计熔断失败、不清空热态时间戳。
   *
   * `encoderId` 留痕（R4-5，ADR-0054）：`[2]` 是写入时的身份标签，引擎侧下发/过滤的 `encoderId`
   * 为硬编码常量，**不能反向证明当前写入向量真由 Chinese-CLIP 产生**；真实防护是
   * `health.imageEncoder === 'chinese_clip'` 门禁（门禁不通过则零请求）。不要再加字段解析。
   */
  private async queryClipVectorCandidates(
    keyword: string,
    whereClauses: string[],
    queryParams: any[],
    poolSize: number
  ): Promise<Array<{ fileFingerprint: string; rank: number; score: number }> | null> {
    if (this.clipBreaker.isOpen) {
      // AC：所有跳过都必须留痕。熔断跳过属真实故障态（不是「能力未启用」），用 warn 而非 debug，
      // 否则用户只会看到「搜不到图」而日志里毫无线索。
      logger.warn(
        LogCategory.VIRTUAL_DIRECTORY,
        '[HybridSearchArbiter] CLIP 文本通道熔断中，本轮跳过第 5 路'
      )
      return null
    }
    if (!this.networkSignals) return []
    try {
      // ---- 门禁（六种不满足场景一律零请求）----
      const orchestrator = ConfigOrchestrator.getInstance()
      const profile = await omniService.getEmbeddingProfile()
      const enabled =
        orchestrator.getValue<boolean>('AI_CLIP_TEXT_SEARCH_ENABLED') ?? true
      const lang = orchestrator.getValue<string>('DEFAULT_LANGUAGE') || 'zh-CN'

      // 第一段：零成本前置。**必须在探活之前**——档位/开关/语言不满足时连 /health 都不该发。
      const pre = evaluateClipChannelPrecondition({ profile, enabled, lang })
      if (!pre.run) {
        logger.debug(
          LogCategory.VIRTUAL_DIRECTORY,
          `[HybridSearchArbiter] CLIP 文本通道跳过 (reason=${pre.reason})`
        )
        return []
      }

      // 第二段：探活（5 分钟缓存，单飞）。只有前置通过才会走到这里。
      const health = await omniClient.getClipTextHealth({ lang })
      const healthGate = evaluateClipTextHealthGate(health, lang)
      if (!healthGate.run) {
        // 走到这里说明「档位/开关/语言都要求第 5 路」，却因文本塔不可用而跳过 —— 这是真实的能力缺失，
        // 必须 warn（而前置三条属稳态配置差异，用 debug 以免把最热的检索路径刷成告警风暴）。
        logger.warn(
          LogCategory.VIRTUAL_DIRECTORY,
          `[HybridSearchArbiter] CLIP 文本通道跳过 (reason=${healthGate.reason})`
        )
        return []
      }

      // ---- query 清洗（独立于 Bekko 路）----
      const text = cleanClipTextQuery(keyword)
      if (!text) return []

      // ---- 冷/热态超时预算 ----
      // 冷态 = 从未成功编码，或距上次成功超过 300s（模型可能已被看门狗释放）。
      // 预算按态取值，与响应里的 `coldStart` 无关：后者只做埋点，不参与判定。
      const warm = this.isClipWarm()
      const warmBudgetMs =
        orchestrator.getValue<number>('AI_CLIP_TEXT_TIMEOUT_WARM_MS') ||
        CLIP_TEXT_TIMEOUT_WARM_MS
      const coldBudgetMs =
        orchestrator.getValue<number>('AI_CLIP_TEXT_TIMEOUT_COLD_MS') ||
        CLIP_TEXT_TIMEOUT_COLD_MS
      const budget = warm ? warmBudgetMs : coldBudgetMs

      // 发起前捕获纪元：若飞行中出现 Omni 重启（`invalidateClipTextWarmState()`），
      // 旧进程已发出的 200 响应返回后不得把「新进程尚处于冷加载」误判为热态。
      const reqEpoch = clipWarmEpoch
      const encoded = await omniClient.embedClipText(text, { lang, timeoutMs: budget })
      if (!encoded.ok) {
        // 429 busy：引擎并发饱和，既不算失败也不清空热态——下一轮很可能直接成功
        if (encoded.status === 429 || encoded.error === 'busy') {
          logger.warn(
            LogCategory.VIRTUAL_DIRECTORY,
            '[HybridSearchArbiter] CLIP 文本编码 busy(429)，本轮跳过第 5 路（不计熔断）'
          )
          return []
        }
        this.clipBreaker.recordFailure()
        // 超时 / 503 / 传输错误：热态失效，下次回到 6000ms 冷态预算
        this.lastClipSuccessAt = 0
        logger.warn(
          LogCategory.VIRTUAL_DIRECTORY,
          `[HybridSearchArbiter] CLIP 文本编码失败 (error=${encoded.error}, status=${encoded.status ?? '-'})，本轮跳过第 5 路`
        )
        return null
      }
      if (!encoded.vector || encoded.vector.length === 0) {
        this.clipBreaker.recordFailure()
        this.lastClipSuccessAt = 0
        logger.warn(
          LogCategory.VIRTUAL_DIRECTORY,
          '[HybridSearchArbiter] CLIP 文本编码返回空向量，本轮跳过第 5 路'
        )
        return null
      }
      // 维度必须与 512 视觉槽一致：维度错位的向量送进引擎只会得到 400 或静默零命中，
      // 两种都会表现为「搜不到图」而日志里没有线索，故在此显式拦截并留痕。
      if (encoded.vector.length !== CLIP_TEXT_EMBED_DIM) {
        this.clipBreaker.recordFailure()
        this.lastClipSuccessAt = 0
        logger.warn(
          LogCategory.VIRTUAL_DIRECTORY,
          `[HybridSearchArbiter] CLIP 文本向量维度异常（期望 ${CLIP_TEXT_EMBED_DIM}，实得 ${encoded.vector.length}），` +
            `本轮跳过第 5 路`
        )
        return null
      }
      // 编码成功 ⇒ 文本塔进入热态（刷新热态时间戳）。
      // 但熔断计数必须等**检索也成功**才清零：若在此处 recordSuccess，而检索恒失败，
      // 序列会变成 success(0)→failure(1)→success(0)→failure(1)，consecutiveFailures
      // 永远到不了阈值 3，「编码恒成功 + 检索恒失败」时熔断永不打开。
      this.lastClipSuccessAt = Date.now()
      // 写入**请求发起时**的纪元（而非现读）：参见上方 reqEpoch 的竞态说明
      this.lastClipWarmEpoch = reqEpoch

      // ---- 检索：按语言与实际编码器出处分派 [2] (ChineseCLIP) 或 [3] (MobileCLIP) ----
      const isZh = lang.toLowerCase().startsWith('zh')
      const activeEncoderFilter =
        encoded.encoderId === 3 || (!isZh && encoded.encoderId !== 2)
          ? [...ENCODER_FILTER_MOBILE_CLIP]
          : [...ENCODER_FILTER_CHINESE_CLIP]

      // 必须透传冷/热态预算且禁用重试：`request()` 缺省是 8s × 3 次，
      // 一旦沿用，phase2 会被单条 CLIP 链路拖到 25s 量级，与 800ms 热态契约冲突。
      const resp = await omniClient.searchVectors(encoded.vector, poolSize, {
        encoderFilter: activeEncoderFilter,
        threshold: MIN_CLIP_VECTOR_SCORE,
        timeoutMs: budget,
        retries: 0
      })
      if (!resp || !Array.isArray(resp.matches)) {
        // 检索失败与文本塔冷热无关：不计入 lastClipSuccessAt，只计入本路熔断
        this.clipBreaker.recordFailure()
        logger.warn(
          LogCategory.VIRTUAL_DIRECTORY,
          '[HybridSearchArbiter] CLIP 文本向量检索失败，本轮跳过第 5 路'
        )
        return null
      }
      // 编码 + 检索都成功，才算本路一次完整成功（重置熔断计数与退避代数）
      this.clipBreaker.recordSuccess()
      if (resp.matches.length === 0) return []

      // ---- 切片排除 + 基础条件交集 ----
      const chunkPattern = /^(.+):c(\d+)$/
      const plainMatches = resp.matches.filter(m => !chunkPattern.test(m.fileFingerprint))
      if (plainMatches.length === 0) return []
      const allowed = this.filterMembersFromBase(
        plainMatches.map(m => m.fileFingerprint),
        whereClauses,
        queryParams
      )
      const byFp = new Map<string, number>()
      for (const m of plainMatches) {
        if (!allowed.has(m.fileFingerprint)) continue
        const prev = byFp.get(m.fileFingerprint)
        if (prev === undefined || m.score > prev) byFp.set(m.fileFingerprint, m.score)
      }
      if (byFp.size === 0) return []

      return Array.from(byFp.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, poolSize)
        .map(([fileFingerprint, score], idx) => ({ fileFingerprint, rank: idx + 1, score }))
    } catch (err: unknown) {
      this.clipBreaker.recordFailure()
      this.lastClipSuccessAt = 0
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn(LogCategory.VIRTUAL_DIRECTORY, '[HybridSearchArbiter] CLIP 第 5 路异常，降级: ', msg)
      return null
    }
  }

  /** 向量候选（分析Text→embedding→searchVectors→基础过滤），返回 null 表示失败或熔断 */
  private async queryVectorCandidates(
    keyword: string,
    queryEmbedding: number[] | undefined,
    whereClauses: string[],
    queryParams: any[],
    poolSize: number
  ): Promise<VectorMatch[] | null> {
    if (this.vectorBreaker.isOpen) return null
    if (!this.networkSignals) return []
    try {
      let embedding = queryEmbedding
      if (!embedding || embedding.length === 0) {
        // 正排索引架构下纯拼音查询已在路由层跳过本路（拼音串无语义），此处只处理原生查询
        const textToAnalyze = keyword
        const cleanKeyword = cleanSearchQueryEntities(textToAnalyze)
        // 剥离中文修饰助词（如 "红色的跑车" -> "红色跑车"），使自然语言描述与视觉向量特征空间紧密对齐；
        // 彻底剔除脱离模型实际输入分布的人工提示词前缀 (如 'task: search result | query: ')，
        // 杜绝 28 字节通用英文 ASCII 提示词暴力稀释核心语义，根除所有车辆查询均千篇一律收敛至同一噪点切片 (如 03:24) 的严重偏置。
        const normalizedQuery = cleanKeyword
          .replace(/(?<=[\u4e00-\u9fa5]{2,})[的之得地](?=[\u4e00-\u9fa5]{2,})/g, '')
          .trim()
        let analysis = await omniService.analyzeText(normalizedQuery)
        if (!analysis?.embedding_dense && normalizedQuery !== cleanKeyword) {
          analysis = await omniService.analyzeText(cleanKeyword)
        }
        if (!analysis?.embedding_dense && cleanKeyword !== textToAnalyze) {
          analysis = await omniService.analyzeText(textToAnalyze)
        }
        embedding = analysis?.embedding_dense
      }
      if (!embedding || embedding.length === 0) {
        this.vectorBreaker.recordFailure()
        return null
      }
      // 查询白名单必须显式给出（无「缺省不过滤」兜底）：
      // classic_light 384 槽 → [0, 1]（Bekko + v2 旧记录过渡）；gemma_unified 各 MRL 槽 → [4]。
      const embeddingProfile = await omniService.getEmbeddingProfile()
      // 工单 07：门限同步下推给 Omni 端（AC7 双闸第一道）。引擎在 truncate(top_k) 之前
      // 先按 threshold 剪枝，66 条 .lnk 负样本在最坏情况下也不会跨网络进入候选池；
      // 桌面侧 L712 的 MIN_GENERIC_VECTOR_SCORE 过滤是第二道闸，两者必须同源同值。
      const resp = await omniClient.searchVectors(embedding, poolSize, {
        encoderFilter: resolveQueryEncoderFilter(embeddingProfile),
        threshold: MIN_GENERIC_VECTOR_SCORE
      })
      if (!resp || !Array.isArray(resp.matches)) {
        this.vectorBreaker.recordFailure()
        return null
      }
      if (resp.matches.length === 0) {
        // 空结果属于正常意图（如向量库尚无条目），不视为端点故障
        this.vectorBreaker.recordSuccess()
        return []
      }
      this.vectorBreaker.recordSuccess()

      // 1. 解析时序切片格式（如 `${parentFp}:c${chunkIndex}`），提取父文件指纹并向基础条件做交集过滤
      const chunkPattern = /^(.+):c(\d+)$/
      const parsedMatches: Array<{
        rawFp: string
        parentFp: string
        chunkIndex?: number
        score: number
      }> = resp.matches.map(m => {
        const match = m.fileFingerprint.match(chunkPattern)
        if (match) {
          return {
            rawFp: m.fileFingerprint,
            parentFp: match[1],
            chunkIndex: parseInt(match[2], 10),
            score: m.score
          }
        }
        return {
          rawFp: m.fileFingerprint,
          parentFp: m.fileFingerprint,
          score: m.score
        }
      })

      const uniqueParentFps = Array.from(new Set(parsedMatches.map(p => p.parentFp)))
      const allowed = this.filterMembersFromBase(
        uniqueParentFps,
        whereClauses,
        queryParams
      )

      // 2. 按 parentFp 聚合并保留最高相似度得分与优选切片索引
      interface ParentAgg {
        parentFp: string
        bestScore: number
        bestChunkIndex?: number
        bestChunkScore?: number
        chunks: Array<{ chunkIndex: number; score: number }>
        matchedChunks?: Array<{
          chunkIndex: number
          startSec: number
          endSec: number
          similarity: number
        }>
      }
      const parentAggMap = new Map<string, ParentAgg>()
      for (const m of parsedMatches) {
        if (!allowed.has(m.parentFp)) continue
        let existing = parentAggMap.get(m.parentFp)
        if (!existing) {
          existing = {
            parentFp: m.parentFp,
            bestScore: m.score,
            chunks: []
          }
          parentAggMap.set(m.parentFp, existing)
        }
        if (m.score > existing.bestScore) {
          existing.bestScore = m.score
        }
        if (m.chunkIndex !== undefined) {
          const found = existing.chunks.find(c => c.chunkIndex === m.chunkIndex)
          if (found) {
            if (m.score > found.score) found.score = m.score
          } else {
            existing.chunks.push({ chunkIndex: m.chunkIndex, score: m.score })
          }
        }
      }

      if (parentAggMap.size === 0) {
        return []
      }

      // 1. 预先批量查询所有命中切片视频的 file_video_chunks 元数据（获取各切片起止时间）
      const parentsWithAnyChunks = Array.from(parentAggMap.values()).filter(p => p.chunks.length > 0)
      const chunkTimingMap = new Map<string, { startSec: number; endSec: number }>()
      const maxChunkIndexMap = new Map<string, number>()

      if (parentsWithAnyChunks.length > 0) {
        try {
          const placeholders = parentsWithAnyChunks.map(() => '?').join(',')
          const rows = this.db
            .prepare(
              `SELECT file_fingerprint, chunk_index, start_sec, end_sec
               FROM file_video_chunks
               WHERE file_fingerprint IN (${placeholders})`
            )
            .all(...parentsWithAnyChunks.map(p => p.parentFp)) as Array<{
            file_fingerprint: string
            chunk_index: number
            start_sec: number
            end_sec: number
          }>

          for (const r of rows) {
            const curMax = maxChunkIndexMap.get(r.file_fingerprint) ?? -1
            if (r.chunk_index > curMax) {
              maxChunkIndexMap.set(r.file_fingerprint, r.chunk_index)
            }
            chunkTimingMap.set(`${r.file_fingerprint}:c${r.chunk_index}`, {
              startSec: r.start_sec,
              endSec: r.end_sec
            })
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          logger.warn(LogCategory.VIRTUAL_DIRECTORY, '[HybridSearchArbiter] 查询 file_video_chunks 失败: ', msg)
        }
      }

      // 2. 优选每个视频的跳轴切片并执行时序聚类（Temporal NMS）与多切片返回：
      // 恪守第一性原理：
      // - 绝对门禁：切片 score 必须达到 TEMPORAL_CHUNK_MIN_CONFIDENCE，杜绝未命中切片凭空捏造时间戳；
      // - 显著性门禁：切片得分高出全视频均值至少 TEMPORAL_CHUNK_MIN_PROMINENCE，证明为瞬态高光实体而非背景色偏；
      // - 时序聚类合并（Temporal NMS）：相邻或重叠片段（<= 3.0s 间隔）合并为单连续时段，保留波峰相似度；
      // - 离散时段保留：间隔较远的不同高光段（如同一视频中 1:41 与 2:09 均出现目标跑车）同时保留并返回给前端！
      for (const agg of parentAggMap.values()) {
        if (agg.chunks.length === 0) continue

        const meanScore = agg.chunks.reduce((acc, c) => acc + c.score, 0) / agg.chunks.length
        const maxScore = Math.max(...agg.chunks.map(c => c.score))
        const peakProminence = maxScore - meanScore

        // 核心门禁 1：若视频全片切片得分平铺（peakProminence < TEMPORAL_CHUNK_MIN_PROMINENCE），
        // 证明没有任何切片能够突出于全局背景基线，属于纯背景噪声，彻底阻断跳轴与切片下发！
        const hasSignificantPeak = agg.chunks.length <= 2 || peakProminence >= TEMPORAL_CHUNK_MIN_PROMINENCE

        const validChunks = hasSignificantPeak
          ? agg.chunks.filter(c => {
              const prominence = c.score - meanScore
              const isConfident = c.score >= TEMPORAL_CHUNK_MIN_CONFIDENCE
              const isNearPeak = c.score >= maxScore - 0.015
              const isProminent = prominence >= TEMPORAL_CHUNK_MIN_PROMINENCE || isNearPeak
              return isConfident && isProminent
            })
          : []

        // 提取带有效 timing 的候选区间
        const candidateIntervals: Array<{
          chunkIndex: number
          startSec: number
          endSec: number
          similarity: number
        }> = []

        for (const vc of validChunks) {
          const timing = chunkTimingMap.get(`${agg.parentFp}:c${vc.chunkIndex}`)
          if (timing) {
            candidateIntervals.push({
              chunkIndex: vc.chunkIndex,
              startSec: timing.startSec,
              endSec: timing.endSec,
              similarity: vc.score
            })
          }
        }

        if (candidateIntervals.length > 0) {
          // =========================================================================
          // Phase 1：时序相邻对称加固版 Wing Trimming (侧翼剥离) 与受限合并 (Ticket 05)
          // =========================================================================
          const maxChunkIndex = maxChunkIndexMap.get(agg.parentFp)
          const mergedIntervals = applyWingTrimming(candidateIntervals, maxChunkIndex)

          // =========================================================================
          // Phase 2：Top-Peak 动态门禁与相似度降序重排 (高置信度核心镜头置顶)
          // =========================================================================
          const PEAK_MARGIN = 0.020 // 收紧至 0.020，杜绝与峰值相差过大的背景切片混入
          const minConfidence = TEMPORAL_CHUNK_MIN_CONFIDENCE

          // 找到当前视频合并后时段的最高峰值分
          const maxScore =
            mergedIntervals.length > 0 ? Math.max(...mergedIntervals.map(i => i.similarity)) : 0

          if (maxScore < minConfidence) {
            agg.matchedChunks = []
            agg.bestChunkIndex = undefined
            agg.bestChunkScore = undefined
          } else {
            // 1. 双向时序区间间隙保护 (Interval Gap)，避免前序铺垫或后置飞驰镜头被误杀
            const filteredChunks = mergedIntervals.filter(chunk => {
              if (chunk.similarity < minConfidence) return false
              if (chunk.similarity >= maxScore - PEAK_MARGIN) return true

              const isAdjacentToPeak = mergedIntervals.some(peak => {
                if (peak.similarity < maxScore - PEAK_MARGIN) return false
                // 无向区间间隙：计算真实时间差值，前后均支持
                const gap = Math.max(0, Math.max(chunk.startSec - peak.endSec, peak.startSec - chunk.endSec))
                return gap <= 3.0 // 收紧至 3.0s，只有紧邻高光波峰的同镜头延伸片段才予保全
              })
              if (isAdjacentToPeak) return true

              // 离散高光段保留（修复 Ticket 05 回归）：与所有峰值时段间隔 > 3.0s 的独立时段，
              // 是视频中另一处真实高光而非同镜头延伸（如同一视频 1:41 与 2:20 两处出现目标跑车），
              // 只要自身过绝对置信门禁（上方）与显著性门禁，就必须保留并返回前端，
              // 不因 PEAK_MARGIN 收紧至 0.020 被误杀——恪守上方「离散时段保留」设计承诺。
              return chunk.similarity - meanScore >= TEMPORAL_CHUNK_MIN_PROMINENCE
            })

            // 2. 最终输出结果严格按 similarity DESC 降序排列（分数并列时按时间先后升序），保证最高分片段排在最前
            filteredChunks.sort((a, b) => {
              const diff = b.similarity - a.similarity
              if (Math.abs(diff) > 0.0001) return diff
              return a.startSec - b.startSec
            })

            // 3. 严格区间与时序 NMS 抑制守卫：去重并抑制与更高分镜头重叠过大 (>= 4.0s) 的冗余次要帧
            const uniqueChunks: typeof filteredChunks = []
            for (const c of filteredChunks) {
              const hasHeavyOverlap = uniqueChunks.some(selected => {
                const overlapStart = Math.max(c.startSec, selected.startSec)
                const overlapEnd = Math.min(c.endSec, selected.endSec)
                const overlapLen = Math.max(0, overlapEnd - overlapStart)
                return (
                  overlapLen >= 4.0 ||
                  (Math.round(selected.startSec) === Math.round(c.startSec) &&
                    Math.round(selected.endSec) === Math.round(c.endSec)) ||
                  (selected.startSec === c.startSec && selected.endSec === c.endSec)
                )
              })
              if (!hasHeavyOverlap) {
                uniqueChunks.push(c)
              }
              if (uniqueChunks.length >= 4) break // 单个视频最多保留 4 个最具代表性的高光镜头
            }

            agg.matchedChunks = uniqueChunks
            if (uniqueChunks.length > 0) {
              agg.bestChunkIndex = uniqueChunks[0].chunkIndex
              agg.bestChunkScore = uniqueChunks[0].similarity
              agg.bestScore = Math.max(agg.bestScore, uniqueChunks[0].similarity)
            } else {
              agg.bestChunkIndex = undefined
              agg.bestChunkScore = undefined
            }
          }
        } else {
          // 降级兜底：若未匹配到 Timing 元数据（如单测 mock），保留 topChunk 索引与分数
          agg.chunks.sort((a, b) => b.score - a.score)
          const topChunk = agg.chunks[0]
          const prominence = topChunk.score - meanScore
          const isConfident = topChunk.score >= TEMPORAL_CHUNK_MIN_CONFIDENCE
          const isProminent = agg.chunks.length <= 2 || prominence >= TEMPORAL_CHUNK_MIN_PROMINENCE

          if (hasSignificantPeak && isConfident && isProminent) {
            agg.bestChunkIndex = topChunk.chunkIndex
            agg.bestChunkScore = topChunk.score
          } else {
            agg.bestChunkIndex = undefined
            agg.bestChunkScore = undefined
          }
        }
      }

      // 按最高得分降序重排
      const sortedParents = Array.from(parentAggMap.values()).sort(
        (a, b) => b.bestScore - a.bestScore
      )

      // 3. 组装 VectorMatch 输出
      const out: VectorMatch[] = []
      for (const [idx, p] of sortedParents.entries()) {
        let matchedChunk: VectorMatch['matchedChunk']
        if (p.matchedChunks && p.matchedChunks.length > 0) {
          const top = p.matchedChunks[0]
          matchedChunk = {
            chunkIndex: top.chunkIndex,
            startSec: top.startSec,
            endSec: top.endSec,
            similarity: top.similarity
          }
        } else if (p.bestChunkIndex !== undefined) {
          const timing = chunkTimingMap.get(`${p.parentFp}:c${p.bestChunkIndex}`)
          if (timing) {
            matchedChunk = {
              chunkIndex: p.bestChunkIndex,
              startSec: timing.startSec,
              endSec: timing.endSec,
              similarity: p.bestChunkScore ?? p.bestScore
            }
          }
        }
        out.push({
          fileFingerprint: p.parentFp,
          score: p.bestScore,
          rank: idx + 1,
          matchedChunk,
          matchedChunks: p.matchedChunks
        })
      }
      return out
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn(LogCategory.VIRTUAL_DIRECTORY, '[HybridSearchArbiter] 向量检索失败，降级为 FTS+文件名: ', msg)
      return null
    }
  }

  /** 真实目录 FS 快速文件名检索（返回 null 表示失败/熔断/未启用） */
  private async queryFastFs(
    workspaceDirectoryPath: string,
    keyword: string,
    poolSize: number
  ): Promise<OmniSearchFsItem[] | null> {
    if (this.fsBreaker.isOpen) return null
    if (!this.networkSignals) return []
    try {
      const resp = await omniClient.searchFastFs(workspaceDirectoryPath, keyword, poolSize)
      if (!resp || !Array.isArray(resp.items)) {
        this.fsBreaker.recordFailure()
        return null
      }
      this.fsBreaker.recordSuccess()
      return resp.items.slice(0, poolSize)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn(LogCategory.VIRTUAL_DIRECTORY, '[HybridSearchArbiter] FS 快速文件名检索失败: ', msg)
      return null
    }
  }

  /** 将指纹列表与基础过滤条件取交集返回允许集合 */
  private filterMembersFromBase(
    fingerprints: string[],
    whereClauses: string[],
    queryParams: any[]
  ): Set<string> {
    if (fingerprints.length === 0) return new Set<string>()
    const placeholders = fingerprints.map(() => '?').join(',')
    const extraWhere = whereClauses.length > 0 ? `AND ${whereClauses.join(' AND ')}` : ''
    const sql = `
      SELECT DISTINCT wf.file_fingerprint AS file_fingerprint
      FROM workspace_files wf
      WHERE wf.file_fingerprint IN (${placeholders})
        ${extraWhere}
    `
    try {
      const rows = this.db.prepare(sql).all(...fingerprints, ...queryParams) as Array<{
        file_fingerprint: string
      }>
      return new Set(rows.map(r => r.file_fingerprint))
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn(LogCategory.VIRTUAL_DIRECTORY, '[HybridSearchArbiter] 向量候选基础过滤失败，放行全部: ', msg)
      // 过滤失败时放行全部，主查询的分页 WHERE 仍会兜底过滤
      return new Set(fingerprints)
    }
  }

  /** 批量加载文件名（name/smart_name/path）用于 NameMatch 提升与 FS 去重 */
  private queryNameMap(
    fileFingerprints: string[]
  ): Map<string, { name?: string; smartName?: string; path?: string }> {
    const map = new Map<string, { name?: string; smartName?: string; path?: string }>()
    if (fileFingerprints.length === 0) return map
    const placeholders = fileFingerprints.map(() => '?').join(',')
    const sql = `
      SELECT wf.file_fingerprint AS file_fingerprint,
             wf.name AS name,
             f.smart_name AS smart_name,
             wf.path AS path
      FROM workspace_files wf
      LEFT JOIN files f ON wf.file_fingerprint = f.file_fingerprint
      WHERE wf.file_fingerprint IN (${placeholders})
    `
    try {
      const rows = this.db.prepare(sql).all(...fileFingerprints) as Array<{
        file_fingerprint: string
        name: string | null
        smart_name: string | null
        path: string | null
      }>
      for (const r of rows) {
        map.set(r.file_fingerprint, {
          name: r.name ?? undefined,
          smartName: r.smart_name ?? undefined,
          path: r.path ?? undefined
        })
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn(LogCategory.VIRTUAL_DIRECTORY, '[HybridSearchArbiter] 文件名映射查询失败: ', msg)
    }
    return map
  }
}