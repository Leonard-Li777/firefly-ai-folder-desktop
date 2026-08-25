import { omniService } from '../omni-service'
import { OCRRequestOptions, OCRResult } from './types'

export class OCRService {
  private static instance: OCRService

  private constructor() {}

  public static getInstance(): OCRService {
    if (!OCRService.instance) {
      OCRService.instance = new OCRService()
    }
    return OCRService.instance
  }

  public async ensureLoaded(_modelType: string = 'tiny'): Promise<void> {}

  /**
   * 图像文字 OCR 识别 (由 Omni 原生微服务提供)
   */
  public async recognize(
    input: string | Buffer,
    _options?: OCRRequestOptions
  ): Promise<OCRResult> {
    const tStart = Date.now()
    if (typeof input === 'string') {
      try {
        const omniData = await omniService.extract(input)
        return {
          text: omniData?.markdown_content?.trim() || '',
          confidence: 0.95,
          durationMs: Date.now() - tStart
        }
      } catch {}
    }

    return {
      text: '',
      confidence: 0,
      durationMs: Date.now() - tStart
    }
  }
}

export const ocrService = OCRService.getInstance()
