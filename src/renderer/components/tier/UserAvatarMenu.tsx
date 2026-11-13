import {
  ChevronDown,
  ChevronRight,
  Flame as Firecores,
  Info,
  ListOrdered,
  MessageCircle,
  QrCode,
  RotateCcw,
  Settings,
  User,
  Bot,
  KeyRound,
  Sparkles,
  Building2,
  CalendarClock,
  ReceiptText,
  ExternalLink,
  LogOut
} from 'lucide-react'
import React, { useCallback, useEffect, useRef, useState } from 'react'

import { AboutDialog } from '../settings/about-dialog'
import { UpgradeAccountDialog } from './UpgradeAccountDialog'
import { AccountManagementDialog } from './AccountManagementDialog'
import { ActivationCodeDialog } from './ActivationCodeDialog'
import { UserTier, formatDateOnly, formatSubscriptionExpiry } from '@firefly/shared'
import { SettingsCategory } from '@firefly/types'
import { toast } from '../common/Toast'
import { isEngineServiceReady } from '../../lib/engine-status-badge'
import { WechatQRDialog } from './WechatQRDialog'
import { cn } from '../../lib/utils'
import { createPortal } from 'react-dom'
import { openExternalLink } from '../../lib/external-link'
import { openMarketingPricingUrl } from '../../lib/marketing-link'
import { t } from '@app/languages'
import { useLocation } from 'react-router-dom'
import { useSettingsStore } from '../../stores/settings-store'
import { useTierStore } from '../../stores/tier-store'
import { useConfigStore } from '../../stores/config-store'
import { useAnalysisQueueStore } from '../../stores/analysis-queue-store'
import { Button } from '../ui/button'

interface UserAvatarMenuProps {
  onOpenChange?: (isOpen: boolean) => void
}

