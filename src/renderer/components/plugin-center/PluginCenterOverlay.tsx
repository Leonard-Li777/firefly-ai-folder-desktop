import React, { useMemo, useState } from 'react'
import { Search, Sliders, ChevronLeft, Puzzle, Sparkles, Layers, Code } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog'
import { Input } from '../ui/input'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import { cn } from '../../lib/utils'
import i18nScope from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'
import { usePluginCenterStore } from '../../stores/plugin-center-store'
import { PluginCard } from './PluginCard'
import { AIEngineConfigSettings } from '../settings/ai-engine-config-settings'
import { TTSSettings } from '../settings/tts-settings'

export interface PluginCenterOverlayProps {
  className?: string
}

/**
 * 插件中心全局覆盖弹层 (Plugin Center Overlay)
 *
 * 遵循规格说明书 §6.1 与 Ticket 05：
 * 1. 类似全局搜索的居中全局覆盖弹层与半透明遮罩；
 * 2. Radix Focus Trap 焦点保护；Esc 键仅关闭顶层弹层；
 * 3. 失焦行为规范：点击应用内半透明遮罩关闭弹层；点击应用外其他窗口保留弹层不关闭；再次点击顶部按钮亦可关闭；
 * 4. 高级 AI 引擎与语音合成 TTS 迁移挂载至插件中心，并预留好 config_schema 与 user_config 模板插槽。
 */
export const PluginCenterOverlay: React.FC<PluginCenterOverlayProps> = ({ className }) => {
  const { t } = useVoerkaI18n(i18nScope)

  const isOverlayOpen = usePluginCenterStore(s => s.isOverlayOpen)
  const closeOverlay = usePluginCenterStore(s => s.closeOverlay)
  const configuringModuleId = usePluginCenterStore(s => s.configuringModuleId)
  const setConfiguringModuleId = usePluginCenterStore(s => s.setConfiguringModuleId)
  const searchKeyword = usePluginCenterStore(s => s.searchKeyword)
  const setSearchKeyword = usePluginCenterStore(s => s.setSearchKeyword)
  const selectedCategory = usePluginCenterStore(s => s.selectedCategory)
  const setSelectedCategory = usePluginCenterStore(s => s.setSelectedCategory)
  const modules = usePluginCenterStore(s => s.modules)
  const installPlugin = usePluginCenterStore(s => s.installPlugin)
  const togglePluginActive = usePluginCenterStore(s => s.togglePluginActive)
  const updateUserConfig = usePluginCenterStore(s => s.updateUserConfig)

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

  // 打开配置面板时同步配置草稿
  const handleOpenConfig = (id: string) => {
    const mod = modules.find(m => m.id === id)
    setUserConfigDraft(mod?.user_config || '{\n  \n}')
    setConfigError(null)
    setConfiguringModuleId(id)
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

  return (
    <Dialog
      open={isOverlayOpen}
      onOpenChange={open => {
        if (!open) closeOverlay()
      }}
    >
      <DialogContent
        data-testid="plugin-center-overlay"
        className={cn(
          'max-w-5xl w-[92vw] max-h-[86vh] h-[86vh] flex flex-col p-0 overflow-hidden bg-card text-card-foreground border-2 border-border/80 shadow-2xl rounded-2xl select-text transform-gpu',
          className
        )}
        onFocusOutside={e => {
          // 核心业务铁律：点击应用外其他窗口保留弹层不关闭（防止用户切屏查阅文档导致输入状态丢失）
          e.preventDefault()
        }}
        onPointerDownOutside={e => {
          // 若点击的是顶部导航栏的插件中心切换按钮，阻止 default 关闭，由按钮自身 onClick 完成开关联动
          const target = e.target as HTMLElement | null
          if (target?.closest('[data-plugin-center-toggle]')) {
            e.preventDefault()
          }
        }}
      >
        {/* 顶部标题栏 */}
        <DialogHeader className="px-6 py-4 border-b border-border/70 flex-shrink-0 flex flex-row items-center justify-between pr-14">
          <div className="flex items-center gap-3">
            {configuringModule && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setConfiguringModuleId(null)}
                className="h-8 px-2 text-xs flex items-center gap-1 hover:bg-accent -ml-2 cursor-pointer"
                title={t('返回插件列表')}
              >
                <ChevronLeft className="w-4 h-4" />
                <span>{t('返回')}</span>
              </Button>
            )}
            <div>
              <DialogTitle className="text-lg font-bold flex items-center gap-2">
                <span className="text-xl">🧩</span>
                <span>{t('插件中心')}</span>
                {configuringModule && (
                  <>
                    <span className="text-muted-foreground font-normal">/</span>
                    <span className="text-primary text-base font-semibold">
                      {t(configuringModule.name)}
                    </span>
                  </>
                )}
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                {configuringModule
                  ? t('配置插件运行时参数与专有模型通道')
                  : t('管理本地 AI 引擎、离线多媒体工具与格式解析扩展能力')}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* 主体内容区 */}
        {configuringModule ? (
          /* ==================== 插件配置子视图 ==================== */
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            {configuringModule.id === 'advanced_ai_engine' ? (
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
            ) : configuringModule.id === 'offline_tts' ? (
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
                <div className="p-4 rounded-xl border border-border/70 bg-muted/20 space-y-3">
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
                    rows={10}
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
        ) : (
          /* ==================== 插件市场卡片列表视图 ==================== */
          <div className="flex-1 flex flex-col min-h-0">
            {/* 检索栏与分类 Tab */}
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

            {/* 插件卡片网格 */}
            <div className="flex-1 overflow-y-auto p-6">
              {filteredModules.length === 0 ? (
                <div className="h-64 flex flex-col items-center justify-center text-center p-6 text-muted-foreground">
                  <Puzzle className="w-10 h-10 mb-2 opacity-40" />
                  <p className="text-sm font-medium">{t('未找到匹配的插件模块')}</p>
                  <p className="text-xs mt-1 opacity-70">
                    {t('请尝试切换分类或使用更简短的关键词搜索')}
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {filteredModules.map(item => (
                    <PluginCard
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
      </DialogContent>
    </Dialog>
  )
}
