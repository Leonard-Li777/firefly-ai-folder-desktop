import { AppError, ErrorType, RecoveryStrategy, AIServiceError, AIErrorType } from '@firefly/types'
import { loggingService } from '../system/logging-service'
import { ConfigOrchestrator } from '../../config/config-orchestrator'
import { logger, LogCategory, ErrorNormalizer, ICompleteErrorInfo } from '@firefly/shared'
import { t } from '../../../languages'
import { BrowserWindow } from 'electron'
import { EventEmitter } from 'events'
import { LlamaIndexAIService } from '@firefly/electron-llamaIndex-service'

/**
 * AI服务错误接口
 */
export interface IAIError extends AppError {
  /** AI错误类型 */
  aiErrorType: AIErrorType
  /** 错误严重程度 */
  severity: 'low' | 'medium' | 'high' | 'critical'
  /** 用户友好的错误消息 */
  userMessage: string
  /** 建议的解决方案 */
  solutions: string[]
  /** 错误发生的组件 */
  component: string
  /** 是否需要用户干预 */
  requiresUserAction: boolean
}

/**
 * 错误恢复结果接口
 */
export interface IRecoveryResult {
  /** 是否成功恢复 */
  success: boolean
  /** 使用的恢复策略 */
  strategy?: RecoveryStrategy
  /** 恢复消息 */
  message: string
  /** 恢复耗时（毫秒） */
  duration: number
  /** 是否需要重启服务 */
  requiresRestart: boolean
}

/**
 * AI错误处理器类
 */
export class AIErrorHandler extends EventEmitter {
  private static instance: AIErrorHandler
  private errorHistory: IAIError[] = []
  private recoveryStrategies: Map<AIErrorType, RecoveryStrategy[]> = new Map()
  private maxErrorHistory = 1000
  private isRecovering = false

  private constructor() {
    super()
    this.initializeRecoveryStrategies()
  }

  /**
   * 获取单例实例
   */
  public static getInstance(): AIErrorHandler {
    if (!AIErrorHandler.instance) {
      AIErrorHandler.instance = new AIErrorHandler()
    }
    return AIErrorHandler.instance
  }

