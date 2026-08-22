import { app } from 'electron'
import { PostHog } from 'posthog-node'
import { LogCategory, logger } from '@firefly/shared'
import { SystemIdentityService } from '../runtime-services/system/system-identity-service'
import { userTierService } from '../runtime-services/user-tier/user-tier-service'
import fixPath from 'fix-path'
import * as os from 'os'

// 在 macOS 和 Linux 上修复 PATH 环境变量
if (process.platform !== 'win32') {
  try {
    const fixPathFunc = typeof fixPath === 'function' ? fixPath : (fixPath as any).default
    if (typeof fixPathFunc === 'function') {
      fixPathFunc()
    }
  } catch (e) {
    console.error('Failed to fix PATH in PostHogService:', e)
  }
}

/**
 * 主进程 PostHog 服务
 * 用于捕获后端错误、系统事件和性能指标
 *
 * 采用两阶段初始化策略，确保尽早捕获异常：
 * 1. 早期初始化（构造函数）：同步创建 PostHog 客户端，使用临时标识，立即具备异常捕获能力
 * 2. 完整初始化（init()）：异步更新为真实机器 ID，检查企业授权
 */
class PostHogService {
  private client: PostHog | null = null
  private distinctId: string
  private isEnterprise = false
  private initialized = false
  private initializing = false
  /** 在 earlyInit 客户端创建失败时，缓存事件待 init() 后刷新 */
  private earlyBuffer: Array<{
    type: 'event' | 'exception'
    event?: string
    error?: any
    properties?: Record<string, any>
  }> = []

  constructor() {
    // 使用 hostname + pid 作为临时标识，init() 后会更新为真实机器 ID
    this.distinctId = `${os.hostname()}_${process.pid}`
    // 尽早创建 PostHog 客户端，确保模块加载后即可捕获异常
    this.earlyInit()
  }

  /**
   * 同步早期初始化 - 在模块加载时立即创建 PostHog 客户端
   * 使用临时标识（hostname_pid），后续 init() 会更新为真实机器 ID
   */
  private earlyInit() {
    const key = process.env.VITE_POSTHOG_KEY || process.env.POSTHOG_KEY
    const host =
      process.env.VITE_POSTHOG_HOST || process.env.POSTHOG_HOST || 'https://app.posthog.com'
    const enablePostHog = process.env.ENABLE_POSTHOG === 'true'

    // 只有 app.isPackaged（已打包）或显式开启 ENABLE_POSTHOG 时才创建客户端
    if (!key || (!app.isPackaged && !enablePostHog)) {
      return
    }

    try {
      this.client = new PostHog(key, {
        host: host,
        flushAt: 1, // 早期阶段逐条发送，确保崩溃前事件不丢失
        flushInterval: 10000
      })
    } catch (e) {
      console.error('PostHog 早期初始化失败:', e)
    }
  }

