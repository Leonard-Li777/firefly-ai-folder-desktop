/**
 * 模型升级与卸载两阶段 Tombstone GC 服务
 *
 * 核心机制：
 * 1. 模型升级/卸载时，先向 Omni 发送 Slot Unload 释放模型句柄；
 * 2. 事务外执行两阶段删除：先原子重命名为 .deleting-<uuid> 脱离活动路径，再退避重试删除；
 * 3. 若重命名或删除遭遇 Windows 句柄占用（EBUSY / EPERM），将路径注册入待清理清单并触发横幅提醒；
 * 4. 启动期 reconcileOnStartup() 对账自愈，彻底物理清空残留的 .deleting_* 目录。
 */

import * as fs from 'fs'
import * as path from 'path'
import { app as electronApp } from 'electron'
import { logger, LogCategory } from '@firefly/shared'
import { safeDeleteDirectory, cleanOrphanTombstones } from '../system/file-download-service'

export interface PendingDeletionItem {
  path: string
  registeredAt: string
  reason?: string
}

export class TombstoneGCService {
  private static instance: TombstoneGCService | null = null
  private pendingDeletions: Map<string, PendingDeletionItem> = new Map()
  private persistenceFilePath: string | null = null

  constructor(persistenceFilePath?: string) {
    if (persistenceFilePath) {
      this.persistenceFilePath = persistenceFilePath
      this.loadPersistedDeletions()
    }
  }

  static getInstance(persistenceFilePath?: string): TombstoneGCService {
    if (!TombstoneGCService.instance) {
      TombstoneGCService.instance = new TombstoneGCService(persistenceFilePath)
    }
    return TombstoneGCService.instance
  }

  /**
   * 设置待清理记录的持久化文件路径 (如 modules/_pending_tombstones.json)
   */
  public setPersistenceFile(filePath: string): void {
    this.persistenceFilePath = filePath
    this.loadPersistedDeletions()
  }

  private loadPersistedDeletions(): void {
    if (!this.persistenceFilePath || !fs.existsSync(this.persistenceFilePath)) return
    try {
      const data = fs.readFileSync(this.persistenceFilePath, 'utf8')
      const items: PendingDeletionItem[] = JSON.parse(data)
      for (const item of items) {
        if (item.path && fs.existsSync(item.path)) {
          this.pendingDeletions.set(item.path, item)
        }
      }
    } catch (err) {
      logger.warn(LogCategory.SYSTEM, '[TombstoneGC] 加载持久化待清理记录失败:', err)
    }
  }

