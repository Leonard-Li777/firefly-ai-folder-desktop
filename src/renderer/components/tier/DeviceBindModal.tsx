import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog'
import { Button } from '../ui/button'
import { Smartphone, RefreshCw, CheckCircle2, ShieldCheck, Laptop, AlertCircle } from 'lucide-react'
import { useTierStore } from '../../stores/tier-store'
import { toast } from '../common/Toast'

interface DeviceBindModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface BindCodeData {
  code: string
  imageDataUrl: string
  deviceLabel?: string
  platform?: string
  machineIdTail?: string
  expiresAt?: string
}

function formatErrorMessage(err?: string): string {
  if (!err) return '生成微信登录码失败'
  if (err === 'RATE_LIMIT_EXCEEDED') return '操作过于频繁，请 1 分钟后再试'
  if (err === 'machine_id_missing') return '未检测到设备硬件标识'
  return err
}

export const DeviceBindModal: React.FC<DeviceBindModalProps> = ({ open, onOpenChange }) => {
  const { syncFromCloud } = useTierStore()
  const [loading, setLoading] = useState<boolean>(false)
  const [bindData, setBindData] = useState<BindCodeData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isSuccess, setIsSuccess] = useState<boolean>(false)
  const pollTimerRef = useRef<NodeJS.Timeout | null>(null)
  const loadRequestIdRef = useRef<number>(0)

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }, [])

  // 获取绑定短凭据与微信官方小程序码
  const loadBindCode = useCallback(async () => {
    const currentRequestId = ++loadRequestIdRef.current
    setLoading(true)
    setError(null)
    setIsSuccess(false)
    stopPolling()

    try {
      if (!window.electronAPI?.deviceBind?.createCode) {
        throw new Error('设备绑定接口未就绪')
      }

      const res = await window.electronAPI.deviceBind.createCode()
      // 竞态防御：若在异步生成期间弹窗已关闭或发起了新请求，立即放弃
      if (currentRequestId !== loadRequestIdRef.current || !open) {
        return
      }

      if (!res.success || !res.code) {
        throw new Error(formatErrorMessage(res.error))
      }

      if (!res.imageDataUrl || !res.imageDataUrl.startsWith('data:image/')) {
        throw new Error('微信二维码生成未完成，请点击重试')
      }

      setBindData({
        code: res.code,
        imageDataUrl: res.imageDataUrl,
        deviceLabel: res.deviceLabel,
        platform: res.platform,
        machineIdTail: res.machineIdTail,
        expiresAt: res.expiresAt
      })

      // 启动轮询检查设备是否被微信小程序认领绑定
      pollTimerRef.current = setInterval(async () => {
        if (currentRequestId !== loadRequestIdRef.current || !open) {
          stopPolling()
          return
        }
        try {
          const status = await window.electronAPI.deviceBind.getStatus()
          if (status?.success && status?.bound) {
            stopPolling()
            setIsSuccess(true)
            toast.success('微信设备绑定成功！')
            await syncFromCloud().catch(() => {})
            setTimeout(() => {
              onOpenChange(false)
            }, 1200)
          }
        } catch {
          // 轮询异常静默重试
        }
      }, 2500)
    } catch (err: any) {
      if (currentRequestId === loadRequestIdRef.current && open) {
        setError(formatErrorMessage(err?.message))
      }
    } finally {
      if (currentRequestId === loadRequestIdRef.current && open) {
        setLoading(false)
      }
    }
  }, [open, onOpenChange, stopPolling, syncFromCloud])

  useEffect(() => {
    if (open) {
      loadBindCode()
    } else {
      stopPolling()
      setBindData(null)
      setError(null)
      setIsSuccess(false)
    }
    return () => {
      stopPolling()
    }
  }, [open, loadBindCode, stopPolling])

  return (
    <Dialog
      open={open}
      onOpenChange={nextOpen => {
        // 强制登录守则：未绑定成功前严禁通过任何外部途径关闭
        if (isSuccess && !nextOpen) {
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
            <Smartphone className="w-6 h-6" />
          </div>
          <DialogTitle className="text-lg font-bold tracking-tight">
            微信扫码登录 · 绑定当前设备
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            请使用微信扫描专属小程序码，在小程序确认绑定后即可使用完整功能并同步权益
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center justify-center py-2 space-y-4">
          {/* 二维码展示区 */}
          <div className="relative w-64 h-64 rounded-2xl border border-border/60 bg-white flex items-center justify-center overflow-hidden shadow-inner p-2">
            {loading && (
              <div className="flex flex-col items-center gap-2 text-muted-foreground text-xs">
                <RefreshCw className="w-6 h-6 animate-spin text-primary" />
                <span>正在生成微信专属二维码...</span>
              </div>
            )}

            {!loading && error && (
              <div className="flex flex-col items-center p-4 text-center gap-2">
                <AlertCircle className="w-8 h-8 text-destructive" />
                <span className="text-xs text-destructive font-medium">{error}</span>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2 text-xs h-8"
                  onClick={loadBindCode}
                >
                  <RefreshCw className="w-3.5 h-3.5 mr-1" /> 重试
                </Button>
              </div>
            )}

            {!loading && isSuccess && (
              <div className="flex flex-col items-center gap-2 text-emerald-500 animate-in fade-in zoom-in-95">
                <CheckCircle2 className="w-14 h-14" />
                <span className="text-sm font-semibold text-foreground">绑定成功</span>
                <span className="text-xs text-muted-foreground">正在同步会员资产...</span>
              </div>
            )}

            {!loading && !error && !isSuccess && bindData?.imageDataUrl && (
              <div className="flex flex-col items-center justify-center w-full h-full">
                <img
                  src={bindData.imageDataUrl}
                  alt="微信扫码绑定"
                  className="w-56 h-56 object-contain"
                />
              </div>
            )}
          </div>

          {/* 短码防钓鱼与备用输入 */}
          {bindData?.code && !isSuccess && (
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

              {/* 待绑定设备指纹 */}
              <div className="flex items-center justify-between px-3 py-1.5 text-[11px] text-muted-foreground/80">
                <div className="flex items-center gap-1">
                  <Laptop className="w-3.5 h-3.5" />
                  <span>{bindData.deviceLabel || '当前电脑'}</span>
                </div>
                <span>尾号: ...{bindData.machineIdTail || '----'}</span>
              </div>
            </div>
          )}
        </div>

        {/* 底部操作与提示（不可跳过，仅可刷新或扫码完成） */}
        <div className="flex flex-col items-center justify-center pt-3 border-t border-border/40 gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground hover:text-foreground h-8 px-4"
            onClick={loadBindCode}
            disabled={loading}
          >
            <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
            刷新二维码
          </Button>
          <p className="text-[11px] text-muted-foreground text-center">
            为保证权益安全与跨端同步，使用前请先绑定微信账号
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
