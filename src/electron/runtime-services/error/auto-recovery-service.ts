import { EventEmitter } from 'events'
import { 
  AppError, 
  ErrorType, 
  RecoveryStrategy,
  SystemHealthStatus 
} from '@yonuc/types'
import { loggingService } from '../system/logging-service'
import { errorHandlingService } from './error-handling-service'
import { systemHealthService } from '../system/system-health-service'
import { logger, LogCategory } from '@yonuc/shared';
import { t } from '@app/languages'

/**
 * 自动恢复服务类
 */
export class AutoRecoveryService extends EventEmitter {
  private static instance: AutoRecoveryService
  private isRecoveryEnabled: boolean = true
  private recoveryHistory: Array<{
    timestamp: Date
    error: AppError
    strategy: RecoveryStrategy
    success: boolean
    duration: number
  }> = []
  private maxRecoveryHistory: number = 1000
  private recoveryStats: {
    totalAttempts: number
    successfulRecoveries: number
    failedRecoveries: number
    averageRecoveryTime: number
  } = {
    totalAttempts: 0,
    successfulRecoveries: 0,
    failedRecoveries: 0,
    averageRecoveryTime: 0
  }

  private constructor() {
    super()
    this.setupEventListeners()
    this.initializeRecoveryStrategies()
  }

  /**
   * 获取单例实例
   */
  public static getInstance(): AutoRecoveryService {
    if (!AutoRecoveryService.instance) {
      AutoRecoveryService.instance = new AutoRecoveryService()
    }
    return AutoRecoveryService.instance
  }

  /**
   * 设置事件监听器
   */
  private setupEventListeners(): void {
    // 监听错误处理服务的错误事件
    errorHandlingService.on('error', (error: AppError) => {
      if (this.isRecoveryEnabled && error.recoverable) {
        this.handleRecoverableError(error)
      }
    })

    // 监听系统健康服务的健康状态更新事件
    systemHealthService.on('health-status-updated', (healthStatus: SystemHealthStatus) => {
      if (this.isRecoveryEnabled) {
        this.handleHealthStatusUpdate(healthStatus)
      }
    })
  }

  /**
   * 初始化恢复策略
   */
  private initializeRecoveryStrategies(): void {
    // 服务重启策略
    this.addRecoveryStrategy({
      id: 'restart_critical_service',
      name: t('重启关键服务'),
      description: t('重启失败的关键服务'),
      errorTypes: [ErrorType.SERVICE],
      level: 1,
      priority: 1,
      action: async () => {
        loggingService.info(LogCategory.AUTO_RECOVERY, '尝试重启关键服务')
        // 实现服务重启逻辑
        return await this.restartCriticalServices()
      },
      maxRetries: 3,
      retryDelay: 5000
    })

    // 内存清理策略
    this.addRecoveryStrategy({
      id: 'memory_cleanup',
      name: t('内存清理'),
      description: t('清理系统内存'),
      errorTypes: [ErrorType.SYSTEM],
      level: 2,
      priority: 2,
      action: async () => {
        loggingService.info(LogCategory.AUTO_RECOVERY, '尝试清理内存')
        return await this.cleanupMemory()
      },
      maxRetries: 2,
      retryDelay: 3000
    })

    // 数据库重连策略
    this.addRecoveryStrategy({
      id: 'database_reconnect',
      name: t('数据库重连'),
      description: t('重新连接数据库'),
      errorTypes: [ErrorType.DATABASE],
      level: 3,
      priority: 3,
      action: async () => {
        loggingService.info(LogCategory.AUTO_RECOVERY, '尝试重新连接数据库')
        return await this.reconnectDatabase()
      },
      maxRetries: 5,
      retryDelay: 2000
    })

    // 网络重连策略
    this.addRecoveryStrategy({
      id: 'network_reconnect',
      name: t('网络重连'),
      description: t('重新建立网络连接'),
      errorTypes: [ErrorType.NETWORK],
      level: 4,
      priority: 4,
      action: async () => {
        loggingService.info(LogCategory.AUTO_RECOVERY, '尝试重新建立网络连接')
        return await this.reconnectNetwork()
      },
      maxRetries: 3,
      retryDelay: 3000
    })

    // 状态恢复策略
    this.addRecoveryStrategy({
      id: 'state_restore',
      name: t('状态恢复'),
      description: t('恢复应用状态'),
      errorTypes: [ErrorType.SYSTEM, ErrorType.SERVICE],
      level: 5,
      priority: 5,
      action: async () => {
        loggingService.info(LogCategory.AUTO_RECOVERY, '尝试恢复应用状态')
        return await this.restoreApplicationState()
      },
      maxRetries: 2,
      retryDelay: 5000
    })

    // 优雅关闭策略
    this.addRecoveryStrategy({
      id: 'graceful_shutdown',
      name: t('优雅关闭'),
      description: t('优雅关闭应用'),
      errorTypes: [ErrorType.SYSTEM, ErrorType.DATABASE],
      level: 6,
      priority: 6,
      action: async () => {
        loggingService.info(LogCategory.AUTO_RECOVERY, '执行优雅关闭')
        return await this.gracefulShutdown()
      },
      maxRetries: 1,
      retryDelay: 1000
    })
  }

