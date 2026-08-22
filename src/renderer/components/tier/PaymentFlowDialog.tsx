import React, { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog'
import { Button } from '../ui/button'
import { useTierStore } from '../../stores/tier-store'
import { t } from '@app/languages'
import { toast } from '../common/Toast'
import { Flame as Firecores, AlertCircle, ArrowRight, Sparkles } from 'lucide-react'
import { UpgradeAccountDialog } from './UpgradeAccountDialog'
import { FirecoresRulesDialog } from './FirecoresRulesDialog'
import { cn } from '../../lib/utils'
import { FirecoreOperationType } from '@firefly/types'

interface PaymentFlowDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  cost: number
  operationName: string
  successTitle?: string
  successDescription?: string
  onSuccess: () => void
  metadata?: Record<string, any>
  firecoreOperationType?: FirecoreOperationType
}

type Step = 'confirm' | 'insufficient' | 'upgrade' | 'rules'

export const PaymentFlowDialog: React.FC<PaymentFlowDialogProps> = ({
  open,
  onOpenChange,
  cost,
  operationName,
  successTitle,
  successDescription,
  onSuccess,
  metadata,
  firecoreOperationType
}) => {
  const { firecores, spendFirecores } = useTierStore()
  const [step, setStep] = useState<Step>('confirm')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [rulesBackStep, setRulesBackStep] = useState<Step>('insufficient')

  useEffect(() => {
    if (open) {
      setStep('confirm')
    }
  }, [open])

  if (!open) return null

  const hasEnough = firecores >= cost
  const balanceAfter = firecores - cost

  const handleConfirm = async () => {
    if (!hasEnough) {
      setStep('insufficient')
      return
    }
    setIsSubmitting(true)
    try {
      const result = await spendFirecores(
        cost,
        firecoreOperationType ?? 'spend_unlock_analysis',
        metadata
      )
      if (result.success) {
        onSuccess()
        onOpenChange(false)
        toast.success(successTitle ?? t('兑换成功'))
      } else {
        toast.error(result.message || t('操作无法完成，请稍后再试'))
      }
    } catch (error) {
      console.error('Payment failed:', error)
      toast.error(t('无法处理您的请求'))
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleUpgrade = () => {
    setStep('upgrade')
  }

  const handleBack = () => {
    setStep('confirm')
  }

  const handleClose = () => {
    onOpenChange(false)
  }

  const handleOpenRules = (fromStep: Step) => {
    setRulesBackStep(fromStep)
    setStep('rules')
  }

  return (
    <>
      {/* Step 1: 确认支付 */}
      <Dialog
        open={open && step === 'confirm'}
        onOpenChange={o => {
          if (!o) handleClose()
        }}
      >
        <DialogContent className="max-w-md [&>button]:w-8 [&>button]:h-8 [&>button]:flex [&>button]:items-center [&>button]:justify-center [&>button_svg]:w-5 [&>button_svg]:h-5">
          <DialogHeader>
            <DialogTitle>{t('萤火消费确认')}</DialogTitle>
          </DialogHeader>

          <div className="py-2 space-y-5">
            {/* 操作名称 & 萤火金额卡片 */}
            <div className="flex flex-col items-center justify-center p-5 bg-gradient-to-b from-amber-50/80 to-amber-100/50 dark:from-amber-950/30 dark:to-amber-900/20 rounded-2xl border border-amber-200/60 dark:border-amber-800/40">
              <div className="text-xs text-muted-foreground mb-1.5 tracking-wide">
                {t('即将执行')}
              </div>
              <div className="text-lg font-bold text-foreground mb-3">{t(operationName)}</div>
              <div className="flex items-center gap-1.5 px-4 py-1.5 bg-amber-500/10 dark:bg-amber-500/20 rounded-full">
                <Firecores className="w-5 h-5 text-amber-500" />
                <span className="text-xl font-bold text-amber-600 dark:text-amber-400 tabular-nums">
                  {cost}
                </span>
                <span className="text-xs text-amber-600/70 dark:text-amber-400/70 ml-0.5">
                  {t('萤火')}
                </span>
              </div>
            </div>

            {/* 余额变动 */}
            <div className="flex items-center justify-center gap-6 px-2">
              <div className="text-center space-y-1.5">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {t('当前余额')}
                </div>
                <div className="flex items-center justify-center gap-1 font-semibold tabular-nums">
                  <Firecores className="w-4 h-4 text-yellow-500" />
                  <span className="text-base">{firecores}</span>
                </div>
              </div>
              <div className="flex flex-col items-center">
                <ArrowRight className="w-5 h-5 text-muted-foreground" />
              </div>
              <div className="text-center space-y-1.5">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {t('扣除后')}
                </div>
                <div
                  className={cn(
                    'flex items-center justify-center gap-1 font-bold tabular-nums',
                    hasEnough ? 'text-foreground' : 'text-destructive'
                  )}
                >
                  <Firecores className="w-4 h-4 text-yellow-500" />
                  <span className="text-base">{Math.max(0, balanceAfter)}</span>
                </div>
              </div>
            </div>
          </div>

          {/* 按钮区域：确认支付居中单行 + 其他操作单行 */}
          <div className="flex flex-col items-center gap-4 pb-2">
            <Button
              className="w-full max-w-[220px] rounded-xl h-10 text-sm font-semibold gap-2 shadow-md shadow-primary/20"
              disabled={isSubmitting || !hasEnough}
              onClick={handleConfirm}
            >
              <Firecores className="w-4 h-4" />
              {isSubmitting ? t('处理中...') : t('确认支付')}
            </Button>
            <div className="flex items-center justify-center gap-4 w-full pt-1">
              <Button
                variant="ghost"
                onClick={() => handleOpenRules('confirm')}
                className="text-sm text-muted-foreground h-9 px-4"
              >
                {t('收集萤火')}
              </Button>
              <Button
                variant="ghost"
                onClick={handleUpgrade}
                className="text-sm text-primary gap-0.5 h-9 px-4"
              >
                {t('升级帐户')}
                <span className="text-primary/60 font-normal">（{t('可免萤火')}）</span>
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Step 2: 萤火不足 */}
      <Dialog
        open={open && step === 'insufficient'}
        onOpenChange={o => {
          if (!o) handleBack()
        }}
      >
        <DialogContent className="max-w-md [&>button]:w-8 [&>button]:h-8 [&>button]:flex [&>button]:items-center [&>button]:justify-center [&>button_svg]:w-5 [&>button_svg]:h-5">
          <DialogHeader>
            <DialogTitle>{t('萤火余额不足')}</DialogTitle>
            <DialogDescription>{t('您的萤火不足以完成此操作')}</DialogDescription>
          </DialogHeader>

          <div className="py-4 space-y-4">
            <div className="flex gap-3 p-4 bg-destructive/10 text-destructive rounded-lg">
              <AlertCircle className="w-5 h-5 flex-shrink-0" />
              <div>
                <p className="font-medium">{t('萤火不足')}</p>
                <p className="text-sm mt-1 text-destructive/80">
                  {t('当前余额')}: {firecores} | {t('需要')}: {cost}
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-col items-center gap-3 pb-2">
            <div className="flex items-center justify-center gap-2 w-full">
              <Button variant="outline" onClick={() => handleOpenRules('insufficient')}>
                {t('收集萤火')}
              </Button>
              <Button variant="outline" onClick={handleUpgrade} className="gap-0.5">
                <Sparkles className="w-3 h-3" />
                {t('升级帐户')}
                <span className="font-normal">（{t('可免萤火')}）</span>
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Upgrade Account Dialog (占位) */}
      <UpgradeAccountDialog
        open={open && step === 'upgrade'}
        onOpenChange={(o, isNavigatingToPro) => {
          if (!o) {
            if (isNavigatingToPro) {
              handleClose()
            } else {
              handleBack()
            }
          }
        }}
      />

      {/* Firecore Rules Dialog */}
      <FirecoresRulesDialog
        open={open && step === 'rules'}
        onOpenChange={o => {
          if (!o) setStep(rulesBackStep)
        }}
        defaultTab="earn"
      />
    </>
  )
}
