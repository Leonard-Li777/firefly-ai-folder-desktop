import React from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog'
import { t } from '@app/languages'
import { KeyRound } from 'lucide-react'
import { ActivationCodeSection } from './ActivationCodeSection'

interface ActivationCodeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onActivated?: () => void
}

export const ActivationCodeDialog: React.FC<ActivationCodeDialogProps> = ({
  open,
  onOpenChange,
  onActivated
}) => {
  if (!open) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl p-0 overflow-hidden border-none shadow-2xl bg-background/95 backdrop-blur-xl [&>button]:w-8 [&>button]:h-8 [&>button]:flex [&>button]:items-center [&>button]:justify-center [&>button_svg]:w-5 [&>button_svg]:h-5">
        <DialogHeader className="p-6 pb-2 text-center space-y-2">
          <div className="flex justify-center mb-1">
            <div className="p-3.5 bg-primary/10 rounded-2xl ring-8 ring-primary/5">
              <KeyRound className="w-8 h-8 text-primary" />
            </div>
          </div>
          <DialogTitle className="text-2xl font-black tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-foreground to-foreground/80">
            {t('兑换授权激活码')}
          </DialogTitle>
          <DialogDescription className="text-xs font-semibold text-muted-foreground">
            {t('专供离线企业版用户或活动授权码，输入后即时在本地校验激活')}
          </DialogDescription>
        </DialogHeader>

        <div className="px-6 pb-6">
          <ActivationCodeSection
            tier="enterprise"
            onActivated={() => {
              onActivated?.()
              setTimeout(() => onOpenChange(false), 2000)
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
