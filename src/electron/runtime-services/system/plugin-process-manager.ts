/**
 * 内存态插件进程中枢管理器 (PluginProcessManager)
 *
 * 遵循规格：plugin-lifecycle-developer-mode-and-archive-parser-spec.md §4 (ALT-PARADIGM)
 * 1. 运行时态与持久化态彻底解耦：DB 仅记录用户意图 (install_state)，内存态全权管理真实进程 PID 与运行态；
 * 2. 纯函数决策联动：所有启停与门禁严格经过 deriveRunDecision；
 * 3. 升维单选替换模型：独占能力槽切换平滑停止同槽前任，天然契合 ux_exclusive_active_slot 唯一约束；
 * 4. isUsable 分层判定：utility_process 查子进程存活，omni_onnx 与 builtin 模块按 active 意图与无挂起放行，彻底消除假死；
 * 5. 跨平台安全终结管线：四段式优雅退役 -> 3000ms 超时进程树强杀 -> 200ms 句柄避让。
 */

import { execSync } from 'child_process'
import { app } from 'electron'
import { deriveRunDecision, type HoldReason } from './plugin-run-decision'
import {
  getModularResourceDao,
  type BuiltinModuleRecord,
  type PluginCapabilitySlot
} from '../database/dao/modular-resource-dao'
import { pluginHostManager, type PluginHostManager } from '../plugin/plugin-host-manager'
import { logger, LogCategory } from '@firefly/shared'

export interface RunningPluginState {
  running: boolean
  pid?: number
  holdReasons: Set<HoldReason>
  lastError?: string
}

export type ActivationSource = 'user_toggle' | 'slot_release' | 'dev_mode_on' | 'startup_reconcile'

export interface PluginProcessManagerOptions {
  dao?: ReturnType<typeof getModularResourceDao>
  getDao?: () => ReturnType<typeof getModularResourceDao>
  hostManager?: PluginHostManager
  isPackaged?: boolean
}

export class PluginProcessManager {
  private readonly runningStates = new Map<string, RunningPluginState>()
  private customDao?: ReturnType<typeof getModularResourceDao>
  private customDaoGetter?: () => ReturnType<typeof getModularResourceDao>
  private readonly hostManager: PluginHostManager
  private readonly isPackaged: boolean

  constructor(options?: PluginProcessManagerOptions) {
    this.customDao = options?.dao
    this.customDaoGetter = options?.getDao
    this.hostManager = options?.hostManager ?? pluginHostManager
    this.isPackaged =
      options?.isPackaged ?? (typeof app !== 'undefined' && app.isPackaged ? app.isPackaged : false)
  }

  private getDao(): ReturnType<typeof getModularResourceDao> {
    if (this.customDao) return this.customDao
    if (this.customDaoGetter) {
      try {
        const d = this.customDaoGetter()
        if (d) return d
      } catch {}
    }
    return getModularResourceDao()
  }

  /**
   * 业务侧判定是否物理可用 (按 backend_type 分层判定，根除非进程类模块假死)
   */
  public isUsable(moduleId: string): boolean {
    const dao = this.getDao()
    if (!dao?.modules) return false
    const record = dao.modules.findByIdSync(moduleId)
    if (!record || record.install_state !== 'active') {
      return false
    }

    const s = this.runningStates.get(moduleId)
    const holdCount = s?.holdReasons.size ?? 0
    if (holdCount > 0) {
      return false
    }

    const backend = record.backend_type ?? 'utility_process'
    if (backend === 'utility_process') {
      // 外部子进程类插件：必须底层子进程真实存活
      return !!s?.running
    }

    // omni_onnx (Omni 内存管理) 与 builtin (Node 内置服务)：只要 active 且无挂起即物理可用
    return true
  }

  /**
   * 获取底层真实运行布尔值
   */
  public isRunning(moduleId: string): boolean {
    const record = this.getDao().modules.findByIdSync(moduleId)
    const backend = record?.backend_type ?? 'utility_process'
    if (backend !== 'utility_process') {
      return record?.install_state === 'active'
    }
    const s = this.runningStates.get(moduleId)
    return !!s?.running
  }

  /**
   * 获取当前模块所有挂起原因列表
   */
  public getHoldReasons(moduleId: string): HoldReason[] {
    const s = this.runningStates.get(moduleId)
    return s ? Array.from(s.holdReasons) : []
  }

