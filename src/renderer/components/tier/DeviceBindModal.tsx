import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import {
  Smartphone,
  RefreshCw,
  CheckCircle2,
  ShieldCheck,
  Laptop,
  AlertCircle,
  Mail,
  Gift
} from 'lucide-react'
import { useTierStore } from '../../stores/tier-store'
import { toast } from '../common/Toast'
import { DeviceEvictDialog } from './DeviceEvictDialog'

interface DeviceBindModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface BindCodeData {
  code: string
  pollSecret: string
  imageDataUrl: string
  deviceLabel?: string
  platform?: string
  machineIdTail?: string
  expiresAt?: string
}

type BindStep = 'qr_loading' | 'qr_polling' | 'email_input' | 'submitting' | 'success'

function formatErrorMessage(err?: string, fallbackMessage?: string): string {
  if (!err && !fallbackMessage) return '网络开小差了，请点击重试'
  if (err === 'RATE_LIMIT_EXCEEDED') return '操作过于频繁，请 1 分钟后再试'
  if (err === 'machine_id_missing') return '未检测到当前电脑硬件标识'
  if (err === 'BIND_SESSION_EXPIRED') return '登录凭证已超时，请重新扫码'
  if (err === 'CLAIM_PENDING') return '当前二维码正在被其他手机确认，请稍等或点击刷新二维码'
  if (err === 'INVALID_CODE') return '验证码输入错误或已失效'
  if (err === 'DISPOSABLE_DOMAIN') return '请使用常见的个人邮箱，暂不支持临时或一次性邮箱'
  if (err === 'EMAIL_OCCUPIED') return '该邮箱已被其他账号使用，请更换邮箱'
  if (err === 'SEAT_FAILED' || err === 'MISSING_SESSION_TOKEN') {
    return fallbackMessage || '当前电脑登录席位激活失败，请点击重试或刷新二维码'
  }
  if (err === 'SESSION_EXPIRED' || err === 'UNAUTHORIZED') {
    return '扫码登录状态已过期，请刷新二维码重新扫码'
  }
  if (err === 'EVICT_QUOTA_EXCEEDED') {
    return fallbackMessage || '本月自助换绑次数已用完，请替换闲置超过 90 天的旧电脑或联系客服'
  }
  if (err === 'CONCURRENT_LOCK_RETRY') {
    return '当前账号正在另一台设备操作换绑，请稍后重试'
  }
  return fallbackMessage || err || '网络开小差了，请点击重试'
}

