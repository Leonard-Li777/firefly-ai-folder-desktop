import React, { useState, useEffect, useMemo } from 'react'
import { intervalToDuration } from 'date-fns'
import { formatDateTime } from '@firefly/shared'
import QRCode from 'qrcode'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Alert, AlertDescription, AlertTitle } from '../ui/alert'
import {
  Copy,
  CheckCircle2,
  Loader2,
  ShieldAlert,
  Sparkles,
  ExternalLink,
  ChevronLeft,
  Mail,
  Send,
  RefreshCw,
  SendHorizontal
} from 'lucide-react'
import { toast } from '../common/Toast'
import { t } from '@app/languages'
import confetti from 'canvas-confetti'
import {
  buildEnterprisePricingUrl,
  buildSupportMailto,
  TELEGRAM_CHANNEL_URL,
  openMarketingPricingUrl
} from '../../lib/marketing-link'
import { openExternalLink } from '../../lib/external-link'
import type { AppRegion } from '../../lib/app-region'
import { useTierStore } from '../../stores/tier-store'

export type IdentCodeState =
  | { status: 'loading' }
  | { status: 'ready'; identCode: string }
  | { status: 'error'; reason: 'ipc-failed' | 'invalid-format' | 'empty' }

export interface EnterpriseLicenseFormProps {
  region: AppRegion
  identState: IdentCodeState
  onRetryIdent: () => void
  licenseDraft: string
  onDraftChange: (draft: string) => void
  onBack: () => void
  onActivated?: () => void
  tier?: 'pro' | 'enterprise'
}

export type DomesticQrTab = 'miniprogram_pay' | 'wechat_contact'

export const LICENSE_MIN_LENGTH = 50
export const LICENSE_MAX_LENGTH = 512

