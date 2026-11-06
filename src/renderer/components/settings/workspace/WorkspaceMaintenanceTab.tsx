import React, { useState, useMemo, useEffect } from 'react'
import { WorkspaceDirectory, WorkspaceConfig, parseWorkspaceConfig } from '@firefly/types'
import { getIntentDisplayName } from '../WorkspaceConfigPanel'
import { Card } from '../../ui/card'
import { Button } from '../../ui/button'
import { Switch } from '../../ui/switch'
import { Label } from '../../ui/label'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '../../ui/alert-dialog'
import { RescanPreviewDialog } from '../RescanPreviewDialog'
import { EmptyFolderCleanupDialog } from '../../organize/EmptyFolderCleanupDialog'
import { useVirtualDirectoryStore } from '../../../stores/virtual-directory-store'
import { useAnalyzedDirectoryStore } from '../../../stores/analyzed-directory-store'
import { MaterialIcon, cn } from '../../../lib/utils'
import { toast } from '../../common/Toast'
import { t } from '@app/languages'
import {
  FolderOpen,
  RotateCcw,
  AlertTriangle,
  Sparkles,
  ShieldCheck,
  HardDrive,
  Trash2,
  Loader2,
  Calendar,
  Layers,
  Radio,
  RefreshCw,
  FolderX,
  ExternalLink,
  Search,
  CheckCircle2,
  Clock
} from 'lucide-react'

export interface WorkspaceMaintenanceTabProps {
  workspace: WorkspaceDirectory
  onRerunWizard: () => void
  onConfigSaved?: () => void
}

/**
 * 工作区专有：目录维护与安全重置面板 (TASK-11 完善版)
 *
 * 核心功能项按「每行一个卡片」整齐排列：
 * 1. 目录信息与打开物理文件夹
 * 2. 自动监听文件变动 (Switch 控制)
 * 3. 重新扫描目录与文件差异检测
 * 4. 扫描并清理空文件夹
 * 5. 重新运行场景设置向导
 * 6. 两段式安全重置 AI 分析数据 (跨工作区孤儿保护)
 * 7. 从应用中移除工作目录
 */
