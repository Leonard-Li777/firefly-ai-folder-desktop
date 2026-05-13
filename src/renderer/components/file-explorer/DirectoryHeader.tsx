import { toast } from '../common/Toast';
import { openExternalLink } from '../../lib/external-link'
import { LogCategory, logger } from '@yonuc/shared'
import { MaterialIcon, cn } from '../../lib/utils'
import React, { useEffect, useRef, useState } from 'react'

import { LatestNewsItem } from '@yonuc/types/config-types'
import { SearchBar } from '../common/SearchBar'
import { SettingsButton } from '../settings/settings-button'
import { WorkspaceDirectory } from '@yonuc/types'
import { t } from '@app/languages'
import { useConfigStore } from '../../stores/config-store'
import { useVirtualDirectoryStore } from '../../stores/virtual-directory-store'
import { useNavigate } from 'react-router-dom'
import { Badge } from '../ui/badge'
import { PersistentTooltip } from '../common/PersistentTooltip'
// @ts-ignore - icon.ico 文件可能不存在
import logoIcon from '../../assets/icon.ico'

interface DirectoryHeaderProps {
  currentWorkspaceDirectory: WorkspaceDirectory | null
  workspaceDirectories: WorkspaceDirectory[]
  showDirectoryDropdown: boolean
  isRealDirectory: boolean // true for real directory, false for virtual directory
  onToggleDirectoryDropdown: () => void
  onSelectWorkspaceDirectory: (directory: WorkspaceDirectory) => Promise<void>
  onAddWorkspaceDirectory: (type?: 'SPEEDY' | 'PRIVATE') => Promise<void>
  dropdownRef: React.RefObject<HTMLDivElement | null>
  onSearch: (keyword: string) => void // 搜索回调
}

