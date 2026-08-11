import { TierService, UserTierQueries, KMLogic, WORKSPACE_CONSTANTS } from '@firefly/server'
import { UserTierDataManager } from '@firefly/core-engine'
import {
  UserTierProfile,
  FirecoreOperationType,
  UserTierData,
  QuotaType,
  UserTier,
  EntitlementType,
  Entitlement,
  TierConstants
} from '@firefly/types'
import { ipcMain, BrowserWindow, app } from 'electron'
import { ConfigOrchestrator } from '../../config/config-orchestrator'
import { SystemIdentityService } from '../system/system-identity-service'
import { logger, LogCategory, FIRECORE_OPERATION_TYPES, getSharedSchemaName } from '@firefly/shared'
import { databaseService } from '../database/database-service'
import { createSupabaseClient } from '../system/supabase-client-factory'
import { t } from '@app/languages'
import { net } from 'electron'

export class UserTierService {
  private static instance: UserTierService
  private queries: UserTierQueries | null = null
  private tierService: TierService | null = null
  private encryptionKey: Buffer | null = null
  private hmacKey: Buffer | null = null
  private configCleanup: (() => void) | null = null
  /** UserTierDataManager 实例，延迟初始化 */
  private dataManager: UserTierDataManager | null = null
  /** 防重：记录最近消费的 txId，防止重复扣费 */
  private recentSpendTxIds: Set<string> = new Set()

  private constructor() {}

  private getTierConstants(): TierConstants {
    return ConfigOrchestrator.getInstance().getTierConstants()
  }

  static getInstance(): UserTierService {
    if (!UserTierService.instance) {
      UserTierService.instance = new UserTierService()
    }
    return UserTierService.instance
  }

  static resetDataManagerForTest(): void {
    UserTierDataManager.resetInstance()
    if (UserTierService.instance) {
      UserTierService.instance.dataManager = null
    }
  }

  /** 获取或创建 UserTierDataManager */
  private getDataManager(): UserTierDataManager {
    if (!this.dataManager) {
      const orchestrator = ConfigOrchestrator.getInstance()
      const machineId = SystemIdentityService.getInstance().getMachineId()

      this.dataManager = UserTierDataManager.getInstance({
        machineId,
        tierConstants: this.getTierConstants(),
        db: () => databaseService.db,
        getTierService: () => this.getTierService(),
        encryptionKey: this.encryptionKey!,
        hmacKey: this.hmacKey!,
        configGet: <T>(key: string) => orchestrator.getValue<T>(key as any),
        configSet: (key: string, value: any, options?: any) =>
          orchestrator.updateValue(key as any, value, options),
        isOnline: () => (typeof net.isOnline === 'function' ? net.isOnline() : true),
        onDataChanged: () => {
          this.notifyProfileChanged()
        },
        onTransactionFailed: (message: string) => {
          BrowserWindow.getAllWindows().forEach(win =>
            win.webContents.send('userTier/transactionFailed', { message })
          )
        },
        checkIntervalMs: -1 // 不启动定时同步，仅消费/查流水/启动时手动触发
      })
    }
    return this.dataManager
  }

  private getTierService(): TierService {
    if (!this.tierService) {
      const machineId = SystemIdentityService.getInstance().getMachineId()
      const signature = SystemIdentityService.getInstance().getSignature()
      const supabase = createSupabaseClient(
        WORKSPACE_CONSTANTS.SUPABASE_URL,
        WORKSPACE_CONSTANTS.SUPABASE_ANON_KEY,
        machineId,
        signature
      )
      const schema = getSharedSchemaName()
      this.queries = new UserTierQueries(supabase, this.getTierConstants(), schema)
      this.tierService = new TierService(this.queries, this.getTierConstants())
    }
    return this.tierService
  }

  getCachedData(): UserTierData | null {
    try {
      return this.getDataManager().getData()
    } catch {
      return null
    }
  }

  async getProfile(): Promise<UserTierProfile> {
    await databaseService.ensureInitialized()
    const data = this.getDataManager().getData()
    return {
      tier: data.tier,
      firecores: data.firecores,
      entitlements: data.entitlements,
      counters: data.counters,
      computed_limits: data.computed_limits,
      subscription: data.subscription
    }
  }

  async getUserTierData(): Promise<UserTierData> {
    await databaseService.ensureInitialized()
    return this.getDataManager().getData()
  }

  async checkQuota(operation: {
    type: QuotaType
    currentCount: number
    amount?: number
  }): Promise<any> {
    const data = this.getDataManager().getData()
    const tierService = this.getTierService()
    return tierService.checkQuota(data, operation)
  }

