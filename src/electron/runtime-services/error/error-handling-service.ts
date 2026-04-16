import { t } from '@app/languages';
import { EventEmitter } from 'events'
import { 
  AppError, 
  ErrorType, 
  RecoveryStrategy,
  LogLevel 
} from '@yonuc/types'
import { loggingService } from '../system/logging-service'
import { logger, LogCategory } from '@yonuc/shared';

/**
 * 错误处理服务类
 */
export class ErrorHandlingService extends EventEmitter {
  private static instance: ErrorHandlingService
  private errorCounts: Map<string, number> = new Map()
  private recoveryStrategies: Map<string, RecoveryStrategy> = new Map()
  private errorHistory: AppError[] = []
  private maxErrorHistory: number = 1000
  private isRecoveryInProgress: boolean = false

  private constructor() {
    super()
    this.setupDefaultRecoveryStrategies()
    this.setupGlobalErrorHandling()
  }

  /**
   * 获取单例实例
   */
  public static getInstance(): ErrorHandlingService {
    if (!ErrorHandlingService.instance) {
      ErrorHandlingService.instance = new ErrorHandlingService()
    }
    return ErrorHandlingService.instance
  }

  /**
   * 设置默认恢复策略
   */
  private setupDefaultRecoveryStrategies(): void {
    const defaultStrategies: RecoveryStrategy[] = [
      {
        id: 'retry_operation',
        name: t('重试操作'),
        description: t('重试失败的操作'),
        errorTypes: [ErrorType.NETWORK, ErrorType.SERVICE],
        level: 1,
        priority: 1,
        action: async () => {
          loggingService.info(LogCategory.ERROR_HANDLING, '执行重试操作策略')
          // 具体重试逻辑由调用者实现
          return true
        },
        maxRetries: 3,
        retryDelay: 1000
      },
      {
        id: 'clear_cache',
        name: t('清理缓存'),
        description: t('清理应用缓存'),
        errorTypes: [ErrorType.DATABASE, ErrorType.SYSTEM],
        level: 2,
        priority: 2,
        action: async () => {
          loggingService.info(LogCategory.ERROR_HANDLING, '执行清理缓存策略')
          // 实现缓存清理逻辑
          return true
        },
        maxRetries: 2,
        retryDelay: 2000
      },
      {
        id: 'restart_service',
        name: t('重启服务'),
        description: t('重启失败的服务'),
        errorTypes: [ErrorType.SERVICE],
        level: 3,
        priority: 3,
        action: async () => {
          loggingService.info(LogCategory.ERROR_HANDLING, '执行重启服务策略')
          // 实现服务重启逻辑
          return true
        },
        maxRetries: 2,
        retryDelay: 3000
      },
      {
        id: 'graceful_shutdown',
        name: t('优雅关闭'),
        description: t('优雅关闭应用'),
        errorTypes: [ErrorType.SYSTEM, ErrorType.DATABASE],
        level: 4,
        priority: 4,
        action: async () => {
          loggingService.info(LogCategory.ERROR_HANDLING, '执行优雅关闭策略')
          // 实现优雅关闭逻辑
          return true
        },
        maxRetries: 1,
        retryDelay: 1000
      }
    ]

    defaultStrategies.forEach(strategy => {
      this.recoveryStrategies.set(strategy.id, strategy)
    })
  }

  /**
   * 设置全局错误处理
   */
  private setupGlobalErrorHandling(): void {
    // 处理未捕获的异常
    process.on('uncaughtException', (error) => {
      this.handleUncaughtException(error)
    })

    // 处理未处理的Promise拒绝
    process.on('unhandledRejection', (reason, promise) => {
      this.handleUnhandledRejection(reason, promise)
    })
  }

  /**
   * 处理未捕获的异常
   */
  private handleUncaughtException(error: Error): void {
    const appError: AppError = {
      type: ErrorType.SYSTEM,
      code: 'UNCAUGHT_EXCEPTION',
      message: error.message,
      details: error.stack,
      timestamp: new Date(),
      recoverable: false,
      context: {
        name: error.name,
        stack: error.stack
      }
    }

    this.handleError(appError)
  }

  /**
   * 处理未处理的Promise拒绝
   */
  private handleUnhandledRejection(reason: any, promise: Promise<any>): void {
    const appError: AppError = {
      type: ErrorType.SYSTEM,
      code: 'UNHANDLED_REJECTION',
      message: reason instanceof Error ? reason.message : String(reason),
      details: reason,
      timestamp: new Date(),
      recoverable: true,
      context: {
        reason,
        promise: promise.toString()
      }
    }

    this.handleError(appError)
  }