export const DeviceBindModal: React.FC<DeviceBindModalProps> = ({ open, onOpenChange }) => {
  const { syncFromCloud } = useTierStore()
  const [step, setStep] = useState<BindStep>('qr_loading')
  const [bindData, setBindData] = useState<BindCodeData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [deviceConsumedInvitation, setDeviceConsumedInvitation] = useState<boolean>(false)
  const [evictOpen, setEvictOpen] = useState<boolean>(false)
  const [pendingSessionToken, setPendingSessionToken] = useState<string>('')

  // 阶段二：邮箱与邀请码输入状态
  const [email, setEmail] = useState<string>('')
  const [otpCode, setOtpCode] = useState<string>('')
  const [invitationCode, setInvitationCode] = useState<string>('')
  const [sendingOtp, setSendingOtp] = useState<boolean>(false)
  const [cooldown, setCooldown] = useState<number>(0)

  const pollTimerRef = useRef<NodeJS.Timeout | null>(null)
  const cooldownTimerRef = useRef<NodeJS.Timeout | null>(null)
  const loadRequestIdRef = useRef<number>(0)

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }, [])

  // 倒计时管理
  useEffect(() => {
    if (cooldown > 0) {
      cooldownTimerRef.current = setTimeout(() => {
        setCooldown(c => c - 1)
      }, 1000)
    }
    return () => {
      if (cooldownTimerRef.current) {
        clearTimeout(cooldownTimerRef.current)
      }
    }
  }, [cooldown])

  // 启动时检查是否有未完成的断点会话（先查未入席会话，再查待补绑邮箱会话）
  const checkInitialSession = useCallback(async () => {
    try {
      if (window.electronAPI?.deviceBind?.getUnseatedSession) {
        const unseatedRes = await window.electronAPI.deviceBind.getUnseatedSession()
        if (unseatedRes?.unseated && unseatedRes?.sessionToken) {
          setPendingSessionToken(unseatedRes.sessionToken)
          setStep('qr_polling')
          setEvictOpen(true)
          return true
        }
      }
      if (window.electronAPI?.deviceBind?.hasActiveBindSession) {
        const hasSession = await window.electronAPI.deviceBind.hasActiveBindSession()
        if (hasSession) {
          // 查询本机是否已参加过好友邀请活动
          try {
            if (window.electronAPI?.deviceBind?.getStatus) {
              const statusRes = await window.electronAPI.deviceBind.getStatus()
              setDeviceConsumedInvitation(!!statusRes?.device_consumed_invitation)
            }
          } catch (statusErr) {
            console.warn('[DeviceBindModal] 查询设备绑定状态失败:', statusErr)
          }
          setStep('email_input')
          return true
        }
      }
    } catch (err) {
      console.warn('[DeviceBindModal] 检查初始绑定会话失败，回退为扫码登录:', err)
    }
    return false
  }, [])

  // 获取绑定短凭据与微信官方小程序码
  const loadBindCode = useCallback(
    async (forceRefresh = false) => {
      const currentRequestId = ++loadRequestIdRef.current
      setStep('qr_loading')
      setError(null)
      stopPolling()

      try {
        if (!window.electronAPI?.deviceBind?.createCode) {
          throw new Error('设备绑定接口未就绪')
        }

        // 先查询本机是否已参与过好友邀请活动
        try {
          const statusRes = await window.electronAPI.deviceBind.getStatus()
          setDeviceConsumedInvitation(!!statusRes?.device_consumed_invitation)
        } catch (statusErr) {
          console.warn('[DeviceBindModal] 查询邀请资格状态警告:', statusErr)
        }

        const res = await window.electronAPI.deviceBind.createCode({ forceRefresh })
        if (currentRequestId !== loadRequestIdRef.current || !open) {
          return
        }

        if (!res.success || !res.code || !res.pollSecret) {
          throw new Error(formatErrorMessage(res.error))
        }

        if (!res.imageDataUrl || !res.imageDataUrl.startsWith('data:image/')) {
          throw new Error('微信二维码生成未完成，请点击刷新重试')
        }

        setBindData({
          code: res.code,
          pollSecret: res.pollSecret,
          imageDataUrl: res.imageDataUrl,
          deviceLabel: res.deviceLabel,
          platform: res.platform,
          machineIdTail: res.machineIdTail,
          expiresAt: res.expiresAt
        })
        setStep('qr_polling')

        // 启动轮询检查设备认领与席位入座结果
        pollTimerRef.current = setInterval(async () => {
          if (currentRequestId !== loadRequestIdRef.current || !open) {
            stopPolling()
            return
          }
          try {
            if (!window.electronAPI?.deviceBind?.pollResult) return
            const pollRes = await window.electronAPI.deviceBind.pollResult({
              code: res.code!,
              pollSecret: res.pollSecret!
            })

            if (pollRes?.success) {
              if (pollRes.status === 'bound' && pollRes.seated !== false) {
                stopPolling()
                setStep('success')
                toast.success('微信设备绑定成功！')
                await syncFromCloud().catch(syncErr => {
                  console.warn('[DeviceBindModal] 绑定成功后同步云端权益失败:', syncErr)
                })
                setTimeout(() => {
                  onOpenChange(false)
                }, 1200)
              } else if (pollRes.status === 'need_evict') {
                stopPolling()
                setPendingSessionToken(pollRes.device_token || '')
                setEvictOpen(true)
              }
            } else if (pollRes?.error === 'CODE_EXPIRED' || pollRes?.status === 'expired') {
              stopPolling()
              setError('二维码已过期，请点击刷新二维码重试')
            } else if (pollRes?.status === 'error' || pollRes?.error) {
              stopPolling()
              setError(formatErrorMessage(pollRes.error, pollRes.message))
            }
          } catch (pollErr) {
            console.warn('[DeviceBindModal] 轮询绑定状态网络波动，将自动重试:', pollErr)
          }
        }, 2500)
      } catch (err: any) {
        if (currentRequestId === loadRequestIdRef.current && open) {
          setError(formatErrorMessage(undefined, err?.message))
          setStep('qr_polling')
        }
      }
    },
    [open, onOpenChange, stopPolling, syncFromCloud]
  )

  useEffect(() => {
    if (open) {
      checkInitialSession().then(resumed => {
        if (!resumed) {
          loadBindCode()
        }
      })
    } else {
      stopPolling()
      setBindData(null)
      setError(null)
      setStep('qr_loading')
    }
    return () => {
      stopPolling()
    }
  }, [open, loadBindCode, stopPolling, checkInitialSession])

  // 发送邮箱验证码
  const handleSendOtp = async () => {
    const cleanEmail = email.trim()
    if (!cleanEmail || !cleanEmail.includes('@') || !cleanEmail.includes('.')) {
      toast.error('请输入格式正确的邮箱地址')
      return
    }

    setSendingOtp(true)
    setError(null)
    try {
      const res = await window.electronAPI.deviceBind.sendEmailOtp({ email: cleanEmail })
      if (res?.success) {
        toast.success('验证码已发送至您的邮箱，请注意查收')
        setCooldown(res.cooldown_seconds || 60)
      } else {
        toast.error(formatErrorMessage(res?.error))
      }
    } catch (err: any) {
      toast.error(formatErrorMessage(err?.message))
    } finally {
      setSendingOtp(false)
    }
  }

  // 提交完成绑定
  const handleSubmitEmailBinding = async () => {
    const cleanEmail = email.trim()
    const cleanOtp = otpCode.trim()
    const cleanInvite = invitationCode.trim()

    if (!cleanEmail || !cleanEmail.includes('@')) {
      toast.error('请输入正确的常用邮箱')
      return
    }
    if (!cleanOtp || cleanOtp.length < 6) {
      toast.error('请输入 6 位邮箱验证码')
      return
    }

    setStep('submitting')
    setError(null)

    try {
      const res = await window.electronAPI.deviceBind.completeEmailBinding({
        email: cleanEmail,
        code: cleanOtp,
        invitationCode: cleanInvite || undefined
      })

      if (res?.success && res.status === 'active') {
        // 邀请兑换结果温和提示
        if (cleanInvite && res.invitation_result) {
          if (res.invitation_result.success) {
            toast.success('邮箱绑定成功！已额外获得好友邀请分析额度与萤火奖励')
          } else {
            toast.warning(`邮箱绑定成功！但${res.invitation_result.message || '邀请码未生效'}`)
          }
        } else {
          toast.success('账号激活与设备绑定成功！')
        }

        setStep('success')
        await syncFromCloud().catch(syncErr => {
          console.warn('[DeviceBindModal] 邮箱激活后同步云端权益失败:', syncErr)
        })
        setTimeout(() => {
          onOpenChange(false)
        }, 1200)
      } else {
        setError(formatErrorMessage(res?.error))
        setStep('email_input')
      }
    } catch (err: any) {
      setError(formatErrorMessage(err?.message))
      setStep('email_input')
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={nextOpen => {
        // 严格硬门控守则：未绑定成功前严禁通过任何外部途径关闭
        if (step === 'success' && !nextOpen) {
          onOpenChange(false)
        }
      }}
    >
      <DialogContent
        className="sm:max-w-md p-6 bg-card text-card-foreground border-border/80 shadow-2xl [&>button:last-child]:hidden select-none"
        onPointerDownOutside={e => e.preventDefault()}
        onEscapeKeyDown={e => e.preventDefault()}
      >
        <DialogHeader className="text-center sm:text-center space-y-1">
          <div className="mx-auto w-12 h-12 rounded-2xl bg-primary/10 text-primary flex items-center justify-center mb-1">
            {step === 'email_input' || step === 'submitting' ? (
              <Mail className="w-6 h-6 text-primary" />
            ) : (
              <Smartphone className="w-6 h-6" />
            )}
          </div>
          <DialogTitle className="text-lg font-bold tracking-tight">
            {step === 'email_input' || step === 'submitting'
              ? '绑定常用邮箱 · 激活软件账号'
              : '微信扫码登录 · 绑定当前电脑'}
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {step === 'email_input' || step === 'submitting'
              ? '请验证常用个人邮箱，用于接收重要升级与账户安全通知'
              : '使用微信扫描小程序码，同一账号支持在多台设备间共享权益'}
          </DialogDescription>
        </DialogHeader>

        {/* 阶段一：微信小程序扫码 */}
        {(step === 'qr_loading' || step === 'qr_polling') && (
          <div className="flex flex-col items-center justify-center py-2 space-y-4">
            <div className="relative w-64 h-64 rounded-2xl border border-border/60 bg-white flex items-center justify-center overflow-hidden shadow-inner p-2">
              {step === 'qr_loading' && (
                <div className="flex flex-col items-center gap-2 text-muted-foreground text-xs">
                  <RefreshCw className="w-6 h-6 animate-spin text-primary" />
                  <span>正在生成微信专属二维码...</span>
                </div>
              )}

              {step === 'qr_polling' && error && (
                <div className="flex flex-col items-center p-4 text-center gap-2">
                  <AlertCircle className="w-8 h-8 text-destructive" />
                  <span className="text-xs text-destructive font-medium">{error}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2 text-xs h-8"
                    onClick={() => loadBindCode(true)}
                  >
                    <RefreshCw className="w-3.5 h-3.5 mr-1" /> 重试
                  </Button>
                </div>
              )}

              {step === 'qr_polling' && !error && bindData?.imageDataUrl && (
                <div className="flex flex-col items-center justify-center w-full h-full">
                  <img
                    src={bindData.imageDataUrl}
                    alt="微信扫码绑定"
                    className="w-56 h-56 object-contain"
                  />
                </div>
              )}
            </div>

            {bindData?.code && (
              <div className="w-full space-y-2">
                <div className="flex items-center justify-between px-3 py-2 bg-muted/40 rounded-lg border border-border/50 text-xs">
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <ShieldCheck className="w-4 h-4 text-primary" />
                    <span>设备校验码:</span>
                  </div>
                  <span className="font-mono font-bold tracking-widest text-primary text-sm">
                    {bindData.code}
                  </span>
                </div>

                <div className="flex items-center justify-between px-3 py-1.5 text-[11px] text-muted-foreground/80">
                  <div className="flex items-center gap-1">
                    <Laptop className="w-3.5 h-3.5" />
                    <span>{bindData.deviceLabel || '当前电脑'}</span>
                  </div>
                  <span>尾号: ...{bindData.machineIdTail || '----'}</span>
                </div>
              </div>
            )}

            <div className="flex flex-col items-center justify-center pt-2 border-t border-border/40 gap-2 w-full">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-xs text-muted-foreground hover:text-foreground h-8 px-4"
                onClick={() => loadBindCode(true)}
                disabled={step === 'qr_loading'}
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 mr-1.5 ${step === 'qr_loading' ? 'animate-spin' : ''}`}
                />
                刷新二维码
              </Button>
            </div>
          </div>
        )}

        {/* 阶段二：大白话邮箱强制绑定与邀请码填报 */}
        {(step === 'email_input' || step === 'submitting') && (
          <div className="flex flex-col py-2 space-y-3.5">
            {error && (
              <div className="p-2.5 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {/* 邮箱输入 */}
            <div className="space-y-1">
              <label className="text-xs font-semibold text-foreground">常用邮箱</label>
              <Input
                type="email"
                placeholder="例如 yourname@qq.com / 163.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                disabled={step === 'submitting'}
                className="text-xs h-9"
              />
            </div>

            {/* 验证码输入与获取按钮 */}
            <div className="space-y-1">
              <label className="text-xs font-semibold text-foreground">邮箱验证码</label>
              <div className="flex gap-2">
                <Input
                  type="text"
                  maxLength={6}
                  placeholder="6 位数字"
                  value={otpCode}
                  onChange={e => setOtpCode(e.target.value)}
                  disabled={step === 'submitting'}
                  className="text-xs h-9 font-mono tracking-widest flex-1"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleSendOtp}
                  disabled={sendingOtp || cooldown > 0 || step === 'submitting'}
                  className="text-xs h-9 shrink-0 px-3"
                >
                  {sendingOtp ? (
                    <RefreshCw className="w-3.5 h-3.5 animate-spin mr-1" />
                  ) : cooldown > 0 ? (
                    `${cooldown} 秒后重发`
                  ) : (
                    '获取验证码'
                  )}
                </Button>
              </div>
            </div>

            {/* 好友邀请码 (智能墓碑感知) */}
            <div className="space-y-1 pt-1 border-t border-border/40">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-foreground flex items-center gap-1">
                  <Gift className="w-3.5 h-3.5 text-primary" />
                  好友邀请码 (选填)
                </label>
                {deviceConsumedInvitation && (
                  <span className="text-[11px] text-muted-foreground">本机已参与过</span>
                )}
              </div>
              <Input
                type="text"
                maxLength={8}
                placeholder={
                  deviceConsumedInvitation
                    ? '本机已参与过好友邀请，无需重复填写'
                    : '填写好友的 8 位邀请码，双方各得 500 额度'
                }
                value={invitationCode}
                onChange={e => setInvitationCode(e.target.value.toUpperCase())}
                disabled={deviceConsumedInvitation || step === 'submitting'}
                className="text-xs h-9 font-mono uppercase"
              />
            </div>

            {/* 提交激活按钮 */}
            <Button
              type="button"
              onClick={handleSubmitEmailBinding}
              disabled={step === 'submitting' || !email.trim() || !otpCode.trim()}
              className="w-full h-9 mt-2 text-xs font-bold"
            >
              {step === 'submitting' ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin mr-1.5" />
                  正在激活账号...
                </>
              ) : (
                '完成绑定并进入软件'
              )}
            </Button>
          </div>
        )}

        {/* 阶段三：激活成功过渡 */}
        {step === 'success' && (
          <div className="flex flex-col items-center justify-center py-8 space-y-3 animate-in fade-in zoom-in-95">
            <CheckCircle2 className="w-16 h-16 text-emerald-500" />
            <span className="text-base font-bold text-foreground">绑定与账号激活成功</span>
            <span className="text-xs text-muted-foreground">正在同步会员资产并进入软件...</span>
          </div>
        )}
      </DialogContent>

      {/* 席位已满换绑弹窗 */}
      <DeviceEvictDialog
        open={evictOpen}
        onOpenChange={nextOpen => {
          setEvictOpen(nextOpen)
          if (!nextOpen && step !== 'success' && !bindData) {
            loadBindCode(false)
          }
        }}
        sessionToken={pendingSessionToken}
        onEvictedSuccess={async () => {
          setStep('success')
          toast.success('设备替换成功，已完成登录！')
          await syncFromCloud().catch(syncErr => {
            console.warn('[DeviceBindModal] 设备替换后同步云端权益失败:', syncErr)
          })
          setTimeout(() => {
            onOpenChange(false)
          }, 1200)
        }}
      />
    </Dialog>
  )
}