  async spendFirecores(
    firecores: number,
    type: FirecoreOperationType = 'spend_unlock_analysis',
    metadata?: Record<string, any>
  ): Promise<{ success: boolean; message?: string }> {
    const data = this.getDataManager().getData()

    // 企业版跳过扣费
    if (data.tier === UserTier.ENTERPRISE) return { success: true }

    // 消费前检查离线授权是否已过期
    try {
      const { LicenseService, LicenseStatus } = await import('../system/license-service')
      const licenseResult = await LicenseService.getInstance().checkLicenseStatus(true)
      if (licenseResult.status !== LicenseStatus.AUTHORIZED) {
        // 通知渲染进程授权失效
        const { BrowserWindow } = await import('electron')
        BrowserWindow.getAllWindows().forEach(win => {
          if (!win.isDestroyed()) {
            win.webContents.send('license:unauthorized', licenseResult)
          }
        })
      }
    } catch {
      // 检查失败不阻断消费，仅记录日志
    }

    if (!FIRECORE_OPERATION_TYPES.includes(type as any)) {
      return { success: false, message: '不支持的操作类型' }
    }

    const scope = metadata?.workspaceId != null ? Number(metadata.workspaceId) : null
    const machineId = SystemIdentityService.getInstance().getMachineId()
    const txId = this.getDeterministicUUID()

    // 防重：同一 type+reference_id 在 5 秒内不重复扣费
    const dedupKey = `${type}:${metadata?.reference_id || ''}`
    const now = Date.now()
    if (this.recentSpendTxIds.has(dedupKey)) {
      logger.warn(
        LogCategory.SYSTEM,
        '[DEBUG-SPEND] 防重命中: dedupKey=%s, txId=%s, 跳过',
        dedupKey,
        txId
      )
      return { success: true, message: '操作已完成' }
    }
    this.recentSpendTxIds.add(dedupKey)
    // 5 秒后自动清除防重记录
    setTimeout(() => {
      this.recentSpendTxIds.delete(dedupKey)
    }, 5000)

    logger.info(
      LogCategory.SYSTEM,
      '[DEBUG-SPEND]spendFirecores 入口: type=%s, firecores=%d, txId=%s',
      type,
      firecores,
      txId
    )

    const tierConstants = this.getTierConstants()
    const isCloudFirst = tierConstants.firecoreCloudFirstConfirm?.[type] === true

    if (isCloudFirst && this.getDataManager().isOnline()) {
      try {
        logger.info(LogCategory.SYSTEM, '[DEBUG-SPEND]云优先路径: 调用RPC, txId=%s', txId)
        const result = await this.getTierService().spendFirecores(machineId, {
          type,
          id: txId,
          metadata: { ...metadata, workspaceId: scope }
        })
        logger.info(
          LogCategory.SYSTEM,
          '[DEBUG-SPEND]云优先路径 RPC结果: success=%s',
          result.success
        )
        if (result.success) {
          const localResult = await this.getDataManager().spendFirecoresLocal(
            firecores,
            type,
            metadata,
            txId
          )
          if (!localResult.success) {
            // 本地写入失败时回滚云端
            await this.getTierService().spendFirecores(machineId, {
              type,
              id: txId,
              metadata: { ...metadata, workspaceId: scope, __rollback: true }
            })
            return localResult
          }
          const db = databaseService.db
          if (db) {
            db.prepare(
              `UPDATE pending_firecore_operations SET status = 'completed', synced_at = ? WHERE id = ?`
            ).run(new Date().toISOString(), txId)
            logger.info(
              LogCategory.SYSTEM,
              '[DEBUG-SPEND]云优先路径: pending已更新为completed, txId=%s',
              txId
            )
          }
          this.syncLocalCacheAndNotify(machineId).catch(err => {
            logger.error(LogCategory.SYSTEM, '[UserTierService] 后台同步失败:', err)
          })
          return { success: true }
        } else {
          return { success: false, message: result.message || t('云端执行失败') }
        }
      } catch (error) {
        logger.error(
          LogCategory.SYSTEM,
          'spendFirecores 云端执行网络异常，回退本地乐观更新:',
          error
        )
        // 网络异常时，直接走本地优先路径
        // 注意：不要 return，继续执行下面的本地优先路径
      }
    }

    // 1. 本地扣减与暂存
    logger.info(
      LogCategory.SYSTEM,
      '[DEBUG-SPEND]本地优先路径: spendFirecoresLocal, txId=%s, firecores=%d',
      txId,
      firecores
    )
    const localResult = await this.getDataManager().spendFirecoresLocal(
      firecores,
      type,
      metadata,
      txId
    )
    if (!localResult.success) {
      logger.warn(LogCategory.SYSTEM, '[DEBUG-SPEND]本地扣减失败: %s', localResult.message)
      return localResult
    }
    logger.info(LogCategory.SYSTEM, '[DEBUG-SPEND]本地扣减成功')

    // 2. 异步上报云端 (如果在线)
    if (this.getDataManager().isOnline()) {
      try {
        logger.info(LogCategory.SYSTEM, '[DEBUG-SPEND]调用云端RPC, txId=%s', txId)
        const result = await this.getTierService().spendFirecores(machineId, {
          type,
          id: txId,
          metadata: { ...metadata, workspaceId: scope }
        })
        logger.info(LogCategory.SYSTEM, '[DEBUG-SPEND]云端RPC结果: success=%s', result.success)
        if (result.success) {
          // 云端成功，直接将本地 pending 转为 completed
          const db = databaseService.db
          if (db) {
            db.prepare(
              `UPDATE pending_firecore_operations SET status = 'completed', synced_at = ? WHERE id = ?`
            ).run(new Date().toISOString(), txId)
            logger.info(LogCategory.SYSTEM, '[DEBUG-SPEND]pending已更新为completed, txId=%s', txId)
          }
          // 异步刷新缓存并通知
          this.syncLocalCacheAndNotify(machineId).catch(err => {
            logger.error(LogCategory.SYSTEM, '[UserTierService] 后台同步失败:', err)
          })
          return { success: true }
        } else {
          // 云端业务失败 (例如余额不足)，本地回滚
          logger.warn(
            LogCategory.SYSTEM,
            '[DEBUG-SPEND]云端RPC业务失败，回滚本地: %s',
            result.message
          )
          await this.rollbackLocal(txId)
          return { success: false, message: result.message || t('云端执行失败') }
        }
      } catch (error) {
        logger.error(LogCategory.SYSTEM, 'spendFirecores 云端执行网络异常，转为离线模式:', error)
        // 网络异常，本地保持 pending，但直接返回成功允许使用！
        return { success: true }
      }
    }

    // 离线模式：由于本地已成功写入 pending，直接返回 success: true 允许进入离线流程！
    return { success: true }
  }

