import { MaterialIcon, cn } from '../../lib/utils'
import React, { useEffect, useRef, useState, useMemo } from 'react'

import { LatestNewsItem } from '@firefly/types/config-types'
import { PersistentTooltip } from '../common/PersistentTooltip'
import { UserAvatarMenu } from '../tier/UserAvatarMenu'
import { WorkspaceDirectory } from '@firefly/types'
import { logoIcon } from '../ui/icon'
import { openExternalLink } from '../../lib/external-link'
import i18nScope, { t } from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'
import { useConfigStore } from '../../stores/config-store'
import { useTierStore } from '../../stores/tier-store'
import { useSearchStore } from '../../stores/search-store'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAnalyzedDirectoryStore } from '../../stores/analyzed-directory-store'
import { useSettingsStore } from '../../stores/settings-store'
import { SettingsCategory } from '@firefly/types'
import { Stepper, Step } from '../common/Stepper'
import { Button } from '../ui/button'

import { PaymentFlowDialog } from '../tier/PaymentFlowDialog'

interface DirectoryHeaderProps {
  currentWorkspaceDirectory: WorkspaceDirectory | null
  workspaceDirectories: WorkspaceDirectory[]
  showDirectoryDropdown: boolean
  isRealDirectory: boolean // true for real directory, false for virtual directory
  onToggleDirectoryDropdown: (forceState?: boolean) => void
  onSelectWorkspaceDirectory: (directory: WorkspaceDirectory) => Promise<void>
  onAddWorkspaceDirectory: (type?: 'SPEEDY' | 'PRIVATE') => Promise<void>
  dropdownRef: React.RefObject<HTMLDivElement | null>
  onSearch: (keyword: string) => void // 搜索回调
  exportTooltipVisible?: boolean
  isLoading?: boolean
}

