/**
 * 日志记录器适配器实现
 * 将日志功能适配到核心引擎
 */

import { ILoggerAdapter } from '@firefly/core-engine'
import { logger, LogCategory } from '@firefly/shared'

/**
 * 日志记录器适配器
 */
export class LoggerAdapter implements ILoggerAdapter {
  info(category: LogCategory, message: string, ...args: any[]): void {
    logger.info(this.mapCategory(category), message, ...args)
  }

  warn(category: LogCategory, message: string, ...args: any[]): void {
    logger.warn(this.mapCategory(category), message, ...args)
  }

  error(category: LogCategory, message: string, ...args: any[]): void {
    logger.error(this.mapCategory(category), message, ...args)
  }

  debug(category: LogCategory, message: string, ...args: any[]): void {
    logger.debug(this.mapCategory(category), message, ...args)
  }

  /**
   * 映射日志类别
   */
  private mapCategory(category: LogCategory): LogCategory {
    // 标准 LogCategory 枚举直接透传
    return category
  }
}

/**
 * 创建日志记录器适配器实例
 */
export function createLoggerAdapter(): ILoggerAdapter {
  return new LoggerAdapter()
}
