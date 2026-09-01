import React, { useState, useEffect, useMemo } from 'react'
import { Sun, Moon, Monitor, Check, Loader2 } from 'lucide-react'
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
import { useSettingsStore } from '../../stores/settings-store'
import { useTheme } from '../ui/theme-provider'
import type { LanguageCode } from '@firefly/types'
import { toast } from '../common/Toast'
import { getAvailableColorSchemes, ColorScheme } from '../../lib/theme-config'
import { cn } from '../../lib/utils'
import i18nScope from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'
import { SUPPORTED_LANGUAGES } from '@firefly/shared'

/**
 * 界面设置组件
 */
export const InterfaceSettings: React.FC = () => {
  const getConfigValue = useSettingsStore(s => s.getConfigValue)
  const updateConfigValue = useSettingsStore(s => s.updateConfigValue)
  const themeMode = useSettingsStore(s => (s.config?.ui as any)?.theme || (s.config as any)?.theme)
  const { t, changeLanguage, activeLanguage } = useVoerkaI18n(i18nScope)
  const { setTheme, colorScheme, setColorScheme } = useTheme()
  const [showLanguageChangeDialog, setShowLanguageChangeDialog] = useState(false)
  const [pendingLanguage, setPendingLanguage] = useState<LanguageCode | null>(null)
  const [isSwitchingLanguage, setIsSwitchingLanguage] = useState(false)

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
