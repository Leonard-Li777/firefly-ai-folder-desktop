/**
 * Magika Service - AI 驱动的文件类型检测服务
 * 基于 Node.js 原生 ONNX 模型 (@google/magika) 实现高精度文件识别
 */

import * as path from 'path'
import { LogCategory, logger } from '@firefly/shared'
import { FileCategory } from '@firefly/types'

export class MagikaService {
  private static instance: MagikaService

  private constructor() {}

  public static getInstance(): MagikaService {
    if (!MagikaService.instance) {
      MagikaService.instance = new MagikaService()
    }
    return MagikaService.instance
  }

  /**
   * 检测文件类型
   */
  public async identifyFile(filePath: string): Promise<FileCategory> {
    try {
      const { unifiedWorkerManager } = await import('./unified-worker-service')
      const result = await unifiedWorkerManager.postJson<FileCategory>('/api/extract/identify', {
        filePath
      })
      if (result && result.label) {
        return result
      }
    } catch (err) {
      logger.debug(LogCategory.SYSTEM, `[Magika] 常驻微服务识别异常: ${filePath}`, err)
    }

    logger.debug(LogCategory.SYSTEM, `[Magika] 使用扩展名兜底: ${filePath}`)
    return this.getMockCategory(filePath)
  }

  /**
   * 批量检测文件类型
   */
  public async identifyFiles(filePaths: string[]): Promise<Map<string, FileCategory>> {
    const results = new Map<string, FileCategory>()
    for (const p of filePaths) {
      const category = await this.identifyFile(p)
      results.set(p, category)
    }
    return results
  }

  /**
   * 根据扩展名构造 Mock 返回 (兜底方案)
   */
  public getMockCategory(filePath: string): FileCategory {
    const ext = path.extname(filePath).toLowerCase().replace('.', '')
    logger.debug(
      LogCategory.SYSTEM,
      `[Magika] getMockCategory 兜底: ${filePath}, 扩展名: ${ext || '(无)'}`
    )
    return {
      description: '',
      extensions: [ext],
      group: '',
      is_text: true,
      label: '',
      mime_type: '',
      score: 0
    }
  }
}

export const magikaService = MagikaService.getInstance()
