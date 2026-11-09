import React, { useState, memo } from 'react'
import { AlertCircle, X } from 'lucide-react'
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
import { Button } from '../ui/button'
import { useSettingsStore, systemSettingsCategories } from '../../stores/settings-store'
import { usePluginCenterStore } from '../../stores/plugin-center-store'
import { SettingsCategory } from '@firefly/types'
import { t } from '@app/languages'
import { cn } from '../../lib/utils'
import { SETTINGS_COMPONENT_MAP } from './settings-component-map'

const SYSTEM_CATEGORY_COMPONENTS: Array<{
  category: SettingsCategory
  Component: React.ComponentType
}> = [
  { category: SettingsCategory.INTERFACE, Component: SETTINGS_COMPONENT_MAP.interface },
  {
    category: SettingsCategory.AI_ENGINE_CONFIG,
    Component: SETTINGS_COMPONENT_MAP.ai_engine_config
  },
  { category: SettingsCategory.TTS, Component: SETTINGS_COMPONENT_MAP.tts },
  {
    category: SettingsCategory.ANALYSIS_IGNORE_RULES,
    Component: SETTINGS_COMPONENT_MAP.analysis_ignore_rules
  },
  {
    category: SettingsCategory.EXTERNAL_API,
    Component: SETTINGS_COMPONENT_MAP.external_api
  }
]

const ICON_MAP: Record<string, string> = {
  palette: '🎨',
  settings_suggest: '✨',
  record_voice_over: '🎙️',
  filter: '🛡️',
  share: '🔌'
}

/**
 * 系统设置独立对话框 (SystemSettingsDialog)
 * 严格限定为界面/显示、开启高级AI引擎、离线TTS、系统忽略规则 4 项
 */
export const SystemSettingsDialog: React.FC = () => {
  const isOpen = useSettingsStore(s => s.isSystemSettingsOpen)
  const currentCategory = useSettingsStore(s => s.currentCategory)
  const setCurrentCategory = useSettingsStore(s => s.setCurrentCategory)
  const closeSettings = useSettingsStore(s => s.closeSystemSettings)
  const error = useSettingsStore(s => s.error)
  const setError = useSettingsStore(s => s.setError)
  const validationResult = useSettingsStore(s => s.validationResult)

  const [showLanguageChangeDialog, setShowLanguageChangeDialog] = useState(false)
  const [visitedCategories, setVisitedCategories] = useState<Set<SettingsCategory>>(
    () => new Set([SettingsCategory.INTERFACE])
  )

  // 记录访问过的分类以 Keep-Alive 保活
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

  if (!isOpen) return null

  const modules = usePluginCenterStore(s => s.modules)

  // 动态根据已安装且激活的插件挂载或隐藏对应 Tab (Spec §5.2)
  const validCategories = React.useMemo(() => {
    const all = systemSettingsCategories()
    if (!modules || modules.length === 0) return all

    const activeModules = modules.filter(m => m.install_state === 'active')

    return all.filter(category => {
      // 基础界面、全系统忽略规则与对外接口为内置常驻项
      if (
        category.id === SettingsCategory.INTERFACE ||
        category.id === SettingsCategory.ANALYSIS_IGNORE_RULES ||
        category.id === SettingsCategory.EXTERNAL_API
      ) {
        return true
      }
      // 语音合成 (TTS)：若对应插件未激活则自动隐藏
      if (category.id === SettingsCategory.TTS) {
        return activeModules.some(
          m =>
            m.contributes?.settings?.componentId === 'tts' ||
            m.capability_slot === 'voice_tts' ||
            m.id === 'tts_moss_onnx'
        )
      }
      // 高级 AI 引擎：若对应插件未激活则自动隐藏
      if (category.id === SettingsCategory.AI_ENGINE_CONFIG) {
        return activeModules.some(
          m =>
            m.contributes?.settings?.componentId === 'ai_engine_config' ||
            m.capability_slot === 'ai_engine'
        )
      }
      return true
    })
  }, [modules])

  // 兜底校验：如果当前分类不在可用项中，重置为第一个有效分类
  const activeCategory = validCategories.some(c => c.id === currentCategory)
    ? currentCategory
    : (validCategories[0]?.id as SettingsCategory) || SettingsCategory.INTERFACE

  return (
    <Dialog open={isOpen} onOpenChange={open => !open && closeSettings()}>
      <DialogContent className="max-w-5xl w-[88vw] h-[82vh] flex flex-col p-0 bg-card text-foreground border-4 border-border rounded-2xl surface-elev-3 transform-gpu [contain:content]">
        <DialogHeader className="px-6 py-4 border-b flex-shrink-0 flex flex-row items-center justify-between">
          <div>
            <DialogTitle className="text-xl font-bold flex items-center gap-2">
              <span>⚙️</span>
              <span>{t('系统设置')}</span>
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground mt-0.5">
              {t('通用环境、界面风格、高级 AI 引擎与全局忽略规则')}
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="flex flex-1 overflow-hidden">
          {/* 左侧系统设置导航 */}
          <div className="w-56 border-r flex flex-col flex-shrink-0 bg-muted/40">
            <nav className="p-3 space-y-1.5 overflow-y-auto">
              {validCategories.map(category => {
                const isActive = activeCategory === category.id
                return (
                  <Button
                    key={category.id}
                    variant={isActive ? 'default' : 'ghost'}
                    className={cn(
                      'w-full justify-start text-left h-auto p-2.5 whitespace-break-spaces transition-all duration-200',
                      isActive && 'bg-primary text-primary-foreground shadow-sm scale-[1.01]',
                      !isActive && 'hover:bg-muted/60 text-muted-foreground hover:text-foreground'
                    )}
                    onClick={() => setCurrentCategory(category.id as SettingsCategory)}
                  >
                    <div className="flex items-start gap-2.5">
                      <span className="text-base shrink-0 mt-0.5">
                        {ICON_MAP[category.icon] || '⚙️'}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-xs leading-snug">{category.name}</div>
                        <div
                          className={cn(
                            'text-[11px] mt-0.5 line-clamp-1 opacity-80',
                            isActive ? 'text-primary-foreground' : 'text-muted-foreground'
                          )}
                        >
                          {category.description}
                        </div>
                      </div>
                    </div>
                  </Button>
                )
              })}
            </nav>
          </div>

          {/* 右侧内容区 */}
          <div className="flex-1 flex flex-col overflow-hidden bg-background">
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

            {validationResult && !validationResult.isValid && (
              <div className="mx-6 mt-4 p-3 bg-destructive/10 border border-destructive/20 rounded-md">
                <div className="flex items-center gap-2 text-destructive mb-2">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span className="text-sm font-medium">{t('设置验证失败')}</span>
                </div>
                <ul className="text-sm text-destructive/80 space-y-1">
                  {validationResult.errors.map((err, index) => (
                    <li key={index}>• {err.message}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* 设置内容挂载区 */}
            <div className="flex-1 relative overflow-hidden [contain:paint]">
              {SYSTEM_CATEGORY_COMPONENTS.map(({ category, Component }) => {
                const isVisited = visitedCategories.has(category)
                if (!isVisited) return null
                const isActive = activeCategory === category
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
    </Dialog>
  )
}