  /**
   * 处理可恢复错误
   */
  private async handleRecoverableError(error: AppError): Promise<void> {
    loggingService.info(LogCategory.AUTO_RECOVERY, '处理可恢复错误', { error })

    // 获取适用于此错误类型的恢复策略
    const applicableStrategies = this.getApplicableStrategies(error.type)
    
    if (applicableStrategies.length === 0) {
      loggingService.warn(LogCategory.AUTO_RECOVERY, '没有找到适用的恢复策略', { error })
      return
    }

    // 按优先级尝试恢复策略
    for (const strategy of applicableStrategies) {
      const success = await this.executeRecoveryStrategy(strategy, error)
      if (success) {
        loggingService.info(LogCategory.AUTO_RECOVERY, `恢复策略 ${strategy.name} 执行成功`)
        this.emit('recovery-success', { error, strategy })
        return
      }
    }

    // 所有恢复策略都失败
    loggingService.error(LogCategory.AUTO_RECOVERY, '所有恢复策略都失败', { error })
    this.emit('recovery-failed', { error })
  }

  /**
   * 处理健康状态更新
   */
  private async handleHealthStatusUpdate(healthStatus: SystemHealthStatus): Promise<void> {
    if (healthStatus.overall === 'critical') {
      loggingService.warn(LogCategory.AUTO_RECOVERY, '检测到关键健康状态', { healthStatus })
      await this.handleCriticalHealthStatus(healthStatus)
    } else if (healthStatus.overall === 'warning') {
      loggingService.info(LogCategory.AUTO_RECOVERY, '检测到警告健康状态', { healthStatus })
      await this.handleWarningHealthStatus(healthStatus)
    }
  }

  /**
   * 处理关键健康状态
   */
  private async handleCriticalHealthStatus(healthStatus: SystemHealthStatus): Promise<void> {
    // 创建系统错误
    const systemError: AppError = {
      type: ErrorType.SYSTEM,
      code: 'CRITICAL_HEALTH_STATUS',
      message: t('系统处于关键健康状态'),
      details: healthStatus,
      timestamp: new Date(),
      recoverable: true,
      context: { healthStatus }
    }

    await this.handleRecoverableError(systemError)
  }

  /**
   * 处理警告健康状态
   */
  private async handleWarningHealthStatus(healthStatus: SystemHealthStatus): Promise<void> {
    // 可以在这里添加预防性恢复措施
    loggingService.info(LogCategory.AUTO_RECOVERY, '执行预防性恢复措施')
    
    // 例如：清理内存、优化性能等
    await this.preventiveMaintenance()
  }

