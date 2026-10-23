/**
 * EmbeddingGemma MRL 维度契约
 * 依据 docs/developer/architecture/vector-semantic-text-unified-scheme.md §3.4：
 * gemma_unified 只允许 256/512/768 三个合法槽位；1024 不是合法槽位，
 * 引擎在 HAC/检索侧会回退到配置维度，desktop 侧同样禁止从档位字符串嗅探出 1024。
 */

/** gemma_unified 合法 MRL 维度白名单 */
export const GEMMA_MRL_DIMS = [256, 512, 768] as const

/** gemma_unified 合法 MRL 维度 */
export type GemmaMrlDim = (typeof GEMMA_MRL_DIMS)[number]

/** 判断给定数值是否为合法 MRL 维度槽位 */
export function isGemmaMrlDim(dim: unknown): dim is GemmaMrlDim {
  return dim === 256 || dim === 512 || dim === 768
}

/**
 * 将配置的 EMBEDDING_MRL_DIMENSION 归一化为合法槽位：
 * 256/768 原样返回，其余取值（含 512 与历史遗留的 1024）一律回退 512。
 */
export function normalizeGemmaMrlDim(dim: number | null | undefined): GemmaMrlDim {
  return dim === 256 || dim === 768 ? dim : 512
}

/**
 * 解析 gemma_unified 档位下实际使用的向量维度：
 * - 调用方档位字符串显式带 256/768 时尊重之；1024 等非法维度字符串一律忽略；
 * - 其余情况以配置的 MRL 维度为准，非法配置回退 512。
 * 返回值恒为合法槽位，杜绝 1024 从档位字符串流入下游。
 */
export function resolveGemmaDim(
  aiProfile: string | null | undefined,
  configuredMrlDim: number | null | undefined
): GemmaMrlDim {
  if (aiProfile?.includes('256')) return 256
  if (aiProfile?.includes('768')) return 768
  return normalizeGemmaMrlDim(configuredMrlDim)
}
