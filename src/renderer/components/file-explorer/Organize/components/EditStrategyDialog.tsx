import React, { useState, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '../../../ui/dialog'
import { Button } from '../../../ui/button'
import { Textarea } from '../../../ui/textarea'
import { t } from '@app/languages'

interface EditStrategyDialogProps {
  open: boolean
  onClose: () => void
  initialStrategy: string
  onSubmit: (strategy: string) => void
}

export const EditStrategyDialog: React.FC<EditStrategyDialogProps> = ({
  open,
  onClose,
  initialStrategy,
  onSubmit
}) => {
  const [strategy, setStrategy] = useState(initialStrategy)

  useEffect(() => {
    if (open) {
      setStrategy(initialStrategy)
    }
  }, [open, initialStrategy])

  const handleSumbit = (e: React.FormEvent) => {
    e.preventDefault()
    onSubmit(strategy.trim())
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(val: boolean) => !val && onClose()}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{t('修改整理策略')}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSumbit} className="space-y-4 py-4">
          <div className="space-y-2">
            <label className="text-sm font-medium leading-none">
              {t('整理策略')}
            </label>
            <Textarea
              value={strategy}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setStrategy(e.target.value)}
              placeholder={t('描述该虚拟目录的整理思路、分类逻辑、优先级等')}
              rows={8}
              className="resize-none"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('取消')}
            </Button>
            <Button type="submit" className="bg-primary">
              {t('确定')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