  async rollbackLocal(operationId: string): Promise<void> {
    await this.getDataManager().rollbackLocal(operationId)
  }

  hasPendingOperations(): boolean {
    return this.getDataManager().hasPendingOperations()
  }

  async syncToCache(machineId: string): Promise<void> {
    logger.info(LogCategory.SYSTEM, '[DEBUG-SYNC] syncToCache 被调用: machineId=%s', machineId)
    await this.getDataManager().trySync()
  }

  async getConsumptionDetails(): Promise<any[]> {
    const machineId = SystemIdentityService.getInstance().getMachineId()

    // 阶段一：立即返回本地数据库的流水记录
    const locals = this.getDataManager().getLocalPendingRecords()

    // 阶段二：后台异步拉取云端数据，完成后通过 IPC 事件通知渲染进程更新
    this.fetchCloudTransactionsInBackground(machineId, locals.length === 0)

    // 如果本地有记录，直接返回（不等待云端）
    if (locals.length > 0) {
      return locals
    }

    // 本地无记录时，仍尝试获取云端数据（阻塞等待）
    return this.fetchAndPushCloudTransactions(machineId)
  }

  private async ensureKeys(): Promise<void> {
    if (this.encryptionKey && this.hmacKey) return
    const machineId = SystemIdentityService.getInstance().getMachineId()
    const orchestrator = ConfigOrchestrator.getInstance()
    const storedKMHex = orchestrator.getValue<string>('CACHE_KEY_DATA') || null
    const offlineLicense = orchestrator.getValue<string>('OFFLINE_LICENSE') || null
    const { LicenseService, LicenseStatus } = await import('../system/license-service')
    const licenseService = LicenseService.getInstance()
    const statusResult = await licenseService.checkLicenseStatus()
    const isLicenseAuthorized = statusResult.status === LicenseStatus.AUTHORIZED
    const queries = this.queries || null
    const result = await KMLogic.resolveKeys({
      machineId,
      storedKMHex,
      offlineLicense,
      isLicenseAuthorized,
      queries
    })
    this.encryptionKey = result.encryptionKey
    this.hmacKey = result.hmacKey
    if (result.newKMHexToStore !== undefined) {
      await orchestrator.updateValue('CACHE_KEY_DATA', result.newKMHexToStore, {
        source: 'runtime'
      })
    }
  }

  private getDeterministicUUID(): string {
    return require('crypto').randomUUID()
  }

