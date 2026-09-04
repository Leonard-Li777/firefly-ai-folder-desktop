import {
  ChevronDown,
  CreditCard,
  ExternalLink,
  Flame as Firecores,
  Info,
  ListOrdered,
  MessageCircle,
  QrCode,
  RotateCcw,
  Settings,
  User,
  Bot,
  Crown,
  KeyRound
} from 'lucide-react'
import React, { useCallback, useEffect, useRef, useState } from 'react'

import { AboutDialog } from '../settings/about-dialog'
import { FirecoresRulesDialog } from './FirecoresRulesDialog'
import { UpgradeAccountDialog } from './UpgradeAccountDialog'
import { AccountManagementDialog } from './AccountManagementDialog'
import { ActivationCodeDialog } from './ActivationCodeDialog'
import { UserTier, formatDateOnly } from '@firefly/shared'
import { WechatQRDialog } from './WechatQRDialog'
import { cn } from '../../lib/utils'
import { createPortal } from 'react-dom'
import { openExternalLink } from '../../lib/external-link'
import { openMarketingPricingUrl, resolveDevCreemUrl } from '../../lib/marketing-link'
import { t } from '@app/languages'
import { useLocation } from 'react-router-dom'
import { useSettingsStore } from '../../stores/settings-store'
import { useTierStore } from '../../stores/tier-store'
import { useConfigStore } from '../../stores/config-store'
import { useAnalysisQueueStore } from '../../stores/analysis-queue-store'
import { Button } from '../ui/button'

