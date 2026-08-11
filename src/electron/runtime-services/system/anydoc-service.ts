import { toMarkdown } from '@firecrawl/anydoc'
import { LogCategory, logger } from '@firefly/shared'

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
   * Extract markdown content and image assets from a document file using @firecrawl/anydoc
   */
  public async extract(filePath: string): Promise<AnydocResult> {
    logger.info(LogCategory.ANALYSIS_QUEUE, `[AnydocService] 开始提取: ${filePath}`)

    try {
      const markdown = await toMarkdown(filePath)
      const content = typeof markdown === 'string' ? markdown : (markdown as any)?.content || ''

      return {
        content,
        assets: []
      }
    } catch (error: any) {
      // anydoc 文档约定：unsupported（不支持的格式，如 .lnk 快捷方式）/ encrypted（加密文档）
      // 属于正常跳过场景，记录 warn 即可，避免对每个不支持的文件刷 error 日志
      const code = (error as any)?.code
      if (code === 'unsupported' || code === 'encrypted') {
        logger.warn(
          LogCategory.ANALYSIS_QUEUE,
          `[AnydocService] 跳过不支持的文件 (${filePath}): ${error?.message || code}`
        )
      } else {
        logger.error(LogCategory.ANALYSIS_QUEUE, `[AnydocService] 提取异常 (${filePath}):`, error)
      }
      return {
        content: '',
        assets: []
      }
    }
  }
}

export const anydocService = AnydocService.getInstance()
