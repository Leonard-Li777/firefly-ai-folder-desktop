import React, { useState, useEffect, useMemo } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'
import { t } from '@app/languages'
import {
  Check,
  Info,
  Flame as Firecores,
  ShoppingCart,
  ReceiptIndianRupee,
  Loader2,
  UserPlus,
  Gift,
  FolderPlus,
  Sparkles,
  Copy,
  Rocket
} from 'lucide-react'
import { MaterialIcon, cn, getLocalPrice, formatPrice } from '../../lib/utils'
import { Input } from '../ui/input'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import { encodeMachineIdToRef } from '@firefly/shared'
import { toast } from '../common/Toast'
import { useTierStore } from '../../stores/tier-store'
import { useConfigStore } from '../../stores/config-store'
import { getFirecoreRules } from '../../constants/tier-rules'
import type { TierConstants, FirecorePurchaseTier, PaymentInfo } from '@firefly/types'
import { EmptyState } from '../common/EmptyState'
import { UpgradeAccountDialog } from './UpgradeAccountDialog'
import { formatDateTime } from '@firefly/shared'

interface FirecoreRulesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultTab?: string
}

export const FirecoreRulesDialog: React.FC<FirecoreRulesDialogProps> = ({
  open,
  onOpenChange,
  defaultTab
}) => {
  const [machineId, setMachineId] = useState('')
  const [redeemCode, setRedeemCode] = useState('')
  const [isRedeeming, setIsRedeeming] = useState(false)
  const [hasCopied, setHasCopied] = useState(false)
  const [qrSrc, setQrSrc] = useState<string>('')
  const [isUpgradeOpen, setIsUpgradeOpen] = useState(false)
  const { counters } = useTierStore()
  const wasInvited = counters?.is_invited === 1

  const config = useConfigStore(state => state.config)
  const tierConstants: TierConstants = (config as any)?.TIER_CONSTANTS
  const [purchaseFirecores, setPurchaseFirecores] = useState<FirecorePurchaseTier[] | undefined>(
    (config as any)?.OPERATION_PRICES?.purchase_firecores
  )
  const paymentInfo: PaymentInfo | undefined = (config as any)?.PAYMENT_INFO

  const inviteQuotaBonus = tierConstants?.inviteQuotaBonus || 500
  const inviteFirecoreReward = tierConstants?.inviteFirecoreReward || 100
  const inviteFirecoreRewardInvitee = tierConstants?.inviteFirecoreRewardInvitee || 45

  // getFirecoreRules 的返回类型（earn/spend 规则对象）
  type FirecoreRules = ReturnType<typeof getFirecoreRules>
  const rules: FirecoreRules = useMemo(() => {
    if (!open) return { earn: [], spend: [] } as FirecoreRules
    return getFirecoreRules(tierConstants?.prices || {})
  }, [open, tierConstants])

  // 注意：此 useEffect 必须位于任何条件 return 之前，以保持 hooks 调用顺序稳定
  useEffect(() => {
    if (!open) return
    window.electronAPI!.getMachineId().then(setMachineId)

    // 每次打开对话框时直接从主进程获取 OPERATION_PRICES，绕过所有缓存问题
    window.electronAPI!.getConfigValue('OPERATION_PRICES').then((prices: any) => {
      if (prices?.purchase_firecores) {
        setPurchaseFirecores(prices.purchase_firecores)
      }
    })

    if (__BUILD_REGION__ === 'CN') {
      const loadQR = async () => {
        try {
          const resourcesPath = await window.electronAPI.utils.getResourcesPath()
          const qrPath = paymentInfo?.qr_image || 'assets\\wechat-qr.jpg'
          const imagePath = `${resourcesPath}\\${qrPath.replace(/\//g, '\\')}`
          setQrSrc(`file:///${imagePath.replace(/\\/g, '/')}`)
        } catch (error) {
          console.error('加载微信二维码失败:', error)
        }
      }
      loadQR()
    }
  }, [open, paymentInfo?.qr_image])

  if (!open) return null

  const inviteLink = machineId
    ? `https://aifolder.iocn.cn?ref=${encodeMachineIdToRef(machineId)}`
    : ''

  const handleCopyLink = async () => {
    try {
      const text = `${t('我发现一个超好用的开源免费AI文件整理工具，一键整理乱七八糟的桌面、下载目录等，自动分类/重命名/归档，配截图！')}\n${inviteLink}`
      await navigator.clipboard.writeText(text)
      toast.success(t('邀请链接已复制'))
      // 复制成功反馈：按钮短暂切换为「已复制」
      setHasCopied(true)
      setTimeout(() => setHasCopied(false), 2000)
    } catch {
      toast.error(t('复制失败'))
    }
  }

  const handleRedeem = async () => {
    let code = redeemCode.trim()
    if (!code) return
    const base62Match = code.match(/[a-zA-Z0-9]{16}/)
    if (base62Match) code = base62Match[0]
    if (code.length !== 16) {
      toast.error(t('请输入有效的 16 位邀请码'))
      return
    }
    setIsRedeeming(true)
    try {
      const result = await window.electronAPI!.invitation.redeem(code)
      if (result.success) {
        toast.success(t('兑换成功！已增加 {amount} 个文件分析额度', { amount: inviteQuotaBonus }))
        setRedeemCode('')
      } else {
        toast.error(t('兑换失败: {error}', { error: result.error || t('未知错误') }))
      }
    } catch {
      toast.error(t('兑换请求失败'))
    } finally {
      setIsRedeeming(false)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl max-h-[78vh] overflow-hidden flex flex-col mt-14">
          <DialogHeader>
            <DialogTitle>{t('萤火规则')}</DialogTitle>
            <DialogDescription>{t('了解如何获取和使用萤火')}</DialogDescription>
          </DialogHeader>

          <Tabs
            key={defaultTab || 'spend'}
            defaultValue={defaultTab || 'spend'}
            className="mt-4 flex-1 overflow-hidden flex flex-col"
          >
            <TabsList className="grid w-full grid-cols-4">
              <TabsTrigger value="earn" className="flex items-center gap-2">
                <Firecores className="w-4 h-4" />
                {t('收集萤火')}
              </TabsTrigger>
              <TabsTrigger value="buy" className="flex items-center gap-2">
                <ShoppingCart className="w-4 h-4" />
                {t('购买萤火')}
              </TabsTrigger>
              <TabsTrigger value="consumption" className="flex items-center gap-2">
                <ReceiptIndianRupee className="w-4 h-4" />
                {t('收支流水')}
              </TabsTrigger>
              <TabsTrigger value="spend" className="flex items-center gap-2">
                <MaterialIcon icon="info" className="text-sm" />
                {t('消费规则')}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="buy" className="flex-1 overflow-y-auto mt-4 pr-2">
              <div className="py-2 space-y-5">
                {/* 头部提示 */}
                <div className="text-center space-y-3"></div>

                {/* 价格档位 */}
                <div className="grid grid-cols-4 gap-3">
                  {purchaseFirecores && purchaseFirecores.length > 0
                    ? purchaseFirecores.map((tier, idx) => {
                        const tags: string[] = []
                        if (idx === 1) tags.push(t('推荐'))
                        if (idx >= 2) tags.push(t('超值'))
                        const price = getLocalPrice(tier.prices)
                        return (
                          <div
                            key={idx}
                            className={cn(
                              'relative p-4 rounded-xl border flex flex-col items-center gap-2 transition-all',
                              idx === 1
                                ? 'border-primary bg-primary/5 shadow-md scale-105 z-10'
                                : 'border-border/50 hover:border-border/80'
                            )}
                          >
                            {idx >= 2 && (
                              <span className="absolute -top-2.5 px-2 py-0.5 bg-destructive text-[11px] font-black text-destructive-foreground rounded-full whitespace-nowrap">
                                {tags[0]}
                              </span>
                            )}
                            {idx === 1 && (
                              <span className="absolute -top-2.5 px-2 py-0.5 bg-primary text-[11px] font-black text-primary-foreground rounded-full whitespace-nowrap">
                                {tags[0]}
                              </span>
                            )}
                            <div className="flex items-center gap-1">
                              <Firecores className="w-5 h-5 text-amber-500" />
                              <span className="text-2xl font-black">{tier.firecores}</span>
                            </div>
                            <div className="text-sm font-black text-muted-foreground">
                              {formatPrice(price)}
                            </div>
                          </div>
                        )
                      })
                    : [
                        { firecores: 20, price: 5, tag: t('体验') },
                        { firecores: 50, price: 10, tag: t('推荐'), popular: true },
                        { firecores: 200, price: 30, tag: t('立省¥20'), hot: true },
                        { firecores: 500, price: 50, tag: t('半价'), hot: true }
                      ].map((item, idx) => (
                        <div
                          key={idx}
                          className={cn(
                            'relative p-4 rounded-xl border flex flex-col items-center gap-2 transition-all',
                            item.popular
                              ? 'border-primary bg-primary/5 shadow-md scale-105 z-10'
                              : 'border-border/50 hover:border-border/80'
                          )}
                        >
                          {item.hot && (
                            <span className="absolute -top-2.5 px-2 py-0.5 bg-destructive text-[9px] font-black text-destructive-foreground rounded-full whitespace-nowrap">
                              {item.tag}
                            </span>
                          )}
                          {item.popular && (
                            <span className="absolute -top-2.5 px-2 py-0.5 bg-primary text-[9px] font-black text-primary-foreground rounded-full whitespace-nowrap">
                              {item.tag}
                            </span>
                          )}
                          <div className="flex items-center gap-1">
                            <Firecores className="w-5 h-5 text-amber-500" />
                            <span className="text-2xl font-black">{item.firecores}</span>
                          </div>
                          <div className="text-sm font-black text-muted-foreground">
                            ¥{item.price}
                          </div>
                        </div>
                      ))}
                </div>

                {/* 二维码 + 标识码 + 升级帐户 并排 */}
                <div className="grid grid-cols-1 lg:grid-cols-[6fr_4fr] gap-5">
                  {/* 左侧：二维码 + 标识码 */}
                  <div className="flex items-center gap-5 p-5 rounded-xl border border-border/50 bg-muted/10">
                    {__BUILD_REGION__ === 'CN' ? (
                      <div className="shrink-0">
                        {qrSrc ? (
                          <div className="p-2 bg-white rounded-lg shadow-sm ring-1 ring-border/10">
                            <img
                              src={qrSrc}
                              alt={t('微信二维码')}
                              className="w-32 h-32 object-contain rounded"
                            />
                          </div>
                        ) : (
                          <div className="w-32 h-32 bg-muted/30 rounded-lg animate-pulse flex items-center justify-center">
                            <span className="text-xs text-muted-foreground">{t('加载中...')}</span>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="shrink-0">
                        <div className="p-4 bg-primary/10 rounded-xl flex items-center justify-center">
                          <MaterialIcon icon="payments" className="text-4xl text-primary" />
                        </div>
                      </div>
                    )}
                    <div className="flex-1 min-w-0 space-y-3 pt-1">
                      <div>
                        {__BUILD_REGION__ === 'CN' ? (
                          <>
                            <p className="text-sm font-black text-foreground">
                              {t('扫码添加管理员微信')}
                            </p>
                            <p className="text-xs text-muted-foreground mt-1">
                              {paymentInfo?.instructions || t('留言「购买萤火」即可快速开通')}
                            </p>
                            {paymentInfo?.contact && (
                              <p className="text-[11px] text-muted-foreground mt-0.5">
                                {t('或添加微信号：{id}', { id: paymentInfo.contact })}
                              </p>
                            )}
                          </>
                        ) : (
                          <>
                            <p className="text-sm font-black text-foreground">
                              {t('通过 PayPal 支付')}
                            </p>
                            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                              {paymentInfo?.instructions ||
                                t('请点击下方链接进行支付，并在备注中附上您的标识码')}
                            </p>
                            {paymentInfo?.paypal_me && (
                              <Button
                                variant="link"
                                className="h-auto p-0 text-xs font-bold text-primary mt-1"
                                onClick={() =>
                                  window.electronAPI.utils.openExternal(paymentInfo.paypal_me!)
                                }
                              >
                                {paymentInfo.paypal_me}
                                <MaterialIcon icon="open_in_new" className="text-[10px] ml-1" />
                              </Button>
                            )}
                          </>
                        )}
                      </div>
                      <div className="pt-2 border-t border-border/30">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[10px] font-bold text-muted-foreground shrink-0">
                            {t('我的标识码')}
                          </span>
                          <span className="font-mono text-[10px] text-muted-foreground truncate">
                            {encodeMachineIdToRef(machineId)}
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-4 w-4 p-0 shrink-0"
                            onClick={() => {
                              navigator.clipboard.writeText(encodeMachineIdToRef(machineId))
                              toast.success(t('已复制'))
                            }}
                          >
                            <Copy className="w-2.5 h-2.5" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* 右侧：升级帐户 */}
                  <div className="flex flex-col items-center justify-center p-5 rounded-xl border border-primary/20 bg-gradient-to-br from-primary/5 to-transparent">
                    <div className="text-center space-y-4">
                      <div className="w-12 h-12 mx-auto bg-primary/10 rounded-full flex items-center justify-center">
                        <Rocket className="w-6 h-6 text-primary" />
                      </div>
                      <div>
                        <p className="text-sm font-bold text-foreground">
                          {t('您也可以选择升级帐户')}
                        </p>
                      </div>
                      <Button onClick={() => setIsUpgradeOpen(true)} className="w-full">
                        {t('升级帐户')}
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="earn" className="flex-1 overflow-y-auto mt-4 pr-2">
              <div className="py-2 space-y-5">
                {/* 奖励总览 Hero：突出核心激励，三条奖励横向卡片 */}
                <div className="relative overflow-hidden rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/10 via-primary/5 to-transparent p-5">
                  <div className="absolute -top-8 -right-8 w-32 h-32 bg-primary/10 rounded-full blur-3xl pointer-events-none" />
                  <div className="relative flex items-center gap-3 mb-4">
                    <div className="p-2 bg-primary/15 rounded-xl ring-4 ring-primary/5">
                      <Sparkles className="w-5 h-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="text-base font-black tracking-tight leading-tight">
                        {t('邀请好友，双方都有奖')}
                      </h3>
                      <p className="text-xs text-muted-foreground font-medium mt-0.5">
                        {t('每成功邀请一位好友，立即解锁以下奖励')}
                      </p>
                    </div>
                  </div>

                  <div className="relative grid grid-cols-3 gap-3">
                    {/* 邀请者得币 */}
                    <div className="flex flex-col items-center text-center gap-2 rounded-xl bg-background/60 backdrop-blur-sm p-3 border border-primary/10 hover:border-primary/30 hover:-translate-y-0.5 transition-all">
                      <div className="w-9 h-9 rounded-lg bg-primary/15 flex items-center justify-center text-primary">
                        <UserPlus className="w-[18px] h-[18px]" />
                      </div>
                      <div className="text-xl font-black tabular-nums text-primary leading-none">
                        +{inviteFirecoreReward}
                      </div>
                      <div className="text-[11px] text-muted-foreground font-medium leading-tight">
                        {t('您获萤火')}
                      </div>
                    </div>
                    {/* 被邀请人得币 */}
                    <div className="flex flex-col items-center text-center gap-2 rounded-xl bg-background/60 backdrop-blur-sm p-3 border border-green-500/15 hover:border-green-500/30 hover:-translate-y-0.5 transition-all">
                      <div className="w-9 h-9 rounded-lg bg-green-500/15 flex items-center justify-center text-green-600">
                        <Gift className="w-[18px] h-[18px]" />
                      </div>
                      <div className="text-xl font-black tabular-nums text-green-600 leading-none">
                        +{inviteFirecoreRewardInvitee}
                      </div>
                      <div className="text-[11px] text-muted-foreground font-medium leading-tight">
                        {t('好友获萤火')}
                      </div>
                    </div>
                    {/* 双方额度增加 */}
                    <div className="flex flex-col items-center text-center gap-2 rounded-xl bg-background/60 backdrop-blur-sm p-3 border border-orange-500/15 hover:border-orange-500/30 hover:-translate-y-0.5 transition-all">
                      <div className="w-9 h-9 rounded-lg bg-orange-500/15 flex items-center justify-center text-orange-600">
                        <FolderPlus className="w-[18px] h-[18px]" />
                      </div>
                      <div className="text-xl font-black tabular-nums text-orange-600 leading-none">
                        +{inviteQuotaBonus}
                      </div>
                      <div className="text-[11px] text-muted-foreground font-medium leading-tight">
                        {t('双方各得文件额度')}
                      </div>
                    </div>
                  </div>
                </div>

                {/* 主操作：分享邀请链接 */}
                <div className="rounded-2xl border border-border/60 bg-card p-4 space-y-3 shadow-sm">
                  <div className="flex items-center gap-2">
                    <MaterialIcon icon="share" className="text-primary text-lg" />
                    <h3 className="text-sm font-black tracking-tight">
                      {t('分享您的专属邀请链接')}
                    </h3>
                  </div>
                  <div className="flex gap-2">
                    <div className="flex-1 bg-muted/50 border border-border rounded-lg px-3 py-2 text-sm text-foreground truncate select-all font-mono">
                      {inviteLink || t('正在获取...')}
                    </div>
                    <Button
                      size="sm"
                      onClick={handleCopyLink}
                      disabled={!machineId}
                      className={`shrink-0 min-w-[88px] transition-all ${hasCopied ? 'bg-green-600 hover:bg-green-600' : ''}`}
                    >
                      {hasCopied ? (
                        <>
                          <Check className="w-4 h-4 mr-1" />
                          {t('已复制')}
                        </>
                      ) : (
                        <>
                          <Copy className="w-4 h-4 mr-1" />
                          {t('复制链接')}
                        </>
                      )}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {t(
                      '发送链接给好友，好友使用邀请码后，您获得 {firecores} 萤火，双方获得 {bonus} 个私有目录分析额度。',
                      { firecores: inviteFirecoreReward, bonus: inviteQuotaBonus }
                    )}
                  </p>
                </div>

                {/* 次操作：我有邀请码 */}
                {!wasInvited && (
                  <div className="rounded-2xl border border-dashed border-orange-500/30 bg-orange-500/[0.03] p-4 space-y-3">
                    <div className="flex items-center gap-2">
                      <MaterialIcon
                        icon="confirmation_number"
                        className="text-orange-500 text-lg"
                      />
                      <h3 className="text-sm font-black tracking-tight">
                        {t('我有邀请码 / 邀请链接')}
                      </h3>
                    </div>
                    <div className="flex gap-2">
                      <Input
                        placeholder={t('在此输入 16 位邀请码或链接')}
                        value={redeemCode}
                        onChange={e => setRedeemCode(e.target.value)}
                        className="flex-1"
                      />
                      <Button
                        variant="outline"
                        onClick={handleRedeem}
                        disabled={isRedeeming || !redeemCode.trim()}
                        className="shrink-0 border-orange-500/60 text-orange-600 hover:bg-orange-50 hover:border-orange-500"
                      >
                        {isRedeeming ? (
                          <MaterialIcon icon="sync" className="animate-spin mr-1" />
                        ) : null}
                        {t('立即领取')}
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      {t(
                        '如果您知道他人的邀请码或链接，输入后双方均可立即获取 {bonus} 个分析额度奖励，您还能获得 {firecores} 萤火。',
                        { bonus: inviteQuotaBonus, firecores: inviteFirecoreRewardInvitee }
                      )}
                    </p>
                  </div>
                )}
              </div>
            </TabsContent>

            <TabsContent value="spend" className="flex-1 overflow-y-auto mt-4 pr-2">
              <div className="space-y-4">
                <div className="border rounded-lg overflow-hidden">
                  <table className="w-full text-sm text-left">
                    <thead className="bg-muted text-muted-foreground font-medium">
                      <tr>
                        <th className="px-4 py-3">{t('操作类型')}</th>
                        <th className="px-4 py-3">{t('免费版')}</th>
                        <th className="px-4 py-3 text-amber-600">{t('专业版')}</th>
                        <th className="px-4 py-3 text-purple-600">{t('企业版')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {rules.spend.map(rule => (
                        <tr key={rule.operation} className="hover:bg-muted/30 transition-colors">
                          <td className="px-4 py-3">
                            <div className="font-medium">
                              {rule.description}
                              {rule.isPermanent && (
                                <span className="text-[10px] bg-primary/10 text-primary px-1 rounded">
                                  {t('永久')}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3 tabular-nums">
                            {rule.freePrice > 0 ? (
                              <span>
                                {rule.freePrice} {t('萤火')}
                              </span>
                            ) : (
                              <span className="text-green-600 font-medium">{t('免费')}</span>
                            )}
                          </td>
                          <td className="px-4 py-3 tabular-nums font-medium text-amber-600">
                            {rule.proPrice > 0 ? (
                              <span>
                                {rule.proPrice} {t('萤火')}
                              </span>
                            ) : (
                              <div className="flex items-center gap-1 text-green-600">
                                <Check className="w-4 h-4" />
                                <span>{t('免费')}</span>
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3 tabular-nums font-medium text-purple-600">
                            {rule.enterprisePrice > 0 ? (
                              <span>
                                {rule.enterprisePrice} {t('萤火')}
                              </span>
                            ) : (
                              <div className="flex items-center gap-1 text-green-600">
                                <Check className="w-4 h-4" />
                                <span>{t('免费')}</span>
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg flex gap-3 text-xs text-blue-700 dark:text-blue-300">
                  <Info className="w-4 h-4 flex-shrink-0" />
                  <p>{t('萤火消费遵循"先扣除、后使用"的原则。部分功能解锁后永久有效')}</p>
                </div>
              </div>
            </TabsContent>

            <TabsContent
              value="consumption"
              className="flex-1 overflow-y-auto mt-4 pr-2 flex flex-col"
            >
              <ConsumptionDetailTab />
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>
      <UpgradeAccountDialog
        open={isUpgradeOpen}
        onOpenChange={(open, isNavigatingToPro) => {
          setIsUpgradeOpen(open)
          // 如果用户正在导航到Pro/Enterprise页面，同时关闭萤火规则弹层
          if (!open && isNavigatingToPro) {
            onOpenChange(false)
          }
        }}
      />
    </>
  )
}

/**
 * 收支流水 Tab 内容
 * 展示用户的萤火收入与支出记录，切到该 Tab 时自动拉取最新数据
 */
const ConsumptionDetailTab: React.FC = () => {
  const { consumptionDetails, fetchConsumptionDetails, isLoading } = useTierStore()

  useEffect(() => {
    fetchConsumptionDetails()
    // 打开流水页面时从云端同步等级数据并检查授权
    if (window.electronAPI?.userTier?.syncFromCloud) {
      window.electronAPI.userTier.syncFromCloud().then(profile => {
        if (profile.tier !== 'enterprise' && profile.tier !== 'pro' && profile.tier !== 'agent') {
          // 等级降级（到期/取消），通知前端刷新
          if (window.electronAPI?.license?.getStatus) {
            window.electronAPI.license.getStatus().then(result => {
              if (result.status !== 'AUTHORIZED') {
                window.dispatchEvent(new CustomEvent('app:unauthorized', { detail: result }))
              }
            })
          }
        }
      })
    } else if (window.electronAPI?.license?.getStatus) {
      window.electronAPI.license.getStatus().then(result => {
        if (result.status !== 'AUTHORIZED') {
          window.dispatchEvent(new CustomEvent('app:unauthorized', { detail: result }))
        }
      })
    }
  }, [fetchConsumptionDetails])

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed':
        return 'bg-green-500/10 text-green-500 border-green-500/20'
      case 'pending':
        return 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20'
      case 'failed':
        return 'bg-red-500/10 text-red-500 border-red-500/20'
      case 'syncing':
        return 'bg-blue-500/10 text-blue-500 border-blue-500/20'
      default:
        return 'bg-gray-500/10 text-gray-500 border-gray-500/20'
    }
  }

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'completed':
        return t('已完成')
      case 'pending':
        return t('待同步')
      case 'failed':
        return t('失败')
      case 'syncing':
        return t('同步中')
      default:
        return status
    }
  }

  const getTypeLabel = (type: string) => {
    switch (type) {
      case 'welcome_grant':
        return t('首次使用，欢迎赠送')
      case 'invitation_earn':
        return t('邀请奖励')
      case 'invitation_receive':
        return t('被邀请奖励')
      case 'spend_unlock_analysis':
        return t('解锁私有目录无限分析额度')
      case 'spend_extra_private_dir_slot':
        return t('购买私有目录')
      case 'spend_extra_speedy_dir_slot':
        return t('购买极速目录')
      case 'spend_extra_vdir_slot':
        return t('购买虚拟目录')
      case 'spend_access_vdir':
        return t('开通虚拟目录访问权限')
      case 'spend_export_vdir':
        return t('导出虚拟目录')
      case 'spend_export_rdir':
        return t('导出真实目录')
      case 'spend_download_file':
        return t('下载文件')
      case 'spend_cloud_decompress':
        return t('云解压')
      case 'spend_get_password':
        return t('获取密码')
      case 'spend_regenerate_vdir':
        return t('重新生成虚拟目录')
      case 'upload_earn':
        return t('上传收益')
      case 'admin_adjust':
        return t('管理员调整')
      default:
        return type
    }
  }

  return (
    <div className="flex-1 flex flex-col p-1">
      {isLoading ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-primary/50" />
          <p className="text-sm font-bold text-muted-foreground">{t('正在加载收支流水...')}</p>
        </div>
      ) : consumptionDetails.length > 0 ? (
        <div className="space-y-3">
          {[...consumptionDetails]
            .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
            .map((item: any, index: number) => {
              const isIncome = item.firecores > 0
              return (
                <div
                  key={index}
                  className={`flex items-center justify-between p-4 rounded-2xl border transition-colors group ${
                    isIncome
                      ? 'bg-green-500/[0.03] border-green-500/15 hover:bg-green-500/[0.06]'
                      : 'bg-muted/30 border-border/40 hover:bg-muted/50'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                        isIncome ? 'bg-green-500/15 text-green-600' : 'bg-red-500/10 text-red-500'
                      }`}
                    >
                      <span className="text-sm font-black">{isIncome ? '+' : '-'}</span>
                    </div>
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <span className="text-sm font-black tracking-tight truncate">
                        {getTypeLabel(item.type)}
                      </span>
                      {/* admin_adjust 显示操作详情 */}
                      {item.type === 'admin_adjust' && item.metadata?.income_operation && (
                        <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] font-bold text-muted-foreground/80">
                          {item.metadata.income_operation.type === 'upgrade' && (
                            <>
                              <span>
                                {item.metadata.income_operation.tier?.toUpperCase() === 'PRO'
                                  ? t('升级 PRO')
                                  : item.metadata.income_operation.tier?.toUpperCase() ===
                                      'ENTERPRISE'
                                    ? t('升级 Enterprise')
                                    : item.metadata.income_operation.tier || ''}
                              </span>
                              {item.metadata.income_operation.plan && (
                                <span>
                                  {item.metadata.income_operation.plan}
                                  {item.metadata.income_operation.period_count
                                    ? ` (${item.metadata.income_operation.period_count}${item.metadata.income_operation.period_unit === 'month' ? t('个月') : t('年')})`
                                    : ''}
                                </span>
                              )}
                              {item.metadata.income_operation.quantity &&
                                item.metadata.income_operation.quantity > 1 && (
                                  <span>x{item.metadata.income_operation.quantity}</span>
                                )}
                              {item.metadata.income_operation.amount != null && (
                                <span>
                                  {formatPrice({
                                    currency: 'CNY',
                                    amount: item.metadata.income_operation.amount
                                  })}
                                </span>
                              )}
                            </>
                          )}
                          {item.metadata.income_operation.type === 'purchase_firecores' && (
                            <>
                              <span>{t('充值萤火')}</span>
                              {item.metadata.income_operation.firecore_key && (
                                <span>
                                  {t('档位')}: {item.metadata.income_operation.firecore_key}
                                </span>
                              )}
                              {item.metadata.income_operation.quantity &&
                                item.metadata.income_operation.quantity > 1 && (
                                  <span>x{item.metadata.income_operation.quantity}</span>
                                )}
                            </>
                          )}
                        </div>
                      )}
                      <div className="flex items-center gap-2 text-[11px] font-bold text-muted-foreground">
                        <span>{formatDateTime(item.time, { showSeconds: true })}</span>
                        {item.balance_after != null && (
                          <span className="text-muted-foreground/60">
                            {t('余额')}: {item.balance_after}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <div className="flex flex-col items-end gap-1">
                      <span
                        className={`text-sm font-black tabular-nums ${
                          isIncome ? 'text-green-600' : 'text-red-500'
                        }`}
                      >
                        {isIncome ? '+' : ''}
                        {item.firecores} {t('萤火')}
                      </span>
                      {item.status !== 'completed' && (
                        <Badge
                          variant="outline"
                          className={`text-[10px] font-black px-2 py-0 h-5 rounded-full border-none ${getStatusColor(
                            item.status
                          )}`}
                        >
                          {getStatusLabel(item.status)}
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center py-12">
          <EmptyState
            title={t('暂无收支记录')}
            description={t('您还没有萤火相关的收入或支出记录')}
          />
        </div>
      )}
    </div>
  )
}
