/**
 * 高维修正（Stage 5）共享常量（Issue 0046）
 *
 * 前后端共享：主进程（引擎托管 / 高维修正流水线）与渲染进程（设置页未安装预警、
 * 模型页深链聚焦）都需要同一份模型标识与关键词，故收敛到 `src/shared`。
 */

/** WeMM 多模态嵌入模型的 ModelScope 仓库标识（`model-source.ts` 双轨注册之一） */
export const WEMM_MODEL_ID_MODELSCOPE = 'huangyusi/WeMM-Embedding-2B-GGUF:Q4_K_M'

/** WeMM 多模态嵌入模型的 HuggingFace 仓库标识（`model-source.ts` 双轨注册之一） */
export const WEMM_MODEL_ID_HUGGINGFACE = 'Weidows/WeMM-Embedding-2B-GGUF:Q4_K_M'

/**
 * 模型安装探针关键词（宽松匹配）。
 *
 * 引擎 `/api/models` 对磁盘扫描到的模型返回 `id` = GGUF 文件名主干（如
 * `WeMM-Embedding-2B-Q4_K_M`），而非仓库 id，故用仓库尾段做包含匹配。
 */
export const HIGH_DIM_MODEL_KEYWORDS: string[] = ['wemm-embedding-2b', 'wemm']

/** 深链聚焦关键词：引擎模型面板据此滚动聚焦并呼吸高亮目标行 */
export const HIGH_DIM_MODEL_FOCUS_KEYWORD = 'WeMM-Embedding-2B'

/**
 * 高维修正使用的 WeMM 嵌入服务端口（规范声明的固定回退端口）。
 *
 * 注意：`38200` 已被 Omni 服务占用（`APP_PORTS.OMNI_SERVER`），不可复用。
 * 运行时优先复用 Tier 2 引擎（firefly-ai-engine，`APP_PORTS.LLAMA_LOCAL_SERVER` 38400 段）
 * 实际绑定的端口——见 `high-dim-adapters.ts` 的 `resolveWemmBaseUrl`；
 * 仅在引擎桥接不可用时回退到本端口（38400 段之后的空闲槽位）。
 */
export const WEMM_EMBEDDING_PORT = 38420

/** WeMM-Embedding 2B 输出的向量维度 */
export const WEMM_EMBEDDING_DIM = 2048

/** 高维修正缓冲灌库的单批上限（动态分页，避免万级历史数据冲垮队列表） */
export const HIGH_DIM_REFILL_BATCH_SIZE = 150

/** Stage 5 高维修正阶段编号（单一真相源在 `@firefly/types`，此处仅重导出） */
export { HIGH_DIM_CORRECTION_STAGE } from '@firefly/types'

/**
 * 高维修正受保护的标签来源分组（ADR-0045 §3 / ADR-0046 Consequences 出处保护）。
 *
 * 这些分组的标签关系由客观物理事实（fact）、多模态模型融合（fused）、
 * 纯视觉引擎（visual）或用户人工打标（user）产出，高维修正不得改写他人出处，
 * 写入时同键关系原样保留。
 */
export const HIGH_DIM_PROTECTED_TAG_GROUPS: string[] = ['fact', 'fused', 'visual', 'user']

/**
 * 高维修正允许剪枝剔除的标签来源分组（仅限 AI 派生分组，严禁包含 fact / user）。
 */
export const HIGH_DIM_PRUNABLE_TAG_GROUPS: string[] = ['fused', 'visual', 'ai']

/**
 * 高维修正受控标签入库的最低置信度阈值。
 * 低于该阈值的弱相关候选被判定为噪点并丢弃（Issue 0046 §5）。
 */
export const HIGH_DIM_MIN_TAG_CONFIDENCE = 0.55
