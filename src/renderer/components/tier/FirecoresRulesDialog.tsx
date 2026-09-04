import React, { useState, useEffect, useMemo } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'
import { t } from '@app/languages'
import {
  Check,
  Info,
  Flame as Firecores,
  ReceiptIndianRupee,
  Loader2,
  UserPlus,
  Gift,
  FolderPlus,
  Sparkles,
  Copy,
  Rocket,
  ExternalLink,
  ArrowRight,
  Lock,
  Unlock,
  Users,
  CheckCircle2,
  Trophy,
  Infinity as InfinityIcon,
  Zap
} from 'lucide-react'
import { MaterialIcon, cn, formatPrice } from '../../lib/utils'
import { Input } from '../ui/input'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import { encodeMachineIdToRef, formatDateTime } from '@firefly/shared'
import { toast } from '../common/Toast'
import { useTierStore } from '../../stores/tier-store'
import { useConfigStore } from '../../stores/config-store'
import { getFirecoreRules } from '../../constants/tier-rules'
import type { TierConstants } from '@firefly/types'
import { EmptyState } from '../common/EmptyState'
import { UpgradeAccountDialog } from './UpgradeAccountDialog'
import { openMarketingPricingUrl, getInviteLink } from '../../lib/marketing-link'

interface FirecoresRulesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultTab?: string
}