  async fetchAndPushCloudTransactions(machineId: string): Promise<any[]> {
    try {
      const cloudData = await this.getTierService().getFirecoreTransactions(machineId, 500, 0)
      if (!cloudData || cloudData.length === 0) {
        const locals = this.getDataManager().getLocalPendingRecords()
        if (locals.length === 0) {
          return [
            {
              type: 'welcome_grant',
              firecores: this.getTierConstants().welcomeGrantFirecores,
              balance_after: this.getTierConstants().welcomeGrantFirecores,
              status: 'completed',
              time: new Date().toISOString(),
              metadata: null
            }
          ]
        }
        return locals
      }
      return cloudData.map(tx => ({
        id: tx.id,
        type: tx.transaction_type,
        firecores: tx.firecores,
        balance_after: tx.balance_after,
        status: 'completed',
        time: tx.created_at,
        metadata: tx.metadata || null
      }))
    } catch {
      const locals = this.getDataManager().getLocalPendingRecords()
      if (locals.length === 0) {
        return [
          {
            type: 'welcome_grant',
            firecores: this.getTierConstants().welcomeGrantFirecores,
            balance_after: this.getTierConstants().welcomeGrantFirecores,
            status: 'completed',
            time: new Date().toISOString(),
            metadata: null
          }
        ]
      }
      return locals
    }
  }

  /**
   * 后台异步拉取云端流水记录，完成后通过 IPC 事件通知渲染进程更新
   * 不阻塞主流程，本地数据优先显示
   */
  private async fetchCloudTransactionsInBackground(
    machineId: string,
    fallbackToDefault: boolean
  ): Promise<void> {
    try {
      // 先触发双向同步（回放本地 pending + 拉取云端流水到本地）
      try {
        await this.getDataManager().trySync()
      } catch (e) {
        logger.warn(LogCategory.SYSTEM, '[UserTierService] 查流水时后台同步失败:', e)
      }

      const cloudData = await this.getTierService().getFirecoreTransactions(machineId, 500, 0)
      let result: any[]
      if (!cloudData || cloudData.length === 0) {
        if (fallbackToDefault) {
          result = [
            {
              type: 'welcome_grant',
              firecores: this.getTierConstants().welcomeGrantFirecores,
              balance_after: this.getTierConstants().welcomeGrantFirecores,
              status: 'completed',
              time: new Date().toISOString(),
              metadata: null
            }
          ]
        } else {
          return // 本地已有记录且云端为空，不做更新
        }
      } else {
        result = cloudData.map(tx => ({
          id: tx.id,
          type: tx.transaction_type,
          firecores: tx.firecores,
          balance_after: tx.balance_after,
          status: 'completed',
          time: tx.created_at,
          metadata: tx.metadata || null
        }))
      }
      this.notifyFirecoreTransactionsUpdated(result)
    } catch {
      // 后台获取云端数据失败，静默忽略（本地数据已展示）
    }
  }

  async removeVDirEntitlement(vdirId: number): Promise<void> {
    const mgr = this.getDataManager()
    await mgr.refundFirecores(
      0,
      ent => ent.type === 'access_vdir' && ent.metadata?.virtual_directory_id === vdirId
    )
  }

  reloadServices(): void {
    this.tierService = null
    UserTierDataManager.resetInstance()
    this.dataManager = null
    this.recentSpendTxIds.clear()
    logger.info(LogCategory.SYSTEM, 'UserTierService services reloaded')
  }

  /**
   * 从离线授权码中恢复 userTierData，重置密钥缓存并重新计算 computed_limits。
   *
   * 调用前需确保 CACHE_KEY_DATA 已更新（由 LicenseService.writeEmbeddedUserTierData 写入），
   * 本方法内部通过 ensureKeys 从新 CACHE_KEY_DATA 重新派生密钥。
   *
   * @param data  离线授权码中嵌入的 userTierData
   * @param machineId  机器标识
   */
  async restoreFromLicenseData(data: UserTierData, machineId: string): Promise<void> {
    // 1. 清除密钥缓存，后续 ensureKeys 从新 CACHE_KEY_DATA 重新派生
    this.encryptionKey = null
    this.hmacKey = null
    await this.ensureKeys()

    // 2. 重置 UserTierDataManager 实例，强制重建时使用新密钥
    UserTierDataManager.resetInstance()
    this.dataManager = null

    // 3. 重新创建 DataManager（已使用新密钥），通过统一方法处理订阅过期后写入
    const manager = this.getDataManager()
    const effectiveData = UserTierDataManager.ensureNotExpired(data)
    // replaceFromCloud() 内部调用 build() → computeComputedLimits() 并持久化
    await manager.replaceFromCloud(effectiveData)
  }