export const UserAvatarMenu: React.FC = () => {
  const { tier, firecores, subscription, fetchProfile } = useTierStore()
  const { openSettings } = useSettingsStore()
  const config = useConfigStore(state => state.config)
  const location = useLocation()

  const [isOpen, setIsOpen] = useState(false)
  const [isRulesOpen, setIsRulesOpen] = useState(false)
  const [rulesDefaultTab, setRulesDefaultTab] = useState<string | undefined>(undefined)
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
          ringClass: 'ring-1 ring-purple-500/30 hover:ring-purple-500/50',
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
          ringClass: 'ring-1 ring-emerald-500/30 hover:ring-emerald-500/50',
          arrowClass: 'text-emerald-500/70'
        }
      case UserTier.PRO:
        return {
          name: t('Pro 专业版'),
          bgClass: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
          textClass: 'text-amber-600 dark:text-amber-400',
          borderClass: 'border-amber-500/30',
          badgeClass: 'bg-gradient-to-r from-amber-500 to-orange-500 text-white shadow-amber-500/20',
          ringClass: 'ring-1 ring-amber-500/30 hover:ring-amber-500/50',
          arrowClass: 'text-amber-500/70'
        }
      default:
        return {
          name: t('免费版'),
          bgClass: 'bg-muted text-muted-foreground',
          textClass: 'text-muted-foreground',
          borderClass: 'border-border/50',
          badgeClass: 'bg-secondary text-secondary-foreground',
          ringClass: 'ring-1 ring-border/50 hover:ring-border',
          arrowClass: 'text-muted-foreground/70'
        }
    }
  }, [])

  const tierConfig = getTierConfig(tier)

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(event.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false)
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    } else {
      document.removeEventListener('mousedown', handleClickOutside)
    }

    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen])

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
    setIsOpen(false)
  }

  const paymentInfo = (config as any)?.PAYMENT_INFO

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          'relative flex items-center gap-1.5 px-2 py-1.5 rounded-full transition-all active:scale-95 hover:bg-accent/50',
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
            'w-3.5 h-3.5 transition-transform',
            isOpen && 'rotate-180',
            tierConfig.arrowClass
          )}
        />
      </button>

      {isOpen &&
        createPortal(
          <div
            ref={menuRef}
            className={cn(
              'fixed z-[100] w-72 bg-card text-card-foreground border border-border rounded-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200'
            )}
            style={{
              top: menuPosition.top,
              right: menuPosition.right,
              backdropFilter: 'blur(12px)',
              WebkitBackdropFilter: 'blur(12px)'
            }}
          >
            {/* Header / Wallet Card */}
            <div className="p-4 pb-2.5 relative">
              <div
                className={cn(
                  'rounded-2xl border p-4 pt-2 relative overflow-hidden transition-all shadow-md',
                  tier === UserTier.ENTERPRISE
                    ? 'bg-gradient-to-br from-purple-500/[0.09] via-indigo-500/[0.03] to-transparent border-purple-500/15'
                    : tier === UserTier.PRO
                      ? 'bg-gradient-to-br from-amber-500/[0.09] via-yellow-500/[0.03] to-transparent border-amber-500/15'
                      : tier === UserTier.AGENT
                        ? 'bg-gradient-to-br from-emerald-500/[0.09] via-teal-500/[0.03] to-transparent border-emerald-500/15'
                        : 'bg-muted/40 border-border/60'
                )}
              >
                {/* 装饰性光晕背景 */}
                <div
                  className={cn(
                    'absolute -right-8 -top-8 w-24 h-24 rounded-full blur-2xl pointer-events-none opacity-60',
                    tier === UserTier.ENTERPRISE
                      ? 'bg-purple-500/20'
                      : tier === UserTier.PRO
                        ? 'bg-amber-500/20'
                        : tier === UserTier.AGENT
                          ? 'bg-emerald-500/20'
                          : 'bg-muted'
                  )}
                />

                {/* 会员等级徽章 */}
                <div className="flex items-center justify-between relative z-10 pt-2 pb-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className={cn(
                        'text-xs font-black uppercase tracking-wider px-2.5 py-0.5 rounded-full shadow-sm truncate',
                        tierConfig.badgeClass
                      )}
                    >
                      {tierConfig.name}
                    </span>
                  </div>
                </div>

                {/* 萤火余额卡片 */}
                <div
                  onClick={() =>
                    handleMenuClick(() => {
                      setRulesDefaultTab('consumption')
                      setIsRulesOpen(true)
                    })
                  }
                  className="flex items-center gap-3 py-3 px-2 -mx-2 hover:bg-amber-500/[0.04] dark:hover:bg-amber-500/[0.06] rounded-xl cursor-pointer transition-colors duration-200 relative z-10 pl-4"
                  title={t('点击查看收支流水')}
                >
                  <div className="p-2 bg-amber-500/10 rounded-lg ring-1 ring-amber-500/20 shrink-0">
                    <Firecores className="w-5 h-5 text-amber-500 animate-pulse" />
                  </div>
                  <div>
                    <div className="text-2xl font-black tabular-nums leading-none tracking-tight">
                      {firecores.toLocaleString()}
                    </div>
                    <div className="text-[10px] text-muted-foreground font-semibold mt-1 uppercase tracking-wider">
                      {t('萤火余额')}
                    </div>
                  </div>
                </div>

                {/* Action Row: Upgrade Account & Firecore Rules */}
                <div className="grid grid-cols-2 gap-2.5 relative z-10 pt-3 border-t border-border/40">
                  <Button
                    onClick={() =>
                      handleMenuClick(() => {
                        if (tier !== UserTier.FREE) {
                          const targetPortalUrl =
                            paymentInfo?.cancellation_portal?.url || 'https://www.creem.io/portal'
                          openExternalLink(resolveDevCreemUrl(targetPortalUrl))
                        } else {
                          openMarketingPricingUrl('upgrade_pro')
                        }
                      })
                    }
                    style={{ whiteSpace: 'normal', height: 'auto' }}
                    className="flex items-center justify-center gap-1.5 min-h-8 !h-auto py-1.5 px-2 !whitespace-normal rounded-xl text-xs font-bold transition-all hover:scale-[1.02] active:scale-95 duration-200 shadow-sm hover:shadow-md border border-transparent bg-gradient-to-r from-sky-500 to-blue-600 text-white hover:from-sky-600 hover:to-blue-700 leading-tight text-center"
                  >
                    <CreditCard className="w-3.5 h-3.5 shrink-0" />
                    <span
                      style={{ whiteSpace: 'normal', wordBreak: 'break-word' }}
                      className="min-w-0 !whitespace-normal !break-words text-center leading-tight flex items-center gap-0.5"
                    >
                      {tier !== UserTier.FREE ? t('管理订阅') : t('升级帐户')}
                    </span>
                  </Button>
                  <Button
                    onClick={() =>
                      handleMenuClick(() => {
                        setRulesDefaultTab('earn')
                        setIsRulesOpen(true)
                      })
                    }
                    style={{ whiteSpace: 'normal', height: 'auto' }}
                    className="flex items-center justify-center gap-1.5 min-h-8 !h-auto py-1.5 px-2 !whitespace-normal rounded-xl text-xs font-bold border border-amber-500/30 bg-background/50 text-secondary-foreground hover:bg-accent transition-all hover:scale-[1.02] active:scale-95 duration-200 leading-tight text-center"
                  >
                    <Firecores className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                    <span
                      style={{ whiteSpace: 'normal', wordBreak: 'break-word' }}
                      className="min-w-0 !whitespace-normal !break-words text-center leading-tight"
                    >
                      {t('收集萤火')}
                    </span>
                  </Button>
                </div>
              </div>

              {/* 过期时间：沿角标斜边外侧平行显示 */}
              {(tier === UserTier.PRO || tier === UserTier.AGENT || tier === UserTier.ENTERPRISE) &&
                subscription?.expires_at && (
                  <div
                    className="absolute z-30 pointer-events-none"
                    style={{
                      right: '27px',
                      top: '68px',
                      transform: 'rotate(45deg)',
                      transformOrigin: 'right center'
                    }}
                  >
                    <span className="text-[9px] whitespace-nowrap text-foreground/70">
                      {t('有效期至')}{' '}
                      <span
                        className={cn(
                          new Date(subscription.expires_at).getTime() < Date.now()
                            ? 'text-red-500'
                            : tier === UserTier.ENTERPRISE
                              ? 'text-purple-600 dark:text-purple-400'
                              : tier === UserTier.AGENT
                                ? 'text-emerald-600 dark:text-emerald-400'
                                : 'text-amber-600 dark:text-amber-400'
                        )}
                      >
                        {formatDateOnly(subscription.expires_at)}
                      </span>
                    </span>
                  </div>
                )}
            </div>

            <div className="h-px bg-border/40 mx-4" />

            {/* Menu Items */}
            <div className="p-2 space-y-0.5">
              {/* 离线企业激活码兑换入口 */}
              <button
                className="w-full flex items-center gap-3 px-3 py-2 text-sm rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-all duration-200 group active:scale-[0.98]"
                onClick={() =>
                  handleMenuClick(() => {
                    setIsActivationCodeOpen(true)
                  })
                }
              >
                <KeyRound className="w-4 h-4 shrink-0 opacity-70 group-hover:opacity-100 group-hover:scale-105 transition-all text-sky-500" />
                <span className="font-medium whitespace-normal break-words min-w-0 text-left leading-tight">
                  {t('兑换授权激活码')}
                </span>
              </button>

              <div className="my-1 border-t border-border/30 mx-2" />

              <button
                className="w-full flex items-center gap-3 px-3 py-2 text-sm rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-all duration-200 group active:scale-[0.98]"
                onClick={() => handleMenuClick(() => openSettings())}
              >
                <Settings className="w-4 h-4 shrink-0 opacity-70 group-hover:opacity-100 group-hover:scale-105 transition-all" />
                <span className="font-medium whitespace-normal break-words min-w-0 text-left leading-tight">
                  {t('设置')}
                </span>
              </button>
              <button
                className="w-full flex items-center gap-3 px-3 py-2 text-sm rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-all duration-200 group active:scale-[0.98]"
                onClick={() =>
                  handleMenuClick(() => useAnalysisQueueStore.getState().toggleQueue())
                }
              >
                <ListOrdered className="w-4 h-4 shrink-0 opacity-70 group-hover:opacity-100 group-hover:scale-105 transition-all text-primary" />
                <span className="font-medium whitespace-normal break-words min-w-0 text-left leading-tight">
                  {t('分析队列')}
                </span>
              </button>
              <button
                className="w-full flex items-center gap-3 px-3 py-2 text-sm rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-all duration-200 group active:scale-[0.98]"
                onClick={() =>
                  handleMenuClick(async () => {
                    const runningPort = await window.electronAPI?.getLlamaServerPort?.()
                    const configPort =
                      await window.electronAPI?.getConfigValue<number>('AI_LOCAL_PORT')
                    const port = runningPort || configPort || 38400
                    openExternalLink(`http://localhost:${port}`)
                  })
                }
              >
                <Bot className="w-4 h-4 shrink-0 opacity-70 group-hover:opacity-100 group-hover:scale-105 transition-all text-purple-500" />
                <span className="font-medium whitespace-normal break-words min-w-0 text-left leading-tight">
                  {t('与本地AI私密聊天')}
                </span>
              </button>
              <button
                className="w-full flex items-center gap-3 px-3 py-2 text-sm rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-all duration-200 group active:scale-[0.98]"
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
                <RotateCcw className="w-4 h-4 shrink-0 opacity-70 group-hover:opacity-100 group-hover:scale-105 transition-all" />
                <span className="font-medium whitespace-normal break-words min-w-0 text-left leading-tight">
                  {t('重置布局')}
                </span>
              </button>
              <div className="my-1 border-t border-border/30 mx-2" />
              {(config as any)?.PAYMENT_INFO?.method === 'creem' ? (
                <button
                  className="w-full flex items-center gap-3 px-3 py-2 text-sm rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-all duration-200 group active:scale-[0.98]"
                  onClick={() =>
                    handleMenuClick(() => {
                      openExternalLink('https://t.me/firefly_ai_folder')
                    })
                  }
                >
                  <MessageCircle className="w-4 h-4 shrink-0 opacity-70 group-hover:opacity-100 group-hover:scale-105 transition-all text-sky-400" />
                  <span className="font-medium whitespace-normal break-words min-w-0 text-left leading-tight">
                    {t('Telegram 官方频道')}
                  </span>
                </button>
              ) : (
                <>
                  <button
                    className="w-full flex items-center gap-3 px-3 py-2 text-sm rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-all duration-200 group active:scale-[0.98]"
                    onClick={() =>
                      handleMenuClick(() => {
                        openExternalLink('https://www.zhihu.com/ring/2019089912897478826')
                      })
                    }
                  >
                    <MessageCircle className="w-4 h-4 shrink-0 opacity-70 group-hover:opacity-100 group-hover:scale-105 transition-all text-sky-500" />
                    <span className="font-medium whitespace-normal break-words min-w-0 text-left leading-tight">
                      {t('知乎萤核圈子')}
                    </span>
                  </button>
                  <button
                    className="w-full flex items-center gap-3 px-3 py-2 text-sm rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-all duration-200 group active:scale-[0.98]"
                    onClick={() =>
                      handleMenuClick(() => {
                        setIsWechatQROpen(true)
                      })
                    }
                  >
                    <QrCode className="w-4 h-4 shrink-0 opacity-70 group-hover:opacity-100 group-hover:scale-105 transition-all text-green-500" />
                    <span className="font-medium whitespace-normal break-words min-w-0 text-left leading-tight">
                      {t('扫码加微信群')}
                    </span>
                  </button>
                </>
              )}
              <button
                className="w-full flex items-center gap-3 px-3 py-2 text-sm rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-all duration-200 group active:scale-[0.98]"
                onClick={() => handleMenuClick(() => setIsAboutOpen(true))}
              >
                <Info className="w-4 h-4 shrink-0 opacity-70 group-hover:opacity-100 group-hover:scale-105 transition-all text-blue-500" />
                <span className="font-medium whitespace-normal break-words min-w-0 text-left leading-tight">
                  {t('关于萤核')}
                </span>
              </button>
            </div>
          </div>,
          document.body
        )}

      {/* Dialogs */}
      <FirecoresRulesDialog
        open={isRulesOpen}
        onOpenChange={setIsRulesOpen}
        defaultTab={rulesDefaultTab}
      />
      <UpgradeAccountDialog open={isUpgradeOpen} onOpenChange={setIsUpgradeOpen} />
      <AccountManagementDialog
        open={isAccountManagementOpen}
        onOpenChange={setIsAccountManagementOpen}
      />
      <ActivationCodeDialog
        open={isActivationCodeOpen}
        onOpenChange={setIsActivationCodeOpen}
      />
      <AboutDialog open={isAboutOpen} onOpenChange={setIsAboutOpen} />
      <WechatQRDialog open={isWechatQROpen} onOpenChange={setIsWechatQROpen} />
    </div>
  )
}
