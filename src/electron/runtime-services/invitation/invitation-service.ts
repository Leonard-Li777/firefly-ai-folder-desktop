import { INFINITY, LogCategory, logger, getSharedSchemaName } from '@firefly/shared'
import { ipcMain } from 'electron'
import { SystemIdentityService } from '../system/system-identity-service'
import { userTierService } from '../user-tier/user-tier-service'
import { UserTierData } from '@firefly/types'
import { ConfigOrchestrator } from '../../config/config-orchestrator'
import { t } from '../../../languages'

class InvitationService {
  private getSharedSchemaName(): string {
    return getSharedSchemaName()
  }

  /**
   * 获取邀请统计及总配额 (增加重试机制，从 userTierService 缓存或云端同步)
   */
  async getInvitationQuota() {
    // 0. 优先检查企业授权（通过 can_offline 门控判断）
    try {
      const tierData = userTierService.getCachedData()
      if (
        tierData?.computed_limits?.can_offline === true ||
        tierData?.computed_limits?.has_unlimited_analysis === true
      ) {
        logger.info(LogCategory.AI_SERVICE, '[Invitation] 检测到无限分析权限，直接开通无限额度')
        return {
          count: tierData?.counters?.invitation_count ?? 4,
          isInvited: true,
          quota: INFINITY
        }
      }
    } catch (e) {
      logger.error(LogCategory.AI_SERVICE, '[Invitation] 检查企业授权失败:', e)
    }

    const MAX_RETRIES = 3
    let lastError: any = null

    for (let i = 0; i < MAX_RETRIES; i++) {
      try {
        const id = SystemIdentityService.getInstance().getMachineId()
        const tierData = userTierService.getCachedData()

        const count = tierData?.counters?.invitation_count ?? 0
        const isInvited = !!tierData?.counters?.is_invited

        const tierConstants = ConfigOrchestrator.getInstance().getTierConstants()
        if (!tierConstants) {
          logger.warn(LogCategory.INVITATION, '[Invitation] TIER_CONSTANTS 未加载，使用默认配额')
          const fallbackQuota = tierData?.computed_limits?.analysis_quota_total || 500
          return { count, isInvited, quota: fallbackQuota }
        }

        const quota =
          tierData?.computed_limits?.analysis_quota_total ||
          tierConstants.freeBaseQuota + count * tierConstants.inviteQuotaBonus

        // 同步到本地缓存
        ConfigOrchestrator.getInstance().updateValue('INVITATION_CACHE_DATA', {
          invitationCount: count,
          isInvited: isInvited,
          quota: quota,
          lastUpdatedAt: new Date().toISOString()
        })

        return { count, isInvited, quota }
      } catch (error: any) {
        lastError = error
        const isNetworkError =
          error.message?.includes('fetch failed') || error.message?.includes('timeout')

        if (isNetworkError && i < MAX_RETRIES - 1) {
          const waitTime = 1000 * (i + 1)
          logger.warn(
            LogCategory.AI_SERVICE,
            `[Invitation] Fetch quota attempt ${i + 1} failed, retrying in ${waitTime}ms...`
          )
          await new Promise(resolve => setTimeout(resolve, waitTime))
          continue
        }
        break
      }
    }

    // 最终失败，回滚使用本地缓存
    logger.error(
      LogCategory.AI_SERVICE,
      '[Invitation] Failed to fetch quota after retries, rolling back to cache:',
      lastError?.message
    )
    const cache = ConfigOrchestrator.getInstance().getValue<any>('INVITATION_CACHE_DATA')
    const count = cache?.invitationCount || 0
    const isInvited = !!cache?.isInvited
    const tierConstants = ConfigOrchestrator.getInstance().getTierConstants()
    const quota = cache?.quota || tierConstants?.freeBaseQuota || 500

    return {
      count,
      isInvited,
      quota,
      isFromCache: true
    }
  }

  /**
   * 检查配额限制
   * @returns 如果超出配额则抛出错误
   */
  async checkQuotaLimit(): Promise<void> {
    // 1. 获取实时配额信息
    const { count, isInvited, quota } = await this.getInvitationQuota()

    if (quota === INFINITY) {
      return
    }

    // 3. 统计已分析数量 (基于全局私有工作区唯一指纹)
    const { virtualDirectoryService } =
      await import('../filesystem/virtual-directory-service/index')
    const analyzedCount = await virtualDirectoryService.getAnalyzedFilesCount()

    logger.info(
      LogCategory.ANALYSIS_QUEUE,
      `[配额检查] 当前已分析私有目录唯一文件总数：${analyzedCount}, 配额限制：${quota}, 已邀请：${count}, 被邀请：${isInvited}`
    )

    // 4. 检查是否超出配额
    if (analyzedCount >= quota) {
      throw new Error(
        t(
          '配额已用尽：已分析 {count} 个私有目录文件，当前配额为 {quota} 个文件。可以通过邀请好友解锁更多额度。',
          { count: analyzedCount, quota: quota }
        )
      )
    }
  }

  private ipcRegistered = false

  async initialize() {
    if (this.ipcRegistered) return
    this.ipcRegistered = true

    ipcMain.handle('invitation/get-count', async () => {
      return await this.getInvitationQuota()
    })

    // 基于统一 UserId 的好友邀请兑换
    ipcMain.handle('invitation/redeem', async (_, inviterRef: string) => {
      try {
        const id = SystemIdentityService.getInstance().getMachineId()
        const { RemoteConfigService } = await import('../system/remote-config-service')
        const supabase = RemoteConfigService.getInstance().getSupabaseClient()

        if (!supabase) throw new Error('Network service not available')

        const sharedSchema = this.getSharedSchemaName()
        const { data, error } = await supabase
          .schema(sharedSchema)
          .rpc('rpc_redeem_user_invitation_code', {
            p_invitation_code: inviterRef?.trim()
          })

        if (error) throw error

        if (data && data.success === false) {
          return { success: false, error: data.message || data.error || 'Unknown error' }
        }

        // 手动兑换成功后，云端已处理奖励，客户端立即同步缓存
        if (data && data.success) {
          try {
            await userTierService.syncToCache(SystemIdentityService.getInstance().getMachineId())
          } catch (e) {
            logger.warn(LogCategory.AI_SERVICE, '[Invitation] 同步本地缓存失败:', e)
          }
        }

        return data
      } catch (error: any) {
        logger.error(LogCategory.AI_SERVICE, 'Manual redemption failed', error)
        return { success: false, error: error.message }
      }
    })
  }
}

export const invitationService = new InvitationService()
