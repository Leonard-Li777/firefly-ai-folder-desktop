import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { MaterialIcon, cn } from '../../lib/utils'
import { Button } from '../ui/button'
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
    <div
      className={cn(
        'px-3.5 py-1.5 flex items-center justify-between border-b text-xs transition-colors duration-200',
        'bg-amber-500/10 dark:bg-amber-500/15 border-amber-500/20 text-foreground'
      )}
    >
      <div className="flex items-center gap-2 min-w-0 flex-1 mr-2">
        <span className="text-sm select-none shrink-0" role="img" aria-label="lightbulb">
          💡
        </span>
        <span className="font-medium truncate text-amber-950 dark:text-amber-200">
          {t('建议在 AI 深度分析前先执行【目录瘦身】，临时文件与重复项清理，可节省分析时间与算力。')}
        </span>

        <div className="flex items-center gap-1.5 shrink-0 ml-1">
          <Button
            variant="outline"
            size="sm"
            onClick={handleGoToCleanup}
            className="h-6 px-2.5 text-xs font-medium rounded-md gap-1 bg-amber-500/15 hover:bg-amber-500/25 border-amber-500/30 text-amber-900 dark:text-amber-100 cursor-pointer shadow-2xs transition-all"
          >
            <MaterialIcon icon="cleaning_services" className="text-xs text-amber-600 dark:text-amber-400" />
            <span>{t('立即查看冗余文件')}</span>
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={handleDismiss}
            className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground cursor-pointer rounded-md hover:bg-amber-500/15"
          >
            {t('知道了')}
          </Button>
        </div>
      </div>

      <button
        type="button"
        onClick={handleDismiss}
        className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-amber-500/20 transition-colors cursor-pointer shrink-0 flex items-center justify-center"
        title={t('关闭提示')}
        aria-label={t('关闭提示')}
      >
        <MaterialIcon icon="close" className="text-sm" />
      </button>
    </div>
  )
}
