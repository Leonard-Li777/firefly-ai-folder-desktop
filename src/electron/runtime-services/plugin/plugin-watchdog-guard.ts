/**
 * 宿主独立时间/内存双看门狗与休眠补偿模块 (PluginWatchdogGuard)
 *
 * 遵循 L3 深度技术规格书：plugin-runtime-sandbox-and-omni-seams-spec.md §4.1 与 §4.2
 * 彻底废除对插件心跳的生死依赖，由宿主完全掌控绝对时间、内存阈值与休眠唤醒补偿
 */

import * as os from 'os'
import {
  MAX_PLUGIN_FILE_SIZE_BYTES,
  NORMAL_MEMORY_RECYCLE_THRESHOLD_BYTES,
  EMERGENCY_MEMORY_KILL_THRESHOLD_BYTES,
  PluginManifest,
  FileTooLargeError,
  MemoryLimitExceededError,
  WatchdogReason
} from './plugin-types'
import { PluginHost } from './plugin-host'

export interface IWatchdogPowerMonitor {
  on(event: 'resume', listener: () => void): this
  removeListener(event: 'resume', listener: () => void): this
}

export type ProcessMetricsProvider = (
  pid: number
) => Promise<{ workingSetBytes: number } | null> | { workingSetBytes: number } | null

export interface PluginWatchdogGuardOptions {
  sampleIntervalMs?: number
  metricsProvider?: ProcessMetricsProvider
  powerMonitor?: IWatchdogPowerMonitor
  normalRecycleThresholdBytes?: number
  emergencyKillThresholdBytes?: number
  logger?: {
    info(msg: string, ...args: any[]): void
    warn(msg: string, ...args: any[]): void
    error(msg: string, ...args: any[]): void
  }
}

/**
 * 动态超时公式计算
 * TimeoutSec = Clamp(15 + FileSizeBytes / (1024 * 1024) * 0.5, 15, 180)
 * 若为重试任务 (isRetry)，超时预算自动放宽至 1.5 倍
 */
export function calculateTaskTimeoutSec(
  fileSizeBytes: number,
  profile?: PluginManifest['timeoutProfile'],
  isRetry = false
): number {
  const baseSec = profile?.baseSec ?? 15
  const perMbSec = profile?.perMbSec ?? 0.5
  const maxSec = profile?.maxSec ?? 180

  const mb = fileSizeBytes / (1024 * 1024)
  const calculated = baseSec + mb * perMbSec
  const clamped = Math.min(Math.max(calculated, baseSec), maxSec)
  return isRetry ? clamped * 1.5 : clamped
}

/**
 * 判断单文件体积是否超限 (>1GB 直接跳过深度解析，回退 Omni 基线)
 */
export function isFileSizeTooLarge(
  fileSizeBytes: number,
  limitBytes = MAX_PLUGIN_FILE_SIZE_BYTES
): boolean {
  return fileSizeBytes > limitBytes
}

/**
 * 看门狗与内存守护者核心管理类
 */
export class PluginWatchdogGuard {
  private static instance: PluginWatchdogGuard | null = null

  private readonly registeredHosts = new Set<PluginHost>()
  private sampleTimer: any = null
  private readonly sampleIntervalMs: number
  private metricsProvider?: ProcessMetricsProvider
  private powerMonitor?: IWatchdogPowerMonitor
  private readonly normalRecycleThresholdBytes: number
  private readonly emergencyKillThresholdBytes: number
  private readonly logger: NonNullable<PluginWatchdogGuardOptions['logger']>
  private onResumeListener: (() => void) | null = null

  constructor(options?: PluginWatchdogGuardOptions) {
    this.sampleIntervalMs = options?.sampleIntervalMs ?? 2000
    this.metricsProvider = options?.metricsProvider
    this.normalRecycleThresholdBytes =
      options?.normalRecycleThresholdBytes ?? NORMAL_MEMORY_RECYCLE_THRESHOLD_BYTES

    // 紧急硬杀阈值：min(4GB, 物理内存 * 25%)
    let defaultEmergencyLimit = EMERGENCY_MEMORY_KILL_THRESHOLD_BYTES
    try {
      const totalMem = typeof os.totalmem === 'function' ? os.totalmem() : 16 * 1024 * 1024 * 1024
      defaultEmergencyLimit = Math.min(
        EMERGENCY_MEMORY_KILL_THRESHOLD_BYTES,
        Math.floor(totalMem * 0.25)
      )
    } catch (_) {}

    this.emergencyKillThresholdBytes = options?.emergencyKillThresholdBytes ?? defaultEmergencyLimit

    this.logger = options?.logger ?? {
      info: (msg, ...args) => console.log(msg, ...args),
      warn: (msg, ...args) => console.warn(msg, ...args),
      error: (msg, ...args) => console.error(msg, ...args)
    }

    if (options?.powerMonitor) {
      this.bindPowerMonitor(options.powerMonitor)
    } else {
      // 尝试在 Electron 运行时安全绑定
      try {
        const { powerMonitor } = require('electron')
        if (powerMonitor) {
          this.bindPowerMonitor(powerMonitor)
        }
      } catch (_) {}
    }
  }

  public static getInstance(): PluginWatchdogGuard {
    if (!PluginWatchdogGuard.instance) {
      PluginWatchdogGuard.instance = new PluginWatchdogGuard()
    }
    return PluginWatchdogGuard.instance
  }

