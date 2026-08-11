/**
 * 系统健康检查服务使用示例
 */
import { systemHealthService } from './system-health-service'
import { loggingService } from './logging-service'
import { errorHandlingService } from './error-handling-service'
import { autoRecoveryService } from './auto-recovery-service'
import { ErrorType, LogLevel } from '@/shared/types/types'

/**
 * 基本使用示例
 */
async function basicUsageExample(): Promise<void> {
  try {
    // 1. 启动系统健康检查服务
    await systemHealthService.start()
    console.log('系统健康检查服务已启动')

    // 2. 获取系统健康状态
    const healthStatus = await systemHealthService.getSystemHealthStatus()
    console.log('系统健康状态:', healthStatus)

    // 3. 获取系统指标
    const metrics = await systemHealthService.getSystemMetrics()
    console.log('系统指标:', metrics)

    // 4. 停止系统健康检查服务
    await systemHealthService.stop()
    console.log('系统健康检查服务已停止')
  } catch (error) {
    console.error('基本使用示例失败:', error)
  }
}

/**
 * 日志服务使用示例
 */
function loggingServiceExample(): void {
  // 1. 记录不同级别的日志
  loggingService.error('example', '这是一个错误日志', { errorCode: 500 })
  loggingService.warn('example', '这是一个警告日志', { warning: '内存使用过高' })
  loggingService.info('example', '这是一个信息日志', { status: '服务启动成功' })
  loggingService.debug('example', '这是一个调试日志', { debug: '详细调试信息' })
  loggingService.trace('example', '这是一个跟踪日志', { trace: '详细跟踪信息' })

  // 2. 获取日志条目
  const recentLogs = loggingService.getLogEntries({ limit: 10 })
  console.log('最近的日志:', recentLogs)

  // 3. 获取错误日志
  const errorLogs = loggingService.getErrorLogs({ limit: 5 })
  console.log('错误日志:', errorLogs)

  // 4. 获取日志统计
  const logStats = loggingService.getLogStatistics()
  console.log('日志统计:', logStats)

  // 5. 导出日志到文件
  const exportSuccess = loggingService.exportLogs('./exported-logs.json')
  console.log('日志导出结果:', exportSuccess)
}

/**
 * 错误处理服务使用示例
 */
async function errorHandlingServiceExample(): Promise<void> {
  // 1. 创建应用错误
  const appError = errorHandlingService.createError(
    ErrorType.SERVICE,
    'SERVICE_TIMEOUT',
    '服务超时错误',
    { serviceName: 'database', timeout: 5000 },
    true,
    { userId: '12345' }
  )

  // 2. 处理错误
  await errorHandlingService.handleError(appError)

  // 3. 包装异步函数
  const riskyOperation = async () => {
    // 模拟可能失败的操作
    if (Math.random() > 0.5) {
      throw new Error('随机错误')
    }
    return '操作成功'
  }

  const wrappedOperation = errorHandlingService.wrapAsyncFunction(
    riskyOperation,
    ErrorType.SERVICE,
    'RISKY_OPERATION_ERROR',
    { operationId: 'op-123' }
  )

  try {
    const result = await wrappedOperation()
    console.log('操作结果:', result)
  } catch (error) {
    console.log('操作失败，但已被错误处理服务捕获')
  }

  // 4. 获取错误统计
  const errorStats = errorHandlingService.getErrorStatistics()
  console.log('错误统计:', errorStats)

  // 5. 获取错误历史
  const errorHistory = errorHandlingService.getErrorHistory({ limit: 10 })
  console.log('错误历史:', errorHistory)
}

/**
 * 自动恢复服务使用示例
 */
async function autoRecoveryServiceExample(): Promise<void> {
  // 1. 获取恢复统计
  const recoveryStats = autoRecoveryService.getRecoveryStats()
  console.log('恢复统计:', recoveryStats)

  // 2. 获取恢复历史
  const recoveryHistory = autoRecoveryService.getRecoveryHistory({ limit: 10 })
  console.log('恢复历史:', recoveryHistory)

  // 3. 手动触发恢复
  const testError = errorHandlingService.createError(
    ErrorType.SERVICE,
    'TEST_ERROR',
    '测试错误',
    null,
    true
  )

  const recoveryResult = await autoRecoveryService.triggerManualRecovery(testError)
  console.log('手动恢复结果:', recoveryResult)

  // 4. 启用/禁用自动恢复
  autoRecoveryService.enableRecovery()
  console.log('自动恢复已启用')

  // autoRecoveryService.disableRecovery()
  // console.log('自动恢复已禁用')
}

/**
 * 自定义服务健康检查示例
 */
