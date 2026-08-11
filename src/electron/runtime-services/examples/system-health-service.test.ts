/**
 * 系统健康检查服务测试
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { systemHealthService } from './system-health-service'
import { loggingService } from './logging-service'
import { errorHandlingService } from './error-handling-service'
import { autoRecoveryService } from './auto-recovery-service'
import { LogLevel, ErrorType } from '@/shared/types/types'

describe('SystemHealthService', () => {
  beforeEach(() => {
    // 重置服务状态
    vi.clearAllMocks()
  })

  afterEach(async () => {
    // 清理服务
    await systemHealthService.stop()
  })

  describe('服务生命周期', () => {
    it('应该能够启动和停止服务', async () => {
      // 启动服务
      await systemHealthService.start()
      expect(systemHealthService['isRunning']).toBe(true)

      // 停止服务
      await systemHealthService.stop()
      expect(systemHealthService['isRunning']).toBe(false)
    })

    it('启动后应该开始健康检查', async () => {
      const healthCheckSpy = vi.spyOn(systemHealthService, 'performHealthCheck')
      
      await systemHealthService.start()
      
      // 等待一段时间让健康检查执行
      await new Promise(resolve => setTimeout(resolve, 100))
      
      expect(healthCheckSpy).toHaveBeenCalled()
    })
  })

  describe('健康状态检查', () => {
    it('应该返回正确的系统健康状态', async () => {
      await systemHealthService.start()
      
      const healthStatus = await systemHealthService.getSystemHealthStatus()
      
      expect(healthStatus).toBeDefined()
      expect(healthStatus.overall).toMatch(/^(healthy|warning|critical)$/)
      expect(healthStatus.timestamp).toBeInstanceOf(Date)
      expect(healthStatus.uptime).toBeGreaterThan(0)
      expect(healthStatus.checks).toBeDefined()
      expect(healthStatus.checks.process).toBeDefined()
      expect(healthStatus.checks.memory).toBeDefined()
      expect(healthStatus.checks.services).toBeDefined()
      expect(healthStatus.checks.resources).toBeDefined()
      expect(healthStatus.metrics).toBeDefined()
    })

    it('应该正确评估进程健康状态', async () => {
      const processHealth = await systemHealthService['getProcessHealthStatus']()
      
      expect(processHealth).toBeDefined()
      expect(processHealth.status).toMatch(/^(running|stopped|error)$/)
      expect(processHealth.pid).toBe(process.pid)
      expect(processHealth.cpuUsage).toBeGreaterThanOrEqual(0)
      expect(processHealth.memoryUsage).toBeGreaterThan(0)
      expect(processHealth.uptime).toBeGreaterThan(0)
      expect(processHealth.lastCheck).toBeInstanceOf(Date)
    })

    it('应该正确评估内存健康状态', async () => {
      const memoryHealth = await systemHealthService['getMemoryHealthStatus']()
      
      expect(memoryHealth).toBeDefined()
      expect(memoryHealth.status).toMatch(/^(healthy|warning|critical)$/)
      expect(memoryHealth.totalMemory).toBeGreaterThan(0)
      expect(memoryHealth.freeMemory).toBeGreaterThan(0)
      expect(memoryHealth.usedMemory).toBeGreaterThan(0)
      expect(memoryHealth.memoryUsage).toBeGreaterThan(0)
      expect(memoryHealth.lastCheck).toBeInstanceOf(Date)
    })
  })

  describe('系统指标', () => {
    it('应该返回正确的系统指标', async () => {
      const metrics = await systemHealthService.getSystemMetrics()
      
      expect(metrics).toBeDefined()
      expect(metrics.timestamp).toBeInstanceOf(Date)
      expect(metrics.cpu).toBeDefined()
      expect(metrics.cpu.usage).toBeGreaterThanOrEqual(0)
      expect(metrics.cpu.usage).toBeLessThanOrEqual(100)
      expect(metrics.memory).toBeDefined()
      expect(metrics.memory.total).toBeGreaterThan(0)
      expect(metrics.disk).toBeDefined()
      expect(metrics.network).toBeDefined()
      expect(metrics.uptime).toBeGreaterThan(0)
    })
  })

  describe('服务健康检查', () => {
    it('应该能够注册和注销服务健康检查', () => {
      const checkFunction = async () => ({
        name: 'test-service',
        status: 'healthy' as const,
        responseTime: 10,
        lastCheck: new Date()
      })

      // 注册服务健康检查
      systemHealthService.registerServiceHealthCheck('test-service', checkFunction)
      expect(systemHealthService['serviceHealthChecks'].has('test-service')).toBe(true)

      // 注销服务健康检查
      systemHealthService.unregisterServiceHealthCheck('test-service')
      expect(systemHealthService['serviceHealthChecks'].has('test-service')).toBe(false)
    })

    it('应该正确执行服务健康检查', async () => {
      const checkFunction = vi.fn().mockResolvedValue({
        name: 'test-service',
        status: 'healthy' as const,
        responseTime: 10,
        lastCheck: new Date()
      })

      systemHealthService.registerServiceHealthCheck('test-service', checkFunction)
      
      await systemHealthService.start()
      
      // 等待一段时间让健康检查执行
      await new Promise(resolve => setTimeout(resolve, 100))
      
      expect(checkFunction).toHaveBeenCalled()
    })
  })

  describe('恢复策略', () => {
    it('应该能够添加和移除恢复策略', () => {
      const strategy = {
        id: 'test-strategy',
        name: '测试策略',
        description: '测试恢复策略',
        errorTypes: [ErrorType.SERVICE],
        priority: 1,
        action: vi.fn().mockResolvedValue(true),
        maxRetries: 3,
        retryDelay: 1000
      }

      // 添加恢复策略
      systemHealthService.addRecoveryStrategy(strategy)
      expect(systemHealthService['recoveryStrategies'].has('test-strategy')).toBe(true)

      // 移除恢复策略
      systemHealthService.removeRecoveryStrategy('test-strategy')
      expect(systemHealthService['recoveryStrategies'].has('test-strategy')).toBe(false)
    })
  })

  describe('配置管理', () => {
    it('应该能够更新配置', () => {
      const originalConfig = systemHealthService.getConfig()
      
      const newConfig = {
        monitoring: {
          enabled: true,
          interval: 60000,
          criticalThreshold: {
            cpu: 95,
            memory: 95,
            disk: 98
          },
          warningThreshold: {
            cpu: 80,
            memory: 85,
            disk: 90
          }
        }
      }

      systemHealthService.updateConfig(newConfig)
      
      const updatedConfig = systemHealthService.getConfig()
      expect(updatedConfig.monitoring.interval).toBe(60000)
    })
  })
})

describe('LoggingService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('日志记录', () => {
    it('应该能够记录不同级别的日志', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      
      loggingService.error('test', '错误消息', { error: 'test error' })
      loggingService.warn('test', '警告消息', { warning: 'test warning' })
      loggingService.info('test', '信息消息', { info: 'test info' })
      loggingService.debug('test', '调试消息', { debug: 'test debug' })
      loggingService.trace('test', '跟踪消息', { trace: 'test trace' })

      expect(consoleSpy).toHaveBeenCalledTimes(5)
    })

    it('应该能够获取日志条目', () => {
      loggingService.info('test', '测试消息')
      
      const logs = loggingService.getLogEntries({ limit: 10 })
      expect(logs.length).toBeGreaterThan(0)
      expect(logs[0].category).toBe('test')
      expect(logs[0].message).toBe('测试消息')
    })

    it('应该能够获取错误日志', () => {
      loggingService.error('test', '错误消息')
      
      const errorLogs = loggingService.getErrorLogs({ limit: 10 })
      expect(errorLogs.length).toBeGreaterThan(0)
      expect(errorLogs[0].level).toBe(LogLevel.ERROR)
    })

    it('应该能够获取日志统计', () => {
      loggingService.info('test', '信息消息')
      loggingService.error('test', '错误消息')
      
      const stats = loggingService.getLogStatistics()
      expect(stats.total).toBeGreaterThan(0)
      expect(stats.byLevel).toBeDefined()
      expect(stats.byCategory).toBeDefined()
    })
  })

  describe('应用错误处理', () => {
    it('应该能够创建应用错误', () => {
      const error = loggingService.createAppError(
        ErrorType.SERVICE,
        'TEST_ERROR',
        '测试错误',
        { details: 'test details' },
        true,
        { context: 'test context' }
      )

      expect(error.type).toBe(ErrorType.SERVICE)
      expect(error.code).toBe('TEST_ERROR')
      expect(error.message).toBe('测试错误')
      expect(error.recoverable).toBe(true)
    })

    it('应该能够记录应用错误', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      
      const error = loggingService.createAppError(
        ErrorType.SERVICE,
        'TEST_ERROR',
        '测试错误'
      )
      
      loggingService.logAppError(error)
      
      expect(consoleSpy).toHaveBeenCalled()
    })
  })

  describe('函数包装', () => {
    it('应该能够包装异步函数', async () => {
      const asyncFn = async () => {
        throw new Error('测试错误')
      }

      const wrappedFn = loggingService.wrapAsyncFunction(
        asyncFn,
        'test',
        { context: 'test context' }
      )

      await expect(wrappedFn()).rejects.toThrow('测试错误')
    })

    it('应该能够包装同步函数', () => {
      const syncFn = () => {
        throw new Error('测试错误')
      }

      const wrappedFn = loggingService.wrapSyncFunction(
        syncFn,
        'test',
        { context: 'test context' }
      )

      expect(() => wrappedFn()).toThrow('测试错误')
    })
  })
})

describe('ErrorHandlingService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('错误处理', () => {
    it('应该能够创建错误', () => {
      const error = errorHandlingService.createError(
        ErrorType.SERVICE,
        'TEST_ERROR',
        '测试错误',
        { details: 'test details' },
        true,
        { context: 'test context' }
      )

      expect(error.type).toBe(ErrorType.SERVICE)
      expect(error.code).toBe('TEST_ERROR')
      expect(error.message).toBe('测试错误')
      expect(error.recoverable).toBe(true)
    })

    it('应该能够处理错误', async () => {
      const error = errorHandlingService.createError(
        ErrorType.SERVICE,
        'TEST_ERROR',
        '测试错误'
      )

      const handleErrorSpy = vi.spyOn(errorHandlingService, 'handleError')
      
      await errorHandlingService.handleError(error)
      
      expect(handleErrorSpy).toHaveBeenCalledWith(error)
    })

    it('应该能够获取错误统计', () => {
      const error = errorHandlingService.createError(
        ErrorType.SERVICE,
        'TEST_ERROR',
        '测试错误'
      )

      errorHandlingService.handleError(error)
      
      const stats = errorHandlingService.getErrorStatistics()
      expect(stats.totalErrors).toBeGreaterThan(0)
      expect(stats.errorsByType).toBeDefined()
      expect(stats.errorsByCode).toBeDefined()
    })
  })

  describe('函数包装', () => {
    it('应该能够包装异步函数', async () => {
      const asyncFn = async () => {
        throw new Error('测试错误')
      }

      const wrappedFn = errorHandlingService.wrapAsyncFunction(
        asyncFn,
        ErrorType.SERVICE,
        'ASYNC_ERROR'
      )

      await expect(wrappedFn()).rejects.toThrow('测试错误')
    })

    it('应该能够包装同步函数', () => {
      const syncFn = () => {
        throw new Error('测试错误')
      }

      const wrappedFn = errorHandlingService.wrapSyncFunction(
        syncFn,
        ErrorType.SERVICE,
        'SYNC_ERROR'
      )

      expect(() => wrappedFn()).toThrow('测试错误')
    })
  })

  describe('恢复策略', () => {
    it('应该能够添加和移除恢复策略', () => {
      const strategy = {
        id: 'test-strategy',
        name: '测试策略',
        description: '测试恢复策略',
        errorTypes: [ErrorType.SERVICE],
        priority: 1,
        action: vi.fn().mockResolvedValue(true),
        maxRetries: 3,
        retryDelay: 1000
      }

      errorHandlingService.addRecoveryStrategy(strategy)
      expect(errorHandlingService.getRecoveryStrategies()).toContain(strategy)

      errorHandlingService.removeRecoveryStrategy('test-strategy')
      expect(errorHandlingService.getRecoveryStrategies()).not.toContain(strategy)
    })
  })
})

describe('AutoRecoveryService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('恢复功能', () => {
    it('应该能够启用和禁用自动恢复', () => {
      autoRecoveryService.enableRecovery()
      expect(autoRecoveryService['isRecoveryEnabled']).toBe(true)

      autoRecoveryService.disableRecovery()
      expect(autoRecoveryService['isRecoveryEnabled']).toBe(false)
    })

    it('应该能够获取恢复统计', () => {
      const stats = autoRecoveryService.getRecoveryStats()
      expect(stats).toBeDefined()
      expect(stats.totalAttempts).toBeGreaterThanOrEqual(0)
      expect(stats.successfulRecoveries).toBeGreaterThanOrEqual(0)
      expect(stats.failedRecoveries).toBeGreaterThanOrEqual(0)
      expect(stats.successRate).toBeGreaterThanOrEqual(0)
    })

    it('应该能够获取恢复历史', () => {
      const history = autoRecoveryService.getRecoveryHistory({ limit: 10 })
      expect(Array.isArray(history)).toBe(true)
    })

    it('应该能够添加恢复策略', () => {
      const strategy = {
        id: 'test-strategy',
        name: '测试策略',
        description: '测试恢复策略',
        errorTypes: [ErrorType.SERVICE],
        priority: 1,
        action: vi.fn().mockResolvedValue(true),
        maxRetries: 3,
        retryDelay: 1000
      }

      autoRecoveryService.addRecoveryStrategy(strategy)
      expect(autoRecoveryService.getRecoveryStrategies()).toContain(strategy)
    })
  })

  describe('系统恢复检查', () => {
    it('应该能够检查系统是否需要恢复', async () => {
      const needsRecovery = await autoRecoveryService.checkSystemRecoveryNeeded()
      expect(typeof needsRecovery).toBe('boolean')
    })
  })
})

describe('集成测试', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await systemHealthService.start()
  })

  afterEach(async () => {
    await systemHealthService.stop()
  })

  it('应该能够协同工作', async () => {
    // 创建一个错误
    const error = errorHandlingService.createError(
      ErrorType.SERVICE,
      'INTEGRATION_TEST_ERROR',
      '集成测试错误'
    )

    // 记录错误
    loggingService.logAppError(error)

    // 处理错误
    await errorHandlingService.handleError(error)

    // 获取系统健康状态
    const healthStatus = await systemHealthService.getSystemHealthStatus()
    expect(healthStatus).toBeDefined()

    // 获取错误统计
    const errorStats = errorHandlingService.getErrorStatistics()
    expect(errorStats.totalErrors).toBeGreaterThan(0)

    // 获取日志统计
    const logStats = loggingService.getLogStatistics()
    expect(logStats.total).toBeGreaterThan(0)
  })

  it('应该能够处理系统健康状态变化', async () => {
    // 监听健康状态变化
    const healthStatusListener = vi.fn()
    systemHealthService.on('health-status-updated', healthStatusListener)

    // 等待健康检查执行
    await new Promise(resolve => setTimeout(resolve, 100))

    expect(healthStatusListener).toHaveBeenCalled()
  })
})