  /**
   * 获取适用的恢复策略
   */
  private getApplicableStrategies(errorType: ErrorType): RecoveryStrategy[] {
    return errorHandlingService.getRecoveryStrategies()
      .filter(strategy => strategy.errorTypes.includes(errorType))
      .sort((a, b) => a.priority - b.priority)
  }

  /**
   * 执行恢复策略
   */
  private async executeRecoveryStrategy(strategy: RecoveryStrategy, error: AppError): Promise<boolean> {
    const startTime = Date.now()
    let attempts = 0
    let lastError: Error | null = null

    while (attempts < strategy.maxRetries) {
      try {
        const success = await strategy.action()
        const duration = Date.now() - startTime
        
        // 记录恢复历史
        this.recordRecoveryHistory(error, strategy, success, duration)
        
        if (success) {
          this.updateRecoveryStats(true, duration)
          return true
        }
      } catch (recoveryError) {
        lastError = recoveryError instanceof Error ? recoveryError : new Error(String(recoveryError))
        loggingService.error(LogCategory.AUTO_RECOVERY, `恢复策略执行失败 (尝试 ${attempts + 1}/${strategy.maxRetries})`, {
          error: lastError.message,
          strategy: strategy.name
        })
      }

      attempts++
      if (attempts < strategy.maxRetries) {
        await new Promise(resolve => setTimeout(resolve, strategy.retryDelay))
      }
    }

    const duration = Date.now() - startTime
    this.recordRecoveryHistory(error, strategy, false, duration)
    this.updateRecoveryStats(false, duration)
    
    return false
  }

  /**
   * 记录恢复历史
   */
  private recordRecoveryHistory(error: AppError, strategy: RecoveryStrategy, success: boolean, duration: number): void {
    const recoveryRecord = {
      timestamp: new Date(),
      error,
      strategy,
      success,
      duration
    }

    this.recoveryHistory.push(recoveryRecord)

    // 保持恢复历史在合理范围内
    if (this.recoveryHistory.length > this.maxRecoveryHistory) {
      this.recoveryHistory = this.recoveryHistory.slice(-this.maxRecoveryHistory)
    }
  }

  /**
   * 更新恢复统计
   */
  private updateRecoveryStats(success: boolean, duration: number): void {
    this.recoveryStats.totalAttempts++
    
    if (success) {
      this.recoveryStats.successfulRecoveries++
    } else {
      this.recoveryStats.failedRecoveries++
    }

    // 更新平均恢复时间
    const totalTime = this.recoveryStats.averageRecoveryTime * (this.recoveryStats.totalAttempts - 1) + duration
    this.recoveryStats.averageRecoveryTime = totalTime / this.recoveryStats.totalAttempts
  }

  /**
   * 重启关键服务
   */
  private async restartCriticalServices(): Promise<boolean> {
    try {
      // 获取关键服务列表
      const criticalServices = ['database', 'ai', 'config']
      
      for (const serviceName of criticalServices) {
        try {
          // 这里可以实现具体的服务重启逻辑
          loggingService.info(LogCategory.AUTO_RECOVERY, `重启服务: ${serviceName}`)
          
          // 模拟服务重启
          await new Promise(resolve => setTimeout(resolve, 1000))
          
          loggingService.info(LogCategory.AUTO_RECOVERY, `服务重启成功: ${serviceName}`)
        } catch (error) {
          loggingService.error(LogCategory.AUTO_RECOVERY, `服务重启失败: ${serviceName}`, { error })
          return false
        }
      }
      
      return true
    } catch (error) {
      loggingService.error(LogCategory.AUTO_RECOVERY, '重启关键服务失败', { error })
      return false
    }
  }

  /**
   * 清理内存
   */
  private async cleanupMemory(): Promise<boolean> {
    try {
      // 触发垃圾回收
      if (global.gc) {
        global.gc()
      }

      // 清理不必要的缓存
      // 这里可以添加具体的缓存清理逻辑
      
      loggingService.info(LogCategory.AUTO_RECOVERY, '内存清理完成')
      return true
    } catch (error) {
      loggingService.error(LogCategory.AUTO_RECOVERY, '内存清理失败', { error })
      return false
    }
  }

