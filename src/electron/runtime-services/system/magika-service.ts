/**
 * Magika Service - AI 驱动的文件类型检测服务
 * 全面集成 firefly-omni Rust 神经网络识别，具备完整的 7 项元数据协议与扩展名降级兜底
 */

import * as path from 'path'
import { LogCategory, logger } from '@firefly/shared'
import { FileCategory } from '@firefly/types'
import { omniService } from './omni-service'

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
   * 检测文件类型 (优先通过 Omni 原生服务识别)
   */
  public async identifyFile(filePath: string): Promise<FileCategory> {
    try {
      const result = await omniService.identifyMagika(filePath)
      if (result && result.label) {
        return result
      }
    } catch (err) {
      logger.debug(LogCategory.SYSTEM, `[Magika] Omni 服务识别异常: ${filePath}`, err)
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
      label: ext || 'bin',
      mime_type: 'application/octet-stream',
      score: 0
    }
  }
}

export const magikaService = MagikaService.getInstance()
