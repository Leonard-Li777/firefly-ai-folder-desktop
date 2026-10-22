import React, { useState, useEffect } from 'react'
import { intervalToDuration } from 'date-fns'
import { formatDateTime } from '@firefly/shared'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Textarea } from '../ui/textarea'
import { Label } from '../ui/label'
import { Alert, AlertDescription, AlertTitle } from '../ui/alert'
import {
  Copy,
  CheckCircle2,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  Key,
  Sparkles,
  ExternalLink,
  Check,
  Zap,
  Lock,
  ArrowRight,
  WifiOff
} from 'lucide-react'
import { toast } from '../common/Toast'
import { t } from '@app/languages'
import confetti from 'canvas-confetti'
import { openMarketingPricingUrl, getMarketingPricingUrl, buildPricingUrlSync } from '../../lib/marketing-link'


interface ActivationCodeSectionProps {
  tier: 'pro' | 'enterprise'
  onActivated?: () => void
}

export const ActivationCodeSection: React.FC<ActivationCodeSectionProps> = ({
  tier,
  onActivated
}) => {
  if (tier === 'pro') {
    return <ProActivationCode onActivated={onActivated} />
  }
  return <EnterpriseActivationFlow onActivated={onActivated} />
}

const ProActivationCode: React.FC<{ onActivated?: () => void }> = ({ onActivated }) => {
  const [identCode, setIdentCode] = useState<string>('')
  const [hasCopied, setHasCopied] = useState(false)

  useEffect(() => {
    if (window.electronAPI?.license) {
      window.electronAPI.license.getIdentCode().then(setIdentCode)
    }
  }, [])

  const handleCopyCode = () => {
    if (!identCode) return
    navigator.clipboard.writeText(identCode)
    setHasCopied(true)
    toast.success(t('标识码已复制到剪贴板'))
    setTimeout(() => setHasCopied(false), 2000)
  }

  return (
    <div className="space-y-6 mx-auto py-2">
      <div className="rounded-2xl border border-border/70 bg-card/60 dark:bg-card/40 backdrop-blur-md p-5 space-y-4 shadow-xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-primary">
            <div className="w-6 h-6 rounded-lg bg-primary/10 text-primary font-mono font-black text-xs flex items-center justify-center ring-1 ring-primary/20">
              01
            </div>
            <Label className="text-sm font-black tracking-tight">
              {t('我的设备标识码')}
            </Label>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="text-xs font-bold h-8 px-3 rounded-xl border-primary/30 text-primary hover:bg-primary/10 flex items-center gap-1.5 shadow-xs cursor-pointer self-start sm:self-auto"
            onClick={() => openMarketingPricingUrl('upgrade_pro')}
          >
            <Sparkles className="w-3.5 h-3.5 text-amber-500" />
            <span>{t('前往官网升级 Pro 版')}</span>
            <ExternalLink className="w-3 h-3 ml-0.5" />
          </Button>
        </div>

        <div className="relative group">
          <Input
            readOnly
            value={identCode}
            className="font-mono text-base md:text-lg bg-muted/40 border border-border/80 h-14 pr-28 focus-visible:ring-primary/30 transition-all rounded-xl shadow-inner select-all"
          />
          <Button
            variant="secondary"
            onClick={handleCopyCode}
            className="absolute right-1.5 top-1.5 h-11 gap-1.5 hover:bg-primary hover:text-primary-foreground transition-all font-bold rounded-lg px-4 shadow-xs cursor-pointer"
          >
            {hasCopied ? (
              <>
                <Check className="w-4 h-4 text-emerald-500" />
                <span className="text-emerald-500">{t('已复制')}</span>
              </>
            ) : (
              <>
                <Copy className="w-4 h-4" />
                <span>{t('复制')}</span>
              </>
            )}
          </Button>
        </div>

        <div className="flex items-start gap-2.5 p-3.5 bg-primary/5 rounded-xl border border-primary/15 text-xs text-muted-foreground leading-relaxed font-medium">
          <span className="text-primary font-bold">💡</span>
          <p>
            {t(
              '您可在官网定价中心选购 Pro 专业版，系统将根据此标识码自动绑定当前设备即刻生效开通。'
            )}
          </p>
        </div>
      </div>
    </div>
  )
}

