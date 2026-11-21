import React, { useState, useEffect, useMemo, memo } from 'react'
import {
  WorkspaceDirectory,
  WorkspaceConfig,
  WorkspaceConfigReady,
  parseWorkspaceConfig,
  HardwareInfo,
  SettingsCategory
} from '@firefly/types'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter
} from '../ui/alert-dialog'
import { Button } from '../ui/button'
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
  Clock,
  AlertTriangle,
  Save,
  Loader2
} from 'lucide-react'

import { WorkspaceSetupWizard } from './workspace/WorkspaceSetupWizard'
import { BasicAIEngineTab } from './workspace/BasicAIEngineTab'
import { ContentExtractionTab } from './workspace/ContentExtractionTab'
import {
  WorkspaceAdmissionRulesTab,
  WorkspaceAdmissionRulesTabHandle
} from './workspace/WorkspaceAdmissionRulesTab'
import { WorkspaceMaintenanceTab } from './workspace/WorkspaceMaintenanceTab'
import { WorkspacePluginsTab } from './workspace/WorkspacePluginsTab'
import { useWorkspaceRuntimeContext } from '../../stores/workspace-runtime-context-store'
import { usePluginCenterStore } from '../../stores/plugin-center-store'
import { useToastStore, toast } from '../common/Toast'
import {
  computeLocalEffectiveConfig,
  submitWorkspacePolicyMutation,
  getMutationErrorText,
  type DegradationFixAction
} from '../../lib/workspace-policy/workspace-ai-client'

type WorkspaceTabId =
  | 'basic_ai_engine'
  | 'content_extraction'
  | 'workspace_plugins'
  | 'ignore_rules'
  | 'maintenance'

interface WorkspaceTabInfo {
  id: WorkspaceTabId
  name: string
  icon: string
  description: string
}

const MemoizedBasicAIEngineTab = memo(BasicAIEngineTab)
const MemoizedContentExtractionTab = memo(ContentExtractionTab)
const MemoizedWorkspaceAdmissionRulesTab = memo(WorkspaceAdmissionRulesTab)
const MemoizedWorkspaceMaintenanceTab = memo(WorkspaceMaintenanceTab)
const MemoizedWorkspacePluginsTab = memo(WorkspacePluginsTab)

/**
 * 工作目录独立设置对话框 (WorkspaceSettingsDialog)
 *
 * 核心架构 (TASK-07 ~ TASK-11)：
 * 1. 物理层解耦：完全独立于系统设置，专属于具体工作目录的配置；
 * 2. 左侧一级工作目录列表：取代原顶部下拉，支持在所有已添加的工作目录之间自由切换（默认选中当前活动目录）；
 * 3. 右侧内容区二级 Tab 菜单：目录维护与安全重置（首个 Tab）、检索式引擎、文件内容萃取、文件准入与包含排除；
 * 4. 极简向导流转：
 *    - 当工作区为 pending 时，首先进入 WorkspaceSetupWizard；
 *    - 点击「完成并开始分析」自动持久化 ready 并关闭弹窗；
 *    - 点击「深度自定义设置 ➔」就地切换至 4-Tab 高级模式；
 */
