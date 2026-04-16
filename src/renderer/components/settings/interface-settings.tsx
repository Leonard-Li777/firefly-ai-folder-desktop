import React, { useState, useEffect } from 'react'
import { Card } from '../ui/card'
import { Label } from '../ui/label'
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
  AlertDialogTitle,
} from '../ui/alert-dialog'
import { Button } from '../ui/button'
import { useSettingsStore } from '../../stores/settings-store'
import { useTheme } from '../ui/theme-provider'
import type { LanguageCode } from '@yonuc/types'
import { toast } from '../common/Toast'
import { getAvailableColorSchemes, ColorScheme } from '../../lib/theme-config'
import { cn } from '../../lib/utils'
import i18nScope from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'
import { SUPPORTED_LANGUAGES } from '@yonuc/shared'

/**
 * 界面设置组件
 */
export const InterfaceSettings: React.FC = () => {
  const { config, getConfigValue, updateConfigValue, saveSettings } = useSettingsStore()
  const { t, changeLanguage } = useVoerkaI18n(i18nScope)
  const { setTheme, colorScheme, setColorScheme } = useTheme()
  const [showLanguageChangeDialog, setShowLanguageChangeDialog] = useState(false)
  const [pendingLanguage, setPendingLanguage] = useState<LanguageCode | null>(null)

  // 获取可用的配色方案
  const colorSchemes = getAvailableColorSchemes()

  // 当主题配置变化时,应用主题
  useEffect(() => {
    const theme = getConfigValue<'light' | 'dark' | 'auto'>('THEME_MODE') || 'auto'
    setTheme(theme)
  }, [config.theme, setTheme, getConfigValue])

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
      // 1. 更新语言配置
      updateConfigValue('DEFAULT_LANGUAGE', pendingLanguage)
      
      // 2. 强制保存配置到后端，确保主进程获知语言变更
      await saveSettings()
      
      // 3. 切换前端语言（虽然即将刷新，但为了平滑过渡）
      changeLanguage(pendingLanguage)

      // 4. 关闭对话框
      setShowLanguageChangeDialog(false)
      setPendingLanguage(null)

      toast.success(t('语言已切换，正在刷新页面...'))
      
      // 5. 刷新页面以完全重新加载应用状态（包括数据库连接、工作目录等）
      // 给予一点时间让 Toast 显示
      setTimeout(() => {
        window.location.reload()
      }, 500)
      
    } catch (error) {
      console.error('切换语言失败:', error)
      toast.error(t('切换语言失败,请重试'))
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
  const themeOptions = [
    { value: 'light', label: t('浅色主题'), description: t('始终使用浅色界面') },
    { value: 'dark', label: t('深色主题'), description: t('始终使用深色界面') },
    { value: 'auto', label: t('跟随系统'), description: t('根据系统设置自动切换') }
  ]

  /**
   * 语言选项（从 SUPPORTED_LANGUAGES 动态生成，避免硬编码）
   */
  const languageOptions = SUPPORTED_LANGUAGES.map(lang => ({
    value: lang.code,
    label: lang.nativeName,
    flag: lang.flag
  }))

  /**
   * 视图模式选项
   */
  const viewModeOptions = [
    { value: 'grid', label: t('网格视图'), description: t('以缩略图网格形式显示文件') },
    { value: 'list', label: t('列表视图'), description: t('以详细列表形式显示文件') }
  ]

  return (
    <div className="p-6 space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-2">{t('界面设置')}</h3>
        <p className="text-sm text-muted-foreground">
          {t('自定义应用的外观和界面行为')}
        </p>
      </div>

      {/* 主题设置 */}
      <Card className="p-4 bg-card dark:bg-card">
        <div className="space-y-4">
          <div>
            <Label className="text-base font-medium text-card-foreground">{t('主题模式')}</Label>
            <p className="text-sm text-muted-foreground mt-1">
              {t('选择应用的明暗模式')}
            </p>
          </div>

          <RadioGroup
            value={getConfigValue<'light' | 'dark' | 'auto'>('THEME_MODE') || 'auto'}
            onValueChange={handleThemeChange}
            className="space-y-3"
          >
            {themeOptions.map((option) => (
              <div key={option.value} className="flex items-start space-x-3">
                <div className="flex items-center space-x-2">
                  <input
                    type="radio"
                    id={`theme-${option.value}`}
                    name="theme"
                    value={option.value}
                    checked={(getConfigValue<'light' | 'dark' | 'auto'>('THEME_MODE') || 'auto') === option.value}
                    onChange={(e) => handleThemeChange(e.target.value as 'light' | 'dark' | 'auto')}
                    className="h-4 w-4 text-primary border-input dark:border-input focus:ring-primary"
                  />
                  <Label htmlFor={`theme-${option.value}`} className="font-medium text-foreground dark:text-foreground cursor-pointer">
                    {option.label}
                  </Label>
                </div>
                <p className="text-sm text-muted-foreground ml-6">
                  {option.description}
                </p>
              </div>
            ))}
          </RadioGroup>
        </div>
      </Card>

      {/* 配色方案设置 */}
      <Card className="p-4 bg-card dark:bg-card">
        <div className="space-y-4">
          <div>
            <Label className="text-base font-medium text-card-foreground">{t('配色方案')}</Label>
            <p className="text-sm text-muted-foreground mt-1">
              {t('选择应用的主题配色')}
            </p>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {colorSchemes.map((scheme) => (
              <button
                key={scheme.value}
                onClick={() => setColorScheme(scheme.value)}
                className={cn(
                  "relative p-4 rounded-lg border-2 transition-all",
                  "hover:shadow-md dark:hover:shadow-lg",
                  "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
                  colorScheme === scheme.value
                    ? "border-primary bg-primary/10 dark:bg-primary/20"
                    : "border-border bg-background dark:bg-card hover:border-muted-foreground/50"
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
                    <svg
                      className="w-5 h-5 text-primary"
                      fill="currentColor"
                      viewBox="0 0 20 20"
                    >
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
            <p className="text-sm text-muted-foreground mt-1">
              {t('选择应用界面显示的语言')}
            </p>
          </div>

          <Select
            value={getConfigValue<LanguageCode>('DEFAULT_LANGUAGE') || 'zh-CN'}
            onValueChange={handleLanguageChange}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder={t('选择语言')} />
            </SelectTrigger>
            <SelectContent>
              {languageOptions.map((option) => (
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

      {/* 默认视图模式 */}
      <Card className="p-4">
        <div className="space-y-4">
          <div>
            <Label className="text-base font-medium">{t('默认视图模式')}</Label>
            <p className="text-sm text-muted-foreground mt-1">
              {t('设置打开文件目录时的默认显示模式')}
            </p>
          </div>

          <RadioGroup
            value={getConfigValue<'grid' | 'list'>('DEFAULT_VIEW') || 'grid'}
            onValueChange={(value) => updateConfigValue('DEFAULT_VIEW', value)}
            className="space-y-3"
          >
            {viewModeOptions.map((option) => (
              <div key={option.value} className="flex items-start space-x-3">
                <div className="flex items-center space-x-2">
                  <input
                    type="radio"
                    id={`view-${option.value}`}
                    name="defaultView"
                    value={option.value}
                    checked={(getConfigValue<'grid' | 'list'>('DEFAULT_VIEW') || 'grid') === option.value}
                    onChange={(e) => updateConfigValue('DEFAULT_VIEW', e.target.value)}
                    className="h-4 w-4 text-primary border-gray-300 focus:ring-primary"
                  />
                  <Label htmlFor={`view-${option.value}`} className="font-medium">
                    {option.label}
                  </Label>
                </div>
                <p className="text-sm text-muted-foreground ml-6">
                  {option.description}
                </p>
              </div>
            ))}
          </RadioGroup>
        </div>
      </Card>

      {/* 标签显示设置 */}
      {IS_DEV && (<Card className="p-4">
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
                onChange={(e) => updateConfigValue('SHOW_EMPTY_TAGS', e.target.checked)}
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
      </Card>)}

      {/* 预览区域 */}
      <Card className="p-4 bg-muted/30">
        <div className="space-y-2">
          <Label className="text-base font-medium">{t('预览')}</Label>
          <div className="text-sm text-muted-foreground space-y-1">
            <p>{t('当前主题:')} <span className="font-medium">{themeOptions.find(t => t.value === getConfigValue('THEME_MODE'))?.label}</span></p>
            <p>{t('当前语言:')} <span className="font-medium">{languageOptions.find(l => l.value === getConfigValue('DEFAULT_LANGUAGE'))?.label}</span></p>
            <p>{t('默认视图:')} <span className="font-medium">{viewModeOptions.find(v => v.value === getConfigValue('DEFAULT_VIEW'))?.label}</span></p>
          </div>
        </div>
      </Card>

      {/* 语言变更确认对话框 */}
      <AlertDialog open={showLanguageChangeDialog} onOpenChange={setShowLanguageChangeDialog}>
        <AlertDialogContent className="border-2 dark:border-2 border-border dark:border-border">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-amber-600 dark:text-amber-500 flex items-center gap-2 text-lg dark:text-lg">
              <span className="text-2xl">⚠️</span>
              {t('语言变更警告')}
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-3 text-base text-foreground dark:text-foreground">
              {t('已创建的工作目录不支持语言切换，因为已分析文件的语言无法匹配新的语言环境。您可以随时切换回语言来恢复')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button variant="outline" onClick={handleCancelLanguageChange} className="text-foreground dark:text-foreground">
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
    </div>
  )
}
