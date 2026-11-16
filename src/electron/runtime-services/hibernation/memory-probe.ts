/**
 * 跨平台零开销物理内存探针 (MemoryProbe) 与自适应内存阈值算法
 * 遵循 L3 规格书: docs/specs/unified-module-hibernation-and-energy-transparency-spec.md §2.2 / §3.2
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import {
  IDLE_MULTIPLIER_BUCKETS,
  MACOS_FREEMEM_BIAS_MB,
  MAX_MEMORY_THRESHOLD_BYTES,
  MEMORY_HYSTERESIS_RATIO,
  MEMORY_THRESHOLD_BASE_DIVISOR,
  MIN_MEMORY_THRESHOLD_BYTES
} from './types'

/**
 * 核心统一动态内存门限裁决函数 (SSOT)
 * 算法：物理总内存比例 (1/16) × 用户闲置阶梯乘数 (1.0x / 1.5x / 2.0x) + 钳制与手动覆写
 */
export function computeHibernationMemoryThreshold(
  totalRamBytes: number,
  userIdleMs: number,
  manualFloorMb?: number
): number {
  // 若用户在设置中显式指定了固定非零阈值，以用户意图为准
  if (manualFloorMb && manualFloorMb > 0) {
    return manualFloorMb * 1024 * 1024
  }

  // 核心统一算法：1/16 物理内存比例基准线
  const baseThreshold = totalRamBytes / MEMORY_THRESHOLD_BASE_DIVISOR
  const bucket =
    IDLE_MULTIPLIER_BUCKETS.find(b => userIdleMs < b.maxMs) ??
    IDLE_MULTIPLIER_BUCKETS[IDLE_MULTIPLIER_BUCKETS.length - 1]
  const rawThreshold = baseThreshold * bucket.multiplier

  // 128 MB 下限保护 与 4 GB 上限钳制
  return Math.max(MIN_MEMORY_THRESHOLD_BYTES, Math.min(MAX_MEMORY_THRESHOLD_BYTES, rawThreshold))
}

/** 跨平台底层内存查询驱动接口 */
export interface IMemoryProbeDriver {
  getPlatform(): string
  getTotalMemoryBytes(): number
  getFreeMemoryBytes(): number
  readLinuxMemAvailableBytes?(): number | null
}

/** 默认生产环境内存驱动 */
export class DefaultMemoryProbeDriver implements IMemoryProbeDriver {
  getPlatform(): string {
    return process.platform
  }

  getTotalMemoryBytes(): number {
    return os.totalmem()
  }

  getFreeMemoryBytes(): number {
    return os.freemem()
  }

  readLinuxMemAvailableBytes(): number | null {
    if (process.platform !== 'linux') return null
    try {
      const content = fs.readFileSync('/proc/meminfo', 'utf8')
      const match = content.match(/^MemAvailable:\s+(\d+)\s+kB/m)
      if (match && match[1]) {
        return parseInt(match[1], 10) * 1024
      }
    } catch {
      // 容错回退
    }
    return null
  }
}

export interface MemoryProbeOptions {
  driver?: IMemoryProbeDriver
}

/** 跨平台零开销内存探针 */
export class MemoryProbe {
  private readonly driver: IMemoryProbeDriver

  constructor(options?: MemoryProbeOptions) {
    this.driver = options?.driver ?? new DefaultMemoryProbeDriver()
  }

  /** 获取系统物理总内存 */
  getTotalMemoryBytes(): number {
    return this.driver.getTotalMemoryBytes()
  }

  /**
   * 获取操作系统当前真实可用物理内存 (Available Memory)
   * - Windows: os.freemem() 直调 GlobalMemoryStatusEx 的 ullAvailPhys
   * - Linux: 优先读取 /proc/meminfo 的 MemAvailable，失败回退 os.freemem()
   * - macOS: os.freemem() + MACOS_FREEMEM_BIAS_MB (2GB) 补偿
   */
  getAvailableMemoryBytes(): number {
    const platform = this.driver.getPlatform()
    const total = this.driver.getTotalMemoryBytes()
    const rawFree = this.driver.getFreeMemoryBytes()

    if (platform === 'linux') {
      const memAvailable = this.driver.readLinuxMemAvailableBytes?.()
      if (memAvailable !== null && memAvailable !== undefined && memAvailable > 0) {
        return Math.min(total, memAvailable)
      }
      return rawFree
    }

    if (platform === 'darwin') {
      const biasBytes = MACOS_FREEMEM_BIAS_MB * 1024 * 1024
      return Math.min(total, rawFree + biasBytes)
    }

    // Windows 平台: os.freemem() 即 ullAvailPhys
    return rawFree
  }

  /**
   * 判定当前内存是否处于吃紧状态
   * 规则：availableBytes < computeHibernationMemoryThreshold(...)
   */
  isMemoryUnderPressure(userIdleMs: number, manualFloorMb?: number): boolean {
    const available = this.getAvailableMemoryBytes()
    const threshold = computeHibernationMemoryThreshold(
      this.getTotalMemoryBytes(),
      userIdleMs,
      manualFloorMb
    )
    return available < threshold
  }

  /**
   * 判定是否解除吃紧状态（8% 向上滞回带，防边界震荡）
   * 规则：availableBytes >= threshold * 1.08
   */
  shouldReleaseMemoryPressure(userIdleMs: number, manualFloorMb?: number): boolean {
    const available = this.getAvailableMemoryBytes()
    const threshold = computeHibernationMemoryThreshold(
      this.getTotalMemoryBytes(),
      userIdleMs,
      manualFloorMb
    )
    return available >= threshold * MEMORY_HYSTERESIS_RATIO
  }
}

/** 全局单例 */
export const memoryProbe = new MemoryProbe()