export const DirectoryHeader: React.FC<DirectoryHeaderProps> = React.memo(
  ({
    currentWorkspaceDirectory,
    workspaceDirectories,
    showDirectoryDropdown,
    isRealDirectory,
    onToggleDirectoryDropdown,
    onSelectWorkspaceDirectory,
    onAddWorkspaceDirectory,
    dropdownRef,
    onSearch,
    exportTooltipVisible = false,
    isLoading = false
  }) => {
    const navigate = useNavigate()
    const location = useLocation()
    const currentPath = location.pathname
    const [isMaximized, setIsMaximized] = useState(false)
    const [isUserMenuOpen, setIsUserMenuOpen] = useState(false)
    const { hasNewFiles, setHasNewFiles, newFilesCount } = useAnalyzedDirectoryStore()
    const { computed_limits } = useTierStore()
    const [licenseType, setLicenseType] = useState<string | null>(null)

    // 全域搜索状态与输入控制
    const globalSearchKeyword = useSearchStore(state => state.globalSearchKeyword)
    const setGlobalSearchKeyword = useSearchStore(state => state.setGlobalSearchKeyword)
    const clearGlobalSearch = useSearchStore(state => state.clearGlobalSearch)
    const searchHistory = useSearchStore(state => state.searchHistory)
    const getSearchSuggestions = useSearchStore(state => state.getSearchSuggestions)
    const addSearchHistory = useSearchStore(state => state.addSearchHistory)
    const removeSearchHistoryByKeyword = useSearchStore(
      state => state.removeSearchHistoryByKeyword
    )
    const clearSearchHistory = useSearchStore(state => state.clearSearchHistory)

    const [localSearchInput, setLocalSearchInput] = useState(globalSearchKeyword)
    const [showHistoryPopover, setShowHistoryPopover] = useState(false)
    const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(-1)
    const searchInputRef = useRef<HTMLInputElement | null>(null)
    const searchContainerRef = useRef<HTMLDivElement | null>(null)
    const isComposingRef = useRef(false)

    // 计算当前匹配的搜索历史词（聚焦空输入时返回最近历史，有输入时返回模糊匹配历史）
    const historySuggestions = useMemo(() => {
      return getSearchSuggestions('global', localSearchInput)
    }, [getSearchSuggestions, localSearchInput, searchHistory])

    // 同步外部 globalSearchKeyword 变更（如清空或由其他操作重置）
    useEffect(() => {
      setLocalSearchInput(globalSearchKeyword)
    }, [globalSearchKeyword])

    // 全局快捷键监听 (Ctrl+F / Cmd+F)，带白名单与可见性守卫
    useEffect(() => {
      const handleGlobalKeyDown = (e: KeyboardEvent) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
          // 可见性守卫：若当前 Header 所在容器隐藏（非活跃 Keep-Alive 页面），忽略该快捷键
          if (
            searchInputRef.current?.closest('.opacity-0') ||
            searchInputRef.current?.offsetParent === null
          ) {
            return
          }
          const activeEl = document.activeElement
          const tagName = activeEl?.tagName
          if (
            tagName === 'INPUT' ||
            tagName === 'TEXTAREA' ||
            activeEl?.closest('.monaco-editor')
          ) {
            return
          }
          e.preventDefault()
          searchInputRef.current?.focus()
          searchInputRef.current?.select()
        }
      }
      window.addEventListener('keydown', handleGlobalKeyDown)
      return () => window.removeEventListener('keydown', handleGlobalKeyDown)
    }, [])

    // 订阅语言变化，确保 useMemo 中缓存的翻译随语言切换更新
    const { activeLanguage } = useVoerkaI18n(i18nScope)

    // 消息轮播相关
    const config = useConfigStore(state => state.config)
    const latestNews = (config?.LATEST_NEWS as LatestNewsItem[]) || []
    const [currentNewsIndex, setCurrentNewsIndex] = useState(0)
    const [isNewsDropdownOpen, setIsNewsDropdownOpen] = useState(false)
    const newsDropdownRef = useRef<HTMLDivElement | null>(null)
    const newsTimerRef = useRef<NodeJS.Timeout | null>(null)
    const headerRef = useRef<HTMLElement | null>(null)

    const STEPS: Step[] = [
      { key: 'real', label: t('真实目录'), path: '/real-directory', icon: 'folder' },
      {
        key: 'analyzed',
        label: t('已分析'),
        path: '/analyzed-directory',
        icon: 'auto_awesome',
        badgeCount: hasNewFiles ? newFilesCount : 0,
        tooltipId: 'header_analyzed_badge_hint',
        tooltipContent: t('有新分析完成的文件，点击「已分析」查看')
      },
      { key: 'organize', label: t('整理'), path: '/organize', icon: 'auto_fix_high' },
      {
        key: 'virtual',
        label: t('虚拟目录'),
        path: '/virtual-directory',
        icon: 'folder_special'
      },
      {
        key: 'export',
        label: t('导出'),
        path: '/virtual-directory/export',
        icon: 'output',
        ...(exportTooltipVisible
          ? {
              tooltipId: 'header_export_satisfaction_hint',
              tooltipContent: t('对虚拟目录满意，可以选择导出'),
              tooltipVisible: true,
              tooltipPosition: 'bottom' as const
            }
          : {})
      }
    ]

    const currentStepPath = useMemo(() => {
      if (currentPath === '/' || currentPath === '/real-directory') return '/real-directory'
      return currentPath
    }, [currentPath])

    useEffect(() => {
      const checkMaximized = async () => {
        if (typeof window.electronAPI?.window?.isMaximized === 'function') {
          const maximized = await window.electronAPI!.window.isMaximized()
          setIsMaximized(maximized)
        }
      }
      const fetchLicenseStatus = async () => {
        if (window.electronAPI?.license?.getStatus) {
          const result = await window.electronAPI.license.getStatus()
          setLicenseType(result.type || null)
        }
      }
      checkMaximized()
      fetchLicenseStatus()
    }, [])

    // 动态监听 Header 高度，实时写回 CSS 变量 --app-header-height，使全局搜索浮层无缝贴合第二排下边缘
    useEffect(() => {
      const headerEl = headerRef.current
      if (!headerEl) return

      const updateWrapState = () => {
        const height = headerEl.offsetHeight
        document.documentElement.style.setProperty('--app-header-height', `${height}px`)
      }

      updateWrapState()
      const resizeObserver = new ResizeObserver(updateWrapState)
      resizeObserver.observe(headerEl)

      return () => {
        resizeObserver.disconnect()
      }
    }, [])

    // 全局点击外部关闭逻辑（第二层保险：处理点击页面主体、侧边栏等非 Header 区域）
    useEffect(() => {
      const handleClickOutside = (event: PointerEvent) => {
        if (
          showDirectoryDropdown &&
          dropdownRef.current &&
          !dropdownRef.current.contains(event.target as Node)
        ) {
          onToggleDirectoryDropdown(false)
        }

        if (
          isNewsDropdownOpen &&
          newsDropdownRef.current &&
          !newsDropdownRef.current.contains(event.target as Node)
        ) {
          setIsNewsDropdownOpen(false)
        }

        if (
          showHistoryPopover &&
          searchContainerRef.current &&
          !searchContainerRef.current.contains(event.target as Node)
        ) {
          setShowHistoryPopover(false)
          setActiveSuggestionIndex(-1)
        }
      }

      if (showDirectoryDropdown || isNewsDropdownOpen || showHistoryPopover) {
        document.addEventListener('pointerdown', handleClickOutside)
      }

      return () => {
        document.removeEventListener('pointerdown', handleClickOutside)
      }
    }, [
      showDirectoryDropdown,
      isNewsDropdownOpen,
      showHistoryPopover,
      onToggleDirectoryDropdown,
      dropdownRef
    ])

    const isEnterprise = licenseType === 'ENTERPRISE'

    // 轮播逻辑（最新资讯）
    useEffect(() => {
      if (latestNews.length <= 1) {
        if (newsTimerRef.current) clearInterval(newsTimerRef.current)
        return
      }

      newsTimerRef.current = setInterval(() => {
        setCurrentNewsIndex(prev => (prev + 1) % latestNews.length)
      }, 5000)

      return () => {
        if (newsTimerRef.current) clearInterval(newsTimerRef.current)
      }
    }, [latestNews.length])

    // 搜索框动态 Placeholder 候选列表（遵循国际化支持）
    const SEARCH_PLACEHOLDERS = useMemo(
      () => [
        t('自然语言搜索文件...'),
        t('支持搜索文本、图片、音频、视频...'),
        t('支持拼音和拼音首字母搜索...'),
        t('支持搜索未分析和已分析文件...'),
        t('示例：红色跑车、hongsepaoche、hspc'),
        t('示例：上个月签署的采购合同 pdf'),
        t('示例：带红色印章的发票图片'),
        t('示例：周会录音或产品需求会议纪要'),
        t('示例：去年第四季度财务预算表 xlsx')
      ],
      [activeLanguage]
    )

    const [currentPlaceholderIndex, setCurrentPlaceholderIndex] = useState(0)

    useEffect(() => {
      const placeholderTimer = setInterval(() => {
        setCurrentPlaceholderIndex(prev => (prev + 1) % SEARCH_PLACEHOLDERS.length)
      }, 3600)

      return () => {
        clearInterval(placeholderTimer)
      }
    }, [SEARCH_PLACEHOLDERS.length])

    const handleNewsClick = (url: string | undefined) => {
      if (url) {
        openExternalLink(url, { errorTitle: t('无法打开链接') })
        setIsNewsDropdownOpen(false)
      }
    }

    const getLevelStyles = (level?: string) => {
      switch (level) {
        case 'error':
          return {
            bg: 'bg-red-500/10 hover:bg-red-500/20',
            dot: 'bg-red-500',
            text: 'text-red-500',
            ring: 'ring-red-500/30'
          }
        case 'warn':
          return {
            bg: 'bg-amber-500/10 hover:bg-amber-500/20',
            dot: 'bg-amber-500',
            text: 'text-amber-500',
            ring: 'ring-amber-500/30'
          }
        case 'info':
          return {
            bg: 'bg-primary/10 hover:bg-primary/20',
            dot: 'bg-primary',
            text: 'text-primary',
            ring: 'ring-primary/30'
          }
        default:
          return {
            bg: 'bg-primary/10 hover:bg-primary/20',
            dot: 'bg-primary',
            text: 'text-primary',
            ring: 'ring-primary/30'
          }
      }
    }

    const handleMinimize = () => {
      window.electronAPI!.window.minimize()
    }

    const handleMaximize = async () => {
      if (typeof window.electronAPI?.window?.maximize === 'function') {
        await window.electronAPI!.window.maximize()
        const maximized = await window.electronAPI!.window.isMaximized()
        setIsMaximized(maximized)
      }
    }

    const handleClose = () => {
      window.electronAPI!.window.close()
    }

    // 仅当「带全屏点击拦截层的浮层」打开时禁用拖拽：此时需要让点击落到拦截层/关闭逻辑上。
    // 严禁把「搜索框有内容」「搜索历史气泡展开」纳入判据：二者长期驻留（关键词会一直留在 store 里），
    // 一旦纳入会让整个 Header 永久无法拖动；且搜索输入框与历史气泡自身已各自 no-drag，无需整体禁用。
    const isAnyDropdownOpen = showDirectoryDropdown || isNewsDropdownOpen || isUserMenuOpen

    return (
      <header
        ref={headerRef}
        className="relative z-50 flex-shrink-0 bg-background/98 dark:bg-background/98 backdrop-blur-md border-b border-border/60 dark:border-border/40 shadow-sm w-full flex flex-col"
        style={{ WebkitAppRegion: isAnyDropdownOpen ? 'no-drag' : 'drag' } as React.CSSProperties}
      >
        {/* Dropdown Overlays */}
        {(showDirectoryDropdown || isNewsDropdownOpen) && (
          <div
            className="fixed inset-0 z-[90]"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            onPointerDown={e => {
              e.stopPropagation()
              if (showDirectoryDropdown) onToggleDirectoryDropdown(false)
              if (isNewsDropdownOpen) setIsNewsDropdownOpen(false)
            }}
          />
        )}

        {/* 第一排：Logo + 标题 与 动态资讯 + 窗口控制 */}
        <div
          className="flex items-center justify-between px-4 py-2 w-full gap-4 flex-nowrap relative z-[105]"
          style={{ WebkitAppRegion: isAnyDropdownOpen ? 'no-drag' : 'drag' } as React.CSSProperties}
        >
          {/* Left Side: Logo and Title */}
          <div className="flex items-center space-x-2 flex-shrink-0">
            <img
              src={logoIcon}
              width={24}
              height={24}
              className="object-contain flex-shrink-0"
              alt="logo"
            />
            <span className="text-base font-semibold text-foreground dark:text-foreground hidden sm:inline-block whitespace-nowrap">
              {t('萤核智能文件夹')}
            </span>
          </div>

          {/* Right Side: News & Controls */}
          <div className="flex items-center justify-end space-x-3 flex-1 min-w-0 relative z-[105]">
            {/* News Carousel: 默认左对齐、宽度自适应（文本多长才多长，超出溢出省略） */}
            {!isEnterprise && (
              <div
                className="relative flex items-center text-xs text-primary transition-all duration-500 min-w-0 flex-1 justify-start"
                ref={newsDropdownRef}
                onPointerDown={e => e.stopPropagation()}
              >
                {latestNews.length > 0 ? (
                  <>
                    <div
                      className={cn(
                        'flex items-center gap-1.5 px-1 py-1 rounded-md animate-in fade-in duration-500 cursor-pointer max-w-full min-w-0 hover:opacity-85 transition-opacity',
                        getLevelStyles(latestNews[currentNewsIndex]?.level).text
                      )}
                      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                      onClick={() => setIsNewsDropdownOpen(!isNewsDropdownOpen)}
                    >
                      <span
                        className={cn(
                          'flex h-1.5 w-1.5 rounded-full animate-pulse flex-shrink-0',
                          getLevelStyles(latestNews[currentNewsIndex]?.level).dot
                        )}
                      />
                      <span
                        className="truncate font-medium min-w-0 text-left"
                        title={latestNews[currentNewsIndex]?.text}
                      >
                        {latestNews[currentNewsIndex]?.text}
                      </span>
                      <MaterialIcon
                        icon={isNewsDropdownOpen ? 'arrow_drop_up' : 'arrow_drop_down'}
                        className="text-base opacity-70 flex-shrink-0"
                      />
                    </div>

                    {isNewsDropdownOpen && (
                      <div
                        className="absolute top-full left-0 mt-2 bg-popover border border-border rounded-md shadow-xl z-[120] py-1 min-w-[280px] max-w-[420px]"
                        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                      >
                        <div className="px-3 py-1.5 text-[10px] font-semibold text-muted-foreground border-b border-border mb-1 uppercase tracking-wider">
                          {t('最新动态')}
                        </div>
                        <div className="max-h-60 overflow-y-auto">
                          {latestNews.map((news, index) => {
                            const styles = getLevelStyles(news.level)
                            return (
                              <button
                                key={index}
                                className={cn(
                                  'w-full flex items-start gap-3 px-3 py-2.5 text-left transition-colors group whitespace-nowrap',
                                  news.url
                                    ? 'cursor-pointer hover:bg-accent hover:text-accent-foreground'
                                    : 'cursor-default',
                                  'border-b border-border/50 last:border-none'
                                )}
                                onClick={() => handleNewsClick(news.url)}
                              >
                                <span
                                  className={cn(
                                    'flex h-1.5 w-1.5 rounded-full mt-1.5 flex-shrink-0',
                                    news.level
                                      ? styles.dot
                                      : index === currentNewsIndex
                                        ? 'bg-primary animate-pulse'
                                        : 'bg-muted-foreground/40'
                                  )}
                                />
                                <div className="min-w-0">
                                  <div className={cn('text-xs font-medium', news.level && styles.text)}>
                                    {news.text}
                                  </div>
                                  {news.url && (
                                    <div className="text-[10px] text-muted-foreground truncate opacity-60 transition-colors duration-200 group-hover:text-accent-foreground/70">
                                      {news.url}
                                    </div>
                                  )}
                                </div>
                                {news.url && (
                                  <MaterialIcon
                                    icon="open_in_new"
                                    className="text-sm text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity self-center"
                                  />
                                )}
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <span className="truncate px-2">{t('AI 摘要功能已上线!')}</span>
                )}
              </div>
            )}

            {/* Controls Group */}
            <div className="flex items-center space-x-3 flex-shrink-0">
              {/* User Avatar Menu */}
              <div data-no-drag className="no-drag flex-shrink-0" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
                <UserAvatarMenu onOpenChange={setIsUserMenuOpen} />
              </div>

              {/* Window Controls */}
              <div
                className="flex items-center space-x-1 pl-2 border-l border-border/40 dark:border-white/10 ml-1 flex-shrink-0"
                style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
              >
                <button
                  onClick={handleMinimize}
                  className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer"
                  title={t('最小化')}
                >
                  <MaterialIcon
                    icon="minimize"
                    className="text-muted-foreground text-lg leading-none"
                  />
                </button>
                <button
                  onClick={handleMaximize}
                  className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer"
                  title={isMaximized ? t('恢复') : t('最大化')}
                >
                  <MaterialIcon
                    icon={isMaximized ? 'fullscreen_exit' : 'fullscreen'}
                    className="text-muted-foreground text-lg leading-none"
                  />
                </button>
                <button
                  onClick={handleClose}
                  className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-destructive hover:text-destructive-foreground transition-colors cursor-pointer"
                  title={t('关闭')}
                >
                  <MaterialIcon icon="close" className="text-muted-foreground text-lg leading-none" />
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* 第二排：拉通背景、无圆角的统一 Hub 与弹性宽度自适应搜索框 */}
        {/* 拖拽：本排不整体设 no-drag，条带空白处继承 header 的 drag；仅 Hub 与搜索框各自 no-drag */}
        <div className="flex items-center w-full gap-6 px-4 py-1.5 border-t border-border/50 dark:border-white/[0.08] bg-muted/40 dark:bg-white/[0.03] shadow-[inset_0_1px_0_hsl(0_0%_100%/0.04)] relative z-[95]">
          {/* Hub 区域：工作目录选择器 + 步骤指示器（移除独立外层胶囊与圆角，与第二排背景融为一体） */}
          <div
            className="flex items-center flex-shrink-0 gap-1"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            {/* Directory Selector */}
            <div
              className="relative flex-shrink-0"
              ref={dropdownRef}
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
              onPointerDown={e => e.stopPropagation()}
            >
              <button
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 rounded-full transition-all duration-200 cursor-pointer',
                  'border text-sm font-semibold whitespace-nowrap',
                  showDirectoryDropdown
                    ? [
                        'bg-background dark:bg-background/60',
                        'text-foreground dark:text-foreground',
                        'border-border/60 dark:border-border/40',
                        'shadow-[0_1px_4px_hsl(0_0%_0%/0.1)] dark:shadow-[0_1px_4px_hsl(0_0%_0%/0.25)]'
                      ]
                    : [
                        'bg-transparent text-muted-foreground',
                        'border-transparent',
                        'hover:bg-background/70 dark:hover:bg-white/[0.06]',
                        'hover:text-foreground',
                        'hover:border-border/40 dark:hover:border-white/10'
                      ]
                )}
                onClick={() => {
                  if (!showDirectoryDropdown && globalSearchKeyword) {
                    clearGlobalSearch()
                    setLocalSearchInput('')
                  }
                  onToggleDirectoryDropdown()
                }}
                title={t('当前工作目录: {name}，点击切换', {
                  name: currentWorkspaceDirectory?.name || t('未选择')
                })}
              >
                <MaterialIcon
                  icon={
                    currentWorkspaceDirectory?.type === 'SPEEDY'
                      ? 'rocket_launch'
                      : currentWorkspaceDirectory?.type === 'PRIVATE'
                        ? 'lock'
                        : isRealDirectory
                          ? 'folder_open'
                          : 'folder_special'
                  }
                  className={cn(
                    'text-[15px] transition-colors duration-200 leading-none',
                    showDirectoryDropdown ? 'text-primary' : 'text-primary'
                  )}
                />
                <span className="transition-colors duration-200 max-w-[120px] truncate">
                  {currentWorkspaceDirectory?.name || t('未选择')}
                </span>
                <MaterialIcon
                  icon={showDirectoryDropdown ? 'arrow_drop_up' : 'arrow_drop_down'}
                  className="text-[16px] leading-none transition-transform duration-200 text-current opacity-60"
                />
              </button>

              {/* Directory Dropdown */}
              <div
                className={cn(
                  'absolute top-full left-0 mt-2 w-80 bg-background dark:bg-zinc-900 border border-border dark:border-zinc-800 rounded-xl shadow-2xl z-[100] overflow-hidden origin-top transition-all duration-200 ease-out',
                  showDirectoryDropdown
                    ? 'opacity-100 translate-y-0 scale-100 pointer-events-auto'
                    : 'opacity-0 -translate-y-2 scale-95 pointer-events-none'
                )}
              >
                <div className="max-h-60 overflow-y-auto">
                  {workspaceDirectories.length === 0 ? (
                    <div className="p-4 text-center text-sm text-muted-foreground">
                      {t('暂无工作目录')}
                    </div>
                  ) : (
                    (() => {
                      let speedyCount = 0
                      let privateCount = 0
                      return workspaceDirectories.map(directory => {
                        const isSpeedy = directory.type === 'SPEEDY'
                        const isPrivate = directory.type === 'PRIVATE'
                        let isExpired = false
                        if (computed_limits) {
                          if (isSpeedy) {
                            if (speedyCount >= (computed_limits.speedy_dir_slot_limit ?? 3))
                              isExpired = true
                            speedyCount++
                          }
                          if (isPrivate) {
                            if (privateCount >= (computed_limits.private_dir_slot_limit ?? 3))
                              isExpired = true
                            privateCount++
                          }
                        }

                        const isSelectedDir =
                          currentWorkspaceDirectory?.path && directory.path
                            ? (
                                window.electronAPI?.utils?.isPathEqual ||
                                ((a: string, b: string) => a === b)
                              )(currentWorkspaceDirectory.path, directory.path)
                            : currentWorkspaceDirectory?.path === directory.path

                        return (
                          <div
                            key={directory.path}
                            className={cn(
                              'w-full flex items-center space-x-3 px-3 py-2 text-sm text-left transition-colors cursor-pointer',
                              isExpired
                                ? 'opacity-40 hover:opacity-60 hover:bg-accent/50'
                                : 'hover:bg-accent hover:text-accent-foreground',
                              isSelectedDir ? 'bg-primary/10 text-primary' : 'text-foreground'
                            )}
                            onClick={() => onSelectWorkspaceDirectory(directory)}
                            role="button"
                            tabIndex={0}
                            onKeyDown={e => {
                              if (e.key === 'Enter') onSelectWorkspaceDirectory(directory)
                            }}
                            title={
                              isExpired
                                ? t('已超出目录插槽限制，点击可激活')
                                : t('切换到工作目录: {path}', { path: directory.path })
                            }
                          >
                            <MaterialIcon
                              icon={
                                isExpired
                                  ? 'lock'
                                  : directory.type === 'SPEEDY'
                                    ? 'rocket_launch'
                                    : directory.type === 'PRIVATE'
                                      ? 'lock'
                                      : 'folder'
                              }
                              className={cn(
                                'text-sm',
                                isSelectedDir && !isExpired
                                  ? 'text-primary'
                                  : 'text-muted-foreground'
                              )}
                            />
                            <div className="flex-1 min-w-0">
                              <div className="font-medium truncate flex items-center">
                                {directory.name}
                                {directory.type === 'SPEEDY' && (
                                  <span className="text-xs text-muted-foreground ml-1">
                                    {t('（极速）')}
                                  </span>
                                )}
                                {directory.type === 'PRIVATE' && (
                                  <span className="text-xs text-muted-foreground ml-1">
                                    {t('（私有）')}
                                  </span>
                                )}
                              </div>
                              <div className="text-xs text-muted-foreground truncate">
                                {directory.path}
                              </div>
                            </div>
                            {isExpired && (
                              <MaterialIcon icon="lock" className="text-muted-foreground text-sm" />
                            )}
                            {isSelectedDir && !isExpired && (
                              <MaterialIcon icon="check" className="text-primary text-base" />
                            )}
                          </div>
                        )
                      })
                    })()
                  )}
                </div>
                <div className="p-3 border-t border-border/60 dark:border-border/40 bg-gradient-to-b from-muted/30 to-muted/10 dark:from-background/40 dark:to-background/20">
                  {/* 区块标题 */}
                  <div className="px-1 mb-3 flex items-center gap-1.5">
                    <div className="flex items-center justify-center w-4 h-4 rounded-full bg-primary/15 dark:bg-primary/20">
                      <MaterialIcon icon="add" className="text-[10px] text-primary" />
                    </div>
                    <span className="text-[10px] font-bold text-muted-foreground/80 dark:text-muted-foreground/70 uppercase tracking-widest">
                      {t('添加新工作目录')}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {/* 极速目录卡片 */}
                    <button
                      className={cn(
                        'group relative flex flex-col items-center justify-center p-3.5 rounded-xl border transition-all duration-300 overflow-hidden',
                        isEnterprise
                          ? 'border-muted-foreground/10 text-muted-foreground/40 cursor-not-allowed opacity-40 bg-muted/20'
                          : 'border-primary/25 dark:border-primary/20 text-primary cursor-pointer hover:border-primary/60 dark:hover:border-primary/50 hover:shadow-md hover:shadow-primary/10 dark:hover:shadow-primary/5 hover:-translate-y-0.5 active:translate-y-0 bg-gradient-to-br from-primary/8 to-primary/3 dark:from-primary/10 dark:to-primary/5 hover:from-primary/12 hover:to-primary/6 dark:hover:from-primary/15 dark:hover:to-primary/8'
                      )}
                      onClick={() => {
                        if (isEnterprise) return
                        onAddWorkspaceDirectory('SPEEDY')
                      }}
                      title={isEnterprise ? t('企业版暂不支持极速目录') : t('创建极速目录（推荐）')}
                      disabled={isEnterprise}
                    >
                      {/* 光晕背景 */}
                      {!isEnterprise && (
                        <div className="absolute inset-0 bg-radial from-primary/10 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
                      )}
                      {/* 推荐角标 - 直接定位在button角落，依靠button的overflow-hidden裁切 */}
                      {!isEnterprise && (
                        <div className="absolute top-1 -right-3 bg-gradient-to-br from-primary to-primary/80 text-primary-foreground text-[8px] font-black px-5 py-0.5 rotate-45 shadow-sm uppercase tracking-tighter pointer-events-none">
                          ⭐
                        </div>
                      )}
                      {/* 图标 */}
                      <div className="relative z-10 flex items-center justify-center w-9 h-9 rounded-full bg-primary/10 dark:bg-primary/15 group-hover:bg-primary/20 dark:group-hover:bg-primary/25 transition-all duration-300 mb-2 group-hover:scale-110">
                        <MaterialIcon
                          icon="rocket_launch"
                          className="text-lg text-primary group-hover:-rotate-12 transition-transform duration-500"
                        />
                      </div>
                      <span className="text-xs font-bold relative z-10 text-primary dark:text-primary">
                        {t('极速目录')}
                      </span>
                      <p
                        className="text-[9px] opacity-55 dark:opacity-50 text-center mt-1 leading-tight relative z-10 text-primary/80 dark:text-primary/70 w-full truncate"
                        title={t('共享分析数据，极速分析')}
                      >
                        {t('共享分析数据，极速分析')}
                      </p>
                    </button>
                    {/* 私有目录卡片 */}
                    <button
                      className="group relative flex flex-col items-center justify-center p-3.5 rounded-xl border border-border/60 dark:border-border/40 cursor-pointer overflow-hidden transition-all duration-300 bg-gradient-to-br from-muted/40 to-muted/20 dark:from-muted/20 dark:to-muted/10 hover:border-violet-400/40 dark:hover:border-violet-500/30 hover:shadow-md hover:shadow-violet-500/8 dark:hover:shadow-violet-500/5 hover:-translate-y-0.5 active:translate-y-0 hover:from-violet-50/60 hover:to-violet-50/20 dark:hover:from-violet-900/15 dark:hover:to-violet-900/8"
                      onClick={() => {
                        onAddWorkspaceDirectory('PRIVATE')
                      }}
                      title={t('创建私有目录')}
                    >
                      {/* 光晕背景 */}
                      <div className="absolute inset-0 bg-radial from-violet-500/8 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
                      {/* 图标 */}
                      <div className="relative z-10 flex items-center justify-center w-9 h-9 rounded-full bg-muted/60 dark:bg-muted/30 group-hover:bg-violet-100/70 dark:group-hover:bg-violet-900/25 transition-all duration-300 mb-2 group-hover:scale-110">
                        <MaterialIcon
                          icon="lock"
                          className="text-lg text-muted-foreground group-hover:text-violet-500 dark:group-hover:text-violet-400 transition-colors duration-300"
                        />
                      </div>
                      <span className="text-xs font-bold relative z-10 text-muted-foreground group-hover:text-foreground dark:group-hover:text-foreground transition-colors duration-300">
                        {t('私有目录')}
                      </span>
                      <p
                        className="text-[9px] opacity-50 text-center mt-1 leading-tight relative z-10 text-muted-foreground group-hover:opacity-65 transition-opacity duration-300 w-full truncate"
                        title={t('分析数据不上云，数据私密')}
                      >
                        {t('分析数据不上云，数据私密')}
                      </p>
                    </button>
                  </div>
                </div>
                <div className="p-2 border-t border-border/60 dark:border-border/40">
                  <button
                    className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
                    onClick={() => {
                      onToggleDirectoryDropdown(false)
                      useSettingsStore.getState().openSettings(SettingsCategory.MONITORING)
                    }}
                  >
                    <MaterialIcon icon="settings" className="text-[15px]" />
                    <span>{t('工作目录管理')}</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Divider */}
            <div className="w-px h-5 bg-border/40 dark:bg-white/[0.07] flex-shrink-0 mx-0.5" />

            {/* Workflow Stepper */}
            <div className="px-0.5 min-w-0 flex-1">
              <Stepper
                steps={STEPS}
                currentPath={currentStepPath}
                onStepClick={path => {
                  if (path === '/analyzed-directory') setHasNewFiles(false)
                  clearGlobalSearch()
                  navigate(path)
                }}
              />
            </div>
          </div>

          {/* Elevated Search Bar: 右对齐（ml-auto 吸收剩余空间），弹性自适应宽度，与 Hub 保持 gap-6 最小间距 */}
          <div
            ref={searchContainerRef}
            className="relative flex items-center flex-1 min-w-[200px] max-w-2xl ml-auto z-[95]"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <div className="relative flex items-center group w-full">
              <MaterialIcon
                icon="search"
                className={cn(
                  'absolute left-3 text-[17px] pointer-events-none transition-colors duration-200 z-10',
                  localSearchInput
                    ? 'text-primary'
                    : 'text-muted-foreground/60 group-hover:text-muted-foreground'
                )}
              />
              <input
                ref={searchInputRef}
                type="text"
                value={localSearchInput}
                onFocus={() => {
                  setShowHistoryPopover(true)
                  setActiveSuggestionIndex(-1)
                }}
                onChange={e => {
                  const val = e.target.value
                  setLocalSearchInput(val)
                  setShowHistoryPopover(true)
                  setActiveSuggestionIndex(-1)
                  const isNativeComposing = (e.nativeEvent as any)?.isComposing ?? isComposingRef.current
                  if (!isNativeComposing) {
                    setGlobalSearchKeyword(val)
                    onSearch?.(val)
                  }
                }}
                onKeyDown={e => {
                  if (showHistoryPopover && historySuggestions.length > 0) {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault()
                      setActiveSuggestionIndex(prev =>
                        prev < historySuggestions.length - 1 ? prev + 1 : 0
                      )
                      return
                    }
                    if (e.key === 'ArrowUp') {
                      e.preventDefault()
                      setActiveSuggestionIndex(prev =>
                        prev > 0 ? prev - 1 : historySuggestions.length - 1
                      )
                      return
                    }
                    if (e.key === 'Enter' && activeSuggestionIndex >= 0) {
                      e.preventDefault()
                      const chosen = historySuggestions[activeSuggestionIndex]
                      setLocalSearchInput(chosen)
                      setGlobalSearchKeyword(chosen)
                      addSearchHistory(chosen, 'global')
                      onSearch?.(chosen)
                      setShowHistoryPopover(false)
                      setActiveSuggestionIndex(-1)
                      return
                    }
                  }

                  if (e.key === 'Enter') {
                    // 若处于输入法组词中，交由 compositionend 处理，避免截断拼音
                    if ((e.nativeEvent as any)?.isComposing || isComposingRef.current) {
                      return
                    }
                    e.preventDefault()
                    const finalKeyword = (searchInputRef.current?.value ?? localSearchInput).trim()
                    if (finalKeyword) {
                      setLocalSearchInput(finalKeyword)
                      setGlobalSearchKeyword(finalKeyword)
                      addSearchHistory(finalKeyword, 'global')
                      onSearch?.(finalKeyword)
                    }
                    setShowHistoryPopover(false)
                    setActiveSuggestionIndex(-1)
                    return
                  }

                  if (e.key === 'Escape') {
                    e.preventDefault()
                    setShowHistoryPopover(false)
                    setActiveSuggestionIndex(-1)
                    setLocalSearchInput('')
                    clearGlobalSearch()
                    searchInputRef.current?.blur()
                  }
                }}
                onCompositionStart={() => {
                  isComposingRef.current = true
                }}
                onCompositionEnd={e => {
                  isComposingRef.current = false
                  // 健壮获取上屏文本：优先 DOM 真实值，兜底 event 目标值
                  const val = searchInputRef.current?.value ?? (e.target as HTMLInputElement)?.value ?? e.currentTarget.value
                  setLocalSearchInput(val)
                  setGlobalSearchKeyword(val)
                  onSearch?.(val)
                }}
                onBlur={() => {
                  if (isComposingRef.current) {
                    isComposingRef.current = false
                    const val = searchInputRef.current?.value ?? localSearchInput
                    setLocalSearchInput(val)
                    setGlobalSearchKeyword(val)
                    onSearch?.(val)
                  }
                }}
                placeholder={SEARCH_PLACEHOLDERS[currentPlaceholderIndex]}
                className={cn(
                  'w-full h-9 rounded-full pl-8.5 text-xs transition-all duration-200 ease-out select-text',
                  localSearchInput ? 'pr-26' : 'pr-8',
                  'bg-background/90 dark:bg-background/60',
                  // 默认无边框：仅在聚焦或已输入搜索文本时高亮显示边框
                  'border border-transparent',
                  'text-foreground placeholder:text-muted-foreground/60',
                  'focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/60 focus:bg-background focus:shadow-md',
                  // 已有搜索文本时常亮高亮（与聚焦态同款），便于一眼识别当前处于搜索状态
                  localSearchInput.trim().length > 0 &&
                    'border-primary/60 ring-2 ring-primary/20 shadow-md'
                )}
                title={t('全域混合搜索（支持未分析与已分析文件）')}
              />
              {localSearchInput ? (
                <button
                  type="button"
                  onClick={() => {
                    setLocalSearchInput('')
                    clearGlobalSearch()
                    setShowHistoryPopover(false)
                    setActiveSuggestionIndex(-1)
                    searchInputRef.current?.focus()
                  }}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 h-6 px-2 rounded-full flex items-center gap-1 bg-muted/80 hover:bg-muted text-muted-foreground hover:text-foreground text-[11px] font-medium transition-all duration-150 cursor-pointer border border-border/50 hover:border-border active:scale-95 z-10 shadow-2xs"
                  title={t('退出搜索 (ESC)')}
                >
                  <MaterialIcon icon="close" className="text-xs shrink-0" />
                  <span className="hidden sm:inline leading-none whitespace-nowrap">
                    {t('退出搜索')}
                  </span>
                  <kbd className="text-[9px] font-mono leading-none text-muted-foreground/80 bg-background/80 dark:bg-black/30 px-1 py-0.5 rounded border border-border/40 ml-0.5 shrink-0">
                    ESC
                  </kbd>
                </button>
              ) : (
                <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] font-mono text-muted-foreground/40 bg-muted/40 dark:bg-white/[0.06] px-1.5 py-0.5 rounded border border-border/30 select-none pointer-events-none hidden sm:inline-flex z-10">
                  Ctrl F
                </kbd>
              )}
            </div>

            {/* 轻量搜索历史气泡 */}
            {showHistoryPopover && historySuggestions.length > 0 && (
              <div
                className="absolute top-full left-0 mt-2 w-full min-w-[280px] bg-popover/95 dark:bg-zinc-900/95 backdrop-blur-md border border-border/70 dark:border-zinc-800 rounded-xl shadow-xl z-[110] overflow-hidden animate-in fade-in slide-in-from-top-1 duration-150"
                style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
              >
                <div className="px-3 py-1.5 flex items-center justify-between border-b border-border/40 text-[11px] text-muted-foreground select-none">
                  <span>{localSearchInput.trim() ? t('匹配搜索历史') : t('最近搜索')}</span>
                  <button
                    type="button"
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => {
                      clearSearchHistory()
                      setShowHistoryPopover(false)
                      setActiveSuggestionIndex(-1)
                    }}
                    className="hover:text-primary transition-colors cursor-pointer"
                  >
                    {t('清空')}
                  </button>
                </div>
                <div className="max-h-56 overflow-y-auto py-1">
                  {historySuggestions.map((suggestion, idx) => (
                    <div
                      key={suggestion}
                      onMouseDown={e => e.preventDefault()}
                      onClick={() => {
                        setLocalSearchInput(suggestion)
                        setGlobalSearchKeyword(suggestion)
                        addSearchHistory(suggestion, 'global')
                        onSearch?.(suggestion)
                        setShowHistoryPopover(false)
                        setActiveSuggestionIndex(-1)
                        searchInputRef.current?.focus()
                      }}
                      className={cn(
                        'px-3 py-1.5 flex items-center justify-between text-xs cursor-pointer transition-colors group select-none',
                        activeSuggestionIndex === idx
                          ? 'bg-accent text-accent-foreground font-medium'
                          : 'hover:bg-accent/60 text-foreground'
                      )}
                    >
                      <div className="flex items-center gap-2 min-w-0 flex-1 mr-2">
                        <MaterialIcon
                          icon="history"
                          className="text-[14px] text-muted-foreground/60 shrink-0"
                        />
                        <span className="truncate">{suggestion}</span>
                      </div>
                      <button
                        type="button"
                        onMouseDown={e => e.preventDefault()}
                        onClick={e => {
                          e.stopPropagation()
                          removeSearchHistoryByKeyword(suggestion)
                        }}
                        className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-opacity"
                        title={t('删除此条历史')}
                      >
                        <MaterialIcon icon="close" className="text-[12px]" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 通栏 Loading 条 (处于 DirectoryHeader 底边，贯穿整个视口宽度) */}
        {isLoading && (
          <div
            data-testid="directory-header-loading-bar"
            className="absolute bottom-0 inset-x-0 h-[2px] z-[120] overflow-hidden pointer-events-none bg-primary/10"
          >
            <div className="h-full w-full bg-gradient-to-r from-transparent via-primary to-transparent animate-indeterminate-bar" />
          </div>
        )}
      </header>
    )
  }
)
