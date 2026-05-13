import { PostHog } from 'posthog-node'
import { LogCategory, logger } from '@yonuc/shared'
import { SystemIdentityService } from '../runtime-services/system/system-identity-service'
import { LicenseService } from '../runtime-services/system/license-service'
import fixPath from 'fix-path'

// 在 macOS 和 Linux 上修复 PATH 环境变量
if (process.platform !== 'win32') {
  try {
    const fixPathFunc = typeof fixPath === 'function' ? fixPath : (fixPath as any).default;
    if (typeof fixPathFunc === 'function') {
      fixPathFunc();
    }
  } catch (e) {
    console.error('Failed to fix PATH in PostHogService:', e);
  }
}

/**
 * 主进程 PostHog 服务
 * 用于捕获后端错误、系统事件和性能指标
 */
class PostHogService {
  private client: PostHog | null = null
  private distinctId: string = 'unknown_main_process'
  private isProd: boolean = process.env.NODE_ENV === 'production'
  private isEnterprise: boolean = false
  private initialized: boolean = false

  constructor() {
    // 延迟初始化，等待 LicenseService 准备好
  }

  /**
   * 异步初始化
   */
  async init() {
    if (this.initialized) return
    this.initialized = true

    // 核心变更：如果是企业授权，立即禁用 PostHog
    try {
      const status = await LicenseService.getInstance().checkLicenseStatus()
      if (status.type === 'ENTERPRISE_OFFLINE') {
        this.isEnterprise = true
        logger.info(LogCategory.SYSTEM, 'PostHog: 检测到企业授权，禁用追踪')
        return
      }
    } catch (e) {
      logger.warn(LogCategory.SYSTEM, 'PostHog: 授权检查失败', e)
    }

    const key = process.env.VITE_POSTHOG_KEY || process.env.POSTHOG_KEY
    const host = process.env.VITE_POSTHOG_HOST || process.env.POSTHOG_HOST || 'https://app.posthog.com'
    const enablePostHog = process.env.ENABLE_POSTHOG === 'true'

    // 如果没有 Key，或者在开发环境下未显式开启，则跳过
    if (!key || (!this.isProd && !enablePostHog)) {
      if (!key) {
        logger.warn(LogCategory.SYSTEM, 'PostHog API Key 未配置，主进程将不进行行为追踪')
      } else if (!this.isProd && !enablePostHog) {
        logger.info(LogCategory.SYSTEM, 'PostHog 已配置但未开启（开发环境默认关闭），使用 start:debug-posthog 开启')
      }
      return
    }

    try {
      this.distinctId = SystemIdentityService.getInstance().getMachineId()
      this.client = new PostHog(key, {
        host: host,
        flushAt: this.isProd ? 20 : 1, // 生产环境累积发送，开发环境立即发送
        flushInterval: 10000,
      })

      logger.info(LogCategory.SYSTEM, `PostHog 主进程服务已初始化, ID: ${this.distinctId}`)
    } catch (error) {
      logger.error(LogCategory.SYSTEM, 'PostHog 主进程初始化失败:', error)
    }
  }

  /**
   * 捕获事件
   */
  capture(event: string, properties?: Record<string, any>) {
    if (!this.client || this.isEnterprise) return

    this.client.capture({
      distinctId: this.distinctId,
      event,
      properties: {
        '运行环境': this.isProd ? '生产环境' : '开发环境',
        '运行进程': '主进程',
        ...properties
      }
    })
  }

  /**
   * 捕获异常
   */
  captureException(error: any, properties?: Record<string, any>) {
    if (!this.client || this.isEnterprise) return

    // posthog-node 支持 captureException
    this.client.captureException(error, this.distinctId, {
      '运行环境': this.isProd ? '生产环境' : '开发环境',
      '运行进程': '主进程',
      ...properties
    })
  }

  /**
   * 确保所有挂起的事件已发送（应用退出时调用）
   */
  async shutdown() {
    if (this.client) {
      await this.client.shutdown()
    }
  }
}

// 导出单例
export const postHogMain = new PostHogService()