  /**
   * 初始化恢复策略
   */
  private initializeRecoveryStrategies(): void {
    // 服务器错误恢复策略 - 禁用自动重试
    // 启动失败时保持错误状态，等待用户手动重试或按需初始化（chat接口调用时）
    this.addRecoveryStrategy(AIErrorType.SERVER_START_FAILED, {
      id: 'restart-server-downgrade',
      name: '重启并降级',
      description: '服务器启动失败，需要用户手动重试',
      errorTypes: [ErrorType.SERVICE],
      level: 1,
      priority: 1,
      action: async () => {
        loggingService.warn(
          LogCategory.AI_ERROR_HANDLER,
          'AI服务启动失败，不进行自动重试，等待用户手动重试'
        )
        // 返回 false 表示恢复失败，不触发重试
        return false
      },
      maxRetries: 0, // 禁用自动重试
      retryDelay: 0
    })

    this.addRecoveryStrategy(AIErrorType.SERVER_NOT_RESPONDING, {
      id: 'check-server-health',
      name: '检查服务器健康状态',
      description: '检查服务器是否响应',
      errorTypes: [ErrorType.SERVICE],
      level: 1,
      priority: 1,
      action: async () => {
        loggingService.info(LogCategory.AI_ERROR_HANDLER, '执行服务器健康检查策略')
        try {
          const aiService = LlamaIndexAIService.getInstance()
          if (aiService) {
            const healthy = await aiService.healthCheck()
            if (!healthy) {
              loggingService.warn(
                LogCategory.AI_ERROR_HANDLER,
                '健康检查显示服务不响应，尝试重启服务'
              )
              await aiService.restart()
            }
            return true
          }
          return false
        } catch (error) {
          loggingService.error(LogCategory.AI_ERROR_HANDLER, '执行健康检查策略失败:', error)
          return false
        }
      },
      maxRetries: 3,
      retryDelay: 2000
    })

    // 模型错误恢复策略（含自动降级逻辑）
    this.addRecoveryStrategy(AIErrorType.MODEL_LOAD_FAILED, {
      id: 'reload-model-downgrade',
      name: '重新加载并降级',
      description: '尝试降级加速模式并重新加载AI模型',
      errorTypes: [ErrorType.SERVICE],
      level: 1,
      priority: 1,
      action: async () => {
        loggingService.info(LogCategory.AI_ERROR_HANDLER, '执行模型重新加载与自动降级策略')
        try {
          const aiService = LlamaIndexAIService.getInstance()
          if (!aiService) return false

          const config = ConfigOrchestrator.getInstance()
          const isForceCpu = config.getValue<boolean>('AI_ENGINE_FORCE_CPU_MODE')
          const isCompatible = config.getValue<boolean>('AI_ENGINE_DRIVER_COMPATIBLE_MODE')

          const currentAcc = config.getValue<string>('SELECTED_ACCELERATION') || 'auto'
          const isDarwin = process.platform === 'darwin'

          // 定义各加速层的下一步降级方向
          let nextAcc = 'cpu'
          if (currentAcc === 'openvino') {
            nextAcc = 'sycl'
          } else if (
            currentAcc === 'sycl' ||
            currentAcc === 'cuda' ||
            currentAcc === 'hip' ||
            currentAcc === 'rocm'
          ) {
            nextAcc = isDarwin ? 'cpu' : 'vulkan'
          } else if (currentAcc === 'metal' || currentAcc === 'vulkan') {
            nextAcc = 'cpu'
          }

          loggingService.warn(
            LogCategory.AI_ERROR_HANDLER,
            `模型/驱动崩溃或加载失败，正在自动降级加速模式: ${currentAcc} -> ${nextAcc}`
          )

          const updatePayload: Record<string, any> = {
            SELECTED_ACCELERATION: nextAcc
          }

          if (nextAcc === 'vulkan' || nextAcc === 'sycl') {
            updatePayload.AI_ENGINE_DRIVER_COMPATIBLE_MODE = true
            updatePayload.AI_ENGINE_FORCE_CPU_MODE = false
          } else if (nextAcc === 'cpu') {
            updatePayload.AI_ENGINE_FORCE_CPU_MODE = true
            updatePayload.AI_ENGINE_DRIVER_COMPATIBLE_MODE = false
          } else {
            updatePayload.AI_ENGINE_DRIVER_COMPATIBLE_MODE = false
            updatePayload.AI_ENGINE_FORCE_CPU_MODE = false
          }

          await config.updateValues(updatePayload, { source: 'runtime', preventAutoReload: true })

          // 重启服务以应用新配置并重新加载模型
          await aiService.restart()
          return true
        } catch (error) {
          loggingService.error(LogCategory.AI_ERROR_HANDLER, '执行自动降级策略失败:', error)
          return false
        }
      },
      maxRetries: 2,
      retryDelay: 3000
    })

    // 注意：GPU层数调整策略已被移除，因为新的配置系统不再直接管理GPU层数参数
    // 该参数现在由模型加载逻辑自动处理或使用默认值

    // 请求错误恢复策略
    this.addRecoveryStrategy(AIErrorType.REQUEST_TIMEOUT, {
      id: 'increase-timeout',
      name: '增加请求超时时间',
      description: '增加请求超时时间',
      errorTypes: [ErrorType.NETWORK],
      level: 2,
      priority: 2,
      action: async () => {
        loggingService.info(LogCategory.AI_ERROR_HANDLER, '执行增加超时时间策略')
        try {
          const currentTimeout =
            ConfigOrchestrator.getInstance().getValue<number>('AI_REQUEST_TIMEOUT')
          const newTimeout = Math.min(currentTimeout * 1.5, 300000) // 最大5分钟

          ConfigOrchestrator.getInstance().updateValue('AI_REQUEST_TIMEOUT', newTimeout)
          loggingService.info(
            LogCategory.AI_ERROR_HANDLER,
            `自动增加请求超时时间: ${currentTimeout} -> ${newTimeout}`
          )

          return true
        } catch (error) {
          loggingService.error(LogCategory.AI_ERROR_HANDLER, '增加超时时间失败', error)
          return false
        }
      },
      maxRetries: 1,
      retryDelay: 1000
    })

    // 连接错误恢复策略
    this.addRecoveryStrategy(AIErrorType.CONNECTION_FAILED, {
      id: 'retry-connection',
      name: '重试连接',
      description: '重试建立连接',
      errorTypes: [ErrorType.NETWORK],
      level: 1,
      priority: 1,
      action: async () => {
        loggingService.info(LogCategory.AI_ERROR_HANDLER, '执行重试连接策略')
        // 等待一段时间后重试
        await new Promise(resolve => setTimeout(resolve, 2000))
        return true
      },
      maxRetries: 5,
      retryDelay: 2000
    })

    // 磁盘空间不足恢复策略
    this.addRecoveryStrategy(AIErrorType.DISK_FULL, {
      id: 'check-disk-space',
      name: '检查磁盘空间',
      description: '检查并清理磁盘空间',
      errorTypes: [ErrorType.SYSTEM],
      level: 1,
      priority: 1,
      action: async () => {
        loggingService.info(LogCategory.AI_ERROR_HANDLER, '执行磁盘空间检查策略')
        // 磁盘空间不足通常需要用户手动清理，但可以尝试清理临时文件
        try {
          // 提示用户检查磁盘空间
          loggingService.warn(LogCategory.AI_ERROR_HANDLER, '磁盘空间不足，请检查并清理磁盘空间')
          return false // 需要用户干预，无法自动恢复
        } catch (error) {
          loggingService.error(LogCategory.AI_ERROR_HANDLER, '执行磁盘空间检查策略失败:', error)
          return false
        }
      },
      maxRetries: 1,
      retryDelay: 1000
    })

    loggingService.info(LogCategory.AI_ERROR_HANDLER, 'AI错误处理服务已启动')
  }

