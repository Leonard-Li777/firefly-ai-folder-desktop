import { platformAdapter } from '@yonuc/electron-llamaIndex-service'
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { EventEmitter } from 'events'
import { logger, LogCategory } from '@yonuc/shared';
import {
  SystemHealthStatus,
  ProcessHealthStatus,
  MemoryHealthStatus,
  ServiceHealthStatus,
  ResourceHealthStatus,
  SystemMetrics,
  LogLevel,
  LogEntry,
  ErrorType,
  AppError,
  RecoveryStrategy,
  SystemHealthConfig
} from '@yonuc/types'
import { ConfigOrchestrator } from '../../config/config-orchestrator'

/**
 * 系统健康检查服务类
 */
export class SystemHealthService extends EventEmitter {
  private static instance: SystemHealthService
  private config!: SystemHealthConfig
  private isRunning = false
  private monitoringInterval: NodeJS.Timeout | null = null
  private startTime: Date = new Date()
  private logEntries: LogEntry[] = []
  private serviceHealthChecks: Map<string, () => Promise<ServiceHealthStatus>> = new Map()
  private recoveryStrategies: Map<string, RecoveryStrategy> = new Map()
  private errorCounts: Map<string, number> = new Map()
  private lastMetrics: SystemMetrics | null = null

  private constructor() {
    super()
    this.initializeConfig()
    this.setupDefaultRecoveryStrategies()
    this.setupGlobalErrorHandling()
  }

  /**
   * 获取单例实例
   */
  public static getInstance(): SystemHealthService {
    if (!SystemHealthService.instance) {
      SystemHealthService.instance = new SystemHealthService()
    }
    return SystemHealthService.instance
  }