  /**
   * 绑定休眠唤醒事件源
   */
  public bindPowerMonitor(powerMonitor: IWatchdogPowerMonitor): void {
    if (this.powerMonitor && this.onResumeListener) {
      this.powerMonitor.removeListener('resume', this.onResumeListener)
    }
    this.powerMonitor = powerMonitor
    this.onResumeListener = () => this.handleSystemResume()
    this.powerMonitor.on('resume', this.onResumeListener)
  }

  /**
   * 注入自定义进程内存采样提供者（测试或非 Electron 环境）
   */
  public setMetricsProvider(provider: ProcessMetricsProvider | undefined): void {
    this.metricsProvider = provider
  }

  /**
   * 注册宿主实例到看门狗守卫
   */
  public registerHost(host: PluginHost): void {
    this.registeredHosts.add(host)
    this.ensureMonitoring()
  }

  /**
   * 从看门狗守卫注销宿主实例
   */
  public unregisterHost(host: PluginHost): void {
    this.registeredHosts.delete(host)
    if (this.registeredHosts.size === 0) {
      this.stopMonitoring()
    }
  }

  /**
   * 启动后台内存监控定时器 (每 2 秒采样一次)
   */
  public ensureMonitoring(): void {
    if (this.sampleTimer || this.registeredHosts.size === 0) {
      return
    }

    this.sampleTimer = setInterval(async () => {
      try {
        await this.sampleAndCheck()
      } catch (err) {
        this.logger.warn('[PluginWatchdogGuard] Memory sampling check error:', err)
      }
    }, this.sampleIntervalMs)
  }

  /**
   * 停止监控定时器
   */
  public stopMonitoring(): void {
    if (this.sampleTimer) {
      clearInterval(this.sampleTimer)
      this.sampleTimer = null
    }
  }

  /**
   * 触发单次采样检测（暴露此方法以便测试直接触发）
   */
  public async sampleAndCheck(): Promise<void> {
    for (const host of this.registeredHosts) {
      const pid = host.pid
      if (!pid || host.state === 'STOPPED' || host.state === 'TERMINATING') {
        continue
      }

      const metrics = await this.getProcessMetrics(pid)
      if (!metrics) continue

      const wsBytes = metrics.workingSetBytes

      // 1. 紧急硬杀阈值判定 (AC 3)
      if (wsBytes >= this.emergencyKillThresholdBytes) {
        this.logger.error(
          `[PluginWatchdogGuard] Emergency memory limit exceeded for plugin ${host.manifest.id} (PID: ${pid}): ${wsBytes}B >= ${this.emergencyKillThresholdBytes}B. Terminating by mem_guard!`
        )
        host.terminateForMemoryGuard(wsBytes, this.emergencyKillThresholdBytes)
        continue
      }

      // 2. 正常平滑回收阈值判定 (2GB)
      if (wsBytes >= this.normalRecycleThresholdBytes) {
        this.logger.warn(
          `[PluginWatchdogGuard] Normal memory recycle threshold reached for plugin ${host.manifest.id} (PID: ${pid}): ${wsBytes}B >= ${this.normalRecycleThresholdBytes}B. Triggering retiring.`
        )
        host.markRetiringDueToMemory(wsBytes)
      }
    }
  }

  /**
   * 处理系统休眠唤醒事件 (AC 2)
   * 为所有活跃在途任务自动顺延/重置 deadline 计时，防集中误杀
   */
  public handleSystemResume(bonusCompensationMs = 15000): void {
    this.logger.info(
      `[PluginWatchdogGuard] System resumed from sleep, compensating in-flight tasks (+${bonusCompensationMs}ms)...`
    )
    for (const host of this.registeredHosts) {
      if (host.state === 'BUSY') {
        host.compensateSystemResume(bonusCompensationMs)
      }
    }
  }

  /**
   * 查询指定 PID 的内存 WorkingSet 字节数
   */
  private async getProcessMetrics(pid: number): Promise<{ workingSetBytes: number } | null> {
    if (this.metricsProvider) {
      return await this.metricsProvider(pid)
    }

    try {
      const { app } = require('electron')
      if (app && typeof app.getAppMetrics === 'function') {
        const allMetrics = app.getAppMetrics()
        const target = allMetrics.find((m: any) => m.pid === pid)
        if (target && target.memory && typeof target.memory.workingSetSize === 'number') {
          // Electron app.getAppMetrics 返回的 workingSetSize 单位通常为 KB
          return { workingSetBytes: target.memory.workingSetSize * 1024 }
        }
      }
    } catch (_) {}

    return null
  }

  /**
   * 清理并销毁看门狗单例
   */
  public dispose(): void {
    this.stopMonitoring()
    if (this.powerMonitor && this.onResumeListener) {
      this.powerMonitor.removeListener('resume', this.onResumeListener)
      this.onResumeListener = null
    }
    this.registeredHosts.clear()
  }

  public static resetInstance(): void {
    if (PluginWatchdogGuard.instance) {
      PluginWatchdogGuard.instance.dispose()
      PluginWatchdogGuard.instance = null
    }
  }
}

export const pluginWatchdogGuard = PluginWatchdogGuard.getInstance()