  /**
   * 添加恢复策略
   */
  private addRecoveryStrategy(errorType: AIErrorType, strategy: RecoveryStrategy): void {
    if (!this.recoveryStrategies.has(errorType)) {
      this.recoveryStrategies.set(errorType, [])
    }
    const strategies = this.recoveryStrategies.get(errorType)
    if (strategies) {
      strategies.push(strategy)
    }
  }

  /**
   * 创建AI错误
   */
  public createAIError(
    aiErrorType: AIErrorType,
    message: string,
    component: string,
    details?: unknown,
    originalError?: Error
  ): IAIError {
    const errorInfo = this.getErrorInfo(aiErrorType)

    return {
      type: this.mapToErrorType(aiErrorType),
      code: aiErrorType,
      message,
      details,
      stack: originalError?.stack,
      timestamp: new Date(),
      recoverable: errorInfo.recoverable,
      context: {
        component,
        originalError: originalError?.message
      },
      aiErrorType,
      severity: errorInfo.severity,
      userMessage: errorInfo.userMessage,
      solutions: errorInfo.solutions,
      component,
      requiresUserAction: errorInfo.requiresUserAction
    }
  }

  /**
   * 获取错误信息
   */
  private getErrorInfo(aiErrorType: AIErrorType): ICompleteErrorInfo {
    // 使用 ErrorNormalizer 获取完整的错误信息，避免重复定义
    const configMode =
      ConfigOrchestrator.getInstance().getValue<string>('AI_SERVICE_MODE') || 'local'
    return ErrorNormalizer.getCompleteErrorInfo(aiErrorType, configMode as 'local' | 'cloud')
  }

  /**
   * 映射到通用错误类型
   */
  private mapToErrorType(aiErrorType: AIErrorType): ErrorType {
    switch (aiErrorType) {
      case AIErrorType.SERVER_START_FAILED:
      case AIErrorType.SERVER_STOP_FAILED:
      case AIErrorType.SERVER_NOT_RESPONDING:
      case AIErrorType.SERVER_CRASHED:
      case AIErrorType.MODEL_LOAD_FAILED:
      case AIErrorType.MODEL_SWITCH_FAILED:
        return ErrorType.SERVICE

      case AIErrorType.NETWORK_ERROR:
      case AIErrorType.CONNECTION_FAILED:
      case AIErrorType.CONNECTION_LOST:
      case AIErrorType.REQUEST_TIMEOUT:
      case AIErrorType.REQUEST_FAILED:
        return ErrorType.NETWORK

      case AIErrorType.CONFIG_INVALID:
      case AIErrorType.CONFIG_LOAD_FAILED:
      case AIErrorType.CONFIG_SAVE_FAILED:
      case AIErrorType.FILE_NOT_FOUND:
      case AIErrorType.FILE_ACCESS_DENIED:
      case AIErrorType.DISK_FULL:
        return ErrorType.SYSTEM

      case AIErrorType.REQUEST_INVALID:
        return ErrorType.USER

      default:
        return ErrorType.UNKNOWN
    }
  }

