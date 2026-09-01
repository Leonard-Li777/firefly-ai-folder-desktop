import { AlertCircle, Loader2, X } from 'lucide-react'
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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { LogCategory, logger } from '@firefly/shared'
import React, { useState, useCallback, memo } from 'react'
import { settingsCategories, useSettingsStore } from '../../stores/settings-store'

import { AIEngineConfigSettings } from './ai-engine-config-settings'
import { AIModelSettings } from './ai-model-settings'
import { AnalysisSettings } from './analysis-settings'
import { Button } from '../ui/button'
import { FileDisplaySettings } from './file-display-settings'
import { InterfaceSettings } from './interface-settings'
import { MonitoringSettings } from './workspace-settings'
import { SettingsCategory } from '@firefly/types'
import { SettingsNavigation } from './settings-navigation'
import { t } from '@app/languages'

const MemoizedInterfaceSettings = memo(InterfaceSettings)
const MemoizedFileDisplaySettings = memo(FileDisplaySettings)
const MemoizedAIModelSettings = memo(AIModelSettings)
const MemoizedAIEngineConfigSettings = memo(AIEngineConfigSettings)
const MemoizedAnalysisSettings = memo(AnalysisSettings)
const MemoizedMonitoringSettings = memo(MonitoringSettings)

const CATEGORY_COMPONENTS: Array<{
  category: SettingsCategory
  Component: React.ComponentType
}> = [
  { category: SettingsCategory.INTERFACE, Component: MemoizedInterfaceSettings },
  { category: SettingsCategory.FILE_DISPLAY, Component: MemoizedFileDisplaySettings },
  { category: SettingsCategory.AI_MODEL, Component: MemoizedAIModelSettings },
  { category: SettingsCategory.AI_ENGINE_CONFIG, Component: MemoizedAIEngineConfigSettings },
  { category: SettingsCategory.ANALYSIS, Component: MemoizedAnalysisSettings },
  { category: SettingsCategory.MONITORING, Component: MemoizedMonitoringSettings }
]

/**
 * 设置对话框组件
 */
export const SettingsDialog: React.FC = () => {
  const isOpen = useSettingsStore(s => s.isOpen)
  const currentCategory = useSettingsStore(s => s.currentCategory)
  const isLoading = useSettingsStore(s => s.isLoading)
  const error = useSettingsStore(s => s.error)
  const setError = useSettingsStore(s => s.setError)
  const validationResult = useSettingsStore(s => s.validationResult)
  const closeSettings = useSettingsStore(s => s.closeSettings)
  const saveSettings = useSettingsStore(s => s.saveSettings)

  const [showLanguageChangeDialog, setShowLanguageChangeDialog] = useState(false)
  const [visitedCategories, setVisitedCategories] = useState<Set<SettingsCategory>>(
    () => new Set([currentCategory])
  )

  // 记录访问过的分类 Tab，实现按需挂载并 Keep-Alive 保活
  React.useEffect(() => {
    if (currentCategory) {
      setVisitedCategories(prev => {
        if (prev.has(currentCategory)) return prev
        const next = new Set(prev)
        next.add(currentCategory)
        return next
      })
    }
  }, [currentCategory])

  // 打开弹窗后，在后台空闲时段分步预热挂载其余所有 Tab，确保用户点击任意 Tab 时 100% 瞬切、零卡顿
  React.useEffect(() => {
    if (!isOpen) return

    let cancelled = false
    let timeoutId: any = null

    const preheatRemainingTabs = () => {
      const allCategories = CATEGORY_COMPONENTS.map(c => c.category)
      let index = 0

      const step = () => {
        if (cancelled || index >= allCategories.length) return
        const cat = allCategories[index]
        index++

        setVisitedCategories(prev => {
          if (prev.has(cat)) return prev
          const next = new Set(prev)
          next.add(cat)
          return next
        })

        // 分步延时调度，每个 Tab 间隔 60ms，避免抢占主线程
        if (index < allCategories.length) {
          if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
            ;(window as any).requestIdleCallback(step, { timeout: 300 })
          } else {
            timeoutId = setTimeout(step, 60)
          }
        }
      }

      if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
        ;(window as any).requestIdleCallback(step, { timeout: 300 })
      } else {
        timeoutId = setTimeout(step, 60)
      }
    }

    // 弹窗弹出 100ms 后启动后台静默预热
    timeoutId = setTimeout(preheatRemainingTabs, 100)

    return () => {
      cancelled = true
      if (timeoutId) clearTimeout(timeoutId)
    }
  }, [isOpen])

  /**
   * 确认语言变更后保存
   */
  const handleConfirmLanguageChange = useCallback(async () => {
    setShowLanguageChangeDialog(false)
    await saveSettings()
    if (!useSettingsStore.getState().error) {
      closeSettings()
    }
  }, [saveSettings, closeSettings])

  if (!isOpen) {
    return null
  }

  logger.info(LogCategory.RENDERER, '[Settings Dialog] 渲染设置对话框')

  return (
    <Dialog open={isOpen} onOpenChange={open => !open && closeSettings()}>
      <DialogContent className="max-w-6xl w-[90vw] h-[85vh] flex flex-col p-0 bg-background dark:bg-card text-primary border-4 border-border rounded-2xl shadow-2xl transform-gpu [contain:content]">
        <DialogHeader className="px-6 py-4 border-b flex-shrink-0">
          <DialogTitle className="text-xl font-semibold">{t('应用设置')}</DialogTitle>
          <DialogDescription className="sr-only">{t('应用设置管理界面')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-1 overflow-hidden">
          {/* 左侧导航 */}
          <div className="w-55 border-r flex flex-col flex-shrink-0">
            <div className="flex-1 overflow-y-auto no-scrollbar">
              <SettingsNavigation />
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

            {/* 设置内容 Keep-Alive 容器 */}
            <div className="flex-1 relative overflow-hidden [contain:paint]">
              {CATEGORY_COMPONENTS.map(({ category, Component }) => {
                const isVisited = visitedCategories.has(category)
                if (!isVisited) return null
                const isActive = currentCategory === category
                return (
                  <div
                    key={category}
                    className={`h-full w-full overflow-y-auto ${isActive ? 'block' : 'hidden'}`}
                  >
                    <Component />
                  </div>
                )
              })}
            </div>
          </div>
        </div>
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
              <Button variant="destructive" onClick={handleConfirmLanguageChange}>
                {t('继续')}
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  )
}