export const UserAvatarMenu: React.FC<UserAvatarMenuProps> = ({ onOpenChange }) => {
  const { tier, firecores, subscription, fetchProfile, openRulesDialog, logout } = useTierStore()
  const { openSettings } = useSettingsStore()
  const config = useConfigStore(state => state.config)
  const location = useLocation()

  const [isOpen, setIsOpenState] = useState(false)
  const [isLoggingOut, setIsLoggingOut] = useState(false)
  const updateIsOpen = useCallback(
    (open: boolean) => {
      setIsOpenState(open)
      onOpenChange?.(open)
    },
    [onOpenChange]
  )

  const [isUpgradeOpen, setIsUpgradeOpen] = useState(false)
  const [isAccountManagementOpen, setIsAccountManagementOpen] = useState(false)
  const [isActivationCodeOpen, setIsActivationCodeOpen] = useState(false)
  const [isAboutOpen, setIsAboutOpen] = useState(false)
  const [isWechatQROpen, setIsWechatQROpen] = useState(false)

  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    fetchProfile()
  }, [fetchProfile])

  // 展开头像菜单时，主动拉取最新资产与等级数据，确保余额显示即时无延迟
  useEffect(() => {
    if (isOpen) {
      fetchProfile()
    }
  }, [isOpen, fetchProfile])

  const getTierConfig = useCallback((tier: UserTier) => {
    switch (tier) {
      case UserTier.ENTERPRISE:
        return {
          name: t('企业版'),
          bgClass: 'bg-purple-500/15 text-purple-600 dark:text-purple-400',
          textClass: 'text-purple-600 dark:text-purple-400',
          borderClass: 'border-purple-500/30',
          badgeClass:
            'bg-gradient-to-r from-purple-500 to-indigo-600 text-white shadow-purple-500/20',
          ringClass: 'hover:ring-1 hover:ring-purple-500/50',
          arrowClass: 'text-purple-500/70'
        }
      case UserTier.AGENT:
        return {
          name: t('代理版'),
          bgClass: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
          textClass: 'text-emerald-600 dark:text-emerald-400',
          borderClass: 'border-emerald-500/30',
          badgeClass:
            'bg-gradient-to-r from-emerald-500 to-teal-600 text-white shadow-emerald-500/20',
          ringClass: 'hover:ring-1 hover:ring-emerald-500/50',
          arrowClass: 'text-emerald-500/70'
        }
      case UserTier.PRO:
        return {
          name: t('Pro 专业版'),
          bgClass: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
          textClass: 'text-amber-600 dark:text-amber-400',
          borderClass: 'border-amber-500/30',
          badgeClass:
            'bg-gradient-to-r from-amber-500 to-orange-500 text-white shadow-amber-500/20',
          ringClass: 'hover:ring-1 hover:ring-amber-500/50',
          arrowClass: 'text-amber-500/70'
        }
      default:
        return {
          name: t('免费版'),
          bgClass: 'bg-muted text-muted-foreground',
          textClass: 'text-muted-foreground',
          borderClass: 'border-border/50',
          badgeClass: 'bg-secondary text-secondary-foreground',
          ringClass: 'hover:ring-1 hover:ring-border',
          arrowClass: 'text-muted-foreground/70'
        }
    }
  }, [])

  const tierConfig = getTierConfig(tier)

  // 订阅有效期状态：仅付费会员展示；临期（30天内）橙色提醒，已过期红色
  const expiryDate = subscription?.expires_at ? new Date(subscription.expires_at) : null
  const isExpired = expiryDate ? expiryDate.getTime() < Date.now() : false
  const isExpiringSoon = expiryDate
    ? !isExpired && expiryDate.getTime() - Date.now() < 30 * 24 * 60 * 60 * 1000
    : false
  const expiryTextClass = isExpired
    ? 'text-red-500 dark:text-red-400 font-semibold'
    : isExpiringSoon
      ? 'text-amber-600 dark:text-amber-400 font-semibold'
      : 'text-muted-foreground font-medium'

  // 多档位独立有效期管理：判断当前是否是企业版并持有未过期的 Pro 版接续期
  const tierPeriods = subscription?.tier_periods
  const proPeriod = tierPeriods?.pro
  const proExpiresAt = proPeriod?.expires_at
  const hasProReserve =
    tier === UserTier.ENTERPRISE &&
    Boolean(
      proExpiresAt &&
      new Date(proExpiresAt).getTime() > Date.now() &&
      proPeriod?.status !== 'refunded'
    )

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(event.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(event.target as Node)
      ) {
        updateIsOpen(false)
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    } else {
      document.removeEventListener('mousedown', handleClickOutside)
    }

    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen, updateIsOpen])

  const [menuPosition, setMenuPosition] = useState({ top: 0, right: 0 })

  useEffect(() => {
    if (isOpen && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect()
      setMenuPosition({
        top: rect.bottom + 8,
        right: window.innerWidth - rect.right
      })
    }
  }, [isOpen])

  const handleMenuClick = (action: () => void | Promise<void>) => {
    action()
    updateIsOpen(false)
  }

  // 主行动按钮配置：根据用户当前等级动态调整文案、图标、跳转目标及渐变风格，但保持黄金入口位置绝对不变
  const primaryActionConfig = (() => {
    switch (tier) {
      case UserTier.ENTERPRISE:
        return {
          label: t('充值萤火'),
          icon: <Firecores className="w-4 h-4 shrink-0 text-white" />,
          action: () => openMarketingPricingUrl('buy_firecores'),
          className:
            'bg-gradient-to-r from-amber-500 to-orange-600 text-white shadow-amber-500/20 hover:from-amber-600 hover:to-orange-700'
        }
      case UserTier.PRO:
        return {
          label: t('充值萤火'),
          icon: <Firecores className="w-4 h-4 shrink-0 text-white" />,
          action: () => openMarketingPricingUrl('buy_firecores'),
          className:
            'bg-gradient-to-r from-amber-500 to-orange-600 text-white shadow-amber-500/20 hover:from-amber-600 hover:to-orange-700'
        }
      case UserTier.AGENT:
        return {
          label: t('升级企业版'),
          icon: <Building2 className="w-4 h-4 shrink-0 text-white" />,
          action: () => openMarketingPricingUrl('enterprise'),
          className:
            'bg-gradient-to-r from-emerald-500 to-teal-600 text-white shadow-emerald-500/20 hover:from-emerald-600 hover:to-teal-700'
        }
      default:
        return {
          label: t('升级帐户'),
          icon: <Sparkles className="w-4 h-4 shrink-0 text-white" />,
          action: () => openMarketingPricingUrl('upgrade_pro'),
          className:
            'bg-gradient-to-r from-sky-500 to-blue-600 text-white shadow-sky-500/20 hover:from-sky-600 hover:to-blue-700'
        }
    }
  })()

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        data-no-drag
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        onClick={() => updateIsOpen(!isOpen)}
        className={cn(
          'relative flex items-center gap-1.5 px-1 py-1 rounded-full transition-all active:scale-95 hover:bg-accent/50 cursor-pointer',
          tierConfig.ringClass
        )}
      >
        <div
          className={cn(
            'flex items-center justify-center w-7 h-7 rounded-full',
            tierConfig.bgClass
          )}
        >
          <User className={cn('w-4 h-4', tierConfig.textClass)} />
        </div>
        <ChevronDown
          className={cn(
            'w-3.5 h-3.5 transition-transform duration-200',
            isOpen && 'rotate-180',
            tierConfig.arrowClass
          )}
        />
      </button>

      {isOpen &&
        createPortal(
          <>
            {/* 全屏透明遮罩：阻断底层所有窗口拖拽 (drag) 区域，并处理点击外部关闭 */}
            <div
              data-no-drag
              className="fixed inset-0 z-[99] no-drag"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
              onPointerDown={e => {
                e.stopPropagation()
                updateIsOpen(false)
              }}
            />

            <div
              ref={menuRef}
              data-no-drag
              className={cn(
                'fixed z-[100] w-[352px] max-w-[calc(100vw-24px)] bg-card/98 text-card-foreground border border-border/80 rounded-2xl shadow-2xl overflow-hidden animate-in fade-in-0 zoom-in-95 duration-200 no-drag ring-1 ring-black/5 dark:ring-white/10'
              )}
              style={
                {
                  top: menuPosition.top,
                  right: menuPosition.right,
                  backdropFilter: 'blur(20px)',
                  WebkitBackdropFilter: 'blur(20px)',
                  WebkitAppRegion: 'no-drag'
                } as React.CSSProperties
              }
            >
              {/* 层级一 & 二：会员身份资产复合卡片 */}
              <div className="p-3.5 pb-2.5 relative">
                <div
                  className={cn(
                    'rounded-xl border p-3.5 relative overflow-hidden transition-all shadow-sm',
                    tier === UserTier.ENTERPRISE
                      ? 'bg-gradient-to-br from-purple-500/[0.08] via-indigo-500/[0.03] to-transparent border-purple-500/20'
                      : tier === UserTier.PRO
                        ? 'bg-gradient-to-br from-amber-500/[0.08] via-yellow-500/[0.03] to-transparent border-amber-500/20'
                        : tier === UserTier.AGENT
                          ? 'bg-gradient-to-br from-emerald-500/[0.08] via-teal-500/[0.03] to-transparent border-emerald-500/20'
                          : 'bg-muted/40 border-border/60'
                  )}
                >
                  {/* 装饰性背景微光晕 */}
                  <div
                    className={cn(
                      'absolute -right-8 -top-8 w-28 h-28 rounded-full blur-2xl pointer-events-none opacity-50',
                      tier === UserTier.ENTERPRISE
                        ? 'bg-purple-500/25'
                        : tier === UserTier.PRO
                          ? 'bg-amber-500/25'
                          : tier === UserTier.AGENT
                            ? 'bg-emerald-500/25'
                            : 'bg-muted'
                    )}
                  />

                  {/* 1. 顶部身份首行：等级徽章 与 退出登录 / 管理订阅入口 */}
                  <div className="flex items-center justify-between gap-2 relative z-10">
                    <span
                      className={cn(
                        'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold tracking-wide shadow-sm select-none shrink-0',
                        tierConfig.badgeClass
                      )}
                    >
                      {tierConfig.name}
                    </span>

                    <div className="flex items-center gap-1.5 shrink-0">
                      {tier !== UserTier.FREE && (
                        <button
                          type="button"
                          data-no-drag
                          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                          onClick={e => {
                            e.stopPropagation()
                            handleMenuClick(() => {
                              setIsAccountManagementOpen(true)
                            })
                          }}
                          className="inline-flex items-center gap-1 text-xs font-semibold text-muted-foreground hover:text-foreground hover:bg-accent/80 transition-all px-2 py-1 rounded-lg cursor-pointer no-drag select-none group border border-border/40 hover:border-border/80 bg-background/50 shadow-xs"
                          title={t('管理订阅与权益')}
                        >
                          <span>{t('管理订阅')}</span>
                          <ChevronRight className="w-3 h-3 text-muted-foreground/70 group-hover:text-foreground group-hover:translate-x-0.5 transition-all" />
                        </button>
                      )}

                      <button
                        type="button"
                        data-no-drag
                        data-testid="user-avatar-logout-btn"
                        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                        disabled={isLoggingOut}
                        onClick={async e => {
                          e.stopPropagation()
                          setIsLoggingOut(true)
                          try {
                            updateIsOpen(false)
                            await logout()
                          } finally {
                            setIsLoggingOut(false)
                          }
                        }}
                        className="inline-flex items-center gap-1 text-xs font-semibold text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all px-2 py-1 rounded-lg cursor-pointer no-drag select-none group border border-border/40 hover:border-destructive/30 bg-background/50 shadow-xs"
                        title={t('退出登录')}
                      >
                        <LogOut className="w-3 h-3 text-muted-foreground/70 group-hover:text-destructive transition-colors shrink-0" />
                        <span>{isLoggingOut ? t('退出中...') : t('退出登录')}</span>
                      </button>
                    </div>
                  </div>

                  {/* 2. 独立有效期展示行：仅付费会员展示，从容容纳中英文长格式日期，不挤压首行 */}
                  {tier !== UserTier.FREE && (
                    <div className="flex items-center gap-1.5 mt-2.5 text-xs relative z-10 select-none">
                      <CalendarClock className="w-3.5 h-3.5 text-muted-foreground/70 shrink-0" />
                      {subscription?.expires_at ? (
                        <div className="flex items-center gap-1 text-[11px] leading-none min-w-0">
                          <span className="text-muted-foreground/80 shrink-0">{t('有效期至')}</span>
                          <span
                            className={cn('tabular-nums font-semibold truncate', expiryTextClass)}
                          >
                            {formatSubscriptionExpiry(subscription.expires_at, subscription.plan)}
                          </span>
                          {isExpired && (
                            <span className="text-[10px] px-1.5 py-0.2 rounded bg-red-500/10 text-red-500 font-bold shrink-0">
                              {t('已过期')}
                            </span>
                          )}
                          {isExpiringSoon && (
                            <span className="text-[10px] px-1.5 py-0.2 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 font-bold shrink-0">
                              {t('即将到期')}
                            </span>
                          )}
                          {hasProReserve && (
                            <span
                              className="text-[10px] px-1.5 py-0.2 rounded bg-purple-500/10 text-purple-600 dark:text-purple-400 font-bold shrink-0"
                              title={t('企业版到期后自动接续 Pro 版')}
                            >
                              {t('接续 Pro')}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-[11px] text-muted-foreground/80 font-medium">
                          {t('已激活永久有效')}
                        </span>
                      )}
                    </div>
                  )}

                  {/* 3. 萤火资产大卡：大数值余额与收支流水 */}
                  <div className="mt-3 pt-3 border-t border-border/40 relative z-10">
                    <button
                      type="button"
                      onClick={() =>
                        handleMenuClick(() => {
                          openRulesDialog('consumption')
                        })
                      }
                      className="w-full flex items-center justify-between gap-3 text-left group cursor-pointer transition-transform duration-200 hover:scale-[1.01]"
                      title={t('点击查看收支流水')}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="p-2.5 bg-amber-500/10 rounded-xl ring-1 ring-amber-500/20 shrink-0 transition-all duration-200 group-hover:ring-amber-500/40 group-hover:bg-amber-500/15">
                          <Firecores className="w-5 h-5 text-amber-500 animate-pulse" />
                        </div>
                        <div className="min-w-0">
                          <div className="text-[11px] text-muted-foreground font-semibold uppercase tracking-wider leading-tight">
                            {t('萤火余额')}
                          </div>
                          <div className="text-2xl font-black tabular-nums leading-tight tracking-tight mt-0.5 text-foreground truncate">
                            {firecores.toLocaleString()}
                          </div>
                        </div>
                      </div>

                      {/* 显式流水明细入口：右侧胶囊，空间充裕且自然展开 */}
                      <div className="inline-flex shrink-0 max-w-[150px] items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-muted-foreground group-hover:text-foreground bg-background/60 group-hover:bg-accent/80 border border-border/50 group-hover:border-border transition-all select-none shadow-2xs">
                        <ReceiptText className="w-3.5 h-3.5 text-amber-500/80 group-hover:text-amber-500 transition-colors shrink-0" />
                        <span className="text-[11px] font-medium truncate">{t('收支流水')}</span>
                        <ChevronRight className="w-3 h-3 text-muted-foreground/60 group-hover:text-foreground group-hover:translate-x-0.5 transition-all shrink-0" />
                      </div>
                    </button>
                  </div>

                  {/* 4. 全宽主行动按钮（Hero CTA）：无论何种语言长文本均能从容舒展，彻底告别文字截断 */}
                  <div className="relative z-10 pt-3 mt-3 border-t border-border/40">
                    <Button
                      onClick={() => handleMenuClick(primaryActionConfig.action)}
                      className={cn(
                        'w-full h-9 px-3 rounded-xl text-xs font-bold transition-all duration-200 shadow-sm hover:shadow-md border border-transparent cursor-pointer flex items-center justify-center gap-2 select-none hover:scale-[1.01] active:scale-98',
                        primaryActionConfig.className
                      )}
                    >
                      {primaryActionConfig.icon}
                      <span className="font-bold tracking-wide">{primaryActionConfig.label}</span>
                      <ChevronRight className="w-3.5 h-3.5 opacity-80" />
                    </Button>
                  </div>

                  {/* 5. 平衡双联副操作区：收集萤火 与 兑换激活码 对等分布 */}
                  <div className="grid grid-cols-2 gap-2 relative z-10 pt-2.5 mt-2.5 border-t border-border/40">
                    <Button
                      variant="outline"
                      onClick={() =>
                        handleMenuClick(() => {
                          openRulesDialog('earn')
                        })
                      }
                      className="h-8 py-1 px-2 rounded-lg text-xs font-medium border-border/60 bg-background/60 hover:bg-accent/80 text-foreground transition-all duration-200 flex items-center justify-center gap-1.5 cursor-pointer select-none"
                    >
                      <Firecores className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                      <span className="truncate">{t('收集萤火')}</span>
                    </Button>

                    <Button
                      variant="outline"
                      onClick={() =>
                        handleMenuClick(() => {
                          setIsActivationCodeOpen(true)
                        })
                      }
                      className="h-8 py-1 px-2 rounded-lg text-xs font-medium border-border/60 bg-background/60 hover:bg-accent/80 text-foreground transition-all duration-200 flex items-center justify-center gap-1.5 cursor-pointer select-none"
                    >
                      <KeyRound className="w-3.5 h-3.5 text-sky-500 shrink-0" />
                      <span className="truncate">{t('兑换激活码')}</span>
                    </Button>
                  </div>
                </div>
              </div>

              <div className="h-px bg-border/40 mx-3.5" />

              {/* 层级五：通用功能菜单列表 */}
              <div className="p-2 space-y-0.5">
                <button
                  className="w-full flex items-center gap-3 px-3 py-2 text-sm rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-all duration-200 group active:scale-[0.98] cursor-pointer"
                  onClick={() => handleMenuClick(() => openSettings())}
                >
                  <div className="w-7 h-7 rounded-lg bg-muted/60 flex items-center justify-center shrink-0 group-hover:bg-primary/10 transition-colors">
                    <Settings className="w-4 h-4 opacity-70 group-hover:opacity-100 group-hover:text-primary transition-all" />
                  </div>
                  <span className="flex-1 font-medium whitespace-normal break-words min-w-0 text-left leading-snug">
                    {t('设置')}
                  </span>
                </button>

                <button
                  className="w-full flex items-center gap-3 px-3 py-2 text-sm rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-all duration-200 group active:scale-[0.98] cursor-pointer"
                  onClick={() =>
                    handleMenuClick(() => useAnalysisQueueStore.getState().toggleQueue())
                  }
                >
                  <div className="w-7 h-7 rounded-lg bg-muted/60 flex items-center justify-center shrink-0 group-hover:bg-primary/10 transition-colors">
                    <ListOrdered className="w-4 h-4 opacity-70 group-hover:opacity-100 text-primary transition-all" />
                  </div>
                  <span className="flex-1 font-medium whitespace-normal break-words min-w-0 text-left leading-snug">
                    {t('分析队列')}
                  </span>
                </button>

                <button
                  className="w-full flex items-center gap-3 px-3 py-2 text-sm rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-all duration-200 group active:scale-[0.98] cursor-pointer"
                  onClick={() =>
                    handleMenuClick(async () => {
                      // 1. 校验是否开启高级AI引擎
                      const aiServiceMode =
                        useSettingsStore.getState().config?.aiServiceMode ??
                        (await window.electronAPI?.getConfigValue<string>('AI_SERVICE_MODE')) ??
                        'local'
                      if (aiServiceMode === 'disabled') {
                        toast.warning(t('生成式引擎未开启，请先开启生成式引擎'), 3000, undefined, {
                          label: t('前往设置'),
                          onClick: () => openSettings(SettingsCategory.AI_ENGINE_CONFIG)
                        })
                        return
                      }

                      // 2. 校验高级AI引擎是否已启动
                      const snapshot = await window.electronAPI?.engineBridge?.getStatus?.()
                      const status = snapshot?.raw?.status
                      if (status === 'starting') {
                        toast.info(t('生成式引擎正在启动中，请稍后重试'))
                        return
                      }
                      if (!isEngineServiceReady(status)) {
                        toast.warning(t('生成式引擎未启动，请先启动生成式引擎'), 3000, undefined, {
                          label: t('前往设置'),
                          onClick: () => openSettings(SettingsCategory.AI_ENGINE_CONFIG)
                        })
                        return
                      }

                      const runningPort = await window.electronAPI?.getLlamaServerPort?.()
                      const configPort =
                        await window.electronAPI?.getConfigValue<number>('AI_LOCAL_PORT')
                      const port = runningPort || snapshot?.port || configPort || 38400
                      openExternalLink(`http://localhost:${port}`)
                    })
                  }
                >
                  <div className="w-7 h-7 rounded-lg bg-muted/60 flex items-center justify-center shrink-0 group-hover:bg-purple-500/10 transition-colors">
                    <Bot className="w-4 h-4 opacity-70 group-hover:opacity-100 text-purple-500 transition-all" />
                  </div>
                  <span className="flex-1 font-medium whitespace-normal break-words min-w-0 text-left leading-snug">
                    {t('与本地AI私密聊天')}
                  </span>
                  <ExternalLink className="w-3.5 h-3.5 opacity-40 group-hover:opacity-70 shrink-0" />
                </button>

                <button
                  className="w-full flex items-center gap-3 px-3 py-2 text-sm rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-all duration-200 group active:scale-[0.98] cursor-pointer"
                  onClick={() =>
                    handleMenuClick(() => {
                      // 根据当前页面路径确定 storageKey
                      const pathname = location.pathname
                      let storageKey = 'real-directory'
                      if (pathname === '/analyzed-directory') {
                        storageKey = 'analyzed-directory'
                      } else if (pathname.startsWith('/virtual-directory')) {
                        storageKey = 'virtual-directory'
                      } else if (pathname === '/organize') {
                        storageKey = 'organize-main'
                      }
                      // 清除 localStorage 中的布局数据
                      localStorage.removeItem('split-pane:' + storageKey)
                      // 重新加载页面应用默认布局
                      window.location.reload()
                    })
                  }
                >
                  <div className="w-7 h-7 rounded-lg bg-muted/60 flex items-center justify-center shrink-0 group-hover:bg-accent transition-colors">
                    <RotateCcw className="w-4 h-4 opacity-70 group-hover:opacity-100 transition-all" />
                  </div>
                  <span className="flex-1 font-medium whitespace-normal break-words min-w-0 text-left leading-snug">
                    {t('重置布局')}
                  </span>
                </button>

                <div className="my-1 border-t border-border/30 mx-2" />

                {(config as any)?.PAYMENT_INFO?.method === 'creem' ? (
                  <button
                    className="w-full flex items-center gap-3 px-3 py-2 text-sm rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-all duration-200 group active:scale-[0.98] cursor-pointer"
                    onClick={() =>
                      handleMenuClick(() => {
                        openExternalLink('https://t.me/firefly_ai_folder')
                      })
                    }
                  >
                    <div className="w-7 h-7 rounded-lg bg-muted/60 flex items-center justify-center shrink-0 group-hover:bg-sky-500/10 transition-colors">
                      <MessageCircle className="w-4 h-4 opacity-70 group-hover:opacity-100 text-sky-400 transition-all" />
                    </div>
                    <span className="flex-1 font-medium whitespace-normal break-words min-w-0 text-left leading-snug">
                      {t('Telegram 官方频道')}
                    </span>
                    <ExternalLink className="w-3.5 h-3.5 opacity-40 group-hover:opacity-70 shrink-0" />
                  </button>
                ) : (
                  <>
                    <button
                      className="w-full flex items-center gap-3 px-3 py-2 text-sm rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-all duration-200 group active:scale-[0.98] cursor-pointer"
                      onClick={() =>
                        handleMenuClick(() => {
                          openExternalLink('https://www.zhihu.com/ring/2019089912897478826')
                        })
                      }
                    >
                      <div className="w-7 h-7 rounded-lg bg-muted/60 flex items-center justify-center shrink-0 group-hover:bg-sky-500/10 transition-colors">
                        <MessageCircle className="w-4 h-4 opacity-70 group-hover:opacity-100 text-sky-500 transition-all" />
                      </div>
                      <span className="flex-1 font-medium whitespace-normal break-words min-w-0 text-left leading-snug">
                        {t('知乎萤核圈子')}
                      </span>
                      <ExternalLink className="w-3.5 h-3.5 opacity-40 group-hover:opacity-70 shrink-0" />
                    </button>
                    <button
                      className="w-full flex items-center gap-3 px-3 py-2 text-sm rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-all duration-200 group active:scale-[0.98] cursor-pointer"
                      onClick={() =>
                        handleMenuClick(() => {
                          setIsWechatQROpen(true)
                        })
                      }
                    >
                      <div className="w-7 h-7 rounded-lg bg-muted/60 flex items-center justify-center shrink-0 group-hover:bg-emerald-500/10 transition-colors">
                        <QrCode className="w-4 h-4 opacity-70 group-hover:opacity-100 text-green-500 transition-all" />
                      </div>
                      <span className="flex-1 font-medium whitespace-normal break-words min-w-0 text-left leading-snug">
                        {t('扫码加微信群')}
                      </span>
                    </button>
                  </>
                )}

                <button
                  className="w-full flex items-center gap-3 px-3 py-2 text-sm rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-all duration-200 group active:scale-[0.98] cursor-pointer"
                  onClick={() => handleMenuClick(() => setIsAboutOpen(true))}
                >
                  <div className="w-7 h-7 rounded-lg bg-muted/60 flex items-center justify-center shrink-0 group-hover:bg-blue-500/10 transition-colors">
                    <Info className="w-4 h-4 opacity-70 group-hover:opacity-100 text-blue-500 transition-all" />
                  </div>
                  <span className="flex-1 font-medium whitespace-normal break-words min-w-0 text-left leading-snug">
                    {t('关于萤核')}
                  </span>
                </button>
              </div>
            </div>
          </>,
          document.body
        )}

      {/* Dialogs */}
      <UpgradeAccountDialog open={isUpgradeOpen} onOpenChange={setIsUpgradeOpen} />
      <AccountManagementDialog
        open={isAccountManagementOpen}
        onOpenChange={setIsAccountManagementOpen}
      />
      <ActivationCodeDialog
        open={isActivationCodeOpen}
        onOpenChange={setIsActivationCodeOpen}
        onActivated={() => {
          void fetchProfile()
        }}
      />
      <AboutDialog open={isAboutOpen} onOpenChange={setIsAboutOpen} />
      <WechatQRDialog open={isWechatQROpen} onOpenChange={setIsWechatQROpen} />
    </div>
  )
}
