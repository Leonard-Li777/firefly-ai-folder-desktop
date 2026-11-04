import React, { useState, useEffect, useMemo, memo } from 'react'
import {
  WorkspaceDirectory,
  WorkspaceConfig,
  parseWorkspaceConfig,
  HardwareInfo
} from '@firefly/types'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { useSettingsStore } from '../../stores/settings-store'
import { useVirtualDirectoryStore } from '../../stores/virtual-directory-store'
import { MaterialIcon, cn } from '../../lib/utils'
import { t } from '@app/languages'
import {
  FolderOpen,
  Sliders,
  Filter,
  HardDrive,
  Sparkles,
  ChevronRight,
  RotateCcw,
  CheckCircle2,
  Clock
} from 'lucide-react'

import { WorkspaceSetupWizard } from './workspace/WorkspaceSetupWizard'
import { BasicAIEngineTab } from './workspace/BasicAIEngineTab'
import { ContentExtractionTab } from './workspace/ContentExtractionTab'
import { WorkspaceIgnoreRulesTab } from './workspace/WorkspaceIgnoreRulesTab'
import { WorkspaceMaintenanceTab } from './workspace/WorkspaceMaintenanceTab'

type WorkspaceTabId = 'basic_ai_engine' | 'content_extraction' | 'ignore_rules' | 'maintenance'

interface WorkspaceTabInfo {
  id: WorkspaceTabId
  name: string
  icon: string
  description: string
}

const MemoizedBasicAIEngineTab = memo(BasicAIEngineTab)
const MemoizedContentExtractionTab = memo(ContentExtractionTab)
const MemoizedWorkspaceIgnoreRulesTab = memo(WorkspaceIgnoreRulesTab)
const MemoizedWorkspaceMaintenanceTab = memo(WorkspaceMaintenanceTab)

/**
 * 工作目录独立设置对话框 (WorkspaceSettingsDialog)
 *
 * 核心架构 (TASK-07 ~ TASK-11)：
 * 1. 物理层解耦：完全独立于系统设置，专属于具体工作目录的配置；
 * 2. 顶部工作区下拉切换：支持在所有已添加的工作目录之间自由切换（默认选中当前活动目录）；
 * 3. 极简向导流转：
 *    - 当工作区为 pending 时，首先进入 WorkspaceSetupWizard；
 *    - 点击「完成并开始分析」自动持久化 ready 并关闭弹窗；
 *    - 点击「深度自定义设置 ➔」就地切换至 3-Tab 高级模式；
 * 4. 常态 3-Tab 高级模式：
 *    - 1. AI分析与多媒体策略 (TaskEngineSettings)
 *    - 2. AI分析忽略规则 (WorkspaceIgnoreRulesTab)
 *    - 3. 目录维护与安全重置 (WorkspaceMaintenanceTab)
 */