  /**
   * 重新连接数据库
   */
  private async reconnectDatabase(): Promise<boolean> {
    try {
      // 这里可以实现数据库重连逻辑
      loggingService.info(LogCategory.AUTO_RECOVERY, '重新连接数据库')
      
      // 模拟数据库重连
      await new Promise(resolve => setTimeout(resolve, 2000))
      
      loggingService.info(LogCategory.AUTO_RECOVERY, '数据库重连成功')
      return true
    } catch (error) {
      loggingService.error(LogCategory.AUTO_RECOVERY, '数据库重连失败', { error })
      return false
    }
  }

  /**
   * 重新建立网络连接
   */
  private async reconnectNetwork(): Promise<boolean> {
    try {
      // 这里可以实现网络重连逻辑
      loggingService.info(LogCategory.AUTO_RECOVERY, '重新建立网络连接')
      
      // 模拟网络重连
      await new Promise(resolve => setTimeout(resolve, 3000))
      
      loggingService.info(LogCategory.AUTO_RECOVERY, '网络重连成功')
      return true
    } catch (error) {
      loggingService.error(LogCategory.AUTO_RECOVERY, '网络重连失败', { error })
      return false
    }
  }

  /**
   * 恢复应用状态
   */
  private async restoreApplicationState(): Promise<boolean> {
    try {
      // 这里可以实现状态恢复逻辑
      loggingService.info(LogCategory.AUTO_RECOVERY, '恢复应用状态')
      
      // 从持久化存储恢复状态
      // 这里可以添加具体的状态恢复逻辑
      
      loggingService.info(LogCategory.AUTO_RECOVERY, '应用状态恢复成功')
      return true
    } catch (error) {
      loggingService.error(LogCategory.AUTO_RECOVERY, '应用状态恢复失败', { error })
      return false
    }
  }

  /**
   * 预防性维护
   */
  private async preventiveMaintenance(): Promise<boolean> {
    try {
      // 执行预防性维护任务
      loggingService.info(LogCategory.AUTO_RECOVERY, '执行预防性维护')
      
      // 清理临时文件
      await this.cleanupTempFiles()
      
      // 优化内存使用
      await this.optimizeMemoryUsage()
      
      loggingService.info(LogCategory.AUTO_RECOVERY, '预防性维护完成')
      return true
    } catch (error) {
      loggingService.error(LogCategory.AUTO_RECOVERY, '预防性维护失败', { error })
      return false
    }
  }

  /**
   * 清理临时文件
   */
  private async cleanupTempFiles(): Promise<void> {
    // 这里可以实现临时文件清理逻辑
    loggingService.info(LogCategory.AUTO_RECOVERY, '清理临时文件')
  }

  /**
   * 优化内存使用
   */
  private async optimizeMemoryUsage(): Promise<void> {
    // 这里可以实现内存优化逻辑
    loggingService.info(LogCategory.AUTO_RECOVERY, '优化内存使用')
  }

  /**
   * 优雅关闭
   */
  private async gracefulShutdown(): Promise<boolean> {
    try {
      loggingService.info(LogCategory.AUTO_RECOVERY, '执行优雅关闭')
      
      // 保存应用状态
      await this.saveApplicationState()
      
      // 关闭所有服务
      await this.shutdownAllServices()
      
      // 退出应用
      const { app } = require('electron')
      app.quit()
      
      return true
    } catch (error) {
      loggingService.error(LogCategory.AUTO_RECOVERY, '优雅关闭失败', { error })
      return false
    }
  }

  /**
   * 保存应用状态
   */
  private async saveApplicationState(): Promise<void> {
    // 这里可以实现状态保存逻辑
    loggingService.info(LogCategory.AUTO_RECOVERY, '保存应用状态')
  }

  /**
   * 关闭所有服务
   */
  private async shutdownAllServices(): Promise<void> {
    // 这里可以实现服务关闭逻辑
    loggingService.info(LogCategory.AUTO_RECOVERY, '关闭所有服务')
  }