  /**
   * 处理AI错误
   */
  public async handleError(error: IAIError): Promise<IRecoveryResult> {
    // 避免在一小段时间内重复处理完全相同的错误（例如，来自多个监听器的重复触发）
    if (this.hasDuplicateError(error, 1000)) {
      loggingService.debug(
        LogCategory.AI_ERROR_HANDLER,
        '检测到重复的 AI 错误，忽略处理:',
        error.aiErrorType
      )
      return {
        success: false,
        message: t('重复的错误，已忽略'),
        duration: 0,
        requiresRestart: false
      }
    }

    // 记录错误
    this.recordError(error)

    // 发送错误事件
    this.emit('ai-error', error)

    // 记录到日志
    loggingService.error(
      LogCategory.AI_ERROR_HANDLER,
      t('AI错误: {type} - {message}', { type: error.aiErrorType, message: (error as any).message }),
      {
        severity: error.severity,
        userMessage: error.userMessage,
        solutions: error.solutions,
        details: (error as any).details
      }
    )

    // 推送错误到前端
    this.pushErrorToFrontend(error)

    // 如果错误可恢复且未在恢复中，尝试恢复
    if (error.recoverable && !this.isRecovering) {
      // 对于超时错误，主动通知前端
      if (error.aiErrorType === AIErrorType.REQUEST_TIMEOUT) {
        this.notifyFrontend(error)
      }
      return await this.attemptRecovery(error)
    }

    return {
      success: false,
      message: t('错误不可恢复或正在恢复中'),
      duration: 0,
      requiresRestart: false
    }
  }

  /**
   * 记录错误
   */
  private recordError(error: IAIError): void {
    // 添加到错误历史
    this.errorHistory.push(error)

    // 保持错误历史在合理范围内
    if (this.errorHistory.length > this.maxErrorHistory) {
      this.errorHistory = this.errorHistory.slice(-this.maxErrorHistory)
    }
  }

  /**
   * 尝试恢复
   */
  private async attemptRecovery(error: IAIError): Promise<IRecoveryResult> {
    this.isRecovering = true
    const startTime = Date.now()

    try {
      // 获取适用的恢复策略
      const strategies = this.recoveryStrategies.get(error.aiErrorType) || []

      if (strategies.length === 0) {
        loggingService.warn(
          LogCategory.AI_ERROR_HANDLER,
          t('没有找到适用于 {type} 的恢复策略', { type: error.aiErrorType })
        )
        return {
          success: false,
          message: t('没有可用的恢复策略'),
          duration: Date.now() - startTime,
          requiresRestart: false
        }
      }

      // 按优先级排序
      strategies.sort((a, b) => a.priority - b.priority)

      // 尝试每个恢复策略
      for (const strategy of strategies) {
        try {
          loggingService.info(LogCategory.AI_ERROR_HANDLER, `尝试恢复策略: ${strategy.name}`)

          const success = await this.executeRecoveryStrategy(strategy)

          if (success) {
            const duration = Date.now() - startTime
            loggingService.info(
              LogCategory.AI_ERROR_HANDLER,
              `恢复策略 ${strategy.name} 执行成功，耗时 ${duration}ms`
            )

            this.emit('recovery-success', { error, strategy, duration })

            return {
              success: true,
              strategy,
              message: t('使用策略 "{name}" 成功恢复', { name: strategy.name }),
              duration,
              requiresRestart: this.shouldRestart(error.aiErrorType)
            }
          }
        } catch (recoveryError) {
          loggingService.error(
            LogCategory.AI_ERROR_HANDLER,
            `恢复策略 ${strategy.name} 执行失败`,
            recoveryError
          )
        }
      }

      // 所有策略都失败
      const duration = Date.now() - startTime
      loggingService.error(LogCategory.AI_ERROR_HANDLER, t('所有恢复策略都失败'))
      this.emit('recovery-failed', { error, duration })

      return {
        success: false,
        message: t('所有恢复策略都失败'),
        duration,
        requiresRestart: this.shouldRestart(error.aiErrorType)
      }
    } finally {
      this.isRecovering = false
    }
  }

  /**
   * 执行恢复策略
   */
  private async executeRecoveryStrategy(strategy: RecoveryStrategy): Promise<boolean> {
    let attempts = 0

    while (attempts < strategy.maxRetries) {
      try {
        const success = await strategy.action()
        if (success) {
          return true
        }
      } catch (error) {
        loggingService.error(
          LogCategory.AI_ERROR_HANDLER,
          `恢复策略执行失败 (尝试 ${attempts + 1}/${strategy.maxRetries})`,
          error
        )
      }

      attempts++
      if (attempts < strategy.maxRetries) {
        await new Promise(resolve => setTimeout(resolve, strategy.retryDelay))
      }
    }

    return false
  }