export const WorkspaceSettingsDialog: React.FC = () => {
  const isOpen = useSettingsStore(s => s.isWorkspaceSettingsOpen)
  const closeSettings = useSettingsStore(s => s.closeWorkspaceSettings)
  const openSystemSettings = useSettingsStore(s => s.openSystemSettings)
  const targetWorkspaceId = useSettingsStore(s => s.targetWorkspaceId)
  const targetWorkspaceTab = useSettingsStore(s => s.targetWorkspaceTab)

  // SLICE-08：渲染进程运行时上下文（contextEpoch 单调递增广播）
  // 弹窗打开时初始化快照并订阅推送；关闭时释放订阅
  const runtimeSnapshot = useWorkspaceRuntimeContext(s => s.snapshot)
  const initializeRuntime = useWorkspaceRuntimeContext(s => s.initialize)
  const disposeRuntime = useWorkspaceRuntimeContext(s => s.dispose)
  const refreshRuntime = useWorkspaceRuntimeContext(s => s.refresh)

  // 从 virtual directory store 获取工作目录列表与当前活动目录
  const workspaceDirectories = useVirtualDirectoryStore(s => s.workspaceDirectories)
  const currentWorkspace = useVirtualDirectoryStore(s => s.currentWorkspaceDirectory)
  const setWorkspaceDirectories = useVirtualDirectoryStore(s => s.setWorkspaceDirectories)

  // 当前正在查看与编辑的工作区 ID
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<number | null>(null)
  const [activeTab, setActiveTab] = useState<WorkspaceTabId>('maintenance')
  const [isManualWizardMode, setIsManualWizardMode] = useState<boolean>(false)
  const [isWizardDismissed, setIsWizardDismissed] = useState<boolean>(false)
  const [hardwareInfo, setHardwareInfo] = useState<HardwareInfo | null>(null)
  const [visitedTabs, setVisitedTabs] = useState<Set<WorkspaceTabId>>(
    () => new Set(['maintenance'])
  )

  // 引用规则管理 Tab 暴露的脏状态与操作 Handle
  const rulesTabRef = React.useRef<WorkspaceAdmissionRulesTabHandle>(null)

  // 美化的未保存规则确认对话框状态与挂起的离开动作
  const [showUnsavedConfirmDialog, setShowUnsavedConfirmDialog] = useState(false)
  const [isSavingOnConfirm, setIsSavingOnConfirm] = useState(false)
  const pendingActionRef = React.useRef<(() => void | Promise<void>) | null>(null)

  /**
   * 离开准入规则 Tab 或关闭设置弹窗前置检查：
   * 若规则已修改但用户未点击右上角的「保存包含与排除规则」，则弹出美化 React 确认对话框询问用户是否保存
   */
  const requestLeaveAction = (action: () => void | Promise<void>) => {
    if (rulesTabRef.current?.isDirty()) {
      pendingActionRef.current = action
      setShowUnsavedConfirmDialog(true)
    } else {
      void action()
    }
  }

  // 美化弹窗中点击【保存并继续】
  const handleConfirmSave = async () => {
    setIsSavingOnConfirm(true)
    try {
      const ok = await rulesTabRef.current?.save()
      if (ok) {
        setShowUnsavedConfirmDialog(false)
        const nextAction = pendingActionRef.current
        pendingActionRef.current = null
        if (nextAction) {
          await nextAction()
        }
      }
    } finally {
      setIsSavingOnConfirm(false)
    }
  }

  // 美化弹窗中点击【不保存】（放弃本次修改并继续离开）
  const handleConfirmDiscard = async () => {
    rulesTabRef.current?.discard()
    setShowUnsavedConfirmDialog(false)
    const nextAction = pendingActionRef.current
    pendingActionRef.current = null
    if (nextAction) {
      await nextAction()
    }
  }

  // 美化弹窗中点击【取消】（留在当前页面继续编辑）
  const handleConfirmCancel = () => {
    pendingActionRef.current = null
    setShowUnsavedConfirmDialog(false)
  }

  const handleRequestClose = () => {
    if (parsedConfig.status === 'pending') {
      ensureDefaultReadyConfig().catch(err => {
        console.warn('[WorkspaceSettingsDialog] 关闭弹窗补齐默认就绪配置失败:', err)
      })
    }
    requestLeaveAction(() => closeSettings())
  }

  const handleTabChange = (tabId: WorkspaceTabId) => {
    if (tabId === activeTab) return
    requestLeaveAction(() => setActiveTab(tabId))
  }

  const handleWorkspaceChange = (val: string) => {
    const nextId = Number(val)
    if (nextId === selectedWorkspaceId) return
    requestLeaveAction(() => {
      setSelectedWorkspaceId(nextId)
      setIsManualWizardMode(false)
      setIsWizardDismissed(false)
    })
  }

  const handleRunWizard = () => {
    requestLeaveAction(() => {
      setIsWizardDismissed(false)
      setIsManualWizardMode(true)
    })
  }

  // 1a. 初始化或同步选中的工作区 ID
  useEffect(() => {
    if (isOpen) {
      if (targetWorkspaceId != null) {
        setSelectedWorkspaceId(targetWorkspaceId)
      } else if (currentWorkspace?.id != null) {
        setSelectedWorkspaceId(currentWorkspace.id)
      } else if (workspaceDirectories.length > 0) {
        setSelectedWorkspaceId(prev => prev ?? workspaceDirectories[0].id ?? null)
      }
    }
  }, [isOpen, targetWorkspaceId, currentWorkspace?.id, workspaceDirectories])

  // 1b. 弹窗打开或路由锚点变化时，直达目标 Tab 或工作流向导模式
  useEffect(() => {
    if (isOpen) {
      setIsWizardDismissed(false)
      if (targetWorkspaceTab === 'wizard') {
        setIsManualWizardMode(true)
      } else {
        if (targetWorkspaceTab) {
          const tabKey =
            targetWorkspaceTab === 'admission' || targetWorkspaceTab === 'admission_rules'
              ? 'ignore_rules'
              : targetWorkspaceTab
          setActiveTab(tabKey as WorkspaceTabId)
        }
        setIsManualWizardMode(false)
      }
    }
  }, [isOpen, targetWorkspaceId, targetWorkspaceTab])

  // 2. 加载硬件信息
  useEffect(() => {
    if (isOpen && window.electronAPI?.getHardwareInfo) {
      window.electronAPI
        .getHardwareInfo()
        .then(hw => setHardwareInfo(hw || null))
        .catch(err => {
          console.warn('[WorkspaceSettingsDialog] 读取硬件信息失败:', err)
          setHardwareInfo(null)
        })
    }
  }, [isOpen])

  // 2b. SLICE-08：弹窗打开时握手运行时上下文快照并订阅推送，关闭时仅释放本弹窗引用（不错杀 Footer）
  useEffect(() => {
    if (!isOpen) return
    void initializeRuntime(selectedWorkspaceId)
    return () => {
      disposeRuntime()
    }
  }, [isOpen, selectedWorkspaceId, initializeRuntime, disposeRuntime])

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

  // SLICE-08：本地隔离版三态仲裁（Group A 合流前过渡实现）
  // 单次派生三桶计数与目录插件状态，驱动顶栏三态总览横幅与第 5 Tab。
  const hasBoundWorkflow = parsedConfig.status === 'ready' && parsedConfig.workflowId != null
  const resolvedEffectiveConfig = useMemo(() => {
    if (parsedConfig.status !== 'ready') return null
    return computeLocalEffectiveConfig({
      parsedConfig,
      runtimeSnapshot
    })
  }, [parsedConfig, runtimeSnapshot])
  const effectiveSummary = resolvedEffectiveConfig?.summary ?? {
    defaultCount: 0,
    userCustomCount: 0,
    degradedCount: 0
  }
  const pluginsRecord = resolvedEffectiveConfig?.plugins ?? {}

  // 判断是否应该展示设置向导：
  // 仅在用户显式要求向导模式（targetWorkspaceTab === 'wizard' 或手动点击运行向导）且未点击跳过时展示向导；
  // 即使工作区未绑定工作流（isPending），只要用户是打开工作目录设置，均允许直接进入 4-Tab 高级设置。
  const isPending = parsedConfig.status === 'pending'
  const showWizard = !isWizardDismissed && (isManualWizardMode || targetWorkspaceTab === 'wizard')

  // 确保当前工作区就绪为默认配置（若处于 pending，保存为默认 AI 策略且未绑定工作流）
  const ensureDefaultReadyConfig = async () => {
    if (activeWorkspace?.id != null && parsedConfig.status === 'pending') {
      try {
        // SLICE-08：pending → ready 初始化也统一走补丁通道（restoreWorkflowDefault）
        // 不再整份拼装 WorkspaceConfigReady 直写 updateWorkspaceConfig
        const result = await submitWorkspacePolicyMutation(activeWorkspace.id!, {
          restoreWorkflowDefault: true
        })
        if (!result.success) {
          console.warn(
            '[WorkspaceSettingsDialog] 持久化默认就绪配置失败:',
            result.error ?? 'UNKNOWN'
          )
          return
        }
        await refreshWorkspaceData()
      } catch (err) {
        console.warn('[WorkspaceSettingsDialog] 持久化默认就绪配置失败:', err)
      }
    }
  }

  // 用户点击【跳过向导】：退出向导模式，进入 4-Tab 高级设置，并持久化默认就绪配置（不绑定工作流）
  const handleSkipWizard = async () => {
    setIsManualWizardMode(false)
    setIsWizardDismissed(true)
    await ensureDefaultReadyConfig()
  }

  // 刷新工作区列表数据
  const refreshWorkspaceData = async () => {
    try {
      if (window.electronAPI?.getAllWorkspaceDirectories) {
        const dirs = await window.electronAPI.getAllWorkspaceDirectories()
        if (dirs) {
          setWorkspaceDirectories(dirs)
          // 若当前活跃工作区存在，同步刷新 store 中 currentWorkspaceDirectory
          if (currentWorkspace?.id) {
            const freshCurrent = dirs.find(d => d.id === currentWorkspace.id)
            if (freshCurrent) {
              useVirtualDirectoryStore.getState().setCurrentWorkspaceDirectory(freshCurrent)
            }
          }
        }
      }
    } catch (err) {
      console.warn('[WorkspaceSettingsDialog] 刷新工作目录失败:', err)
    }
  }

  // 4-Tab 完整还原定义 (目录维护、检索式引擎、文件内容萃取、忽略规则)
  // 内置常驻项：目录维护与安全重置、检索式引擎、文件准入与包含排除；
  // 文件内容萃取仍依据已激活插件动态挂载 (Spec §5.2)。
  // 「目录维护与安全重置」为首个 Tab，且为 activeTab 默认值与 visitedTabs 初值。
  // 「检索式引擎」必须常驻：插件中心配置锚点 (targetTab: 'basic_ai_engine') 仍指向它。
  // 若按插件激活状态过滤，全新安装或插件未激活时会出现「入口消失但内容仍在」、
  // 且 activeTab 指向不可见 Tab 的断裂，用户无法再进入检索式引擎设置。
  const tabs: WorkspaceTabInfo[] = useMemo(() => {
    const allTabs: WorkspaceTabInfo[] = [
      {
        id: 'maintenance',
        name: t('目录维护与安全重置'),
        icon: 'folder_open',
        description: t('重新运行向导与两段式安全重置')
      },
      {
        id: 'basic_ai_engine',
        name: t('检索式引擎'),
        icon: 'tune',
        description: t('分析模式与视频画面提取')
      },
      {
        id: 'content_extraction',
        name: t('文件内容萃取'),
        icon: 'document_scanner',
        description: t('文字提取清晰度与首页封面图')
      },
      {
        id: 'workspace_plugins',
        name: t('目录插件配置'),
        icon: 'extension',
        description: t('按当前目录单独开关语音听写与敏感图识别等组件')
      },
      {
        id: 'ignore_rules',
        name: t('文件准入与包含排除'),
        icon: 'filter',
        description: t('包含规则与排除规则可同时设置、叠加生效')
      }
    ]

    // SLICE-08：5 个 Tab 全部常驻，严禁随插件激活状态隐藏（修复 content_extraction
    // 在仅启用基础引擎时整 Tab 消失、用户无法配置文字提取清晰度的 Bug）。
    return allTabs
  }, [])

  // 统一处理三态降级一键引导动作（插件中心 / 文档封面 Tab / 专业版升级）
  // 【跳转归一铁律】install/enable/fix_global_plugin 三类组件级修复必须直达
  // 插件中心覆盖层（可带 pluginId 定位到对应插件详情），严禁误跳生成式 AI 引擎
  // 设置页 —— 引擎页只有 open_generative_engine / switch_to_gemma_unified 两类
  // 引擎级动作合法。
  const handleDegradationFixAction = (action: DegradationFixAction, pluginId?: string) => {
    switch (action) {
      case 'open_generative_engine':
      case 'switch_to_gemma_unified':
        closeSettings()
        openSystemSettings(SettingsCategory.AI_ENGINE_CONFIG)
        break
      case 'install_global_plugin':
      case 'enable_global_plugin':
      case 'fix_global_plugin': {
        closeSettings()
        void Promise.resolve(usePluginCenterStore.getState().openOverlay()).then(() => {
          if (pluginId) {
            usePluginCenterStore.getState().setConfiguringModuleId(pluginId)
          }
        })
        break
      }
      case 'install_libreoffice':
        setActiveTab('content_extraction')
        break
      case 're_enable_parent_plugin':
        setActiveTab('workspace_plugins')
        break
      case 'open_pro_upgrade':
        closeSettings()
        openSystemSettings(SettingsCategory.GENERAL)
        break
      default:
        break
    }
  }

  if (!isOpen) return null

  return (
    <Dialog open={isOpen} onOpenChange={open => !open && void handleRequestClose()}>
      <DialogContent className="max-w-5xl w-[88vw] h-[82vh] flex flex-col p-0 bg-background dark:bg-card text-foreground border-4 border-border rounded-2xl shadow-2xl transform-gpu [contain:content]">
        {/* 顶部 Header：标题与状态概览 (pr-16 预留右上角绝对定位关闭按钮空间，杜绝重叠) */}
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
                        <span>{t('未绑定工作流')}</span>
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

          {/* SLICE-08：三态配置总览横幅（向导模式隐藏；未绑定工作流切换为通用配置文案） */}
          {activeWorkspace && !showWizard && (
            <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
              {/* 主题归属标识：已绑定显示工作流名称，未绑定显式显示通用配置 */}
              {hasBoundWorkflow ? (
                <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                  {(parsedConfig.status === 'ready'
                    ? (parsedConfig as unknown as { workflowName?: string }).workflowName
                    : undefined) || t('已绑定工作流')}
                </span>
              ) : (
                <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                  {t('未绑定工作流（通用配置）')}
                </span>
              )}

              {/* 🔵 基础计数胶囊：已绑定工作流显示「工作流默认」，未绑定显示「默认配置」 */}
              <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-2 py-0.5 text-[11px] font-medium text-blue-600 dark:text-blue-400">
                <span className="h-1.5 w-1.5 rounded-full bg-blue-500" aria-hidden="true" />
                {hasBoundWorkflow ? t('工作流默认') : t('默认配置')}
                <span className="font-semibold">{effectiveSummary.defaultCount}</span>
              </span>

              {/* 🟣 用户自定义（>0 时展示） */}
              {effectiveSummary.userCustomCount > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full bg-purple-500/10 px-2 py-0.5 text-[11px] font-medium text-purple-600 dark:text-purple-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-purple-500" aria-hidden="true" />
                  {t('用户自定义')}
                  <span className="font-semibold">{effectiveSummary.userCustomCount}</span>
                </span>
              )}

              {/* 🟠 环境自动降级（按根因去重后 >0 时琥珀色醒目展示，支持点击跳转定位受限 Tab） */}
              {effectiveSummary.degradedCount > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    const hasPluginDegraded = Object.values(pluginsRecord).some(
                      p => p.applicability === 'degraded'
                    )
                    handleTabChange(hasPluginDegraded ? 'workspace_plugins' : 'basic_ai_engine')
                  }}
                  className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-700 hover:bg-amber-500/25 dark:text-amber-300 transition-colors cursor-pointer"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
                  {t('环境自动降级')}
                  <span className="font-semibold">{effectiveSummary.degradedCount}</span>
                </button>
              )}

              {/* 全量重置按钮：已绑定显示「恢复工作流默认」，未绑定显示「恢复全局默认」 */}
              {parsedConfig.status === 'ready' && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    void submitWorkspacePolicyMutation(activeWorkspace.id!, {
                      restoreWorkflowDefault: true
                    })
                      .then(result => {
                        if (result.success) {
                          toast.success(
                            hasBoundWorkflow ? t('已恢复工作流默认配置') : t('已恢复全局默认配置')
                          )
                          void refreshWorkspaceData()
                          void refreshRuntime()
                        } else {
                          toast.error(getMutationErrorText(result, t('恢复默认配置失败')))
                        }
                      })
                      .catch(err => {
                        console.warn('[WorkspaceSettingsDialog] 恢复默认配置异常:', err)
                        toast.error(err instanceof Error ? err.message : t('恢复默认配置失败'))
                      })
                  }}
                >
                  <RotateCcw className="mr-1 h-3 w-3" />
                  {hasBoundWorkflow ? t('恢复工作流默认') : t('恢复全局默认')}
                </Button>
              )}
            </div>
          )}
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
                onSkip={handleSkipWizard}
                onFinish={async (mode, readyConfig) => {
                  const prevWorkflowId =
                    parsedConfig.status === 'ready' ? (parsedConfig.workflowId ?? null) : null
                  const prevOverrides =
                    parsedConfig.status === 'ready' && parsedConfig.overrides
                      ? { ...parsedConfig.overrides }
                      : undefined
                  const rawPrevPluginOverrides =
                    parsedConfig.status === 'ready'
                      ? (parsedConfig as unknown as { pluginOverrides?: Record<string, boolean> })
                          .pluginOverrides
                      : undefined
                  const prevPluginOverrides =
                    rawPrevPluginOverrides && Object.keys(rawPrevPluginOverrides).length > 0
                      ? { ...rawPrevPluginOverrides }
                      : undefined
                  const nextWorkflowId =
                    readyConfig?.status === 'ready' ? (readyConfig.workflowId ?? null) : null
                  const targetWorkspaceId = activeWorkspace.id

                  await refreshWorkspaceData()
                  void refreshRuntime()

                  // 切换工作流时提供非阻断 [撤销] Toast，允许一键还原原工作流、参数覆盖与插件覆盖
                  if (
                    targetWorkspaceId != null &&
                    prevWorkflowId !== nextWorkflowId &&
                    (prevWorkflowId !== null ||
                      (prevOverrides && Object.keys(prevOverrides).length > 0) ||
                      Boolean(prevPluginOverrides))
                  ) {
                    useToastStore.getState().addToast({
                      type: 'info',
                      message: t('已切换工作流配置，原有自定义参数已重置'),
                      duration: 8000,
                      action: {
                        label: t('撤销'),
                        onClick: () => {
                          void submitWorkspacePolicyMutation(targetWorkspaceId, {
                            workflowId: prevWorkflowId,
                            ...(prevOverrides && Object.keys(prevOverrides).length > 0
                              ? { overridePatch: prevOverrides }
                              : {}),
                            ...(prevPluginOverrides
                              ? { pluginOverridePatch: prevPluginOverrides }
                              : {})
                          })
                            .then(res => {
                              if (res.success) {
                                toast.success(t('已恢复切换前的工作流与参数配置'))
                                void refreshWorkspaceData()
                                void refreshRuntime()
                              } else {
                                toast.error(getMutationErrorText(res, t('撤销失败')))
                              }
                            })
                            .catch(err => {
                              console.warn('[WorkspaceSettingsDialog] 撤销工作流切换异常:', err)
                              toast.error(err instanceof Error ? err.message : t('撤销失败'))
                            })
                        }
                      }
                    })
                  }

                  if (mode === 'complete') {
                    closeSettings()
                  } else {
                    // 切入深度自定义模式：直达「文件准入与包含排除」Tab
                    setIsManualWizardMode(false)
                    setIsWizardDismissed(true)
                    setActiveTab('ignore_rules')
                  }
                }}
              />
            </div>
          ) : (
            /* 2. 常态 4-Tab 高级设置视图 */
            <>
              {/* 一级导航：左侧工作目录列表 */}
              <div className="w-56 border-r flex flex-col flex-shrink-0 bg-muted/10">
                <div className="px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground border-b border-border/40">
                  {t('工作目录列表')}
                </div>
                <nav className="p-2 space-y-1 overflow-y-auto flex-1">
                  {workspaceDirectories.map(ws => {
                    const isActive = activeWorkspace?.id === ws.id
                    return (
                      <Button
                        key={ws.id}
                        variant="ghost"
                        className={cn(
                          'w-full justify-start text-left h-auto p-2.5 transition-all duration-200 border',
                          isActive
                            ? 'bg-primary/10 text-primary border-primary/30'
                            : 'border-transparent hover:bg-muted/60 text-muted-foreground hover:text-foreground'
                        )}
                        onClick={() => void handleWorkspaceChange(String(ws.id))}
                      >
                        <div className="flex items-center gap-2.5 w-full min-w-0">
                          <FolderOpen
                            className={cn(
                              'w-4 h-4 shrink-0',
                              isActive ? 'text-primary' : 'text-muted-foreground'
                            )}
                          />
                          <div className="flex-1 min-w-0">
                            <div className="font-semibold text-xs truncate">{ws.name}</div>
                            <div className="text-[10px] truncate opacity-70 mt-0.5">{ws.path}</div>
                          </div>
                        </div>
                      </Button>
                    )
                  })}
                </nav>
              </div>

              {/* 右侧内容区：二级 Tab 菜单 + Tab 内容 (Keep-Alive 保活) */}
              <div className="flex-1 flex flex-col overflow-hidden bg-background">
                {/* 二级 Tab 菜单（横向标签栏） */}
                <div className="flex-shrink-0 px-4 pt-2.5 border-b border-border/60 overflow-x-auto">
                  <div className="flex items-center gap-1">
                    {tabs.map(tab => {
                      const isActive = activeTab === tab.id
                      return (
                        <Button
                          key={tab.id}
                          variant="ghost"
                          size="sm"
                          title={tab.description}
                          className={cn(
                            'relative h-9 px-3.5 text-xs font-semibold whitespace-nowrap rounded-t-md rounded-b-none border-b-2 transition-all duration-200',
                            isActive
                              ? 'text-primary border-primary bg-primary/5'
                              : 'text-muted-foreground border-transparent hover:text-foreground hover:bg-muted/60'
                          )}
                          onClick={() => void handleTabChange(tab.id)}
                        >
                          <div className="flex items-center gap-1.5">
                            <MaterialIcon icon={tab.icon} className="text-base" />
                            <span>{tab.name}</span>
                          </div>
                        </Button>
                      )
                    })}
                  </div>
                </div>

                {/* Tab 内容区 (Keep-Alive 保活) */}
                <div className="flex-1 flex flex-col overflow-hidden">
                  {visitedTabs.has('basic_ai_engine') && (
                    <div
                      className={cn(
                        'flex-1 flex flex-col overflow-hidden',
                        activeTab !== 'basic_ai_engine' && 'hidden'
                      )}
                    >
                      <MemoizedBasicAIEngineTab
                        key={`${activeWorkspace.id}-${activeWorkspace.workspace_config}`}
                        workspace={activeWorkspace}
                        hardwareInfo={hardwareInfo}
                        isActive={activeTab === 'basic_ai_engine'}
                        onConfigSaved={refreshWorkspaceData}
                        resolvedFields={resolvedEffectiveConfig?.fields}
                        hasBoundWorkflow={hasBoundWorkflow}
                        onFixAction={handleDegradationFixAction}
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
                        key={`${activeWorkspace.id}-${activeWorkspace.workspace_config}`}
                        workspace={activeWorkspace}
                        hardwareInfo={hardwareInfo}
                        isActive={activeTab === 'content_extraction'}
                        onConfigSaved={refreshWorkspaceData}
                        resolvedFields={resolvedEffectiveConfig?.fields}
                        hasBoundWorkflow={hasBoundWorkflow}
                        onFixAction={handleDegradationFixAction}
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
                      <MemoizedWorkspaceAdmissionRulesTab
                        ref={rulesTabRef}
                        key={activeWorkspace.id}
                        workspace={activeWorkspace}
                        hardwareInfo={hardwareInfo}
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

                  {visitedTabs.has('workspace_plugins') && (
                    <div
                      className={cn(
                        'flex-1 flex flex-col overflow-y-auto',
                        activeTab !== 'workspace_plugins' && 'hidden'
                      )}
                    >
                      <div className="p-4">
                        <MemoizedWorkspacePluginsTab
                          key={activeWorkspace.id}
                          workspaceId={activeWorkspace.id!}
                          plugins={pluginsRecord}
                          hasBoundWorkflow={hasBoundWorkflow}
                          onFixAction={(action, pluginId) =>
                            handleDegradationFixAction(action, pluginId)
                          }
                          onMutationSuccess={() => {
                            void refreshWorkspaceData()
                            void refreshRuntime()
                          }}
                          onMutationError={err => {
                            // 显式上报并向用户提示失败，严禁静默吞掉
                            console.warn('[WorkspaceSettingsDialog] 目录插件开关提交失败:', err)
                            toast.error(err || t('目录插件配置保存失败'))
                          }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        {/* 规则修改未保存：系统中美化的 React 确认对话框 */}
        <AlertDialog open={showUnsavedConfirmDialog} onOpenChange={setShowUnsavedConfirmDialog}>
          <AlertDialogContent
            data-testid="unsaved-admission-rules-dialog"
            className="border-2 border-border max-w-md bg-background dark:bg-card text-foreground rounded-2xl shadow-2xl"
          >
            <AlertDialogHeader>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-amber-500/15 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
                  <AlertTriangle className="w-5 h-5" />
                </div>
                <AlertDialogTitle className="text-base font-bold text-foreground">
                  {t('文件准入与包含规则已修改')}
                </AlertDialogTitle>
              </div>
              <AlertDialogDescription asChild>
                <div className="text-xs text-muted-foreground pt-2 space-y-2 leading-relaxed">
                  <p className="font-semibold text-foreground text-sm">
                    {t('文件准入与包含规则已修改，是否保存？')}
                  </p>
                  <p>
                    {t(
                      '当前工作目录的文件准入与包含规则已发生变动，但尚未保存。若不保存，您刚才的所有修改都将丢失。'
                    )}
                  </p>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>

            <AlertDialogFooter className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isSavingOnConfirm}
                data-testid="unsaved-confirm-cancel-btn"
                onClick={handleConfirmCancel}
                className="text-xs"
              >
                {t('取消')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={isSavingOnConfirm}
                data-testid="unsaved-confirm-discard-btn"
                onClick={handleConfirmDiscard}
                className="text-xs text-muted-foreground hover:text-destructive"
              >
                {t('不保存')}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={isSavingOnConfirm}
                data-testid="unsaved-confirm-save-btn"
                onClick={handleConfirmSave}
                className="text-xs font-semibold bg-primary text-primary-foreground hover:bg-primary/90 flex items-center gap-1.5 shadow-sm"
              >
                {isSavingOnConfirm ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Save className="w-3.5 h-3.5" />
                )}
                <span>{isSavingOnConfirm ? t('正在保存...') : t('保存并继续')}</span>
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  )
}