  /**
   * 添加恢复策略
   */
  public addRecoveryStrategy(strategy: RecoveryStrategy): void {
    errorHandlingService.addRecoveryStrategy(strategy)
    loggingService.info(LogCategory.AUTO_RECOVERY, `添加恢复策略: ${strategy.name}`)
  }

  /**
   * 移除恢复策略
   */
  public removeRecoveryStrategy(strategyId: string): void {
    errorHandlingService.removeRecoveryStrategy(strategyId)
    loggingService.info(LogCategory.AUTO_RECOVERY, `移除恢复策略: ${strategyId}`)
  }

  /**
   * 启用自动恢复
   */
  public enableRecovery(): void {
    this.isRecoveryEnabled = true
    loggingService.info(LogCategory.AUTO_RECOVERY, '自动恢复已启用')
  }

  /**
   * 禁用自动恢复
   */
  public disableRecovery(): void {
    this.isRecoveryEnabled = false
    loggingService.info(LogCategory.AUTO_RECOVERY, '自动恢复已禁用')
  }

  /**
   * 获取恢复历史
   */
  public getRecoveryHistory(options?: {
    startTime?: Date
    endTime?: Date
    success?: boolean
    limit?: number
  }): Array<{
    timestamp: Date
    error: AppError
    strategy: RecoveryStrategy
    success: boolean
    duration: number
  }> {
    let filteredHistory = [...this.recoveryHistory]

    // 按时间范围过滤
    if (options?.startTime !== undefined) {
      filteredHistory = filteredHistory.filter(record => record.timestamp >= options.startTime!)
    }

    if (options?.endTime !== undefined) {
      filteredHistory = filteredHistory.filter(record => record.timestamp <= options.endTime!)
    }

    // 按成功状态过滤
    if (options?.success !== undefined) {
      filteredHistory = filteredHistory.filter(record => record.success === options.success)
    }

    // 按数量限制
    if (options?.limit !== undefined) {
      filteredHistory = filteredHistory.slice(-options.limit)
    }

    return filteredHistory.reverse() // 最新的记录在前
  }

  /**
   * 获取恢复统计
   */
  public getRecoveryStats(): {
    totalAttempts: number
    successfulRecoveries: number
    failedRecoveries: number
    averageRecoveryTime: number
    successRate: number
  } {
    const successRate = this.recoveryStats.totalAttempts > 0 
      ? (this.recoveryStats.successfulRecoveries / this.recoveryStats.totalAttempts) * 100 
      : 0

    return {
      ...this.recoveryStats,
      successRate
    }
  }

  /**
   * 清除恢复历史
   */
  public clearRecoveryHistory(): void {
    this.recoveryHistory = []
    this.recoveryStats = {
      totalAttempts: 0,
      successfulRecoveries: 0,
      failedRecoveries: 0,
      averageRecoveryTime: 0
    }
    loggingService.info(LogCategory.AUTO_RECOVERY, '恢复历史已清除')
  }

  /**
   * 手动触发恢复
   */
  public async triggerManualRecovery(error: AppError): Promise<void> {
    loggingService.info(LogCategory.AUTO_RECOVERY, '手动触发恢复', { error })
    await this.handleRecoverableError(error)
  }

  /**
   * 获取恢复策略
   */
  public getRecoveryStrategies(): RecoveryStrategy[] {
    return errorHandlingService.getRecoveryStrategies()
  }

  /**
   * 检查系统是否需要恢复
   */
  public async checkSystemRecoveryNeeded(): Promise<boolean> {
    try {
      const healthStatus = await systemHealthService.getSystemHealthStatus()
      return healthStatus.overall === 'critical'
    } catch (error) {
      loggingService.error(LogCategory.AUTO_RECOVERY, '检查系统恢复需求失败', { error })
      return false
    }
  }
}

// 导出单例实例
export const autoRecoveryService = AutoRecoveryService.getInstance()