  /**
   * 初始化配置
   */
  private initializeConfig(): void {
    // 从配置服务加载阈值
    const cpuWarning = ConfigOrchestrator.getInstance().getValue<number>('CPU_WARNING_THRESHOLD') || 70
    const cpuCritical = ConfigOrchestrator.getInstance().getValue<number>('CPU_CRITICAL_THRESHOLD') || 90
    const memWarning = ConfigOrchestrator.getInstance().getValue<number>('MEMORY_WARNING_THRESHOLD') || 75
    const memCritical = ConfigOrchestrator.getInstance().getValue<number>('MEMORY_CRITICAL_THRESHOLD') || 92
    const healthCheckInterval = ConfigOrchestrator.getInstance().getValue<number>('HEALTH_CHECK_INTERVAL') || 30000
    const maxRetries = ConfigOrchestrator.getInstance().getValue<number>('ERROR_MAX_RETRIES') || 3
    const retryDelay = ConfigOrchestrator.getInstance().getValue<number>('ERROR_RETRY_DELAY') || 1000

    this.config = {
      monitoring: {
        enabled: true,
        interval: healthCheckInterval,
        extremeThreshold: {
          cpu: cpuCritical,
          memory: memCritical,
          disk: 95
        },
        warningThreshold: {
          cpu: cpuWarning,
          memory: memWarning,
          disk: 85
        }
      },
      logging: {
        level: LogLevel.ERROR,
        maxFileSize: 10 * 1024 * 1024, // 10MB
        maxFiles: 5,
        enableConsole: false,
        enableFile: true,
        filePath: path.join(platformAdapter.getAppDataPath(), 'logs', 'system-health.log')
      },
      recovery: {
        enabled: true,
        maxRetries: maxRetries,
        retryDelay: retryDelay,
        strategies: []
      },
      services: {
        checkInterval: 10000, // 10秒
        timeout: ConfigOrchestrator.getInstance().getValue<number>('CONNECTION_IDLE_TIMEOUT') || 5000,
        criticalServices: ['database', 'ai', 'config']
      }
    }

    // 确保日志目录存在
    const logDir = path.dirname(this.config.logging.filePath)
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true })
    }
  }

  /**
   * 设置默认恢复策略
   */
  private setupDefaultRecoveryStrategies(): void {
    const maxRetries = ConfigOrchestrator.getInstance().getValue<number>('ERROR_MAX_RETRIES') || 3
    const retryDelay = ConfigOrchestrator.getInstance().getValue<number>('ERROR_RETRY_DELAY') || 1000

    const defaultStrategies: RecoveryStrategy[] = [
      {
        id: 'restart_service',
        name: '重启服务',
        description: '重启失败的服务',
        errorTypes: [ErrorType.SERVICE],
        level: 1,
        priority: 1,
        action: async () => {
          this.log(LogLevel.INFO, 'system-health', '尝试重启服务')
          // 这里可以根据具体服务实现重启逻辑
          return true
        },
        maxRetries: maxRetries,
        retryDelay: retryDelay * 5  // 重启服务需要更长的延迟
      },
      {
        id: 'clear_memory',
        name: '清理内存',
        description: '清理系统内存',
        errorTypes: [ErrorType.SYSTEM],
        level: 2,
        priority: 2,
        action: async () => {
          this.log(LogLevel.INFO, 'system-health', '尝试清理内存')
          global.gc && global.gc()
          return true
        },
        maxRetries: Math.max(2, maxRetries - 1),
        retryDelay: retryDelay * 3  // 清理内存需要中等延迟
      },
      {
        id: 'graceful_shutdown',
        name: '优雅关闭',
        description: '优雅关闭应用',
        errorTypes: [ErrorType.SYSTEM, ErrorType.DATABASE],
        level: 3,
        priority: 3,
        action: async () => {
          this.log(LogLevel.INFO, 'system-health', '执行优雅关闭')
          platformAdapter.quit()
          return true
        },
        maxRetries: 1,
        retryDelay: retryDelay
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

    // 处理系统信号
    process.on('SIGINT', () => {
      this.handleShutdown('SIGINT')
    })
  }

  /**
   * 启动监控
   */
  public async start(): Promise<void> {
    if (this.isRunning) {
      return
    }

    this.isRunning = true
    this.startTime = new Date()
    this.log(LogLevel.INFO, 'system-health', '系统健康监控已启动')


    // 启动定期监控
    this.monitoringInterval = setInterval(async () => {
      try {
        await this.performHealthCheck()
      } catch (error) {
        this.log(LogLevel.ERROR, 'system-health', '健康检查失败', { error })
      }
    }, this.config.monitoring.interval)

    // 立即执行一次健康检查
    this.performHealthCheck().catch(error => {
      this.log(LogLevel.ERROR, 'system-health', '初始健康检查失败', { error })
    })
  }

  /**
   * 更新监控间隔
   */
  public updateMonitoringInterval(newInterval: number): void {
    if (this.config.monitoring.interval === newInterval) {
      return
    }

    const prevInterval = this.config.monitoring.interval
    this.config.monitoring.interval = newInterval
    this.log(LogLevel.INFO, 'system-health', `更新监控间隔: ${prevInterval}ms -> ${newInterval}ms`)

    if (this.isRunning && this.monitoringInterval) {
      clearInterval(this.monitoringInterval)
      this.monitoringInterval = setInterval(async () => {
        try {
          await this.performHealthCheck()
        } catch (error) {
          this.log(LogLevel.ERROR, 'system-health', '健康检查失败', { error })
        }
      }, this.config.monitoring.interval)
    }
  }

  /**
   * 停止系统健康监控
   */
  public async stop(): Promise<void> {
    if (!this.isRunning) {
      return
    }

    this.isRunning = false
    this.log(LogLevel.INFO, 'system-health', '系统健康监控已停止')

    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval)
      this.monitoringInterval = null
    }
  }

  /**
   * 执行健康检查
   */
  private async performHealthCheck(): Promise<void> {
    const healthStatus = await this.getSystemHealthStatus()
    
    // 根据健康状态采取相应措施
    if (healthStatus.overall === 'critical') {
      this.handleCriticalHealthStatus(healthStatus)
    } else if (healthStatus.overall === 'warning') {
      this.handleWarningHealthStatus(healthStatus)
    }

    // 发送健康状态更新事件
    this.emit('health-status-updated', healthStatus)
  }

  /**
   * 获取系统健康状态
   */
  public async getSystemHealthStatus(): Promise<SystemHealthStatus> {
    const timestamp = new Date()
    const uptime = timestamp.getTime() - this.startTime.getTime()

    const processHealth = await this.getProcessHealthStatus()
    const memoryHealth = await this.getMemoryHealthStatus()
    const servicesHealth = await this.getServicesHealthStatus()
    const resourcesHealth = await this.getResourceHealthStatus()
    const metrics = await this.getSystemMetrics()

    // 确定整体健康状态
    let overall: 'healthy' | 'warning' | 'critical' = 'healthy'

    if (processHealth.status === 'error' ||
      memoryHealth.status === 'critical' ||
      resourcesHealth.status === 'critical' ||
      servicesHealth.some(s => s.status === 'critical')) {
      overall = 'critical'
    } else if (processHealth.status === 'stopped' ||
      memoryHealth.status === 'warning' ||
      resourcesHealth.status === 'warning' ||
      servicesHealth.some(s => s.status === 'warning')) {
      overall = 'warning';
    }

    return {
      overall,
      timestamp,
      uptime,
      checks: {
        process: processHealth,
        memory: memoryHealth,
        services: servicesHealth,
        resources: resourcesHealth
      },
      metrics
    }
  }

  /**
   * 获取进程健康状态
   */
  private async getProcessHealthStatus(): Promise<ProcessHealthStatus> {
    const memoryUsage = process.memoryUsage()
    const cpuUsage = process.cpuUsage()
    const uptime = process.uptime()

    let status: 'running' | 'stopped' | 'error' = 'running'

    // 检查内存使用是否过高
    const memoryUsageMB = memoryUsage.heapUsed / 1024 / 1024
    if (memoryUsageMB > 1000) { // 超过1GB
      status = 'error'
    }

    return {
      status,
      pid: process.pid,
      cpuUsage: cpuUsage.user / 1000, // 转换为秒
      memoryUsage: memoryUsage.heapUsed,
      uptime,
      lastCheck: new Date()
    }
  }

  /**
   * 获取内存健康状态
   */
  private async getMemoryHealthStatus(): Promise<MemoryHealthStatus> {
    const totalMemory = os.totalmem()
    const freeMemory = os.freemem()
    const usedMemory = totalMemory - freeMemory
    const memoryUsage = (usedMemory / totalMemory) * 100

    let status: 'healthy' | 'warning' | 'critical' = 'healthy'

    if (memoryUsage > this.config.monitoring.extremeThreshold.memory) {
      status = 'critical'
    } else if (memoryUsage > this.config.monitoring.warningThreshold.memory) {
      status = 'warning'
    }

    return {
      status,
      totalMemory,
      freeMemory,
      usedMemory,
      memoryUsage,
      lastCheck: new Date()
    }
  }

  /**
   * 获取服务健康状态
   */
  private async getServicesHealthStatus(): Promise<ServiceHealthStatus[]> {
    const serviceStatuses: ServiceHealthStatus[] = []

    // 检查所有注册的服务
    for (const [serviceName, checkFunction] of this.serviceHealthChecks) {
      try {
        const startTime = Date.now()
        const status = await Promise.race([
          checkFunction(),
          new Promise<ServiceHealthStatus>((_, reject) =>
            setTimeout(() => reject(new Error('Service check timeout')), this.config.services.timeout)
          )
        ])
        const responseTime = Date.now() - startTime

        serviceStatuses.push({
          ...status,
          responseTime
        })
      } catch (error) {
        serviceStatuses.push({
          name: serviceName,
          status: 'critical',
          responseTime: this.config.services.timeout,
          lastCheck: new Date(),
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }

    return serviceStatuses
  }

  /**
   * 获取系统资源健康状态
   */
  private async getResourceHealthStatus(): Promise<ResourceHealthStatus> {
    const cpuUsage = this.getCPUUsage()
    const memoryInfo = this.getMemoryInfo()
    const diskInfo = this.getDiskInfo()

    let status: 'healthy' | 'warning' | 'critical' = 'healthy'

    if (cpuUsage > this.config.monitoring.extremeThreshold.cpu ||
      memoryInfo.usage > this.config.monitoring.extremeThreshold.memory ||
      diskInfo.usage > this.config.monitoring.extremeThreshold.disk) {
      status = 'critical'
    } else if (cpuUsage > this.config.monitoring.warningThreshold.cpu ||
      memoryInfo.usage > this.config.monitoring.warningThreshold.memory ||
      diskInfo.usage > this.config.monitoring.warningThreshold.disk) {
      status = 'warning'
    }

    return {
      status,
      cpu: {
        usage: cpuUsage,
        cores: os.cpus().length
      },
      memory: memoryInfo,
      disk: diskInfo,
      lastCheck: new Date()
    }
  }

  /**
   * 获取系统指标
   */
  public async getSystemMetrics(): Promise<SystemMetrics> {
    const timestamp = new Date()
    const cpuUsage = this.getCPUUsage()
    const memoryInfo = this.getMemoryInfo()
    const diskInfo = this.getDiskInfo()
    const networkInfo = this.getNetworkInfo()
    const uptime = process.uptime()

    const metrics: SystemMetrics = {
      timestamp,
      cpu: {
        usage: cpuUsage,
        loadAverage: os.loadavg()
      },
      memory: memoryInfo,
      disk: diskInfo,
      network: networkInfo,
      uptime
    }

    this.lastMetrics = metrics
    return metrics
  }

  /**
   * 获取CPU使用率
   */
  private getCPUUsage(): number {
    // 简化的CPU使用率计算
    const cpus = os.cpus()
    let totalIdle = 0
    let totalTick = 0

    cpus.forEach(cpu => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type as keyof typeof cpu.times]
      }
      totalIdle += cpu.times.idle
    })

    return totalTick > 0 ? ((totalTick - totalIdle) / totalTick) * 100 : 0
  }

  /**
   * 获取内存信息
   */
  private getMemoryInfo() {
    const totalMemory = os.totalmem()
    const freeMemory = os.freemem()
    const usedMemory = totalMemory - freeMemory
    const usage = (usedMemory / totalMemory) * 100

    return {
      total: totalMemory,
      free: freeMemory,
      used: usedMemory,
      usage
    }
  }

  /**
   * 获取磁盘信息
   */
  private getDiskInfo() {
    // 简化的磁盘信息获取
    const totalDisk = 100 * 1024 * 1024 * 1024 // 假设100GB
    const freeDisk = 50 * 1024 * 1024 * 1024  // 假设50GB
    const usedDisk = totalDisk - freeDisk
    const usage = (usedDisk / totalDisk) * 100

    return {
      total: totalDisk,
      free: freeDisk,
      used: usedDisk,
      usage
    }
  }

  /**
   * 获取网络信息
   */
  private getNetworkInfo() {
    const networkInterfaces = os.networkInterfaces()
    let bytesReceived = 0
    let bytesSent = 0
    let packetsReceived = 0
    let packetsSent = 0
    for (const interfaceName in networkInterfaces) {
      const interfaces = networkInterfaces[interfaceName]
      if (interfaces) {
        interfaces.forEach(iface => {
          if (iface) {
            const anyIface = iface as any
            bytesReceived += anyIface.rx_bytes || 0
            bytesSent += anyIface.tx_bytes || 0
            packetsReceived += anyIface.rx_packets || 0
            packetsSent += anyIface.tx_packets || 0
          }
        })
      }
    }

    return {
      bytesReceived,
      bytesSent,
      packetsReceived,
      packetsSent
    }
  }

  /**
   * 处理关键健康状态
   */
  private async handleCriticalHealthStatus(healthStatus: SystemHealthStatus): Promise<void> {
    this.log(LogLevel.ERROR, 'system-health', '系统处于关键状态', { healthStatus })

    if (this.config.recovery.enabled) {
      await this.attemptRecovery(healthStatus)
    }
  }

  /**
   * 处理警告健康状态
   */
  private async handleWarningHealthStatus(healthStatus: SystemHealthStatus): Promise<void> {
    this.log(LogLevel.WARN, 'system-health', '系统处于警告状态', { healthStatus })

    // 可以在这里添加预警逻辑，比如发送通知
  }

  /**
   * 尝试恢复
   */
  private async attemptRecovery(healthStatus: SystemHealthStatus): Promise<void> {
    this.log(LogLevel.INFO, 'system-health', '尝试系统恢复')

    // 按优先级执行恢复策略
    const sortedStrategies = Array.from(this.recoveryStrategies.values())
      .sort((a, b) => a.priority - b.priority)

    for (const strategy of sortedStrategies) {
      try {
        const success = await this.executeRecoveryStrategy(strategy)
        if (success) {
          this.log(LogLevel.INFO, 'system-health', `恢复策略 ${strategy.name} 执行成功`)
          break
        }
      } catch (error) {
        this.log(LogLevel.ERROR, 'system-health', `恢复策略 ${strategy.name} 执行失败`, { error })
      }
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
        this.log(LogLevel.ERROR, 'system-health', `恢复策略执行失败 (尝试 ${attempts + 1}/${strategy.maxRetries})`, { error })
      }

      attempts++
      if (attempts < strategy.maxRetries) {
        await new Promise(resolve => setTimeout(resolve, strategy.retryDelay))
      }
    }

    return false
  }

  /**
   * 注册服务健康检查
   */
  public registerServiceHealthCheck(name: string, checkFunction: () => Promise<ServiceHealthStatus>): void {
    this.serviceHealthChecks.set(name, checkFunction)
    this.log(LogLevel.INFO, 'system-health', `注册服务健康检查: ${name}`)
  }

  /**
   * 注销服务健康检查
   */
  public unregisterServiceHealthCheck(name: string): void {
    this.serviceHealthChecks.delete(name)
    this.log(LogLevel.INFO, 'system-health', `注销服务健康检查: ${name}`)
  }

  /**
   * 添加恢复策略
   */
  public addRecoveryStrategy(strategy: RecoveryStrategy): void {
    this.recoveryStrategies.set(strategy.id, strategy)
    this.log(LogLevel.INFO, 'system-health', `添加恢复策略: ${strategy.name}`)
  }

  /**
   * 移除恢复策略
   */
  public removeRecoveryStrategy(strategyId: string): void {
    this.recoveryStrategies.delete(strategyId)
    this.log(LogLevel.INFO, 'system-health', `移除恢复策略: ${strategyId}`)
  }

  /**
   * 记录日志
   */
  public log(level: LogLevel, category: string, message: string, data?: any): void {
    if (level > this.config.logging.level) {
      return
    }

    const logEntry: LogEntry = {
      timestamp: new Date(),
      level,
      category,
      message,
      data
    }

    this.logEntries.push(logEntry)

    // 保持日志数量在合理范围内
    if (this.logEntries.length > 1000) {
      this.logEntries = this.logEntries.slice(-1000)
    }

    // 控制台输出
    if (this.config.logging.enableConsole) {
      const levelName = LogLevel[level]
      logger.info(LogCategory.SYSTEM_HEALTH, `[${levelName}] ${category}: ${message}`, data || '')
    }

    // 文件输出
    if (this.config.logging.enableFile) {
      this.writeLogToFile(logEntry)
    }
  }

  /**
   * 写入日志文件
   */
  private writeLogToFile(logEntry: LogEntry): void {
    try {
      const logLine = JSON.stringify(logEntry) + '\n'
      fs.appendFileSync(this.config.logging.filePath, logLine)

      // 检查文件大小，如果超过限制则轮转
      const stats = fs.statSync(this.config.logging.filePath)
      if (stats.size > this.config.logging.maxFileSize) {
        this.rotateLogFile()
      }
    } catch (error) {
      logger.error(LogCategory.SYSTEM_HEALTH, '写入日志文件失败:', error)
    }
  }

  /**
   * 轮转日志文件
   */
  private rotateLogFile(): void {
    const logDir = path.dirname(this.config.logging.filePath)
    const logName = path.basename(this.config.logging.filePath, '.log')

    // 删除最旧的日志文件
    for (let i = this.config.logging.maxFiles - 1;i >= 1;i--) {
      const oldFile = path.join(logDir, `${logName}.${i}.log`)
      if (fs.existsSync(oldFile)) {
        fs.unlinkSync(oldFile)
      }
    }

    // 重命名现有的日志文件
    for (let i = this.config.logging.maxFiles - 1;i >= 1;i--) {
      const oldFile = i === 1 ? this.config.logging.filePath : path.join(logDir, `${logName}.${i - 1}.log`)
      const newFile = path.join(logDir, `${logName}.${i}.log`)

      if (fs.existsSync(oldFile)) {
        fs.renameSync(oldFile, newFile)
      }
    }
  }

  /**
   * 获取日志条目
   */
  public getLogEntries(level?: LogLevel, category?: string, limit?: number): LogEntry[] {
    let filteredLogs = this.logEntries

    if (level !== undefined) {
      filteredLogs = filteredLogs.filter(log => log.level <= level)
    }

    if (category !== undefined) {
      filteredLogs = filteredLogs.filter(log => log.category === category)
    }

    if (limit !== undefined) {
      filteredLogs = filteredLogs.slice(-limit)
    }

    return filteredLogs
  }

  /**
   * 清除日志
   */
  public clearLogs(): void {
    this.logEntries = []
    this.log(LogLevel.INFO, 'system-health', '日志已清除')
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

    this.log(LogLevel.ERROR, 'system-health', '未捕获的异常', appError)
    this.emit('error', appError)

    // 尝试优雅关闭
    if (this.config.recovery.enabled) {
      setTimeout(() => {
        platformAdapter.exit(1)
      }, 1000)
    }
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
        promise
      }
    }

    this.log(LogLevel.ERROR, 'system-health', '未处理的Promise拒绝', appError)
    this.emit('error', appError)
  }

  /**
   * 处理系统关闭信号
   */
  private handleShutdown(signal: string): void {
    this.log(LogLevel.INFO, 'system-health', `接收到关闭信号: ${signal}`)

    // 执行清理操作
    this.stop()

    // 退出应用
    platformAdapter.exit(0)
  }

  /**
   * 更新配置
   */
  public updateConfig(config: Partial<SystemHealthConfig>): void {
    this.config = { ...this.config, ...config }
    this.log(LogLevel.INFO, 'system-health', '配置已更新')
  }

  /**
   * 获取配置
   */
  public getConfig(): SystemHealthConfig {
    return { ...this.config }
  }

  /**
   * 获取最后的系统指标
   */
  public getLastMetrics(): SystemMetrics | null {
    return this.lastMetrics
  }
}

// 导出单例实例
export const systemHealthService = SystemHealthService.getInstance()