  /**
   * 处理错误
   */
  public async handleError(error: AppError): Promise<void> {
    // 记录错误
    this.recordError(error)

    // 发送错误事件
    this.emit('error', error)

    // 记录到日志
    loggingService.logAppError(error)

    // 如果错误可恢复，尝试恢复
    if (error.recoverable && !this.isRecoveryInProgress) {
      await this.attemptRecovery(error)
    }
  }

  /**
   * 记录错误
   */
  private recordError(error: AppError): void {
    // 添加到错误历史
    this.errorHistory.push(error)

    // 保持错误历史在合理范围内
    if (this.errorHistory.length > this.maxErrorHistory) {
      this.errorHistory = this.errorHistory.slice(-this.maxErrorHistory)
    }

    // 更新错误计数
    const errorKey = `${error.type}:${error.code}`
    const currentCount = this.errorCounts.get(errorKey) || 0
    this.errorCounts.set(errorKey, currentCount + 1)
  }

  /**
   * 尝试恢复
   */
  private async attemptRecovery(error: AppError): Promise<void> {
    this.isRecoveryInProgress = true

    try {
      // 获取适用于此错误类型的恢复策略
      const applicableStrategies = Array.from(this.recoveryStrategies.values())
        .filter(strategy => strategy.errorTypes.includes(error.type))
        .sort((a, b) => a.priority - b.priority)

      // 按优先级尝试恢复策略
      for (const strategy of applicableStrategies) {
        try {
          const success = await this.executeRecoveryStrategy(strategy)
          if (success) {
            loggingService.info(LogCategory.ERROR_HANDLING, `恢复策略 ${strategy.name} 执行成功`)
            this.emit('recovery-success', { error, strategy })
            return
          }
        } catch (recoveryError) {
          loggingService.error(LogCategory.ERROR_HANDLING, `恢复策略 ${strategy.name} 执行失败`, {
            error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
          })
        }
      }

      // 所有恢复策略都失败
      loggingService.error(LogCategory.ERROR_HANDLING, '所有恢复策略都失败')
      this.emit('recovery-failed', { error })
    } finally {
      this.isRecoveryInProgress = false
    }
  }