async function customServiceHealthCheckExample(): Promise<void> {
  // 1. 注册自定义服务健康检查
  systemHealthService.registerServiceHealthCheck('custom-service', async () => {
    try {
      // 模拟服务健康检查
      const isHealthy = Math.random() > 0.1 // 90%的概率健康
      
      return {
        name: 'custom-service',
        status: isHealthy ? 'healthy' : 'critical',
        responseTime: Math.floor(Math.random() * 100) + 10,
        lastCheck: new Date(),
        details: { customMetric: Math.random() * 100 }
      }
    } catch (error) {
      return {
        name: 'custom-service',
        status: 'critical',
        responseTime: 0,
        lastCheck: new Date(),
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  // 2. 获取系统健康状态（包含自定义服务）
  const healthStatus = await systemHealthService.getSystemHealthStatus()
  console.log('包含自定义服务的健康状态:', healthStatus)

  // 3. 注销服务健康检查
  systemHealthService.unregisterServiceHealthCheck('custom-service')
  console.log('自定义服务健康检查已注销')
}

/**
 * 自定义恢复策略示例
 */
async function customRecoveryStrategyExample(): Promise<void> {
  // 1. 添加自定义恢复策略
  const customStrategy = {
    id: 'custom-recovery',
    name: '自定义恢复策略',
    description: '自定义恢复策略示例',
    errorTypes: [ErrorType.SERVICE],
    priority: 10,
    action: async () => {
      console.log('执行自定义恢复策略')
      // 模拟恢复操作
      await new Promise(resolve => setTimeout(resolve, 1000))
      return Math.random() > 0.2 // 80%的成功率
    },
    maxRetries: 3,
    retryDelay: 2000
  }

  autoRecoveryService.addRecoveryStrategy(customStrategy)
  console.log('自定义恢复策略已添加')

  // 2. 触发恢复测试
  const testError = errorHandlingService.createError(
    ErrorType.SERVICE,
    'TEST_CUSTOM_RECOVERY',
    '测试自定义恢复',
    null,
    true
  )

  await autoRecoveryService.triggerManualRecovery(testError)

  // 3. 移除自定义恢复策略
  autoRecoveryService.removeRecoveryStrategy('custom-recovery')
  console.log('自定义恢复策略已移除')
}

/**
 * 事件监听示例
 */
function eventListenerExample(): void {
  // 1. 监听系统健康状态更新
  systemHealthService.on('health-status-updated', (healthStatus) => {
    console.log('健康状态更新:', healthStatus)
    
    if (healthStatus.overall === 'critical') {
      console.warn('系统处于关键状态！')
    }
  })

  // 2. 监听错误事件
  errorHandlingService.on('error', (error) => {
    console.error('检测到错误:', error)
  })

  // 3. 监听恢复成功事件
  autoRecoveryService.on('recovery-success', (data) => {
    console.log('恢复成功:', data)
  })

  // 4. 监听恢复失败事件
  autoRecoveryService.on('recovery-failed', (data) => {
    console.error('恢复失败:', data)
  })
}

/**
 * 配置更新示例
 */
function configurationExample(): void {
  // 1. 更新系统健康检查配置
  systemHealthService.updateConfig({
    monitoring: {
      enabled: true,
      interval: 15000, // 15秒
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
    },
    logging: {
      level: LogLevel.DEBUG,
      maxFileSize: 20 * 1024 * 1024, // 20MB
      maxFiles: 10,
      enableConsole: true,
      enableFile: true,
      filePath: './logs/custom-health.log'
    }
  })

  // 2. 更新日志服务配置
  loggingService.updateConfig({
    level: LogLevel.INFO,
    maxFileSize: 15 * 1024 * 1024, // 15MB
    maxFiles: 8,
    enableConsole: true,
    enableFile: true,
    filePath: './logs/custom-app.log',
    enableStructuredLogging: true,
    enableErrorTracking: false
  })

  console.log('配置已更新')
}

/**
 * 综合示例
 */
async function comprehensiveExample(): Promise<void> {
  console.log('=== 开始综合示例 ===')

  try {
    // 1. 启动服务
    await systemHealthService.start()
    console.log('✓ 系统健康检查服务已启动')

    // 2. 设置事件监听
    eventListenerExample()
    console.log('✓ 事件监听器已设置')

    // 3. 更新配置
    configurationExample()
    console.log('✓ 配置已更新')

    // 4. 注册自定义服务健康检查
    await customServiceHealthCheckExample()
    console.log('✓ 自定义服务健康检查已完成')

    // 5. 添加自定义恢复策略
    await customRecoveryStrategyExample()
    console.log('✓ 自定义恢复策略已完成')

    // 6. 执行日志服务示例
    loggingServiceExample()
    console.log('✓ 日志服务示例已完成')

    // 7. 执行错误处理服务示例
    await errorHandlingServiceExample()
    console.log('✓ 错误处理服务示例已完成')

    // 8. 执行自动恢复服务示例
    await autoRecoveryServiceExample()
    console.log('✓ 自动恢复服务示例已完成')

    // 9. 获取最终系统状态
    const finalHealthStatus = await systemHealthService.getSystemHealthStatus()
    console.log('最终系统健康状态:', finalHealthStatus)

    // 10. 清理
    await systemHealthService.stop()
    console.log('✓ 系统健康检查服务已停止')

    console.log('=== 综合示例完成 ===')
  } catch (error) {
    console.error('综合示例失败:', error)
  }
}

// 导出示例函数
export {
  basicUsageExample,
  loggingServiceExample,
  errorHandlingServiceExample,
  autoRecoveryServiceExample,
  customServiceHealthCheckExample,
  customRecoveryStrategyExample,
  eventListenerExample,
  configurationExample,
  comprehensiveExample
}

// 如果直接运行此文件，执行综合示例
if (require.main === module) {
  comprehensiveExample().catch(console.error)
}