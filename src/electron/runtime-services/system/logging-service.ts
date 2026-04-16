import * as path from 'path'
import * as fs from 'fs'
import { platformAdapter } from './platform-adapter'
import { 
  LogLevel, 
  LogEntry, 
  AppError, 
  ErrorType 
} from '@yonuc/types'
import { LogCategory } from '@yonuc/shared'

/**
 * 日志服务类
 */
export class LoggingService {
  private static instance: LoggingService
  private logEntries: LogEntry[] = []
  private config: {
    level: LogLevel
    maxFileSize: number
    maxFiles: number
    enableConsole: boolean
    enableFile: boolean
    filePath: string
    enableStructuredLogging: boolean
    enableErrorTracking: boolean
  }

  private constructor() {
    this.config = {
      level: LogLevel.INFO,
      maxFileSize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
      enableConsole: false,
      enableFile: true,
      filePath: path.join(platformAdapter.getAppDataPath(), 'logs', 'app.log'),
      enableStructuredLogging: true,
      enableErrorTracking: false
    }

    // 确保日志目录存在
    const logDir = path.dirname(this.config.filePath)
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true })
    }

    // 设置全局错误处理
    this.setupGlobalErrorHandling()
  }

  private suppressDuplicates = true
  private suppressWindowMs = 60 * 1000
  private suppressionMap: Map<string, { count: number; firstTs: number; lastTs: number }> = new Map()

  private stableSerialize(obj: any): string {
    if (obj === null || obj === undefined) return 'null'
    if (typeof obj !== 'object') return String(obj)
    if (Array.isArray(obj)) return `[${obj.map(v => this.stableSerialize(v)).join(',')}]`
    const keys = Object.keys(obj).sort()
    const entries = keys.map(k => `"${k}":${this.stableSerialize((obj as any)[k])}`)
    return `{${entries.join(',')}}`
  }

  private makeSuppressionKey(entry: LogEntry): string {
    const dataSig = this.stableSerialize(entry.data)
    return `${entry.level}|${entry.category}|${entry.message}|${dataSig}`
  }

  /**
   * 获取单例实例
   */
  public static getInstance(): LoggingService {
    if (!LoggingService.instance) {
      LoggingService.instance = new LoggingService()
    }
    return LoggingService.instance
  }

  /**
   * 设置全局错误处理
   */
  private setupGlobalErrorHandling(): void {
    if (this.config.enableErrorTracking) {
      process.on('uncaughtException', (error) => {
        this.error(LogCategory.ERROR, '未捕获的异常', {
          error: error.message,
          stack: error.stack,
          name: error.name
        })
      })

      process.on('unhandledRejection', (reason, promise) => {
        this.error(LogCategory.ERROR, '未处理的Promise拒绝', {
          reason: reason instanceof Error ? reason.message : String(reason),
          promise: promise.toString()
        })
      })
    }
  }

  /**
   * 记录错误级别日志
   */
  public error(category: LogCategory, message: string, data?: any, stack?: string): void {
    this.log(LogLevel.ERROR, category, message, data, stack)
  }

  /**
   * 记录警告级别日志
   */
  public warn(category: LogCategory, message: string, data?: any): void {
    this.log(LogLevel.WARN, category, message, data)
  }

  /**
   * 记录信息级别日志
   */
  public info(category: LogCategory, message: string, data?: any): void {
    this.log(LogLevel.INFO, category, message, data)
  }

  /**
   * 记录调试级别日志
   */
  public debug(category: LogCategory, message: string, data?: any): void {
    this.log(LogLevel.DEBUG, category, message, data)
  }

  /**
   * 记录跟踪级别日志
   */
  public trace(category: LogCategory, message: string, data?: any): void {
    this.log(LogLevel.TRACE, category, message, data)
  }

  /**
   * 记录应用错误
   */
  public logAppError(error: AppError): void {
    this.error(
      LogCategory.ERROR,
      error.code,
      {
        message: error.message,
        details: error.details,
        context: error.context,
        recoverable: error.recoverable,
        errorType: error.type
      },
      error.stack
    )
  }

  /**
   * 记录日志
   */
  public log(level: LogLevel, category: LogCategory, message: string, data?: any, stack?: string): void {
    if (level > this.config.level) {
      return
    }

    const logEntry: LogEntry = {
      timestamp: new Date(),
      level,
      category: category as string, // 将枚举转换为字符串存储
      message,
      data,
      stack
    }

    // 添加到内存中的日志列表
    this.logEntries.push(logEntry)

    // 保持日志数量在合理范围内
    if (this.logEntries.length > 10000) {
      this.logEntries = this.logEntries.slice(-10000)
    }

    if (this.suppressDuplicates) {
      const key = this.makeSuppressionKey(logEntry)
      const now = Date.now()
      const record = this.suppressionMap.get(key)
      if (!record) {
        this.suppressionMap.set(key, { count: 1, firstTs: now, lastTs: now })
      } else {
        if (now - record.lastTs < this.suppressWindowMs) {
          record.count += 1
          record.lastTs = now
          return
        } else {
          if (record.count > 1) {
            const summary: LogEntry = {
              timestamp: new Date(),
              level: LogLevel.INFO,
              category: logEntry.category,
              message: `重复日志已抑制 ${record.count} 次: ${logEntry.message}`,
              data: undefined,
              stack: undefined
            }
            if (this.config.enableConsole) {
              this.logToConsole(summary)
            }
            if (this.config.enableFile) {
              this.logToFile(summary)
            }
          }
          this.suppressionMap.set(key, { count: 1, firstTs: now, lastTs: now })
        }
      }
    }

    // 控制台输出
    if (this.config.enableConsole) {
      this.logToConsole(logEntry)
    }

    // 文件输出
    if (this.config.enableFile) {
      this.logToFile(logEntry)
    }
  }

  /**
   * 控制台输出日志
   */
  private logToConsole(logEntry: LogEntry): void {
    const levelName = LogLevel[logEntry.level]
    const timestamp = logEntry.timestamp.toISOString()
    
    if (this.config.enableStructuredLogging) {
      console.log(`[${timestamp}] [${levelName}] [${logEntry.category}] ${logEntry.message}`, logEntry.data || '')
    } else {
      console.log(`[${timestamp}] [${levelName}] [${logEntry.category}] ${logEntry.message}`)
    }
  }

  /**
   * 文件输出日志
   */
  private logToFile(logEntry: LogEntry): void {
    try {
      let logLine: string
      
      if (this.config.enableStructuredLogging) {
        logLine = JSON.stringify(logEntry) + '\n'
      } else {
        const levelName = LogLevel[logEntry.level]
        const timestamp = logEntry.timestamp.toISOString()
        logLine = `[${timestamp}] [${levelName}] [${logEntry.category}] ${logEntry.message}\n`
        
        if (logEntry.data) {
          logLine += `Data: ${JSON.stringify(logEntry.data)}\n`
        }
        
        if (logEntry.stack) {
          logLine += `Stack: ${logEntry.stack}\n`
        }
        
        logLine += '\n'
      }

      fs.appendFileSync(this.config.filePath, logLine, 'utf8')
      
      // 检查文件大小，如果超过限制则轮转
      const stats = fs.statSync(this.config.filePath)
      if (stats.size > this.config.maxFileSize) {
        this.rotateLogFile()
      }
    } catch (error) {
      console.error('写入日志文件失败:', error)
    }
  }

  /**
   * 轮转日志文件
   */
  private rotateLogFile(): void {
    const logDir = path.dirname(this.config.filePath)
    const logName = path.basename(this.config.filePath, '.log')
    
    // 删除最旧的日志文件
    const oldestFile = path.join(logDir, `${logName}.${this.config.maxFiles}.log`)
    if (fs.existsSync(oldestFile)) {
      fs.unlinkSync(oldestFile)
    }

    // 重命名现有的日志文件
    for (let i = this.config.maxFiles - 1; i >= 1; i--) {
      const oldFile = i === 1 ? this.config.filePath : path.join(logDir, `${logName}.${i}.log`)
      const newFile = path.join(logDir, `${logName}.${i + 1}.log`)
      
      if (fs.existsSync(oldFile)) {
        fs.renameSync(oldFile, newFile)
      }
    }
  }

  /**
   * 获取日志条目
   */
  public getLogEntries(options?: {
    level?: LogLevel
    category?: string
    startTime?: Date
    endTime?: Date
    limit?: number
    offset?: number
  }): LogEntry[] {
    let filteredLogs = [...this.logEntries]

    // 按级别过滤
    if (options?.level !== undefined) {
      filteredLogs = filteredLogs.filter(log => log.level <= options.level!)
    }

    // 按类别过滤
    if (options?.category !== undefined) {
      filteredLogs = filteredLogs.filter(log => log.category === options.category)
    }

    // 按时间范围过滤
    if (options?.startTime !== undefined) {
      filteredLogs = filteredLogs.filter(log => log.timestamp >= options.startTime!)
    }

    if (options?.endTime !== undefined) {
      filteredLogs = filteredLogs.filter(log => log.timestamp <= options.endTime!)
    }

    // 按偏移量过滤
    if (options?.offset !== undefined && options.offset > 0) {
      filteredLogs = filteredLogs.slice(options.offset)
    }

    // 按数量限制
    if (options?.limit !== undefined) {
      filteredLogs = filteredLogs.slice(0, options.limit)
    }

    return filteredLogs.reverse() // 最新的日志在前
  }

  /**
   * 获取错误日志
   */
  public getErrorLogs(options?: {
    category?: string
    startTime?: Date
    endTime?: Date
    limit?: number
  }): LogEntry[] {
    return this.getLogEntries({
      level: LogLevel.ERROR,
      ...options
    })
  }

  /**
   * 获取日志统计信息
   */
  public getLogStatistics(): {
    total: number
    byLevel: Record<string, number>
    byCategory: Record<string, number>
    recentErrors: LogEntry[]
  } {
    const byLevel: Record<string, number> = {}
    const byCategory: Record<string, number> = {}

    // 初始化统计
    Object.values(LogLevel).forEach(level => {
      if (typeof level === 'number') {
        byLevel[LogLevel[level]] = 0
      }
    })

    // 统计日志
    this.logEntries.forEach(log => {
      const levelName = LogLevel[log.level]
      byLevel[levelName] = (byLevel[levelName] || 0) + 1
      byCategory[log.category] = (byCategory[log.category] || 0) + 1
    })

    // 获取最近的错误日志
    const recentErrors = this.getErrorLogs({ limit: 10 })

    return {
      total: this.logEntries.length,
      byLevel,
      byCategory,
      recentErrors
    }
  }

  /**
   * 清除日志
   */
  public clearLogs(): void {
    this.logEntries = []
    this.info(LogCategory.LOGGING_SERVICE, '日志已清除')
  }

  /**
   * 清除旧日志
   */
  public clearOldLogs(olderThan: Date): void {
    const beforeCount = this.logEntries.length
    this.logEntries = this.logEntries.filter(log => log.timestamp >= olderThan)
    const afterCount = this.logEntries.length
    
    this.info(LogCategory.LOGGING_SERVICE, `清除了 ${beforeCount - afterCount} 条旧日志`)
  }

  /**
   * 导出日志到文件
   */
  public exportLogs(filePath: string, options?: {
    level?: LogLevel
    category?: string
    startTime?: Date
    endTime?: Date
  }): boolean {
    try {
      const logs = this.getLogEntries(options)
      const logContent = logs.map(log => JSON.stringify(log)).join('\n')
      
      fs.writeFileSync(filePath, logContent, 'utf8')
      this.info(LogCategory.LOGGING_SERVICE, `日志已导出到 ${filePath}`)
      
      return true
    } catch (error) {
      this.error(LogCategory.LOGGING_SERVICE, `导出日志失败: ${error}`)
      return false
    }
  }

  /**
   * 更新配置
   */
  public updateConfig(config: Partial<typeof this.config>): void {
    this.config = { ...this.config, ...config }
    this.info(LogCategory.LOGGING_SERVICE, '日志配置已更新')
  }

  /**
   * 获取配置
   */
  public getConfig(): typeof this.config {
    return { ...this.config }
  }

  /**
   * 创建应用错误对象
   */
  public createAppError(
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
   * 包装异步函数以添加错误处理和日志记录
   */
  public wrapAsyncFunction<T>(
    fn: () => Promise<T>,
    category: LogCategory,
    context?: any
  ): Promise<T> {
    return fn().catch(error => {
      const appError = this.createAppError(
        ErrorType.SYSTEM,
        'ASYNC_FUNCTION_ERROR',
        error instanceof Error ? error.message : String(error),
        error,
        true,
        context
      )
      
      this.logAppError(appError)
      throw error
    })
  }

  /**
   * 包装同步函数以添加错误处理和日志记录
   */
  public wrapSyncFunction<T>(
    fn: () => T,
    category: LogCategory,
    context?: any
  ): T {
    try {
      return fn()
    } catch (error) {
      const appError = this.createAppError(
        ErrorType.SYSTEM,
        'SYNC_FUNCTION_ERROR',
        error instanceof Error ? error.message : String(error),
        error,
        true,
        context
      )
      
      this.logAppError(appError)
      throw error
    }
  }
}

// 导出单例实例
export const loggingService = LoggingService.getInstance()
