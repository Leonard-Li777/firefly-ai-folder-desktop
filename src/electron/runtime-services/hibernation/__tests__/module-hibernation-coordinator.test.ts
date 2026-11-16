import { beforeEach, describe, expect, it } from 'vitest'
import { LeaseRegistry } from '../lease-registry'
import { computeHibernationMemoryThreshold, IMemoryProbeDriver, MemoryProbe } from '../memory-probe'
import { ModuleHibernationCoordinator } from '../module-hibernation-coordinator'
import { ModuleRuntimeStore } from '../module-runtime-store'
import { MAX_MEMORY_THRESHOLD_BYTES, MIN_MEMORY_THRESHOLD_BYTES } from '../types'

class MockMemoryProbeDriver implements IMemoryProbeDriver {
  platform = 'win32'
  totalMem = 16 * 1024 * 1024 * 1024 // 16 GB
  freeMem = 4 * 1024 * 1024 * 1024 // 4 GB
  linuxMemAvailable: number | null = null

  getPlatform(): string {
    return this.platform
  }
  getTotalMemoryBytes(): number {
    return this.totalMem
  }
  getFreeMemoryBytes(): number {
    return this.freeMem
  }
  readLinuxMemAvailableBytes(): number | null {
    return this.linuxMemAvailable
  }
}

