import { TierService, UserTierQueries, KMLogic, WORKSPACE_CONSTANTS } from '@firefly/server'
import { UserTierDataManager, LocalOfflineLicenseInfo } from '@firefly/core-engine'
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
import { emitRuntimeContextChange } from '../system/workspace-runtime-context-bus'

export class UserTierService {
  private static instance: UserTierService
  private queries: UserTierQueries | null = null
  private tierService: TierService | null = null
  private encryptionKey: Buffer | null = null
  private hmacKey: Buffer | null = null
  private configCleanup: (() => void) | null = null
  /** UserTierDataManager 实例，延迟初始化 */
  private dataManager: UserTierDataManager | null = null
  /** 已校验的本机离线授权摘要，供 DataManager 执行本地优先仲裁 */
  private verifiedOfflineLicense: LocalOfflineLicenseInfo | null = null
  /** 防重：记录最近消费的 txId，防止重复扣费 */
  private recentSpendTxIds: Set<string> = new Set()
  /** 云端流水后台拉取飞行中句柄：并发入口复用同一次请求，杜绝同一份流水被推送两次导致列表重绘 */
  private cloudTransactionsInFlight: Promise<void> | null = null

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
      UserTierService.instance.verifiedOfflineLicense = null
    }
  }

  /** 获取或创建 UserTierDataManager（禁止空密钥或未确认态构造单例） */
  private getDataManager(): UserTierDataManager {
    if (!this.dataManager) {
      if (!this.encryptionKey || !this.hmacKey) {
        throw new Error('[UserTierService] 密钥尚未派生，禁止构造 UserTierDataManager')
      }
      const tierConstants = this.getTierConstants()
      if (!tierConstants || !tierConstants.tierLimits) {
        throw new Error('[UserTierService] TIER_CONSTANTS 尚未就绪，禁止构造 UserTierDataManager')
      }
      const orchestrator = ConfigOrchestrator.getInstance()
      const machineId = SystemIdentityService.getInstance().getMachineId()

      this.dataManager = UserTierDataManager.getInstance({
        machineId,
        tierConstants,
        db: () => databaseService.db,
        getTierService: () => this.getTierService(),
        encryptionKey: this.encryptionKey!,
        hmacKey: this.hmacKey!,
        configGet: <T>(key: string) => orchestrator.getValue<T>(key as any),
        configSet: (key: string, value: any, options?: any) =>
          orchestrator.updateValue(key as any, value, options),
        isOnline: () => (typeof net.isOnline === 'function' ? net.isOnline() : true),
        getLocalOfflineLicense: () => this.verifiedOfflineLicense,
        onDataChanged: () => {
          this.notifyProfileChanged()
        },
        onTransactionFailed: (message: string) => {
          BrowserWindow.getAllWindows().forEach(win =>
            win.webContents.send('userTier/transactionFailed', { message })
          )
        },
        onDeviceUnbound: () => {
          BrowserWindow.getAllWindows().forEach(win =>
            win.webContents.send('userTier/deviceUnbound')
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

      // 追查源头，严禁消费侧伪兜底：TIER_CONSTANTS 是云端 SSOT（异步下行），
      // 启动早期尚未就绪时必须显式上浮错误，暴露配置时序缺口，
      // 严禁把 undefined 冻结进 TierService 单例导致后续 syncFromCloud 读取
      // this.tierConstants.tierLimits 时抛出晦涩的 TypeError（原报错根因）。
      const tierConstants = this.getTierConstants()
      if (!tierConstants || !tierConstants.tierLimits) {
        throw new Error(
          '[UserTierService] TIER_CONSTANTS 未就绪（云端 SSOT 尚未下行）。' +
            'tier 服务依赖 tierConstants 计算额度，无法在配置缺失时构造。' +
            '请等待 ConfigDbManager 完成云端同步（onConfigChange 触发重试）后再调用 getTierService()。'
        )
      }

      this.queries = new UserTierQueries(supabase, tierConstants, schema)
      this.tierService = new TierService(this.queries, tierConstants)
    }
    return this.tierService
  }

  private getUnconfirmedProfilePlaceholder(): UserTierProfile {
    return {
      tier: 'free' as any,
      firecores: 0,
      ref_code: '',
      entitlements: [],
      counters: {} as any,
      computed_limits: {
        can_offline: false
      } as any,
      subscription: undefined
    }
  }

  getCachedData(): UserTierData | null {
    if (!this.encryptionKey || !this.hmacKey) {
      return null
    }
    try {
      return this.getDataManager().getData()
    } catch {
      return null
    }
  }

  async getProfile(): Promise<UserTierProfile> {
    await databaseService.ensureInitialized()
    if (!this.encryptionKey || !this.hmacKey || !this.getTierConstants()?.tierLimits) {
      return this.getUnconfirmedProfilePlaceholder()
    }
    try {
      const data = this.getDataManager().getData()
      return {
        tier: data.tier,
        firecores: data.firecores,
        ref_code: data.ref_code,
        entitlements: data.entitlements,
        counters: data.counters,
        computed_limits: data.computed_limits,
        subscription: data.subscription
      }
    } catch {
      return this.getUnconfirmedProfilePlaceholder()
    }
  }

  async getUserTierData(): Promise<UserTierData> {
    await databaseService.ensureInitialized()
    await this.ensureKeysIfConfirmed()
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

    logger.debug(
      LogCategory.SYSTEM,
      '[DEBUG-SPEND]spendFirecores 入口: type=%s, firecores=%d, txId=%s',
      type,
      firecores,
      txId
    )

    const tierConstants = this.getTierConstants()
    const isCloudFirst = tierConstants.firecoreCloudFirstConfirm?.[type] === true

    // 防重键在确定性拒绝时立即释放，避免 5 秒内重试被误判为「操作已完成」
    const releaseDedup = () => this.recentSpendTxIds.delete(dedupKey)

    if (isCloudFirst && this.getDataManager().isOnline()) {
      try {
        logger.debug(LogCategory.SYSTEM, '[DEBUG-SPEND]云优先路径: 调用RPC, txId=%s', txId)
        const result = await this.getTierService().spendFirecores(machineId, {
          type,
          id: txId,
          metadata: { ...metadata, workspaceId: scope }
        })
        logger.debug(
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
            releaseDedup()
            return localResult
          }
          const db = databaseService.db
          if (db) {
            db.prepare(
              `UPDATE pending_firecore_operations SET status = 'completed', updated_at = ? WHERE id = ?`
            ).run(Date.now(), txId)
            logger.debug(
              LogCategory.SYSTEM,
              '[DEBUG-SPEND]云优先路径: pending已更新为completed, txId=%s',
              txId
            )
          }
          this.syncLocalCacheAndNotify(machineId).catch(err => {
            logger.error(LogCategory.SYSTEM, '[UserTierService] 后台同步失败:', err)
          })
          return { success: true }
        }
        if (result.errorCode) {
          // 确定性业务拒绝（INSUFFICIENT_FIRECORES / ACCOUNT_LOCKED 等）：
          // 不入离线队列、不重试，本地回滚置终态，明确返回失败。
          logger.warn(
            LogCategory.SYSTEM,
            '[DEBUG-SPEND]云端业务拒绝(%s)，不入队并回滚本地, txId=%s: %s',
            result.errorCode,
            txId,
            result.message
          )
          await this.rollbackLocal(txId)
          releaseDedup()
          return { success: false, message: result.message || t('云端执行失败') }
        }
        // 云端响应失败但无 errorCode：传输层瞬态，按原 txId 入队并允许立即二次上报
        logger.warn(
          LogCategory.SYSTEM,
          '[DEBUG-SPEND]云端瞬态失败（无 errorCode），转离线入队, txId=%s: %s',
          txId,
          result.message
        )
      } catch (error) {
        // 错误三分类：超时(结果未知)/明确未送达一律保留原 txId 入 pending，绝不新建 UUID；
        // 结果未知场景不立即二次上报，交 replayOfflineQueue 幂等重放（云端按 p_client_op_id 去重）。
        const category = this.classifyNetworkError(error)
        logger.warn(
          LogCategory.SYSTEM,
          'spendFirecores 云优先上报异常(%s)，原 txId 入 pending, txId=%s:',
          category,
          txId,
          error
        )
        const queued = await this.enqueueOfflineSpend({
          firecores,
          type,
          metadata,
          txId,
          machineId,
          scope,
          immediateReport: false
        })
        if (!queued.success) releaseDedup()
        return queued
      }
    }

    // 本地优先 / 离线路径：始终复用方法开头生成的原 txId，绝不新建 UUID。
    const queued = await this.enqueueOfflineSpend({
      firecores,
      type,
      metadata,
      txId,
      machineId,
      scope,
      immediateReport: true
    })
    if (!queued.success) releaseDedup()
    return queued
  }

  async rollbackLocal(operationId: string): Promise<void> {
    await this.getDataManager().rollbackLocal(operationId)
  }

  hasPendingOperations(): boolean {
    return this.getDataManager().hasPendingOperations()
  }

  async syncToCache(machineId: string): Promise<void> {
    logger.debug(LogCategory.SYSTEM, '[DEBUG-SYNC] syncToCache 被调用: machineId=%s', machineId)
    await this.getDataManager().trySync()
  }

  async getConsumptionDetails(): Promise<any[]> {
    const machineId = SystemIdentityService.getInstance().getMachineId()

    // 阶段一：立即返回本地数据库的流水记录
    const locals = this.getDataManager().getLocalPendingRecords()

    if (locals.length > 0) {
      // 阶段二：本地有记录则立即返回（零白屏），云端补齐交给后台单次异步拉取
      this.fetchCloudTransactionsInBackground(machineId, false)
      return locals
    }

    // 本地无记录：只走一次阻塞拉取（云端为流水 SSOT），
    // 严禁再并发触发后台第二次请求——否则同一份流水会被推送两次，弹窗列表反复重绘表现为闪动
    return this.fetchAndPushCloudTransactions(machineId)
  }

  public async ensureKeysIfConfirmed(): Promise<boolean> {
    const { LicenseService } = await import('../system/license-service')
    if (!LicenseService.getInstance().isLicenseConfirmed()) {
      return false
    }
    await this.ensureKeys()
    return Boolean(this.encryptionKey && this.hmacKey)
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

  /**
   * 传输层错误三分类（严禁按中文 message 匹配，只读结构化 code / name / HTTP status）：
   * - timeout：请求已发出、结果未知（超时 / 连接中断 / 管道破裂）。必须保留原 txId 入 pending，
   *   绝不新建 UUID 重复扣减，交 replayOfflineQueue 幂等重放；
   * - offline：明确未送达（DNS 失败 / 连接拒绝 / 网关 502/503/504），同样原 txId 入 pending 乐观放行；
   * - unknown：其余异常，按「结果未知」保守处理，不立即二次上报。
   */
  private classifyNetworkError(err: any): 'timeout' | 'offline' | 'unknown' {
    const code = String(err?.code ?? err?.name ?? '').toUpperCase()
    const status = Number(err?.status ?? err?.response?.status ?? err?.statusCode ?? 0)
    if (
      code === 'ETIMEDOUT' ||
      code === 'ABORTERROR' ||
      code === 'ECONNRESET' ||
      code === 'EPIPE'
    ) {
      return 'timeout'
    }
    if (
      code === 'ENOTFOUND' ||
      code === 'ECONNREFUSED' ||
      code === 'EAI_AGAIN' ||
      status === 502 ||
      status === 503 ||
      status === 504
    ) {
      return 'offline'
    }
    return 'unknown'
  }

  /**
   * 离线乐观入队：以原 txId 走 core-engine spendFirecoresLocal 写入 pending（amount_delta<0），
   * 严禁在 desktop 侧另写 INSERT 绕过 core-engine。
   * - immediateReport=true：联网时以同一 txId 立即二次上报（云端按 p_client_op_id 幂等去重）；
   * - immediateReport=false：结果未知（超时/断网）场景不立即重发，保留 pending 交回放链。
   */
  private async enqueueOfflineSpend(params: {
    firecores: number
    type: FirecoreOperationType
    metadata?: Record<string, any>
    txId: string
    machineId: string
    scope: number | null
    immediateReport: boolean
  }): Promise<{ success: boolean; message?: string }> {
    const { firecores, type, metadata, txId, machineId, scope, immediateReport } = params
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
    logger.info(LogCategory.SYSTEM, '[DEBUG-SPEND]本地扣减成功，已入 pending, txId=%s', txId)

    if (!immediateReport || !this.getDataManager().isOnline()) {
      // 离线或结果未知：pending 保留，乐观放行，不阻塞分析/整理操作
      return { success: true }
    }

    try {
      const result = await this.getTierService().spendFirecores(machineId, {
        type,
        id: txId,
        metadata: { ...metadata, workspaceId: scope }
      })
      if (result.success) {
        const db = databaseService.db
        if (db) {
          db.prepare(
            `UPDATE pending_firecore_operations SET status = 'completed', updated_at = ? WHERE id = ?`
          ).run(Date.now(), txId)
          logger.info(LogCategory.SYSTEM, '[DEBUG-SPEND]pending已更新为completed, txId=%s', txId)
        }
        this.syncLocalCacheAndNotify(machineId).catch(err => {
          logger.error(LogCategory.SYSTEM, '[UserTierService] 后台同步失败:', err)
        })
        return { success: true }
      }
      if (result.errorCode) {
        // 确定性业务拒绝：不入离线队列，本地回滚置终态，明确返回失败
        logger.warn(
          LogCategory.SYSTEM,
          '[DEBUG-SPEND]云端业务拒绝(%s)，回滚本地: %s',
          result.errorCode,
          result.message
        )
        await this.rollbackLocal(txId)
        return { success: false, message: result.message || t('云端执行失败') }
      }
      // 无 errorCode：传输层瞬态，pending 保留，乐观放行等待回放
      logger.warn(
        LogCategory.SYSTEM,
        '[DEBUG-SPEND]云端瞬态失败（无 errorCode），保留 pending, txId=%s: %s',
        txId,
        result.message
      )
      return { success: true }
    } catch (error) {
      // 二次上报网络异常：分类上报日志，pending 保留交 replayOfflineQueue 幂等重放
      const category = this.classifyNetworkError(error)
      logger.warn(
        LogCategory.SYSTEM,
        '[DEBUG-SPEND]二次上报网络异常(%s)，保留 pending, txId=%s:',
        category,
        txId,
        error
      )
      return { success: true }
    }
  }

  /**
   * 归一化云端流水展示类型：
   * V4 账本 firecore_transactions.transaction_type 受 CHECK 约束固定写入大类
   * （如 'consume' / 'exchange'），具体消费动作存在 metadata.action_type 中。
   * 展示层优先取 metadata.action_type，与本地 pending_firecore_operations.operation_type 对齐。
   */
  private mapCloudTransactionToDisplayItem(tx: any) {
    const actionType =
      typeof tx?.metadata?.action_type === 'string' ? tx.metadata.action_type.trim() : ''
    const displayType =
      actionType && (tx.transaction_type === 'consume' || tx.transaction_type === 'exchange')
        ? actionType
        : tx.transaction_type

    return {
      id: tx.id,
      type: displayType,
      firecores: tx.firecores,
      balance_after: tx.balance_after,
      status: 'completed',
      time: tx.created_at,
      metadata: tx.metadata || null
    }
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
      const locals = this.getDataManager().getLocalPendingRecords()
      return this.mergeCloudWithLocals(
        cloudData.map(tx => this.mapCloudTransactionToDisplayItem(tx)),
        locals
      )
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
    // 并发去重：「查流水」与「等级云端同步」会同时触发本方法，
    // 重复拉取会把同一份流水向渲染层推送两次，列表随之反复重绘（用户感知为闪动）
    if (this.cloudTransactionsInFlight) return this.cloudTransactionsInFlight

    const task = (async () => {
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
          result = this.mergeCloudWithLocals(
            cloudData.map(tx => this.mapCloudTransactionToDisplayItem(tx)),
            this.getDataManager().getLocalPendingRecords()
          )
        }
        this.notifyFirecoreTransactionsUpdated(result)
      } catch (error) {
        // 后台获取云端数据失败：本地数据已展示，但严禁静默吞掉，须显式上报便于排查
        logger.warn(
          LogCategory.SYSTEM,
          '[UserTierService] 后台拉取云端流水失败，保留本地展示:',
          error
        )
      } finally {
        this.cloudTransactionsInFlight = null
      }
    })()

    this.cloudTransactionsInFlight = task
    return task
  }

  /**
   * 云端流水与本地记录的合并策略（展示层）：
   * 云端为流水 SSOT，但端侧收入类流水（welcome_grant 等）按设计不由端侧上报
   * （见 UserTierDataManager.replayOfflineQueue 的云端 SSOT 注释），云端可能长期没有其镜像。
   * 合并时保留云端全量，并追加「云端缺失类型的本地收入记录」，
   * 防止云同步整体覆盖后，本地专属收入（如欢迎赠送）从流水中凭空消失。
   * 同类型已被云端覆盖的本地记录（如云端已镜像的 invitation_receive）与
   * id 重复的记录均不再追加，避免展示层重复。
   */
  private mergeCloudWithLocals(cloudData: any[], locals: any[]): any[] {
    const cloudTypes = new Set(cloudData.map(tx => tx.type))
    const cloudIds = new Set(cloudData.map(tx => tx.id))
    const incomeTypes = new Set([
      'welcome_grant',
      'invitation_earn',
      'invitation_receive',
      'upload_earn',
      'admin_adjust'
    ])
    const localOnly = locals.filter(
      l => incomeTypes.has(l.type) && !cloudTypes.has(l.type) && !cloudIds.has(l.id)
    )
    return [...cloudData, ...localOnly]
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
    this.verifiedOfflineLicense = null
    this.recentSpendTxIds.clear()
    this.cloudTransactionsInFlight = null
    logger.info(LogCategory.SYSTEM, 'UserTierService services reloaded')
  }

  /**
   * 探测本机是否存在有效且未过期的物理机离线授权，写入内存仲裁基线。
   * 仅对显式离线证书类型（ENTERPRISE / ENTERPRISE_OFFLINE / PRO）生效，ONLINE 授权不计入。
   */
  private async refreshVerifiedOfflineLicense(): Promise<void> {
    try {
      const { LicenseService, LicenseStatus } = await import('../system/license-service')
      const licenseStatus = await LicenseService.getInstance().checkLicenseStatus()
      if (
        licenseStatus.status === LicenseStatus.AUTHORIZED &&
        (licenseStatus.type === 'ENTERPRISE' ||
          licenseStatus.type === 'ENTERPRISE_OFFLINE' ||
          licenseStatus.type === 'PRO')
      ) {
        const tier = licenseStatus.type === 'PRO' ? UserTier.PRO : UserTier.ENTERPRISE
        this.verifiedOfflineLicense = {
          valid: true,
          tier,
          expires_at: licenseStatus.expiry ?? null,
          plan_id: tier
        }
      } else {
        this.verifiedOfflineLicense = null
      }
    } catch {
      // 单测 mock 或授权服务未就绪时不覆写已有 verifiedOfflineLicense
    }
  }

  /**
   * 从离线授权码中恢复 userTierData，重置密钥缓存并重新计算 computed_limits。
   *
   * 调用前需确保 CACHE_KEY_DATA 已更新（由 LicenseService.writeEmbeddedUserTierData / activate 写入），
   * 本方法内部通过 ensureKeys 从新 CACHE_KEY_DATA 重新派生密钥，直接权威落盘并立即广播更新事件。
   *
   * @param data  离线授权码中嵌入或构造的 userTierData
   * @param _machineId  机器标识
   */
  async restoreFromLicenseData(data: UserTierData, _machineId: string): Promise<void> {
    const effectiveData = UserTierDataManager.ensureNotExpired(data)
    if (effectiveData.tier !== UserTier.FREE) {
      this.verifiedOfflineLicense = {
        valid: true,
        tier: effectiveData.tier,
        expires_at: effectiveData.subscription?.expires_at ?? null,
        plan_id: effectiveData.subscription?.plan_id || effectiveData.tier
      }
    } else {
      this.verifiedOfflineLicense = null
    }

    // 1. 清除密钥缓存，后续 ensureKeys 从新 CACHE_KEY_DATA 重新派生
    this.encryptionKey = null
    this.hmacKey = null
    await this.ensureKeys()

    // 2. 重置 UserTierDataManager 实例，强制重建时使用新密钥并保留未消费的已有本地数据
    UserTierDataManager.resetInstance()
    this.dataManager = null

    // 3. 创建新 DataManager 并权威落盘离线授权数据（绕过云端 version<=1 拦截并立即通知前端）
    const manager = this.getDataManager()
    await manager.applyAuthoritativeOfflineData(effectiveData)
  }

  async initialize(): Promise<void> {
    await databaseService.ensureInitialized()
    if (!databaseService.db) {
      logger.debug(
        LogCategory.SYSTEM,
        '[UserTierService] 数据库未初始化 (语言未确认)，暂缓 UserTierService 数据库加载'
      )
      return
    }

    const initProcess = async () => {
      logger.debug(
        LogCategory.SYSTEM,
        '[UserTierService] net modules keys:',
        Object.keys(net),
        'isOnline type:',
        typeof net.isOnline
      )
      const machineId = await SystemIdentityService.getInstance().getMachineId()
      logger.debug(
        LogCategory.SYSTEM,
        '[UserTierService] 绑定监听（状态跃迁驱动）, machineId:',
        machineId
      )
      await this.refreshVerifiedOfflineLicense()

      const { LicenseService } = await import('../system/license-service')
      const licenseService = LicenseService.getInstance()

      const activateOnConfirmed = async () => {
        // 离线授权文件模式免等 cloudReady，避免离线用户或初始化串行链死锁
        const localCached = (licenseService as any).cachedResult
        if (localCached?.source !== 'offline_file') {
          try {
            const { gate } = await import('../../main/startup-gates')
            await gate('cloudReady')
          } catch {}
        }
        try {
          await this.ensureKeys()
        } catch (e) {
          logger.warn(LogCategory.SYSTEM, '[UserTierService] 状态跃迁密钥派生失败:', e)
          return
        }
        if (this.getTierConstants()?.tierLimits) {
          this.getDataManager()
          this.notifyProfileChanged()
          await this.syncLocalCacheAndNotify(machineId).catch(err => {
            logger.error(LogCategory.SYSTEM, '[UserTierService] 授权确认后云端同步失败:', err)
          })
        }
      }

      licenseService.onLicenseConfirmed(activateOnConfirmed)

      this.configCleanup = ConfigOrchestrator.getInstance().onConfigChange(changes => {
        if (!licenseService.isLicenseConfirmed()) {
          return
        }
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

        // TIER_CONSTANTS 是云端 SSOT（异步下行）。启动早期未就绪时 getTierService()
        // 会抛出明确错误（而非冻结 undefined 进单例）。此处监听其首次就绪，
        // 重置已构造的 tierService/dataManager 单例，确保后续同步使用权威常量。
        if ('TIER_CONSTANTS' in changes) {
          const tc = this.getTierConstants()
          if (tc && tc.tierLimits && this.encryptionKey && this.hmacKey) {
            logger.info(
              LogCategory.SYSTEM,
              '[UserTierService] TIER_CONSTANTS 已就绪，重置 tier 服务单例并重新同步'
            )
            this.tierService = null
            this.queries = null
            UserTierDataManager.resetInstance()
            this.dataManager = null
            this.syncLocalCacheAndNotify(SystemIdentityService.getInstance().getMachineId()).catch(
              err => {
                logger.error(
                  LogCategory.SYSTEM,
                  '[UserTierService] TIER_CONSTANTS 就绪后同步失败:',
                  err
                )
              }
            )
          }
        }
      })

      // 仅当授权已确认（如离线文件授权或测试环境）且常量就绪时才非阻塞激活，避免阻塞 Deferred 前置链
      if (licenseService.isLicenseConfirmed()) {
        void activateOnConfirmed().catch(err => {
          logger.warn(LogCategory.SYSTEM, '[UserTierService] 初始授权激活异常:', err)
        })
      }
    }

    if (app.isReady()) {
      await initProcess()
    } else {
      await app.whenReady()
      await initProcess()
    }
  }

  async syncLocalCacheAndNotify(machineId: string): Promise<void> {
    logger.debug(
      LogCategory.SYSTEM,
      '[UserTierService] syncLocalCacheAndNotify 开始, machineId:',
      machineId
    )
    await this.refreshVerifiedOfflineLicense()
    try {
      // 先确保密钥已派生（可能被 activate 清空后需从新写入的 CACHE_KEY_DATA 重新派生）
      await this.ensureKeys()
    } catch (e) {
      logger.warn(LogCategory.SYSTEM, '[UserTierService] 密钥派生失败，降级进行同步:', e)
    }
    try {
      // 重置并重建 DataManager，确保从最新密钥、离线授权基线及最新加密缓存加载
      UserTierDataManager.resetInstance()
      this.dataManager = null
      await this.getDataManager().trySync()
    } catch (e) {
      logger.error(LogCategory.SYSTEM, 'syncLocalCacheAndNotify failed', e)
    }
    this.notifyProfileChanged()
    // 会员等级/权益变化驱动 contextEpoch 递增，触发工作区有效能力重算
    emitRuntimeContextChange('user_tier_changed')

    // 启动时异步拉取云端流水记录，确保余额变更（如邀请赠送）能及时反映
    this.fetchCloudTransactionsInBackground(machineId, false).catch(err => {
      logger.error(LogCategory.SYSTEM, '[UserTierService] 启动时流水同步失败:', err)
    })

    // 同步后检测等级是否降级到免费/过期，通知前端触发授权弹层
    const currentData = this.getDataManager().getData()
    if (currentData.tier !== UserTier.FREE) {
      // 用户具备 Pro/VIP 权益，异步唤醒待续作长视频切片重新入队 (ISS-60)
      import('../analysis-queue-service')
        .then(({ analysisQueueService }) => {
          analysisQueueService.requeueIncompleteVideos().catch(err => {
            logger.warn(LogCategory.ANALYSIS_QUEUE, '[UserTierService] 唤醒待续作长视频失败:', err)
          })
        })
        .catch(() => {})
    }
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