export const WorkspaceSettingsDialog: React.FC = () => {
  const isOpen = useSettingsStore(s => s.isWorkspaceSettingsOpen)
  const closeSettings = useSettingsStore(s => s.closeWorkspaceSettings)
  const targetWorkspaceId = useSettingsStore(s => s.targetWorkspaceId)

  // 从 virtual directory store 获取工作目录列表与当前活动目录
  const workspaceDirectories = useVirtualDirectoryStore(s => s.workspaceDirectories)
  const currentWorkspace = useVirtualDirectoryStore(s => s.currentWorkspaceDirectory)
  const setWorkspaceDirectories = useVirtualDirectoryStore(s => s.setWorkspaceDirectories)

  // 当前正在查看与编辑的工作区 ID
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<number | null>(null)
  const [activeTab, setActiveTab] = useState<WorkspaceTabId>('basic_ai_engine')
  const [isManualWizardMode, setIsManualWizardMode] = useState<boolean>(false)
  const [hardwareInfo, setHardwareInfo] = useState<HardwareInfo | null>(null)
  const [visitedTabs, setVisitedTabs] = useState<Set<WorkspaceTabId>>(
    () => new Set(['basic_ai_engine'])
  )

  // 1. 初始化或同步选中的工作区 ID
  useEffect(() => {
    if (isOpen) {
      if (targetWorkspaceId != null) {
        setSelectedWorkspaceId(targetWorkspaceId)
      } else if (currentWorkspace?.id != null) {
        setSelectedWorkspaceId(currentWorkspace.id)
      } else if (workspaceDirectories.length > 0) {
        setSelectedWorkspaceId(workspaceDirectories[0].id ?? null)
      }
      setIsManualWizardMode(false)
    }
  }, [isOpen, targetWorkspaceId, currentWorkspace?.id, workspaceDirectories])

  // 2. 加载硬件信息
  useEffect(() => {
    if (isOpen && window.electronAPI?.getHardwareInfo) {
      window.electronAPI
        .getHardwareInfo()
        .then(hw => setHardwareInfo(hw || null))
        .catch(() => setHardwareInfo(null))
    }
  }, [isOpen])

  // 记录访问过的 Tab 以实现 Keep-Alive
  useEffect(() => {
    setVisitedTabs(prev => {
      if (prev.has(activeTab)) return prev
      const next = new Set(prev)
      next.add(activeTab)
      return next
    })
  }, [activeTab])

  // 当前选中的 Workspace 实体
  const activeWorkspace = useMemo<WorkspaceDirectory | null>(() => {
    if (!selectedWorkspaceId) return currentWorkspace || workspaceDirectories[0] || null
    return workspaceDirectories.find(w => w.id === selectedWorkspaceId) || currentWorkspace || null
  }, [selectedWorkspaceId, workspaceDirectories, currentWorkspace])

  // 当前选中的工作区配置状态
  const parsedConfig = useMemo<WorkspaceConfig>(() => {
    if (!activeWorkspace) return { schemaVersion: 1, status: 'pending' }
    return parseWorkspaceConfig(activeWorkspace.workspace_config)
  }, [activeWorkspace?.workspace_config])

  // 判断是否应该展示设置向导
  const isPending = parsedConfig.status === 'pending'
  const showWizard = isPending || isManualWizardMode

  // 刷新工作区列表数据
  const refreshWorkspaceData = async () => {
    try {
      if (window.electronAPI?.getAllWorkspaceDirectories) {
        const dirs = await window.electronAPI.getAllWorkspaceDirectories()
        if (dirs) {
          setWorkspaceDirectories(dirs)
        }
      }
    } catch (err) {
      console.warn('[WorkspaceSettingsDialog] 刷新工作目录失败:', err)
    }
  }

  // 4-Tab 完整还原定义 (基础AI引擎、文件内容萃取、忽略规则、目录维护)
  const tabs: WorkspaceTabInfo[] = useMemo(
    () => [
      {
        id: 'basic_ai_engine',
        name: t('基础AI引擎'),
        icon: 'tune',
        description: t('分析模式、视频抽帧与向量底座看板')
      },
      {
        id: 'content_extraction',
        name: t('文件内容萃取'),
        icon: 'boxes',
        description: t('正文提取、OCR精度与Office封面')
      },
      {
        id: 'ignore_rules',
        name: t('AI分析忽略规则'),
        icon: 'filter',
        description: t('目录专属跳过规则与系统基线合并')
      },
      {
        id: 'maintenance',
        name: t('目录维护与安全重置'),
        icon: 'folder_open',
        description: t('重新运行向导与两段式安全重置')
      }
    ],
    []
  )

  if (!isOpen) return null

  return (
    <Dialog open={isOpen} onOpenChange={open => !open && closeSettings()}>
      <DialogContent className="max-w-5xl w-[88vw] h-[82vh] flex flex-col p-0 bg-background dark:bg-card text-foreground border-4 border-border rounded-2xl shadow-2xl transform-gpu [contain:content]">
        {/* 顶部 Header：工作区选择与状态概览 (pr-16 预留右上角绝对定位关闭按钮空间，杜绝重叠) */}
        <DialogHeader className="pl-6 pr-14 sm:pr-16 py-3.5 border-b flex-shrink-0 flex flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div className="w-9 h-9 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
              <MaterialIcon icon="folder_special" className="text-xl" />
            </div>

            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <DialogTitle className="text-lg font-bold">{t('工作目录设置')}</DialogTitle>

                {/* 状态徽标 */}
                {activeWorkspace && (
                  <span
                    className={cn(
                      'text-[11px] font-semibold px-2 py-0.5 rounded-full flex items-center gap-1 shrink-0',
                      isPending
                        ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                        : 'bg-green-500/15 text-green-600 dark:text-green-400'
                    )}
                  >
                    {isPending ? (
                      <>
                        <Clock className="w-3 h-3" />
                        <span>{t('待配置 (向导)')}</span>
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="w-3 h-3" />
                        <span>{t('已就绪')}</span>
                      </>
                    )}
                  </span>
                )}
              </div>

              <DialogDescription className="text-xs text-muted-foreground truncate mt-0.5">
                {activeWorkspace ? activeWorkspace.path : t('针对当前所选工作目录独立生效')}
              </DialogDescription>
            </div>
          </div>

          {/* 右侧：下拉切换目标工作目录 */}
          <div className="flex items-center gap-2 shrink-0">
            <Label className="text-xs text-muted-foreground hidden sm:inline">
              {t('切换工作目录:')}
            </Label>
            <Select
              value={activeWorkspace?.id != null ? String(activeWorkspace.id) : undefined}
              onValueChange={val => {
                setSelectedWorkspaceId(Number(val))
                setIsManualWizardMode(false)
              }}
            >
              <SelectTrigger className="h-8 text-xs font-semibold w-48 sm:w-56 bg-muted/30">
                <SelectValue placeholder={t('选择工作目录...')} />
              </SelectTrigger>
              <SelectContent>
                {workspaceDirectories.map(ws => (
                  <SelectItem key={ws.id} value={String(ws.id)} className="text-xs">
                    <div className="flex items-center gap-2">
                      <FolderOpen className="w-3.5 h-3.5 text-primary shrink-0" />
                      <span className="truncate">{ws.name}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </DialogHeader>

        {/* 主体内容区 */}
        <div className="flex flex-1 overflow-hidden">
          {!activeWorkspace ? (
            <div className="flex-1 flex items-center justify-center p-8 text-muted-foreground text-sm">
              {t('暂未添加任何工作目录，请先在主界面添加工作目录。')}
            </div>
          ) : showWizard ? (
            /* 1. 向导流转视图 (WorkspaceSetupWizard) */
            <div className="flex-1 flex flex-col overflow-hidden bg-background">
              <WorkspaceSetupWizard
                workspace={activeWorkspace}
                hardwareInfo={hardwareInfo}
                onFinish={async (mode, readyConfig) => {
                  await refreshWorkspaceData()
                  if (mode === 'complete') {
                    closeSettings()
                  } else {
                    // 切入深度自定义 4-Tab 模式
                    setIsManualWizardMode(false)
                    setActiveTab('basic_ai_engine')
                  }
                }}
              />
            </div>
          ) : (
            /* 2. 常态 4-Tab 高级设置视图 */
            <>
              {/* 左侧导航栏 */}
              <div className="w-56 border-r flex flex-col flex-shrink-0 bg-muted/10">
                <nav className="p-3 space-y-1.5 overflow-y-auto">
                  {tabs.map(tab => {
                    const isActive = activeTab === tab.id
                    return (
                      <Button
                        key={tab.id}
                        variant={isActive ? 'default' : 'ghost'}
                        className={cn(
                          'w-full justify-start text-left h-auto p-2.5 whitespace-break-spaces transition-all duration-200',
                          isActive && 'bg-primary text-primary-foreground shadow-sm scale-[1.01]',
                          !isActive &&
                            'hover:bg-muted/60 text-muted-foreground hover:text-foreground'
                        )}
                        onClick={() => setActiveTab(tab.id)}
                      >
                        <div className="flex items-start gap-2.5">
                          <MaterialIcon icon={tab.icon} className="text-base shrink-0 mt-0.5" />
                          <div className="flex-1 min-w-0">
                            <div className="font-semibold text-xs leading-snug">{tab.name}</div>
                            <div
                              className={cn(
                                'text-[11px] mt-0.5 line-clamp-1 opacity-80',
                                isActive ? 'text-primary-foreground' : 'text-muted-foreground'
                              )}
                            >
                              {tab.description}
                            </div>
                          </div>
                        </div>
                      </Button>
                    )
                  })}
                </nav>

                {/* 底部重新运行向导小卡片 */}
                <div className="mt-auto p-3 border-t border-border/40">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setIsManualWizardMode(true)}
                    className="w-full text-xs text-muted-foreground hover:text-foreground flex items-center justify-between p-2 h-auto"
                  >
                    <div className="flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-primary" />
                      <span>{t('运行场景向导')}</span>
                    </div>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>

              {/* 右侧 Tab 内容区 (Keep-Alive 保活) */}
              <div className="flex-1 flex flex-col overflow-hidden bg-background">
                {visitedTabs.has('basic_ai_engine') && (
                  <div
                    className={cn(
                      'flex-1 flex flex-col overflow-hidden',
                      activeTab !== 'basic_ai_engine' && 'hidden'
                    )}
                  >
                    <MemoizedBasicAIEngineTab
                      workspace={activeWorkspace}
                      hardwareInfo={hardwareInfo}
                      onConfigSaved={refreshWorkspaceData}
                    />
                  </div>
                )}

                {visitedTabs.has('content_extraction') && (
                  <div
                    className={cn(
                      'flex-1 flex flex-col overflow-hidden',
                      activeTab !== 'content_extraction' && 'hidden'
                    )}
                  >
                    <MemoizedContentExtractionTab
                      workspace={activeWorkspace}
                      hardwareInfo={hardwareInfo}
                      onConfigSaved={refreshWorkspaceData}
                    />
                  </div>
                )}

                {visitedTabs.has('ignore_rules') && (
                  <div
                    className={cn(
                      'flex-1 flex flex-col overflow-hidden',
                      activeTab !== 'ignore_rules' && 'hidden'
                    )}
                  >
                    <MemoizedWorkspaceIgnoreRulesTab
                      workspace={activeWorkspace}
                      onConfigSaved={refreshWorkspaceData}
                    />
                  </div>
                )}

                {visitedTabs.has('maintenance') && (
                  <div
                    className={cn(
                      'flex-1 flex flex-col overflow-hidden',
                      activeTab !== 'maintenance' && 'hidden'
                    )}
                  >
                    <MemoizedWorkspaceMaintenanceTab
                      workspace={activeWorkspace}
                      onRerunWizard={() => setIsManualWizardMode(true)}
                      onConfigSaved={refreshWorkspaceData}
                    />
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
