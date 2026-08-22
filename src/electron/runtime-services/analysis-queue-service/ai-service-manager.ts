import { AIServiceStatus, ILlamaIndexAIService } from '@firefly/types'
import { ConfigOrchestrator } from '@app/electron/config/config-orchestrator'
import { LogCategory, logger, isTestEnvironment } from '@firefly/shared'
import { t } from '@app/languages'

/**
 * AI 服务状态管理器
 * 处理 AI 引擎的就绪等待、健康检查和自动恢复逻辑
 */
export class AIServiceManager {
  private lastHealthCheckOkTime = 0
  private static readonly HEALTH_CHECK_CACHE_TTL = 30000

  constructor(
    private getAIService: () => ILlamaIndexAIService | undefined,
    private isRunning: () => boolean,
    private notifyFrontend: (
      type: 'info' | 'success' | 'warning' | 'error',
      message: string,
      sticky?: boolean,
      id?: string,
      autoClose?: number,
      action?: any
    ) => Promise<void>
  ) {}

  /**
   * 获取最近一次健康检查成功的时间戳
   */
  getLastHealthCheckOkTime(): number {
    return this.lastHealthCheckOkTime
  }

  /**
   * 重置健康检查时间戳（用于测试或强制重新检查）
   */
  resetHealthCheckCache(): void {
    this.lastHealthCheckOkTime = 0
  }

