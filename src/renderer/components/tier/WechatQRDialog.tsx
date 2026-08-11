import React, { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog'
import { t } from '@app/languages'
import { Label } from '../ui/label'

interface WechatQRDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export const WechatQRDialog: React.FC<WechatQRDialogProps> = ({ open, onOpenChange }) => {
  const [imageSrc, setImageSrc] = useState<string>('')

  useEffect(() => {
    if (open) {
      const loadImage = async () => {
        try {
          const resourcesPath = await window.electronAPI.utils.getResourcesPath()
          const imagePath = `${resourcesPath}\\assets\\wechat-qr.jpg`
          setImageSrc(`file:///${imagePath.replace(/\\/g, '/')}`)
        } catch (error) {
          console.error('加载微信二维码失败:', error)
        }
      }
      loadImage()
    }
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm p-6">
        <DialogHeader>
          <DialogTitle className="text-center">{t('扫码加微信群')}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col items-center gap-10 mt-5">
          {imageSrc && (
            <img
              src={imageSrc}
              alt={t('微信二维码')}
              className="w-64 h-64 object-contain rounded-lg"
            />
          )}
          <DialogDescription className="text-center text-sm text-muted-foreground">
            <Label className="bg-primary text-primary-foreground font-bold p-2 pl-4 pr-4 rounded-full">
              {t('加微信并留言：萤核，拉你进微信群交流')}
            </Label>
            <p className="text-xs mt-5">{t('严禁广告或发邀请码')}</p>
          </DialogDescription>
        </div>
      </DialogContent>
    </Dialog>
  )
}
