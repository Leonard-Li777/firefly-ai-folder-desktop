import React, { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../ui/card'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Alert, AlertDescription, AlertTitle } from '../ui/alert'
import { Copy, Key, ShieldAlert, Wifi, Globe, Mail, CheckCircle2, Loader2 } from 'lucide-react'
import { toast } from '../common/Toast'
import { t } from '@app/languages'

import { EnterpriseLicenseForm } from './EnterpriseLicenseForm'

interface LicenseGatewayProps {
  onActivated: () => void
  status: 'UNAUTHORIZED' | 'EXPIRED' | 'TIME_TAMPERED' | 'AUTHORIZED'
  error?: string
  canOffline?: boolean
}

export const LicenseGateway: React.FC<LicenseGatewayProps> = ({
  onActivated,
  status,
  error: initialError,
  canOffline = false
}) => {
  const [isActivating, setIsActivating] = useState(false)
  const [error, setError] = useState<string | null>(initialError || null)
  const [isOfflineMode, setIsOfflineMode] = useState(false)

  const handleRetryOnline = async () => {
    setIsActivating(true)
    setError(null)
    try {
      const result = await window.electronAPI!.license.checkOnline()
      if (result.status === 'AUTHORIZED') {
        toast.success(t('在线验证成功！'))
        onActivated()
      } else {
        setError(result.error || t('网络连接失败，请检查设置'))
      }
    } catch (e) {
      setError(t('在线验证过程中发生错误'))
    } finally {
      setIsActivating(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-background/95 backdrop-blur-sm p-4 overflow-y-auto">
      <Card className="w-full max-w-2xl shadow-2xl border-2 border-primary/20">
        <CardHeader className="text-center space-y-4">
          <div className="mx-auto bg-primary/10 w-16 h-16 rounded-full flex items-center justify-center">
            <Key className="w-8 h-8 text-primary" />
          </div>
          <div>
            <CardTitle className="text-3xl font-bold">{t('软件授权验证')}</CardTitle>
            <CardDescription className="text-lg mt-2">
              {status === 'TIME_TAMPERED'
                ? t('检测到系统时间异常，请校准时间后再运行。')
                : t('当前处于离线环境，个人需要联网，企业需要获取离线授权才能继续使用。')}
            </CardDescription>
          </div>
        </CardHeader>

        <CardContent className="space-y-6">
          {error && (
            <Alert variant="destructive">
              <ShieldAlert className="h-4 w-4" />
              <AlertTitle>{t('授权验证失败')}</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {!isOfflineMode ? (
            <div className="grid grid-cols-2 gap-4">
              <Button
                size="lg"
                className="h-16 text-lg gap-2"
                onClick={handleRetryOnline}
                disabled={isActivating}
              >
                {isActivating ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <Wifi className="h-5 w-5" />
                )}
                {t('个人，我已打开网络')}
              </Button>
              <Button
                size="lg"
                variant="outline"
                className="h-16 text-lg gap-2"
                onClick={() => {
                  setIsOfflineMode(true)
                  setError(null)
                }}
                disabled={isActivating}
              >
                <ShieldAlert className="w-5 h-5" />
                {t('企业，离线授权使用')}
              </Button>
            </div>
          ) : (
            <EnterpriseLicenseForm onActivated={onActivated} />
          )}
        </CardContent>

        <CardFooter className="flex flex-col gap-4">
          {isOfflineMode && (
            <div className="flex w-full gap-4">
              <Button
                variant="outline"
                className="w-full h-12 text-base"
                onClick={() => {
                  setIsOfflineMode(false)
                  setError(null)
                }}
              >
                {t('返回')}
              </Button>
            </div>
          )}
          <p className="text-xs text-center text-muted-foreground px-8 italic">
            {t('本软件受版权保护，合法授权后方可解锁。')}
          </p>
        </CardFooter>
      </Card>
    </div>
  )
}