  /**
   * 等待 AI 服务就绪
   */
  async waitForAIServiceReady(): Promise<boolean> {
    // 集成测试环境或云端模式下，跳过就绪检查
    const isTest = isTestEnvironment()
    const mode = ConfigOrchestrator.getInstance().getValue<string>('AI_SERVICE_MODE')

    if (isTest || mode === 'cloud') {
      logger.info(
        LogCategory.ANALYSIS_QUEUE,
        `[分析队列] ${isTest ? '测试环境' : '云端模式'}跳过 AI 服务就绪检查`
      )
      return true
    }

    const aiService = this.getAIService()
    if (!aiService) {
      logger.warn(LogCategory.ANALYSIS_QUEUE, '[分析队列] AI 服务未初始化，无法检查状态')
      return true
    }

    let status = aiService.getServiceStatus()

    if (status === AIServiceStatus.IDLE || status === AIServiceStatus.PROCESSING) {
      // 【性能优化】如果上次深度健康检查在缓存有效期内，直接返回成功
      // 避免处理大量文件时每个文件前都发一次 HTTP 健康检查
      const now = Date.now()
      if (
        this.lastHealthCheckOkTime > 0 &&
        now - this.lastHealthCheckOkTime < AIServiceManager.HEALTH_CHECK_CACHE_TTL
      ) {
        logger.debug(
          LogCategory.ANALYSIS_QUEUE,
          `[分析队列] 命中健康检查缓存（上次检查通过距今 ${(now - this.lastHealthCheckOkTime) / 1000}s）`
        )
        return true
      }

      // 【修复】即使高层状态为 IDLE，也需要深度检查底层服务是否真正在运行
      // 防止服务器进程已崩溃但状态未更新的情况（健康检查间隔5分钟，自动重启默认关闭）
      try {
        const isHealthy = await aiService.healthCheck()
        if (isHealthy) {
          this.lastHealthCheckOkTime = Date.now()
          return true
        }
        // 健康检查失败，清除缓存
        this.lastHealthCheckOkTime = 0
        // 健康检查失败但状态显示 IDLE —— 服务进程已崩溃，需要触发恢复
        logger.warn(
          LogCategory.ANALYSIS_QUEUE,
          '[分析队列] AI服务状态为IDLE但健康检查失败（底层服务未运行），尝试重启服务...'
        )
        this.notifyFrontend('info', t('AI引擎异常断开，正在重新连接...'), true, 'waiting-for-ai', 0)
      } catch (healthError) {
        // 健康检查异常，清除缓存
        this.lastHealthCheckOkTime = 0
        logger.error(LogCategory.ANALYSIS_QUEUE, '[分析队列] AI服务健康检查异常:', healthError)
        this.notifyFrontend('info', t('AI引擎状态异常，正在尝试恢复...'), true, 'waiting-for-ai', 0)
      }

      // 尝试重启 AI 服务（initialize 内部会清理旧连接并重新启动进程）
      try {
        // 先停止再重新初始化，确保底层进程被重新拉起
        await aiService.restart()
        status = aiService.getServiceStatus()
        if (status === AIServiceStatus.IDLE || status === AIServiceStatus.PROCESSING) {
          // 再次验证健康检查
          const isHealthyAfterRestart = await aiService.healthCheck()
          if (isHealthyAfterRestart) {
            logger.info(LogCategory.ANALYSIS_QUEUE, '[分析队列] AI服务重启成功，底层服务已恢复运行')
            this.lastHealthCheckOkTime = Date.now()
            this.notifyFrontend('success', t('AI引擎已恢复'), false, 'waiting-for-ai', 3000)
            return true
          }
        }
        logger.error(LogCategory.ANALYSIS_QUEUE, '[分析队列] AI服务重启后状态仍异常:', status)
      } catch (restartError) {
        logger.error(LogCategory.ANALYSIS_QUEUE, '[分析队列] AI服务重启失败:', restartError)
      }

      // 重启失败，返回 false 让队列暂停
      this.notifyFrontend(
        'error',
        t('AI引擎启动失败，请检查配置后重试'),
        false,
        'waiting-for-ai',
        5000
      )
      return false
    }

    logger.info(
      LogCategory.ANALYSIS_QUEUE,
      `[分析队列] AI服务未就绪 (当前状态: ${status}), 开始等待...`
    )

    // 发送通知给前端
    this.notifyFrontend('info', t('正在等待AI引擎启动，请稍候...'), true, 'waiting-for-ai', 0)

    // 等待状态变化，最多等待 120 秒
    const startTime = Date.now()
    while (Date.now() - startTime < 120000) {
      // 如果在此期间用户手动暂停了队列，停止等待
      if (!this.isRunning()) {
        this.notifyFrontend('info', t('分析已暂停'), false, 'waiting-for-ai', 3000)
        return false
      }

      status = aiService.getServiceStatus()
      if (status === AIServiceStatus.IDLE || status === AIServiceStatus.PROCESSING) {
        logger.info(LogCategory.ANALYSIS_QUEUE, '[分析队列] AI服务已就绪，继续执行')
        this.notifyFrontend('success', t('AI引擎已就绪，开始分析'), false, 'waiting-for-ai', 3000)
        return true
      }

      if (status === AIServiceStatus.ERROR) {
        logger.warn(LogCategory.ANALYSIS_QUEUE, '[分析队列] AI服务处于错误状态，尝试重启...')
        this.notifyFrontend('info', t('AI引擎状态异常，正在尝试重启...'), true, 'waiting-for-ai', 0)

        // 尝试重启 AI 服务（与 IDLE 分支的健康检查失败后相同策略）
        try {
          await aiService.restart()
          status = aiService.getServiceStatus()
          if (status === AIServiceStatus.IDLE || status === AIServiceStatus.PROCESSING) {
            logger.info(LogCategory.ANALYSIS_QUEUE, '[分析队列] AI服务重启成功，继续执行')
            this.lastHealthCheckOkTime = Date.now()
            this.notifyFrontend('success', t('AI引擎已恢复'), false, 'waiting-for-ai', 3000)
            return true
          }
          logger.error(LogCategory.ANALYSIS_QUEUE, `[分析队列] AI服务重启后状态仍异常: ${status}`)
        } catch (restartError) {
          logger.error(LogCategory.ANALYSIS_QUEUE, '[分析队列] AI服务重启失败:', restartError)
        }

        // 重启失败，停止等待
        this.notifyFrontend(
          'error',
          t('AI引擎启动失败，请检查配置后重试'),
          false,
          'waiting-for-ai',
          5000
        )
        return false
      }

      // 每秒检查一次
      await new Promise(resolve => setTimeout(resolve, 1000))
    }

    logger.error(LogCategory.ANALYSIS_QUEUE, '[分析队列] 等待AI服务就绪超时')
    this.notifyFrontend('error', t('等待AI引擎启动超时'), false, 'waiting-for-ai', 5000)
    return false
  }
}
