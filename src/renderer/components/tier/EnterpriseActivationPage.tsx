import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { SubscriptionPlan } from '@firefly/types'
import { Button } from '../ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../ui/card'
import i18nScope, { t } from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'
import { Check, Building2, QrCode, X } from 'lucide-react'
import { ActivationCodeSection } from './ActivationCodeSection'
import { useConfigStore } from '../../stores/config-store'
import { getLocalPrice, formatPrice } from '../../lib/utils'

export const EnterpriseActivationPage: React.FC = () => {
  const { t, activeLanguage } = useVoerkaI18n(i18nScope)
  const navigate = useNavigate()
  const [qrSrc, setQrSrc] = useState<string>('')
  const config = useConfigStore(state => state.config)
  const enterprisePlans = (config as any)?.OPERATION_PRICES?.upgrade_enterprise as
    | Record<string, SubscriptionPlan>
    | undefined

  const pricingPlans = useMemo(() => {
    if (!enterprisePlans) return []
    const entries = Object.entries(enterprisePlans)
    const plans: Array<{
      id: string
      name: string
      price: string
      period: string
      popular: boolean
      features: string[]
    }> = []

    const halfYearPlan = enterprisePlans['half_year']
    const halfYearPrice = halfYearPlan ? getLocalPrice(halfYearPlan.prices) : null

    for (const [key, plan] of entries) {
      const localPrice = getLocalPrice(plan.prices)
      const priceStr = formatPrice(localPrice)
      let name: string
      let period: string
      let popular = false
      const features: string[] = []

      if (key === 'half_year') {
        name = t('半年')
        period = t('/半年')
        features.push(t('适合短期项目需求'))
      } else if (key === 'yearly') {
        name = t('一年')
        period = t('/年')
        popular = true
        if (halfYearPrice) {
          const savings = halfYearPrice.amount * 2 - localPrice!.amount
          if (savings > 0) {
            const savedStr = formatPrice({ currency: localPrice!.currency, amount: savings })
            features.push(t('立省 {saved}，最超值方案', { saved: savedStr }))
          }
        }
      } else {
        name = key
        period = ''
      }
      plans.push({ id: key, name, price: priceStr, period, popular, features })
    }
    return plans
  }, [enterprisePlans, activeLanguage])

  useEffect(() => {
    const loadQR = async () => {
      try {
        const resourcesPath = await window.electronAPI.utils.getResourcesPath()
        const imagePath = `${resourcesPath}\\assets\\wechat-qr.jpg`
        setQrSrc(`file:///${imagePath.replace(/\\/g, '/')}`)
      } catch (error) {
        console.error('加载微信二维码失败:', error)
      }
    }
    loadQR()
  }, [])

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-background">
      <div className="flex-1 overflow-y-auto flex flex-col">
        <div className="flex-1 flex items-center justify-center">
          <div className="w-full">
            <div className="absolute top-4 right-4 z-20">
              <Button
                variant="ghost"
                size="icon"
                className="rounded-full w-14 h-14 hover:bg-background/80 [&_svg]:size-8"
                onClick={() => navigate('/')}
              >
                <X className="!size-8" />
              </Button>
            </div>

            <div className="pb-8 text-center space-y-4 px-6">
              <div className="flex justify-center mb-2">
                <div className="p-3 bg-primary/10 rounded-2xl ring-8 ring-primary/5">
                  <Building2 className="w-8 h-8 text-primary" />
                </div>
              </div>
              <h1 className="text-3xl font-black tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-foreground to-foreground/70">
                {t('开通企业版')}
              </h1>
              <p className="text-sm font-bold opacity-60 max-w-md mx-auto leading-relaxed">
                {t('选择适合您的方案，联系管理员完成开通，释放 AI 文件管理的全部潜力')}
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-2xl mx-auto px-6 pb-10">
              {pricingPlans.map(plan => (
                <Card
                  key={plan.id}
                  className={`relative flex flex-col border-2 transition-all duration-300 hover:shadow-xl ${
                    plan.popular
                      ? 'border-primary shadow-lg scale-105 z-10'
                      : 'border-border/40 hover:border-border/80'
                  }`}
                >
                  {plan.popular && (
                    <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 bg-primary text-[10px] font-black text-primary-foreground rounded-full uppercase tracking-widest shadow-sm">
                      {t('最受欢迎')}
                    </div>
                  )}

                  <CardHeader className="pb-4 text-center">
                    <CardTitle className="text-lg font-black tracking-tight">{plan.name}</CardTitle>
                    <div className="mt-3">
                      <span className="text-4xl font-black tracking-tight">{plan.price}</span>
                      <span className="text-sm text-muted-foreground font-bold ml-1">
                        {plan.period}
                      </span>
                    </div>
                  </CardHeader>

                  <CardContent className="flex-1 space-y-3 px-6">
                    <ul className="space-y-2.5">
                      {plan.features.map((feature, idx) => (
                        <li key={idx} className="flex items-center justify-center gap-2.5">
                          <div
                            className={`p-0.5 rounded-full shrink-0 ${
                              plan.popular
                                ? 'bg-primary/20 text-primary'
                                : 'bg-muted text-muted-foreground'
                            }`}
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
                </Card>
              ))}
            </div>

            <div className="max-w-2xl mx-auto px-6 pb-10">
              <div className="flex items-center justify-center gap-2 pb-6">
                <div className="h-px w-12 bg-border/60" />
                <div className="p-1.5 bg-primary/10 rounded-lg">
                  <QrCode className="w-5 h-5 text-primary" />
                </div>
                <div className="h-px w-12 bg-border/60" />
              </div>
              <ActivationCodeSection tier="enterprise" onActivated={() => navigate('/')} />
            </div>

            <div
              id="wechat-qr-section"
              className="max-w-md mx-auto px-6 pb-16 text-center space-y-5"
            >
              <Card className="border-2 border-border/40 shadow-sm">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base font-black tracking-tight">
                    {t('联系管理员')}
                  </CardTitle>
                  <CardDescription className="text-xs font-medium">
                    {t('扫码添加管理员微信，留言「开通企业版」获取授权码')}
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col items-center gap-4 pb-6">
                  {qrSrc ? (
                    <div className="p-3 bg-white rounded-xl shadow-inner ring-1 ring-border/10">
                      <img
                        src={qrSrc}
                        alt={t('微信二维码')}
                        className="w-48 h-48 object-contain rounded-lg"
                      />
                    </div>
                  ) : (
                    <div className="w-48 h-48 bg-muted/30 rounded-xl animate-pulse flex items-center justify-center">
                      <span className="text-xs text-muted-foreground">{t('加载中...')}</span>
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground font-medium">
                    {t('或添加微信号：reloaded1234567')}
                  </p>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
