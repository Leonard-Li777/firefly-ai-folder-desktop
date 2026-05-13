import { AlertCircle, Loader2, X, ShieldCheck } from 'lucide-react'
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { LogCategory, logger } from '@yonuc/shared'
import React, { useState } from 'react'
import { settingsCategories, useSettingsStore } from '../../stores/settings-store'

import { AIModelSettings } from './ai-model-settings'
import { AnalysisSettings } from './analysis-settings'
import { Button } from '../ui/button'
import { FileDisplaySettings } from './file-display-settings'
import { InterfaceSettings } from './interface-settings'
import { MonitoringSettings } from './workspace-settings'
import { SettingsCategory } from '@yonuc/types'
import { SettingsNavigation } from './settings-navigation'
import { t } from '@app/languages'
import { EnterpriseLicenseForm } from '../license/EnterpriseLicenseForm'

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
  const [isActivatingEnterprise, setIsActivatingEnterprise] = useState(false)

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
    if (isActivatingEnterprise) {
      return (
        <div className="p-8 max-w-2xl mx-auto">
          <div className="mb-8 text-center">
            <ShieldCheck className="w-12 h-12 text-primary mx-auto mb-4" />
            <h2 className="text-2xl font-bold">{t('激活企业版')}</h2>
            <p className="text-muted-foreground mt-2">{t('解锁离线授权与企业级高级功能')}</p>
          </div>
          <EnterpriseLicenseForm onActivated={() => {
            setIsActivatingEnterprise(false)
            window.location.reload()
          }} />
        </div>
      )
    }

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
          <div className="w-55 border-r flex flex-col">
            <div className="flex-1 overflow-y-auto no-scrollbar">
              <SettingsNavigation 
                onCategoryChange={() => setIsActivatingEnterprise(false)} 
                isEnterpriseActive={isActivatingEnterprise}
              />
            </div>
            <div className="p-4 border-t bg-muted/20">
              <Button 
                variant={isActivatingEnterprise ? "default" : "outline"} 
                className="w-full justify-start gap-2 text-xs font-bold"
                onClick={() => setIsActivatingEnterprise(true)}
              >
                <ShieldCheck className="w-4 h-4" />
                {t('激活企业版')}
              </Button>
            </div>
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
