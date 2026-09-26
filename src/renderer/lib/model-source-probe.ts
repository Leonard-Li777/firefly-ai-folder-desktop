/**
 * 模型源网络自适应探测（Issue 0046 §3）
 *
 * 背景：国内用户直连 HuggingFace 频繁超时，海外用户直连 ModelScope 体验不佳。
 * 高维修正开关引导跳转到萤核AI引擎模型页时，需要先探明当前网络能顺畅访问哪个源，
 * 再自动切换并聚焦目标模型。
 *
 * 实现说明：渲染进程跨域探测使用 `mode: 'no-cors'`（opaque 响应）。
 * 该模式下「网络层可达」即 resolve、「DNS/连接失败」即 reject，
 * 足以判定可达性，且无需目标站点返回 CORS 头。
 */

/** 模型源标识（与 `model-source.ts` 的 `source` 字段、引擎侧 source 枚举对齐） */
export type ModelSourceId = 'modelscope' | 'huggingface'

export interface ModelSourceProbeResult {
  /** 探测得出的最优源（两源均不可达时回退 `modelscope`） */
  source: ModelSourceId
  /** ModelScope 是否可达 */
  modelscope: boolean
  /** HuggingFace 是否可达 */
  huggingface: boolean
}

/** 探测端点：仅用于连通性判定，不下载任何内容 */
export const MODEL_SOURCE_PROBE_TARGETS: ReadonlyArray<{ id: ModelSourceId; url: string }> = [
  { id: 'modelscope', url: 'https://modelscope.cn/' },
  { id: 'huggingface', url: 'https://huggingface.co/' }
]

/** 默认探测超时（毫秒）：超时即视为不可达，避免阻塞引导跳转 */
export const MODEL_SOURCE_PROBE_TIMEOUT_MS = 3000

/** 单源可达性探测 */
export async function probeSourceReachable(
  url: string,
  timeoutMs: number = MODEL_SOURCE_PROBE_TIMEOUT_MS
): Promise<boolean> {
  try {
    await fetch(url, {
      method: 'GET',
      mode: 'no-cors',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs)
    })
    return true
  } catch {
    return false
  }
}

/**
 * 探测并选出最优模型源。
 *
 * 判定顺序：ModelScope 可达 → modelscope；否则 HuggingFace 可达 → huggingface；
 * 两者皆不可达 → 回退 modelscope（保持与国内默认一致，不改变用户现状）。
 */
export async function probeModelSource(
  timeoutMs: number = MODEL_SOURCE_PROBE_TIMEOUT_MS
): Promise<ModelSourceProbeResult> {
  const [modelscope, huggingface] = await Promise.all([
    probeSourceReachable(MODEL_SOURCE_PROBE_TARGETS[0].url, timeoutMs),
    probeSourceReachable(MODEL_SOURCE_PROBE_TARGETS[1].url, timeoutMs)
  ])

  const source: ModelSourceId = modelscope ? 'modelscope' : huggingface ? 'huggingface' : 'modelscope'

  return { source, modelscope, huggingface }
}

/** 模型源 → 桌面端下载镜像配置值（`app.DOWNLOAD_MIRROR`） */
export function modelSourceToDownloadMirror(source: ModelSourceId): 'cn' | 'global' {
  return source === 'huggingface' ? 'global' : 'cn'
}
