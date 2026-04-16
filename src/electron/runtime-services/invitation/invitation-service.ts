import { LogCategory, logger, calculateQuota } from '@yonuc/shared'
import { ipcMain } from 'electron'
import { machineId } from 'node-machine-id'
import { configService } from '../config'
import { t } from '@app/languages'

class InvitationService {
  /**
   * 获取邀请统计及总配额 (增加重试机制)
   */
  async getInvitationQuota() {
    const MAX_RETRIES = 3;
    let lastError: any = null;

    for (let i = 0; i < MAX_RETRIES; i++) {
      try {
        const id = await machineId()
        const { RemoteConfigService } = await import('../system/remote-config-service');
        const supabase = RemoteConfigService.getInstance().getSupabaseClient();

        if (!supabase) {
          throw new Error('Supabase client not initialized');
        }

        const { data, error } = await supabase
          .from('machines')
          .select('invitation_count, is_invited')
          .eq('machine_id', id)
          .single()
        
        if (error) throw error;
        
        const count = data?.invitation_count || 0;
        const isInvited = !!data?.is_invited;

        // 接口成功，同步到本地缓存
        configService.updateValue('INVITATION_CACHE_DATA', {
          invitationCount: count,
          isInvited: isInvited,
          lastUpdatedAt: new Date().toISOString()
        });

        const quota = calculateQuota(count, isInvited);
        return { count, isInvited, quota };
      } catch (error: any) {
        lastError = error;
        const isNetworkError = error.message?.includes('fetch failed') || error.message?.includes('timeout');
        
        if (isNetworkError && i < MAX_RETRIES - 1) {
          const waitTime = 1000 * (i + 1);
          logger.warn(LogCategory.AI_SERVICE, `[Invitation] Fetch quota attempt ${i + 1} failed, retrying in ${waitTime}ms...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          continue;
        }
        break;
      }
    }

    // 最终失败，回滚使用本地缓存
    logger.error(LogCategory.AI_SERVICE, '[Invitation] Failed to fetch quota after retries, rolling back to cache:', lastError?.message)
    const cache = configService.getValue<any>('INVITATION_CACHE_DATA')
    const count = cache?.invitationCount || 0
    const isInvited = !!cache?.isInvited
    const quota = calculateQuota(count, isInvited)
    
    return { 
      count, 
      isInvited, 
      quota,
      isFromCache: true 
    };
  }

  /**
   * 检查配额限制
   * @returns 如果超出配额则抛出错误
   */
  async checkQuotaLimit(): Promise<void> {
    // 1. 检查是否已解锁无限额度
    const isUnlocked = configService.getValue<boolean>('IS_PRIVATE_DIRECTORY_UNLOCKED')
    logger.info(LogCategory.ANALYSIS_QUEUE, `[配额检查] 是否已解锁无限额度: ${isUnlocked}`)
    if (isUnlocked) {
      return
    }

    // 2. 获取实时配额信息
    const { count, isInvited, quota } = await this.getInvitationQuota();

    if (quota === Infinity) {
      return
    }
    
    // 3. 统计已分析数量 (基于全局私有工作区唯一指纹)
    const { virtualDirectoryService } = await import('../filesystem/virtual-directory-service')
    const analyzedCount = await virtualDirectoryService.getAnalyzedFilesCount()
    
    logger.info(LogCategory.ANALYSIS_QUEUE, `[配额检查] 当前已分析私有目录唯一文件总数：${analyzedCount}, 配额限制：${quota}, 已邀请：${count}, 被邀请：${isInvited}`)
    
    // 4. 检查是否超出配额
    if (analyzedCount >= quota) {
      throw new Error(t('配额已用尽：已分析 {count} 个私有目录文件，当前配额为 {quota} 个文件。可以通过邀请好友解锁更多额度。', { count: analyzedCount, quota: quota }))
    }
  }

  async initialize() {
    ipcMain.handle('invitation/match', async (_, features) => {
      try {
        const id = await machineId()
        
        logger.info(LogCategory.AI_SERVICE, '[Invitation] 收到匹配请求', {
          machineId: id,
          featuresType: typeof features,
          hasVisitorId: !!(features?.visitorId),
          featuresPreview: features ? JSON.stringify(features).substring(0, 200) : 'null/undefined'
        });
        
        const { RemoteConfigService } = await import('../system/remote-config-service');
        const supabase = RemoteConfigService.getInstance().getSupabaseClient();

        if (!supabase) {
            logger.error(LogCategory.AI_SERVICE, '[Invitation] Supabase client not initialized');
            return { success: false, error: 'Network service not available' };
        }

        // 验证 features 参数
        if (!features || typeof features !== 'object') {
          logger.error(LogCategory.AI_SERVICE, '[Invitation] 无效的 features 参数:', features);
          return { success: false, error: 'Invalid features parameter' };
        }

        // Call Supabase RPC
        const { data, error } = await supabase.rpc('match_invitation', {
          p_machine_id: id,
          p_app_features: features
        })

        if (error) {
            logger.error(LogCategory.AI_SERVICE, '[Invitation] match_invitation RPC 调用失败', error)
            return { success: false, error: error.message }
        }

        logger.info(LogCategory.AI_SERVICE, '[Invitation] match_invitation RPC 调用成功', data)
        return data
      } catch (error: any) {
        logger.error(LogCategory.AI_SERVICE, '[Invitation] 匹配过程发生异常', error)
        return { success: false, error: error.message }
      }
    })

    ipcMain.handle('invitation/get-count', async () => {
        return await this.getInvitationQuota();
    })

    ipcMain.handle('invitation/redeem', async (_, inviterRef: string) => {
        try {
            const id = await machineId()
            const { RemoteConfigService } = await import('../system/remote-config-service');
            const supabase = RemoteConfigService.getInstance().getSupabaseClient();

            if (!supabase) throw new Error('Network service not available');

            const { data, error } = await supabase.rpc('redeem_invitation_code', {
                p_machine_id: id,
                p_inviter_ref: inviterRef
            })

            if (error) throw error;
            
            if (data && data.success === false) {
                return { success: false, error: data.message || 'Unknown error' }
            }
            
            return data;
        } catch (error: any) {
            logger.error(LogCategory.AI_SERVICE, 'Manual redemption failed', error)
            return { success: false, error: error.message }
        }
    })
  }
}

export const invitationService = new InvitationService()
