/**
 * 混合检索常量与权重表（Hybrid Search Constants）
 * 自 HybridSearchArbiter.ts 按职责拆出：RRF 平滑常量、各路权重、CLIP 系列阈值/超时/熔断参数、
 * 编码器通道过滤器、BM25 列权与中文短词倒排阈值。仅常量，不含任何运行逻辑。
 */

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
export const MIN_GENERIC_VECTOR_SCORE = 0.3

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
 * CLIP 第 5 路**零成本前置**门禁（纯函数）。
 *
 * 这三条判定不需要任何网络往返，因此必须在探活**之前**执行：
 * 否则档位不对 / 开关关闭 / 非中文界面时仍会打一次 `/health`，违反 AC1「零请求」。
 */
export const ENCODER_FILTER_CHINESE_CLIP = [2] as const
export const ENCODER_FILTER_MOBILE_CLIP = [3] as const
/**
 * CLIP 文本 query 是否剥离中文结构助词（`的/之/得/地`）。
 *
 * A/B 定稿在工单 14：默认 **false**（保留修饰词），因为 CLIP 文本塔在自然语言上训练，
 * 「红色的跑车」正是它优于 Bekko 的地方；剥离后与既有向量路的清洗口径趋同，第 5 路就没有独立价值。
 * 保留开关是为了让 14 能用同一份夹具跑 A/B 并回填结论，而不是把猜测写死。
 */
export const CLIP_TEXT_STRIP_PARTICLES = false
/** BM25 完整 10 列列权（第 0 列为 file_fingerprint UNINDEXED 赋 0.0，随后 9 列对齐 files_fts 架构：name, smart_name, description, content, multimodal_content, ocr, lrc, asr, tags） */
export const HYBRID_BM25_COLUMN_WEIGHTS = [
  0.0, 4.0, 4.0, 3.0, 3.0, 3.5, 3.5, 3.0, 3.5, 3.5
] as const

/**
 * 中文双字短词倒排点查快道的高置信度采纳阈值（Ticket 09 / Spec §4.8）：
 * 点查命中数 >= 此阈值时直接采用倒排召回集合（跳过 9 列 LIKE 全表扫描）；
 * 低于此阈值时无缝并入 LIKE 安全降级候选，保证低频生僻短词不漏召回。
 */
export const SHORT_HAN_INVERTED_MIN_HITS = 5

/** 中文双字纯汉字短词判定（FTS5 trigram 物理上无法为 <3 字符建索引的唯一快道适用窗口） */
export const SHORT_HAN_TOKEN_PATTERN = /^[\u4e00-\u9fa5]{2}$/

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