  private savePersistedDeletions(): void {
    if (!this.persistenceFilePath) return
    try {
      const dir = path.dirname(this.persistenceFilePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      const items = Array.from(this.pendingDeletions.values())
      fs.writeFileSync(this.persistenceFilePath, JSON.stringify(items, null, 2), 'utf8')
    } catch (err) {
      logger.warn(LogCategory.SYSTEM, '[TombstoneGC] 保存持久化待清理记录失败:', err)
    }
  }

  /**
   * 注册遭遇句柄占用的待清理目录
   */
  public registerPendingDeletion(dirPath: string, reason?: string): void {
    const normalized = path.normalize(dirPath)
    this.pendingDeletions.set(normalized, {
      path: normalized,
      registeredAt: new Date().toISOString(),
      reason
    })
    this.savePersistedDeletions()
    logger.warn(
      LogCategory.SYSTEM,
      `[TombstoneGC] 路径已被 Windows 句柄占用，进入待重启清理队列: ${normalized} (原因: ${reason || 'EBUSY'})`
    )
  }

  /**
   * 移除已成功清理的路径
   */
  public clearPendingDeletion(dirPath: string): void {
    const normalized = path.normalize(dirPath)
    if (this.pendingDeletions.delete(normalized)) {
      this.savePersistedDeletions()
    }
  }

  /**
   * 获取所有被句柄占用的待清理路径
   */
  public getPendingDeletions(): PendingDeletionItem[] {
    return Array.from(this.pendingDeletions.values()).filter(item => fs.existsSync(item.path))
  }

  /**
   * 是否存在需要重启释放的待清理项目
   */
  public hasPendingDeletions(): boolean {
    return this.getPendingDeletions().length > 0
  }

  /**
   * 向 Omni 发送 Slot Unload 请求释放文件句柄
   */
  public async unloadSlotBeforeDelete(slotName?: string): Promise<void> {
    if (!slotName) return
    try {
      const { omniService } = await import('../system/omni-service')
      if (typeof omniService.unloadSlot === 'function') {
        await omniService.unloadSlot(slotName)
      } else if (typeof omniService.syncConfigFromDesktop === 'function') {
        await omniService.syncConfigFromDesktop()
      }
    } catch (err) {
      logger.warn(
        LogCategory.SYSTEM,
        `[TombstoneGC] 卸载 slot (${slotName}) 释放句柄异常 (已忽略):`,
        err
      )
    }
  }

  /**
   * 尝试安全删除（整合 Slot 卸载、两阶段重命名与 EBUSY 待清理队列）
   */
  public async safeDeleteWithTombstone(
    dirPath: string,
    options?: {
      slot?: string
      deleteDirectoryFn?: (p: string) => Promise<boolean>
    }
  ): Promise<boolean> {
    if (!fs.existsSync(dirPath)) {
      this.clearPendingDeletion(dirPath)
      return true
    }

    // 1. 若关联能力槽位，先卸载槽位释放句柄
    if (options?.slot) {
      await this.unloadSlotBeforeDelete(options.slot)
    }

    const delFn = options?.deleteDirectoryFn ?? safeDeleteDirectory

    try {
      const deleted = await delFn(dirPath)
      if (deleted) {
        this.clearPendingDeletion(dirPath)
        return true
      }
      // 删除返回 false 说明 Windows 进程句柄仍被占用（EBUSY/EPERM）
      this.registerPendingDeletion(dirPath, 'Windows 文件句柄占用 (EBUSY/EPERM)')
      return false
    } catch (err: any) {
      if (err?.code === 'EBUSY' || err?.code === 'EPERM') {
        this.registerPendingDeletion(dirPath, `句柄锁定 (${err.code})`)
        return false
      }
      throw err
    }
  }

  /**
   * 启动期对账与清空自愈
   */
  public async reconcileOnStartup(baseDirs: string[]): Promise<number> {
    let totalCleaned = 0

    // 1. 扫描清理所有物理孤儿目录
    for (const d of baseDirs) {
      if (fs.existsSync(d)) {
        totalCleaned += await cleanOrphanTombstones(d)
      }
    }

    // 2. 重试清理已登记的 pendingDeletions 列表
    for (const [pathStr] of Array.from(this.pendingDeletions.entries())) {
      if (!fs.existsSync(pathStr)) {
        this.clearPendingDeletion(pathStr)
        totalCleaned++
        continue
      }
      try {
        fs.rmSync(pathStr, { recursive: true, force: true })
        this.clearPendingDeletion(pathStr)
        totalCleaned++
        logger.info(LogCategory.SYSTEM, `[TombstoneGC] 启动期成功清空占用目录: ${pathStr}`)
      } catch (err: any) {
        logger.warn(LogCategory.SYSTEM, `[TombstoneGC] 启动期清理仍失败 (${err.code}): ${pathStr}`)
      }
    }

    return totalCleaned
  }

  /**
   * 请求重启桌面端应用以彻底释放文件句柄
   */
  public requestAppRestart(): void {
    logger.info(LogCategory.SYSTEM, '[TombstoneGC] 用户触发重启应用以释放文件句柄...')
    try {
      if (electronApp && typeof electronApp.relaunch === 'function') {
        electronApp.relaunch()
        electronApp.exit(0)
      } else {
        logger.warn(
          LogCategory.SYSTEM,
          '[TombstoneGC] electron app.relaunch 不可用（非 Electron 运行时）'
        )
      }
    } catch (err) {
      logger.error(LogCategory.SYSTEM, '[TombstoneGC] 重启应用失败:', err)
    }
  }
}

export const tombstoneGCService = TombstoneGCService.getInstance()
