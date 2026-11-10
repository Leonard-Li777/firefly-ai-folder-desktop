import React, { useState, useEffect, useCallback } from 'react'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../ui/card'
import { Button } from '../ui/button'
import { Alert, AlertDescription, AlertTitle } from '../ui/alert'
import { Key, ShieldAlert, Wifi, Loader2 } from 'lucide-react'
import { toast } from '../common/Toast'
import { t } from '@app/languages'
import { getAppRegion } from '../../lib/app-region'
import { validateIdentCode } from '../../lib/marketing-link'
import { EnterpriseLicenseForm, type IdentCodeState } from './EnterpriseLicenseForm'

export type LicenseView = 'choice' | 'enterprise'

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
  const [currentView, setCurrentView] = useState<LicenseView>('choice')
  const [isActivating, setIsActivating] = useState(false)
  const [error, setError] = useState<string | null>(initialError || null)
  const [licenseDraft, setLicenseDraft] = useState<string>('')
  const [identState, setIdentState] = useState<IdentCodeState>({ status: 'loading' })

  const region = getAppRegion()

  const fetchIdentCode = useCallback(async () => {
    setIdentState({ status: 'loading' })
    try {
      let code = ''
      if (window.electronAPI?.license?.getIdentCode) {
        code = await window.electronAPI.license.getIdentCode()
      }
      if (!code && window.electronAPI?.getMachineId) {
        const machineId = await window.electronAPI.getMachineId()
        if (machineId) {
          const { encodeMachineIdToBase64 } = await import('@firefly/shared')
          code = encodeMachineIdToBase64(machineId)
        }
      }

      const valid = validateIdentCode(code)
      if (valid) {
        setIdentState({ status: 'ready', identCode: valid })
      } else {
        setIdentState({ status: 'error', reason: code ? 'invalid-format' : 'empty' })
      }
    } catch (err) {
      console.error('[LicenseGateway] Failed to fetch ident code:', err)
      setIdentState({ status: 'error', reason: 'ipc-failed' })
    }
  }, [])

  useEffect(() => {
    void fetchIdentCode()
  }, [fetchIdentCode])

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

  const isChoiceView = currentView === 'choice'

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-background/95 backdrop-blur-sm p-4 overflow-y-auto">
      <Card
        className={`w-full max-w-2xl shadow-2xl border-2 border-primary/20 transition-all duration-300 ${
          isChoiceView ? '' : 'p-2 sm:p-4'
        }`}
      >
        {/* 第一屏独占：Header 区域。进入企业离线屏时彻底条件卸载，释放空间 */}
        {isChoiceView && (
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
        )}

        <CardContent className={isChoiceView ? 'space-y-6' : 'p-2 sm:p-3'}>
          {isChoiceView ? (
            <>
              {error && (
                <Alert variant="destructive">
                  <ShieldAlert className="h-4 w-4" />
                  <AlertTitle>{t('授权验证失败')}</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <div className="grid grid-cols-2 gap-4">
                <Button
                  size="lg"
                  className="h-16 text-lg gap-2 cursor-pointer"
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
                  className="h-16 text-lg gap-2 cursor-pointer"
                  onClick={() => {
                    setCurrentView('enterprise')
                    setError(null)
                  }}
                  disabled={isActivating}
                >
                  <ShieldAlert className="w-5 h-5" />
                  {t('企业，离线授权使用')}
                </Button>
              </div>
            </>
          ) : (
            <EnterpriseLicenseForm
              region={region}
              identState={identState}
              onRetryIdent={fetchIdentCode}
              licenseDraft={licenseDraft}
              onDraftChange={setLicenseDraft}
              onBack={() => setCurrentView('choice')}
              onActivated={onActivated}
            />
          )}
        </CardContent>

        {/* 第一屏独占：底部版权与说明。第二屏彻底卸载以消除双重返回与纵向挤压 */}
        {isChoiceView && (
          <CardFooter className="flex flex-col gap-4">
            <p className="text-xs text-center text-muted-foreground px-8 italic">
              {t('本软件受版权保护，合法授权后方可解锁。')}
            </p>
          </CardFooter>
        )}
      </Card>
    </div>
  )
}