export const WorkspaceMaintenanceTab: React.FC<WorkspaceMaintenanceTabProps> = ({
  workspace,
  onRerunWizard,
  onConfigSaved
}) => {
  // 弹窗与加载状态
  const [showResetDialog, setShowResetDialog] = useState(false)
  const [isResetting, setIsResetting] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [isScanning, setIsScanning] = useState(false)
  const [isTogglingWatch, setIsTogglingWatch] = useState(false)

  // 差异扫描预览弹窗
  const [showRescanDialog, setShowRescanDialog] = useState(false)
  const [rescanData, setRescanData] = useState<{ newFiles: any[]; modifiedFiles: any[] } | null>(
    null
  )

  // 空文件夹清理弹窗
  const [showEmptyFolderDialog, setShowEmptyFolderDialog] = useState(false)
  const [isScanningEmptyFolders, setIsScanningEmptyFolders] = useState(false)

  // 工作流列表（从 ConfigDbManager 数据中枢获取）
  const [workflows, setWorkflows] = useState<any[]>([])

  useEffect(() => {
    let isMounted = true
    window.electronAPI
      ?.getLocalWorkflows?.()
      .then((res: any) => {
        if (isMounted && res?.success && Array.isArray(res.data) && res.data.length > 0) {
          setWorkflows(res.data)
        }
      })
      .catch(() => {})
    return () => {
      isMounted = false
    }
  }, [])

  // 绑定的工作流实体与白名单快照
  const boundWorkflow = useMemo(() => {
    if (!workspace.bound_workflow_id) return null
    return workflows.find((w: any) => w.id === workspace.bound_workflow_id) || null
  }, [workspace.bound_workflow_id, workflows])

  const whitelistPatterns = useMemo<string[]>(() => {
    let raw = workspace.whitelist_patterns
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw)
      } catch {
        raw = []
      }
    }
    return Array.isArray(raw) ? raw : []
  }, [workspace.whitelist_patterns])

  // 解绑工作流与清空白名单弹窗状态
  const [showUnbindDialog, setShowUnbindDialog] = useState(false)
  const [isUnbinding, setIsUnbinding] = useState(false)
  const [showClearWhitelistDialog, setShowClearWhitelistDialog] = useState(false)
  const [isClearingWhitelist, setIsClearingWhitelist] = useState(false)

  // 本地监听开关状态
  const [autoWatch, setAutoWatch] = useState<boolean>(Boolean(workspace.autoWatch))

  // 同步外部 workspace.autoWatch
  React.useEffect(() => {
    setAutoWatch(Boolean(workspace.autoWatch))
  }, [workspace.id, workspace.autoWatch])

  // 解析当前工作区配置
  const parsedConfig = useMemo<WorkspaceConfig>(() => {
    return parseWorkspaceConfig(workspace.workspace_config)
  }, [workspace.workspace_config])

  const isReady = parsedConfig.status === 'ready'

  // 1. 在操作系统资源管理器中打开物理目录
  const handleOpenFolder = async () => {
    try {
      if (window.electronAPI?.utils?.openPathInExplorer && workspace.path) {
        await window.electronAPI.utils.openPathInExplorer(workspace.path)
      } else {
        toast.info(t('当前环境无法直接打开本地目录'))
      }
    } catch (err: any) {
      toast.error(err?.message || t('打开目录失败'))
    }
  }

  // 2. 切换目录文件自动监听开关 (Switch)
  const handleToggleAutoWatch = async (checked: boolean) => {
    if (!workspace.id) return
    setIsTogglingWatch(true)
    try {
      if (window.electronAPI?.updateWorkspaceDirectoryAutoWatch) {
        await window.electronAPI.updateWorkspaceDirectoryAutoWatch(workspace.id, checked)
        setAutoWatch(checked)
        toast.success(
          checked
            ? t('已开启自动监听：新文件变动将自动加入 AI 分析队列')
            : t('已暂停自动监听：不再自动跟踪外部文件变化')
        )
        onConfigSaved?.()
      }
    } catch (err: any) {
      toast.error(err?.message || t('更新目录监听状态失败'))
    } finally {
      setIsTogglingWatch(false)
    }
  }

  // 3. 重新扫描目录并检测外部变动
  const handleRescanDirectory = async () => {
    if (!workspace.id) return
    setIsScanning(true)
    try {
      if (window.electronAPI?.rescanWorkspaceDirectory) {
        const result = await window.electronAPI.rescanWorkspaceDirectory(workspace.id)
        const newFiles = (result as any)?.stats?.newFiles || []
        const modifiedFiles = (result as any)?.stats?.modifiedFiles || []

        if (newFiles.length > 0 || modifiedFiles.length > 0) {
          setRescanData({ newFiles, modifiedFiles })
          setShowRescanDialog(true)
        } else {
          toast.info(t('当前目录无新增或变动文件'))
        }
        onConfigSaved?.()
      } else {
        toast.info(t('扫描接口不可用'))
      }
    } catch (err: any) {
      toast.error(err?.message || t('重新扫描目录失败'))
    } finally {
      setIsScanning(false)
    }
  }

  // 4. 扫描空文件夹并弹出清理对话框
  const handleScanEmptyFolders = async () => {
    if (!workspace.path) return
    setIsScanningEmptyFolders(true)
    try {
      if (window.electronAPI?.emptyFolder?.scan) {
        const result = await window.electronAPI.emptyFolder.scan(workspace.path)
        if (!result.emptyFolders || result.emptyFolders.length === 0) {
          toast.info(t('未发现空文件夹，目录结构非常整洁！'))
        } else {
          setShowEmptyFolderDialog(true)
        }
      }
    } catch (err: any) {
      toast.error(err?.message || t('扫描空文件夹失败'))
    } finally {
      setIsScanningEmptyFolders(false)
    }
  }

  // 5. 执行两段式安全重置
  const handleExecuteReset = async () => {
    if (!workspace.path) return
    setIsResetting(true)
    try {
      if (window.electronAPI?.resetWorkspaceDirectory) {
        await window.electronAPI.resetWorkspaceDirectory(workspace.path)
        // 清理虚拟目录状态缓存
        try {
          localStorage.removeItem('virtualDir_selectedTags')
          localStorage.removeItem('virtualDir_selectionStack')
          useVirtualDirectoryStore.getState().setDimensionGroups([])
          useVirtualDirectoryStore.getState().clearSelection()
          useVirtualDirectoryStore.getState().setFilteredFiles([])
          useVirtualDirectoryStore.getState().setTotalFilesCount(0)
          useAnalyzedDirectoryStore.getState().setDimensionGroups([])
          useAnalyzedDirectoryStore.getState().clearSelectedTags()
          useAnalyzedDirectoryStore.getState().setFilteredFiles([])
          window.dispatchEvent(new CustomEvent('workspace-reset'))
        } catch {
          // 容错
        }

        toast.success(t('工作区分析数据已安全重置，被其他目录共享的文件已依法完整保留。'))
        setShowResetDialog(false)
        onConfigSaved?.()
      } else {
        toast.info(t('未检测到重置接口'))
      }
    } catch (err: any) {
      toast.error(err?.message || t('重置工作区异常'))
    } finally {
      setIsResetting(false)
    }
  }

  // 6. 从应用中移除工作目录
  const handleExecuteDelete = async () => {
    if (!workspace.path) return
    setIsDeleting(true)
    try {
      if (window.electronAPI?.deleteWorkspaceDirectory) {
        const result = await window.electronAPI.deleteWorkspaceDirectory(workspace.path)
        if (result?.success) {
          toast.success(t('工作目录「{name}」已从应用中移除', { name: workspace.name }))
          setShowDeleteDialog(false)
          onConfigSaved?.()
        } else {
          toast.error(result?.error || t('移除工作目录失败'))
        }
      }
    } catch (err: any) {
      toast.error(err?.message || t('移除工作目录异常'))
    } finally {
      setIsDeleting(false)
    }
  }

  // 7. 解除工作流绑定 (默认完整保留当前白名单快照，防非目标文件骤然涌入)
  const handleUnbindWorkflow = async () => {
    if (!workspace.id) return
    setIsUnbinding(true)
    try {
      if (window.electronAPI?.updateWorkspaceBoundWorkflow) {
        const res = await window.electronAPI.updateWorkspaceBoundWorkflow(workspace.id, null)
        if (res?.success) {
          // 同步更新前端 store 状态
          const {
            workspaceDirectories,
            setWorkspaceDirectories,
            currentWorkspaceDirectory,
            setCurrentWorkspaceDirectory
          } = useVirtualDirectoryStore.getState()
          const fresh = workspaceDirectories.map(w =>
            w.id === workspace.id ? { ...w, bound_workflow_id: null } : w
          )
          setWorkspaceDirectories(fresh)
          if (currentWorkspaceDirectory?.id === workspace.id) {
            setCurrentWorkspaceDirectory({ ...currentWorkspaceDirectory, bound_workflow_id: null })
          }

          toast.success(t('已解除工作流绑定，当前白名单快照已安全保留'))
          setShowUnbindDialog(false)
          onConfigSaved?.()
        } else {
          toast.error(res?.error || t('解除工作流绑定失败'))
        }
      }
    } catch (err: any) {
      toast.error(err?.message || t('解除工作流绑定异常'))
    } finally {
      setIsUnbinding(false)
    }
  }

  // 8. 显式清空白名单并恢复全量模式
  const handleClearWhitelist = async () => {
    if (!workspace.id) return
    setIsClearingWhitelist(true)
    try {
      if (window.electronAPI?.updateWorkspaceWhitelist) {
        const res = await window.electronAPI.updateWorkspaceWhitelist(workspace.id, [])
        if (res?.success) {
          // 同步更新前端 store 状态
          const {
            workspaceDirectories,
            setWorkspaceDirectories,
            currentWorkspaceDirectory,
            setCurrentWorkspaceDirectory
          } = useVirtualDirectoryStore.getState()
          const fresh = workspaceDirectories.map(w =>
            w.id === workspace.id ? { ...w, whitelist_patterns: [] } : w
          )
          setWorkspaceDirectories(fresh)
          if (currentWorkspaceDirectory?.id === workspace.id) {
            setCurrentWorkspaceDirectory({ ...currentWorkspaceDirectory, whitelist_patterns: [] })
          }

          toast.success(t('白名单已清空，已恢复为标准全量入场模式'))
          setShowClearWhitelistDialog(false)
          onConfigSaved?.()
        } else {
          toast.error(res?.error || t('清空白名单失败'))
        }
      }
    } catch (err: any) {
      toast.error(err?.message || t('清空白名单异常'))
    } finally {
      setIsClearingWhitelist(false)
    }
  }

  return (
    <div className="p-6 space-y-4 max-w-4xl mx-auto overflow-y-auto max-h-full">
      {/* 头部说明 */}
      <div className="pb-3 border-b border-border/60">
        <h3 className="text-lg font-bold flex items-center gap-2">
          <HardDrive className="w-5 h-5 text-primary" />
          <span>{t('目录维护与管理')}</span>
        </h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          {t('监控文件变动、全量扫描、清理空文件夹或重置当前目录的 AI 分析数据。')}
        </p>
      </div>

      {/* 1. 目录物理概览信息卡片 */}
      <Card className="p-4 bg-muted/20 border-border/70 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
              <FolderOpen className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h4 className="font-bold text-sm text-foreground truncate">{workspace.name}</h4>
                {isReady ? (
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-green-500/15 text-green-600 dark:text-green-400">
                    {t('已就绪')}
                  </span>
                ) : (
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400">
                    {t('待配置')}
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground font-mono truncate mt-0.5">
                {workspace.path}
              </p>
            </div>
          </div>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleOpenFolder}
            className="text-xs shrink-0 flex items-center gap-1.5 h-8 px-3"
            title={t('在操作系统资源管理器中查看此文件夹')}
          >
            <ExternalLink className="w-3.5 h-3.5" />
            <span>{t('打开文件夹')}</span>
          </Button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 border-t border-border/40 text-[11px] text-muted-foreground">
          <div className="flex items-center gap-2 min-w-0">
            <Layers className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
            <span>{t('场景意图: ')}</span>
            <span className="font-semibold text-foreground truncate">
              {isReady ? getIntentDisplayName(parsedConfig.intent) : t('未指定')}
            </span>
          </div>

          <div className="flex items-center gap-2 min-w-0">
            <Sparkles className="w-3.5 h-3.5 shrink-0 text-primary" />
            <span>{t('绑定工作流: ')}</span>
            <span className="font-semibold text-foreground truncate">
              {boundWorkflow
                ? boundWorkflow.name
                : workspace.bound_workflow_id || t('未绑定 (标准模式)')}
            </span>
          </div>

          <div className="flex items-center gap-2 min-w-0">
            <Calendar className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
            <span>{t('添加时间: ')}</span>
            <span className="font-semibold text-foreground truncate">
              {workspace.createdAt ? new Date(workspace.createdAt).toLocaleString() : '-'}
            </span>
          </div>
        </div>
      </Card>

      {/* 2. 条目 1: 目录文件自动监听 (Switch 控件，解决用户核心诉求) */}
      <Card className="p-4 flex items-center justify-between gap-4 border-border/70 hover:border-border transition-colors">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0 mt-0.5">
            <Radio className="w-4 h-4" />
          </div>
          <div className="space-y-0.5 min-w-0">
            <div className="flex items-center gap-2">
              <Label
                htmlFor="auto-watch-switch"
                className="text-sm font-bold text-foreground cursor-pointer"
              >
                {t('自动监听文件变动 (Auto Watch)')}
              </Label>
              {autoWatch && (
                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-600 dark:text-blue-400">
                  {t('实时监听中')}
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {t(
                '实时感知当前目录下新增、修改与删除的文件。开启后新文件将自动同步并加入 AI 智能分析队列。'
              )}
            </p>
          </div>
        </div>

        <div className="shrink-0 flex items-center gap-2 pl-2">
          {isTogglingWatch && (
            <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
          )}
          <Switch
            id="auto-watch-switch"
            checked={autoWatch}
            disabled={isTogglingWatch}
            onCheckedChange={handleToggleAutoWatch}
          />
        </div>
      </Card>

      {/* 3. 条目 2: 重新扫描目录变动 (每行一个按钮布局) */}
      <Card className="p-4 flex items-center justify-between gap-4 border-border/70 hover:border-border transition-colors">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0 mt-0.5">
            <RefreshCw className={cn('w-4 h-4', isScanning && 'animate-spin')} />
          </div>
          <div className="space-y-0.5 min-w-0">
            <h4 className="text-sm font-bold text-foreground">{t('重新扫描与变动检测')}</h4>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {t(
                '对物理磁盘文件进行全量比对，检查是否有脱机添加的新文件或改动，并可选择将其推入分析队列。'
              )}
            </p>
          </div>
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isScanning}
          onClick={handleRescanDirectory}
          className="text-xs font-semibold shrink-0 h-8 px-3 flex items-center gap-1.5"
        >
          {isScanning ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Search className="w-3.5 h-3.5" />
          )}
          <span>{t('重新扫描')}</span>
        </Button>
      </Card>

      {/* 4. 条目 3: 扫描并清理空文件夹 (每行一个按钮布局) */}
      <Card className="p-4 flex items-center justify-between gap-4 border-border/70 hover:border-border transition-colors">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0 mt-0.5">
            <FolderX className="w-4 h-4" />
          </div>
          <div className="space-y-0.5 min-w-0">
            <h4 className="text-sm font-bold text-foreground">{t('扫描并清理空文件夹')}</h4>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {t('递归扫描当前目录因整理或删除后遗留的空文件夹，支持查看详情并一键批量清理。')}
            </p>
          </div>
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isScanningEmptyFolders}
          onClick={handleScanEmptyFolders}
          className="text-xs font-semibold shrink-0 h-8 px-3 flex items-center gap-1.5"
        >
          {isScanningEmptyFolders ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <FolderX className="w-3.5 h-3.5" />
          )}
          <span>{t('清理空文件夹')}</span>
        </Button>
      </Card>

      {/* 5. 条目 4: 重新运行场景策略向导 */}
      <Card className="p-4 flex items-center justify-between gap-4 border-border/70 hover:border-border transition-colors">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-purple-500/10 text-purple-600 dark:text-purple-400 flex items-center justify-center shrink-0 mt-0.5">
            <Sparkles className="w-4 h-4" />
          </div>
          <div className="space-y-0.5 min-w-0">
            <h4 className="text-sm font-bold text-foreground">{t('重新运行场景设置向导')}</h4>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {t(
                '重新启动极简向导，由系统再次探测目录内容并提供「极速整理/创意图库/影视素材/桌面杂乱」预设推荐。'
              )}
            </p>
          </div>
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRerunWizard}
          className="text-xs font-semibold shrink-0 h-8 px-3 flex items-center gap-1.5"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          <span>{t('运行向导')}</span>
        </Button>
      </Card>

      {/* 6. 条目 5: 工作流绑定与白名单快照保护 (Ticket 03: 非破坏性快照与独立清空) */}
      <Card className="p-4 border-border/70 hover:border-border transition-colors space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-purple-500/10 text-purple-600 dark:text-purple-400 flex items-center justify-center shrink-0 mt-0.5">
              <Layers className="w-4 h-4" />
            </div>
            <div className="space-y-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h4 className="text-sm font-bold text-foreground">
                  {t('工作流绑定与白名单快照保护')}
                </h4>
                {workspace.bound_workflow_id ? (
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-600 dark:text-purple-400">
                    {t('已绑定: {name}', {
                      name: boundWorkflow ? boundWorkflow.name : workspace.bound_workflow_id
                    })}
                  </span>
                ) : (
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                    {t('未绑定 (通用模式)')}
                  </span>
                )}
                {whitelistPatterns.length > 0 && (
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-600 dark:text-blue-400">
                    {t('白名单快照生效中 ({count})', { count: whitelistPatterns.length })}
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                {workspace.bound_workflow_id
                  ? t(
                      '已绑定专属业务工作流。解除绑定后目录将恢复为通用模式，且自动保留白名单快照防止非目标文件涌入。'
                    )
                  : t(
                      '当前目录未绑定专属工作流。若存在白名单快照，将继续作为安全保护生效，亦可随时清空恢复全量模式。'
                    )}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
            {Boolean(workspace.bound_workflow_id) && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isUnbinding}
                onClick={() => setShowUnbindDialog(true)}
                className="text-xs font-semibold h-8 px-3 text-muted-foreground hover:text-foreground"
              >
                {isUnbinding ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : null}
                <span>{t('解除工作流绑定')}</span>
              </Button>
            )}
            {whitelistPatterns.length > 0 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isClearingWhitelist}
                onClick={() => setShowClearWhitelistDialog(true)}
                className="text-xs font-semibold h-8 px-3 border-amber-500/30 text-amber-600 hover:bg-amber-500/10 dark:text-amber-400"
              >
                {isClearingWhitelist ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : null}
                <span>{t('清空白名单并恢复全量模式')}</span>
              </Button>
            )}
            {!workspace.bound_workflow_id && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onRerunWizard}
                className="text-xs font-semibold h-8 px-3 flex items-center gap-1.5"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>{t('前往绑定工作流')}</span>
              </Button>
            )}
          </div>
        </div>

        {whitelistPatterns.length > 0 && (
          <div className="pt-2 border-t border-border/40 text-[11px] text-muted-foreground flex items-center gap-2 flex-wrap">
            <ShieldCheck className="w-3.5 h-3.5 text-blue-500 shrink-0" />
            <span className="font-medium text-foreground">{t('生效中扩展名快照:')}</span>
            <div className="flex items-center gap-1 flex-wrap font-mono text-[10px]">
              {whitelistPatterns.slice(0, 8).map(ext => (
                <span
                  key={ext}
                  className="px-1.5 py-0.5 rounded bg-muted/80 text-foreground border border-border/60"
                >
                  {ext}
                </span>
              ))}
              {whitelistPatterns.length > 8 && (
                <span className="text-muted-foreground">+{whitelistPatterns.length - 8}</span>
              )}
            </div>
          </div>
        )}
      </Card>

      {/* 6. 条目 5: 两段式安全重置 AI 分析数据 */}
      <Card className="p-4 flex items-center justify-between gap-4 border-destructive/30 bg-destructive/5 dark:bg-destructive/10 hover:border-destructive/40 transition-colors">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-destructive/10 text-destructive flex items-center justify-center shrink-0 mt-0.5">
            <RotateCcw className="w-4 h-4" />
          </div>
          <div className="space-y-0.5 min-w-0">
            <h4 className="text-sm font-bold text-destructive">{t('安全重置目录分析数据')}</h4>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {t(
                '清空当前目录所有文件的 AI 标签、分镜缓存与文本索引。受跨工作区孤儿保护机制守护，共享文件绝不误伤。'
              )}
            </p>
          </div>
        </div>

        <Button
          type="button"
          variant="destructive"
          size="sm"
          onClick={() => setShowResetDialog(true)}
          className="text-xs font-semibold shrink-0 h-8 px-3 shadow-xs flex items-center gap-1.5"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          <span>{t('重置数据...')}</span>
        </Button>
      </Card>

      {/* 7. 条目 6: 从应用中移除工作目录 */}
      <Card className="p-4 flex items-center justify-between gap-4 border-border/70 hover:border-destructive/40 transition-colors">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-destructive/10 text-destructive flex items-center justify-center shrink-0 mt-0.5">
            <Trash2 className="w-4 h-4" />
          </div>
          <div className="space-y-0.5 min-w-0">
            <h4 className="text-sm font-bold text-destructive">{t('从应用中移除工作目录')}</h4>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {t(
                '解除此目录在应用内的绑定并清空其索引记录。此操作完全不会影响或删除物理磁盘上的真实文件。'
              )}
            </p>
          </div>
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setShowDeleteDialog(true)}
          className="text-xs font-semibold text-destructive hover:bg-destructive/10 border-destructive/30 shrink-0 h-8 px-3 flex items-center gap-1.5"
        >
          <Trash2 className="w-3.5 h-3.5" />
          <span>{t('移除目录...')}</span>
        </Button>
      </Card>

      {/* ─── 弹窗区域 ─── */}

      {/* 重置确认对话框 */}
      <AlertDialog open={showResetDialog} onOpenChange={setShowResetDialog}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              <span>{t('确认安全重置「{name}」？', { name: workspace.name })}</span>
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="text-xs leading-relaxed space-y-2 text-muted-foreground">
                <p>
                  {t(
                    '此操作将清空当前目录下所有文件的 AI 分析成果与分镜缓存，但不会删除物理磁盘上的真实文件。'
                  )}
                </p>
                <div className="p-2.5 rounded-lg bg-muted text-muted-foreground flex items-center gap-2 border border-border/50">
                  <ShieldCheck className="h-4 w-4 text-green-500 shrink-0" />
                  <span>{t('受孤儿保护机制守护：其他工作区引用的共享文件自动受到免疫保留。')}</span>
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isResetting}>{t('取消')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={e => {
                e.preventDefault()
                handleExecuteReset()
              }}
              disabled={isResetting}
              className="bg-destructive hover:bg-destructive/90 text-destructive-foreground font-semibold"
            >
              {isResetting ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
              ) : (
                <RotateCcw className="h-4 w-4 mr-1.5" />
              )}
              <span>{t('确认安全重置')}</span>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 移除工作目录确认对话框 */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="h-5 w-5" />
              <span>{t('确认移除工作目录「{name}」？', { name: workspace.name })}</span>
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="text-xs leading-relaxed space-y-2 text-muted-foreground">
                <p>{t('确定要从应用中移除此工作目录吗？相关的文件索引与分析数据将被清理。')}</p>
                <div className="p-2.5 rounded-lg bg-green-500/10 text-green-700 dark:text-green-300 flex items-center gap-2 border border-green-500/20">
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" />
                  <span>{t('安全保障：物理磁盘上的文件和文件夹 100% 完好无损。')}</span>
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>{t('取消')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={e => {
                e.preventDefault()
                handleExecuteDelete()
              }}
              disabled={isDeleting}
              className="bg-destructive hover:bg-destructive/90 text-destructive-foreground font-semibold"
            >
              {isDeleting ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
              ) : (
                <Trash2 className="h-4 w-4 mr-1.5" />
              )}
              <span>{t('确认移除')}</span>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 解除工作流绑定确认对话框 (非破坏性快照保护) */}
      <AlertDialog open={showUnbindDialog} onOpenChange={setShowUnbindDialog}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Layers className="h-5 w-5 text-primary" />
              <span>{t('确认解除工作流绑定？')}</span>
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="text-xs leading-relaxed space-y-2 text-muted-foreground">
                <p>
                  {t('解除工作流绑定后，该目录将切换为通用管理模式，不再受特定工作流规则统领。')}
                </p>
                <div className="p-2.5 rounded-lg bg-blue-500/10 text-blue-700 dark:text-blue-300 flex items-start gap-2 border border-blue-500/20">
                  <ShieldCheck className="h-4 w-4 text-blue-500 shrink-0 mt-0.5" />
                  <span>
                    {t(
                      '【快照安全保护】：为防止非目标垃圾文件骤然涌入分析队列，当前生效的白名单扩展名（共 {count} 项）将作为安全快照完整保留。',
                      { count: whitelistPatterns.length }
                    )}
                  </span>
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex flex-col sm:flex-row gap-2">
            <AlertDialogCancel disabled={isUnbinding} className="text-xs">
              {t('取消')}
            </AlertDialogCancel>
            <Button
              type="button"
              variant="default"
              disabled={isUnbinding}
              onClick={handleUnbindWorkflow}
              className="text-xs font-semibold flex items-center gap-1.5"
            >
              {isUnbinding && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              <span>{t('解除绑定 (保留快照)')}</span>
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 清空白名单并恢复全量模式确认对话框 */}
      <AlertDialog open={showClearWhitelistDialog} onOpenChange={setShowClearWhitelistDialog}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
              <AlertTriangle className="h-5 w-5" />
              <span>{t('确认清空白名单并恢复全量模式？')}</span>
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="text-xs leading-relaxed space-y-2 text-muted-foreground">
                <p>
                  {t(
                    '清空白名单后，目录将恢复为标准全量入场模式。除系统与自定义排除规则拦截的项目外，所有新增与存量合法文件都将纳入扫描与 AI 分析队列。'
                  )}
                </p>
                <div className="p-2.5 rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-300 flex items-start gap-2 border border-amber-500/20">
                  <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
                  <span>
                    {t('此操作将清空当前已配置的 {count} 项扩展名放行白名单，并触发增量补扫。', {
                      count: whitelistPatterns.length
                    })}
                  </span>
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex flex-col sm:flex-row gap-2">
            <AlertDialogCancel disabled={isClearingWhitelist} className="text-xs">
              {t('取消')}
            </AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              disabled={isClearingWhitelist}
              onClick={handleClearWhitelist}
              className="text-xs font-semibold flex items-center gap-1.5"
            >
              {isClearingWhitelist && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              <span>{t('清空白名单并恢复全量')}</span>
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 重新扫描差异预览对话框 */}
      {showRescanDialog && rescanData && (
        <RescanPreviewDialog
          isOpen={showRescanDialog}
          onClose={() => {
            setShowRescanDialog(false)
            setRescanData(null)
          }}
          workspaceDirectoryPath={workspace.path}
          workspaceDirectoryName={workspace.name}
          newFiles={rescanData.newFiles}
          modifiedFiles={rescanData.modifiedFiles}
          onAddToQueue={async files => {
            if (window.electronAPI?.addToAnalysisQueue) {
              await window.electronAPI.addToAnalysisQueue(files, true)
              if (window.electronAPI?.startAnalysis) {
                await window.electronAPI.startAnalysis()
              }
            }
          }}
        />
      )}

      {/* 空文件夹清理对话框 */}
      {showEmptyFolderDialog && workspace.path && (
        <EmptyFolderCleanupDialog
          isOpen={showEmptyFolderDialog}
          onClose={() => setShowEmptyFolderDialog(false)}
          workspaceDirectoryPath={workspace.path}
        />
      )}
    </div>
  )
}