export const DirectoryHeader: React.FC<DirectoryHeaderProps> = ({
  currentWorkspaceDirectory,
  workspaceDirectories,
  showDirectoryDropdown,
  isRealDirectory,
  onToggleDirectoryDropdown,
  onSelectWorkspaceDirectory,
  onAddWorkspaceDirectory,
  dropdownRef,
  onSearch
}) => {
  const navigate = useNavigate()
  const [isMaximized, setIsMaximized] = useState(false)
  const [isSearchDropdownOpen, setIsSearchDropdownOpen] = useState(false)

  const { hasNewFiles, setHasNewFiles, newFilesCount } = useVirtualDirectoryStore()
  const [licenseType, setLicenseType] = useState<string | null>(null)

  // 消息轮播相关
  const config = useConfigStore(state => state.config)
  const latestNews = (config?.LATEST_NEWS as LatestNewsItem[]) || []
  const [currentNewsIndex, setCurrentNewsIndex] = useState(0)
  const [isNewsDropdownOpen, setIsNewsDropdownOpen] = useState(false)
  const newsDropdownRef = useRef<HTMLDivElement | null>(null)
  const newsTimerRef = useRef<NodeJS.Timeout | null>(null)

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

  // 处理消息下拉菜单点击外部关闭
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (newsDropdownRef.current && !newsDropdownRef.current.contains(event.target as Node)) {
        setIsNewsDropdownOpen(false)
      }
    }

    if (isNewsDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isNewsDropdownOpen])

  const isEnterprise = licenseType === 'ENTERPRISE_OFFLINE'

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

  const handleNewsClick = (url: string) => {
    if (url) {
      openExternalLink(url, { errorTitle: t('无法打开链接') });
      setIsNewsDropdownOpen(false);
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
      className="relative flex-shrink-0 dark:bg-muted bg-linear-to-b from-0% from-black/10 via-10% via-black/30 to-90%  to-transparent border-b border-border flex items-center justify-between px-4 py-4"
      style={{ WebkitAppRegion: isAnyDropdownOpen ? 'no-drag' : 'drag' } as React.CSSProperties}
    >
      {/* Window Controls - positioned with z-index to be on top */}
      <div
        className="absolute top-5 right-2 flex items-center space-x-1 z-50"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <button
          onClick={handleMinimize}
          className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer"
          title={t('最小化')}
        >
          <MaterialIcon icon="minimize" className="text-muted-foreground text-lg leading-none" />
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

      {/* Left Side: Logo and Notification */}
      <div className="flex items-center space-x-4 min-w-0 flex-1 overflow-visible">
        {/* Logo and Title */}
        <div className="flex items-center space-x-2 flex-shrink-0">
          <img src={logoIcon} className="w-6 h-6 object-contain flex-shrink-0" alt="logo" />
          <span className="text-base font-semibold text-foreground dark:text-foreground">
            {t('萤核智能文件夹')}
          </span>
        </div>

        {/* System Notification / News Carousel */}
        {!isEnterprise && (
          <div 
            className="relative flex items-center space-x-2 text-xs px-3 py-1 text-primary transition-all duration-500 min-w-0 overflow-visible"
            ref={newsDropdownRef}
          >
            {latestNews.length > 0 ? (
              <>
                <div
                  className={cn(
                    'flex items-center gap-2 bg-primary/10 px-2 py-0.5 rounded-full animate-in fade-in slide-in-from-left-1 duration-500 min-w-0 overflow-hidden cursor-pointer hover:bg-primary/20',
                    isNewsDropdownOpen ? 'bg-primary/20 ring-1 ring-primary/30' : ''
                  )}
                  style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                  onClick={() => setIsNewsDropdownOpen(!isNewsDropdownOpen)}
                >
                  <span className="flex h-1.5 w-1.5 rounded-full bg-primary animate-pulse flex-shrink-0" />
                  <span className="flex-1 min-w-0 truncate" title={latestNews[currentNewsIndex]?.text}>
                    {latestNews[currentNewsIndex]?.text}
                  </span>
                  <MaterialIcon 
                    icon={isNewsDropdownOpen ? 'arrow_drop_up' : 'arrow_drop_down'} 
                    className="text-sm opacity-60" 
                  />
                </div>

                {/* News Dropdown */}
                {isNewsDropdownOpen && (
                  <div 
                    className="absolute top-full left-0 mt-2 bg-popover border border-border rounded-md shadow-lg z-50 py-1"
                    style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                  >
                    <div className="px-3 py-1.5 text-[10px] font-semibold text-muted-foreground border-b border-border mb-1 uppercase tracking-wider">
                      {t('最新动态')}
                    </div>
                    <div className="max-h-60 overflow-y-auto">
                      {latestNews.map((news, index) => (
                        <button
                          key={index}
                          className={cn(
                            'w-full flex items-start gap-3 px-3 py-2.5 text-left transition-colors cursor-pointer group',
                            'hover:bg-accent hover:text-accent-foreground border-b border-border/50 last:border-none'
                          )}
                          onClick={() => handleNewsClick(news.url)}
                        >
                          <span className={cn(
                            "flex h-1.5 w-1.5 rounded-full mt-1.5 flex-shrink-0",
                            index === currentNewsIndex ? "bg-primary" : "bg-muted-foreground/30 group-hover:bg-primary/50"
                          )} />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium leading-tight mb-0.5">
                              {news.text}
                            </div>
                            {news.url && (
                              <div className="text-[10px] text-muted-foreground truncate opacity-60">
                                {news.url}
                              </div>
                            )}
                          </div>
                          {news.url && (
                            <MaterialIcon icon="open_in_new" className="text-sm text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity self-center" />
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <span className="truncate">{t('AI 摘要功能已上线!')}</span>
            )}
          </div>
        )}
      </div>

      {/* Right Side: Controls */}
      <div className="flex items-center space-x-4 flex-shrink-0 justify-end mr-28">
        {/* Directory Selector */}
        <div
          className="relative flex-shrink-0"
          ref={dropdownRef}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <button
            className="flex items-center space-x-2 px-3 py-2 hover:bg-accent hover:text-accent-foreground hover:border-border rounded-md transition-all duration-200 hover:shadow-sm text-foreground dark:text-foreground cursor-pointer"
            onClick={onToggleDirectoryDropdown}
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
              className="text-muted-foreground dark:text-muted-foreground text-lg"
            />
            <span className="text-sm font-medium truncate max-w-[200px]">
              {t('工作目录: {name}', { name: currentWorkspaceDirectory?.name || t('未选择') })}
            </span>
            <MaterialIcon
              icon="arrow_drop_down"
              className="text-muted-foreground dark:text-muted-foreground"
            />
          </button>

          {/* Directory Dropdown */}
          {showDirectoryDropdown && (
            <div className="absolute top-full left-0 mt-1 w-80 bg-popover border border-border rounded-md shadow-lg z-50">
              <div className="max-h-60 overflow-y-auto">
                {workspaceDirectories.length === 0 ? (
                  <div className="p-4 text-center text-sm text-muted-foreground">
                    {t('暂无工作目录')}
                  </div>
                ) : (
                  workspaceDirectories.map(directory => (
                    <button
                      key={directory.path}
                      className={cn(
                        'w-full flex items-center space-x-3 px-3 py-2 text-sm text-left transition-colors cursor-pointer',
                        currentWorkspaceDirectory?.path === directory.path
                          ? 'bg-primary/10 text-primary'
                          : 'text-foreground hover:bg-accent hover:text-accent-foreground'
                      )}
                      onClick={() => onSelectWorkspaceDirectory(directory)}
                      title={t('切换到工作目录: {path}', { path: directory.path })}
                    >
                      <MaterialIcon
                        icon={
                          directory.type === 'SPEEDY'
                            ? 'rocket_launch'
                            : directory.type === 'PRIVATE'
                              ? 'lock'
                              : 'folder'
                        }
                        className={cn(
                          'text-sm',
                          currentWorkspaceDirectory?.path === directory.path
                            ? 'text-primary'
                            : 'text-muted-foreground'
                        )}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate">
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
                      {currentWorkspaceDirectory?.path === directory.path && (
                        <MaterialIcon icon="check" className="text-primary text-base" />
                      )}
                    </button>
                  ))
                )}
              </div>
              <div className="p-2 border-b border-border space-y-1">
                <button
                  className={cn(
                    'w-full flex items-center space-x-2 px-3 py-2 text-sm rounded-md transition-colors',
                    isEnterprise
                      ? 'text-muted-foreground/50 cursor-not-allowed opacity-60'
                      : 'text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-900/20 cursor-pointer'
                  )}
                  onClick={() => !isEnterprise && onAddWorkspaceDirectory('SPEEDY')}
                  title={isEnterprise ? t('企业版暂不支持极速目录') : t('创建极速目录（推荐）')}
                  disabled={isEnterprise}
                >
                  <MaterialIcon icon="rocket_launch" className="text-sm" />
                  <span>{t('创建极速目录')}</span>
                </button>
                <button
                  className="w-full flex items-center space-x-2 px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800 rounded-md transition-colors cursor-pointer"
                  onClick={() => onAddWorkspaceDirectory('PRIVATE')}
                  title={t('创建私有目录')}
                >
                  <MaterialIcon icon="lock" className="text-sm" />
                  <span>{t('创建私有目录')}</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Real/Virtual Toggle */}
        <div
          className="flex bg-muted border border-border rounded-md shadow-sm flex-shrink-0"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <button
            className={cn(
              'px-4 py-2 text-sm font-medium transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 cursor-pointer rounded-l-md',
              isRealDirectory
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
            )}
            onClick={() => navigate('/real-directory')}
            title={t('切换到真实文件系统视图')}
          >
            {t('真实目录')}
          </button>
          <button
            className={cn(
              'px-4 py-2 text-sm font-medium transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 cursor-pointer relative rounded-r-md',
              !isRealDirectory
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
            )}
            onClick={() => {
              setHasNewFiles(false)
              navigate('/virtual-directory')
            }}
            title={t('切换到AI智能分类视图')}
          >
            <PersistentTooltip
              id="header_virtual_dir_hint"
              content={t('可以切换到虚拟目录查看分析后的文件')}
              visible={hasNewFiles && isRealDirectory}
              position="bottom"
            >
              {t('虚拟目录')}
            </PersistentTooltip>
            {hasNewFiles && isRealDirectory && (
              <Badge 
                className="absolute -top-2 -right-2 px-1.5 py-0.5 min-w-[1.25rem] h-5 flex items-center justify-center bg-orange-500 hover:bg-orange-600 text-white text-[10px] font-bold border-none shadow-[0_0_10px_rgba(249,115,22,0.6)] animate-pulse cursor-pointer z-10"
                onClick={(e) => {
                  e.stopPropagation();
                  setHasNewFiles(false);
                }}
              >
                {newFilesCount > 99 ? '99+' : newFilesCount}
              </Badge>
            )}
          </button>
        </div>

        {/* Search Bar */}
        <div
          className="flex-1 max-w-xs min-w-[200px]"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <SearchBar
            type={isRealDirectory ? 'real-directory' : 'virtual-directory'}
            placeholder={
              isRealDirectory
                ? t('搜索文件、标签、作者或内容...')
                : t('搜索标签、描述、智能文件名...')
            }
            onSearch={onSearch}
            className="w-full"
            onToggleSuggestions={setIsSearchDropdownOpen}
          />
        </div>

        {/* Settings Button */}
        <div style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <SettingsButton
            variant="ghost"
            className="text-sm hover:bg-accent hover:text-accent-foreground hover:shadow-sm text-muted-foreground transition-all duration-200 whitespace-nowrap cursor-pointer"
          >
            <MaterialIcon icon="settings" className="text-sm mr-1" />
            {t('设置')}
          </SettingsButton>
        </div>
      </div>
    </header>
  )
}