  /**
   * 记录或更新模块挂起原因
   */
  public setHoldReasons(moduleId: string, reasons: HoldReason[]): void {
    let s = this.runningStates.get(moduleId)
    if (!s) {
      s = { running: false, holdReasons: new Set() }
      this.runningStates.set(moduleId, s)
    }
    s.holdReasons = new Set(reasons)
  }

  /**
   * 测试辅助：手动注入运行态
   */
  public setRunningForTest(moduleId: string, state: { running: boolean; pid?: number }): void {
    let s = this.runningStates.get(moduleId)
    if (!s) {
      s = { running: state.running, pid: state.pid, holdReasons: new Set() }
      this.runningStates.set(moduleId, s)
    } else {
      s.running = state.running
      s.pid = state.pid
    }
  }

  /**
   * 槽位占用权威检查
   */
  public async checkSlotPreempted(moduleId: string, slot?: string | null): Promise<boolean> {
    if (!slot || slot === 'general' || slot === 'tool' || slot === 'parser') {
      return false
    }
    const currentActive = this.getDao().modules.findActiveBySlotSync(slot as PluginCapabilitySlot)
    return !!(currentActive && currentActive.id !== moduleId && this.isRunning(currentActive.id))
  }

  /**
   * 槽位平滑单选替换：新模块拉起前确保槽位前任已退出 (Intent-Driven Slot Switchover)
   */
  public async handleSlotSwitchover(slot: string, incomingModuleId: string): Promise<void> {
    const currentActive = this.getDao().modules.findActiveBySlotSync(slot as PluginCapabilitySlot)
    if (currentActive && currentActive.id !== incomingModuleId) {
      logger.info(
        LogCategory.SYSTEM,
        `[Switchover] 独占槽位 ${slot} 前任 ${currentActive.id} 将被平滑停止并由 ${incomingModuleId} 替换`
      )
      // 原子置为 installed_inactive
      this.getDao().modules.updateInstallStateSync(currentActive.id, 'installed_inactive')
      // 停止前任进程
      await this.stopProcess(currentActive.id)
    }
  }

  /**
   * 全系统唯一拉起调度中枢
   */
  public async requestActivate(
    moduleId: string,
    source: ActivationSource
  ): Promise<{ success: boolean; error?: string }> {
    const record = this.getDao().modules.findByIdSync(moduleId)
    if (!record) {
      return { success: false, error: `未找到模块: ${moduleId}` }
    }

    // 1. 开发者模式纯读有效性推导 (打包态非 canary 强制熔断为 false)
    const devModeEffective = !this.isPackaged

    // 2. 独占能力槽单选替换与抢占检查
    const slot = record.capability_slot ?? 'general'
    const policy = record.slot_policy ?? 'multi_active'
    const isExclusive = policy === 'exclusive_required' || policy === 'exclusive_optional'

    if (isExclusive && source === 'user_toggle') {
      await this.handleSlotSwitchover(slot, moduleId)
    }

    const slotPreempted = await this.checkSlotPreempted(moduleId, record.capability_slot)

    // 3. 纯函数生命周期决策
    const decision = deriveRunDecision(
      {
        availability: record.availability,
        install_state: 'active', // 意图为拉起
        delist_reason: record.delist_reason ?? null
      },
      { devModeEffective, slotPreempted }
    )

    if (!decision.shouldRun) {
      this.setHoldReasons(moduleId, decision.holdReasons)
      return { success: false, error: decision.blockReason }
    }

    // 4. 执行拉起
    try {
      if (record.backend_type === 'utility_process') {
        await this.spawnProcess(moduleId)
      } else {
        // omni_onnx 与 builtin 模块直接转入运行态
        let s = this.runningStates.get(moduleId)
        if (!s) {
          s = { running: true, holdReasons: new Set() }
          this.runningStates.set(moduleId, s)
        } else {
          s.running = true
          s.holdReasons.clear()
        }
      }

      // 清除可能存在的挂起原因
      const s = this.runningStates.get(moduleId)
      if (s) {
        s.holdReasons.clear()
      }

      return { success: true }
    } catch (err: any) {
      logger.error(LogCategory.SYSTEM, `[PluginProcessManager] 启动模块 ${moduleId} 失败:`, err)
      return { success: false, error: err?.message || '进程拉起异常' }
    }
  }

