import React, { useState, useEffect } from 'react'
import { intervalToDuration } from 'date-fns'
import { formatDateTime } from '@firefly/shared'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Alert, AlertDescription, AlertTitle } from '../ui/alert'
import {
  Copy,
  Mail,
  CheckCircle2,
  Loader2,
  ShieldAlert,
  Key,
  Sparkles,
  ExternalLink
} from 'lucide-react'
import { toast } from '../common/Toast'
import { t } from '@app/languages'
import confetti from 'canvas-confetti'
import { openExternalLink } from '../../lib/external-link'

interface EnterpriseLicenseFormProps {
  onActivated?: () => void
  tier?: 'pro' | 'enterprise'
}

export const EnterpriseLicenseForm: React.FC<EnterpriseLicenseFormProps> = ({
  onActivated,
  tier = 'enterprise'
}) => {
  const [invitationCode, setInvitationCode] = useState<string>('')
  const [licenseCode, setLicenseCode] = useState<string>('')
  const [isActivating, setIsActivating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isSuccess, setIsSuccess] = useState(false)
  const [expiryDate, setExpiryDate] = useState<string | null>(null)
  const [timeLeft, setTimeLeft] = useState<string>('')
  const [isCheckingInitialStatus, setIsCheckingInitialStatus] = useState(true)
  const [qrSrc, setQrSrc] = useState<string>('')

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
      if (window.electronAPI?.license) {
        // 获取我的标识码（Base64 编码，可逆）
        const code = await window.electronAPI.license.getBase64Code()
        setInvitationCode(code)

        // 用户已主动进入离线授权表单，无需调用 getStatus() 触发网络检测
        // 直接标记初始化完成，显示表单
      }
      setIsCheckingInitialStatus(false)
    }
    init()
  }, [])

  // 自动激活逻辑 (带防抖)
  useEffect(() => {
    // 如果已经成功或正在激活，不触发
    if (isSuccess || isActivating || isCheckingInitialStatus) return

    const code = licenseCode.trim()
    if (!code) {
      setError(null)
      return
    }

    const timer = setTimeout(() => {
      void handleActivate(code)
    }, 800) // 800ms 防抖

    return () => clearTimeout(timer)
  }, [licenseCode, isSuccess, isActivating, isCheckingInitialStatus])

  const fireCelebration = () => {
    const duration = 5 * 1000
    const animationEnd = Date.now() + duration
    const defaults = { startVelocity: 30, spread: 360, ticks: 60, zIndex: 10000 }

    const randomInRange = (min: number, max: number) => Math.random() * (max - min) + min

    const interval: any = setInterval(function () {
      const timeLeft = animationEnd - Date.now()

      if (timeLeft <= 0) {
        return clearInterval(interval)
      }

      const particleCount = 50 * (timeLeft / duration)
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

  const handleCopyRequestCode = () => {
    navigator.clipboard.writeText(invitationCode)
    toast.success(t('标识码已复制到剪贴板'))
  }

  const handleOpenEnterprisePage = () => {
    openExternalLink('https://aifolder.iocn.cn/pricing')
  }

  const handleActivate = async (code: string) => {
    if (!code) return

    setIsActivating(true)
    setError(null)

    try {
      const result = await window.electronAPI!.license.activate(code)
      if (result.success) {
        setIsSuccess(true)
        // 重新获取状态以更新过期时间
        const statusResult = await window.electronAPI!.license.getStatus()
        if (statusResult.expiry) {
          setExpiryDate(statusResult.expiry)
        }

        fireCelebration()
        toast.success(tier === 'pro' ? t('Pro 版授权激活成功！') : t('企业版授权激活成功！'))

        // 自动进入下一阶段 (延迟 5 秒以演示烟花效果)
        setTimeout(() => {
          if (onActivated) onActivated()
        }, 5000)
      } else {
        setError(result.error || t('激活失败，请检查授权码是否正确'))
      }
    } catch (e) {
      setError(t('激活过程中发生错误'))
    } finally {
      setIsActivating(false)
    }
  }

  if (isCheckingInitialStatus) {
    return (
      <div className="flex flex-col items-center justify-center py-12 space-y-4">
        <Loader2 className="w-10 h-10 animate-spin text-primary opacity-50" />
        <p className="text-sm text-muted-foreground animate-pulse">{t('正在同步授权状态...')}</p>
      </div>
    )
  }

  if (isSuccess) {
    return (
      <div className="flex flex-col items-center justify-center py-12 space-y-8 animate-in zoom-in-95 duration-500">
        <div className="relative">
          <div className="absolute inset-0 bg-primary/20 blur-3xl rounded-full animate-pulse" />
          <div className="relative bg-primary/10 p-8 rounded-full shadow-2xl ring-4 ring-primary/20">
            <CheckCircle2 className="w-24 h-20 text-primary animate-in zoom-in-50 duration-300" />
          </div>
        </div>
        <div className="text-center space-y-3">
          <h3 className="text-4xl font-black tracking-tighter bg-clip-text text-transparent bg-gradient-to-r from-primary to-blue-600">
            {tier === 'pro' ? t('欢迎使用 Pro 版') : t('欢迎使用企业版')}
          </h3>
          <p className="text-muted-foreground font-bold text-lg">
            {t('授权验证成功，所有高级功能已解锁')}
          </p>
        </div>
        <div className="flex gap-4">
          <Sparkles className="w-8 h-8 text-amber-500 animate-bounce" />
          <Sparkles className="w-8 h-8 text-amber-500 animate-bounce delay-150" />
          <Sparkles className="w-8 h-8 text-amber-500 animate-bounce delay-300" />
        </div>

        {expiryDate && (
          <div className="mt-8 animate-in fade-in duration-1000 flex flex-col items-center space-y-4">
            <Badge
              variant="outline"
              className="text-sm font-black py-1.5 px-6 rounded-2xl bg-primary/5 border-primary/20 text-primary"
            >
              {t('授权有效期至：{date}', {
                date: formatDateTime(expiryDate, { showSeconds: true })
              })}
            </Badge>
            {timeLeft && (
              <div className="text-[11px] font-black tracking-widest uppercase opacity-70 bg-muted/40 px-5 py-1.5 rounded-full border border-border/40 shadow-sm flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                {t('剩余时间：{time}', { time: timeLeft })}
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-10 animate-in slide-in-from-right-4 duration-300 max-w-xl mx-auto py-6">
      <div className="flex gap-6">
        <div className="flex-1 space-y-5">
          <div className="flex items-center gap-2.5 text-primary">
            <Key className="w-5 h-5" />
            <Label className="text-sm font-black tracking-widest uppercase opacity-80">
              {t('第一步：将我的标识码发送管理员')}
            </Label>
          </div>
          <div className="relative group">
            <Input
              readOnly
              value={invitationCode}
              className="font-mono text-lg bg-muted/40 border-2 border-border/60 h-16 pr-28 focus-visible:ring-primary/30 transition-all rounded-2xl shadow-sm"
            />
            <Button
              variant="secondary"
              onClick={handleCopyRequestCode}
              className="absolute right-2 top-2 h-12 gap-2 hover:bg-primary hover:text-primary-foreground transition-all font-black rounded-xl px-5 shadow-sm"
            >
              <Copy className="w-4 h-4" />
              {t('复制')}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-x-8 gap-y-1 text-base font-mono lowercase tracking-tighter">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground/60 text-sm">{t('微信')}:</span>
              <span className="text-foreground font-black">reloaded1234567</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground/60 text-sm">{t('邮箱')}:</span>
              <span className="text-foreground font-black">supply@iocn.cn</span>
            </div>
          </div>
        </div>
        <div className="shrink-0 flex flex-col items-center">
          {qrSrc ? (
            <div className="p-2 bg-white rounded-xl shadow-sm ring-1 ring-border/10">
              <img
                src={qrSrc}
                alt={t('微信二维码')}
                className="w-40 h-40 object-contain rounded-lg"
              />
            </div>
          ) : (
            <div className="w-40 h-40 bg-muted/30 rounded-xl animate-pulse flex items-center justify-center">
              <span className="text-xs text-muted-foreground">{t('加载中...')}</span>
            </div>
          )}
          <p className="text-[11px] text-muted-foreground font-medium mt-2">
            {t('扫码联系管理员')}
          </p>
        </div>
      </div>
      <div className="space-y-5">
        <div className="flex items-center gap-2.5 text-primary">
          <ShieldAlert className="w-5 h-5" />
          <Label
            htmlFor="license"
            className="text-sm font-black tracking-widest uppercase opacity-80"
          >
            {t('第二步：输入授权码')}
          </Label>
        </div>
        <div className="space-y-4">
          <div className="relative">
            <Input
              id="license"
              placeholder={
                tier === 'pro'
                  ? t('粘贴您购买的 Pro 版授权码...')
                  : t('粘贴管理员发送给您的企业版授权码...')
              }
              value={licenseCode}
              onChange={e => {
                setLicenseCode(e.target.value)
                if (error) setError(null)
              }}
              className={`font-mono text-lg h-20 border-2 transition-all shadow-inner rounded-2xl text-center placeholder:text-muted-foreground/40 placeholder:font-sans placeholder:text-sm pr-14
                                ${error ? 'border-destructive/50 bg-destructive/5' : 'border-primary/20 focus-visible:border-primary/50 focus-visible:ring-primary/20 bg-background'}
                            `}
            />
            {isActivating && (
              <div className="absolute right-4 top-1/2 -translate-y-1/2">
                <Loader2 className="w-7 h-7 animate-spin text-primary" />
              </div>
            )}
            {!isActivating && error && (
              <div className="absolute right-4 top-1/2 -translate-y-1/2">
                <ShieldAlert className="w-7 h-7 text-destructive" />
              </div>
            )}
          </div>
        </div>
      </div>
      {/* 错误提示 */}
      {error && (
        <Alert
          variant="destructive"
          className="border-2 shadow-lg bg-destructive/5 rounded-2xl py-5"
        >
          <div className="flex items-start gap-4">
            <ShieldAlert className="h-6 w-6 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <AlertTitle className="font-black text-base leading-none">
                {t('授权验证失败')}
              </AlertTitle>
              <AlertDescription className="font-bold opacity-90 text-sm">{error}</AlertDescription>
            </div>
          </div>
        </Alert>
      )}
    </div>
  )
}

// 辅助组件
const Badge: React.FC<{ children: React.ReactNode; variant?: string; className?: string }> = ({
  children,
  className
}) => (
  <div
    className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 border border-transparent ${className}`}
  >
    {children}
  </div>
)