  /**
   * 判断是否需要重启
   */
  private shouldRestart(errorType: AIErrorType): boolean {
    const restartRequiredErrors = [
      AIErrorType.SERVER_CRASHED,
      AIErrorType.MODEL_OUT_OF_MEMORY,
      AIErrorType.INSUFFICIENT_MEMORY,
      AIErrorType.CONFIG_INVALID
    ]

    return restartRequiredErrors.includes(errorType)
  }

  /**
   * 获取错误统计
   */
  public getErrorStatistics(): {
    totalErrors: number
    errorsByType: Record<string, number>
    errorsBySeverity: Record<string, number>
    recentErrors: IAIError[]
    recoverySuccessRate: number
  } {
    const errorsByType: Record<string, number> = {}
    const errorsBySeverity: Record<string, number> = {}

    // 统计错误
    this.errorHistory.forEach(error => {
      errorsByType[error.aiErrorType] = (errorsByType[error.aiErrorType] || 0) + 1
      errorsBySeverity[error.severity] = (errorsBySeverity[error.severity] || 0) + 1
    })

    // 获取最近的错误
    const recentErrors = this.errorHistory.slice(-10)

    // 计算恢复成功率（简化计算）
    const recoverableErrors = this.errorHistory.filter(error => error.recoverable).length
    const recoverySuccessRate = recoverableErrors > 0 ? 0.8 : 0 // 假设80%的成功率

    return {
      totalErrors: this.errorHistory.length,
      errorsByType,
      errorsBySeverity,
      recentErrors,
      recoverySuccessRate
    }
  }

  /**
   * 获取错误历史
   */
  public getErrorHistory(options?: {
    errorType?: AIErrorType
    severity?: 'low' | 'medium' | 'high' | 'critical'
    component?: string
    startTime?: Date
    endTime?: Date
    limit?: number
  }): IAIError[] {
    let filteredErrors = [...this.errorHistory]

    // 按错误类型过滤
    if (options?.errorType) {
      filteredErrors = filteredErrors.filter(error => error.aiErrorType === options.errorType)
    }

    // 按严重程度过滤
    if (options?.severity) {
      filteredErrors = filteredErrors.filter(error => error.severity === options.severity)
    }

    // 按组件过滤
    if (options?.component) {
      filteredErrors = filteredErrors.filter(error => error.component === options.component)
    }

    // 按时间范围过滤
    if (options?.startTime) {
      const startTime = options.startTime as Date
      filteredErrors = filteredErrors.filter(error => error.timestamp >= startTime)
    }

    if (options?.endTime) {
      const endTime = options.endTime as Date
      filteredErrors = filteredErrors.filter(error => error.timestamp <= endTime)
    }

    // 按数量限制
    if (options?.limit) {
      filteredErrors = filteredErrors.slice(-options.limit)
    }

    return filteredErrors.reverse() // 最新的错误在前
  }

  /**
   * 清除错误历史
   */
  public clearErrorHistory(): void {
    this.errorHistory = []
    loggingService.info(LogCategory.AI_ERROR_HANDLER, t('AI错误历史已清除'))
  }

  /**
   * 获取恢复策略
   */
  public getRecoveryStrategies(errorType?: AIErrorType): RecoveryStrategy[] {
    if (errorType) {
      return this.recoveryStrategies.get(errorType) || []
    }

    const allStrategies: RecoveryStrategy[] = []
    this.recoveryStrategies.forEach(strategies => {
      allStrategies.push(...strategies)
    })

    return allStrategies
  }

  /**
   * 手动触发恢复
   */
  public async triggerRecovery(error: IAIError): Promise<IRecoveryResult> {
    if (this.isRecovering) {
      return {
        success: false,
        message: t('恢复已在进行中'),
        duration: 0,
        requiresRestart: false
      }
    }

    return await this.attemptRecovery(error)
  }

  /**
   * 检查是否有重复错误
   */
  public hasDuplicateError(error: IAIError, timeWindow = 60000): boolean {
    const now = Date.now()
    const windowStart = now - timeWindow

    return this.errorHistory.some(
      existingError =>
        existingError.aiErrorType === error.aiErrorType &&
        existingError.component === error.component &&
        existingError.timestamp.getTime() >= windowStart
    )
  }

