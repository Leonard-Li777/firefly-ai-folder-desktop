import React, { useState } from 'react'
import { createPortal } from 'react-dom'
import { t } from '@app/languages'
import { MaterialIcon, cn } from '../../../../lib/utils'
import { VirtualDirectory } from '@firefly/types'
import { useNavigate } from 'react-router-dom'

interface VirtualDirectoryTabsProps {
  virtualDirectories: VirtualDirectory[]
  selectedId: number | null
  setSelectedId: (id: number | null) => void
  sidebarCollapsed: boolean
  setSidebarCollapsed: (collapsed: boolean) => void
  entitlements: any[] | null
  vdirSlotLimit: number
  computed_limits: any
  setRenamingId: (id: number | null) => void
  handleRegenerate: (vd: VirtualDirectory) => void
  handleDelete: (id: number) => void
}

export const VirtualDirectoryTabs: React.FC<VirtualDirectoryTabsProps> = ({
  virtualDirectories,
  selectedId,
  setSelectedId,
  sidebarCollapsed,
  setSidebarCollapsed,
  entitlements,
  vdirSlotLimit,
  computed_limits,
  setRenamingId,
  handleRegenerate,
  handleDelete
}) => {
  const navigate = useNavigate()
  const [activeTabMenu, setActiveTabMenu] = useState<number | null>(null)
  const [tabMenuPosition, setTabMenuPosition] = useState<{ top: number; left: number } | null>(null)

  return (
    <div className="flex flex-col h-full border-r bg-muted/10 overflow-y-auto no-scrollbar">
      {/* 展开/收起切换按钮 */}
      <button
        onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
        className={cn(
          'flex items-center justify-center w-full h-[44px] text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-all border-b border-border/50 shrink-0',
          sidebarCollapsed ? 'px-0' : 'px-4 justify-end'
        )}
        title={sidebarCollapsed ? t('展开侧边栏') : t('收起侧边栏')}
      >
        <MaterialIcon
          icon={sidebarCollapsed ? 'chevron_right' : 'chevron_left'}
          className="text-lg"
        />
      </button>

      {/* Tab 列表 */}
      <div className={cn('flex flex-col flex-1', sidebarCollapsed ? 'items-center' : '')}>
        {virtualDirectories.map((vd, index) => {
          const hasVdirAccess = entitlements?.some(
            (e: any) =>
              e.type === 'access_vdir' && String(e.metadata?.virtual_directory_id) === String(vd.id)
          )
          const unprotectedBefore = virtualDirectories
            .slice(0, index)
            .filter(
              v =>
                !entitlements?.some(
                  (e: any) =>
                    e.type === 'access_vdir' &&
                    String(e.metadata?.virtual_directory_id) === String(v.id)
                )
            ).length
          const isExpired = !hasVdirAccess && unprotectedBefore >= vdirSlotLimit

          return (
            <React.Fragment key={vd.id}>
              <div className="group relative w-full">
                {selectedId === vd.id && (
                  <div className="absolute left-0 top-0 bottom-0 w-1 bg-primary z-10" />
                )}
                <div
                  onClick={() => setSelectedId(vd.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={e => {
                    if (e.key === 'Enter') setSelectedId(vd.id)
                  }}
                  className={cn(
                    'flex items-center min-w-0 text-left transition-all cursor-pointer border-b border-border/40 h-[44px]',
                    sidebarCollapsed ? 'justify-center px-0 w-full' : 'w-full gap-2 px-4 pr-10',
                    isExpired && 'opacity-40',
                    selectedId === vd.id
                      ? 'bg-primary/15 text-primary font-bold shadow-xs'
                      : 'text-muted-foreground hover:bg-muted/80 hover:text-foreground'
                  )}
                  title={
                    isExpired ? t('已超出虚拟目录插槽限制') : sidebarCollapsed ? vd.name : undefined
                  }
                >
                  <MaterialIcon
                    icon={isExpired ? 'lock' : vd.icon || 'folder_special'}
                    className={cn(
                      'shrink-0 transition-colors',
                      sidebarCollapsed ? 'text-xl' : 'text-sm',
                      selectedId === vd.id ? 'text-primary' : 'text-muted-foreground/70'
                    )}
                  />
                  {!sidebarCollapsed && (
                    <div className="flex-1 flex items-center min-w-0 gap-1">
                      <span className="truncate text-sm">{vd.name}</span>
                    </div>
                  )}
                </div>
                {!sidebarCollapsed && (
                  <button
                    className={cn(
                      'absolute right-3 top-1/2 -translate-y-1/2 p-1 pb-0 text-foreground rounded-md bg-muted hover:bg-background shrink-0 hover:border hover:border-foreground/50 transition-opacity duration-200 z-20',
                      activeTabMenu === vd.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                    )}
                    onClick={e => {
                      e.stopPropagation()
                      const rect = e.currentTarget.getBoundingClientRect()
                      setTabMenuPosition({
                        top: rect.bottom + 4,
                        left: rect.right - 192
                      })
                      setActiveTabMenu(activeTabMenu === vd.id ? null : vd.id)
                    }}
                  >
                    <MaterialIcon
                      icon="expand_more"
                      className="text-base text-muted-foreground hover:text-foreground"
                    />
                  </button>
                )}
              </div>

              {/* Tab Dropdown Menu */}
              {activeTabMenu === vd.id &&
                tabMenuPosition &&
                createPortal(
                  <>
                    <div
                      className="fixed inset-0 z-40 bg-transparent"
                      onMouseDown={e => {
                        e.stopPropagation()
                        setActiveTabMenu(null)
                      }}
                    />
                    <div
                      className="fixed w-48 bg-background border border-border rounded-xl shadow-xl z-50 py-1 animate-in fade-in zoom-in-95 duration-100"
                      style={{
                        top: `${tabMenuPosition.top}px`,
                        left: `${tabMenuPosition.left}px`
                      }}
                    >
                      <button
                        className="w-full flex items-center px-3 py-2 text-sm hover:bg-accent transition-colors text-emerald-600 dark:text-emerald-400 font-medium"
                        onClick={() => {
                          setActiveTabMenu(null)
                          navigate(`/organize?vdId=${vd.id}&action=continue`)
                        }}
                      >
                        <MaterialIcon icon="play_arrow" className="mr-2 text-sm text-emerald-500" />
                        {t('继续整理')}
                      </button>
                      <button
                        className="w-full flex items-center px-3 py-2 text-sm hover:bg-accent transition-colors text-primary font-medium"
                        onClick={() => {
                          setActiveTabMenu(null)
                          navigate(`/organize?vdId=${vd.id}&mode=incremental-organize`)
                        }}
                      >
                        <MaterialIcon icon="library_add" className="mr-2 text-sm text-primary" />
                        {t('增量整理')}
                      </button>
                      <button
                        className="w-full flex items-center px-3 py-2 text-sm hover:bg-accent transition-colors"
                        onClick={() => {
                          setActiveTabMenu(null)
                          setRenamingId(vd.id)
                        }}
                      >
                        <MaterialIcon icon="edit" className="mr-2 text-sm text-muted-foreground" />
                        {t('重命名')}
                      </button>

                      <button
                        className="w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-accent transition-colors"
                        onClick={() => {
                          setActiveTabMenu(null)
                          handleRegenerate(vd)
                        }}
                      >
                        <span className="flex items-center">
                          <MaterialIcon
                            icon="refresh"
                            className="mr-2 text-sm text-muted-foreground"
                          />
                          {t('重新生成')}
                        </span>
                        {((computed_limits?.regenerate_vdir_cost as number) ?? 0) > 0 && (
                          <span className="text-[11px] text-amber-600 font-medium">
                            {(computed_limits?.regenerate_vdir_cost as number) ?? 0} {t('萤火')}
                          </span>
                        )}
                      </button>
                      <div className="my-1 border-t border-border/50" />
                      <button
                        className="w-full flex items-center px-3 py-2 text-sm hover:bg-destructive/10 text-destructive transition-colors"
                        onClick={() => {
                          setActiveTabMenu(null)
                          handleDelete(vd.id)
                        }}
                      >
                        <MaterialIcon icon="delete" className="mr-2 text-sm" />
                        {t('删除')}
                      </button>
                    </div>
                  </>,
                  document.body
                )}
            </React.Fragment>
          )
        })}
        {/* 创建虚拟目录 (+) */}
        <button
          onClick={() => {
            navigate('/analyzed-directory', {
              state: { startInOrganizeMode: true }
            })
          }}
          className={cn(
            'flex items-center justify-center transition-colors',
            'text-primary hover:bg-primary/15',
            sidebarCollapsed
              ? 'py-2 w-full text-xl'
              : 'w-full gap-2 px-4 py-1.5 text-lg bg-primary/5'
          )}
          title={t('创建虚拟目录')}
        >
          <MaterialIcon icon="add" className="text-xl font-bold" />
        </button>
      </div>
    </div>
  )
}
