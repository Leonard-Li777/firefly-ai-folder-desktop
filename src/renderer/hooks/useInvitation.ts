import { t } from '@app/languages'
import { useEffect, useState, useCallback } from 'react'
import { LogCategory, logger, INVITATION_FEATURE_FLAGS } from '@firefly/shared'
import { useTierStore } from '../stores/tier-store'

export const useInvitation = (skipInitialization = false) => {
  const [invitationCount, setInvitationCount] = useState<number>(0)
  const [isInvited, setIsInvited] = useState<boolean>(false)
  const [quota, setQuota] = useState<number>(200)
  const [isLoading, setIsLoading] = useState(false)
  const fetchProfile = useTierStore(state => state.fetchProfile)

  const refreshCount = useCallback(async () => {
    if (!window.electronAPI?.invitation) {
      logger.warn(LogCategory.RENDERER, 'Invitation API not available')
      return { count: 0, isInvited: false }
    }
    try {
      setIsLoading(true)
      logger.info(LogCategory.RENDERER, 'Refreshing invitation status...')
      const result = await window.electronAPI.invitation.getCount()

      // IPC 现在返回 { count, isInvited, quota }
      const count = typeof result === 'object' && result !== null ? result.count || 0 : 0
      const invited = typeof result === 'object' && result !== null ? !!result.isInvited : false
      const quotaVal = typeof result === 'object' && result !== null ? result.quota || 200 : 200

      setInvitationCount(count)
      setIsInvited(invited)
      setQuota(quotaVal)
      return { count, isInvited: invited, quota: quotaVal }
    } catch (e: any) {
      const errMsg = e?.message || String(e)
      if (errMsg.includes('No handler registered')) {
        logger.info(
          LogCategory.RENDERER,
          'Invitation handler not registered yet (app still initializing)'
        )
      } else {
        logger.error(LogCategory.RENDERER, 'Failed to refresh invitation status:', e)
      }
    } finally {
      setIsLoading(false)
    }
    return { count: 0, isInvited: false }
  }, [])

  useEffect(() => {
    // 功能开关检查：无感邀请已关闭时，仅刷新状态
    if (!INVITATION_FEATURE_FLAGS.ENABLE_AUTO_MATCH) {
      logger.info(LogCategory.RENDERER, '[Invitation] 自动匹配功能已关闭，仅刷新状态')
      refreshCount()
      return
    }

    if (skipInitialization) {
      refreshCount()
      return
    }

    const initInvitation = async () => {
      if (!window.electronAPI?.invitation) {
        logger.warn(LogCategory.RENDERER, '[Invitation] electronAPI.invitation 不可用，跳过初始化')
        return
      }

      try {
        logger.info(LogCategory.RENDERER, '[Invitation] 开始收集浏览器特征...')
        const { collectStableFeatures } = await import('@firefly/shared')
        const features = await collectStableFeatures()

        // 验证返回值
        if (!features || !features.visitorId) {
          logger.error(
            LogCategory.RENDERER,
            '[Invitation] collectStableFeatures 返回无效数据:',
            features
          )
          return
        }

        logger.info(
          LogCategory.RENDERER,
          '[Invitation] 特征收集完成，visitorId:',
          features.visitorId
        )

        // 调用后端自动匹配
        const matchResult = await window.electronAPI.invitation.match(features)
        logger.info(LogCategory.RENDERER, '[Invitation] 匹配结果:', matchResult)

        if (matchResult && matchResult.success) {
          await fetchProfile()
        }

        // 获取最新状态
        await refreshCount()
      } catch (e) {
        logger.error(LogCategory.RENDERER, '[Invitation] 初始化失败:', e)
      }
    }

    initInvitation()
  }, [refreshCount, skipInitialization])

  const redeemCode = async (code: string) => {
    if (!window.electronAPI?.invitation?.redeem) return { success: false, error: t('API 不可用') }

    try {
      setIsLoading(true)
      const result = await window.electronAPI.invitation.redeem(code)
      if (result.success) {
        await fetchProfile()
        await refreshCount()
      }
      return result
    } catch (e: any) {
      return { success: false, error: e.message }
    } finally {
      setIsLoading(false)
    }
  }

  return { invitationCount, isInvited, quota, refreshCount, redeemCode, isLoading }
}