  /**
   * 异步完整初始化 - 更新真实机器 ID 并检查遥测门控
   * 在 SystemIdentityService 初始化完成后调用
   */
  async init() {
    if (this.initializing) return
    this.initializing = true

    // 核心变更：通过 computed_limits.telemetry 门控禁用 PostHog
    try {
      const tierData = userTierService.getCachedData()
      if (tierData?.computed_limits?.telemetry === false) {
        this.isEnterprise = true
        logger.info(LogCategory.SYSTEM, 'PostHog: 检测到 telemetry 门控禁用，停止追踪')
        // 关闭早期创建的客户端并清理缓冲
        if (this.client) {
          await this.client.shutdown()
          this.client = null
        }
        this.earlyBuffer = []
        return
      }
    } catch (e) {
      logger.warn(LogCategory.SYSTEM, 'PostHog: tier 数据读取失败', e)
    }

    // 更新为真实的机器 ID
    try {
      this.distinctId = SystemIdentityService.getInstance().getMachineId()
    } catch (e) {
      logger.warn(LogCategory.SYSTEM, 'PostHog: 获取机器 ID 失败，继续使用临时标识')
    }

    // 如果早期初始化未创建客户端（构造函数中的 earlyInit 失败），在此重试
    if (!this.client) {
      const key = process.env.VITE_POSTHOG_KEY || process.env.POSTHOG_KEY
      const host =
        process.env.VITE_POSTHOG_HOST || process.env.POSTHOG_HOST || 'https://app.posthog.com'
      const enablePostHog = process.env.ENABLE_POSTHOG === 'true'

      if (!key || (!app.isPackaged && !enablePostHog)) {
        if (!key) {
          logger.warn(LogCategory.SYSTEM, 'PostHog API Key 未配置，主进程将不进行行为追踪')
        } else if (!app.isPackaged && !enablePostHog) {
          logger.info(
            LogCategory.SYSTEM,
            'PostHog 已配置但未开启（非打包环境默认关闭），使用 ENABLE_POSTHOG=true 开启'
          )
        }
        return
      }

      try {
        this.client = new PostHog(key, {
          host: host,
          flushAt: app.isPackaged ? 20 : 1, // 生产环境累积发送，开发环境立即发送
          flushInterval: 10000
        })
      } catch (error) {
        logger.error(LogCategory.SYSTEM, 'PostHog 主进程初始化失败:', error)
        return
      }
    }

    // 延迟设置 initialized 标志到客户端就绪之后，确保初始化完成前的事件正确进入缓冲
    this.initialized = true
    this.initializing = false

    logger.info(LogCategory.SYSTEM, `PostHog 主进程服务已初始化, ID: ${this.distinctId}`)

    // 刷新早期缓冲的事件（使用已更新的真实 distinctId）
    this.flushEarlyBuffer()
  }

  /**
   * 刷新早期缓冲事件
   */
  private flushEarlyBuffer() {
    if (this.earlyBuffer.length === 0) return

    logger.info(LogCategory.SYSTEM, `PostHog: 正在刷新 ${this.earlyBuffer.length} 个早期缓冲事件`)
    for (const item of this.earlyBuffer) {
      if (item.type === 'event' && item.event) {
        this.capture(item.event, item.properties)
      } else if (item.type === 'exception' && item.error) {
        this.captureException(item.error, item.properties)
      }
    }
    this.earlyBuffer = []
  }

  /**
   * 捕获事件
   */
  capture(event: string, properties?: Record<string, any>) {
    if (this.isEnterprise) return

    if (!this.client) {
      // 客户端未就绪（早期初始化失败），缓冲事件待 init() 后刷新
      if (!this.initialized) {
        this.earlyBuffer.push({ type: 'event', event, properties })
      }
      return
    }

    this.client.capture({
      distinctId: this.distinctId,
      event,
      properties: {
        运行环境: app.isPackaged ? '生产环境' : '开发环境',
        运行进程: '主进程',
        // 标记 init() 完成前的事件，方便在 PostHog 中区分
        ...(this.initialized ? {} : { _early_capture: true }),
        ...properties
      }
    })
  }

  /**
   * 捕获异常
   */
  captureException(error: any, properties?: Record<string, any>) {
    if (this.isEnterprise) return

    if (!this.client) {
      // 客户端未就绪（早期初始化失败），缓冲异常待 init() 后刷新
      if (!this.initialized) {
        this.earlyBuffer.push({ type: 'exception', error, properties })
      }
      return
    }

    // posthog-node 支持 captureException
    this.client.captureException(error, this.distinctId, {
      运行环境: app.isPackaged ? '生产环境' : '开发环境',
      运行进程: '主进程',
      // 标记 init() 完成前的事件，方便在 PostHog 中区分
      ...(this.initialized ? {} : { _early_capture: true }),
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

// 导出单例 - 构造函数中即创建 PostHog 客户端，模块加载后立即可用
export const postHogMain = new PostHogService()
