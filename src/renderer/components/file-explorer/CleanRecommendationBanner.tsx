import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { MaterialIcon } from '../../lib/utils'
import { Button } from '../ui/button'
import { HintBanner, HintBannerLink } from '../ui/hint-banner'
import { t } from '@app/languages'
import { useOrganizeStore } from '../../stores/organize-store'

const STORAGE_KEY = 'firefly_dismiss_cleanup_recommendation_banner'

export const CleanRecommendationBanner: React.FC = () => {
  const navigate = useNavigate()
  const [isDismissed, setIsDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === 'true'
    } catch {
      return false
    }
  })

  // 如果已经关闭过，则不渲染
  if (isDismissed) {
    return null
  }

  const handleGoToCleanup = (e: React.MouseEvent) => {
    e.stopPropagation()
    const store = useOrganizeStore.getState()
    store.setActiveBranch('batch-duplicate')
    store.setStage('batch-duplicate')
    navigate('/organize')
  }

  const handleDismiss = (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      localStorage.setItem(STORAGE_KEY, 'true')
    } catch (err) {
      console.warn('Failed to save banner dismiss state to localStorage', err)
    }
    setIsDismissed(true)
  }

  return (
    <HintBanner
      icon={
        <span className="text-sm" role="img" aria-label="lightbulb">
          💡
        </span>
      }
      textClassName="font-medium text-amber-950 dark:text-amber-200"
      className="px-3.5 py-1.5 border-b border-amber-500/20 bg-amber-500/10 dark:bg-amber-500/15 text-foreground transition-colors duration-200"
      actions={
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={handleGoToCleanup}
            className="h-6 px-2.5 text-xs font-medium rounded-md gap-1 bg-amber-500/15 hover:bg-amber-500/25 border-amber-500/30 text-amber-900 dark:text-amber-100 cursor-pointer shadow-2xs transition-all"
          >
            <MaterialIcon icon="cleaning_services" className="text-xs text-amber-600 dark:text-amber-400" />
            <span>{t('立即查看冗余文件')}</span>
          </Button>
          {/* 「知道了」统一为下划线文字按钮：比实心按钮更轻，不抢主操作的注意力 */}
          <HintBannerLink
            onClick={handleDismiss}
            className="h-6 text-amber-900/75 dark:text-amber-200/75 decoration-amber-500/50 hover:decoration-amber-500 hover:text-amber-900 dark:hover:text-amber-200"
          >
            {t('知道了')}
          </HintBannerLink>
        </>
      }
      onClose={handleDismiss}
      closeTitle={t('关闭提示')}
    >
      {t('建议在 AI 深度分析前先执行【目录瘦身】，临时文件与重复项清理，可节省分析时间与算力。')}
    </HintBanner>
  )
}
