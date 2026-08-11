import React, { useCallback, useEffect, useRef, useState } from 'react'

import { MaterialIcon, cn } from '../../lib/utils'
import { useAnalysisQueueStore } from '../../stores/analysis-queue-store'
import { useTierStore } from '../../stores/tier-store'
import { useVoerkaI18n } from '@voerkai18n/react'
import { useShallow } from 'zustand/react/shallow'
import { INFINITY } from '@firefly/shared'

interface QuotaWarningBarProps {
  currentWorkspaceDirectory?: {
    type?: string
  }
  machineId: string | null
  setMachineId: (id: string) => void
  setShowInvitationModal: (show: boolean) => void
}

export const QuotaWarningBar: React.FC<QuotaWarningBarProps> = ({
  currentWorkspaceDirectory,
  machineId,
  setMachineId,
  setShowInvitationModal
}) => {
  const { t } = useVoerkaI18n()
  const [analyzedCount, setAnalyzedCount] = useState(0)
  const completedItemIds = useAnalysisQueueStore(
    useShallow(
      s => s.snapshot?.items?.filter(item => item.status === 'completed').map(item => item.id) || []
    )
  )
  const quota = useTierStore(s => s.computed_limits?.analysis_quota_total)

  const lastCompletedIds = useRef<Set<number>>(new Set())
  const refreshTimer = useRef<NodeJS.Timeout | null>(null)

  const fetchAnalyzedCount = useCallback(async () => {
    try {
      // 使用 getAnalyzedFilesCount 替代 getPrivateAnalyzedFilesCount
      const count = (await window.electronAPI?.analyzedDirectory?.getAnalyzedFilesCount?.()) || 0
      setAnalyzedCount(count)
    } catch (error) {
      console.error('Failed to fetch analyzed count:', error)
    }
  }, [])

  // 统计全局私有目录已分析文件数
  useEffect(() => {
    // 极速目录不限额度，无需获取
    if (currentWorkspaceDirectory?.type !== 'SPEEDY') {
      fetchAnalyzedCount()
    }
  }, [currentWorkspaceDirectory?.type, fetchAnalyzedCount])

  // 监听分析队列变化，自动刷新计数
  useEffect(() => {
    if (currentWorkspaceDirectory?.type === 'SPEEDY') return

    const currentCompletedIds = new Set<number>(completedItemIds)

    // 检查是否有任何项目是从未完成变为已完成的
    let hasNewCompletion = false
    for (const id of currentCompletedIds) {
      if (!lastCompletedIds.current.has(id)) {
        hasNewCompletion = true
        break
      }
    }

    if (hasNewCompletion) {
      // 立即更新已知完成 ID 集合，防止防抖等待期间后续队列推送重复触发误判
      lastCompletedIds.current = currentCompletedIds

      if (refreshTimer.current) clearTimeout(refreshTimer.current)

      refreshTimer.current = setTimeout(() => {
        fetchAnalyzedCount()
        refreshTimer.current = null
      }, 1000)
    } else if (currentCompletedIds.size !== lastCompletedIds.current.size) {
      lastCompletedIds.current = currentCompletedIds
    }
  }, [completedItemIds, currentWorkspaceDirectory?.type, fetchAnalyzedCount])

  // 组件卸载时清理定时器
  useEffect(() => {
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
    }
  }, [])

  // 仅私有目录且非解锁状态时才需要检查额度（INFINITY 为 INFINITY 哨兵值）
  if (currentWorkspaceDirectory?.type !== 'PRIVATE') return null
  if (quota === undefined || quota >= INFINITY) return null

  const remaining = Math.max(0, quota - analyzedCount)
  const isOverQuota = remaining <= 0

  // 判断配额状态：紧张 (<=20% 额度)、超额 (<=0)
  const usagePercent = analyzedCount / quota
  const isQuotaLow = remaining > 0 && usagePercent >= 0.8

  // 默认不显示，仅当达到警告状态（使用率 >= 80%）或超额状态时才显示
  if (!isQuotaLow && !isOverQuota) return null

  return (
    <div
      className={cn(
        'px-3 py-2 flex items-center justify-between cursor-pointer transition-colors border-b text-xs',
        // 超额状态 - 红色警告
        isOverQuota &&
          'bg-red-50/90 dark:bg-red-950/90 border-red-100 dark:border-red-900/90 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/90',
        // 配额紧张 - 橙色提醒
        isQuotaLow &&
          'bg-orange-50/90 dark:bg-orange-950/90 border-orange-100 dark:border-orange-900/90 text-orange-700 dark:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-950/90'
      )}
      onClick={async e => {
        e.stopPropagation()
        if (!machineId) {
          const mId = await window.electronAPI!.getMachineId()
          setMachineId(mId)
        }
        setShowInvitationModal(true)
      }}
    >
      <div className="flex items-center gap-2">
        <MaterialIcon
          icon={isOverQuota ? 'report_problem' : 'warning'}
          className={cn(
            'text-sm flex-shrink-0',
            // 超额状态
            isOverQuota && 'text-red-500 dark:text-red-400',
            // 配额紧张
            isQuotaLow && 'text-orange-500 dark:text-orange-400'
          )}
        />
        <span className="font-medium">
          {isOverQuota
            ? t('您私有目录合计已分析 {count} 个文件，已超出额度，可使用极速目录不限额。', {
                count: analyzedCount
              })
            : t(
                '您私有目录合计已分析 {count} 个文件，仅剩 {remaining} 个额度，可使用极速目录不限额。',
                {
                  count: analyzedCount,
                  remaining
                }
              )}
        </span>
        <span
          className={cn(
            'underline decoration-dotted underline-offset-2',
            isOverQuota
              ? 'text-red-500 dark:text-red-400 hover:text-red-600 dark:hover:text-red-300'
              : 'text-orange-600 dark:text-orange-400 hover:text-orange-700 dark:hover:text-orange-300'
          )}
        >
          {t('如何取消私有目录限制？')}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-muted-foreground opacity-70 hidden sm:inline">
          {t('小技巧：双击文件启用预览，方向键切换文件，ESC关闭预览')}
        </span>
        <MaterialIcon
          icon="chevron_right"
          className={cn(
            'text-sm flex-shrink-0 opacity-60',
            isOverQuota ? 'text-red-500 dark:text-red-400' : 'text-orange-500 dark:text-orange-400'
          )}
        />
      </div>
    </div>
  )
}
