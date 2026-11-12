import React, { useEffect, useState } from 'react'
import { useVoerkaI18n } from '@voerkai18n/react'
import i18nScope from '@src/languages'
import { WelcomeStepLayout } from './WelcomeStepLayout'
import { Card, CardContent } from '@components/ui/card'
import { Button } from '@components/ui/button'
import {
  HardDrive,
  FolderOpen,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Loader2,
  Zap,
  ShieldCheck
} from 'lucide-react'
import {
  usePluginCenterStore,
  formatPluginErrorMessage
} from '@stores/plugin-center-store'

interface WelcomeStep3PluginDirProps {
  onBack: () => void
  onNext: () => void
  onDirApplied?: (path: string) => void
  initialAppliedPath?: string | null
}

/** 与插件中心设置页保持同款的 1024 进制字节格式化 */
function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = bytes
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex++
  }
  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

/**
 * 取与插件中心相同的 modularResource 桥；优先 electronAPI，兼容独立注入的全局桥。
 */
function getInitialDirApi(): any | null {
  if (typeof window === 'undefined') return null
  const w = window as any
  return w.electronAPI?.modularResource ?? w.modularResource ?? null
}

/**
 * 欢迎向导 Step 3：选择插件安装目录
 *
 * 一步到位原则：
 * 用户选择目录后，直接执行校验与首次运行目录设定。
 * 校验通过直接应用并刷新生效，通不过直接展示大白话错误提示，不啰嗦分多步。
 */
