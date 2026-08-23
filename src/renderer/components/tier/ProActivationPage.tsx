import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { SubscriptionPlan } from '@firefly/types'
import { Button } from '../ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../ui/card'
import { t } from '@app/languages'
import { Crown, Info, QrCode, Sparkles, X } from 'lucide-react'
import { ActivationCodeSection } from './ActivationCodeSection'
import { useConfigStore } from '../../stores/config-store'
import { getLocalPrice } from '../../lib/utils'
import { openExternalLink } from '../../lib/external-link'
import { EmailSvg } from '../ui/EmailSvg'

export const ProActivationPage: React.FC = () => {
  const navigate = useNavigate()
  const [qrSrc, setQrSrc] = useState<string>('')
  const config = useConfigStore(state => state.config)
  const proPlans = (config as any)?.OPERATION_PRICES?.upgrade_pro as
    | Record<string, SubscriptionPlan>
    | undefined

  const pricingPlans = useMemo(() => {
    if (!proPlans) return []

    const monthlyPlan = proPlans['monthly']
    const monthlyPrice = monthlyPlan ? getLocalPrice(monthlyPlan.prices) : null
    const monthlyAmount = monthlyPrice?.amount ?? 0

    const build = (key: string, plan: SubscriptionPlan): any => {
      const localPrice = getLocalPrice(plan.prices)
      const amount = localPrice?.amount ?? 0
      const periodCount = plan.period_count
      const priceNum = amount / 100

      if (key === 'monthly') {
        return {
          id: 'monthly',
          name: t('月度'),
          price: String(priceNum),
          period: t('月'),
          originalPrice: null,
          savePercent: null,
          popular: false,
          tagline: t('灵活方便，随时可换'),
          monthlyLabel: null
        }
      }

      if (!monthlyAmount) return null

      const originalAmount = monthlyAmount * periodCount
      const originalNum = originalAmount / 100
      const savePercent = Math.round((1 - amount / originalAmount) * 100)
      const equivAmount = amount / periodCount
      const equivLabel = t('¥{amount}/月', { amount: equivAmount / 100 })

      if (key === 'quarterly') {
        return {
          id: 'quarterly',
          name: t('季度'),
          price: String(priceNum),
          period: t('季'),
          originalPrice: `¥${originalNum}`,
          savePercent: `${savePercent}%`,
          popular: true,
          tagline: t('首购特惠'),
          monthlyLabel: equivLabel
        }
      }

      if (key === 'yearly') {
        return {
          id: 'yearly',
          name: t('年度'),
          price: String(priceNum),
          period: t('年'),
          originalPrice: `¥${originalNum}`,
          savePercent: `${savePercent}%`,
          popular: false,
          tagline: t('首购特惠，最高性价比'),
          monthlyLabel: equivLabel
        }
      }

      return null
    }

    const plans: any[] = []
    for (const [key, plan] of Object.entries(proPlans)) {
      const p = build(key, plan)
      if (p) plans.push(p)
    }
    return plans
  }, [proPlans])

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
                  <Crown className="w-8 h-8 text-primary" />
                </div>
              </div>
              <h1 className="text-3xl font-black tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-foreground to-foreground/70">
                {t('开通 Pro 专业版')}
              </h1>
              <p className="text-sm font-bold opacity-60 max-w-md mx-auto leading-relaxed">
                {t('选择适合您的方案，联系管理员完成开通，释放 AI 文件管理的全部潜力')}
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-4xl mx-auto px-6 pb-10">
              {pricingPlans.map((plan: any) => (
                <Card
                  key={plan.id}
                  className={`relative flex flex-col border-2 transition-all duration-300 hover:shadow-xl ${
                    plan.popular
                      ? 'border-primary shadow-xl scale-105 z-10 ring-2 ring-primary/20'
                      : 'border-border/40 hover:border-border/80'
                  }`}
                >
                  {plan.originalPrice && (
                    <div className="absolute top-2 right-2">
                      <div className="bg-destructive/10 text-destructive text-[10px] font-black px-2 py-0.5 rounded-full">
                        -{plan.savePercent}
                      </div>
                    </div>
                  )}

                  {plan.popular && (
                    <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-4 py-1 bg-gradient-to-r from-primary to-blue-600 text-[10px] font-black text-primary-foreground rounded-full uppercase tracking-widest shadow-lg z-20">
                      {t('最受欢迎')}
                    </div>
                  )}

                  <CardHeader className={`pb-3 text-center ${plan.popular ? 'pt-7' : ''}`}>
                    <div className="mt-3 space-y-1">
                      <div className="flex items-baseline justify-center gap-0.5">
                        <span className="text-3xl font-black tracking-tight">¥</span>
                        <span className="text-5xl font-black tracking-tight">{plan.price}</span>
                        <span className="text-sm text-muted-foreground font-bold ml-0.5">
                          {plan.period}
                        </span>
                      </div>
                      {plan.monthlyLabel && (
                        <div className="text-[11px] text-muted-foreground/60 font-bold">
                          {t('折合 {price}', { price: plan.monthlyLabel })}
                        </div>
                      )}
                    </div>
                  </CardHeader>

                  <CardContent className="flex-1 flex flex-col items-center px-6 pb-5 space-y-3">
                    <div
                      className={`text-xs font-bold text-center leading-relaxed px-3 py-1.5 rounded-lg ${
                        plan.popular
                          ? 'bg-primary/10 text-primary'
                          : 'bg-muted/40 text-muted-foreground'
                      }`}
                    >
                      {plan.tagline}
                    </div>
                    {plan.originalPrice && (
                      <div className="flex items-center gap-1.5 text-[11px] font-bold text-emerald-600 dark:text-emerald-400">
                        <svg
                          className="w-3.5 h-3.5"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
                          <polyline points="17 6 23 6 23 12" />
                        </svg>
                        {t('比月付省 {percent}', { percent: plan.savePercent! })}
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>

            <div className="max-w-xl mx-auto px-6 pb-10 space-y-6">
              <div className="border border-primary/15 bg-primary/[0.02] dark:bg-primary/[0.01] rounded-2xl p-5 space-y-4 shadow-sm backdrop-blur-sm">
                <div className="flex items-start gap-3.5">
                  <div className="p-2 bg-primary/10 rounded-xl text-primary mt-0.5 flex-shrink-0 animate-pulse">
                    <Sparkles className="w-4 h-4" />
                  </div>
                  <div className="space-y-1">
                    <div className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-primary/15 text-primary mb-1">
                      {t('特权承诺')}
                    </div>
                    <p className="text-xs font-semibold text-foreground leading-relaxed">
                      {t('注：Pro 版承诺之后开发新功能一律原价（限前100名年付用户），无续订要求')}
                    </p>
                  </div>
                </div>

                <div className="h-px bg-border/40" />

                <div className="flex items-start gap-3.5">
                  <div className="p-2 bg-primary/10 rounded-xl text-primary mt-0.5 flex-shrink-0">
                    <Info className="w-4 h-4" />
                  </div>
                  <div className="space-y-1">
                    <div className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-muted-foreground/15 text-muted-foreground mb-1">
                      {t('未来规划')}
                    </div>
                    <p className="text-xs font-medium text-muted-foreground leading-relaxed">
                      {t(
                        '开发计划：萤核官方微调模型、压缩包智能管理(智能密码、破解、预览增强，更适合漫画l图片文档等）、智能文件(AI封面、一键配音，可以听小说、文档)、文件AI知识管理.....'
                      )}
                    </p>
                  </div>
                </div>
              </div>
              <ActivationCodeSection tier="pro" onActivated={() => navigate('/')} />
            </div>

            <div
              id="contact-support-section"
              className="max-w-md mx-auto px-6 pb-16 text-center space-y-5"
            >
              <Card className="border-2 border-border/40 shadow-sm">
                {(config as any)?.PAYMENT_INFO?.method === 'creem' ? (
                  <>
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base font-black tracking-tight">
                        {t('官方管理员与订阅支持')}
                      </CardTitle>
                      <CardDescription className="text-xs font-medium">
                        {t('如有开通、支付、发票或退款疑问，请通过官方支持渠道联系我们')}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col items-center gap-3 pb-6 text-xs">
                      <div className="p-4 bg-muted/30 rounded-xl w-full text-center space-y-2 border border-border/50">
                        <div className="font-bold text-foreground space-y-1">
                          <div className="flex items-center gap-1 justify-center">
                            <span>{t('官方客服邮箱：')}</span>
                            <EmailSvg
                              email={
                                (config as any)?.PAYMENT_INFO?.support_email ||
                                'support@aifolder.net'
                              }
                              color="#3b82f6"
                              fontSize={12}
                            />
                          </div>
                          <div>
                            {t('Telegram：')}
                            <button
                              type="button"
                              onClick={() => openExternalLink('https://t.me/firefly_ai_folder')}
                              className="text-sky-500 font-bold hover:underline ml-1"
                            >
                              @firefly_ai_folder
                            </button>
                          </div>
                        </div>
                        <p className="text-[11px] text-muted-foreground">
                          {(config as any)?.PAYMENT_INFO?.contact_info?.response_time ||
                            t('承诺 24-48 小时内回复')}
                        </p>
                      </div>

                      <div className="p-3 bg-amber-500/5 rounded-xl w-full text-center border border-amber-500/20 text-[11px]">
                        <span className="font-bold text-amber-600 dark:text-amber-400">
                          {(config as any)?.PAYMENT_INFO?.refund_policy_summary ||
                            t('支持 14 天无理由退款保障')}
                        </span>
                      </div>

                      <div className="flex flex-wrap justify-center gap-3 pt-2 text-[11px]">
                        <button
                          type="button"
                          onClick={() =>
                            openExternalLink(
                              (config as any)?.PAYMENT_INFO?.cancellation_portal?.url ||
                                'https://www.creem.io/portal'
                            )
                          }
                          className="text-primary font-bold hover:underline"
                        >
                          {t('取消 / 管理订阅')}
                        </button>
                        <span className="text-muted-foreground">•</span>
                        <button
                          type="button"
                          onClick={() =>
                            openExternalLink(
                              (config as any)?.PAYMENT_INFO?.legal_urls?.privacy_policy ||
                                'https://www.aifolder.net/en-US/privacy'
                            )
                          }
                          className="text-muted-foreground hover:text-foreground hover:underline"
                        >
                          {t('隐私政策')}
                        </button>
                        <span className="text-muted-foreground">•</span>
                        <button
                          type="button"
                          onClick={() =>
                            openExternalLink(
                              (config as any)?.PAYMENT_INFO?.legal_urls?.terms_of_service ||
                                'https://www.aifolder.net/en-US/terms'
                            )
                          }
                          className="text-muted-foreground hover:text-foreground hover:underline"
                        >
                          {t('服务条款')}
                        </button>
                      </div>
                    </CardContent>
                  </>
                ) : (
                  <>
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base font-black tracking-tight">
                        {t('联系管理员')}
                      </CardTitle>
                      <CardDescription className="text-xs font-medium">
                        {t('扫码添加管理员微信，留言「开通 Pro」即可开通')}
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
                      <div className="flex items-center gap-1 text-xs text-muted-foreground font-medium flex-wrap justify-center">
                        <span>
                          {t('或添加微信号：reloaded1234567')} | {t('管理员邮箱：')}
                        </span>
                        <EmailSvg
                          email={(config as any)?.PAYMENT_INFO?.support_email || 'support@iocn.cn'}
                          color="#3b82f6"
                          fontSize={12}
                        />
                      </div>
                    </CardContent>
                  </>
                )}
              </Card>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
