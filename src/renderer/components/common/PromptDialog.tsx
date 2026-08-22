import React, { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { t } from '@app/languages'

interface PromptDialogProps {
  open: boolean
  onClose: () => void
  onSubmit: (value: string) => void
  title: string
  message: string
  defaultValue?: string
  placeholder?: string
}

export const PromptDialog: React.FC<PromptDialogProps> = ({
  open,
  onClose,
  onSubmit,
  title,
  message,
  defaultValue = '',
  placeholder = ''
}) => {
  const [value, setValue] = useState(defaultValue)

  useEffect(() => {
    if (open) setValue(defaultValue)
  }, [open, defaultValue])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSubmit(value)
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 py-4">
          <p className="text-sm text-muted-foreground">{message}</p>
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            autoFocus
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('取消')}
            </Button>
            <Button type="submit" disabled={!value.trim()}>
              {t('确定')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