export function WelcomeStep3PluginDir({
  onBack,
  onNext,
  onDirApplied,
  initialAppliedPath = null
}: WelcomeStep3PluginDirProps) {
  const { t } = useVoerkaI18n(i18nScope)

  const dirInfo = usePluginCenterStore(s => s.dirInfo)
  const loadDirInfo = usePluginCenterStore(s => s.loadDirInfo)
  const pickDirectory = usePluginCenterStore(s => s.pickDirectory)
  const validatePluginDir = usePluginCenterStore(s => s.validatePluginDir)

  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isPicking, setIsPicking] = useState(false)
  const [isApplying, setIsApplying] = useState(false)
  const [appliedPath, setAppliedPath] = useState<string | null>(initialAppliedPath)

  useEffect(() => {
    loadDirInfo()
  }, [loadDirInfo])

  const isBusy = isPicking || isApplying

  /** 一步到位：选择目录后校验通过直接应用，不通过直接报错 */
  const handlePick = async () => {
    setErrorMessage(null)
    setIsPicking(true)
    try {
      const chosenPath = await pickDirectory()
      if (!chosenPath) return

      // 1. 校验目录规范（纯英文、非系统保护路径、磁盘空间门槛等）
      const validation = await validatePluginDir(chosenPath)
      if (!validation?.valid) {
        const code = validation?.errorCode
        // 用户选中的就是当前默认目录：直接沿用
        if (code === 'SAME_AS_CURRENT') {
          setAppliedPath(chosenPath)
          onDirApplied?.(chosenPath)
          return
        }
        setErrorMessage(
          code
            ? formatPluginErrorMessage({ code })
            : validation?.errorMessage || t('所选文件夹不满足要求，请重新选择')
        )
        return
      }

      // 2. 校验通过，直接应用设定并同步内存与配置
      setIsApplying(true)
      const bridge = getInitialDirApi()
      const res = await bridge?.applyInitialPluginDir?.(chosenPath)
      if (!res?.success) {
        const code = res?.errorCode
        setErrorMessage(
          code === 'DIR_CHANGE_GATE_ACTIVE'
            ? t('这个文件夹暂时不能设为安装目录，请沿用默认目录；进入主界面后可在设置里更改')
            : formatPluginErrorMessage({ code })
        )
        return
      }

      const path = res.appliedPath || chosenPath
      setAppliedPath(path)
      onDirApplied?.(path)
      await loadDirInfo()
    } catch (err) {
      setErrorMessage(formatPluginErrorMessage(err))
    } finally {
      setIsPicking(false)
      setIsApplying(false)
    }
  }

  return (
    <WelcomeStepLayout
      testId="welcome-step3-container"
      maxWidthClass="max-w-3xl"
      title={t('选择插件安装目录')}
      subtitle={t(
        '给 AI 大脑模型与功能扩展组件选一个长期存放的文件夹，之后也可以在设置里更改'
      )}
      footer={
        <>
          <Button
            data-testid="welcome-step3-back-btn"
            variant="ghost"
            size="sm"
            onClick={onBack}
            disabled={isBusy}
            className="text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="w-4 h-4 mr-1" />
            {t('返回')}
          </Button>
          <Button
            data-testid="welcome-step3-next-btn"
            onClick={onNext}
            disabled={isBusy}
            className="bg-primary hover:bg-primary/90 text-primary-foreground font-medium px-5"
          >
            {t('下一步')}
            <ArrowRight className="w-4 h-4 ml-1.5" />
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Card className="p-4 rounded-lg bg-card border border-border shadow-sm">
          <CardContent className="p-0 space-y-3">
            <div>
              <h2 className="text-sm font-semibold text-foreground">
                {t('插件与模型存储目录')}
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t('存放 AI 大脑模型与功能扩展组件的本地文件夹')}
              </p>
            </div>

            {/* 默认目录含中文时的稳定性警告 */}
            {dirInfo?.defaultDirNonAscii && (
              <div
                data-testid="welcome-step3-nonascii-warning"
                className="flex items-start gap-2.5 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-300 text-xs"
              >
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
                <span>
                  {t(
                    '当前默认插件存储路径包含中文字符，可能影响部分 AI 模型稳定运行，强烈建议更改到纯英文磁盘目录'
                  )}
                </span>
              </div>
            )}

            {/* 当前目录、占用空间与可用空间 */}
            <div className="p-3 rounded-lg bg-muted/50 border border-border">
              <div className="flex items-center gap-2 min-w-0">
                <HardDrive className="w-4 h-4 text-muted-foreground shrink-0" />
                <span
                  data-testid="welcome-step3-current-path"
                  className="text-xs font-mono font-medium text-foreground truncate select-all"
                >
                  {dirInfo?.currentPath || dirInfo?.currentDir || t('正在获取目录信息...')}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-[11px] text-muted-foreground">
                <span>
                  {t('已占用空间')}:{' '}
                  <b className="font-semibold text-foreground font-mono">
                    {formatBytes(dirInfo?.usedBytes)}
                  </b>
                </span>
                <span>
                  {t('磁盘可用空间')}:{' '}
                  <b className="font-semibold text-foreground font-mono">
                    {formatBytes(dirInfo?.freeBytes)}
                  </b>
                </span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                data-testid="welcome-step3-pick-dir-btn"
                variant="outline"
                size="sm"
                onClick={handlePick}
                disabled={isBusy}
                className="bg-card border-primary/30 text-primary hover:bg-primary/15 font-medium"
              >
                {isBusy ? (
                  <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                ) : (
                  <FolderOpen className="w-3.5 h-3.5 mr-1.5" />
                )}
                {t('更改目录')}
              </Button>
              <span className="text-[11px] text-muted-foreground">
                {t('不改也可以，直接沿用上面的默认目录')}
              </span>
            </div>

            {/* 设定成功：明确告诉用户无需重启，下一步就会装到这个文件夹 */}
            {appliedPath && (
              <div
                data-testid="welcome-step3-applied-banner"
                className="flex items-start gap-2.5 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-700 dark:text-emerald-300 text-xs"
              >
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-600 dark:text-emerald-400" />
                <span>
                  {t('已设定为新的安装文件夹，之后装的插件都会放在这里，无需重启软件')}
                </span>
              </div>
            )}

            {/* 目录校验或应用失败：错误码统一翻译成大白话 */}
            {errorMessage && (
              <div
                data-testid="welcome-step3-dir-error"
                className="flex items-start gap-2.5 p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-xs"
              >
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-destructive" />
                <span>{errorMessage}</span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* 选型提示（放在目录卡片下方，先操作后阅读）：足够空间 + 固态硬盘 + 路径规则 */}
        <Card
          data-testid="welcome-step3-space-hint"
          className="p-3.5 rounded-lg bg-primary/10 border border-primary/30 shadow-xs"
        >
          <CardContent className="p-0 space-y-1.5">
            <div className="flex items-start gap-2 text-xs text-foreground">
              <HardDrive className="w-4 h-4 text-primary shrink-0 mt-0.5" />
              <span>
                {t(
                  'AI 模型和插件体积较大，请确保所选磁盘有足够可用空间，建议至少预留 10GB 以上；空间不足时会自动拦截'
                )}
              </span>
            </div>
            <div className="flex items-start gap-2 text-xs text-foreground">
              <Zap className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
              <span>
                {t(
                  '建议选择固态硬盘（SSD）上的文件夹，模型加载和文件搜索会明显更快；机械硬盘也能用，只是首次加载较慢'
                )}
              </span>
            </div>
            <div className="flex items-start gap-2 text-xs text-foreground">
              <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
              <span>
                {t(
                  '请使用纯英文路径，不要包含中文或空格，也不要选系统文件夹或磁盘根目录'
                )}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>
    </WelcomeStepLayout>
  )
}
