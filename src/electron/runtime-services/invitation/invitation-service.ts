import { INFINITY, LogCategory, logger, getSharedSchemaName } from '@firefly/shared'
import { ipcMain } from 'electron'
import { SystemIdentityService } from '../system/system-identity-service'
import { userTierService } from '../user-tier/user-tier-service'
import { UserTier, ComputedLimits, UserTierData } from '@firefly/types'
import { ConfigOrchestrator } from '@app/electron/config/config-orchestrator'
import { t } from '@app/languages'
import crypto from 'crypto'

class InvitationService {
  private getSharedSchemaName(): string {
    return getSharedSchemaName()
  }

  /**
   * 获取邀请统计及总配额 (增加重试机制)
   */
  async getInvitationQuota() {
    // 0. 优先检查企业授权（通过 can_offline 门控判断）
    try {
      const tierData = userTierService.getCachedData()
      if (tierData?.computed_limits?.can_offline === true) {
        logger.info(LogCategory.AI_SERVICE, '[Invitation] 检测到企业授权，直接开通无限额度')
        return { count: 3, isInvited: true, quota: INFINITY }
      }
    } catch (e) {
      logger.error(LogCategory.AI_SERVICE, '[Invitation] 检查企业授权失败:', e)
    }

    const MAX_RETRIES = 3
    let lastError: any = null

    for (let i = 0; i < MAX_RETRIES; i++) {
      try {
        const id = SystemIdentityService.getInstance().getMachineId()
        const { RemoteConfigService } = await import('../system/remote-config-service')
        const supabase = RemoteConfigService.getInstance().getSupabaseClient()

        if (!supabase) {
          throw new Error('Supabase client not initialized')
        }

        const sharedSchema = this.getSharedSchemaName()
        const { data, error } = await supabase
          .schema(sharedSchema)
          .from('machines')
          .select('user_tier_data, invitation_count')
          .eq('machine_id', id)
          .maybeSingle()

        if (error) throw error

        const tierData = data?.user_tier_data as UserTierData
        let count = tierData?.counters?.invitation_count ?? (data as any)?.invitation_count ?? 0
        let isInvited = !!tierData?.counters?.is_invited

        // 如果 count 仍然是 0，通过 invitations 关联表查询匹配记录数做最终兜底 (兼容老用户首次升级但 machines 表数据未刷新)
        if (count === 0) {
          const { count: matchedCount, error: countError } = await supabase
            .schema(sharedSchema)
            .from('invitations')
            .select('*', { count: 'exact', head: true })
            .eq('inviter_id', id)
            .eq('status', 'matched')

          if (!countError && matchedCount != null) {
            count = matchedCount
          }
        }

        // 检查被邀请人标记的兜底
        if (!isInvited) {
          const { count: inviteeCount, error: inviteeError } = await supabase
            .schema(sharedSchema)
            .from('invitations')
            .select('*', { count: 'exact', head: true })
            .eq('invitee_id', id)
            .eq('status', 'matched')

          if (!inviteeError && inviteeCount != null && inviteeCount > 0) {
            isInvited = true
          }
        }

        const tierConstants = ConfigOrchestrator.getInstance().getTierConstants()
        if (!tierConstants) {
          // TIER_CONSTANTS 未加载时使用默认值（测试环境下常见，因 JSON 配置加载可能延迟）
          logger.warn(LogCategory.INVITATION, '[Invitation] TIER_CONSTANTS 未加载，使用默认配额')
          const fallbackQuota = tierData?.computed_limits?.analysis_quota_total || 50
          return { count, isInvited, quota: fallbackQuota + count * 25 }
        }

        const quota =
          tierData?.computed_limits?.analysis_quota_total ||
          tierConstants.freeBaseQuota + count * tierConstants.inviteQuotaBonus

        // 接口成功，同步到本地缓存
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
    if (!tierConstants) {
      throw new Error(
        '[Invitation] TIER_CONSTANTS 未加载，配置数据可能未正确初始化，请检查数据库迁移和 ConfigDbManager 初始化流程'
      )
    }
    const quota = cache?.quota || tierConstants.freeBaseQuota

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
    ipcMain.handle('invitation/match', async (_, features) => {
      try {
        const id = SystemIdentityService.getInstance().getMachineId()

        logger.info(LogCategory.AI_SERVICE, '[Invitation] 收到匹配请求', {
          machineId: id,
          featuresType: typeof features,
          hasVisitorId: !!features?.visitorId,
          featuresPreview: features ? JSON.stringify(features).substring(0, 200) : 'null/undefined'
        })

        const { RemoteConfigService } = await import('../system/remote-config-service')
        const supabase = RemoteConfigService.getInstance().getSupabaseClient()

        if (!supabase) {
          logger.error(LogCategory.AI_SERVICE, '[Invitation] Supabase client not initialized')
          return { success: false, error: 'Network service not available' }
        }

        // 验证 features 参数
        if (!features || typeof features !== 'object') {
          logger.error(LogCategory.AI_SERVICE, '[Invitation] 无效的 features 参数:', features)
          return { success: false, error: 'Invalid features parameter' }
        }

        // Call Supabase RPC
        const sharedSchema = this.getSharedSchemaName()
        const { data, error } = await supabase.schema(sharedSchema).rpc('match_invitation', {
          p_machine_id: id,
          p_app_features: features
        })

        if (error) {
          logger.error(LogCategory.AI_SERVICE, '[Invitation] match_invitation RPC 调用失败', error)
          return { success: false, error: error.message }
        }

        logger.info(LogCategory.AI_SERVICE, '[Invitation] match_invitation RPC 调用成功', data)

        // 邀请成功后，RPC 已处理奖励（firecores + 权益），客户端仅需同步缓存
        if (data && data.success && data.inviter_machine_id) {
          try {
            await userTierService.syncToCache(SystemIdentityService.getInstance().getMachineId())
          } catch (e) {
            logger.warn(LogCategory.AI_SERVICE, '[Invitation] 同步本地缓存失败:', e)
          }
        }

        return data
      } catch (error: any) {
        logger.error(LogCategory.AI_SERVICE, '[Invitation] 匹配过程发生异常', error)
        return { success: false, error: error.message }
      }
    })

    ipcMain.handle('invitation/get-count', async () => {
      return await this.getInvitationQuota()
    })

    ipcMain.handle('invitation/redeem', async (_, inviterRef: string) => {
      try {
        const id = SystemIdentityService.getInstance().getMachineId()
        const { RemoteConfigService } = await import('../system/remote-config-service')
        const supabase = RemoteConfigService.getInstance().getSupabaseClient()

        if (!supabase) throw new Error('Network service not available')

        const sharedSchema = this.getSharedSchemaName()
        const { data, error } = await supabase.schema(sharedSchema).rpc('redeem_invitation_code', {
          p_machine_id: id,
          p_inviter_ref: inviterRef
        })

        if (error) throw error

        if (data && data.success === false) {
          return { success: false, error: data.message || 'Unknown error' }
        }

        // 手动兑换成功后，RPC 已处理奖励（firecores + 权益），客户端仅需同步缓存
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