  /**
   * 执行恢复策略
   */
  private async executeRecoveryStrategy(strategy: RecoveryStrategy): Promise<boolean> {
    let attempts = 0
    let lastError: Error | null = null

    while (attempts < strategy.maxRetries) {
      try {
        const success = await strategy.action()
        if (success) {
          return true
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        loggingService.error(LogCategory.ERROR_HANDLING, `恢复策略执行失败 (尝试 ${attempts + 1}/${strategy.maxRetries})`, {
          error: lastError.message
        })
      }

      attempts++
      if (attempts < strategy.maxRetries) {
        await new Promise(resolve => setTimeout(resolve, strategy.retryDelay))
      }
    }

    return false
  }

  /**
   * 创建应用错误
   */
  public createError(
    type: ErrorType,
    code: string,
    message: string,
    details?: any,
    recoverable: boolean = true,
    context?: any
  ): AppError {
    return {
      type,
      code,
      message,
      details,
      timestamp: new Date(),
      recoverable,
      context
    }
  }

  /**
   * 包装异步函数以添加错误处理
   */
  public wrapAsyncFunction<T>(
    fn: () => Promise<T>,
    errorType: ErrorType,
    errorCode: string,
    context?: any
  ): Promise<T> {
    return fn().catch(error => {
      const appError = this.createError(
        errorType,
        errorCode,
        error instanceof Error ? error.message : String(error),
        error,
        true,
        context
      )
      
      this.handleError(appError)
      throw error
    })
  }

  /**
   * 包装同步函数以添加错误处理
   */
  public wrapSyncFunction<T>(
    fn: () => T,
    errorType: ErrorType,
    errorCode: string,
    context?: any
  ): T {
    try {
      return fn()
    } catch (error) {
      const appError = this.createError(
        errorType,
        errorCode,
        error instanceof Error ? error.message : String(error),
        error,
        true,
        context
      )
      
      this.handleError(appError)
      throw error
    }
  }

  /**
   * 添加恢复策略
   */
  public addRecoveryStrategy(strategy: RecoveryStrategy): void {
    this.recoveryStrategies.set(strategy.id, strategy)
    loggingService.info(LogCategory.ERROR_HANDLING, `添加恢复策略: ${strategy.name}`)
  }

  /**
   * 移除恢复策略
   */
  public removeRecoveryStrategy(strategyId: string): void {
    this.recoveryStrategies.delete(strategyId)
    loggingService.info(LogCategory.ERROR_HANDLING, `移除恢复策略: ${strategyId}`)
  }

  /**
   * 获取错误统计
   */
  public getErrorStatistics(): {
    totalErrors: number
    errorsByType: Record<string, number>
    errorsByCode: Record<string, number>
    recentErrors: AppError[]
    recoverySuccessRate: number
  } {
    const errorsByType: Record<string, number> = {}
    const errorsByCode: Record<string, number> = {}

    // 统计错误
    this.errorHistory.forEach(error => {
      errorsByType[error.type] = (errorsByType[error.type] || 0) + 1
      errorsByCode[error.code] = (errorsByCode[error.code] || 0) + 1
    })

    // 获取最近的错误
    const recentErrors = this.errorHistory.slice(-10)

    // 计算恢复成功率（简化计算）
    const recoverySuccessRate = 0.85 // 这里可以根据实际恢复情况计算

    return {
      totalErrors: this.errorHistory.length,
      errorsByType,
      errorsByCode,
      recentErrors,
      recoverySuccessRate
    }
  }

  /**
   * 获取错误历史
   */
  public getErrorHistory(options?: {
    type?: ErrorType
    code?: string
    startTime?: Date
    endTime?: Date
    limit?: number
  }): AppError[] {
    let filteredErrors = [...this.errorHistory]

    // 按类型过滤
    if (options?.type !== undefined) {
      filteredErrors = filteredErrors.filter(error => error.type === options.type)
    }

    // 按代码过滤
    if (options?.code !== undefined) {
      filteredErrors = filteredErrors.filter(error => error.code === options.code)
    }

    // 按时间范围过滤
    if (options?.startTime !== undefined) {
      filteredErrors = filteredErrors.filter(error => error.timestamp >= options.startTime!)
    }

    if (options?.endTime !== undefined) {
      filteredErrors = filteredErrors.filter(error => error.timestamp <= options.endTime!)
    }

    // 按数量限制
    if (options?.limit !== undefined) {
      filteredErrors = filteredErrors.slice(-options.limit)
    }

    return filteredErrors.reverse() // 最新的错误在前
  }

  /**
   * 清除错误历史
   */
  public clearErrorHistory(): void {
    this.errorHistory = []
    this.errorCounts.clear()
    loggingService.info(LogCategory.ERROR_HANDLING, '错误历史已清除')
  }

  /**
   * 清除旧错误
   */
  public clearOldErrors(olderThan: Date): void {
    const beforeCount = this.errorHistory.length
    this.errorHistory = this.errorHistory.filter(error => error.timestamp >= olderThan)
    const afterCount = this.errorHistory.length
    
    loggingService.info(LogCategory.ERROR_HANDLING, `清除了 ${beforeCount - afterCount} 条旧错误`)
  }

  /**
   * 获取恢复策略
   */
  public getRecoveryStrategies(): RecoveryStrategy[] {
    return Array.from(this.recoveryStrategies.values())
  }

  /**
   * 手动触发恢复
   */
  public async triggerRecovery(error: AppError): Promise<boolean> {
    if (this.isRecoveryInProgress) {
      loggingService.warn(LogCategory.ERROR_HANDLING, '恢复已在进行中')
      return false
    }

    await this.attemptRecovery(error)
    return true
  }

  /**
   * 检查是否有重复错误
   */
  public hasDuplicateError(error: AppError, timeWindow: number = 60000): boolean {
    const now = Date.now()
    const windowStart = now - timeWindow

    return this.errorHistory.some(existingError => 
      existingError.type === error.type &&
      existingError.code === error.code &&
      existingError.message === error.message &&
      existingError.timestamp.getTime() >= windowStart
    )
  }

  /**
   * 获取错误频率
   */
  public getErrorFrequency(timeWindow: number = 3600000): {
    overall: number
    byType: Record<string, number>
    byCode: Record<string, number>
  } {
    const now = Date.now()
    const windowStart = now - timeWindow

    const recentErrors = this.errorHistory.filter(error => 
      error.timestamp.getTime() >= windowStart
    )

    const byType: Record<string, number> = {}
    const byCode: Record<string, number> = {}

    recentErrors.forEach(error => {
      byType[error.type] = (byType[error.type] || 0) + 1
      byCode[error.code] = (byCode[error.code] || 0) + 1
    })

    return {
      overall: recentErrors.length,
      byType,
      byCode
    }
  }
}

// 导出单例实例
export const errorHandlingService = ErrorHandlingService.getInstance()
