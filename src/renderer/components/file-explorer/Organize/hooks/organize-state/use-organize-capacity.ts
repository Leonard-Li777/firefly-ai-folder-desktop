import { useCallback, useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { LogCategory, logger } from '@firefly/shared'
import i18nScope from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'
import { toast } from '../../../../common/Toast'
import { useAnalyzedDirectoryStore } from '../../../../../stores/analyzed-directory-store'
import { useConfigValue } from '../../../../../stores/settings-store'
import { useOrganizeStore } from '../../../../../stores/organize-store'
import { Stage } from '../../types'

interface UseOrganizeCapacityParams {
  /** 未切片前的全量候选待整理文件数 */
  rawToOrganizeCount: number
}

/**
 * 容量门禁域：单次整理容量上限、切片/穿透控制与进入主流程前的拦截分流。
 */
export function useOrganizeCapacity({ rawToOrganizeCount }: UseOrganizeCapacityParams) {
  const { t } = useVoerkaI18n(i18nScope)
  const location = useLocation()
  const navigate = useNavigate()

  const currentWorkspaceDirectory = useAnalyzedDirectoryStore(
    (s: any) => s.currentWorkspaceDirectory
  )
  const stage = useOrganizeStore(s => s.stage)
  const setStage = useOrganizeStore(s => s.setStage)

  // ─── 配置中心：单次整理容量上限（默认 3,000）与切片/穿透控制 ──────────────────
  // R-20 双层 getter 硬规则：渲染层禁止 getState().getConfigValue()，统一经 useConfigValue 取活值
  const organizeCapacityLimit = useConfigValue<number>('ORGANIZE_CAPACITY_LIMIT') ?? 3000
  const organizeFileLimitOverride = useOrganizeStore(s => s.organizeFileLimitOverride)
  const setOrganizeFileLimitOverride = useOrganizeStore(s => s.setOrganizeFileLimitOverride)
  const bypassCapacityLimit = useOrganizeStore(s => s.bypassCapacityLimit)
  const setBypassCapacityLimit = useOrganizeStore(s => s.setBypassCapacityLimit)
  const [isCapacityExceeded, setIsCapacityExceeded] = useState(false)
  const [capacityExceededCount, setCapacityExceededCount] = useState(0)
  const [showCapacityLimitDialog, setShowCapacityLimitDialog] = useState(false)

  // 监听路由离开 /organize 页面时清理弹窗，避免幽灵穿透
  useEffect(() => {
    if (location.pathname !== '/organize') {
      setShowCapacityLimitDialog(false)
    }
  }, [location.pathname])

  // 返回整理首页时自动复位超限警告标记
  useEffect(() => {
    if (stage === 'root-mode-select') {
      setIsCapacityExceeded(false)
    }
  }, [stage])

  // ─── 批量整理入口容量门禁拦截与分流控制 ──────────────────────────────────
  const handleAttemptEnterModeSelect = useCallback(
    (targetStage: Stage = 'mode-select') => {
      // 1. 如果目标阶段不是批量整理主流程（例如 batch-rename, batch-tag, batch-duplicate, root-mode-select），
      // 属于前置卫星工具或首页，不需要受容量限制阻断，直接无条件放行切换！
      const isMainOrganizeStage =
        targetStage !== 'root-mode-select' &&
        targetStage !== 'batch-rename' &&
        targetStage !== 'batch-tag' &&
        targetStage !== 'batch-duplicate'

      if (!isMainOrganizeStage) {
        setStage(targetStage)
        return
      }

      const currentBypass = useOrganizeStore.getState().bypassCapacityLimit
      const currentOverride = useOrganizeStore.getState().organizeFileLimitOverride

      // 若用户已确认风险 (bypass) 或已设定切片前批次，直接放行进入
      if (currentBypass || currentOverride !== null) {
        setStage(targetStage)
        return
      }

      // 仅在尝试进入批量整理主流程时校验容量
      if (rawToOrganizeCount > organizeCapacityLimit) {
        logger.info(
          LogCategory.FILE_ORGANIZATION,
          `[整理门禁] 待整理文件数 (${rawToOrganizeCount}) 超出上限 ${organizeCapacityLimit}，拦截进入批量整理主流程并弹窗`
        )
        setIsCapacityExceeded(true)
        setCapacityExceededCount(rawToOrganizeCount)
        setShowCapacityLimitDialog(true)
        return
      }

      setIsCapacityExceeded(false)
      setCapacityExceededCount(0)
      setStage(targetStage)
    },
    [organizeCapacityLimit, rawToOrganizeCount, setStage]
  )

  const handleGoToAnalyzedPage = useCallback(() => {
    setShowCapacityLimitDialog(false)
    navigate('/analyzed-directory', {
      state: {
        workspaceId: currentWorkspaceDirectory?.id,
        startInOrganizeMode: true
      }
    })
  }, [navigate, currentWorkspaceDirectory?.id])

  const handleLimitToFirst3000Files = useCallback(() => {
    setOrganizeFileLimitOverride(organizeCapacityLimit)
    setBypassCapacityLimit(false)
    setIsCapacityExceeded(false)
    setShowCapacityLimitDialog(false)
    setStage('mode-select')
    toast.success(
      t('已载入前 {count} 个文件，其余文件保留原样待后续整理', {
        count: Math.min(rawToOrganizeCount, organizeCapacityLimit).toLocaleString()
      })
    )
  }, [
    organizeCapacityLimit,
    rawToOrganizeCount,
    setOrganizeFileLimitOverride,
    setBypassCapacityLimit,
    setStage,
    t
  ])

  const handleBypassLimitAndOrganizeAll = useCallback(() => {
    setBypassCapacityLimit(true)
    setOrganizeFileLimitOverride(null)
    setIsCapacityExceeded(false)
    setShowCapacityLimitDialog(false)
    setStage('mode-select')
    toast.info(
      t('已解除容量限制，本次将整理全部 {count} 个文件', {
        count: rawToOrganizeCount.toLocaleString()
      })
    )
  }, [rawToOrganizeCount, setBypassCapacityLimit, setOrganizeFileLimitOverride, setStage, t])

  return {
    organizeCapacityLimit,
    organizeFileLimitOverride,
    setOrganizeFileLimitOverride,
    bypassCapacityLimit,
    setBypassCapacityLimit,
    isCapacityExceeded,
    setIsCapacityExceeded,
    capacityExceededCount,
    setCapacityExceededCount,
    showCapacityLimitDialog,
    setShowCapacityLimitDialog,
    handleAttemptEnterModeSelect,
    handleGoToAnalyzedPage,
    handleLimitToFirst3000Files,
    handleBypassLimitAndOrganizeAll
  }
}
