import React from 'react'
import { useNavigate } from 'react-router-dom'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog'
import { Button } from '../ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../ui/card'
import { t } from '@app/languages'
import { Check, Rocket, Crown, Building2, Sparkles } from 'lucide-react'
import { useTierStore } from '../../stores/tier-store'
import { UserTier } from '@firefly/types'
import type { TierConstants, SubscriptionPlan } from '@firefly/types'
import { useConfigStore } from '../../stores/config-store'
import { getLocalPrice, formatPrice, formatMonthlyPrice } from '../../lib/utils'
interface UpgradeAccountDialogProps {
  open: boolean
  onOpenChange: (open: boolean, isNavigatingToPro?: boolean) => void
}

export const UpgradeAccountDialog: React.FC<UpgradeAccountDialogProps> = ({
  open,
  onOpenChange
}) => {
  const navigate = useNavigate()
  const { tier } = useTierStore()
  const config = useConfigStore(state => state.config)
  const tierConstants = (config as any)?.TIER_CONSTANTS as TierConstants | undefined
  const operationPrices = (config as any)?.OPERATION_PRICES

  if (!open || !tierConstants) {
    return null
  }

  const freeLimits = tierConstants.tierLimits[UserTier.FREE]

  const getProPrice = () => {
    const proYearly: SubscriptionPlan | undefined = operationPrices?.upgrade_pro?.yearly
    if (!proYearly) return null
    const price = getLocalPrice(proYearly.prices)
    return formatPrice(price)
  }

  const getProMonthlyPrice = () => {
    const proYearly: SubscriptionPlan | undefined = operationPrices?.upgrade_pro?.yearly
    if (!proYearly) return null
    const price = getLocalPrice(proYearly.prices)
    return formatMonthlyPrice(price)
  }

  const getEnterprisePrice = () => {
    const entYearly: SubscriptionPlan | undefined = operationPrices?.upgrade_enterprise?.yearly
    if (!entYearly) return null
    const price = getLocalPrice(entYearly.prices)
    return formatPrice(price)
  }

  const tiers = [
    {
      id: UserTier.FREE,
      name: t('基础版'),
      icon: Rocket,
      description: t('适合个人轻量使用'),
      features: [
        t('{count} 个极速目录槽位', { count: freeLimits.speedy_dir_slot_limit }),
        t('{count} 个私有目录槽位', { count: freeLimits.private_dir_slot_limit }),
        t('每目录 {count} 个虚拟目录槽位', { count: freeLimits.vdir_slot_limit }),
        t('极速目录无限文件分析额度'),
        t('私有目录共享 {count} 个文件基础分析额度', { count: tierConstants.freeBaseQuota }),
        t('赠送 {count} 萤火，体验各项功能', { count: tierConstants.welcomeGrantFirecores }),
        t('不断通过萤火兑换等同Pro的权益'),
        t('专业技术支持')
      ],
      current: tier === UserTier.FREE,
      buttonText: t('当前计划'),
      buttonVariant: 'outline' as const,
      disabled: true
    },
    {
      id: UserTier.PRO,
      name: t('Pro 专业版'),
      icon: Crown,
      description: getProMonthlyPrice()
        ? t('低至 {price}/月，为生产力而生', { price: getProMonthlyPrice() })
        : t('为生产力而生'),
      features: [
        t('无限文件分析额度'),
        t('无限极速目录槽位'),
        t('无限私有目录槽位'),
        t('无限虚拟目录槽位'),
        t('无限导出'),
        t('专业技术支持')
      ],
      current: tier === UserTier.PRO,
      buttonText: tier === UserTier.PRO ? t('当前计划') : t('立即升级'),
      buttonVariant: 'default' as const,
      disabled: tier === UserTier.PRO || tier === UserTier.ENTERPRISE,
      highlight: true
    },
    {
      id: UserTier.ENTERPRISE,
      name: t('企业版'),
      icon: Building2,
      description: getEnterprisePrice()
        ? t('仅需 {price}/年，最高标准的隐私需求', { price: getEnterprisePrice() })
        : t('最高标准的隐私需求'),
      features: [
        t('Pro版所有权益'),
        t('可完全离线或内网使用'),
        t('支持离线进行新功能升级'),
        t('7*24专属技术支持通道')
      ],
      current: tier === UserTier.ENTERPRISE,
      buttonText: tier === UserTier.ENTERPRISE ? t('当前计划') : t('联系升级'),
      buttonVariant: 'secondary' as const,
      disabled: tier === UserTier.ENTERPRISE
    }
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl p-0 overflow-hidden border-none shadow-2xl bg-background/95 backdrop-blur-xl">
        <DialogHeader className="p-8 pb-4 text-center space-y-2">
          <div className="flex justify-center mb-2">
            <div className="flex justify-center mb-2">
              <div className="p-3 bg-primary/10 rounded-2xl ring-8 ring-primary/5">
                <Sparkles className="w-8 h-8 text-primary animate-pulse" />
              </div>
            </div>
          </div>
          <DialogTitle className="text-3xl font-black tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-foreground to-foreground/70">
            {t('升级您的帐户')}
          </DialogTitle>
          <DialogDescription className="text-sm font-bold opacity-60">
            {t('选择最适合您的版本，释放 AI 文件管理的全部潜力')}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 p-8 pt-4">
          {tiers.map(tInfo => {
            const Icon = tInfo.icon
            return (
              <Card
                key={tInfo.id}
                className={`relative flex flex-col border-2 transition-all duration-300 hover:shadow-xl ${
                  tInfo.highlight
                    ? 'border-primary shadow-lg scale-105 z-10'
                    : 'border-border/40 hover:border-border/80'
                }`}
              >
                {tInfo.highlight && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 bg-primary text-[10px] font-black text-primary-foreground rounded-full uppercase tracking-widest shadow-sm">
                    {t('最受欢迎')}
                  </div>
                )}
                <CardHeader className="space-y-1">
                  <div
                    className={`w-12 h-12 rounded-xl flex items-center justify-center mb-2 ${
                      tInfo.highlight
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    <Icon className="w-6 h-6" />
                  </div>
                  <CardTitle className="text-xl font-black tracking-tight">{tInfo.name}</CardTitle>
                  <CardDescription className="text-xs font-bold leading-relaxed">
                    {tInfo.description}
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex-1 space-y-4">
                  <ul className="space-y-3">
                    {tInfo.features.map((feature, idx) => (
                      <li key={idx} className="flex items-center gap-2.5">
                        <div
                          className={`p-0.5 rounded-full shrink-0 ${tInfo.highlight ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'}`}
                        >
                          <Check className="w-3 h-3" />
                        </div>
                        <span className="text-xs font-bold opacity-80 leading-tight">
                          {feature}
                        </span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
                <CardFooter>
                  <Button
                    variant={tInfo.buttonVariant}
                    className={`w-full h-11 text-sm font-black rounded-xl transition-all ${
                      tInfo.highlight
                        ? 'shadow-lg shadow-primary/20 hover:scale-[1.02] active:scale-[0.98]'
                        : ''
                    }`}
                    disabled={tInfo.disabled}
                    onClick={() => {
                      if (tInfo.id === UserTier.PRO) {
                        onOpenChange(false, true)
                        navigate('/pro-activation')
                      }
                      if (tInfo.id === UserTier.ENTERPRISE) {
                        onOpenChange(false, true)
                        navigate('/enterprise-activation')
                      }
                    }}
                  >
                    {tInfo.buttonText}
                  </Button>
                </CardFooter>
              </Card>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}