export const EnterpriseLicenseForm: React.FC<EnterpriseLicenseFormProps> = ({
  region,
  identState,
  onRetryIdent,
  licenseDraft,
  onDraftChange,
  onBack,
  onActivated,
  tier = 'enterprise'
}) => {
  const [isActivating, setIsActivating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isSuccess, setIsSuccess] = useState(false)
  const [expiryDate, setExpiryDate] = useState<string | null>(null)
  const [timeLeft, setTimeLeft] = useState<string>('')

  // 国内版二维码 Tab 切换（纯同步状态，零异步竞态）
  const [qrTab, setQrTab] = useState<DomesticQrTab>('miniprogram_pay')

  // 离线动态生成的支付二维码 DataURL
  const [payQrDataUrl, setPayQrDataUrl] = useState<string | null>(null)
  const [isQrRendering, setIsQrRendering] = useState<boolean>(false)

  // 内置静态微信二维码资源路径
  const [staticWechatQrSrc, setStaticWechatQrSrc] = useState<string>('')
  const [staticQrLoadFailed, setStaticQrLoadFailed] = useState(false)

  const isIdentReady = identState.status === 'ready'
  const currentIdentCode = isIdentReady ? identState.identCode : ''

  // 加载包体内置的静态微信二维码图片
  useEffect(() => {
    const loadStaticQR = async () => {
      try {
        if (window.electronAPI?.utils?.getResourcesPath) {
          const resourcesPath = await window.electronAPI.utils.getResourcesPath()
          const imagePath = `${resourcesPath}\\assets\\wechat-qr.jpg`
          setStaticWechatQrSrc(`file:///${imagePath.replace(/\\/g, '/')}`)
        }
      } catch (err) {
        console.warn('[EnterpriseLicenseForm] 读取内置微信二维码资源异常:', err)
        setStaticQrLoadFailed(true)
      }
    }
    void loadStaticQR()
  }, [])

  // 离线动态生成购买二维码（带参专属落地页，开发模式自动路由至本地 marketing-home 端口）
  useEffect(() => {
    if (!isIdentReady || !currentIdentCode) {
      setPayQrDataUrl(null)
      return
    }

    let cancelled = false
    setIsQrRendering(true)

    try {
      const pricingUrl = buildEnterprisePricingUrl({
        region,
        identCode: currentIdentCode
      })

      QRCode.toDataURL(pricingUrl, {
        width: 220,
        margin: 1,
        color: {
          dark: '#0f172a',
          light: '#ffffff'
        },
        errorCorrectionLevel: 'M'
      })
        .then(url => {
          if (!cancelled) {
            setPayQrDataUrl(url)
            setIsQrRendering(false)
          }
        })
        .catch(err => {
          console.error('[EnterpriseLicenseForm] 本地二维码绘制失败:', err)
          if (!cancelled) {
            setIsQrRendering(false)
          }
        })
    } catch (err) {
      console.error('[EnterpriseLicenseForm] 构造购买链接失败:', err)
      setIsQrRendering(false)
    }

    return () => {
      cancelled = true
    }
  }, [region, isIdentReady, currentIdentCode])

  // 倒计时刷新
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

  const fireCelebration = () => {
    const duration = 5 * 1000
    const animationEnd = Date.now() + duration
    const defaults = { startVelocity: 30, spread: 360, ticks: 60, zIndex: 10000 }
    const randomInRange = (min: number, max: number) => Math.random() * (max - min) + min

    const interval: any = setInterval(() => {
      const left = animationEnd - Date.now()
      if (left <= 0) return clearInterval(interval)
      const particleCount = 50 * (left / duration)
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

  const handleCopyIdentCode = () => {
    if (!isIdentReady || !currentIdentCode) return
    navigator.clipboard.writeText(currentIdentCode)
    toast.success(t('电脑识别码已复制'))
  }

  const handleCopyText = (text: string, tip: string) => {
    navigator.clipboard.writeText(text)
    toast.success(tip)
  }

  const handleOpenPricingPage = () => {
    if (!isIdentReady || !currentIdentCode) return
    void openMarketingPricingUrl('enterprise')
  }

  const handleSendMail = () => {
    if (!isIdentReady || !currentIdentCode) return
    const mailto = buildSupportMailto(currentIdentCode)
    window.location.href = mailto
  }

  const handleOpenTelegram = () => {
    void openExternalLink(TELEGRAM_CHANNEL_URL)
  }

  const handleActivate = async () => {
    const cleanCode = licenseDraft.trim().replace(/\s+/g, '')
    if (!cleanCode) {
      setError(t('请先输入授权码'))
      return
    }

    if (cleanCode.length < LICENSE_MIN_LENGTH) {
      setError(t('授权码长度不足，请确认是否复制完整'))
      return
    }

    setIsActivating(true)
    setError(null)

    try {
      const result = await window.electronAPI!.license.activate(cleanCode)
      if (result.success) {
        setIsSuccess(true)
        const statusResult = await window.electronAPI!.license.getStatus()
        if (statusResult.expiry) {
          setExpiryDate(statusResult.expiry)
        }
        // 激活成功后主动刷新等级 store，确保门控与头像菜单同步切换
        await useTierStore.getState().fetchProfile()
        fireCelebration()
        toast.success(tier === 'pro' ? t('Pro 版授权激活成功！') : t('企业版授权激活成功！'))
        setTimeout(() => {
          if (onActivated) onActivated()
        }, 5000)
      } else {
        // 全量大白话，严禁出现密码学术语
        setError(t('这个授权码不对，请确认复制完整后重试；如刚购买，请等几分钟再试'))
      }
    } catch (e) {
      setError(t('这个授权码不对，请确认复制完整后重试；如刚购买，请等几分钟再试'))
    } finally {
      setIsActivating(false)
    }
  }

  // 成功激活展示页
  if (isSuccess) {
    return (
      <div className="flex flex-col items-center justify-center py-10 space-y-6 animate-in zoom-in-95 duration-500">
        <div className="relative">
          <div className="absolute inset-0 bg-primary/20 blur-3xl rounded-full animate-pulse" />
          <div className="relative bg-primary/10 p-6 rounded-full shadow-2xl ring-4 ring-primary/20">
            <CheckCircle2 className="w-20 h-16 text-primary animate-in zoom-in-50 duration-300" />
          </div>
        </div>
        <div className="text-center space-y-2">
          <h3 className="text-3xl font-black tracking-tight text-slate-800">
            {tier === 'pro' ? t('欢迎使用 Pro 版') : t('欢迎使用企业版')}
          </h3>
          <p className="text-muted-foreground font-bold text-sm">
            {t('授权验证成功，所有高级功能已解锁')}
          </p>
        </div>
        <div className="flex gap-4">
          <Sparkles className="w-6 h-6 text-amber-500 animate-bounce" />
          <Sparkles className="w-6 h-6 text-amber-500 animate-bounce delay-150" />
          <Sparkles className="w-6 h-6 text-amber-500 animate-bounce delay-300" />
        </div>

        {expiryDate && (
          <div className="mt-4 flex flex-col items-center space-y-3">
            <div className="text-xs font-bold py-1 px-4 rounded-xl bg-primary/10 border border-primary/20 text-primary">
              {t('授权有效期至：{date}', {
                date: formatDateTime(expiryDate, { showSeconds: true })
              })}
            </div>
            {timeLeft && (
              <div className="text-[11px] font-medium text-slate-500 bg-muted/40 px-4 py-1 rounded-full border border-border/40">
                {t('剩余时间：{time}', { time: timeLeft })}
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  const isCn = region === 'cn'

  return (
    <div className="space-y-3.5 animate-in slide-in-from-right-4 duration-200">
      {/* 紧凑顶导条：替代原有臃肿Header，彻底释放纵向高度 */}
      <div className="flex items-center justify-between px-1 pb-2 border-b border-border/60">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onBack}
            className="h-7 px-2 gap-1 text-xs font-bold text-muted-foreground hover:text-foreground cursor-pointer"
          >
            <ChevronLeft className="w-4 h-4" />
            {t('返回')}
          </Button>
          <div className="h-3.5 w-[1px] bg-border/80" />
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-primary" />
            <span className="text-xs font-black text-foreground">{t('企业离线授权')}</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground hidden sm:inline">
            {t('一次激活，没网也能永久正常用')}
          </span>
          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-primary/10 text-primary border border-primary/20">
            {isCn ? t('国内服务') : t('Global Service')}
          </span>
        </div>
      </div>

      {/* 第一步：获取授权卡片 */}
      <div className="rounded-2xl border border-border/80 bg-muted/30 p-3.5 shadow-xs space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 rounded-md bg-primary text-primary-foreground text-[11px] font-black flex items-center justify-center shadow-xs">
              1
            </div>
            <span className="text-xs font-bold text-foreground">{t('第一步：获取授权')}</span>
          </div>
          {isIdentReady ? (
            <span className="text-[11px] text-emerald-600 font-medium">
              ● {t('已自动绑定本机')}
            </span>
          ) : (
            <span className="text-[11px] text-amber-600 font-medium">
              {t('正在准备设备信息...')}
            </span>
          )}
        </div>

        <div className="grid grid-cols-12 gap-3.5 items-stretch">
          {/* 左栏：识别码 + 前往官网查看价格 + 客服联系方式 */}
          <div className="col-span-12 sm:col-span-7 flex flex-col justify-between space-y-2.5">
            {/* 这台电脑的识别码 */}
            <div className="bg-background rounded-xl p-2.5 border border-border/80 shadow-xs">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-bold text-foreground">{t('这台电脑的识别码')}</span>
                {identState.status === 'error' && (
                  <Button
                    variant="link"
                    size="sm"
                    onClick={onRetryIdent}
                    className="h-auto p-0 text-[10px] text-destructive flex items-center gap-0.5"
                  >
                    <RefreshCw className="w-3 h-3" />
                    {t('重试')}
                  </Button>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <div className="flex-1 font-mono text-[11px] bg-muted/50 border border-border/60 text-foreground rounded-lg py-1.5 px-2.5 truncate select-all">
                  {identState.status === 'loading' && t('正在读取设备编号...')}
                  {identState.status === 'error' && t('暂时未能读取到设备编号')}
                  {isIdentReady && currentIdentCode}
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleCopyIdentCode}
                  disabled={!isIdentReady}
                  className="shrink-0 h-8 px-2.5 text-xs font-bold gap-1 cursor-pointer"
                >
                  <Copy className="w-3.5 h-3.5" />
                  {t('复制')}
                </Button>
              </div>
            </div>

            {/* 前往官网查看价格 */}
            <Button
              variant="outline"
              size="sm"
              onClick={handleOpenPricingPage}
              disabled={!isIdentReady}
              className="w-full h-9 rounded-xl font-bold text-xs gap-1.5 shadow-xs border-border/90 hover:text-primary transition-all cursor-pointer"
            >
              <ExternalLink className="w-3.5 h-3.5 text-primary" />
              <span>{isCn ? t('前往官网查看价格') : t('View Pricing on Website')}</span>
            </Button>

            {/* 客服与官方联系方式条目 */}
            <div className="bg-background rounded-xl p-2.5 border border-border/80 text-xs space-y-1.5 shadow-xs">
              {isCn ? (
                <>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">{t('客服微信：')}</span>
                    <span className="font-mono font-bold select-all">reloaded1234567</span>
                    <button
                      onClick={() => handleCopyText('reloaded1234567', t('微信号已复制'))}
                      className="text-primary hover:underline font-bold text-[11px] cursor-pointer"
                    >
                      {t('复制')}
                    </button>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">{t('客服邮箱：')}</span>
                    <span className="font-mono select-all">support@iocn.cn</span>
                    <button
                      onClick={() => handleCopyText('support@iocn.cn', t('邮箱已复制'))}
                      className="text-primary hover:underline font-bold text-[11px] cursor-pointer"
                    >
                      {t('复制')}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">{t('Official Email:')}</span>
                    <span className="font-mono font-bold select-all">support@aifolder.net</span>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={handleSendMail}
                        disabled={!isIdentReady}
                        className="text-primary hover:underline font-bold text-[11px] cursor-pointer"
                      >
                        {t('Send')}
                      </button>
                      <span className="text-border">|</span>
                      <button
                        onClick={() => handleCopyText('support@aifolder.net', t('邮箱已复制'))}
                        className="text-primary hover:underline font-bold text-[11px] cursor-pointer"
                      >
                        {t('复制')}
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">{t('Telegram:')}</span>
                    <span className="font-mono">@firefly_ai_folder</span>
                    <button
                      onClick={handleOpenTelegram}
                      className="text-primary hover:underline font-bold text-[11px] cursor-pointer"
                    >
                      {t('Join')}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* 右栏：扫码购买 / 联系客服 二维码卡片 */}
          <div className="col-span-12 sm:col-span-5 bg-background rounded-xl p-2.5 border border-border/80 shadow-xs flex flex-col items-center justify-between min-h-[170px]">
            {/* 国内版胶囊切换条；国际版隐藏 */}
            {isCn ? (
              <div className="w-full p-0.5 bg-muted rounded-lg flex text-[10px] font-bold">
                <button
                  type="button"
                  onClick={() => setQrTab('miniprogram_pay')}
                  className={`flex-1 py-1 rounded-md transition text-center cursor-pointer ${
                    qrTab === 'miniprogram_pay'
                      ? 'bg-background shadow-xs text-primary font-bold'
                      : 'text-muted-foreground hover:text-foreground font-medium'
                  }`}
                >
                  📱 {t('扫码购买')}
                </button>
                <button
                  type="button"
                  onClick={() => setQrTab('wechat_contact')}
                  className={`flex-1 py-1 rounded-md transition text-center cursor-pointer ${
                    qrTab === 'wechat_contact'
                      ? 'bg-background shadow-xs text-primary font-bold'
                      : 'text-muted-foreground hover:text-foreground font-medium'
                  }`}
                >
                  💬 {t('加微信')}
                </button>
              </div>
            ) : (
              <div className="text-[11px] font-bold text-foreground">
                📱 {t('Scan to purchase online')}
              </div>
            )}

            {/* 二维码图像渲染区 */}
            <div className="my-1.5 p-1.5 rounded-xl bg-white border border-border/80 shadow-inner text-center relative flex items-center justify-center min-w-[110px] min-h-[110px]">
              {isCn && qrTab === 'wechat_contact' ? (
                staticWechatQrSrc && !staticQrLoadFailed ? (
                  <img
                    src={staticWechatQrSrc}
                    alt={t('客服微信二维码')}
                    onError={() => setStaticQrLoadFailed(true)}
                    className="w-26 h-26 object-contain rounded-lg"
                    style={{ width: '104px', height: '104px' }}
                  />
                ) : (
                  <div
                    className="w-26 h-26 flex flex-col items-center justify-center p-2 text-center"
                    style={{ width: '104px', height: '104px' }}
                  >
                    <p className="text-[10px] text-muted-foreground">{t('添加客服微信号：')}</p>
                    <p className="font-mono font-bold text-[11px] text-foreground mt-1">
                      reloaded1234567
                    </p>
                  </div>
                )
              ) : /* 动态生成的扫码购买二维码（国内小程序专属 / 国际价格页） */
              isQrRendering ? (
                <div
                  className="w-26 h-26 flex flex-col items-center justify-center"
                  style={{ width: '104px', height: '104px' }}
                >
                  <Loader2 className="w-5 h-5 animate-spin text-primary opacity-60" />
                  <span className="text-[10px] text-muted-foreground mt-1">{t('生成中...')}</span>
                </div>
              ) : payQrDataUrl ? (
                <img
                  src={payQrDataUrl}
                  alt={t('购买二维码')}
                  className="w-26 h-26 object-contain rounded-lg"
                  style={{ width: '104px', height: '104px' }}
                />
              ) : (
                <div
                  className="w-26 h-26 flex flex-col items-center justify-center p-2 text-center"
                  style={{ width: '104px', height: '104px' }}
                >
                  <span className="text-[10px] text-muted-foreground">{t('准备中...')}</span>
                </div>
              )}
            </div>

            <p className="text-[10px] text-muted-foreground text-center font-medium">
              {isCn && qrTab === 'wechat_contact'
                ? t('扫码添加客服微信')
                : t('手机扫一扫，直接开通')}
            </p>
          </div>
        </div>
      </div>

      {/* 第二步：粘贴授权码 */}
      <div className="rounded-2xl border-2 border-emerald-500/25 bg-gradient-to-r from-emerald-50/40 via-background to-emerald-50/20 p-3 shadow-xs space-y-2">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded-md bg-emerald-600 text-white text-[11px] font-black flex items-center justify-center shadow-xs">
            2
          </div>
          <span className="text-xs font-bold text-foreground">{t('第二步：粘贴授权码')}</span>
        </div>

        <div className="flex items-center gap-2">
          <Input
            id="license"
            placeholder={t('收到授权码后，直接粘贴在这里...')}
            value={licenseDraft}
            onChange={e => {
              onDraftChange(e.target.value.trim().replace(/\s+/g, ''))
              if (error) setError(null)
            }}
            className="flex-1 font-mono text-xs h-9 bg-background border-border/80 focus-visible:ring-emerald-500/30 focus-visible:border-emerald-500"
          />
          <Button
            type="button"
            onClick={handleActivate}
            disabled={isActivating || licenseDraft.length < LICENSE_MIN_LENGTH}
            className="shrink-0 h-9 px-5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white font-bold text-xs rounded-xl shadow-md shadow-emerald-600/20 active:scale-95 transition cursor-pointer"
          >
            {isActivating ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
            ) : (
              <Sparkles className="w-3.5 h-3.5 mr-1.5" />
            )}
            {t('激活使用')}
          </Button>
        </div>
      </div>

      {/* 错误提示框 */}
      {error && (
        <Alert variant="destructive" className="py-2.5 px-3 rounded-xl">
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle className="text-xs font-bold">{t('授权验证失败')}</AlertTitle>
          <AlertDescription className="text-xs opacity-90">{error}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}