const EnterpriseActivationFlow: React.FC<{ onActivated?: () => void }> = ({ onActivated }) => {
  const [identCode, setIdentCode] = useState<string>('')
  const [licenseCode, setLicenseCode] = useState<string>('')
  const [isActivating, setIsActivating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isSuccess, setIsSuccess] = useState(false)
  const [expiryDate, setExpiryDate] = useState<string | null>(null)
  const [timeLeft, setTimeLeft] = useState<string>('')
  const [isCheckingInitialStatus, setIsCheckingInitialStatus] = useState(true)
  const [hasCopied, setHasCopied] = useState(false)
  const [hasCopiedUrl, setHasCopiedUrl] = useState(false)
  const [purchaseUrl, setPurchaseUrl] = useState<string>('')
  const [isOnline, setIsOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  )

  /**
   * 结合原生网络状态与系统已有授权/网络状态探测用户是否在线
   */
  const checkNetworkOnline = async () => {
    // 1. 原生断网直接判定为离线
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setIsOnline(false)
      return false
    }

    // 2. 利用系统中已有的检测机制 (license.getStatus)
    try {
      if (window.electronAPI?.license?.getStatus) {
        const statusRes = await window.electronAPI.license.getStatus()
        // 系统已有明确在线授权标识
        if (statusRes.type === 'ONLINE') {
          setIsOnline(true)
          return true
        }
        // 如果断网且未获授权，主进程 checkRealConnectivity 探测失败会返回 UNAUTHORIZED 且无 type
        if (statusRes.status === 'UNAUTHORIZED' && !statusRes.type) {
          setIsOnline(false)
          return false
        }
      }
    } catch {
      setIsOnline(false)
      return false
    }

    const online = typeof navigator !== 'undefined' ? navigator.onLine : true
    setIsOnline(online)
    return online
  }

  // 监听系统物理网络连通性变化
  useEffect(() => {
    const handleOnline = () => {
      void checkNetworkOnline()
    }
    const handleOffline = () => {
      setIsOnline(false)
    }

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  useEffect(() => {
    if (!expiryDate) return

    const updateTimer = () => {
      const end = new Date(expiryDate)
      const now = new Date()

      if (end <= now) {
        setTimeLeft(t('已过期'))
        return
      }

      const duration = intervalToDuration({ start: now, end: end })
      const years = duration.years || 0
      const months = duration.months || 0
      const days = duration.days || 0
      const hours = String(duration.hours || 0).padStart(2, '0')
      const minutes = String(duration.minutes || 0).padStart(2, '0')
      const seconds = String(duration.seconds || 0).padStart(2, '0')

      setTimeLeft(
        t('{years}年-{months}月-{days}日 {hours}:{minutes}:{seconds}', {
          years,
          months,
          days,
          hours,
          minutes,
          seconds
        })
      )
    }

    updateTimer()
    const interval = setInterval(updateTimer, 1000)
    return () => clearInterval(interval)
  }, [expiryDate])

  useEffect(() => {
    const init = async () => {
      // 1. 检测网络连通状态
      await checkNetworkOnline()

      // 2. 构造离线专属购买链接 (强制使用生产公网域名，内嵌当前设备的 ident_code)
      try {
        const url = await getMarketingPricingUrl('enterprise', { forceProductionDomain: true })
        if (url) {
          setPurchaseUrl(url)
        }
      } catch (err) {
        console.error('获取离线企业购买链接失败:', err)
      }

      // 3. 读取设备标识码及初始授权
      if (window.electronAPI?.license) {
        const code = await window.electronAPI.license.getIdentCode()
        setIdentCode(code)

        try {
          const statusResult = await window.electronAPI.license.getStatus()
          if (statusResult.status === 'AUTHORIZED' && statusResult.type !== 'ONLINE') {
            setIsSuccess(true)
            if (statusResult.expiry) {
              setExpiryDate(statusResult.expiry)
            }
            setTimeout(() => fireCelebration(), 300)
          }
        } catch (e) {
          console.error('获取初始授权状态失败:', e)
        } finally {
          setIsCheckingInitialStatus(false)
        }
      } else {
        setIsCheckingInitialStatus(false)
      }
    }
    init()
  }, [])

  useEffect(() => {
    if (isSuccess || isActivating || isCheckingInitialStatus) return

    const code = licenseCode.replace(/\s+/g, '')
    if (!code) {
      setError(null)
      return
    }

    // 授权码为包含签名信息的长 Base64 密文，字符达到基本长度时自动防抖触发校验
    if (code.length < 50) {
      return
    }

    const timer = setTimeout(() => {
      void handleActivate(code)
    }, 800)

    return () => clearTimeout(timer)
  }, [licenseCode, isSuccess, isActivating, isCheckingInitialStatus])

  const fireCelebration = () => {
    const duration = 4 * 1000
    const animationEnd = Date.now() + duration
    const defaults = { startVelocity: 30, spread: 360, ticks: 60, zIndex: 10000 }

    const randomInRange = (min: number, max: number) => Math.random() * (max - min) + min

    const interval: any = setInterval(function () {
      const timeLeft = animationEnd - Date.now()

      if (timeLeft <= 0) {
        return clearInterval(interval)
      }

      const particleCount = 45 * (timeLeft / duration)
      confetti({
        ...defaults,
        particleCount,
        origin: { x: randomInRange(0.1, 0.3), y: Math.random() - 0.2 }
      })
      confetti({
        ...defaults,
        particleCount,
        origin: { x: randomInRange(0.7, 0.9), y: Math.random() - 0.2 }
      })
    }, 250)
  }

  const handleCopyCode = () => {
    if (!identCode) return
    navigator.clipboard.writeText(identCode)
    setHasCopied(true)
    toast.success(t('设备标识码已复制到剪贴板'))
    setTimeout(() => setHasCopied(false), 2000)
  }

  const handleCopyUrl = () => {
    // 兜底链接同样必须按当前区域生成，严禁硬编码国际版域名
    const urlToCopy = purchaseUrl || buildPricingUrlSync('enterprise', identCode || undefined)

    navigator.clipboard.writeText(urlToCopy)
    setHasCopiedUrl(true)
    toast.success(t('离线购买链接已复制到剪贴板'))
    setTimeout(() => setHasCopiedUrl(false), 2000)
  }


  const handleActivate = async (code: string) => {
    const target = code.replace(/\s+/g, '')
    if (!target) return

    setIsActivating(true)
    setError(null)

    try {
      const result = await window.electronAPI!.license.activate(target)
      if (result.success) {
        setIsSuccess(true)
        const statusResult = await window.electronAPI!.license.getStatus()
        if (statusResult.expiry) {
          setExpiryDate(statusResult.expiry)
        }

        fireCelebration()
        toast.success(t('企业版授权激活成功！'))

        setTimeout(() => {
          if (onActivated) onActivated()
        }, 4000)
      } else {
        setError(result.error || t('激活失败，请检查授权码与当前设备是否匹配'))
      }
    } catch (e) {
      setError(t('激活过程中发生错误，请稍后重试'))
    } finally {
      setIsActivating(false)
    }
  }

  if (isCheckingInitialStatus) {
    return (
      <div className="flex flex-col items-center justify-center py-16 space-y-4">
        <Loader2 className="w-9 h-9 animate-spin text-violet-500 opacity-80" />
        <p className="text-xs text-muted-foreground font-medium animate-pulse">
          {t('正在同步本地离线授权状态...')}
        </p>
      </div>
    )
  }

  if (isSuccess) {
    return (
      <div className="flex flex-col items-center justify-center py-8 space-y-6 animate-in zoom-in-95 duration-500 text-center">
        <div className="relative">
          <div className="absolute inset-0 bg-violet-500/25 blur-3xl rounded-full animate-pulse" />
          <div className="relative bg-gradient-to-br from-violet-500/20 to-indigo-500/20 p-6 rounded-3xl shadow-xl ring-2 ring-violet-500/30">
            <CheckCircle2 className="w-16 h-16 text-violet-500 animate-in zoom-in-50 duration-300" />
          </div>
        </div>

        <div className="space-y-2 max-w-md mx-auto">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-violet-500/10 text-violet-600 dark:text-violet-400 border border-violet-500/20 text-xs font-black uppercase tracking-wider">
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>Enterprise Authorized</span>
          </div>
          <h3 className="text-3xl font-black tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-violet-600 via-indigo-600 to-purple-600 dark:from-violet-400 dark:via-indigo-300 dark:to-purple-400">
            {t('欢迎使用企业版')}
          </h3>
          <p className="text-sm text-muted-foreground font-medium">
            {t('授权验证成功，所有离线企业级高级功能已全面解锁')}
          </p>
        </div>

        {expiryDate && (
          <div className="animate-in fade-in duration-700 flex flex-col items-center space-y-3 pt-2">
            <Badge className="text-xs font-black py-1 px-4 rounded-xl bg-violet-500/10 border-violet-500/25 text-violet-600 dark:text-violet-400 shadow-xs">
              {t('授权有效期至：{date}', {
                date: formatDateTime(expiryDate, { showSeconds: false })
              })}
            </Badge>
            {timeLeft && (
              <div className="text-[11px] font-bold tracking-wider text-muted-foreground bg-muted/50 px-4 py-1.5 rounded-full border border-border/60 shadow-xs flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <span>{t('剩余时间：{time}', { time: timeLeft })}</span>
              </div>
            )}
          </div>
        )}

        <div className="pt-4 flex items-center justify-center gap-2 text-xs text-muted-foreground font-semibold">
          <Sparkles className="w-4 h-4 text-amber-500" />
          <span>{t('窗口将在数秒后自动完成激活闭环')}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3.5 mx-auto py-0.5">
      {/* 步骤一：在官网购买离线企业授权，获取授权码 */}
      <div
        className={`rounded-2xl border bg-card/60 dark:bg-card/40 backdrop-blur-md p-4 space-y-3 shadow-xs transition-all ${
          isOnline
            ? 'border-border/70 hover:border-violet-500/30'
            : 'border-amber-500/30 hover:border-amber-500/50'
        }`}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div
              className={`w-5 h-5 rounded-md font-mono font-black text-[11px] flex items-center justify-center ring-1 ${
                isOnline
                  ? 'bg-violet-500/15 text-violet-600 dark:text-violet-400 ring-violet-500/30'
                  : 'bg-amber-500/15 text-amber-600 dark:text-amber-400 ring-amber-500/30'
              }`}
            >
              01
            </div>
            <Label className="text-xs md:text-sm font-black tracking-tight text-foreground">
              {t('第一步：在官网购买离线企业授权，获取授权码')}
            </Label>
          </div>
        </div>

        {/* 系统在线：以前往官网购买离线企业授权为主，不显示标识码和说明 */}
        {isOnline ? (
          <div className="pt-0.5">
            <Button
              onClick={() => openMarketingPricingUrl('enterprise')}
              className="w-full h-11 text-xs md:text-sm font-bold rounded-xl gap-2 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-700 hover:to-indigo-700 text-white shadow-xs hover:shadow-violet-500/20 cursor-pointer transition-all duration-200"
            >
              <Sparkles className="w-4 h-4 text-amber-300" />
              <span>{t('前往官网购买离线企业授权')}</span>
              <ExternalLink className="w-3.5 h-3.5 ml-0.5 opacity-90" />
            </Button>
          </div>
        ) : (
          /* 系统不在线：以复制链接和说明为主，不显示链接按钮 */
          <>
            <div className="relative group">
              <Input
                readOnly
                value={
                  purchaseUrl || buildPricingUrlSync('enterprise', identCode || undefined)
                }
                className="font-mono text-xs md:text-sm bg-muted/40 border border-amber-500/30 h-12 pr-32 focus-visible:ring-amber-500/30 transition-all rounded-xl shadow-inner select-all text-foreground/90"
              />
              <Button
                variant="secondary"
                onClick={handleCopyUrl}
                className="absolute right-1 top-1 h-10 gap-1.5 bg-amber-500/15 hover:bg-amber-600 hover:text-white dark:bg-amber-500/20 text-amber-700 dark:text-amber-300 transition-all font-bold rounded-lg px-3.5 shadow-xs cursor-pointer text-xs border border-amber-500/30"
              >
                {hasCopiedUrl ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-500" />
                    <span className="text-emerald-500">{t('已复制链接')}</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>{t('一键复制链接')}</span>
                  </>
                )}
              </Button>
            </div>

            <div className="flex items-start gap-2.5 p-2.5 bg-amber-500/[0.08] rounded-xl border border-amber-500/25 text-[11px] text-muted-foreground leading-relaxed font-medium">
              <WifiOff className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
              <div className="space-y-1.5 w-full">
                <p className="font-bold text-foreground/90 flex items-center gap-1.5">
                  <span>{t('当前设备处于离线状态')}</span>
                  <span className="text-[10px] font-normal text-amber-600/90 dark:text-amber-400/90">
                    ({t('无法直接打开网页')})
                  </span>
                </p>
                <p>
                  {t(
                    '请点击上方按钮一键复制购买链接，发送到能上网的电脑或手机浏览器打开购买。该链接已内嵌本机设备标识，支付后即可生成对应专属授权码。'
                  )}
                </p>
              </div>
            </div>
          </>
        )}
      </div>



      {/* 步骤二：输入离线授权码 */}
      <div className="rounded-2xl border border-border/70 bg-card/60 dark:bg-card/40 backdrop-blur-md p-4 space-y-3 shadow-xs transition-all hover:border-violet-500/30">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 rounded-md bg-violet-500/15 text-violet-600 dark:text-violet-400 font-mono font-black text-[11px] flex items-center justify-center ring-1 ring-violet-500/30">
              02
            </div>
            <Label htmlFor="license" className="text-xs md:text-sm font-black tracking-tight text-foreground">
              {t('第二步：输入离线授权码')}
            </Label>
          </div>
          {licenseCode && (
            <button
              type="button"
              onClick={() => {
                setLicenseCode('')
                setError(null)
              }}
              className="text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              {t('清空输入')}
            </button>
          )}
        </div>

        <div className="space-y-2.5">
          <div className="relative">
            <Textarea
              id="license"
              placeholder={t('在此粘贴离线授权码...')}
              value={licenseCode}
              onChange={e => {
                setLicenseCode(e.target.value)
                if (error) setError(null)
              }}
              rows={3}
              className={`font-mono text-xs md:text-sm min-h-[76px] max-h-[110px] resize-none border-2 transition-all shadow-inner rounded-xl p-3 leading-relaxed break-all placeholder:text-muted-foreground/40 placeholder:font-sans placeholder:text-xs
                ${
                  error
                    ? 'border-destructive/50 bg-destructive/5 focus-visible:ring-destructive/20'
                    : 'border-violet-500/30 focus-visible:border-violet-500/60 focus-visible:ring-violet-500/20 bg-background'
                }
              `}
            />
          </div>

          <div className="flex items-center justify-between pt-0.5">
            <div className="text-[11px] font-mono text-muted-foreground">
              {licenseCode.trim() ? (
                <span className="text-violet-600 dark:text-violet-400 font-medium">
                  {t('已输入 {count} 个字符', { count: licenseCode.trim().length })}
                </span>
              ) : (
                <span className="text-muted-foreground/60">{t('离线授权码为长格式安全密文')}</span>
              )}
            </div>

            <div>
              {isActivating ? (
                <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-violet-600 dark:text-violet-400">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-violet-600" />
                  <span>{t('验证中...')}</span>
                </div>
              ) : (
                <Button
                  size="sm"
                  onClick={() => handleActivate(licenseCode)}
                  disabled={!licenseCode.trim()}
                  className="h-8.5 px-4 text-xs font-bold rounded-lg bg-violet-600 hover:bg-violet-700 text-white cursor-pointer shadow-xs disabled:opacity-40 gap-1.5"
                >
                  <span>{t('立即激活')}</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </Button>
              )}
            </div>
          </div>
        </div>

        {error && (
          <Alert
            variant="destructive"
            className="border border-destructive/30 shadow-sm bg-destructive/10 rounded-xl py-3 animate-in fade-in duration-200"
          >
            <div className="flex items-start gap-3">
              <ShieldAlert className="h-5 w-5 shrink-0 mt-0.5 text-destructive" />
              <div className="space-y-0.5">
                <AlertTitle className="font-bold text-sm leading-snug">
                  {t('授权验证未通过')}
                </AlertTitle>
                <AlertDescription className="font-medium text-xs opacity-90 leading-relaxed">
                  {error}
                </AlertDescription>
              </div>
            </div>
          </Alert>
        )}
      </div>

      {/* 底部保障与特性徽章 */}
      <div className="pt-2 flex flex-wrap items-center justify-center gap-3 text-[11px] font-semibold text-muted-foreground/80">
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-muted/40 border border-border/40">
          <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
          <span>{t('纯本地离线验签')}</span>
        </div>
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-muted/40 border border-border/40">
          <Lock className="w-3.5 h-3.5 text-violet-500" />
          <span>{t('硬件设备指纹绑定')}</span>
        </div>
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-muted/40 border border-border/40">
          <Zap className="w-3.5 h-3.5 text-amber-500" />
          <span>{t('永久或周期灵活授权')}</span>
        </div>
      </div>
    </div>
  )
}

const Badge: React.FC<{ children: React.ReactNode; className?: string }> = ({
  children,
  className
}) => (
  <div
    className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold transition-colors border border-transparent ${className}`}
  >
    {children}
  </div>
)