describe('ModuleHibernationCoordinator & MemoryProbe (Ticket 04)', () => {
  describe('动态内存自适应阈值算法 (computeHibernationMemoryThreshold)', () => {
    it('4GB 内存机器：256MB 基准线与闲置阶梯', () => {
      const ram4G = 4 * 1024 * 1024 * 1024

      // < 2 min: 1.0x 乘数 -> 256 MB
      expect(computeHibernationMemoryThreshold(ram4G, 30_000)).toBe(256 * 1024 * 1024)

      // 2 ~ 10 min: 1.5x 乘数 -> 384 MB
      expect(computeHibernationMemoryThreshold(ram4G, 5 * 60_000)).toBe(384 * 1024 * 1024)

      // > 10 min: 2.0x 乘数 -> 512 MB
      expect(computeHibernationMemoryThreshold(ram4G, 15 * 60_000)).toBe(512 * 1024 * 1024)
    })

    it('8GB 内存机器：512MB 基准线与闲置阶梯', () => {
      const ram8G = 8 * 1024 * 1024 * 1024
      expect(computeHibernationMemoryThreshold(ram8G, 10_000)).toBe(512 * 1024 * 1024)
      expect(computeHibernationMemoryThreshold(ram8G, 3 * 60_000)).toBe(768 * 1024 * 1024)
      expect(computeHibernationMemoryThreshold(ram8G, 20 * 60_000)).toBe(1024 * 1024 * 1024)
    })

    it('16GB 内存机器：1024MB 基准线与闲置阶梯', () => {
      const ram16G = 16 * 1024 * 1024 * 1024
      expect(computeHibernationMemoryThreshold(ram16G, 0)).toBe(1024 * 1024 * 1024)
      expect(computeHibernationMemoryThreshold(ram16G, 4 * 60_000)).toBe(1536 * 1024 * 1024)
      expect(computeHibernationMemoryThreshold(ram16G, 12 * 60_000)).toBe(2048 * 1024 * 1024)
    })

    it('32GB 内存机器：闲置触发 4GB 上限钳制', () => {
      const ram32G = 32 * 1024 * 1024 * 1024
      expect(computeHibernationMemoryThreshold(ram32G, 0)).toBe(2048 * 1024 * 1024)
      expect(computeHibernationMemoryThreshold(ram32G, 5 * 60_000)).toBe(3072 * 1024 * 1024)
      // 32GB * 2.0 / 16 = 4096 MB，恰好达到 4GB 上限
      expect(computeHibernationMemoryThreshold(ram32G, 15 * 60_000)).toBe(4096 * 1024 * 1024)
    })

    it('64GB+ 内存机器：受 4GB 绝对上限钳制', () => {
      const ram64G = 64 * 1024 * 1024 * 1024
      // 64GB / 16 = 4GB，受上限保护
      expect(computeHibernationMemoryThreshold(ram64G, 0)).toBe(MAX_MEMORY_THRESHOLD_BYTES)
      expect(computeHibernationMemoryThreshold(ram64G, 30 * 60_000)).toBe(
        MAX_MEMORY_THRESHOLD_BYTES
      )
    })

    it('<=2GB 紧凑环境：受 128MB 绝对下限保护', () => {
      const ram1G = 1 * 1024 * 1024 * 1024
      // 1GB / 16 = 64MB < 128MB，钳制为 128MB
      expect(computeHibernationMemoryThreshold(ram1G, 0)).toBe(MIN_MEMORY_THRESHOLD_BYTES)
    })

    it('手动指定 manualFloorMb 时以用户意图为准', () => {
      const ram16G = 16 * 1024 * 1024 * 1024
      expect(computeHibernationMemoryThreshold(ram16G, 0, 800)).toBe(800 * 1024 * 1024)
    })
  })

  describe('跨平台内存探针 (MemoryProbe)', () => {
    let mockDriver: MockMemoryProbeDriver
    let probe: MemoryProbe

    beforeEach(() => {
      mockDriver = new MockMemoryProbeDriver()
      probe = new MemoryProbe({ driver: mockDriver })
    })

    it('Windows 平台直采 freeMem', () => {
      mockDriver.platform = 'win32'
      mockDriver.freeMem = 3 * 1024 * 1024 * 1024
      expect(probe.getAvailableMemoryBytes()).toBe(3 * 1024 * 1024 * 1024)
    })

    it('Linux 平台优先读取 readLinuxMemAvailableBytes', () => {
      mockDriver.platform = 'linux'
      mockDriver.freeMem = 1 * 1024 * 1024 * 1024
      mockDriver.linuxMemAvailable = 2.5 * 1024 * 1024 * 1024
      expect(probe.getAvailableMemoryBytes()).toBe(2.5 * 1024 * 1024 * 1024)
    })

    it('macOS 平台加算 2048MB 补偿', () => {
      mockDriver.platform = 'darwin'
      mockDriver.freeMem = 1 * 1024 * 1024 * 1024
      // 1GB + 2GB bias = 3GB
      expect(probe.getAvailableMemoryBytes()).toBe(3 * 1024 * 1024 * 1024)
    })

    it('内存吃紧与 8% 滞回带判定', () => {
      mockDriver.platform = 'win32'
      mockDriver.totalMem = 16 * 1024 * 1024 * 1024 // 16GB
      // 阈值 (闲置 0min) = 1GB (1024 MB)
      // 滞回门限 = 1024 * 1.08 = 1105.92 MB

      // 可用 900 MB < 1024 MB -> 吃紧
      mockDriver.freeMem = 900 * 1024 * 1024
      expect(probe.isMemoryUnderPressure(0)).toBe(true)
      expect(probe.shouldReleaseMemoryPressure(0)).toBe(false)

      // 可用 1050 MB：虽然 >= 1024 MB，但处于 (1024, 1105.92) 滞回抗抖带内，不应解除吃紧
      mockDriver.freeMem = 1050 * 1024 * 1024
      expect(probe.isMemoryUnderPressure(0)).toBe(false)
      expect(probe.shouldReleaseMemoryPressure(0)).toBe(false)

      // 可用 1200 MB >= 1105.92 MB -> 解除吃紧
      mockDriver.freeMem = 1200 * 1024 * 1024
      expect(probe.isMemoryUnderPressure(0)).toBe(false)
      expect(probe.shouldReleaseMemoryPressure(0)).toBe(true)
    })
  })

  describe('协调器状态机与 Token 申领事务 (ModuleHibernationCoordinator)', () => {
    let coordinator: ModuleHibernationCoordinator
    let store: ModuleRuntimeStore
    let leaseRegistry: LeaseRegistry

    beforeEach(() => {
      store = new ModuleRuntimeStore()
      leaseRegistry = new LeaseRegistry()
      coordinator = new ModuleHibernationCoordinator({
        runtimeStore: store,
        leaseRegistry
      })
    })

    it('idle_hibernation 前置守卫严格核验租约数与 resident 状态', () => {
      // 1. 设置模块状态为 resident，租约为 0 时允许申领
      store.update('pocket-cpu-int8-onnx', d => {
        d.state = 'resident'
      })
      const token = coordinator.beginLifecycleOperation('pocket-cpu-int8-onnx', 'idle_hibernation')
      expect(token).toBeDefined()
      expect(token?.operation).toBe('idle_hibernation')
      coordinator.endLifecycleOperation(token)

      // 2. 持有活跃租约时坚决拒绝
      const handle = leaseRegistry.acquireLease({
        targetId: 'pocket-cpu-int8-onnx'
      })
      const rejectedToken = coordinator.beginLifecycleOperation(
        'pocket-cpu-int8-onnx',
        'idle_hibernation'
      )
      expect(rejectedToken).toBeUndefined()
      handle.release()

      // 3. 处于 hibernated 状态时拒绝空闲休眠
      store.update('pocket-cpu-int8-onnx', d => {
        d.state = 'hibernated'
      })
      const rejectedToken2 = coordinator.beginLifecycleOperation(
        'pocket-cpu-int8-onnx',
        'idle_hibernation'
      )
      expect(rejectedToken2).toBeUndefined()
    })

    it('unload_retry 前置守卫仅允许 error + unload 状态', () => {
      // 非 error 态拒绝
      expect(
        coordinator.beginLifecycleOperation('firefly-ai-engine', 'unload_retry')
      ).toBeUndefined()

      // error 态但 lastFailureKind 是 load 拒绝
      store.update('firefly-ai-engine', d => {
        d.state = 'error'
        d.lastFailureKind = 'load'
      })
      expect(
        coordinator.beginLifecycleOperation('firefly-ai-engine', 'unload_retry')
      ).toBeUndefined()

      // error + unload 成功申领
      store.update('firefly-ai-engine', d => {
        d.lastFailureKind = 'unload'
      })
      const token = coordinator.beginLifecycleOperation('firefly-ai-engine', 'unload_retry')
      expect(token).toBeDefined()
      expect(token?.operation).toBe('unload_retry')
      coordinator.endLifecycleOperation(token)
    })

    it('crash_recovery 允许 error(load) 无内存残留时成功申领 Token (TC-14-HO)', () => {
      store.update('firefly-ai-engine', d => {
        d.state = 'error'
        d.lastFailureKind = 'load'
        d.residentBytes = 0
        d.residentSample = undefined
      })

      const token = coordinator.beginLifecycleOperation('firefly-ai-engine', 'crash_recovery')
      expect(token).toBeDefined()
      expect(token?.operation).toBe('crash_recovery')
      coordinator.endLifecycleOperation(token)
    })

    it('model_swap 拥有最高优先级，原子抢占低优先级操作并使旧 Token 失效', () => {
      store.update('pocket-cpu-int8-onnx', d => {
        d.state = 'resident'
      })
      // 1. 低优先级申领 idle_hibernation
      const idleToken = coordinator.beginLifecycleOperation(
        'pocket-cpu-int8-onnx',
        'idle_hibernation'
      )!
      expect(idleToken).toBeDefined()
      expect(coordinator.currentEpoch('pocket-cpu-int8-onnx')).toBe(idleToken.epoch)

      // 2. 发起 model_swap 顶层事务
      const swapToken = coordinator.beginLifecycleOperation('pocket-cpu-int8-onnx', 'model_swap')!
      expect(swapToken).toBeDefined()
      expect(swapToken.operation).toBe('model_swap')
      // Epoch 原子递增
      expect(swapToken.epoch).toBeGreaterThan(idleToken.epoch)

      // 3. 旧 idleToken 尝试提交，必须被拒绝！
      const committed = coordinator.commitRuntimeSnapshot(idleToken, d => {
        d.state = 'hibernated'
      })
      expect(committed).toBe(false)

      // 4. 新 swapToken 提交成功
      const swapCommitted = coordinator.commitRuntimeSnapshot(swapToken, d => {
        d.state = 'loading'
      })
      expect(swapCommitted).toBe(true)

      coordinator.endLifecycleOperation(swapToken)
    })

    it('handoverLifecycleOwner 原子交接 Token 并推进代际', () => {
      const parentToken = coordinator.beginLifecycleOperation('firefly-ai-engine', 'model_swap')!
      expect(parentToken).toBeDefined()

      // 交接为 single_flight_load
      const childToken = coordinator.handoverLifecycleOwner(parentToken, 'single_flight_load')!
      expect(childToken).toBeDefined()
      expect(childToken.operation).toBe('single_flight_load')
      expect(childToken.epoch).toBeGreaterThan(parentToken.epoch)

      // 原 parentToken 提交被拒
      expect(
        coordinator.commitRuntimeSnapshot(parentToken, d => {
          d.state = 'resident'
        })
      ).toBe(false)

      // childToken 提交成功
      expect(
        coordinator.commitRuntimeSnapshot(childToken, d => {
          d.state = 'resident'
        })
      ).toBe(true)

      coordinator.endLifecycleOperation(childToken)
    })

    it('crash_recovery 抢占低优先级操作时 epoch 恰好单调递增 1 (无双重跳号)', () => {
      store.update('pocket-cpu-int8-onnx', d => {
        d.state = 'resident'
      })
      const idleToken = coordinator.beginLifecycleOperation(
        'pocket-cpu-int8-onnx',
        'idle_hibernation'
      )!
      expect(idleToken).toBeDefined()
      const initialEpoch = idleToken.epoch

      // 发生意外崩溃，触发 crash_recovery 抢占
      const crashToken = coordinator.beginLifecycleOperation(
        'pocket-cpu-int8-onnx',
        'crash_recovery'
      )!
      expect(crashToken).toBeDefined()
      // 断言代际恰好递增 1，杜绝冗余重复递增
      expect(crashToken.epoch).toBe(initialEpoch + 1)
      expect(coordinator.currentEpoch('pocket-cpu-int8-onnx')).toBe(initialEpoch + 1)

      // 旧 Token 提交被拒
      expect(
        coordinator.commitRuntimeSnapshot(idleToken, d => {
          d.state = 'hibernated'
        })
      ).toBe(false)

      coordinator.endLifecycleOperation(crashToken)
    })

    it('并发 crash_recovery 被拒时绝不提前递增 epoch 毒化在途合法协程', () => {
      store.update('firefly-ai-engine', d => {
        d.state = 'resident'
      })
      // 1. 合法协程 1 成功申领 crash_recovery
      const legitToken = coordinator.beginLifecycleOperation('firefly-ai-engine', 'crash_recovery')!
      expect(legitToken).toBeDefined()
      const legitEpoch = legitToken.epoch

      // 2. 看门狗并发触发第二个 crash_recovery 协程 2
      const duplicateToken = coordinator.beginLifecycleOperation(
        'firefly-ai-engine',
        'crash_recovery'
      )
      // 协程 2 必须被正常拒绝
      expect(duplicateToken).toBeUndefined()

      // 3. 核心断言：全局 Epoch 绝不能被已拒绝的协程 2 毒化递增！
      expect(coordinator.currentEpoch('firefly-ai-engine')).toBe(legitEpoch)

      // 4. 合法协程 1 能够顺利提交快照变更
      const committed = coordinator.commitRuntimeSnapshot(legitToken, d => {
        d.crashStreak = 1
      })
      expect(committed).toBe(true)
      expect(store.get('firefly-ai-engine').crashStreak).toBe(1)

      coordinator.endLifecycleOperation(legitToken)
    })
  })
})
