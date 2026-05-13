import { useEffect, useState, useCallback } from 'react';
import { LogCategory, logger, getBaseQuota, getBonusAmount, UNLOCK_INFINITE_QUOTA_COUNT, INVITATION_FEATURE_FLAGS } from '@yonuc/shared';

export const useInvitation = (skipInitialization = false) => {
  const [invitationCount, setInvitationCount] = useState<number>(0);
  const [isInvited, setIsInvited] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState(false);

  const refreshCount = useCallback(async () => {
    if (!window.electronAPI?.invitation) {
        logger.warn(LogCategory.RENDERER, 'Invitation API not available');
        return { count: 0, isInvited: false };
    }
    try {
        setIsLoading(true);
        logger.info(LogCategory.RENDERER, 'Refreshing invitation status...');
        const result = await window.electronAPI.invitation.getCount();
        
        // IPC 现在返回 { count, isInvited }
        const count = typeof result === 'object' && result !== null ? (result.count || 0) : 0;
        const invited = typeof result === 'object' && result !== null ? !!result.isInvited : false;

        setInvitationCount(count);
        setIsInvited(invited);
        return { count, isInvited: invited };

    } catch (e) {
        logger.error(LogCategory.RENDERER, 'Failed to refresh invitation status:', e);
    } finally {
        setIsLoading(false);
    }
    return { count: 0, isInvited: false };
  }, []);

  // 计算当前私有目录分析额度
  // 生产模式：200 (基础) + (受邀奖励 ? 500 : 0) + (邀请人数 * 500)
  // 调试模式：缩小 100 倍用于测试（200 -> 2, 500 -> 5）
  const baseQuota = getBaseQuota()
  const invitedBonus = getBonusAmount()
  const perPersonBonus = getBonusAmount()
  
  const quota = invitationCount >= UNLOCK_INFINITE_QUOTA_COUNT
    ? Infinity
    : baseQuota + (isInvited ? invitedBonus : 0) + (invitationCount * perPersonBonus);

  useEffect(() => {
    // 功能开关检查：无感邀请已关闭时，仅刷新状态
    if (!INVITATION_FEATURE_FLAGS.ENABLE_AUTO_MATCH) {
      logger.info(LogCategory.RENDERER, '[Invitation] 自动匹配功能已关闭，仅刷新状态');
      refreshCount();
      return;
    }

    if (skipInitialization) {
        refreshCount();
        return;
    }

    const initInvitation = async () => {
      if (!window.electronAPI?.invitation) {
        logger.warn(LogCategory.RENDERER, '[Invitation] electronAPI.invitation 不可用，跳过初始化');
        return;
      }

      try {
        logger.info(LogCategory.RENDERER, '[Invitation] 开始收集浏览器特征...');
        const { collectStableFeatures } = await import('@yonuc/shared');
        const features = await collectStableFeatures();

        // 验证返回值
        if (!features || !features.visitorId) {
          logger.error(LogCategory.RENDERER, '[Invitation] collectStableFeatures 返回无效数据:', features);
          return;
        }

        logger.info(LogCategory.RENDERER, '[Invitation] 特征收集完成，visitorId:', features.visitorId);
        
        // 调用后端自动匹配
        const matchResult = await window.electronAPI.invitation.match(features);
        logger.info(LogCategory.RENDERER, '[Invitation] 匹配结果:', matchResult);
        
        // 获取最新状态
        await refreshCount();

      } catch (e) {
        logger.error(LogCategory.RENDERER, '[Invitation] 初始化失败:', e);
      }
    };

    initInvitation();
  }, [refreshCount, skipInitialization]);

  const redeemCode = async (code: string) => {
    if (!window.electronAPI?.invitation?.redeem) return { success: false, error: 'API not available' };
    
    try {
      setIsLoading(true);
      const result = await window.electronAPI.invitation.redeem(code);
      if (result.success) {
        await refreshCount();
      }
      return result;
    } catch (e: any) {
      return { success: false, error: e.message };
    } finally {
      setIsLoading(false);
    }
  };

  return { invitationCount, isInvited, quota, refreshCount, redeemCode, isLoading };
};
