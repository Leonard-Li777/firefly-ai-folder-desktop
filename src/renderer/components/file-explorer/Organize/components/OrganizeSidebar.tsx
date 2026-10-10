import React, { useState } from 'react'
import { Stage } from '../types'
import { MaterialIcon, cn } from '../../../../lib/utils'
import { t } from '@app/languages'
import { useOrganizeStore, OrganizeBranch } from '../../../../stores/organize-store'

interface OrganizeSidebarProps {
  currentStage: Stage
  onSelectStage: (stage: Stage) => void
}

interface NavItem {
  id: string
  targetStage: Stage
  label: string
  icon: string
  description: string
  isHero?: boolean
  category?: 'home' | 'main' | 'satellite'
  isActive: (stage: Stage, activeBranch: OrganizeBranch) => boolean
}

export const OrganizeSidebar: React.FC<OrganizeSidebarProps> = ({
  currentStage,
  onSelectStage
}) => {
  const activeBranch = useOrganizeStore(s => s.activeBranch) || 'organize'

  // 从 localStorage 恢复折叠状态，默认折叠 (true) 保持工作台宽阔
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem('organize_sidebar_collapsed')
      return stored !== null ? stored === 'true' : true
    } catch {
      return true
    }
  })

  const toggleCollapsed = () => {
    const next = !collapsed
    setCollapsed(next)
    try {
      localStorage.setItem('organize_sidebar_collapsed', String(next))
    } catch {
      // 忽略存储异常
    }
  }

  const navItems: NavItem[] = [
    {
      id: 'home',
      targetStage: 'root-mode-select',
      label: t('整理首页'),
      icon: 'home',
      description: t('返回功能选择与流程全景概览'),
      category: 'home',
      isActive: (stage: Stage) => stage === 'root-mode-select'
    },
    {
      id: 'organize',
      targetStage: 'mode-select',
      label: t('批量整理'),
      icon: 'auto_fix_high',
      description: t('AI 目录规划与归档核心主流程'),
      isHero: true,
      category: 'main',
      isActive: (stage: Stage, branch: OrganizeBranch) =>
        branch === 'organize' && stage !== 'root-mode-select'
    },
    {
      id: 'batch-rename',
      targetStage: 'batch-rename',
      label: t('批量更名'),
      icon: 'drive_file_rename_outline',
      description: t('规范智能文件名与属性模板重命名'),
      category: 'satellite',
      isActive: (stage: Stage) => stage === 'batch-rename'
    },
    {
      id: 'batch-tag',
      targetStage: 'batch-tag',
      label: t('批量标签'),
      icon: 'label',
      description: t('批量点选增加或删除文件维度标签'),
      category: 'satellite',
      isActive: (stage: Stage) => stage === 'batch-tag'
    },
    {
      id: 'batch-duplicate',
      targetStage: 'batch-duplicate',
      label: t('批量清理'),
      icon: 'cleaning_services',
      description: t('双轨识别重复与冗余文件，回收站安全保护'),
      category: 'satellite',
      isActive: (stage: Stage) => stage === 'batch-duplicate'
    }
  ]

  return (
    <aside
      className={cn(
        'flex flex-col h-full border-r bg-muted/10 shrink-0 transition-all duration-200 z-10 select-none overflow-y-auto no-scrollbar',
        collapsed ? 'w-[52px]' : 'w-[164px]'
      )}
      aria-label={t('批量功能导航')}
    >
      {/* 顶部折叠/展开切换按钮 */}
      <button
        onClick={toggleCollapsed}
        className={cn(
          'flex items-center justify-center w-full h-[44px] text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-all border-b border-border/40 shrink-0 cursor-pointer',
          collapsed ? 'px-0' : 'px-3 justify-between'
        )}
        title={collapsed ? t('展开功能侧边栏') : t('收起功能侧边栏')}
      >
        {!collapsed && (
          <span className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider pl-1 truncate">
            {t('功能导航')}
          </span>
        )}
        <MaterialIcon
          icon={collapsed ? 'chevron_right' : 'chevron_left'}
          className="text-base shrink-0"
        />
      </button>

      {/* 功能项垂直列表 */}
      <div className={cn('flex flex-col flex-1 py-1', collapsed ? 'items-center' : '')}>
        {navItems.map((item, index) => {
          const active = item.isActive(currentStage, activeBranch)
          const isNextSatellite = item.category === 'satellite' && navItems[index - 1]?.category !== 'satellite'
          const isNextMain = item.category === 'main' && navItems[index - 1]?.category === 'home'

          return (
            <React.Fragment key={item.id}>
              {/* 分组分割线与小标题 */}
              {isNextMain && (
                <div className={cn('w-full my-1', collapsed ? 'px-2' : 'px-3')}>
                  <div className="w-full h-px bg-border/40" />
                </div>
              )}

              {isNextSatellite && (
                <div className={cn('w-full mt-2 mb-1', collapsed ? 'px-2' : 'px-3')}>
                  <div className="w-full h-px bg-border/40 mb-1" />
                  {!collapsed && (
                    <div className="text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-wider py-0.5 truncate">
                      {t('前置预处理')}
                    </div>
                  )}
                </div>
              )}

              <div className="group relative w-full">
                {/* 选中态高亮指示左边条 */}
                {active && (
                  <div className="absolute left-0 top-0 bottom-0 w-1 bg-primary z-10 rounded-r-xs" />
                )}

                <button
                  type="button"
                  onClick={() => onSelectStage(item.targetStage)}
                  className={cn(
                    'flex items-center min-w-0 text-left transition-all cursor-pointer border-b border-border/20 h-[44px] relative',
                    collapsed ? 'justify-center px-0 w-full' : 'w-full gap-2.5 px-3 pr-2',
                    active
                      ? 'bg-primary/15 text-primary font-bold shadow-xs'
                      : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground'
                  )}
                  title={
                    collapsed
                      ? `${item.label} · ${item.description}`
                      : item.description
                  }
                >
                  {/* 图标与微光 */}
                  <div className="relative shrink-0 flex items-center justify-center">
                    <MaterialIcon
                      icon={item.icon}
                      className={cn(
                        'text-lg shrink-0 transition-transform duration-200 group-hover:scale-110',
                        active
                          ? 'text-primary'
                          : item.isHero
                            ? 'text-purple-500 dark:text-purple-400'
                            : 'text-muted-foreground group-hover:text-foreground'
                      )}
                    />
                    {item.isHero && collapsed && (
                      <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-primary ring-2 ring-background animate-pulse" />
                    )}
                  </div>

                  {/* 展开时的文本与徽章 */}
                  {!collapsed && (
                    <div className="flex items-center justify-between min-w-0 flex-1 gap-1">
                      <span className="text-xs truncate font-medium">
                        {item.label}
                      </span>
                      {item.isHero && (
                        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-primary/15 text-primary shrink-0 border border-primary/20">
                          {t('核心')}
                        </span>
                      )}
                    </div>
                  )}
                </button>
              </div>
            </React.Fragment>
          )
        })}
      </div>
    </aside>
  )
}
