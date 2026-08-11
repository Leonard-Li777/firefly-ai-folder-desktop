import React, { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '../ui/dialog'
import { Button } from '../ui/button'
import { useTierStore } from '../../stores/tier-store'
import { t } from '@app/languages'
import { toast } from '../common/Toast'
import { Flame as Firecores, ArrowRight, AlertCircle } from 'lucide-react'
import { cn } from '../../lib/utils'

interface FirecoreConfirmModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  operationName: string
  firecoreCost: number
  successTitle?: string
  successDescription?: string
}

export const FirecoreConfirmModal: React.FC<FirecoreConfirmModalProps> = ({
  open,
  onOpenChange,
  onConfirm,
  operationName,
  firecoreCost,
  successTitle,
  successDescription
}) => {
  const { firecores, spendFirecores } = useTierStore()
  const [isSubmitting, setIsSubmitting] = useState(false)

  const balanceAfter = firecores - firecoreCost
  const hasEnough = firecores >= firecoreCost

  const handleConfirm = async () => {
    setIsSubmitting(true)
    try {
      const result = await spendFirecores(firecoreCost)
      if (result.success) {
        onConfirm()
        onOpenChange(false)
        toast.success(successTitle ?? t('兑换成功'))
      } else {
        toast.error(result.message || t('操作无法完成，请稍后再试'))
      }
    } catch (error) {
      console.error('Spend firecores failed:', error)
      toast.error(t('无法处理您的请求'))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('萤火消费确认')}</DialogTitle>
          <DialogDescription>{t('本次操作将消耗萤火，请确认您的余额变动')}</DialogDescription>
        </DialogHeader>

        <div className="py-6 space-y-6">
          <div className="flex flex-col items-center justify-center p-4 bg-muted/50 rounded-xl border border-dashed">
            <div className="text-sm text-muted-foreground mb-2">{t('即将执行')}</div>
            <div className="text-lg font-bold text-foreground">{t(operationName)}</div>
          </div>

          <div className="grid grid-cols-3 items-center gap-2 px-2">
            <div className="text-center space-y-1">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {t('当前余额')}
              </div>
              <div className="flex items-center justify-center gap-1 font-semibold tabular-nums">
                <Firecores className="w-3.5 h-3.5 text-yellow-500" />
                {firecores}
              </div>
            </div>

            <div className="flex justify-center">
              <div className="flex flex-col items-center gap-1">
                <div className="px-2 py-0.5 bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 text-[10px] font-bold rounded">
                  -{firecoreCost}
                </div>
                <ArrowRight className="w-4 h-4 text-muted-foreground" />
              </div>
            </div>

            <div className="text-center space-y-1">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {t('扣除后')}
              </div>
              <div
                className={cn(
                  'flex items-center justify-center gap-1 font-bold tabular-nums',
                  hasEnough ? 'text-foreground' : 'text-destructive'
                )}
              >
                <Firecores className="w-3.5 h-3.5 text-yellow-500" />
                {balanceAfter}
              </div>
            </div>
          </div>

          {!hasEnough && (
            <div className="flex gap-2 p-3 bg-destructive/10 text-destructive rounded-lg text-sm">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <p>{t('您的萤火余额不足，请先获取更多萤火后再试。')}</p>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('取消')}
          </Button>
          <Button disabled={!hasEnough || isSubmitting} onClick={handleConfirm}>
            {isSubmitting ? t('处理中...') : t('确认并继续')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
