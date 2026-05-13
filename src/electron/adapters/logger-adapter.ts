/**
 * 日志记录器适配器实现
 * 将日志功能适配到核心引擎
 */

import { ILoggerAdapter } from '@yonuc/core-engine'
import { logger, LogCategory } from '@yonuc/shared'

/**
 * 日志记录器适配器
 */
export class LoggerAdapter implements ILoggerAdapter {
  info(category: string, message: string, ...args: any[]): void {
    logger.info(this.mapCategory(category), message, ...args)
  }

  warn(category: string, message: string, ...args: any[]): void {
    logger.warn(this.mapCategory(category), message, ...args)
  }

  error(category: string, message: string, ...args: any[]): void {
    logger.error(this.mapCategory(category), message, ...args)
  }

  debug(category: string, message: string, ...args: any[]): void {
    logger.debug(this.mapCategory(category), message, ...args)
  }

  /**
   * 映射日志类别
   */
  private mapCategory(category: string): LogCategory {
    // 将引擎的字符串类别映射到应用的LogCategory枚举
    const categoryMap: Record<string, LogCategory> = {
      CoreEngine: LogCategory.ANALYSIS_QUEUE,
      AnalysisQueue: LogCategory.ANALYSIS_QUEUE,
      DimensionService: LogCategory.DIMENSION_SERVICE,
      AIService: LogCategory.AI_SERVICE,
      FileAnalysis: LogCategory.FILE_ANALYSIS,
    }

    return categoryMap[category] || LogCategory.ANALYSIS_QUEUE
  }
}

/**
 * 创建日志记录器适配器实例
 */
export function createLoggerAdapter(): ILoggerAdapter {
  return new LoggerAdapter()
}
