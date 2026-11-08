import React, { useEffect, useMemo, useState, useRef } from 'react'
import { Search, Sliders, ChevronLeft, Puzzle, Sparkles, Code, X } from 'lucide-react'
import { Input } from '../ui/input'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import { cn } from '../../lib/utils'
import i18nScope from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'
import { usePluginCenterStore } from '../../stores/plugin-center-store'
import { useSettingsStore } from '../../stores/settings-store'
import { SettingsCategory } from '@firefly/types'
import { PluginListItem } from './PluginListItem'
import { AIEngineConfigSettings } from '../settings/ai-engine-config-settings'
import { TTSSettings } from '../settings/tts-settings'

export interface PluginCenterOverlayProps {
  className?: string
}

/**
 * 插件中心主内容区域全局覆盖层 (Plugin Center Overlay)
 *
 * 遵循与全域搜索 (GlobalSearchOverlay) 完全一致的架构规范：
 * 1. 结构形态：摒弃传统浮动弹窗 (Dialog/Modal)，改为主内容区域绝对定位全局覆盖层；
 * 2. 空间布局：紧贴顶部 DirectoryHeader 底边 (top: var(--app-header-height, 53px))，铺满主内容视口；
 * 3. 展现形态：插件列表全面改用横向条目 (List) 形态，取代狭窄的卡片网格形态；
 * 4. 键盘与交互：支持 Esc 键逐级返回与退出（配置模式返回列表，列表模式关闭覆盖层）；
 * 5. 高级 AI 引擎与离线 TTS 获得充裕的大视口展示空间，配置体验舒展自然。
 */
