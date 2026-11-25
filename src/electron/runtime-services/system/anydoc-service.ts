import { LogCategory, logger } from '@firefly/shared'
import { omniService } from './omni-service'

export interface AnydocAsset {
  path: string
  name: string
  width?: number
  height?: number
  size?: number
}

export interface AnydocResult {
  content: string
  assets: AnydocAsset[]
  ocrText?: string
  audioTranscript?: string
  lrc?: string
  metadata?: any
  phash?: string
  benchmark?:
    | import('./omni-service').OmniBenchmarkResponse
    | import('./omni-service').OmniPerceptionBenchmarkResponse
  perception?: import('./omni-service').OmniPerceptionResponse
  /** 是否为降级结果（原生多模态感知失败 → 回退基础提取；视频将因此无视觉切片） */
  degraded?: boolean
  /** 降级原因（便于日志与上层判定，禁止静默降级） */
  degradedReason?: string
}

export class AnydocService {
  private static instance: AnydocService

  private constructor() {}

  public static getInstance(): AnydocService {
    if (!AnydocService.instance) {
      AnydocService.instance = new AnydocService()
    }
    return AnydocService.instance
  }

  /**
   * 提取文档文本与 Markdown 内容 (全面由 Omni Rust 原生微服务接管)
   */
  public async extract(
    filePath: string,
    options?: import('./omni-service').OmniExtractOptions
  ): Promise<AnydocResult> {
    try {
      const omniData = await omniService.extract(filePath, options)
      const rawContent = omniData?.markdown_content || ''
      const isBinaryNulSkip = rawContent.includes('[Binary File] NUL byte detected')
      return {
        content: isBinaryNulSkip ? '' : rawContent,
        assets: [],
        metadata: omniData?.metadata,
        phash: omniData?.phash,
        benchmark: omniData?.benchmark
      }
    } catch (error: any) {
      logger.warn(
        LogCategory.ANALYSIS_QUEUE,
        `[AnydocService] 提取异常 (${filePath}):`,
        error?.message || error
      )
      return {
        content: '',
        assets: []
      }
    }
  }

  /**
   * 原生多模态感知 (聚合元数据 + 物理事实 + 视觉标签 + 语音转录 + 逆地理)
   * 若 Omni 原生感知失败，平滑降级执行标准 extract
   */
  public async perceive(
    filePath: string,
    options?: import('./omni-service').OmniPerceptionOptions
  ): Promise<AnydocResult> {
    let failureReason: string | null = null
    try {
      const perception = await omniService.perceive(filePath, options)
      if (perception) {
        const rawContent = perception.markdown_content || ''
        const isBinaryNulSkip = rawContent.includes('[Binary File] NUL byte detected')
        const isVisualBudgetDegraded = perception.degraded === 'visual_skipped_budget'
        return {
          content: isBinaryNulSkip ? '' : rawContent,
          assets: [],
          ocrText: perception.ocr_text || undefined,
          audioTranscript: perception.asr || undefined,
          lrc:
            perception.lrc ||
            perception.metadata?.lrc ||
            perception.metadata?.audio?.lrc ||
            undefined,
          metadata: perception.metadata,
          phash: perception.phash,
          benchmark: perception.benchmark ? { ...perception.benchmark } : undefined,
          perception,
          ...(isVisualBudgetDegraded
            ? {
                degraded: true,
                degradedReason: perception.degraded_reason || 'budget_structural'
              }
            : {})
        }
      }
      // 返回 null 同样是失败（如引擎在视频推理中原生崩溃、自愈后仍不可用）。
      // 历史上这里直接静默回退 extract，导致「分析完成但搜不到切片」且日志无线索 —— 必须显式上报。
      failureReason = 'perceive_unavailable'
      logger.warn(
        LogCategory.ANALYSIS_QUEUE,
        `[AnydocService] 原生多模态感知返回空（引擎未就绪/推理失败），回退基础提取；视频将无法产出视觉切片: ${filePath}`
      )
    } catch (error: any) {
      failureReason = error?.message || 'perceive_error'
      logger.warn(
        LogCategory.ANALYSIS_QUEUE,
        `[AnydocService] 原生多模态感知异常 (${filePath})，回退至基础提取；视频将无法产出视觉切片:`,
        error?.message || error
      )
    }

    // 感知失败回退基础提取时，必须把逐请求覆盖参数一并透传，杜绝回退通道丢失工作区配置。
    // `degraded` 让上层能识别「元数据成功但视觉/切片缺失」，不再把降级当作完整成功。
    const fallback = await this.extract(filePath, options)
    return {
      ...fallback,
      degraded: true,
      degradedReason: failureReason ?? 'perceive_unavailable'
    }
  }
}

export const anydocService = AnydocService.getInstance()