  /**
   * 拉起 utility_process 子进程
   */
  public async spawnProcess(moduleId: string): Promise<void> {
    const host = this.hostManager.getHost(moduleId)
    if (host) {
      await host.ensureHost()
      let s = this.runningStates.get(moduleId)
      if (!s) {
        s = { running: true, pid: host.pid, holdReasons: new Set() }
        this.runningStates.set(moduleId, s)
      } else {
        s.running = true
        s.pid = host.pid
        s.holdReasons.clear()
      }
    } else {
      // 记录基础运行状态
      let s = this.runningStates.get(moduleId)
      if (!s) {
        s = { running: true, holdReasons: new Set() }
        this.runningStates.set(moduleId, s)
      } else {
        s.running = true
        s.holdReasons.clear()
      }
    }
  }

  /**
   * 主动停止指定插件（四段式跨平台安全终结管线）
   */
  public async stopProcess(moduleId: string): Promise<void> {
    logger.info(LogCategory.SYSTEM, `[PluginProcessManager] 正在安全停止模块: ${moduleId}`)
    const host = this.hostManager.getHost(moduleId)
    const s = this.runningStates.get(moduleId)

    if (host) {
      const pid = host.pid
      // 1. 发送 retire 指令并等待最多 3000ms
      let retireTimedOut = false
      const timeoutPromise = new Promise<'timeout'>(resolve => {
        setTimeout(() => resolve('timeout'), 3000)
      })

      const retireResult = await Promise.race([host.retire().then(() => 'done'), timeoutPromise])

      if (retireResult === 'timeout') {
        retireTimedOut = true
        logger.warn(
          LogCategory.SYSTEM,
          `[PluginProcessManager] 模块 ${moduleId} retire 超时 (3000ms)，触发跨平台强杀`
        )
      }

      // 2. 超时强杀分支
      if (retireTimedOut && pid) {
        try {
          if (process.platform === 'win32') {
            execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' })
          } else {
            try {
              process.kill(-pid, 'SIGKILL')
            } catch {
              process.kill(pid, 'SIGKILL')
            }
          }
        } catch (killErr) {
          logger.warn(LogCategory.SYSTEM, `[PluginProcessManager] 强杀 pid ${pid} 异常:`, killErr)
        }
      }

      // 3. 延迟 200ms 等待操作系统解除文件锁
      await new Promise(resolve => setTimeout(resolve, 200))
    }

    // 4. 更新内存态为停止
    if (s) {
      s.running = false
      s.pid = undefined
    }
  }

  /**
   * 冷启动幂等对账
   */
  public async reconcileOnStartup(): Promise<void> {
    logger.info(LogCategory.SYSTEM, '[PluginProcessManager] 正在执行应用冷启动幂等对账...')
    const devModeEffective = !this.isPackaged
    const activeRows = this.getDao().modules.findActiveSync()

    for (const row of activeRows) {
      const slotPreempted = await this.checkSlotPreempted(row.id, row.capability_slot)
      const decision = deriveRunDecision(row, { devModeEffective, slotPreempted })

      if (decision.shouldRun) {
        if (row.backend_type === 'utility_process') {
          await this.spawnProcess(row.id).catch(err => {
            logger.warn(
              LogCategory.SYSTEM,
              `[PluginProcessManager] 冷启动拉起 ${row.id} 失败:`,
              err
            )
          })
        } else {
          let s = this.runningStates.get(row.id)
          if (!s) {
            s = { running: true, holdReasons: new Set() }
            this.runningStates.set(row.id, s)
          } else {
            s.running = true
            s.holdReasons.clear()
          }
        }
      } else {
        this.setHoldReasons(row.id, decision.holdReasons)
      }
    }
  }
}

let activeProcessManager: PluginProcessManager | null = null

export function getPluginProcessManager(): PluginProcessManager {
  if (!activeProcessManager) {
    activeProcessManager = new PluginProcessManager()
  }
  return activeProcessManager
}

export function setPluginProcessManagerForTest(manager: PluginProcessManager | null): void {
  activeProcessManager = manager
}