  async initialize(): Promise<void> {
    await databaseService.ensureInitialized()
    if (!databaseService.db) {
      logger.info(
        LogCategory.SYSTEM,
        '[UserTierService] 数据库未初始化 (语言未确认)，暂缓 UserTierService 数据库加载'
      )
      return
    }

    const initProcess = async () => {
      logger.info(
        LogCategory.SYSTEM,
        '[UserTierService] net modules keys:',
        Object.keys(net),
        'isOnline type:',
        typeof net.isOnline
      )
      const machineId = await SystemIdentityService.getInstance().getMachineId()
      logger.info(LogCategory.SYSTEM, '[UserTierService] 初始化开始, machineId:', machineId)
      // ensureKeys 可能因网络等问题失败，但不阻塞后续初始化
      try {
        await this.ensureKeys()
      } catch (e) {
        logger.warn(LogCategory.SYSTEM, '[UserTierService] 密钥派生失败，降级继续初始化:', e)
      }
      this.configCleanup = ConfigOrchestrator.getInstance().onConfigChange(changes => {
        if ('DEFAULT_LANGUAGE' in changes) {
          UserTierDataManager.resetInstance()
          this.dataManager = null
          // 语言切换后数据库重建，需要重新同步
          this.syncLocalCacheAndNotify(SystemIdentityService.getInstance().getMachineId()).catch(
            err => {
              logger.error(LogCategory.SYSTEM, '[UserTierService] 配置变更后同步失败:', err)
            }
          )
        }
      })
      // 初始化 DataManager (它会自动启动定时器和同步)
      this.getDataManager()
      // 初始时通知一次 Profile 改变，防止渲染进程显示残留/为 0
      this.notifyProfileChanged()
      logger.info(LogCategory.SYSTEM, '[UserTierService] 初始化完成，开始后台同步')
      // 后台同步
      await this.syncLocalCacheAndNotify(machineId).catch(err => {
        logger.error(LogCategory.SYSTEM, '[UserTierService] 初始云端同步失败:', err)
      })
      logger.info(LogCategory.SYSTEM, '[UserTierService] 初始云端同步完成')
    }

    if (app.isReady()) {
      await initProcess()
    } else {
      await app.whenReady()
      await initProcess()
    }
  }

  async syncLocalCacheAndNotify(machineId: string): Promise<void> {
    logger.info(
      LogCategory.SYSTEM,
      '[UserTierService] syncLocalCacheAndNotify 开始, machineId:',
      machineId
    )
    try {
      // 先确保密钥已派生（可能被 activate 清空后需从新写入的 CACHE_KEY_DATA 重新派生）
      await this.ensureKeys()
    } catch (e) {
      logger.warn(LogCategory.SYSTEM, '[UserTierService] 密钥派生失败，降级进行同步:', e)
    }
    try {
      // 清除缓存的 DataManager，强制从最新配置（新写入的 USER_TIER_CACHE_DATA）重新加载
      this.dataManager = null
      await this.getDataManager().trySync()
    } catch (e) {
      logger.error(LogCategory.SYSTEM, 'syncLocalCacheAndNotify failed', e)
    }
    this.notifyProfileChanged()

    // 启动时异步拉取云端流水记录，确保余额变更（如邀请赠送）能及时反映
    this.fetchCloudTransactionsInBackground(machineId, false).catch(err => {
      logger.error(LogCategory.SYSTEM, '[UserTierService] 启动时流水同步失败:', err)
    })

    // 同步后检测等级是否降级到免费/过期，通知前端触发授权弹层
    const currentData = this.getDataManager().getData()
    if (currentData.tier === UserTier.FREE) {
      const { LicenseService, LicenseStatus } = await import('../system/license-service')
      const licenseResult = await LicenseService.getInstance().checkLicenseStatus(true)
      if (licenseResult.status !== LicenseStatus.AUTHORIZED) {
        const { BrowserWindow } = await import('electron')
        BrowserWindow.getAllWindows().forEach(win => {
          if (!win.isDestroyed()) {
            win.webContents.send('license:unauthorized', licenseResult)
          }
        })
      }
    }
  }

  private notifyProfileChanged(): void {
    BrowserWindow.getAllWindows().forEach(win =>
      win.webContents.send('userTier/profileChanged', this.getDataManager().getData())
    )
  }

  /**
   * 发送流水更新事件到渲染进程，通知 UI 更新云端数据
   */
  private notifyFirecoreTransactionsUpdated(data: any[]): void {
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send('userTier/firecoreTransactionsUpdated', data)
      }
    })
  }
}

export const userTierService = UserTierService.getInstance()