export const FirecoresRulesDialog: React.FC<FirecoresRulesDialogProps> = ({
  open,
  onOpenChange,
  defaultTab
}) => {
  const [machineId, setMachineId] = useState('')
  const [redeemCode, setRedeemCode] = useState('')
  const [isRedeeming, setIsRedeeming] = useState(false)
  const [hasCopied, setHasCopied] = useState(false)
  const [isUpgradeOpen, setIsUpgradeOpen] = useState(false)
  const { counters, firecores = 0 } = useTierStore()
  const wasInvited = counters?.is_invited === 1

  const config = useConfigStore(state => state.config)
  const tierConstants: TierConstants = (config as any)?.TIER_CONSTANTS

  const inviteQuotaBonus = tierConstants?.inviteQuotaBonus || 500
  const inviteFirecoreReward = tierConstants?.inviteFirecoreReward || 100
  const inviteFirecoreRewardInvitee = tierConstants?.inviteFirecoreRewardInvitee || 45
  const unlockThreshold = tierConstants?.prices?.spend_unlock_analysis || 300

  // 邀请人数统计（若后端无邀请人数，可由已获邀请奖励或萤火刻度推算展示）
  const invitedCount = Number(counters?.invite_count ?? counters?.invited_count ?? 0)

  // 萤火进度与刻度（目标按 300 萤火计算，每 100 萤火一个大刻度）
  const progressPercent = Math.min(100, Math.max(0, Math.round((firecores / unlockThreshold) * 100)))
  const neededFirecores = Math.max(0, unlockThreshold - firecores)
  const isUnlockedUnlimited = firecores >= unlockThreshold || Boolean(counters?.unlimited_analysis_unlocked)

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
  }, [open])

  if (!open) return null
  const inviteLink = getInviteLink(machineId)
  const text = `${t('我发现一个超好用的开源免费AI工具"萤核智能文件夹"，一键整理乱七八糟的桌面、下载目录等，AI自动分类/重命名/标签/描述/缩略图/归档/清理！利用本地AI能力保障隐私，创新虚拟目录整理技术保障文件安全!')}\n${inviteLink}`
  const handleCopyLink = async () => {
    try {
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
        <DialogContent className="max-w-3xl sm:max-w-4xl max-h-[82vh] overflow-hidden flex flex-col mt-10">
          <DialogHeader>
            <DialogTitle>{t('萤火规则')}</DialogTitle>
          </DialogHeader>

          <Tabs
            key={defaultTab || 'spend'}
            defaultValue={defaultTab || 'spend'}
            className="flex-1 min-h-0 overflow-hidden flex flex-col"
          >
            <TabsList className="grid w-full grid-cols-3 h-10 p-1 shrink-0 bg-muted/80 rounded-xl gap-1">
              <TabsTrigger
                value="earn"
                title={t('收集萤火')}
                className="flex items-center justify-center gap-1.5 min-w-0 rounded-lg transition-all"
              >
                <Firecores className="w-4 h-4 shrink-0 text-amber-500" />
                <span className="truncate min-w-0 text-xs sm:text-sm font-semibold">
                  {t('收集萤火')}
                </span>
              </TabsTrigger>
              <TabsTrigger
                value="consumption"
                title={t('收支流水')}
                className="flex items-center justify-center gap-1.5 min-w-0 rounded-lg transition-all"
              >
                <ReceiptIndianRupee className="w-4 h-4 shrink-0 text-emerald-500" />
                <span className="truncate min-w-0 text-xs sm:text-sm font-semibold">
                  {t('收支流水')}
                </span>
              </TabsTrigger>
              <TabsTrigger
                value="spend"
                title={t('消费规则')}
                className="flex items-center justify-center gap-1.5 min-w-0 rounded-lg transition-all"
              >
                <MaterialIcon icon="info" className="text-sm shrink-0 text-blue-500" />
                <span className="truncate min-w-0 text-xs sm:text-sm font-semibold">
                  {t('消费规则')}
                </span>
              </TabsTrigger>
            </TabsList>

            <TabsContent value="earn" className="flex-1 overflow-y-auto mt-4 pr-2">
              <div className="py-2 space-y-5">
                {/* 邀请好友里程碑 Stepper：形象表现 1~3 个好友及无限额度解锁，联动萤火刻度 */}
                <div className="relative overflow-hidden rounded-2xl border border-primary/25 bg-gradient-to-br from-primary/10 via-background to-card p-5 shadow-sm">
                  {/* 背景氛围晕染 */}
                  <div className="absolute -top-12 -right-12 w-44 h-44 bg-amber-500/10 dark:bg-amber-400/15 rounded-full blur-3xl pointer-events-none" />
                  <div className="absolute -bottom-10 -left-10 w-36 h-36 bg-primary/10 rounded-full blur-2xl pointer-events-none" />

                  {/* 标题 & 实时进度指示 */}
                  <div className="relative flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
                    <div className="flex items-center gap-3">
                      <div className="p-2.5 bg-primary/15 text-primary rounded-xl ring-4 ring-primary/5 shadow-inner">
                        <Trophy className="w-5 h-5" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="text-base font-black tracking-tight text-foreground">
                            {t('邀请好友，双方得奖 · 3位好友解锁无限额度')}
                          </h3>
                          {isUnlockedUnlimited ? (
                            <Badge className="bg-emerald-600/90 hover:bg-emerald-600 text-white text-[10px] px-2 py-0.2 shadow-sm font-bold">
                              <Unlock className="w-3 h-3 mr-1" />
                              {t('已解锁无限额度')}
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="border-amber-500/40 text-amber-600 dark:text-amber-400 bg-amber-500/10 text-[10px] px-2 py-0.2 font-semibold">
                              <Zap className="w-3 h-3 mr-1 text-amber-500" />
                              {t('每100萤火进阶')}
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground font-medium mt-0.5">
                          {t('每邀请1人即赠 {firecores} 萤火 + {bonus} 额度，集齐 300 萤火可永久兑换无限额度', {
                            firecores: inviteFirecoreReward,
                            bonus: inviteQuotaBonus
                          })}
                        </p>
                      </div>
                    </div>

                    {/* 联动当前萤火状态卡 */}
                    <div className="flex items-center gap-2 self-start sm:self-auto bg-background/80 dark:bg-background/50 backdrop-blur-md px-3 py-1.5 rounded-xl border border-border/80 shadow-sm shrink-0">
                      <Firecores className="w-4 h-4 text-amber-500 animate-pulse" />
                      <div className="text-xs">
                        <span className="text-muted-foreground">{t('当前拥有')} </span>
                        <span className="font-black text-amber-600 dark:text-amber-400 tabular-nums text-sm">
                          {firecores}
                        </span>
                        <span className="text-muted-foreground"> / {unlockThreshold} {t('萤火')}</span>
                      </div>
                    </div>
                  </div>

                  {/* 萤火刻度与阶段轨道 (Scale & Progress Bar) */}
                  <div className="relative mb-6 pt-2 px-1">
                    <div className="relative h-2.5 w-full rounded-full bg-muted/90 overflow-hidden border border-border/50">
                      {/* 动态进度条 */}
                      <div
                        className="h-full bg-gradient-to-r from-primary via-amber-500 to-amber-400 transition-all duration-500 rounded-full relative"
                        style={{ width: `${progressPercent}%` }}
                      >
                        <div className="absolute right-0 top-0 bottom-0 w-2 bg-white/60 rounded-full blur-[1px]" />
                      </div>
                    </div>

                    {/* 进度刻度标记点 (0, 100, 200, 300 萤火) */}
                    <div className="relative w-full flex justify-between mt-2 text-[10px] text-muted-foreground font-mono font-medium select-none">
                      <div className="flex flex-col items-center">
                        <span className="w-1.5 h-1.5 rounded-full bg-border -mt-3.5 mb-1" />
                        <span>0</span>
                      </div>
                      <div className="flex flex-col items-center">
                        <span className={cn('w-1.5 h-1.5 rounded-full -mt-3.5 mb-1 transition-colors', firecores >= 100 ? 'bg-amber-500 ring-2 ring-amber-500/20' : 'bg-border')} />
                        <span className={cn(firecores >= 100 && 'text-amber-600 dark:text-amber-400 font-bold')}>100</span>
                      </div>
                      <div className="flex flex-col items-center">
                        <span className={cn('w-1.5 h-1.5 rounded-full -mt-3.5 mb-1 transition-colors', firecores >= 200 ? 'bg-amber-500 ring-2 ring-amber-500/20' : 'bg-border')} />
                        <span className={cn(firecores >= 200 && 'text-amber-600 dark:text-amber-400 font-bold')}>200</span>
                      </div>
                      <div className="flex flex-col items-center">
                        <span className={cn('w-1.5 h-1.5 rounded-full -mt-3.5 mb-1 transition-colors', firecores >= 300 ? 'bg-emerald-500 ring-2 ring-emerald-500/20' : 'bg-border')} />
                        <span className={cn(firecores >= 300 && 'text-emerald-600 dark:text-emerald-400 font-bold')}>300 ({t('解锁无限')})</span>
                      </div>
                    </div>
                  </div>

                  {/* 3 阶段 Stepper 步骤卡片 */}
                  <div className="relative grid grid-cols-1 md:grid-cols-3 gap-3">
                    {/* Step 1: 1位好友 / 100 萤火 */}
                    <div
                      className={cn(
                        'relative flex flex-col justify-between rounded-xl p-3.5 transition-all border backdrop-blur-sm',
                        firecores >= 100
                          ? 'bg-primary/[0.07] border-primary/40 shadow-sm'
                          : 'bg-background/60 border-border/70 opacity-90'
                      )}
                    >
                      <div>
                        <div className="flex items-center justify-between gap-2 mb-2">
                          <span className={cn(
                            'text-[11px] font-black uppercase tracking-wider px-2 py-0.5 rounded-md flex items-center gap-1',
                            firecores >= 100 ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
                          )}>
                            <span>Step 1</span>
                            <span>·</span>
                            <span>{t('第1位好友')}</span>
                          </span>
                          {firecores >= 100 ? (
                            <span className="flex items-center gap-1 text-[11px] font-bold text-primary">
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              {t('已达成')}
                            </span>
                          ) : (
                            <span className="text-[10px] text-muted-foreground font-medium">
                              {t('需要 100 萤火')}
                            </span>
                          )}
                        </div>

                        <div className="space-y-1.5 my-1">
                          <div className="flex items-center gap-2 text-sm font-black text-foreground">
                            <Firecores className="w-4 h-4 text-amber-500 shrink-0" />
                            <span>+{inviteFirecoreReward} {t('您获萤火')}</span>
                          </div>
                          <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                            <FolderPlus className="w-4 h-4 text-orange-500 shrink-0" />
                            <span>+{inviteQuotaBonus} {t('双方各得额度')}</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Step 2: 2位好友 / 200 萤火 */}
                    <div
                      className={cn(
                        'relative flex flex-col justify-between rounded-xl p-3.5 transition-all border backdrop-blur-sm',
                        firecores >= 200
                          ? 'bg-amber-500/[0.08] border-amber-500/40 shadow-sm'
                          : firecores >= 100
                            ? 'bg-background/80 border-primary/25 ring-1 ring-primary/20'
                            : 'bg-background/60 border-border/70 opacity-90'
                      )}
                    >
                      <div>
                        <div className="flex items-center justify-between gap-2 mb-2">
                          <span className={cn(
                            'text-[11px] font-black uppercase tracking-wider px-2 py-0.5 rounded-md flex items-center gap-1',
                            firecores >= 200 ? 'bg-amber-500 text-white' : 'bg-muted text-muted-foreground'
                          )}>
                            <span>Step 2</span>
                            <span>·</span>
                            <span>{t('第2位好友')}</span>
                          </span>
                          {firecores >= 200 ? (
                            <span className="flex items-center gap-1 text-[11px] font-bold text-amber-600 dark:text-amber-400">
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              {t('已达成')}
                            </span>
                          ) : (
                            <span className="text-[10px] text-muted-foreground font-medium">
                              {t('累计 200 萤火')}
                            </span>
                          )}
                        </div>

                        <div className="space-y-1.5 my-1">
                          <div className="flex items-center gap-2 text-sm font-black text-foreground">
                            <Firecores className="w-4 h-4 text-amber-500 shrink-0" />
                            <span>{t('累计')} +{inviteFirecoreReward * 2} {t('您获萤火')}</span>
                          </div>
                          <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                            <FolderPlus className="w-4 h-4 text-orange-500 shrink-0" />
                            <span>{t('累计')} +{inviteQuotaBonus * 2} {t('双方各得额度')}</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Step 3: 3位好友 / 300 萤火 · 终极无限大奖 */}
                    <div
                      className={cn(
                        'relative flex flex-col justify-between rounded-xl p-3.5 transition-all border backdrop-blur-sm overflow-hidden',
                        firecores >= 300 || isUnlockedUnlimited
                          ? 'bg-gradient-to-br from-emerald-500/15 via-emerald-500/5 to-transparent border-emerald-500/50 shadow-md ring-1 ring-emerald-500/30'
                          : 'bg-gradient-to-br from-amber-500/[0.1] via-background to-card border-amber-500/40 shadow-xs'
                      )}
                    >
                      {/* 右上角光晕与无限角标 */}
                      <div className="absolute top-0 right-0 w-20 h-20 bg-amber-500/15 rounded-full blur-xl pointer-events-none" />

                      <div>
                        <div className="flex items-center justify-between gap-2 mb-2">
                          <span className={cn(
                            'text-[11px] font-black uppercase tracking-wider px-2 py-0.5 rounded-md flex items-center gap-1 shadow-sm',
                            firecores >= 300 || isUnlockedUnlimited
                              ? 'bg-emerald-600 text-white'
                              : 'bg-gradient-to-r from-amber-500 to-amber-600 text-white'
                          )}>
                            <span>Step 3</span>
                            <span>·</span>
                            <span>{t('第3位好友')}</span>
                          </span>
                          {firecores >= 300 || isUnlockedUnlimited ? (
                            <span className="flex items-center gap-1 text-xs font-black text-emerald-600 dark:text-emerald-400">
                              <Unlock className="w-3.5 h-3.5" />
                              {t('终极大奖')}
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-[11px] font-bold text-amber-600 dark:text-amber-400">
                              <Lock className="w-3.5 h-3.5" />
                              {t('需 300 萤火')}
                            </span>
                          )}
                        </div>

                        {/* 醒目放大的无限额度特权排版 */}
                        <div className="my-1.5">
                          <div className="flex items-center gap-2 text-sm sm:text-base font-black tracking-tight text-foreground">
                            <div className="p-1 rounded-md bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 shrink-0">
                              <InfinityIcon className="w-4 h-4" />
                            </div>
                            <span className="text-emerald-700 dark:text-emerald-300">
                              {t('解锁私有目录无限额度')}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* 通栏醒目解释：好友亦得奖与双向互惠特权横幅 */}
                  <div className="relative mt-3.5 overflow-hidden rounded-xl border border-emerald-500/30 bg-gradient-to-r from-emerald-500/15 via-emerald-500/5 to-transparent p-3 sm:px-4 sm:py-3 flex items-center justify-between gap-3 shadow-xs">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0 shadow-inner">
                        <Gift className="w-4 h-4 animate-bounce" />
                      </div>
                      <div className="text-xs leading-relaxed">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-black text-emerald-800 dark:text-emerald-200 text-sm">
                            {t('好友亦享专属福利')}
                          </span>
                          <Badge className="bg-emerald-600 hover:bg-emerald-600 text-white text-[10px] font-bold px-2 py-0 border-0">
                            {t('双方均有奖')}
                          </Badge>
                        </div>
                        <p className="text-muted-foreground mt-0.5">
                          {t('好友使用您的邀请码或链接，好友立得 ')}
                          <span className="font-black text-emerald-600 dark:text-emerald-400 text-xs">+{inviteFirecoreRewardInvitee} {t('萤火')}</span>
                          {t('，且双方立即各获 ')}
                          <span className="font-bold text-foreground text-xs">+{inviteQuotaBonus} {t('私有目录文件分析额度')}</span>
                        </p>
                      </div>
                    </div>
                  </div>
                </div>

                {/* 主操作：分享邀请链接 */}
                <div className="rounded-2xl border border-border/60 bg-card p-4 space-y-3 shadow-sm">
                  {/* 完整推荐语与链接预览区域 */}
                  <div className="relative rounded-xl border border-border/80 bg-muted/40 p-3.5">
                    <p className="text-foreground text-sm sm:text-[15px] leading-snug select-all whitespace-pre-wrap font-medium">
                      {text}
                    </p>
                  </div>

                  {/* 标题（左对齐）与复制按钮（右对齐）在同一排 */}
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-0.5">
                    <div className="flex items-center gap-2">
                      <MaterialIcon icon="share" className="text-primary text-lg" />
                      <h3 className="text-sm font-black tracking-tight text-foreground">
                        {t('分享您的专属邀请链接')}
                      </h3>
                      <span className="text-[11px] text-muted-foreground hidden sm:inline">
                        ({t('可直接复制上方文案发送给好友')})
                      </span>
                    </div>

                    <Button
                      size="sm"
                      onClick={handleCopyLink}
                      disabled={!machineId}
                      className={`h-9 px-4 transition-all shadow-xs gap-1.5 font-bold shrink-0 self-end sm:self-auto ${hasCopied ? 'bg-green-600 hover:bg-green-600' : ''}`}
                    >
                      {hasCopied ? (
                        <>
                          <Check className="w-4 h-4" />
                          <span>{t('已复制全文')}</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-4 h-4" />
                          <span>{t('复制推荐语与链接')}</span>
                        </>
                      )}
                    </Button>
                  </div>
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

                {/* 底部按需充值优化入口：高质感卡片与充值引导 */}
                <div className="relative overflow-hidden rounded-2xl border border-amber-500/30 bg-gradient-to-r from-amber-500/15 via-primary/10 to-background p-5 shadow-sm transition-all hover:border-amber-500/50">
                  <div className="absolute -right-8 -top-8 w-32 h-32 bg-amber-500/15 rounded-full blur-2xl pointer-events-none" />

                  <div className="relative flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                    <div className="flex items-start sm:items-center gap-3.5">
                      <div className="p-3 bg-gradient-to-br from-amber-500/20 to-amber-600/10 text-amber-500 rounded-2xl ring-1 ring-amber-500/30 shadow-inner shrink-0">
                        <Firecores className="w-6 h-6 animate-pulse" />
                      </div>
                      <div className="space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-black text-foreground tracking-tight">
                            {t('需要更多萤火？支持按需随心充值')}
                          </span>
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/25">
                            {t('永久有效 · 即买即用')}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          {t('无需订阅即可按需选购萤火点数加油包，支持随时兑换槽位与更多高阶功能。')}
                        </p>
                      </div>
                    </div>

                    <Button
                      size="sm"
                      className="shrink-0 font-bold shadow-md bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-white flex items-center gap-1.5 px-4 h-9 transition-all hover:scale-[1.02] active:scale-95"
                      onClick={() => openMarketingPricingUrl('buy_firecores')}
                    >
                      <span>{t('前往购买萤火')}</span>
                      <ArrowRight className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
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
        onOpenChange={(open) => {
          setIsUpgradeOpen(open)
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
                  className={`flex items-center justify-between p-4 rounded-2xl border transition-colors group ${isIncome
                      ? 'bg-green-500/[0.03] border-green-500/15 hover:bg-green-500/[0.06]'
                      : 'bg-muted/30 border-border/40 hover:bg-muted/50'
                    }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${isIncome ? 'bg-green-500/15 text-green-600' : 'bg-red-500/10 text-red-500'
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
                        className={`text-sm font-black tabular-nums ${isIncome ? 'text-green-600' : 'text-red-500'
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
