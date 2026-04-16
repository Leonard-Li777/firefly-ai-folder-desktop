import React, { useState } from 'react'
import { t } from '@app/languages'
import { logger, LogCategory } from '@yonuc/shared'
import { 
  Dialog, 
  DialogContent, 
  DialogHeader, 
  DialogTitle,
  DialogFooter 
} from '../ui/dialog'
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
import { useSettingsStore, settingsCategories } from '../../stores/settings-store'
import { SettingsCategory } from '@yonuc/types'
import { SettingsNavigation } from './settings-navigation'
import { InterfaceSettings } from './interface-settings'
import { FileDisplaySettings } from './file-display-settings'
import { AIModelSettings } from './ai-model-settings'
import { AnalysisSettings } from './analysis-settings'
import { MonitoringSettings } from './workspace-settings'
import { AlertCircle, Loader2, X } from 'lucide-react'

/**
 * 设置对话框组件
 */
export const SettingsDialog: React.FC = () => {
  const {
    isOpen,
    currentCategory,
    hasUnsavedChanges,
    isLoading,
    error,
    setError,
    validationResult,
    config,
    originalConfig,
    closeSettings,
    saveSettings,
    cancelSettings
  } = useSettingsStore()

  const [showLanguageChangeDialog, setShowLanguageChangeDialog] = useState(false)

  logger.info(LogCategory.RENDERER, '[Settings Dialog] 组件渲染，isOpen:', isOpen)

  /**
   * 处理保存设置
   */
  const handleSave = async () => {
    // 检查语言是否变更
    const languageChanged = config.language !== originalConfig?.language
    
    if (languageChanged) {
      setShowLanguageChangeDialog(true)
      return
    }
    
    await saveSettings()
    if (!useSettingsStore.getState().error) {
      closeSettings()
    }
  }

  /**
   * 确认语言变更后保存
   */
  const handleConfirmLanguageChange = async () => {
    setShowLanguageChangeDialog(false)
    await saveSettings()
    if (!useSettingsStore.getState().error) {
      closeSettings()
    }
  }

  /**
   * 处理取消设置
   */
  const handleCancel = () => {
    // 直接关闭对话框，因为更改是即时保存的
    closeSettings()
  }

  /**
   * 渲染当前分类的设置内容
   */
  const renderSettingsContent = () => {
    switch (currentCategory) {
      case SettingsCategory.INTERFACE:
        return <InterfaceSettings />
      case SettingsCategory.FILE_DISPLAY:
        return <FileDisplaySettings />
      case SettingsCategory.AI_MODEL:
        return <AIModelSettings />
      case SettingsCategory.ANALYSIS:
        return <AnalysisSettings />
      case SettingsCategory.MONITORING:
        return <MonitoringSettings />
      default:
        return <div className="p-4 text-center text-muted-foreground">{t('未知的设置分类')}</div>
    }
  }

  if (!isOpen) {
    logger.info(LogCategory.RENDERER, '[Settings Dialog] 对话框未打开，不渲染')
    return null
  }

  logger.info(LogCategory.RENDERER, '[Settings Dialog] 渲染设置对话框')

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && closeSettings()}>
      <DialogContent className="max-w-4xl h-[80vh] flex flex-col p-0 dark:bg-muted/50 text-primary border-4 border-border rounded-2xl">
        <DialogHeader className="px-6 py-4 border-b">
          <DialogTitle className="text-xl font-semibold">{t('应用设置')}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-1 overflow-hidden">
          {/* 左侧导航 */}
          <div className="w-64 border-r">
            <SettingsNavigation />
          </div>

          {/* 右侧内容区 */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* 错误提示 */}
            {error && (
              <div className="mx-6 mt-4 p-3 bg-destructive/10 border border-destructive/20 rounded-md flex items-center justify-between gap-2 text-destructive">
                <div className="flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span className="text-sm">{error}</span>
                </div>
                <button 
                  onClick={() => setError(null)}
                  className="hover:bg-destructive/20 p-1 rounded-full transition-colors"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}

            {/* 验证错误提示 */}
            {validationResult && !validationResult.isValid && (
              <div className="mx-6 mt-4 p-3 bg-destructive/10 border border-destructive/20 rounded-md">
                <div className="flex items-center gap-2 text-destructive mb-2">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span className="text-sm font-medium">{t('设置验证失败')}</span>
                </div>
                <ul className="text-sm text-destructive/80 space-y-1">
                  {validationResult.errors.map((error, index) => (
                    <li key={index}>• {error.message}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* 设置内容 */}
            <div className="flex-1 overflow-y-auto">
              {renderSettingsContent()}
            </div>
          </div>
        </div>

        {/* 底部操作按钮 */}
        <DialogFooter className="px-6 py-4 border-t bg-muted/30 flex-shrink-0">
          <div className="flex items-center justify-end w-full">
            <Button
              variant="outline"
              onClick={handleCancel}
              disabled={isLoading}
            >
              {t('关闭')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>

      {/* 语言变更确认对话框 */}
      <AlertDialog open={showLanguageChangeDialog} onOpenChange={setShowLanguageChangeDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('语言变更警告')}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>{t('更改语言将重置AI分析数据库，所有AI分析结果、标签和维度数据将被清除。')}</p>
                <p className="text-destructive font-medium">{t('是否继续？')}</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button variant="outline">{t('取消')}</Button>
            </AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button variant="destructive" onClick={handleConfirmLanguageChange}>{t('继续')}</Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  )
}
