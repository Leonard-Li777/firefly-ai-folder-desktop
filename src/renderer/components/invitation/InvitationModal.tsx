import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import React, { useState } from 'react'

import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { MaterialIcon } from '../../lib/utils'
import { cn } from '../../lib/utils'
import { encodeMachineIdToRef } from '@yonuc/core-engine/utils/machine-id-compression'
import { t } from '@app/languages'
import { getBaseQuota, getBonusAmount, UNLOCK_INFINITE_QUOTA_COUNT } from '@yonuc/shared'
import { toast } from '../common/Toast'
import { captureEvent } from '../../lib/posthog'

interface InvitationModalProps {
  isOpen: boolean
  onClose: () => void
  invitationCount: number
  isInvited: boolean
  quota: number
  machineId: string
  onRefresh: () => void
  onRedeem: (code: string) => Promise<{ success: boolean; error?: string }>
  isLoading?: boolean
}

export const InvitationModal: React.FC<InvitationModalProps> = ({
  isOpen,
  onClose,
  invitationCount,
  isInvited,
  quota,
  machineId,
  onRefresh,
  onRedeem,
  isLoading
}) => {
  const targetCount = UNLOCK_INFINITE_QUOTA_COUNT
  const isUnlocked = invitationCount >= targetCount
  const [redeemCode, setRedeemCode] = useState('')
  const [isRedeeming, setIsRedeeming] = useState(false)
  
  // 调试模式下显示缩小 100 倍的数值
  const baseQuotaDisplay = getBaseQuota()
  const bonusDisplay = getBonusAmount()

  // 邀请链接模板 - 使用压缩后的 16 位推荐码
  const inviteLink = `https://aifolder.iocn.cn?ref=${encodeMachineIdToRef(machineId)}`
  
  const handleCopyLink = async () => {
    try {
      const text = `${t('我发现一个超好用的开源免费AI文件整理工具，一键整理乱七八糟的桌面、下载目录等，自动分类/重命名/归档，配截图！')}\n${inviteLink}`
      await navigator.clipboard.writeText(text)
      toast.success(t('邀请链接已复制'))
    } catch (err) {
      toast.error(t('复制失败'))
    }
  }

  const handleRedeem = async () => {
    let code = redeemCode.trim()
    if (!code) return
    
    // 直接匹配输入字符串中第一个连续的 16 位 Base62 字符块（邀请码核心格式）
    const base62Match = code.match(/[a-zA-Z0-9]{16}/)
    if (base62Match) {
      code = base62Match[0]
    }

    setIsRedeeming(true)
    captureEvent('提交邀请码', { rawCode: redeemCode })
    try {
      const bonusAmount = getBonusAmount()
      const result = await onRedeem(code)
      if (result.success) {
        captureEvent('提交邀请码成功', { code })
        toast.success(t('兑换成功！已增加 {amount} 个文件分析额度', { amount: bonusAmount }))
        setRedeemCode('')
      } else {
        captureEvent('提交邀请码失败', { code, error: result.error })
        console.error('Invitation redemption failed:', result.error)
        toast.error(t('兑换失败: {error}', { error: result.error || t('未知错误') }))
      }
    } catch (e) {
      captureEvent('提交邀请码失败', { code, error: e instanceof Error ? e.message : 'Unknown request error' })
      console.error('Invitation redemption request failed:', e)
      toast.error(t('兑换请求失败'))
    } finally {
      setIsRedeeming(false)
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl bg-background text-foreground max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-foreground">
            <MaterialIcon icon="card_giftcard" className="text-primary text-xl" />
            {t('获取更多私有目录分析额度')}
          </DialogTitle>
          <DialogDescription className="pt-2 text-muted-foreground text-sm">
            {t('为提倡极速目录共享分析，以及为了项目可持续发展，私有目录有一定限制：默认提供 {baseQuota} 个文件的分析。通过邀请好友或输入邀请码，您可以解锁无限额度。', { baseQuota: getBaseQuota() })}
          </DialogDescription>
        </DialogHeader>
        
        <div className="py-4 space-y-6">
          {/* 当前额度展示 */}
          <div className="bg-primary/5 border border-primary/10 rounded-lg p-4 flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground mb-1">{t('当前总额度')}</p>
              <p className="text-2xl font-bold text-primary">
                {quota === Infinity ? t('不限数量') : t('{count} 个文件', { count: quota })}
              </p>
            </div>
            <div className="text-right">
              <p className="text-xs text-muted-foreground mb-1">{t('已邀请人数')}</p>
              <p className="text-xl font-semibold">{invitationCount} / {targetCount}</p>
            </div>
          </div>

          {/* 进度路径 */}
          <div className="relative pt-2 pb-8">
             <div className="flex justify-between items-start text-[10px] text-muted-foreground">
                <div className="flex flex-col items-center gap-1 w-1/4">
                   <div className={cn("w-6 h-6 rounded-full flex items-center justify-center border-2 z-10 bg-background", isInvited || invitationCount > 0 ? "border-primary text-primary" : "border-muted")}>
                      <MaterialIcon icon="person" className="text-xs" />
                   </div>
                   <span>{baseQuotaDisplay}</span>
                   <span className="text-center leading-tight">{t('基础额度')}</span>
                </div>
                <div className="flex flex-col items-center gap-1 w-1/4">
                   <div className={cn("w-6 h-6 rounded-full flex items-center justify-center border-2 z-10 bg-background", isInvited ? "border-green-500 text-green-500" : "border-muted")}>
                      {isInvited ? <MaterialIcon icon="check" className="text-xs" /> : <MaterialIcon icon="add" className="text-xs" />}
                   </div>
                   <span>+{bonusDisplay}</span>
                   <span className="text-center leading-tight">{t('受邀奖励')}</span>
                </div>
                <div className="flex flex-col items-center gap-1 w-1/4 text-center">
                   <div className={cn("w-6 h-6 rounded-full flex items-center justify-center border-2 z-10 bg-background", invitationCount >= 1 ? "border-primary text-primary" : "border-muted")}>
                      {invitationCount >= 1 ? <MaterialIcon icon="celebration" className="text-xs" /> : <span className="text-[10px]">1</span>}
                   </div>
                   <span>+{bonusDisplay}/人</span>
                   <span className="text-center leading-tight">{t('邀请好友')}</span>
                </div>
                <div className="flex flex-col items-center gap-1 w-1/4 text-center">
                   <div className={cn("w-6 h-6 rounded-full flex items-center justify-center border-2 z-10 bg-background", invitationCount >= 3 ? "border-yellow-500 bg-yellow-500 text-white" : "border-muted")}>
                      <MaterialIcon icon="all_inclusive" className="text-xs" />
                   </div>
                   <span className={cn(invitationCount >= 3 ? "text-yellow-600 font-bold" : "")}>{t('无限')}</span>
                   <span className="text-center leading-tight">{t('满3人解锁')}</span>
                </div>
             </div>
             {/* 连接线 */}
             <div className="absolute top-[20px] left-[12.5%] right-[12.5%] h-0.5 bg-muted -z-0">
                <div 
                  className="h-full bg-primary transition-all duration-500" 
                  style={{ width: `${Math.min(100, (invitationCount / 3) * 100)}%` }}
                />
             </div>
          </div>

          {/* 邀请链接 */}
          <div className="space-y-3">
             <h3 className="text-sm font-semibold flex items-center gap-2">
                <MaterialIcon icon="share" className="text-primary text-base" />
                {t('您的专属邀请链接')}
             </h3>
             <div className="flex gap-2">
                <div className="flex-1 bg-muted/50 border border-border rounded-md px-3 py-2 text-sm text-foreground truncate select-all">
                   {inviteLink}
                </div>
                <Button size="sm" onClick={handleCopyLink} className="shrink-0">
                   <MaterialIcon icon="content_copy" className="mr-1 text-sm" />
                   {t('复制')}
                </Button>
             </div>
             <p className="text-[11px] text-muted-foreground leading-relaxed">
                {t('发送链接给好友，好友下载并运行应用后，您和好友都将立即获得 {bonus} 个文件的分析额度，邀请满3人即可解锁无限额度。', { bonus: bonusDisplay })}
             </p>
          </div>

          {/* 手动输入邀请码 (仅当未被邀请过时显示) */}
          {!isInvited && (
            <div className="pt-4 border-t border-dashed border-border space-y-3">
               <h3 className="text-sm font-semibold flex items-center gap-2">
                  <MaterialIcon icon="confirmation_number" className="text-orange-500 text-base" />
                  {t('我有邀请码/邀请链接')}
               </h3>
               <div className="flex gap-2">
                  <Input 
                    placeholder={t('在此输入 16 位邀请码或链接')} 
                    value={redeemCode}
                    onChange={(e) => setRedeemCode(e.target.value)}
                    className="flex-1"
                  />
                  <Button 
                    variant="outline" 
                    onClick={handleRedeem} 
                    disabled={isRedeeming || !redeemCode.trim()}
                    className="shrink-0 border-orange-500 text-orange-600 hover:bg-orange-50"
                  >
                    {isRedeeming ? <MaterialIcon icon="sync" className="animate-spin mr-1" /> : null}
                    {t('立即领取')}
                  </Button>
               </div>
               <p className="text-[11px] text-muted-foreground">
                  {t('如果你知道他人的邀请码或链接，输入后双方均可立即获取 500 个分析额度。')}
               </p>
            </div>
          )}
        </div>

        <DialogFooter className="sm:justify-start">
          <Button variant="ghost" onClick={onRefresh} disabled={isLoading} className="text-xs h-8">
            <MaterialIcon icon="refresh" className={cn("mr-1 text-sm", isLoading && "animate-spin")} />
            {t('刷新状态')}
          </Button>
          <div className="flex-1" />
          <Button onClick={onClose} variant="secondary" className="h-8 text-xs">
            {t('稍后再说')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
