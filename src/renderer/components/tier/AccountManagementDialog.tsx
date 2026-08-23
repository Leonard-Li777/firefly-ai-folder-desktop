import React from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog'
import { Button } from '../ui/button'
import { Card, CardContent } from '../ui/card'
import { t } from '@app/languages'
import {
  Crown,
  Calendar,
  ShieldCheck,
  Mail,
  ExternalLink,
  AlertCircle,
  XCircle
} from 'lucide-react'
import { useTierStore } from '../../stores/tier-store'
import { useConfigStore } from '../../stores/config-store'
import { UserTier, formatDateOnly } from '@firefly/shared'
import { openExternalLink } from '../../lib/external-link'
import { EmailSvg } from '../ui/EmailSvg'

interface AccountManagementDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export const AccountManagementDialog: React.FC<AccountManagementDialogProps> = ({
  open,
  onOpenChange
}) => {
  const { tier, subscription } = useTierStore()
  const config = useConfigStore(state => state.config)
  const paymentInfo = (config as any)?.PAYMENT_INFO

  if (!open) return null

  const portalUrl = paymentInfo?.cancellation_portal?.url || 'https://www.creem.io/portal'
  const supportEmail =
    paymentInfo?.support_email ||
    (paymentInfo?.method === 'creem' ? 'support@aifolder.net' : 'support@iocn.cn')
  const privacyUrl =
    paymentInfo?.legal_urls?.privacy_policy || 'https://www.aifolder.net/en-US/privacy'
  const termsUrl =
    paymentInfo?.legal_urls?.terms_of_service || 'https://www.aifolder.net/en-US/terms'

  const getTierName = () => {
    switch (tier) {
      case UserTier.ENTERPRISE:
        return t('企业版')
      case UserTier.AGENT:
        return t('代理版')
      case UserTier.PRO:
        return t('Pro 专业版')
      default:
        return t('免费版')
    }
  }

  const handleCancelSubscription = () => {
    openExternalLink(portalUrl)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg p-0 overflow-hidden border-none shadow-2xl bg-background/95 backdrop-blur-xl">
        <DialogHeader className="p-6 pb-4 text-center space-y-2">
          <div className="flex justify-center mb-1">
            <div className="p-3 bg-amber-500/10 rounded-2xl ring-8 ring-amber-500/5">
              <Crown className="w-8 h-8 text-amber-500" />
            </div>
          </div>
          <DialogTitle className="text-2xl font-black tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-amber-500 to-amber-600">
            {t('账户与订阅管理')}
          </DialogTitle>
          <DialogDescription className="text-xs font-bold text-muted-foreground">
            {t('查看当前生效的计划详情与管理下期自动续订')}
          </DialogDescription>
        </DialogHeader>

        <div className="px-6 pb-6 space-y-4">
          <Card className="border-2 border-amber-500/20 bg-amber-500/[0.02]">
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center justify-between pb-3 border-b border-border/40">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="w-5 h-5 text-amber-500" />
                  <span className="text-sm font-black">
                    {t('当前方案：{plan}', { plan: getTierName() })}
                  </span>
                </div>
                <span className="px-2.5 py-0.5 rounded-full text-[10px] font-black bg-amber-500/15 text-amber-600 dark:text-amber-400">
                  {t('已激活')}
                </span>
              </div>

              {subscription?.expires_at && (
                <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <Calendar className="w-4 h-4 text-primary" />
                  <span>
                    {t('订阅有效期至：')}{' '}
                    <strong className="text-foreground">
                      {formatDateOnly(subscription.expires_at)}
                    </strong>
                  </span>
                </div>
              )}

              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <Mail className="w-4 h-4 text-primary" />
                <span>
                  {t('管理员与售后支持：')}{' '}
                  <EmailSvg email={supportEmail} color="#3b82f6" fontSize={13} />
                  {paymentInfo?.method === 'creem' && (
                    <>
                      <span className="mx-1.5">•</span>
                      <button
                        type="button"
                        onClick={() => openExternalLink('https://t.me/firefly_ai_folder')}
                        className="text-sky-500 hover:underline font-bold"
                      >
                        Telegram: @firefly_ai_folder
                      </button>
                    </>
                  )}
                </span>
              </div>
            </CardContent>
          </Card>

          {paymentInfo?.method === 'creem' ? (
            <div className="p-4 bg-muted/40 rounded-2xl space-y-3 border border-border/40">
              <div className="flex items-start gap-2.5">
                <AlertCircle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                <div className="space-y-1 text-xs">
                  <p className="font-bold text-foreground">{t('自主取消订阅说明')}</p>
                  <p className="text-muted-foreground leading-relaxed text-[11px]">
                    {paymentInfo?.cancellation_portal?.instructions ||
                      t(
                        '您可以随时直接通过 Creem 客户门户取消下期自动续订。取消后，您在当前剩余计费周期内仍可正常使用全部 Pro 权益。'
                      )}
                  </p>
                </div>
              </div>

              <Button
                onClick={handleCancelSubscription}
                variant="destructive"
                className="w-full flex items-center justify-center gap-2 font-bold text-xs h-10 rounded-xl shadow-sm"
              >
                <XCircle className="w-4 h-4" />
                <span>{t('退订 / 取消自动续订 (Customer Portal)')}</span>
                <ExternalLink className="w-3.5 h-3.5 opacity-70 ml-1" />
              </Button>
            </div>
          ) : (
            <div className="p-4 bg-muted/40 rounded-2xl space-y-2 border border-border/40 text-xs">
              <div className="flex items-center gap-2 font-bold text-foreground">
                <AlertCircle className="w-4 h-4 text-amber-500 shrink-0" />
                <span>{t('授权与订阅说明')}</span>
              </div>
              <p className="text-muted-foreground leading-relaxed text-[11px]">
                {t(
                  '国内版不支持在线支付与自动扣款续费，授权激活均由管理员人工完成。授权到期后不会发生自动扣费，如需续期请联系客服微信或管理员邮箱。'
                )}
              </p>
            </div>
          )}

          <div className="flex justify-center gap-4 text-[11px] text-muted-foreground pt-1">
            <button
              type="button"
              onClick={() => openExternalLink(privacyUrl)}
              className="hover:text-primary hover:underline"
            >
              {t('隐私政策')}
            </button>
            <span>•</span>
            <button
              type="button"
              onClick={() => openExternalLink(termsUrl)}
              className="hover:text-primary hover:underline"
            >
              {t('服务条款')}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
