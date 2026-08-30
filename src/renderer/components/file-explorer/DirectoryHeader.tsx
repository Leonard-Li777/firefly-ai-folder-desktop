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
    exportTooltipVisible = false
  }) => {
    const navigate = useNavigate()
    const location = useLocation()
    const currentPath = location.pathname
    const [isMaximized, setIsMaximized] = useState(false)
    const [isSearchDropdownOpen, setIsSearchDropdownOpen] = useState(false)
    const { hasNewFiles, setHasNewFiles, newFilesCount } = useAnalyzedDirectoryStore()
    const { computed_limits } = useTierStore()
    const [licenseType, setLicenseType] = useState<string | null>(null)

    // 订阅语言变化，确保 useMemo 中缓存的翻译随语言切换更新
    const { activeLanguage } = useVoerkaI18n(i18nScope)

    // 消息轮播相关
    const config = useConfigStore(state => state.config)
    const latestNews = (config?.LATEST_NEWS as LatestNewsItem[]) || []
    const [currentNewsIndex, setCurrentNewsIndex] = useState(0)
    const [isNewsDropdownOpen, setIsNewsDropdownOpen] = useState(false)
    const newsDropdownRef = useRef<HTMLDivElement | null>(null)
    const newsTimerRef = useRef<NodeJS.Timeout | null>(null)

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
      }

      if (showDirectoryDropdown || isNewsDropdownOpen) {
        document.addEventListener('pointerdown', handleClickOutside)
      }

      return () => {
        document.removeEventListener('pointerdown', handleClickOutside)
      }
    }, [showDirectoryDropdown, isNewsDropdownOpen, onToggleDirectoryDropdown, dropdownRef])

    const isEnterprise = licenseType === 'ENTERPRISE'

    // 轮播逻辑
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

    // 当任何下拉菜单打开时，禁用拖拽，以便点击事件可以正常传播到关闭逻辑
    const isAnyDropdownOpen = showDirectoryDropdown || isSearchDropdownOpen || isNewsDropdownOpen

    return (
      <header
        className="relative z-50 flex-shrink-0 bg-background/98 dark:bg-background/98 backdrop-blur-md border-b border-border/60 dark:border-border/40 grid grid-cols-[auto_1fr_auto] grid-rows-[auto_auto] items-center px-4 py-3 shadow-sm gap-y-2 gap-x-4 xl:flex xl:flex-wrap xl:grid-cols-none xl:grid-rows-none xl:items-center xl:justify-between xl:py-2.5 xl:gap-4"
        style={{ WebkitAppRegion: isAnyDropdownOpen ? 'no-drag' : 'drag' } as React.CSSProperties}
      >
        {/* Dropdown Overlays */}
        {(showDirectoryDropdown || isSearchDropdownOpen || isNewsDropdownOpen) && (
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

        {/* Left Side: Logo and Title */}
        <div
          className="flex items-center space-x-2 flex-shrink-0 order-1 xl:order-1 xl:col-span-none xl:row-span-none"
          style={{ gridColumn: '1', gridRow: '1' }}
        >
          <img
            src={logoIcon}
            width={24}
            height={24}
            className="object-contain flex-shrink-0"
            alt="logo"
          />
          <span className="text-base font-semibold text-foreground dark:text-foreground block xl:hidden 2xl:inline-block whitespace-nowrap">
            {t('萤核智能文件夹')}
          </span>
        </div>

        {/* Unified View Control Hub Container */}
        <div
          className="w-full xl:w-auto flex justify-start min-w-[700px] order-2 xl:order-2 xl:flex-1 xl:mx-4 mt-1 xl:mt-0 xl:min-w-[700px]"
          style={{ gridColumn: '1 / -1', gridRow: '2' }}
        >
          <div
            className="flex items-center rounded-full min-w-[700px] transition-all duration-300 relative z-[95]
          bg-muted/50 dark:bg-white/[0.04]
          border border-border/50 dark:border-white/[0.08]
          shadow-[inset_0_1px_0_hsl(0_0%_100%/0.06),_0_1px_3px_hsl(0_0%_0%/0.08)]
          dark:shadow-[inset_0_1px_0_hsl(0_0%_100%/0.04),_0_1px_3px_hsl(0_0%_0%/0.2)]
          p-1 gap-0.5"
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
                onClick={() => onToggleDirectoryDropdown()}
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
                  navigate(path)
                }}
              />
            </div>
          </div>
        </div>

        {/* News Carousel */}
        {!isEnterprise && (
          <div
            className="relative flex items-center text-xs text-primary transition-all duration-500 min-w-0 flex-shrink-0 max-w-[600px] xl:max-w-[200px] 2xl:max-w-[600px] order-3 xl:order-3 w-fit"
            style={{ gridColumn: '2', gridRow: '1', justifySelf: 'start' }}
            ref={newsDropdownRef}
            onPointerDown={e => e.stopPropagation()}
          >
            {latestNews.length > 0 ? (
              <>
                <div
                  className={cn(
                    'flex items-center gap-1.5 px-2.5 py-1.5 rounded-full animate-in fade-in duration-500 cursor-pointer shadow-sm w-full min-w-0 overflow-hidden',
                    getLevelStyles(latestNews[currentNewsIndex]?.level).bg,
                    getLevelStyles(latestNews[currentNewsIndex]?.level).text,
                    isNewsDropdownOpen
                      ? cn('ring-1', getLevelStyles(latestNews[currentNewsIndex]?.level).ring)
                      : ''
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
                    className="flex-1 truncate 2xl:truncate-none font-medium min-w-0"
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
                    className="absolute top-full left-0 mt-2 bg-popover border border-border rounded-md shadow-lg z-[100] py-1 min-w-[280px]"
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

        {/* Right Side: Controls */}
        <div
          className="flex items-center space-x-3 flex-shrink-0 order-3 xl:order-4 relative z-[95]"
          style={{ gridColumn: '3', gridRow: '1' }}
        >
          <div
            className="flex-grow xl:flex-grow-0 xl:w-0 self-stretch"
            style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
          />

          {/* User Avatar Menu */}
          <div style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
            <UserAvatarMenu />
          </div>

          {/* Window Controls */}
          <div
            className="flex items-center space-x-1 pl-2 border-l border-border/40 dark:border-white/10 ml-1"
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
      </header>
    )
  }
)
