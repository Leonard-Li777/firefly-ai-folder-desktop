/**
 * 错误处理模块
 * 负责错误分类、记录、重试策略等
 */

import { logger, LogCategory } from '@yonuc/shared'
import { AnalysisErrorType, IAnalysisError, IErrorRecoveryConfig } from './types'
import fs from 'node:fs'
import { t } from '@app/languages'

export class ErrorHandler {
  private errorHistory: IAnalysisError[] = []
  private readonly errorRecoveryConfig: IErrorRecoveryConfig = {
    maxRetries: 3,
    retryDelay: 2000,              // 2秒
    backoffMultiplier: 2,          // 指数退避
    fileProcessingTimeout: 120000, // 2分钟
    aiRequestTimeout: 90000,       // 增加到90秒 (原来60秒)
    unitRecognitionTimeout: 30000, // 30秒
    enableFallbackProcessing: true,
    skipOnCriticalError: false,
    fallbackToBasicAnalysis: true
  }
  constructor(config?: Partial<IErrorRecoveryConfig>) {
    if (config) {
      this.errorRecoveryConfig = {
        ...this.errorRecoveryConfig,
        ...config
      }
    }
  }

  /**
   * 记录分析错误（增强版）
   */
  logAnalysisError(
    filePath: string,
    error: Error,
    errorType: AnalysisErrorType = AnalysisErrorType.UNKNOWN_ERROR,
    retryCount = 0,
    _context?: string
  ): IAnalysisError {
    const analysisError: IAnalysisError = {
      id: `error-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      errorType,
      errorMessage: error.message,
      filePath,
      stackTrace: error.stack,
      retryCount,
      maxRetries: this.errorRecoveryConfig.maxRetries,
      recoveryAction: this.getEnhancedRecoveryAction(errorType, retryCount, filePath)
    }

    this.errorHistory.push(analysisError)

    // 保持错误历史记录在合理范围内
    if (this.errorHistory.length > 1000) {
      this.errorHistory = this.errorHistory.slice(-500)
    }

    // 根据错误严重程度使用不同的日志级别
    const severity = this.getErrorSeverity(errorType)
    const logMessage = `[分析队列] ${severity.toUpperCase()} 错误: ${errorType} - ${error.message}`

    switch (severity) {
      case 'critical':
        logger.error(LogCategory.ANALYSIS_QUEUE, logMessage, analysisError)
        break
      case 'high':
        logger.error(LogCategory.ANALYSIS_QUEUE, logMessage, analysisError)
        break
      case 'medium':
        logger.warn(LogCategory.ANALYSIS_QUEUE, logMessage, analysisError)
        break
      case 'low':
        logger.info(LogCategory.ANALYSIS_QUEUE, logMessage, analysisError)
        break
    }

    return analysisError
  }

  /**
   * 获取错误恢复建议
   */
  private getRecoveryAction(errorType: AnalysisErrorType): string {
    switch (errorType) {
      case AnalysisErrorType.FILE_NOT_FOUND:
        return t('检查文件是否存在或已被移动')
      case AnalysisErrorType.PERMISSION_DENIED:
        return t('检查文件访问权限')
      case AnalysisErrorType.FILE_LOCKED:
        return t('等待文件解锁后重试')
      case AnalysisErrorType.UNSUPPORTED_FORMAT:
        return t('跳过不支持的文件格式')
      case AnalysisErrorType.FILE_CORRUPTED:
        return t('文件可能已损坏，建议跳过')
      case AnalysisErrorType.PROCESSING_TIMEOUT:
        return t('增加处理超时时间或跳过大文件')
      case AnalysisErrorType.MODEL_NOT_LOADED:
        return t('等待AI模型加载完成')
      case AnalysisErrorType.AI_REQUEST_TIMEOUT:
        return t('检查AI服务状态或增加超时时间')
      case AnalysisErrorType.DATABASE_ERROR:
        return t('检查数据库连接状态')
      default:
        return t('检查系统状态并重试')
    }
  }

  /**
   * 分类错误类型
   */
  classifyError(error: Error, context: string): AnalysisErrorType {
    const message = error.message.toLowerCase()
    const stack = error.stack?.toLowerCase() || ''

    // 文件访问错误
    if (message.includes('no such file') || message.includes('enoent') ||
      message.includes('file not found') || message.includes(t('文件不存在'))) {
      return AnalysisErrorType.FILE_NOT_FOUND
    }
    if (message.includes('permission denied') || message.includes('eacces') ||
      message.includes('access denied') || message.includes(t('权限被拒绝'))) {
      return AnalysisErrorType.PERMISSION_DENIED
    }
    if (message.includes('file is locked') || message.includes('ebusy') ||
      message.includes('resource busy') || message.includes(t('文件被锁定'))) {
      return AnalysisErrorType.FILE_LOCKED
    }

    // 超时错误
    if (message.includes('timeout') || message.includes(t('超时')) ||
      message.includes('timed out')) {
      if (context.includes('ai') || context.includes('classification') || context.includes('llm')) {
        return AnalysisErrorType.AI_REQUEST_TIMEOUT
      }
      if (context.includes('unit') || context.includes('recognition')) {
        return AnalysisErrorType.UNIT_RECOGNITION_ERROR
      }
      if (context.includes('processing') || context.includes('analysis')) {
        return AnalysisErrorType.PROCESSING_TIMEOUT
      }
      return AnalysisErrorType.PROCESSING_TIMEOUT
    }

    // 格式和文件质量错误
    if (message.includes('unsupported') || message.includes(t('不支持')) ||
      message.includes('invalid format') || message.includes(t('格式不支持'))) {
      return AnalysisErrorType.UNSUPPORTED_FORMAT
    }
    if (message.includes('corrupted') || message.includes('damaged') ||
      message.includes('invalid') || message.includes(t('损坏')) ||
      message.includes('malformed') || message.includes(t('格式错误'))) {
      return AnalysisErrorType.FILE_CORRUPTED
    }

    // AI服务错误
    if (message.includes('model') && (message.includes('not loaded') || message.includes(t('未加载')))) {
      return AnalysisErrorType.MODEL_NOT_LOADED
    }
    if (message.includes('ai service') || message.includes(t('ai服务')) ||
      message.includes('model error') || message.includes(t('模型错误'))) {
      return AnalysisErrorType.AI_SERVICE_ERROR
    }
    if (message.includes('classification failed') || message.includes(t('分类失败'))) {
      return AnalysisErrorType.AI_CLASSIFICATION_FAILED
    }

    // 数据库错误
    if (message.includes('database') || message.includes(t('数据库')) ||
      message.includes('sqlite') || message.includes('sql') ||
      stack.includes('database')) {
      return AnalysisErrorType.DATABASE_ERROR
    }

    // 网络和连接错误
    if (message.includes('network') || message.includes('connection') ||
      message.includes(t('网络')) || message.includes(t('连接'))) {
      return AnalysisErrorType.AI_SERVICE_ERROR
    }

    // 内存和资源错误
    if (message.includes('out of memory') || message.includes(t('内存不足')) ||
      message.includes('resource exhausted') || message.includes(t('资源耗尽'))) {
      return AnalysisErrorType.PROCESSING_ERROR
    }

    // 根据上下文进一步分类
    if (context.includes('unit') || context.includes('recognition')) {
      return AnalysisErrorType.UNIT_RECOGNITION_ERROR
    }
    if (context.includes('ai') || context.includes('classification') || context.includes('llm')) {
      return AnalysisErrorType.AI_SERVICE_ERROR
    }
    if (context.includes('processing') || context.includes('analysis')) {
      return AnalysisErrorType.PROCESSING_ERROR
    }

    return AnalysisErrorType.UNKNOWN_ERROR
  }

  /**
   * 检查是否应该重试
   */
  shouldRetry(errorType: AnalysisErrorType, retryCount: number, filePath?: string): boolean {
    if (retryCount >= this.errorRecoveryConfig.maxRetries) {
      return false
    }

    // 某些错误类型永远不应该重试
    const neverRetryErrors = [
      AnalysisErrorType.FILE_NOT_FOUND,
      AnalysisErrorType.UNSUPPORTED_FORMAT,
      AnalysisErrorType.FILE_CORRUPTED,
      AnalysisErrorType.PERMISSION_DENIED
    ]

    if (neverRetryErrors.includes(errorType)) {
      return false
    }

    // 某些错误类型有条件重试
    const conditionalRetryErrors = [
      AnalysisErrorType.FILE_LOCKED,
      AnalysisErrorType.PROCESSING_TIMEOUT,
      AnalysisErrorType.AI_REQUEST_TIMEOUT,
      AnalysisErrorType.DATABASE_ERROR,
      AnalysisErrorType.MODEL_NOT_LOADED
    ]

    if (conditionalRetryErrors.includes(errorType)) {
      // 对于这些错误，限制重试次数更少
      const maxConditionalRetries = Math.floor(this.errorRecoveryConfig.maxRetries / 2)
      if (retryCount >= maxConditionalRetries) {
        return false
      }
    }

    // 检查文件大小，大文件超时错误减少重试次数
    if (errorType === AnalysisErrorType.PROCESSING_TIMEOUT && filePath) {
      try {
        const stats = fs.statSync(filePath)
        const fileSizeMB = stats.size / (1024 * 1024)

        // 大于100MB的文件，超时后只重试1次
        if (fileSizeMB > 100 && retryCount >= 1) {
          return false
        }

        // 大于50MB的文件，超时后只重试2次
        if (fileSizeMB > 50 && retryCount >= 2) {
          return false
        }
      } catch (e) {
        // 如果无法获取文件大小，使用默认策略
      }
    }

    return true
  }

  /**
   * 检查错误是否为关键错误（需要立即停止处理）
   */
  isCriticalError(errorType: AnalysisErrorType): boolean {
    const criticalErrors = [
      AnalysisErrorType.DATABASE_ERROR,
      AnalysisErrorType.PERMISSION_DENIED
    ]

    return criticalErrors.includes(errorType) && (this.errorRecoveryConfig.skipOnCriticalError ?? false)
  }

  /**
   * 获取错误严重程度
   */
  getErrorSeverity(errorType: AnalysisErrorType): 'low' | 'medium' | 'high' | 'critical' {
    switch (errorType) {
      case AnalysisErrorType.FILE_NOT_FOUND:
      case AnalysisErrorType.UNSUPPORTED_FORMAT:
        return 'low'

      case AnalysisErrorType.FILE_CORRUPTED:
      case AnalysisErrorType.AI_CLASSIFICATION_FAILED:
      case AnalysisErrorType.PROCESSING_TIMEOUT:
        return 'medium'

      case AnalysisErrorType.AI_REQUEST_TIMEOUT:
      case AnalysisErrorType.MODEL_NOT_LOADED:
      case AnalysisErrorType.AI_SERVICE_ERROR:
      case AnalysisErrorType.UNIT_RECOGNITION_ERROR:
        return 'high'

      case AnalysisErrorType.DATABASE_ERROR:
      case AnalysisErrorType.PERMISSION_DENIED:
        return 'critical'

      default:
        return 'medium'
    }
  }

  /**
   * 计算重试延迟（智能退避策略）
   */
  calculateRetryDelay(retryCount: number, errorType: AnalysisErrorType): number {
    let baseDelay = this.errorRecoveryConfig.retryDelay

    // 根据错误类型调整基础延迟
    switch (errorType) {
      case AnalysisErrorType.FILE_LOCKED:
        // 文件锁定错误需要更长的等待时间
        baseDelay = Math.max(baseDelay, 5000)
        break

      case AnalysisErrorType.AI_REQUEST_TIMEOUT:
      case AnalysisErrorType.MODEL_NOT_LOADED:
        // AI相关错误需要较长等待时间
        baseDelay = Math.max(baseDelay, 3000)
        break

      case AnalysisErrorType.DATABASE_ERROR:
        // 数据库错误需要短暂等待
        baseDelay = Math.max(baseDelay, 1000)
        break

      case AnalysisErrorType.PROCESSING_TIMEOUT:
        // 处理超时错误需要更长等待
        baseDelay = Math.max(baseDelay, 4000)
        break

      default:
        // 使用默认延迟
        break
    }

    // 指数退避，但有上限
    const exponentialDelay = baseDelay * Math.pow(this.errorRecoveryConfig.backoffMultiplier ?? 2, retryCount)
    const maxDelay = 30000 // 最大30秒

    // 添加随机抖动，避免雷群效应
    const jitter = Math.random() * 0.3 + 0.85 // 85%-115%的随机因子

    return Math.min(exponentialDelay * jitter, maxDelay)
  }

  /**
   * 获取错误恢复建议（增强版）
   */
  private getEnhancedRecoveryAction(errorType: AnalysisErrorType, retryCount: number, filePath?: string): string {
    const baseAction = this.getRecoveryAction(errorType)
    const severity = this.getErrorSeverity(errorType)

    let enhancedAction = baseAction

    // 根据重试次数添加额外建议
    if (retryCount > 0) {
      enhancedAction += t(' (已重试 {retryCount} 次)', {
        retryCount: retryCount
      })
    }

    // 根据错误严重程度添加建议
    switch (severity) {
      case 'critical':
        enhancedAction += t(' - 建议检查系统状态')
        break
      case 'high':
        enhancedAction += t(' - 可能需要人工干预')
        break
      case 'medium':
        enhancedAction += t(' - 系统将自动重试')
        break
      case 'low':
        enhancedAction += t(' - 将跳过此文件')
        break
    }

    // 根据文件信息添加特定建议
    if (filePath) {
      try {
        const stats = fs.statSync(filePath)
        const fileSizeMB = stats.size / (1024 * 1024)

        if (fileSizeMB > 100 && errorType === AnalysisErrorType.PROCESSING_TIMEOUT) {
          enhancedAction += t(' - 大文件处理，建议增加超时时间')
        }
      } catch (e) {
        // 忽略文件状态检查错误
      }
    }

    return enhancedAction
  }

  /**
   * 获取错误历史记录
   */
  getErrorHistory(): IAnalysisError[] {
    return [...this.errorHistory]
  }

  /**
   * 清理错误历史记录
   */
  clearErrorHistory(): void {
    this.errorHistory = []
    logger.info(LogCategory.ANALYSIS_QUEUE, '[分析队列] 错误历史记录已清理')
  }

  /**
   * 获取错误统计信息
   */
  getErrorStatistics(): {
    totalErrors: number
    errorsByType: Record<AnalysisErrorType, number>
    errorsBySeverity: Record<string, number>
    recentErrorRate: number
    mostCommonError: AnalysisErrorType | null
  } {
    const now = Date.now()
    const oneHourAgo = now - 60 * 60 * 1000

    const recentErrors = this.errorHistory.filter(
      error => new Date(error.timestamp).getTime() > oneHourAgo
    )

    const errorsByType: Record<AnalysisErrorType, number> = {} as any
    const errorsBySeverity: Record<string, number> = {
      low: 0,
      medium: 0,
      high: 0,
      critical: 0
    }

    for (const error of this.errorHistory) {
      errorsByType[error.errorType] = (errorsByType[error.errorType] || 0) + 1
      const severity = this.getErrorSeverity(error.errorType)
      errorsBySeverity[severity]++
    }

    const mostCommonError = Object.entries(errorsByType)
      .sort(([, a], [, b]) => b - a)[0]?.[0] as AnalysisErrorType || null

    return {
      totalErrors: this.errorHistory.length,
      errorsByType,
      errorsBySeverity,
      recentErrorRate: recentErrors.length,
      mostCommonError
    }
  }

  /**
   * 获取错误恢复配置
   */
  getErrorRecoveryConfig(): IErrorRecoveryConfig {
    return { ...this.errorRecoveryConfig }
  }
}

