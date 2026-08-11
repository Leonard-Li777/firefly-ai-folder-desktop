import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import React, { useState } from 'react'

import { Button } from '../ui/button'
import { MaterialIcon, cn } from '../../lib/utils'
import { t } from '@app/languages'
import { toast } from '../common/Toast'
import { useTierStore } from '../../stores/tier-store'
import { useConfigStore } from '../../stores/config-store'
import { FirecoreRulesDialog } from '../tier/FirecoreRulesDialog'

interface UnlockPrivateQuotaModalProps {
  isOpen: boolean
  onClose: () => void
  quota: number
  onRefresh: () => void
  isLoading?: boolean
  workspaceId?: number
}

export const UnlockPrivateQuotaModal: React.FC<UnlockPrivateQuotaModalProps> = ({
  isOpen,
  onClose,
  quota: _quota,
  onRefresh,
  isLoading,
  workspaceId
}) => {
  const { firecores, computed_limits, spendFirecores } = useTierStore()
  // 使用实时 store 中的 analysis_quota_total，避免传入的 prop 过期
  const quota = computed_limits?.analysis_quota_total ?? _quota
  const config = useConfigStore(state => state.config)
  const tierConstants = (config as any)?.TIER_CONSTANTS
  const [isUnlocking, setIsUnlocking] = useState(false)
  const [showFirecoreRules, setShowFirecoreRules] = useState(false)
  const canUnlock = firecores >= (tierConstants?.prices?.spend_unlock_analysis ?? Infinity)

  const handleUnlockUnlimited = async () => {
    setIsUnlocking(true)
    try {
      const result = await spendFirecores(
        tierConstants?.prices?.spend_unlock_analysis ?? Infinity,
        'spend_unlock_analysis',
        {
          reference_type: 'analysis',
          reference_id: 'unlimited',
          workspaceId
        }
      )
      if (result.success) {
        toast.success(t('已解锁私有目录无限额度'))
        onClose()
      } else {
        toast.error(result.message || t('解锁失败'))
      }
    } catch {
      toast.error(t('解锁请求失败'))
    } finally {
      setIsUnlocking(false)
    }
  }

  const handleCloseModal = () => {
    setShowFirecoreRules(false)
    onClose()
  }

  return (
    <>
      <Dialog open={isOpen} onOpenChange={open => !open && handleCloseModal()}>
        <DialogContent className="sm:max-w-2xl bg-background text-foreground max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-foreground">
              <MaterialIcon icon="lock_open" className="text-primary text-xl" />
              {t('解锁私有目录无限额度')}
            </DialogTitle>
            <DialogDescription className="pt-2 text-muted-foreground text-sm">
              {t('私有目录有一定的分析额度限制，消耗萤火即可解锁无限额度，不再受限。')}
            </DialogDescription>
          </DialogHeader>

          <div className="py-4 space-y-6">
            {/* 当前奖励统计 */}
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-primary/5 border border-primary/10 rounded-lg p-4">
                <p className="text-xs text-muted-foreground mb-1">{t('当前萤火')}</p>
                <p className="text-2xl font-bold text-primary">
                  {firecores} <span className="text-sm">{t('萤火')}</span>
                </p>
              </div>
              <div className="bg-orange-500/5 border border-orange-500/10 rounded-lg p-4">
                <p className="text-xs text-muted-foreground mb-1">{t('当前分析额度')}</p>
                <p className="text-2xl font-bold text-orange-600">
                  {quota === Infinity ? t('不限数量') : quota}{' '}
                  <span className="text-sm">{t('个文件')}</span>
                </p>
              </div>
            </div>

            {/* 解锁说明 */}
            <div className="bg-muted/30 rounded-lg p-4 space-y-3">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <MaterialIcon icon="info" className="text-primary text-base" />
                {t('解锁后您将获得')}
              </div>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li className="flex items-center gap-2">
                  <MaterialIcon icon="check" className="text-green-500 text-sm" />
                  {t('私有目录分析文件数量无上限')}
                </li>
                <li className="flex items-center gap-2">
                  <MaterialIcon icon="check" className="text-green-500 text-sm" />
                  {t('永久有效，一次解锁长期使用')}
                </li>
              </ul>
              <div className="flex items-center gap-2 mt-3 pt-3 border-t border-border/60">
                <MaterialIcon icon="sell" className="text-amber-500 text-base" />
                <span className="text-sm font-bold text-amber-600">
                  {t('消耗 {cost} 萤火', {
                    cost: tierConstants?.prices?.spend_unlock_analysis ?? Infinity
                  })}
                </span>
              </div>
            </div>
          </div>

          <DialogFooter className="sm:justify-start">
            <Button
              variant="ghost"
              onClick={onRefresh}
              disabled={isLoading}
              className="text-xs h-8"
            >
              <MaterialIcon
                icon="refresh"
                className={cn('mr-1 text-sm', isLoading && 'animate-spin')}
              />
              {t('刷新状态')}
            </Button>
            <div className="flex-1" />
            <Button
              onClick={handleUnlockUnlimited}
              disabled={!canUnlock || isUnlocking}
              className={cn(
                'h-8 text-xs',
                canUnlock
                  ? 'bg-amber-500 hover:bg-amber-600 text-white shadow-sm'
                  : 'opacity-40 cursor-not-allowed'
              )}
            >
              {isUnlocking
                ? t('处理中...')
                : t('兑换无限额度 ({cost} 萤火)', {
                    cost: tierConstants?.prices?.spend_unlock_analysis ?? Infinity
                  })}
            </Button>
            <Button onClick={() => setShowFirecoreRules(true)} className="h-8 text-xs">
              <MaterialIcon icon="local_fire_department" className="mr-1 text-sm" />
              {t('收集萤火')}
            </Button>
            <Button onClick={handleCloseModal} variant="secondary" className="h-8 text-xs">
              {t('稍后再说')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <FirecoreRulesDialog
        open={showFirecoreRules}
        onOpenChange={o => {
          if (!o) setShowFirecoreRules(false)
        }}
        defaultTab="earn"
      />
    </>
  )
}
