import React, { useCallback, useEffect, useRef, useState } from 'react'

import { MaterialIcon } from '../../lib/utils'
import { cn } from '../../lib/utils'
import { useAnalysisQueueStore } from '../../stores/analysis-queue-store'
import { useVoerkaI18n } from '@voerkai18n/react'

interface QuotaWarningBarProps {
  quota: number
  currentWorkspaceDirectory?: {
    type?: string
  }
  machineId: string | null
  setMachineId: (id: string) => void
  setShowInvitationModal: (show: boolean) => void
}

export const QuotaWarningBar: React.FC<QuotaWarningBarProps> = ({
  quota,
  currentWorkspaceDirectory,
  machineId,
  setMachineId,
  setShowInvitationModal
}) => {
  const { t } = useVoerkaI18n()
  const [analyzedCount, setAnalyzedCount] = useState(0)
  const { snapshot } = useAnalysisQueueStore()
  
  const lastCompletedIds = useRef<Set<number>>(new Set())
  const refreshTimer = useRef<NodeJS.Timeout | null>(null)

  const fetchAnalyzedCount = useCallback(async () => {
    try {
      // 使用 getAnalyzedFilesCount 替代 getPrivateAnalyzedFilesCount
      const count = await window.electronAPI?.virtualDirectory?.getAnalyzedFilesCount?.() || 0
      setAnalyzedCount(count)
    } catch (error) {
      console.error('Failed to fetch analyzed count:', error)
    }
  }, []);

  // 统计全局私有目录已分析文件数
  useEffect(() => {
    // 只有在私有目录时才获取
    if (currentWorkspaceDirectory?.type === 'PRIVATE') {
      fetchAnalyzedCount()
    }
  }, [currentWorkspaceDirectory?.type, fetchAnalyzedCount])

  // 监听分析队列变化，自动刷新计数
  useEffect(() => {
    if (currentWorkspaceDirectory?.type !== 'PRIVATE') return

    const completedItems = snapshot.items.filter(item => item.status === 'completed')
    const currentCompletedIds = new Set<number>(completedItems.map(item => item.id))

    // 检查是否有任何项目是从未完成变为已完成的
    let hasNewCompletion = false
    for (const id of currentCompletedIds) {
      if (!lastCompletedIds.current.has(id)) {
        hasNewCompletion = true
        break
      }
    }

    if (hasNewCompletion) {
      if (refreshTimer.current) clearTimeout(refreshTimer.current)

      refreshTimer.current = setTimeout(() => {
        fetchAnalyzedCount()
        lastCompletedIds.current = currentCompletedIds
        refreshTimer.current = null
      }, 1000)
    } else if (currentCompletedIds.size !== lastCompletedIds.current.size) {
      lastCompletedIds.current = currentCompletedIds
    }
  }, [snapshot.items, currentWorkspaceDirectory?.type, fetchAnalyzedCount])

  // 组件卸载时清理定时器
  useEffect(() => {
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
    }
  }, [])

  // 只有非解锁状态且处于私有目录时才需要检查额度
  const isUnlocked = quota === Infinity
  if (isUnlocked || currentWorkspaceDirectory?.type !== 'PRIVATE') return null

  const remaining = Math.max(0, quota - analyzedCount)
  const isOverQuota = remaining <= 0

  // 判断配额状态：充足 (>20%)、紧张 (<=20%)、超额 (<=0)
  const usagePercent = analyzedCount / quota
  const isQuotaSufficient = remaining > 0 && usagePercent < 0.8
  const isQuotaLow = remaining > 0 && usagePercent >= 0.8

  return (
    <div
      className={cn(
        'px-3 py-2 flex items-center justify-between cursor-pointer transition-colors border-b text-xs',
        // 超额状态 - 红色警告
        isOverQuota && 'bg-red-50/90 dark:bg-red-950/90 border-red-100 dark:border-red-900/90 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/90',
        // 配额紧张 - 橙色提醒
        isQuotaLow && 'bg-orange-50/90 dark:bg-orange-950/90 border-orange-100 dark:border-orange-900/90 text-orange-700 dark:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-950/90',
        // 配额充足 - 主题色正常状态
        isQuotaSufficient && 'bg-muted border-muted text-primary hover:bg-muted/95'
      )}
      onClick={async () => {
        if (!machineId) {
          const mId = await window.electronAPI!.getMachineId()
          setMachineId(mId)
        }
        setShowInvitationModal(true)
      }}
    >
      <div className="flex items-center gap-2">
        <MaterialIcon
          icon={isOverQuota ? 'report_problem' : isQuotaLow ? 'warning' : 'info'}
          className={cn(
            'text-sm flex-shrink-0',
            // 超额状态
            isOverQuota && 'text-red-500 dark:text-red-400',
            // 配额紧张
            isQuotaLow && 'text-orange-500 dark:text-orange-400',
            // 配额充足
            isQuotaSufficient && 'text-primary'
          )}
        />
        <span className="font-medium">
          {isOverQuota
            ? t('您私有目录合计已分析 {count} 个文件，已超出额度。', { count: analyzedCount })
            : isQuotaLow
              ? t('您私有目录合计已分析 {count} 个文件，仅剩 {remaining} 个额度。', { count: analyzedCount, remaining })
              : t('您私有目录合计已分析 {count} 个文件，还能分析 {remaining} 个文件。', { count: analyzedCount, remaining })
          }
        </span>
        <span className={cn(
          'underline decoration-dotted underline-offset-2',
          isOverQuota
            ? 'text-red-500 dark:text-red-400 hover:text-red-600 dark:hover:text-red-300'
            : isQuotaLow
              ? 'text-orange-600 dark:text-orange-400 hover:text-orange-700 dark:hover:text-orange-300'
              : 'text-primary hover:opacity-80'
        )}>
          {t('如何取消限制？')}
        </span>
      </div>
      <MaterialIcon
        icon="chevron_right"
        className={cn(
          'text-sm flex-shrink-0 opacity-60',
          isOverQuota ? 'text-red-500 dark:text-red-400' : isQuotaLow ? 'text-orange-500 dark:text-orange-400' : 'text-primary'
        )}
      />
    </div>
  )
}
