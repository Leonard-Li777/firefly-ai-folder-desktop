import React, { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog'
import { Button } from '../ui/button'
import { Card, CardContent } from '../ui/card'
import { t, getLanguage } from '@app/languages'
import {
  Crown,
  Building2,
  Sparkles,
  ShieldCheck,
  Calendar,
  CreditCard,
  Mail,
  ExternalLink,
  Copy,
  Check,
  Clock,
  Flame as Firecores,
  MessageCircle,
  RefreshCw,
  Sparkle,
  Layers
} from 'lucide-react'
import { useTierStore } from '../../stores/tier-store'
import { useConfigStore } from '../../stores/config-store'
import { UserTier, formatDateOnly, encodeMachineIdToBase64 } from '@firefly/shared'
import { openExternalLink } from '../../lib/external-link'
import { resolveDevCreemUrl, getOfficialSiteOrigin } from '../../lib/marketing-link'
import { EmailSvg } from '../ui/EmailSvg'
import { cn } from '../../lib/utils'

interface AccountManagementDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export const AccountManagementDialog: React.FC<AccountManagementDialogProps> = ({
  open,
  onOpenChange
}) => {
  const { tier, subscription, firecores, syncFromCloud, fetchProfile } = useTierStore()
  const config = useConfigStore(state => state.config)
  const paymentInfo = (config as any)?.PAYMENT_INFO

  const [identCode, setIdentCode] = useState<string>('')
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [isSyncing, setIsSyncing] = useState<boolean>(false)

  const handleSyncStatus = async () => {
    setIsSyncing(true)
    try {
      if (syncFromCloud) {
        await syncFromCloud()
      } else if (fetchProfile) {
        await fetchProfile()
      }
    } catch (err) {
      console.warn('[AccountManagementDialog] 同步最新状态失败:', err)
    } finally {
      setIsSyncing(false)
    }
  }

  useEffect(() => {
    const fetchIdent = async () => {
      try {
        let code = ''
        if (window.electronAPI?.license?.getIdentCode) {
          code = await window.electronAPI.license.getIdentCode()
        }
        if (!code && window.electronAPI?.getMachineId) {
          const mId = await window.electronAPI.getMachineId()
          if (mId) code = encodeMachineIdToBase64(mId)
        }
        setIdentCode(code)
      } catch (err) {
        console.warn('[AccountManagementDialog] 获取设备标识码失败:', err)
      }
    }
    if (open) {
      fetchIdent()
      // 打开账户管理弹窗时，主动触发一次云端最新订阅状态同步
      handleSyncStatus()
    }
  }, [open])

  if (!open) return null

  // 兜底法律条款/门户链接必须跟随当前区域域名（国内版 aifolder.iocn.cn / 国际版 www.aifolder.net）
  const siteDomain = getOfficialSiteOrigin()
  const legalLang = getLanguage() || 'zh-CN'
  const isCreemBilling = paymentInfo?.method === 'creem'
  const portalUrl =
    paymentInfo?.cancellation_portal?.url ||
    (isCreemBilling ? 'https://www.creem.io/portal' : `${siteDomain}/${legalLang}/pricing`)
  const supportEmail =
    paymentInfo?.support_email ||
    (isCreemBilling ? 'support@aifolder.net' : 'support@iocn.cn')
  const privacyUrl =
    paymentInfo?.legal_urls?.privacy_policy || `${siteDomain}/${legalLang}/privacy`
  const termsUrl =
    paymentInfo?.legal_urls?.terms_of_service || `${siteDomain}/${legalLang}/terms`

  const copyToClipboard = (text: string, key: string) => {
    try {
      navigator.clipboard.writeText(text)
      setCopiedKey(key)
      setTimeout(() => {
        setCopiedKey(null)
      }, 2000)
    } catch {}
  }

  // 动态等级视觉配置与专属权益映射（严格对齐官方方案权益承诺）
  const getTierTheme = (currentTier: UserTier) => {
    switch (currentTier) {
      case UserTier.ENTERPRISE:
        return {
          name: t('企业版'),
          subName: t('最高标准的隐私需求'),
          icon: <Building2 className="w-6 h-6 text-purple-500" />,
          glowClass: 'bg-purple-500/25',
          ringClass: 'ring-purple-500/30 bg-purple-500/10 text-purple-600 dark:text-purple-400',
          badgeClass: 'bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30',
          cardBgClass:
            'bg-gradient-to-br from-purple-500/[0.12] via-indigo-500/[0.04] to-transparent border-purple-500/30',
          accentText: 'text-purple-600 dark:text-purple-400',
          features: [
            t('Pro版所有权益'),
            t('可完全离线或内网使用'),
            t('支持离线进行新功能升级'),
            t('7*24专属技术支持通道')
          ]
        }
      case UserTier.AGENT:
        return {
          name: t('代理版'),
          subName: t('团队席位与授权分发'),
          icon: <ShieldCheck className="w-6 h-6 text-emerald-500" />,
          glowClass: 'bg-emerald-500/25',
          ringClass: 'ring-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
          badgeClass: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
          cardBgClass:
            'bg-gradient-to-br from-emerald-500/[0.12] via-teal-500/[0.04] to-transparent border-emerald-500/30',
          accentText: 'text-emerald-600 dark:text-emerald-400',
          features: [
            t('Pro版所有权益'),
            t('多席位授权分发'),
            t('无限文件分析额度'),
            t('优先技术支持通道')
          ]
        }
      case UserTier.PRO:
        return {
          name: t('Pro 专业版'),
          subName: t('为生产力而生'),
          icon: <Crown className="w-6 h-6 text-amber-500" />,
          glowClass: 'bg-amber-500/25',
          ringClass: 'ring-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
          badgeClass: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30',
          cardBgClass:
            'bg-gradient-to-br from-amber-500/[0.12] via-orange-500/[0.04] to-transparent border-amber-500/30',
          accentText: 'text-amber-600 dark:text-amber-400',
          features: [
            t('无限文件分析额度'),
            t('无限极速目录槽位'),
            t('无限私有目录槽位'),
            t('无限虚拟目录槽位'),
            t('无限导出'),
            t('专业技术支持')
          ]
        }
      default:
        return {
          name: t('免费版'),
          subName: t('适合个人轻量使用'),
          icon: <Sparkles className="w-6 h-6 text-muted-foreground" />,
          glowClass: 'bg-muted/40',
          ringClass: 'ring-border/60 bg-muted/40 text-muted-foreground',
          badgeClass: 'bg-secondary text-secondary-foreground border-border/60',
          cardBgClass:
            'bg-gradient-to-br from-muted/40 via-muted/15 to-transparent border-border/60',
          accentText: 'text-muted-foreground',
          features: [
            t('极速目录无限文件分析'),
            t('私有目录有限文件分析'),
            t('有限极速/私有/虚拟目录槽位'),
            t('有限导出'),
            t('收集萤火获取等同Pro的权益'),
            t('专业技术支持')
          ]
        }
    }
  }

  const theme = getTierTheme(tier)

  // 订阅有效期状态：临期（30天内）橙色提醒，已过期红色，正常绿色
  const expiryDate = subscription?.expires_at ? new Date(subscription.expires_at) : null
  const isExpired = expiryDate ? expiryDate.getTime() < Date.now() : false
  const isExpiringSoon = expiryDate
    ? !isExpired && expiryDate.getTime() - Date.now() < 30 * 24 * 60 * 60 * 1000
    : false
  // 解析各个扣费渠道的订阅项
  const channelSubs = (subscription?.channel_subscriptions || {}) as Record<string, any>
  const tierPeriods = (subscription?.tier_periods || {}) as Record<string, any>

  // 辅助函数：根据 plan 字符串解析周期标签
  const getPeriodLabel = (planStr: string) => {
    const s = planStr.toLowerCase()
    if (s.includes('yearly') || s.includes('annual')) return t('年付周期')
    if (s.includes('half_year') || s.includes('semi_annual') || s.includes('6_month')) return t('半年付周期')
    if (s.includes('quarterly') || s.includes('3_month') || s.includes('season')) return t('季付周期')
    if (s.includes('monthly')) return t('月付周期')
    return t('周期授权')
  }

  // 构建多行订阅列表数据：区分「执行中」、「休眠中」与「已退款」
  type FormattedSubItem = {
    id: string
    name: string
    tier: 'enterprise' | 'pro'
    isCurrentExecuting: boolean
    status: string // 'active' | 'canceled' | 'refunded' | 'expired'
    periodLabel: string
    expiresAt: string | null
    isAutoRenew: boolean
  }

  const subscriptionRows: FormattedSubItem[] = []

  // 1. 获取所有在 channelSubs 中登记的条目（包括 active、canceled、refunded 等）
  const allChannelEntries = Object.entries(channelSubs).filter(([_, item]: [string, any]) => Boolean(item))

  // 判定条目是否已被退款（支持 status === 'refunded' 或含有 refunded_at 标记）
  const isItemRefunded = (item: any, planIdStr?: string) => {
    if (!item && !planIdStr) return false
    if (item?.status === 'refunded' || item?.refunded_at) return true
    if (subscription?.status === 'refunded') return true
    // 若特定 planId 在 channelSubs 或 tier_periods 中标记为退款
    const keyPlan = String(item?.plan || item?.product_id || planIdStr || '').toLowerCase()
    if (keyPlan.includes('enterprise') && tierPeriods?.enterprise?.status === 'refunded') return true
    if (keyPlan.includes('pro') && tierPeriods?.pro?.status === 'refunded') return true
    return false
  }

  // 过滤出未退款的有效订阅渠道
  const activeChannelEntries = allChannelEntries.filter(([_, item]: [string, any]) => !isItemRefunded(item))

  // 查找是否有未退款的 Enterprise 方案和 Pro 方案
  const validEnterpriseEntry = activeChannelEntries.find(([_, item]: [string, any]) => {
    const plan = String(item.plan || item.product_id || '').toLowerCase()
    return plan.includes('enterprise')
  })
  const validProEntries = activeChannelEntries.filter(([_, item]: [string, any]) => {
    const plan = String(item.plan || item.product_id || '').toLowerCase()
    return plan.includes('pro') || item.provider === 'creem'
  })

  // 确定真实当前执行中等级与执行渠道对象
  // 规则：未退款的 Enterprise 优先执行；若 Enterprise 已退款或无 Enterprise，则按未退款的 Pro 执行
  let executingChannelEntry: [string, any] | null = null
  let executingTier: 'enterprise' | 'pro' | null = null

  if (validEnterpriseEntry) {
    executingChannelEntry = validEnterpriseEntry
    executingTier = 'enterprise'
  } else if (validProEntries.length > 0) {
    executingChannelEntry = validProEntries[0]
    executingTier = 'pro'
  } else if (tier !== UserTier.FREE && !isItemRefunded(null, subscription?.plan_id)) {
    executingTier = tier === UserTier.ENTERPRISE ? 'enterprise' : 'pro'
  }

  const existingCardIds = new Set<string>()

  // 2. 首先放入当前「执行中」卡片
  if (executingTier) {
    const isEnterprise = executingTier === 'enterprise'
    const execChannel = executingChannelEntry ? executingChannelEntry[1] : null
    const execKey = executingChannelEntry ? executingChannelEntry[0] : ''
    const cardId = execChannel?.sub_id ? `sub_${execChannel.sub_id}` : (execKey ? `sub_${execKey}` : 'current_executing')

    const mainPlanId = execChannel?.plan || subscription?.plan_id || (isEnterprise ? 'enterprise' : 'pro')
    const isExecChannelCanceled = execChannel?.status === 'canceled'

    subscriptionRows.push({
      id: cardId,
      name: isEnterprise ? t('Firefly Enterprise 企业版') : t('Firefly Pro 专业版'),
      tier: executingTier,
      isCurrentExecuting: true,
      status: isExecChannelCanceled ? 'canceled' : 'active',
      periodLabel: getPeriodLabel(mainPlanId),
      expiresAt: subscription?.expires_at || null,
      isAutoRenew: execChannel ? execChannel.status === 'active' : (subscription?.auto_renew ?? false)
    })
    existingCardIds.add(cardId)
  }

  // 3. 遍历 channel_subscriptions 中的其他条目
  allChannelEntries.forEach(([key, item]: [string, any]) => {
    const subId = String(item.sub_id || key)
    const cardId = `sub_${subId}`
    if (existingCardIds.has(cardId)) return

    const planStr = String(item.plan || item.product_id || '').toLowerCase()
    const isEnt = planStr.includes('enterprise')
    const itemTier: 'enterprise' | 'pro' = isEnt ? 'enterprise' : 'pro'
    const refunded = isItemRefunded(item, planStr)

    subscriptionRows.push({
      id: cardId,
      name: isEnt ? t('Firefly Enterprise 企业版') : t('Firefly Pro 专业版'),
      tier: itemTier,
      isCurrentExecuting: false,
      status: refunded ? 'refunded' : (item.status || 'active'),
      periodLabel: getPeriodLabel(planStr),
      expiresAt: null, // 非执行中（休眠或已退款）绝对不显示到期时间
      isAutoRenew: !refunded && item.status === 'active'
    })
    existingCardIds.add(cardId)
  })

  // 4. 若有独立的 Pro 接续储备且未在列表显示
  const proPeriod = tierPeriods?.pro
  if (
    executingTier === 'enterprise' &&
    proPeriod &&
    proPeriod.status !== 'refunded' &&
    !subscriptionRows.some(r => !r.isCurrentExecuting && r.tier === 'pro' && r.status !== 'refunded')
  ) {
    const proPlanId = String(proPeriod.plan_id || '')
    subscriptionRows.push({
      id: 'pro_tier_period_reserve',
      name: t('Firefly Pro 专业版'),
      tier: 'pro',
      isCurrentExecuting: false,
      status: 'active',
      periodLabel: proPlanId ? getPeriodLabel(proPlanId) : t('接续保障权益'),
      expiresAt: null, // 休眠中绝不显示到期时间
      isAutoRenew: true
    })
  }

  const handleOpenBillingPortal = () => {
    openExternalLink(resolveDevCreemUrl(portalUrl))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl p-0 overflow-hidden border border-border/80 shadow-2xl bg-background/98 backdrop-blur-2xl rounded-3xl no-drag">
        {/* 顶部简明标题 */}
        <div className="relative pt-6 pb-2 px-6 text-center overflow-hidden">
          <div
            className={cn(
              'absolute top-0 left-1/2 -translate-x-1/2 w-64 h-24 rounded-full blur-3xl pointer-events-none opacity-25',
              theme.glowClass
            )}
          />

          <div className="relative z-10 flex flex-col items-center">
            <DialogTitle className="text-xl md:text-2xl font-black tracking-tight text-foreground">
              {t('账户与订阅中心')}
            </DialogTitle>
            <DialogDescription className="text-xs font-medium text-muted-foreground mt-1 max-w-md text-center">
              {t('管理您的多方案会员权益、独立计费周期与自动续费状态')}
            </DialogDescription>
          </div>
        </div>

        <div className="px-6 pb-6 space-y-3.5 relative z-10 max-h-[75vh] overflow-y-auto">
          {/* ── 订阅方案通栏卡片列表（每个订阅一个独立的通栏卡片） ── */}
          <div className="space-y-3">
            {subscriptionRows.length > 0 ? (
              subscriptionRows.map((row) => {
                const isEnterprise = row.tier === 'enterprise'
                const tierTheme = getTierTheme(isEnterprise ? UserTier.ENTERPRISE : UserTier.PRO)

                return (
                  <div
                    key={row.id}
                    className={cn(
                      'p-4 rounded-2xl border transition-all duration-200 relative overflow-hidden shadow-xs',
                      row.isCurrentExecuting
                        ? isEnterprise
                          ? 'bg-gradient-to-br from-purple-500/[0.08] via-purple-500/[0.02] to-transparent border-purple-500/35 ring-1 ring-purple-500/25'
                          : 'bg-gradient-to-br from-amber-500/[0.08] via-amber-500/[0.02] to-transparent border-amber-500/35 ring-1 ring-amber-500/25'
                        : 'bg-muted/30 border-border/60 hover:bg-muted/50'
                    )}
                  >
                    {/* 卡片头部：图标、方案名称、周期标签与执行/休眠状态徽标 */}
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div
                          className={cn(
                            'p-2 rounded-xl border shrink-0',
                            row.isCurrentExecuting
                              ? isEnterprise
                                ? 'bg-purple-500/15 border-purple-500/30 text-purple-600 dark:text-purple-400'
                                : 'bg-amber-500/15 border-amber-500/30 text-amber-600 dark:text-amber-400'
                              : 'bg-muted border-border/60 text-muted-foreground'
                          )}
                        >
                          {isEnterprise ? (
                            <Building2 className="w-4 h-4" />
                          ) : (
                            <Crown className="w-4 h-4" />
                          )}
                        </div>

                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span
                              className={cn(
                                'font-black text-sm tracking-tight truncate',
                                row.isCurrentExecuting
                                  ? isEnterprise
                                    ? 'text-purple-600 dark:text-purple-400'
                                    : 'text-amber-600 dark:text-amber-400'
                                  : 'text-foreground'
                              )}
                            >
                              {row.name}
                            </span>
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-background/90 border border-border/70 text-muted-foreground shrink-0 shadow-2xs">
                              {row.periodLabel}
                            </span>
                          </div>
                          <p className="text-[11px] text-muted-foreground font-medium truncate mt-0.5">
                            {tierTheme.subName}
                          </p>
                        </div>
                      </div>

                      {/* 执行状态徽章：执行中 / 休眠中 / 已退款 */}
                      <div className="shrink-0">
                        {row.isCurrentExecuting ? (
                          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-black bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 shadow-2xs">
                            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                            <span>{t('执行中')}</span>
                          </span>
                        ) : row.status === 'refunded' ? (
                          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-black bg-muted/60 text-muted-foreground/80 border border-border/60 shadow-2xs">
                            <span className="w-2 h-2 rounded-full bg-muted-foreground/40" />
                            <span>{t('已退款')}</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-black bg-muted text-muted-foreground border border-border/80 shadow-2xs">
                            <span className="w-2 h-2 rounded-full bg-muted-foreground/60" />
                            <span>{t('休眠中')}</span>
                          </span>
                        )}
                      </div>
                    </div>

                    {/* 卡片详情行：有效期 / 封存提示 / 退款说明，以及自动续订状态 */}
                    <div className="mt-3.5 pt-3 border-t border-border/40 flex items-center justify-between text-xs gap-3">
                      {/* 左侧：执行中显示明确到期日；休眠中绝不显示到期日，显示完整封存提示；已退款显示退款终止提示 */}
                      <div className="flex items-center gap-1.5 text-muted-foreground font-medium min-w-0">
                        {row.isCurrentExecuting ? (
                          <>
                            <Calendar className="w-3.5 h-3.5 text-muted-foreground/80 shrink-0" />
                            <span className="shrink-0">{t('有效期至：')}</span>
                            <span className="font-mono font-bold text-foreground tabular-nums truncate">
                              {row.expiresAt ? formatDateOnly(row.expiresAt) : t('永久有效')}
                            </span>
                          </>
                        ) : row.status === 'refunded' ? (
                          <>
                            <Clock className="w-3.5 h-3.5 text-muted-foreground/60 shrink-0" />
                            <span className="truncate text-muted-foreground/80">
                              {t('款项已原路退回，方案权益已终止')}
                            </span>
                          </>
                        ) : (
                          <>
                            <Clock className="w-3.5 h-3.5 text-muted-foreground/80 shrink-0" />
                            <span className="truncate">
                              {t('权益已完整封存保留，待执行计划到期后起算')}
                            </span>
                          </>
                        )}
                      </div>

                      {/* 右侧：续订扣费状态 */}
                      <div className="shrink-0 font-bold text-[11px]">
                        {row.status === 'refunded' ? (
                          <span className="inline-flex items-center gap-1 text-muted-foreground/70">
                            <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50" />
                            {t('订阅已终结')}
                          </span>
                        ) : row.isAutoRenew ? (
                          <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                            {t('自动续订中')}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                            {t('已关闭自动续费')}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* 方案专属特权标签 */}
                    <div className="mt-2.5 flex items-center gap-1.5 flex-wrap">
                      {tierTheme.features.slice(0, 4).map((feat, idx) => (
                        <span
                          key={idx}
                          className="text-[10px] font-medium px-2 py-0.5 rounded-md bg-background/60 border border-border/40 text-muted-foreground"
                        >
                          {feat}
                        </span>
                      ))}
                    </div>
                  </div>
                )
              })
            ) : (
              /* 免费版用户单个通栏卡 */
              <div className="p-4 rounded-2xl border border-border/60 bg-muted/20 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-5 h-5 text-muted-foreground" />
                    <span className="font-black text-sm text-foreground">{t('免费版方案')}</span>
                  </div>
                  <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-muted text-muted-foreground border border-border/60">
                    {t('基础服务')}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('当前正在使用基础版服务，您可以通过升级 Pro 或 Enterprise 解锁全功能与无限文件处理。')}
                </p>
                <div className="flex items-center gap-1.5 flex-wrap pt-1">
                  {theme.features.slice(0, 4).map((feat, idx) => (
                    <span
                      key={idx}
                      className="text-[10px] px-2 py-0.5 rounded-md bg-background/60 border border-border/40 text-muted-foreground"
                    >
                      {feat}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* ── 机器标识与萤火余额通栏 ── */}
          <div className="p-3 bg-muted/20 rounded-xl border border-border/40 flex items-center justify-between gap-3 text-xs">
            {identCode ? (
              <div className="flex items-center gap-2 min-w-0">
                <ShieldCheck className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                <span className="text-[11px] font-medium text-muted-foreground shrink-0">
                  {t('设备标识码：')}
                </span>
                <span className="font-mono text-[11px] text-foreground font-semibold truncate select-all">
                  {identCode}
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
                <span className="text-[11px] font-medium">{t('设备已受安全授权保护')}</span>
              </div>
            )}

            <div className="flex items-center gap-3 shrink-0">
              <div className="flex items-center gap-1 text-[11px] font-bold text-foreground">
                <Firecores className="w-3.5 h-3.5 text-amber-500" />
                <span>{firecores.toLocaleString()}</span>
              </div>

              {identCode && (
                <button
                  type="button"
                  onClick={() => copyToClipboard(identCode, 'ident')}
                  className="p-1 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                  title={t('复制设备识别码')}
                >
                  {copiedKey === 'ident' ? (
                    <Check className="w-3.5 h-3.5 text-emerald-500" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                </button>
              )}
            </div>
          </div>

          {/* ── 账单与自动续订管理模块 ── */}
          {paymentInfo?.method === 'creem' ? (
            <div className="p-4 bg-muted/40 rounded-2xl space-y-3 border border-border/50 relative overflow-hidden">
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-xl bg-primary/10 text-primary shrink-0 mt-0.5">
                  <CreditCard className="w-4 h-4" />
                </div>
                <div className="space-y-1 text-xs">
                  <p className="font-black text-foreground text-sm">
                    {t('自主账单与自动续费服务 (Customer Portal)')}
                  </p>
                  <p className="text-muted-foreground leading-relaxed text-[11px]">
                    {paymentInfo?.cancellation_portal?.instructions ||
                      t(
                        '您可以通过 Creem 国际客户门户随时下载往期发票收据、更新支付信用卡或关闭下期自动续费。关闭后当前计费周期内所有会员权益不受影响。'
                      )}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  onClick={handleOpenBillingPortal}
                  variant="outline"
                  className="flex-1 flex items-center justify-center gap-2 font-bold text-xs h-10 rounded-xl border border-primary/25 bg-background/80 hover:bg-accent hover:border-primary/50 text-foreground transition-all duration-200 shadow-2xs hover:shadow-sm cursor-pointer"
                >
                  <CreditCard className="w-4 h-4 text-primary" />
                  <span>{t('前往国际结算门户管理账单与续订')}</span>
                  <ExternalLink className="w-3.5 h-3.5 opacity-60 ml-0.5" />
                </Button>
                <Button
                  onClick={handleSyncStatus}
                  disabled={isSyncing}
                  variant="outline"
                  className="h-10 px-3 flex items-center justify-center gap-1.5 font-bold text-xs rounded-xl border border-border/60 bg-background/80 hover:bg-accent text-foreground transition-all duration-200 shadow-2xs hover:shadow-sm cursor-pointer shrink-0"
                  title={t('从云端立即刷新最新订阅状态')}
                >
                  <RefreshCw className={cn('w-3.5 h-3.5 text-primary', isSyncing && 'animate-spin')} />
                  <span>{isSyncing ? t('同步中...') : t('刷新状态')}</span>
                </Button>
              </div>
            </div>
          ) : (
            <div className="p-4 bg-muted/40 rounded-2xl space-y-2 border border-border/50 text-xs">
              <div className="flex items-center gap-2 font-black text-foreground">
                <ShieldCheck className="w-4 h-4 text-emerald-500 shrink-0" />
                <span>{t('固定周期授权保障')}</span>
              </div>
              <p className="text-muted-foreground leading-relaxed text-[11px]">
                {t(
                  '当前授权为无绑卡固定周期模式，绝无任何自动扣费与扣款风险。授权到期后系统将平滑降级为免费版，不会产生任何额外账单，如需延期请联系客服。'
                )}
              </p>
            </div>
          )}

          {/* ── 客户支持与联系渠道 ── */}
          <div className="p-3 bg-muted/20 rounded-2xl border border-border/40 flex flex-col sm:flex-row items-center justify-between gap-2.5 text-xs text-muted-foreground">
            <div className="flex items-center gap-2 min-w-0">
              <Mail className="w-3.5 h-3.5 text-primary shrink-0" />
              <span className="text-[11px] font-medium shrink-0">
                {t('售后支持：')}
              </span>
              <div className="shrink-0">
                <EmailSvg email={supportEmail} color="#3b82f6" fontSize={12} />
              </div>
              <button
                type="button"
                onClick={() => copyToClipboard(supportEmail, 'email')}
                className="p-1 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                title={t('复制客服邮箱')}
              >
                {copiedKey === 'email' ? (
                  <Check className="w-3 h-3 text-emerald-500" />
                ) : (
                  <Copy className="w-3 h-3" />
                )}
              </button>
            </div>

            {paymentInfo?.method === 'creem' && (
              <button
                type="button"
                onClick={() => openExternalLink('https://t.me/firefly_ai_folder')}
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-bold bg-sky-500/10 text-sky-500 hover:bg-sky-500/20 transition-colors cursor-pointer shrink-0"
              >
                <MessageCircle className="w-3 h-3" />
                <span>Telegram: @firefly_ai_folder</span>
              </button>
            )}
          </div>

          {/* ── 底部法律政策 ── */}
          <div className="flex justify-center items-center gap-3 text-[11px] text-muted-foreground/80 pt-1 border-t border-border/30">
            <button
              type="button"
              onClick={() => openExternalLink(privacyUrl)}
              className="hover:text-primary hover:underline transition-colors cursor-pointer"
            >
              {t('隐私政策')}
            </button>
            <span>•</span>
            <button
              type="button"
              onClick={() => openExternalLink(termsUrl)}
              className="hover:text-primary hover:underline transition-colors cursor-pointer"
            >
              {t('服务条款与权益须知')}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

