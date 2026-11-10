import React, { useState, useEffect, useCallback } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog'
import { Button } from '../ui/button'
import { Laptop, ShieldAlert, Clock, RefreshCw, AlertCircle, CheckCircle2 } from 'lucide-react'
import { toast } from '../common/Toast'

export interface SeatedDevice {
  id: string
  machine_id_tail: string
  slot_index: number
  device_label: string
  platform: string
  is_locked: boolean
  bound_at: string
  last_seen_at?: string
  is_current_machine?: boolean
}

interface DeviceEvictDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessionToken?: string
  onEvictedSuccess?: () => void
}

export const DeviceEvictDialog: React.FC<DeviceEvictDialogProps> = ({
  open,
  onOpenChange,
  sessionToken,
  onEvictedSuccess
}) => {
  const [loading, setLoading] = useState<boolean>(false)
  const [submitting, setSubmitting] = useState<boolean>(false)
  const [devices, setDevices] = useState<SeatedDevice[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const loadDevices = useCallback(async () => {
    setLoading(true)
    setErrorMessage(null)
    try {
      if (!window.electronAPI?.deviceBind?.listSeatedDevices) {
        throw new Error('设备席位管理接口未就绪')
      }
      const res = await window.electronAPI.deviceBind.listSeatedDevices({ sessionToken })
      if (res.success && Array.isArray(res.devices)) {
        setDevices(res.devices)
        // 默认不主动选中锁定的设备
        const firstReplaceable = res.devices.find(
          (d: SeatedDevice) => !d.is_locked && !d.is_current_machine
        )
        if (firstReplaceable) {
          setSelectedDeviceId(firstReplaceable.id)
        }
      } else {
        setErrorMessage(res.error || '获取已绑定设备列表失败')
      }
    } catch (err: any) {
      setErrorMessage(err?.message || '网络连接异常，请重试')
    } finally {
      setLoading(false)
    }
  }, [sessionToken])

  useEffect(() => {
    if (open) {
      loadDevices()
    } else {
      setDevices([])
      setSelectedDeviceId(null)
      setErrorMessage(null)
    }
  }, [open, loadDevices])

  // 判断是否闲置超过 90 天
  const isIdleOver90Days = (lastSeen?: string, boundAt?: string): boolean => {
    const timeStr = lastSeen || boundAt
    if (!timeStr) return false
    const diffDays = (Date.now() - new Date(timeStr).getTime()) / (1000 * 60 * 60 * 24)
    return diffDays >= 90
  }

  // 格式化时间展示
  const formatDate = (dateStr?: string): string => {
    if (!dateStr) return '未知时间'
    try {
      const d = new Date(dateStr)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    } catch {
      return dateStr
    }
  }

  // 执行换绑踢线
  const handleConfirmEvict = async () => {
    if (!selectedDeviceId) {
      toast.error('请先选择一台需要替换的旧电脑')
      return
    }

    const targetDevice = devices.find(d => d.id === selectedDeviceId)
    if (targetDevice?.is_locked) {
      toast.error('该设备已被企业策略锁定，无法自助替换')
      return
    }

    setSubmitting(true)
    setErrorMessage(null)
    try {
      if (!window.electronAPI?.deviceBind?.seatDevice) {
        throw new Error('席位分配服务未就绪')
      }

      const res = await window.electronAPI.deviceBind.seatDevice({
        sessionToken,
        evictDeviceId: selectedDeviceId
      })

      if (res.success && res.seated) {
        toast.success('设备替换成功，已完成登录！')
        onEvictedSuccess?.()
        onOpenChange(false)
      } else if (res.error === 'EVICT_TARGET_ALREADY_UNBOUND') {
        toast.warning('所选设备已被解除绑定，正在为您刷新设备列表...')
        await loadDevices()
      } else if (res.error === 'DEVICE_LOCKED_BY_ENTERPRISE') {
        toast.error('目标设备受企业安全策略保护，禁止自助换绑')
        await loadDevices()
      } else {
        setErrorMessage(res.message || res.error || '换绑失败，请重试')
      }
    } catch (err: any) {
      setErrorMessage(err?.message || '网络连接异常，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-lg p-6 bg-card text-card-foreground border-border/80 shadow-2xl rounded-2xl select-none"
        onPointerDownOutside={e => e.preventDefault()}
      >
        <DialogHeader className="text-center sm:text-center space-y-1">
          <div className="mx-auto w-12 h-12 rounded-2xl bg-amber-500/10 text-amber-500 flex items-center justify-center mb-1">
            <ShieldAlert className="w-6 h-6" />
          </div>
          <DialogTitle className="text-lg font-bold tracking-tight">
            设备绑定席位已满（6 / 6 台）
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            您的账号最多支持在 6 台电脑上同时登录。请选择一台旧电脑移出席位，以激活当前电脑。
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex flex-col items-center justify-center py-10 space-y-2 text-muted-foreground text-xs">
            <RefreshCw className="w-6 h-6 animate-spin text-primary" />
            <span>正在读取已绑定的设备清单...</span>
          </div>
        ) : errorMessage && devices.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 space-y-3">
            <AlertCircle className="w-8 h-8 text-destructive" />
            <span className="text-xs text-destructive text-center font-medium">{errorMessage}</span>
            <Button size="sm" variant="outline" className="text-xs h-8" onClick={loadDevices}>
              <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> 重新加载
            </Button>
          </div>
        ) : (
          <div className="space-y-3 py-2">
            {errorMessage && (
              <div className="p-2.5 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{errorMessage}</span>
              </div>
            )}

            <div className="max-h-64 overflow-y-auto space-y-2 pr-1">
              {devices.map(device => {
                const isSelected = selectedDeviceId === device.id
                const isLocked = device.is_locked
                const idleOver90 = isIdleOver90Days(device.last_seen_at, device.bound_at)

                return (
                  <div
                    key={device.id}
                    onClick={() => {
                      if (!isLocked && !submitting) {
                        setSelectedDeviceId(device.id)
                      }
                    }}
                    className={`flex items-center justify-between p-3 rounded-xl border transition-all ${
                      isLocked
                        ? 'opacity-60 bg-muted/30 border-border/40 cursor-not-allowed'
                        : isSelected
                          ? 'bg-primary/5 border-primary shadow-sm cursor-pointer'
                          : 'bg-card hover:bg-muted/40 border-border/60 cursor-pointer'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className={`w-9 h-9 rounded-xl flex items-center justify-center ${
                          isSelected
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-muted text-muted-foreground'
                        }`}
                      >
                        <Laptop className="w-5 h-5" />
                      </div>
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-foreground">
                            {device.device_label || '常用电脑'}
                          </span>
                          {isLocked && (
                            <span className="px-1.5 py-0.2 rounded text-[10px] bg-purple-500/10 text-purple-600 dark:text-purple-400 font-semibold border border-purple-500/20">
                              公司集中管理 (禁止替换)
                            </span>
                          )}
                          {!isLocked && idleOver90 && (
                            <span className="px-1.5 py-0.2 rounded text-[10px] bg-amber-500/10 text-amber-600 dark:text-amber-400 font-semibold border border-amber-500/20">
                              闲置超 3 个月 (建议替换)
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                          <span>尾号: ...{device.machine_id_tail}</span>
                          <span className="flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            最近使用: {formatDate(device.last_seen_at || device.bound_at)}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="pl-2">
                      <div
                        className={`w-5 h-5 rounded-full border flex items-center justify-center ${
                          isSelected
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-muted-foreground/30'
                        }`}
                      >
                        {isSelected && <CheckCircle2 className="w-3.5 h-3.5" />}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="pt-2 flex gap-2">
              <Button
                type="button"
                variant="outline"
                className="flex-1 text-xs h-9"
                onClick={() => onOpenChange(false)}
                disabled={submitting}
              >
                取消
              </Button>
              <Button
                type="button"
                className="flex-1 text-xs h-9 font-bold"
                onClick={handleConfirmEvict}
                disabled={submitting || !selectedDeviceId}
              >
                {submitting ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin mr-1.5" />
                    正在替换并登录...
                  </>
                ) : (
                  '替换所选设备并登录'
                )}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