  /**
   * 获取错误频率
   */
  public getErrorFrequency(timeWindow = 3600000): {
    overall: number
    byType: Record<string, number>
    bySeverity: Record<string, number>
    byComponent: Record<string, number>
  } {
    const now = Date.now()
    const windowStart = now - timeWindow

    const recentErrors = this.errorHistory.filter(error => error.timestamp.getTime() >= windowStart)

    const byType: Record<string, number> = {}
    const bySeverity: Record<string, number> = {}
    const byComponent: Record<string, number> = {}

    recentErrors.forEach(error => {
      byType[error.aiErrorType] = (byType[error.aiErrorType] || 0) + 1
      bySeverity[error.severity] = (bySeverity[error.severity] || 0) + 1
      byComponent[error.component] = (byComponent[error.component] || 0) + 1
    })

    return {
      overall: recentErrors.length,
      byType,
      bySeverity,
      byComponent
    }
  }

  /**
   * 通知前端
   */
  private async notifyFrontend(error: IAIError): Promise<void> {
    try {
      const windows = BrowserWindow.getAllWindows()

      let action: any = undefined
      if (error.aiErrorType === AIErrorType.REQUEST_TIMEOUT) {
        action = {
          label: t('前往设置'),
          category: 'AI_MODEL'
        }
      }

      windows.forEach(win => {
        if (!win.webContents.isDestroyed()) {
          win.webContents.send('system:notification', {
            type: 'warning',
            message: error.userMessage,
            sticky: false,
            id: `ai-error-${error.aiErrorType}`,
            action
          })
        }
      })
    } catch (e) {
      logger.warn(LogCategory.AI_ERROR_HANDLER, '发送前端通知失败', e)
    }
  }

  /**
   * 推送错误到前端（通过 IPC）
   */
  private pushErrorToFrontend(error: IAIError): void {
    try {
      // 检查是否有更具体的已存在错误在 LlamaIndexAIService 中保留，如果有则不要推送较笼统的错误
      const service = LlamaIndexAIService.getInstance() as any
      if (service && service.lastInitError && service.lastInitError.code !== error.aiErrorType) {
        const priorityMap: Record<string, number> = {
          GPU_DRIVER_OUTDATED: 1,
          INSUFFICIENT_VRAM: 1,
          MODEL_OUT_OF_MEMORY: 1,
          INSUFFICIENT_MEMORY: 2,
          GPU_NOT_AVAILABLE: 2,
          MODEL_LOAD_FAILED: 3,
          MODEL_NOT_FOUND: 3,
          MODEL_CORRUPTED: 3,
          FREQUENT_CRASH: 3,
          SERVER_START_FAILED: 4,
          SERVICE_SWITCH_FAILED: 4,
          MODEL_SWITCH_FAILED: 4,
          CONFIG_INVALID: 5,
          CONNECTION_FAILED: 5,
          NETWORK_ERROR: 5,
          SERVER_CRASHED: 5
        }
        const existingPriority = priorityMap[service.lastInitError.code || ''] ?? 99
        const incomingPriority = priorityMap[error.aiErrorType] ?? 99
        if (existingPriority < incomingPriority) {
          logger.info(
            LogCategory.AI_ERROR_HANDLER,
            `[pushErrorToFrontend] 忽略推送较笼统的错误 [${error.aiErrorType}] 到前端，保留更具体的错误 [${(service as any).lastInitError.code}]: ${(service as any).lastInitError.message}`
          )
          return
        }
      }

      const windows = BrowserWindow.getAllWindows()

      // 使用 ErrorNormalizer 规范化错误
      const normalizedError: AIServiceError = ErrorNormalizer.normalize(
        error,
        error.aiErrorType,
        error.component
      )

      windows.forEach(win => {
        if (!win.webContents.isDestroyed()) {
          // 发送规范化后的错误到前端
          win.webContents.send('ai-service:error', normalizedError)
        }
      })

      logger.debug(LogCategory.AI_ERROR_HANDLER, t('已推送错误到前端: {type}'), {
        type: error.aiErrorType
      })
    } catch (e) {
      logger.error(LogCategory.AI_ERROR_HANDLER, '推送错误到前端失败', e)
    }
  }
}

// 导出单例实例
export const aiErrorHandler = AIErrorHandler.getInstance()
