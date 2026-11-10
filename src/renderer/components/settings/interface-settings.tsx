import React, { useState, useEffect, useMemo } from 'react'
import {
  Sun,
  Moon,
  Monitor,
  Check,
  Loader2,
  FolderOpen,
  AlertTriangle,
  HardDrive,
  Trash2
} from 'lucide-react'
import { Card } from '../ui/card'
import { Label } from '../ui/label'
import { Switch } from '../ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { RadioGroup } from '../ui/radio-group'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '../ui/alert-dialog'
import { Button } from '../ui/button'
import { useSettingsConfig, useSettingsStore } from '../../stores/settings-store'
import { usePluginCenterStore, formatPluginErrorMessage } from '../../stores/plugin-center-store'
import { useTheme } from '../ui/theme-provider'
import type { LanguageCode } from '@firefly/types'
import { toast } from '../common/Toast'
import { getAvailableColorSchemes, ColorScheme } from '../../lib/theme-config'
import { cn } from '../../lib/utils'
import i18nScope from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'
import { SUPPORTED_LANGUAGES } from '@firefly/shared'

/**
 * 格式化字节为人类友好字符串 (1024 进制)
 */
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
 * 界面设置组件
 */
export const InterfaceSettings: React.FC = () => {
  // 订阅配置对象：本组件在 render 阶段用 getConfigValue() 读值，仅订阅 theme 不足以
  // 覆盖语言/界面密度等键的变更，缺少订阅会导致修改后不重渲染，UI 不回显
  useSettingsConfig()
  const getConfigValue = useSettingsStore(s => s.getConfigValue)
  const updateConfigValue = useSettingsStore(s => s.updateConfigValue)
  const themeMode = useSettingsStore(s => (s.config?.ui as any)?.theme || (s.config as any)?.theme)
  const { t, changeLanguage, activeLanguage } = useVoerkaI18n(i18nScope)
  const { setTheme, colorScheme, setColorScheme } = useTheme()
  const [showLanguageChangeDialog, setShowLanguageChangeDialog] = useState(false)
  const [pendingLanguage, setPendingLanguage] = useState<LanguageCode | null>(null)
  const [isSwitchingLanguage, setIsSwitchingLanguage] = useState(false)

  // 目录管理与安全迁移 Store 订阅
  const dirInfo = usePluginCenterStore(s => s.dirInfo)
  const dirPhase = usePluginCenterStore(s => s.dirPhase)
  const isOldDirCleanupDismissed = usePluginCenterStore(s => s.isOldDirCleanupDismissed)
  const dirMigrationProgress = usePluginCenterStore(s => s.dirMigrationProgress)
  const loadDirInfo = usePluginCenterStore(s => s.loadDirInfo)
  const pickDirectory = usePluginCenterStore(s => s.pickDirectory)
  const validatePluginDir = usePluginCenterStore(s => s.validatePluginDir)
  const changePluginDir = usePluginCenterStore(s => s.changePluginDir)
  const cancelDirMigration = usePluginCenterStore(s => s.cancelDirMigration)
  const cleanupOldDir = usePluginCenterStore(s => s.cleanupOldDir)
  const dismissOldDirCleanup = usePluginCenterStore(s => s.dismissOldDirCleanup)
  const subscribeDirMigrationProgress = usePluginCenterStore(s => s.subscribeDirMigrationProgress)
  const restartApp = usePluginCenterStore(s => s.restartApp)

  const [migrationTarget, setMigrationTarget] = useState<string | null>(null)
  const [migrationDiagnostics, setMigrationDiagnostics] = useState<any | null>(null)
  const [showConfirmMigrationDialog, setShowConfirmMigrationDialog] = useState(false)
  const [showRestartDialog, setShowRestartDialog] = useState(false)
  const [isCleaningOldDir, setIsCleaningOldDir] = useState(false)
  const [isStartingMigration, setIsStartingMigration] = useState(false)

  // 初始化拉取目录信息与监听进度
  useEffect(() => {
    loadDirInfo()
    const unsubscribe = subscribeDirMigrationProgress()
    return () => {
      unsubscribe()
    }
  }, [loadDirInfo, subscribeDirMigrationProgress])

  // 获取可用的配色方案
  const colorSchemes = useMemo(() => getAvailableColorSchemes(), [activeLanguage])

  // 当主题配置变化时,应用主题
  useEffect(() => {
    const theme = getConfigValue<'light' | 'dark' | 'auto'>('THEME_MODE') || 'auto'
    setTheme(theme)
  }, [themeMode, setTheme, getConfigValue])

  /**
   * 处理语言变更 - 即时提醒
   */
  const handleLanguageChange = async (newLanguage: LanguageCode) => {
    // 如果选择的不是当前语言,立即显示警告
    const currentLanguage = getConfigValue<LanguageCode>('DEFAULT_LANGUAGE') || 'zh-CN'
    if (newLanguage !== currentLanguage) {
      setPendingLanguage(newLanguage)
      setShowLanguageChangeDialog(true)
    }
  }

  /**
   * 确认语言变更
   */
  const handleConfirmLanguageChange = async () => {
    if (!pendingLanguage) return

    try {
      // 开启全屏遮罩与遮罩等待状态
      setIsSwitchingLanguage(true)
      setShowLanguageChangeDialog(false)

      // 显示语言切换提示
      toast.info(t('语言正在切换中...请稍后'))

      // 1. 更新语言配置并等待完成，避免与页面刷新发生竞态
      await updateConfigValue('DEFAULT_LANGUAGE', pendingLanguage)

      // 3. 切换前端语言（虽然即将刷新，但为了平滑过渡）
      changeLanguage(pendingLanguage)

      toast.success(t('语言已切换，正在刷新页面...'))

      // 5. 刷新页面以完全重新加载应用状态（包括数据库连接、工作目录等）
      setTimeout(() => {
        window.location.reload()
      }, 500)
    } catch (error) {
      console.error('切换语言失败:', error)
      toast.error(t('切换语言失败,请重试'))
      setIsSwitchingLanguage(false)
      setShowLanguageChangeDialog(false)
      setPendingLanguage(null)
    }
  }

  /**
   * 取消语言变更
   */
  const handleCancelLanguageChange = () => {
    setShowLanguageChangeDialog(false)
    setPendingLanguage(null)
    // Select组件会自动恢复为原值(因为config.language没变)
  }

  /**
   * 选择新目录并校验
   */
  const handlePickAndChangeDir = async () => {
    try {
      const chosenPath = await pickDirectory()
      if (!chosenPath) return

      const validation = await validatePluginDir(chosenPath)
      if (!validation.valid) {
        const errorMsg =
          formatPluginErrorMessage({ code: validation.errorCode }) ||
          validation.errorMessage ||
          t('所选路径不满足要求')
        toast.error(errorMsg)
        return
      }

      setMigrationTarget(chosenPath)
      setMigrationDiagnostics(validation.diagnostics || null)
      setShowConfirmMigrationDialog(true)
    } catch (err: any) {
      toast.error(formatPluginErrorMessage(err))
    }
  }

  /**
   * 确认并开始流式迁移
   */
  const handleConfirmMigration = async () => {
    if (!migrationTarget) return
    setShowConfirmMigrationDialog(false)
    setIsStartingMigration(true)
    try {
      const res = await changePluginDir(migrationTarget)
      if (res && !res.success && res.errorCode) {
        toast.error(formatPluginErrorMessage({ code: res.errorCode }))
      } else {
        setShowRestartDialog(true)
      }
    } catch (err: any) {
      toast.error(formatPluginErrorMessage(err))
    } finally {
      setIsStartingMigration(false)
    }
  }

  /**
   * 取消迁移
   */
  const handleCancelMigration = async () => {
    try {
      const res = await cancelDirMigration()
      if (!res.cancelled && res.errorCode) {
        toast.error(formatPluginErrorMessage({ code: res.errorCode }))
      } else {
        toast.info(t('已取消插件目录迁移'))
      }
    } catch (err: any) {
      toast.error(formatPluginErrorMessage(err))
    }
  }

  /**
   * 清理旧目录残留
   */
  const handleCleanupOldDir = async () => {
    setIsCleaningOldDir(true)
    try {
      const res = await cleanupOldDir()
      if (res.success) {
        toast.success(t(`旧插件目录清理完成，已释放 ${formatBytes(res.freedBytes)} 空间`))
      } else {
        toast.error(formatPluginErrorMessage({ code: res.errorCode || 'UNKNOWN_ERROR' }))
      }
    } catch (err: any) {
      toast.error(formatPluginErrorMessage(err))
    } finally {
      setIsCleaningOldDir(false)
    }
  }

  /**
   * 忽略旧目录清理
   */
  const handleDismissOldDirCleanup = async () => {
    await dismissOldDirCleanup()
  }

  /**
   * 处理主题变更 - 实时预览
   */
  const handleThemeChange = (newTheme: 'light' | 'dark' | 'auto') => {
    updateConfigValue('THEME_MODE', newTheme)
    // setTheme会在useEffect中被调用
  }

  /**
   * 主题选项
   */
  const themeOptions = useMemo(
    () => [
      { value: 'light', label: t('浅色主题'), description: t('始终使用浅色界面') },
      { value: 'dark', label: t('深色主题'), description: t('始终使用深色界面') },
      { value: 'auto', label: t('跟随系统'), description: t('根据系统设置自动切换') }
    ],
    [activeLanguage]
  )

  /**
   * 语言选项（从 SUPPORTED_LANGUAGES 动态生成，避免硬编码）
   */
  const languageOptions = useMemo(
    () =>
      SUPPORTED_LANGUAGES.map(lang => ({
        value: lang.code,
        label: lang.nativeName,
        flag: lang.flag
      })),
    []
  )
  return (
    <div className="p-6 space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-2">{t('界面设置')}</h3>
        <p className="text-sm text-muted-foreground">{t('自定义应用的外观和界面行为')}</p>
      </div>

      {/* 托盘与窗口行为 */}
      <Card className="p-4 bg-card dark:bg-card">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <Label
              htmlFor="close-to-tray"
              className="text-base font-medium text-card-foreground cursor-pointer"
            >
              {t('关闭时，最小化到托盘')}
            </Label>
            <p className="text-sm text-muted-foreground">
              {t('关闭主窗口时将应用隐藏到系统右下角托盘，可通过托盘图标重新打开应用')}
            </p>
          </div>
          <Switch
            id="close-to-tray"
            checked={getConfigValue<boolean>('CLOSE_TO_TRAY') ?? true}
            onCheckedChange={checked => {
              updateConfigValue('CLOSE_TO_TRAY', checked)
            }}
          />
        </div>
      </Card>

      {/* 主题设置 */}
      <Card className="p-4 bg-card dark:bg-card">
        <div className="space-y-4">
          <div>
            <Label className="text-base font-medium text-card-foreground">{t('主题模式')}</Label>
            <p className="text-sm text-muted-foreground mt-1">{t('选择应用的明暗视觉外观')}</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
            {themeOptions.map(option => {
              const currentTheme = getConfigValue<'light' | 'dark' | 'auto'>('THEME_MODE') || 'auto'
              const isSelected = currentTheme === option.value

              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => handleThemeChange(option.value as 'light' | 'dark' | 'auto')}
                  className={cn(
                    'relative flex flex-col p-3 rounded-xl border-2 transition-all text-left focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
                    isSelected
                      ? 'border-primary bg-primary/5 dark:bg-primary/10 shadow-sm ring-1 ring-primary/20'
                      : 'border-border bg-background hover:border-muted-foreground/40 hover:shadow-sm'
                  )}
                >
                  {/* 右上角选中指示 */}
                  {isSelected && (
                    <div className="absolute top-2.5 right-2.5 z-10 w-5 h-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow">
                      <Check className="w-3.5 h-3.5 stroke-[3]" />
                    </div>
                  )}

                  {/* 直观色彩界面缩略图 */}
                  <div className="w-full h-20 rounded-lg overflow-hidden border border-border/60 mb-3 relative flex shadow-xs">
                    {option.value === 'light' && (
                      <div className="w-full h-full bg-slate-100 p-1.5 flex flex-col gap-1">
                        <div className="h-2.5 bg-slate-200 rounded-sm w-full flex items-center px-1">
                          <div className="w-1 h-1 rounded-full bg-slate-400 mr-1" />
                          <div className="w-1 h-1 rounded-full bg-slate-300" />
                        </div>
                        <div className="flex-1 flex gap-1">
                          <div className="w-1/3 bg-slate-200/90 rounded-sm h-full" />
                          <div className="flex-1 bg-white rounded-sm border border-slate-200/80 p-1 flex flex-col gap-1">
                            <div className="h-2 bg-blue-500/80 rounded-sm w-3/4" />
                            <div className="h-1.5 bg-slate-200 rounded-sm w-1/2" />
                            <div className="h-1.5 bg-slate-100 rounded-sm w-full" />
                          </div>
                        </div>
                      </div>
                    )}

                    {option.value === 'dark' && (
                      <div className="w-full h-full bg-slate-950 p-1.5 flex flex-col gap-1">
                        <div className="h-2.5 bg-slate-800 rounded-sm w-full flex items-center px-1">
                          <div className="w-1 h-1 rounded-full bg-slate-600 mr-1" />
                          <div className="w-1 h-1 rounded-full bg-slate-700" />
                        </div>
                        <div className="flex-1 flex gap-1">
                          <div className="w-1/3 bg-slate-800 rounded-sm h-full" />
                          <div className="flex-1 bg-slate-900 rounded-sm border border-slate-800 p-1 flex flex-col gap-1">
                            <div className="h-2 bg-blue-500/90 rounded-sm w-3/4" />
                            <div className="h-1.5 bg-slate-700 rounded-sm w-1/2" />
                            <div className="h-1.5 bg-slate-800 rounded-sm w-full" />
                          </div>
                        </div>
                      </div>
                    )}

                    {option.value === 'auto' && (
                      <div className="w-full h-full flex">
                        {/* 左半边：浅色预览 */}
                        <div className="w-1/2 h-full bg-slate-100 p-1.5 flex flex-col gap-1 border-r border-slate-300">
                          <div className="h-2.5 bg-slate-200 rounded-sm w-full" />
                          <div className="flex-1 bg-white rounded-sm border border-slate-200 p-1 flex flex-col gap-1">
                            <div className="h-2 bg-blue-500/80 rounded-sm w-full" />
                            <div className="h-1.5 bg-slate-200 rounded-sm w-2/3" />
                          </div>
                        </div>
                        {/* 右半边：深色预览 */}
                        <div className="w-1/2 h-full bg-slate-950 p-1.5 flex flex-col gap-1">
                          <div className="h-2.5 bg-slate-800 rounded-sm w-full" />
                          <div className="flex-1 bg-slate-900 rounded-sm border border-slate-800 p-1 flex flex-col gap-1">
                            <div className="h-2 bg-blue-500/90 rounded-sm w-full" />
                            <div className="h-1.5 bg-slate-700 rounded-sm w-2/3" />
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* 主题标签与图标 */}
                  <div className="flex items-center gap-1.5">
                    {option.value === 'light' && <Sun className="w-4 h-4 text-amber-500" />}
                    {option.value === 'dark' && <Moon className="w-4 h-4 text-indigo-400" />}
                    {option.value === 'auto' && <Monitor className="w-4 h-4 text-blue-500" />}
                    <span className="font-medium text-sm text-foreground">{option.label}</span>
                  </div>

                  <p className="text-xs text-muted-foreground mt-1 line-clamp-1">
                    {option.description}
                  </p>
                </button>
              )
            })}
          </div>
        </div>
      </Card>

      {/* 配色方案设置 */}
      <Card className="p-4 bg-card dark:bg-card">
        <div className="space-y-4">
          <div>
            <Label className="text-base font-medium text-card-foreground">{t('配色方案')}</Label>
            <p className="text-sm text-muted-foreground mt-1">{t('选择应用的主题配色')}</p>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {colorSchemes.map(scheme => (
              <button
                key={scheme.value}
                onClick={() => setColorScheme(scheme.value)}
                className={cn(
                  'relative p-4 rounded-lg border-2 transition-all',
                  'hover:shadow-md dark:hover:shadow-lg',
                  'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
                  colorScheme === scheme.value
                    ? 'border-primary bg-primary/10 dark:bg-primary/20'
                    : 'border-border bg-background dark:bg-card hover:border-muted-foreground/50'
                )}
              >
                <div className="flex flex-col items-center gap-2">
                  {/* 配色预览圆点 */}
                  <div className="flex gap-1">
                    {scheme.value === 'blue' && (
                      <>
                        <div className="w-4 h-4 rounded-full bg-blue-500"></div>
                        <div className="w-4 h-4 rounded-full bg-blue-300"></div>
                      </>
                    )}
                    {scheme.value === 'purple' && (
                      <>
                        <div className="w-4 h-4 rounded-full bg-purple-500"></div>
                        <div className="w-4 h-4 rounded-full bg-purple-300"></div>
                      </>
                    )}
                    {scheme.value === 'green' && (
                      <>
                        <div className="w-4 h-4 rounded-full bg-green-600"></div>
                        <div className="w-4 h-4 rounded-full bg-green-400"></div>
                      </>
                    )}
                    {scheme.value === 'orange' && (
                      <>
                        <div className="w-4 h-4 rounded-full bg-orange-400"></div>
                        <div className="w-4 h-4 rounded-full bg-orange-300"></div>
                      </>
                    )}
                    {scheme.value === 'rose' && (
                      <>
                        <div className="w-4 h-4 rounded-full bg-rose-500"></div>
                        <div className="w-4 h-4 rounded-full bg-rose-300"></div>
                      </>
                    )}
                    {scheme.value === 'slate' && (
                      <>
                        <div className="w-4 h-4 rounded-full bg-slate-500"></div>
                        <div className="w-4 h-4 rounded-full bg-slate-300"></div>
                      </>
                    )}
                  </div>
                  <span className="text-sm font-medium text-foreground dark:text-foreground">
                    {scheme.label}
                  </span>
                </div>
                {colorScheme === scheme.value && (
                  <div className="absolute top-2 right-2">
                    <svg className="w-5 h-5 text-primary" fill="currentColor" viewBox="0 0 20 20">
                      <path
                        fillRule="evenodd"
                        d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                        clipRule="evenodd"
                      />
                    </svg>
                  </div>
                )}
              </button>
            ))}
          </div>
        </div>
      </Card>

      {/* 语言设置 */}
      <Card className="p-4">
        <div className="space-y-4">
          <div>
            <Label className="text-base font-medium">{t('界面语言')}</Label>
            <p className="text-sm text-muted-foreground mt-1">{t('选择应用界面显示的语言')}</p>
          </div>

          <Select
            value={getConfigValue<LanguageCode>('DEFAULT_LANGUAGE') || 'zh-CN'}
            onValueChange={handleLanguageChange}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder={t('选择语言')} />
            </SelectTrigger>
            <SelectContent>
              {languageOptions.map(option => (
                <SelectItem key={option.value} value={option.value}>
                  <div className="flex items-center gap-2">
                    <span>{option.flag}</span>
                    <span>{option.label}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </Card>

      {/* 插件与模型存储目录设置 (Issue 06 Spec §7.4) */}
      <Card className="p-4" data-testid="plugin-dir-settings-card">
        <div className="space-y-4">
          <div>
            <Label className="text-base font-medium">{t('插件与模型存储目录')}</Label>
            <p className="text-sm text-muted-foreground mt-1">
              {t('存放 AI 大脑模型与功能扩展组件的本地文件夹')}
            </p>
          </div>

          {/* 中文路径警告横幅 (RULE 2.16 & Spec §7.4) */}
          {dirInfo?.defaultDirNonAscii && (
            <div
              data-testid="non-ascii-warning-banner"
              className="flex items-start gap-2.5 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-400 text-xs"
            >
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                {t(
                  '当前默认插件存储路径包含中文字符，可能影响部分 AI 模型稳定运行，强烈建议更改到纯英文磁盘目录'
                )}
              </span>
            </div>
          )}

          {/* 待重启提示条 */}
          {dirPhase === 'PENDING_RESTART' && (
            <div
              data-testid="dir-pending-restart-card-banner"
              className="flex items-center justify-between p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs"
            >
              <div className="flex items-center gap-2 text-amber-700 dark:text-amber-400">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>{t('插件目录已迁移完成，需重启软件以加载新目录资源')}</span>
              </div>
              <Button
                size="sm"
                className="h-7 px-2.5 text-xs bg-amber-600 hover:bg-amber-700 text-white cursor-pointer"
                onClick={() => restartApp()}
              >
                {t('立即重启')}
              </Button>
            </div>
          )}

          {/* 迁移中进度展示 */}
          {dirPhase === 'MIGRATING' && (
            <div
              data-testid="dir-migration-progress-card"
              className="space-y-2 p-3 bg-muted/40 rounded-lg border border-border"
            >
              <div className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-1.5 font-medium text-primary">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  {t('正在迁移插件与模型文件...')}
                </span>
                <span className="font-mono text-muted-foreground">
                  {dirMigrationProgress?.percentage ?? 0}% ({dirMigrationProgress?.copiedFiles ?? 0}{' '}
                  / {dirMigrationProgress?.totalFiles ?? 0} 个文件)
                </span>
              </div>
              <div className="w-full bg-secondary rounded-full h-2 overflow-hidden">
                <div
                  className="bg-primary h-full transition-all duration-300"
                  style={{ width: `${dirMigrationProgress?.percentage ?? 0}%` }}
                />
              </div>
              {dirMigrationProgress?.currentFile && (
                <p className="text-[11px] text-muted-foreground truncate font-mono">
                  {dirMigrationProgress.currentFile}
                </p>
              )}
              <div className="flex justify-end pt-1">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleCancelMigration}
                  className="h-7 text-xs"
                >
                  {t('取消迁移')}
                </Button>
              </div>
            </div>
          )}

          {/* 路径展示与更改操作 */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 rounded-lg bg-muted/30 border border-border">
            <div className="space-y-1 min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <HardDrive className="w-4 h-4 text-muted-foreground shrink-0" />
                <span className="text-xs font-mono font-medium truncate select-all">
                  {dirInfo?.currentPath || t('正在获取目录信息...')}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {t('已占用空间')}:{' '}
                <span className="font-medium text-foreground">
                  {formatBytes(dirInfo?.usedBytes)}
                </span>
              </p>
            </div>

            <Button
              size="sm"
              variant="outline"
              data-testid="change-plugin-dir-button"
              disabled={dirPhase === 'MIGRATING' || isStartingMigration}
              onClick={handlePickAndChangeDir}
              className="h-8 px-3 text-xs shrink-0 cursor-pointer flex items-center gap-1.5"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              <span>{t('更改目录')}</span>
            </Button>
          </div>
        </div>
      </Card>

      {/* 旧插件目录清理卡片 (Spec §7.4 & Issue 04) */}
      {dirInfo?.previousPath &&
        !isOldDirCleanupDismissed &&
        dirInfo?.previousPathExists !== false && (
          <Card className="p-4 border-amber-500/20" data-testid="old-dir-cleanup-card">
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <Label className="text-base font-medium text-foreground flex items-center gap-1.5">
                    <Trash2 className="w-4 h-4 text-amber-500" />
                    <span>{t('清理旧插件目录残留')}</span>
                  </Label>
                  <p className="text-sm text-muted-foreground mt-1">
                    {t('检测到此前迁移遗留的旧目录，可安全清理以释放磁盘空间：')}
                  </p>
                </div>
              </div>

              <div className="p-2.5 rounded bg-muted/40 font-mono text-xs text-muted-foreground truncate select-all">
                {dirInfo.previousPath}
              </div>

              <div className="flex items-center justify-end gap-2 pt-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={handleDismissOldDirCleanup}
                  className="h-8 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
                >
                  {t('忽略')}
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  data-testid="cleanup-old-dir-btn"
                  disabled={isCleaningOldDir || dirPhase === 'MIGRATING'}
                  onClick={handleCleanupOldDir}
                  className="h-8 text-xs cursor-pointer flex items-center gap-1.5"
                >
                  {isCleaningOldDir ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="w-3.5 h-3.5" />
                  )}
                  <span>{t('立即清理')}</span>
                </Button>
              </div>
            </div>
          </Card>
        )}

      {/* 迁移确认对话框 */}
      <AlertDialog open={showConfirmMigrationDialog} onOpenChange={setShowConfirmMigrationDialog}>
        <AlertDialogContent className="border-2 border-border">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-lg">
              <FolderOpen className="w-5 h-5 text-primary" />
              {t('确认迁移插件存储目录')}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm text-foreground pt-1">
                <p>
                  {t(
                    '系统将把现有的插件与模型数据安全复制到新目录。迁移期间原目录资源保持只读保护。'
                  )}
                </p>
                <div className="p-3 bg-muted/40 rounded-lg space-y-1.5 font-mono text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('新存储路径')}:</span>
                    <span className="font-semibold truncate max-w-[240px]">{migrationTarget}</span>
                  </div>
                  {migrationDiagnostics && (
                    <>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{t('目标盘可用空间')}:</span>
                        <span>{formatBytes(migrationDiagnostics.targetFreeBytes)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{t('预估待迁移大小')}:</span>
                        <span>{formatBytes(migrationDiagnostics.requiredBytes)}</span>
                      </div>
                    </>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('迁移完成后需重启软件以正式加载新位置的模型与插件。')}
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button variant="outline" onClick={() => setShowConfirmMigrationDialog(false)}>
                {t('取消')}
              </Button>
            </AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button
                onClick={handleConfirmMigration}
                className="bg-primary text-primary-foreground"
              >
                {t('开始迁移')}
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 迁移完成重启提示框 */}
      <AlertDialog open={showRestartDialog} onOpenChange={setShowRestartDialog}>
        <AlertDialogContent className="border-2 border-border">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-primary flex items-center gap-2 text-lg">
              <Check className="w-5 h-5" />
              {t('插件目录迁移完成')}
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-2 text-sm text-foreground pt-1">
              {t('插件与模型已成功复制到新位置。需重启软件以加载新目录资源，您希望现在重启吗？')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button variant="outline" onClick={() => setShowRestartDialog(false)}>
                {t('稍后重启')}
              </Button>
            </AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button
                onClick={() => restartApp()}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {t('立即重启')}
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {/* 标签显示设置 */}
      {__IS_DEV__ && (
        <Card className="p-4">
          <div className="space-y-4">
            <div>
              <Label className="text-base font-medium">{t('标签显示')}</Label>
              <p className="text-sm text-muted-foreground mt-1">
                {t('控制虚拟目录中标签的显示行为')}
              </p>
            </div>

            <div className="flex items-start space-x-3">
              <div className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  id="show-empty-tags"
                  checked={getConfigValue<boolean>('SHOW_EMPTY_TAGS') ?? false}
                  onChange={e => updateConfigValue('SHOW_EMPTY_TAGS', e.target.checked)}
                  className="h-4 w-4 text-primary border-gray-300 rounded focus:ring-primary"
                />
                <Label htmlFor="show-empty-tags" className="font-medium cursor-pointer">
                  {t('显示空标签')}
                </Label>
              </div>
              <p className="text-sm text-muted-foreground ml-6">
                {t('在维度标签树中显示文件数为0的标签')}
              </p>
            </div>
          </div>
        </Card>
      )}

      {/* 语言变更确认对话框 */}
      <AlertDialog open={showLanguageChangeDialog} onOpenChange={setShowLanguageChangeDialog}>
        <AlertDialogContent className="border-2 dark:border-2 border-border dark:border-border">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-amber-600 dark:text-amber-500 flex items-center gap-2 text-lg dark:text-lg">
              <span className="text-2xl">⚠️</span>
              {t('语言变更警告')}
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-3 text-base text-foreground dark:text-foreground">
              {t(
                '已创建的工作目录不支持语言切换，因为已分析文件的语言无法匹配新的语言环境。您可以随时切换回语言来恢复'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button
                variant="outline"
                onClick={handleCancelLanguageChange}
                className="text-foreground dark:text-foreground"
              >
                {t('取消')}
              </Button>
            </AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button
                variant="destructive"
                onClick={handleConfirmLanguageChange}
                className="bg-amber-600 hover:bg-amber-700 dark:bg-amber-600 dark:hover:bg-amber-700 text-white dark:text-white"
              >
                {t('继续')}
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 语言切换全屏遮罩 */}
      {isSwitchingLanguage && (
        <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-background/80 backdrop-blur-md transition-all duration-300 animate-in fade-in">
          <div className="flex flex-col items-center p-8 bg-card border border-border/50 rounded-2xl shadow-2xl space-y-4 max-w-sm w-full mx-4">
            <div className="relative flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 text-primary">
              <Loader2 className="w-8 h-8 animate-spin" />
            </div>
            <div className="space-y-1 text-center">
              <h4 className="text-base font-semibold text-foreground">
                {t('语言正在切换中...请稍后')}
              </h4>
              <p className="text-xs text-muted-foreground">{t('正在初始化数据库与配置文件')}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
