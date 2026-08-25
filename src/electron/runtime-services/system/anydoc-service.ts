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
      return {
        content: omniData?.markdown_content || '',
        assets: []
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
}

export const anydocService = AnydocService.getInstance()