export const PluginCenterOverlay: React.FC<PluginCenterOverlayProps> = ({ className }) => {
  const { t } = useVoerkaI18n(i18nScope)
  const overlayContainerRef = useRef<HTMLDivElement>(null)

  const isOverlayOpen = usePluginCenterStore(s => s.isOverlayOpen)
  const closeOverlay = usePluginCenterStore(s => s.closeOverlay)
  const configuringModuleId = usePluginCenterStore(s => s.configuringModuleId)
  const setConfiguringModuleId = usePluginCenterStore(s => s.setConfiguringModuleId)
  const searchKeyword = usePluginCenterStore(s => s.searchKeyword)
  const setSearchKeyword = usePluginCenterStore(s => s.setSearchKeyword)
  const selectedCategory = usePluginCenterStore(s => s.selectedCategory)
  const setSelectedCategory = usePluginCenterStore(s => s.setSelectedCategory)
  const modules = usePluginCenterStore(s => s.modules)
  const loadModules = usePluginCenterStore(s => s.loadModules)
  const subscribeProgress = usePluginCenterStore(s => s.subscribeProgress)
  const installPlugin = usePluginCenterStore(s => s.installPlugin)
  const togglePluginActive = usePluginCenterStore(s => s.togglePluginActive)
  const updateUserConfig = usePluginCenterStore(s => s.updateUserConfig)

  // IN-06: 订阅后端实时下载进度并支持 React StrictMode 双挂载安全清理
  useEffect(() => {
    const unsubscribe = subscribeProgress()
    return () => {
      unsubscribe()
    }
  }, [subscribeProgress])

  useEffect(() => {
    if (isOverlayOpen) {
      void loadModules()
    }
  }, [isOverlayOpen, loadModules])

  // Esc 键盘多级退出监听
  useEffect(() => {
    if (!isOverlayOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        if (configuringModuleId) {
          setConfiguringModuleId(null)
        } else {
          closeOverlay()
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [isOverlayOpen, configuringModuleId, setConfiguringModuleId, closeOverlay])

  // 自定义配置草稿 (用于 config_schema / user_config 插槽)
  const [userConfigDraft, setUserConfigDraft] = useState<string>('')
  const [configError, setConfigError] = useState<string | null>(null)

  // 当前正在配置的插件实例
  const configuringModule = useMemo(() => {
    if (!configuringModuleId) return null
    return modules.find(m => m.id === configuringModuleId) || null
  }, [configuringModuleId, modules])

  // 分类过滤器
  const categories = useMemo(
    () => [
      { id: 'all', label: t('全部插件') },
      { id: 'ai-engine', label: t('AI 引擎') },
      { id: 'perception', label: t('感知分析') },
      { id: 'media', label: t('多媒体') },
      { id: 'parser', label: t('格式解析') }
    ],
    [t]
  )

  // 过滤后的插件列表（兼顾源码原名、多语言展示名与插件 ID）
  const filteredModules = useMemo(() => {
    return modules.filter(m => {
      // 分类筛选
      if (selectedCategory !== 'all' && m.category !== selectedCategory) {
        return false
      }
      // 关键字搜索
      if (searchKeyword.trim()) {
        const kw = searchKeyword.trim().toLowerCase()
        const nameMatch = m.name.toLowerCase().includes(kw)
        const translatedNameMatch = t(m.name).toLowerCase().includes(kw)
        const descMatch = m.description.toLowerCase().includes(kw)
        const translatedDescMatch = t(m.description).toLowerCase().includes(kw)
        const idMatch = m.id.toLowerCase().includes(kw)
        if (!nameMatch && !translatedNameMatch && !descMatch && !translatedDescMatch && !idMatch) {
          return false
        }
      }
      return true
    })
  }, [modules, selectedCategory, searchKeyword, t])

  // 卡片配置一键直达系统设置对应 Tab (Ticket 05 / Spec §5.2)
  const handleOpenConfig = (id: string) => {
    const mod = modules.find(m => m.id === id)
    closeOverlay()

    const contrib = mod?.contributes?.settings
    if (contrib) {
      if (contrib.scope === 'workspace') {
        useSettingsStore.getState().openWorkspaceSettings({ targetTab: contrib.componentId })
        return
      } else if (contrib.scope === 'global') {
        const catMap: Record<string, SettingsCategory> = {
          tts: SettingsCategory.TTS,
          ai_engine_config: SettingsCategory.AI_ENGINE_CONFIG,
          interface: SettingsCategory.INTERFACE,
          analysis_ignore_rules: SettingsCategory.ANALYSIS_IGNORE_RULES
        }
        const targetCategory = catMap[contrib.componentId] || SettingsCategory.INTERFACE
        useSettingsStore.getState().openSystemSettings(targetCategory)
        return
      }
    }

    // 默认兜底映射
    if (mod?.capability_slot === 'voice_tts' || id === 'tts_moss_onnx') {
      useSettingsStore.getState().openSystemSettings(SettingsCategory.TTS)
    } else if (mod?.capability_slot === 'base_embedding' || id.startsWith('engine_')) {
      useSettingsStore.getState().openWorkspaceSettings({ targetTab: 'basic_ai_engine' })
    } else if (mod?.capability_slot === 'perception_nsfw' || id === 'perception_nsfw') {
      useSettingsStore.getState().openWorkspaceSettings({ targetTab: 'content_extraction' })
    } else if (id === 'ai_organize_skill') {
      useSettingsStore.getState().openSystemSettings(SettingsCategory.AI_ENGINE_CONFIG)
    } else {
      useSettingsStore.getState().openSystemSettings(SettingsCategory.INTERFACE)
    }
  }

  // 保存自定义配置 (增加 JSON 合法性校验防脏写，空白串归一为 null 满足 Genesis V1 CHECK 约束)
  const handleSaveConfig = () => {
    const trimmed = userConfigDraft.trim()
    if (trimmed) {
      try {
        JSON.parse(trimmed)
      } catch {
        setConfigError(t('配置格式错误，必须为合法的 JSON 格式字符串'))
        return
      }
    }
    if (configuringModuleId) {
      updateUserConfig(configuringModuleId, trimmed ? userConfigDraft : null)
    }
    setConfigError(null)
    setConfiguringModuleId(null)
  }

  if (!isOverlayOpen) {
    return null
  }

  return (
    <div
      ref={overlayContainerRef}
      data-testid="plugin-center-overlay"
      className={cn(
        'absolute inset-x-0 bottom-0 z-30 bg-background flex flex-col overflow-hidden select-text',
        'animate-in fade-in duration-200',
        className
      )}
      style={{ top: 'var(--app-header-height, 53px)' }}
    >
      {/* 顶部主工具栏：左侧标题/面包屑与副标，右侧快捷关闭按钮 */}
      <div className="px-6 py-3 border-b border-border/70 flex-shrink-0 flex items-center justify-between bg-card min-h-[52px] gap-4">
        <div className="flex items-center gap-3 min-w-0">
          {configuringModule && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfiguringModuleId(null)}
              className="h-8 px-2 text-xs flex items-center gap-1 hover:bg-accent -ml-2 cursor-pointer shrink-0"
              title={t('返回插件列表')}
            >
              <ChevronLeft className="w-4 h-4" />
              <span>{t('返回')}</span>
            </Button>
          )}
          <div className="min-w-0">
            <div className="text-base font-bold flex items-center gap-2 text-foreground">
              <span className="text-lg shrink-0">🧩</span>
              <span>{t('插件中心')}</span>
              {configuringModule && (
                <>
                  <span className="text-muted-foreground font-normal">/</span>
                  <span className="text-primary text-sm font-semibold truncate max-w-[200px] sm:max-w-[320px]">
                    {t(configuringModule.name)}
                  </span>
                </>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5 truncate">
              {configuringModule
                ? t('配置插件运行时参数与专有模型通道')
                : t('管理本地 AI 引擎、离线多媒体工具与格式解析扩展能力')}
            </p>
          </div>
        </div>

        {/* 右上角关闭按钮 */}
        <Button
          size="sm"
          variant="ghost"
          onClick={closeOverlay}
          className="h-8 w-8 p-0 rounded-full hover:bg-muted text-muted-foreground hover:text-foreground cursor-pointer shrink-0"
          title={t('关闭插件中心 (Esc)')}
          aria-label={t('关闭插件中心')}
        >
          <X className="w-4 h-4" />
        </Button>
      </div>

      {/* 主体内容区 */}
      {configuringModule ? (
        /* ==================== 插件配置子视图 ==================== */
        <div className="flex-1 overflow-y-auto p-6">
          <div className="max-w-5xl mx-auto w-full space-y-6">
            {configuringModule.id === 'advanced_ai_engine' ||
            configuringModule.id === 'ai_organize_skill' ||
            configuringModule.id === 'engine_classic_light' ||
            configuringModule.id === 'engine_gemma_unified' ||
            configuringModule.contributes?.settings?.componentId === 'basic_ai_engine' ? (
              /* 高级 AI 引擎专属配置面板 */
              <div className="space-y-4">
                <div className="flex items-center justify-between pb-3 border-b border-border/60">
                  <div className="flex items-center gap-2">
                    <Sliders className="w-4 h-4 text-primary" />
                    <span className="text-sm font-semibold">{t('本地高级 AI 推理引擎配置')}</span>
                  </div>
                  <Badge variant="outline" className="text-xs font-mono">
                    engine: llama.cpp / v{configuringModule.version}
                  </Badge>
                </div>
                <AIEngineConfigSettings />
              </div>
            ) : configuringModule.id === 'offline_tts' ||
              configuringModule.id === 'tts_moss_onnx' ||
              configuringModule.contributes?.settings?.componentId === 'tts' ? (
              /* 离线语音合成 TTS 专属配置面板 */
              <div className="space-y-4">
                <div className="flex items-center justify-between pb-3 border-b border-border/60">
                  <div className="flex items-center gap-2">
                    <Sliders className="w-4 h-4 text-primary" />
                    <span className="text-sm font-semibold">{t('离线语音合成与发音人管理')}</span>
                  </div>
                  <Badge variant="outline" className="text-xs font-mono">
                    tts: sensevoice-sherpa / v{configuringModule.version}
                  </Badge>
                </div>
                <TTSSettings />
              </div>
            ) : (
              /* 通用插件 config_schema 与 user_config 模板插槽 */
              <div className="space-y-4 max-w-2xl mx-auto py-4">
                <div className="p-5 rounded-xl border border-border/70 bg-muted/20 space-y-3">
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <Code className="w-4 h-4 text-primary" />
                    <span>{t('插件个性化配置项 (JSON Schema)')}</span>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {t(
                      '该模块支持通过标准 JSON 配置调整运行行为。所有配置将持久化存入系统主库 user_config 字段。'
                    )}
                  </p>
                  <textarea
                    rows={12}
                    value={userConfigDraft}
                    onChange={e => {
                      setUserConfigDraft(e.target.value)
                      if (configError) setConfigError(null)
                    }}
                    className={cn(
                      'w-full p-3 text-xs font-mono rounded-lg border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all resize-y',
                      configError ? 'border-destructive' : 'border-border/80 focus:border-primary'
                    )}
                    placeholder="{\n  // 请输入符合插件定义的 JSON 配置项\n}"
                  />
                  {configError && (
                    <div className="text-xs text-destructive font-medium flex items-center gap-1">
                      <span>⚠️</span>
                      <span>{configError}</span>
                    </div>
                  )}
                  <div className="flex items-center justify-end gap-2 pt-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setConfiguringModuleId(null)}
                      className="text-xs"
                    >
                      {t('取消')}
                    </Button>
                    <Button size="sm" onClick={handleSaveConfig} className="text-xs">
                      {t('保存配置')}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        /* ==================== 插件市场 List 列表视图 ==================== */
        <div className="flex-1 flex flex-col min-h-0">
          {/* 二级控制条：分类 Tab 与 关键词搜索输入框 */}
          <div className="px-6 py-3 border-b border-border/60 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-muted/15 flex-shrink-0">
            {/* 分类切换按钮组 */}
            <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-0.5">
              {categories.map(c => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setSelectedCategory(c.id)}
                  className={cn(
                    'px-3 py-1 rounded-full text-xs font-medium transition-all duration-150 cursor-pointer whitespace-nowrap select-none',
                    selectedCategory === c.id
                      ? 'bg-primary text-primary-foreground shadow-2xs font-semibold'
                      : 'bg-muted/70 hover:bg-muted text-muted-foreground hover:text-foreground'
                  )}
                >
                  {c.label}
                </button>
              ))}
            </div>

            {/* 关键词检索输入框 */}
            <div className="relative w-full sm:w-64 flex-shrink-0">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/70" />
              <Input
                value={searchKeyword}
                onChange={e => setSearchKeyword(e.target.value)}
                placeholder={t('搜索插件名称或描述...')}
                className="h-8 pl-8 pr-3 text-xs rounded-full bg-background border-border/80 focus:ring-2 focus:ring-primary/20"
              />
            </div>
          </div>

          {/* 插件条目 List 列表 */}
          <div className="flex-1 overflow-y-auto p-6">
            <div className="max-w-6xl mx-auto w-full">
              {filteredModules.length === 0 ? (
                <div className="h-64 flex flex-col items-center justify-center text-center p-6 text-muted-foreground">
                  <Puzzle className="w-10 h-10 mb-2 opacity-40" />
                  <p className="text-sm font-medium">{t('未找到匹配的插件模块')}</p>
                  <p className="text-xs mt-1 opacity-70">
                    {t('请尝试切换分类或使用更简短的关键词搜索')}
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {filteredModules.map(item => (
                    <PluginListItem
                      key={item.id}
                      module={item}
                      onInstall={installPlugin}
                      onToggleActive={togglePluginActive}
                      onConfigure={handleOpenConfig}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* 底部统计栏 */}
          <div className="px-6 py-2.5 border-t border-border/60 bg-muted/20 flex items-center justify-between text-[11px] text-muted-foreground flex-shrink-0">
            <span className="flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-primary/80" />
              <span>{t('已加载 {total} 个内置与扩展模块', { total: modules.length })}</span>
            </span>
            <span>{t('纯本地离线推理 · 零隐私数据回传')}</span>
          </div>
        </div>
      )}
    </div>
  )
}
