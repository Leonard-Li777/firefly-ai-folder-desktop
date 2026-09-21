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
  benchmark?: import('./omni-service').OmniBenchmarkResponse
  perception?: import('./omni-service').OmniPerceptionResponse
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
  public async extract(filePath: string, _timeoutMs: number = 60000): Promise<AnydocResult> {
    try {
      const omniData = await omniService.extract(filePath)
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
    try {
      const perception = await omniService.perceive(filePath, options)
      if (perception) {
        const rawContent = perception.markdown_content || ''
        const isBinaryNulSkip = rawContent.includes('[Binary File] NUL byte detected')
        return {
          content: isBinaryNulSkip ? '' : rawContent,
          assets: [],
          ocrText: perception.ocr_text || undefined,
          audioTranscript: perception.audio_transcript || undefined,
          lrc: perception.lrc || perception.metadata?.lrc || perception.metadata?.audio?.lrc || undefined,
          metadata: perception.metadata,
          phash: perception.phash,
          benchmark: perception.benchmark
            ? {
                total_ms: perception.benchmark.total_ms,
                magika_ms: perception.benchmark.magika_ms,
                metadata_ms: perception.benchmark.metadata_ms,
                tag_ms: perception.benchmark.tag_ms,
                text_ms: perception.benchmark.text_ms,
                ocr_ms: perception.benchmark.ocr_ms
              }
            : undefined,
          perception
        }
      }
    } catch (error: any) {
      logger.warn(
        LogCategory.ANALYSIS_QUEUE,
        `[AnydocService] 原生多模态感知异常 (${filePath})，回退至基础提取:`,
        error?.message || error
      )
    }

    return this.extract(filePath, options?.timeoutMs)
  }
}

export const anydocService = AnydocService.getInstance()
