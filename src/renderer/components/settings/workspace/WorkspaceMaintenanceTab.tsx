import React, { useState, useMemo } from 'react'
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

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-border/40 text-[11px] text-muted-foreground">
          <div className="flex items-center gap-2">
            <Layers className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
            <span>{t('场景意图: ')}</span>
            <span className="font-semibold text-foreground">
              {isReady ? getIntentDisplayName(parsedConfig.intent) : t('未指定')}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <Calendar className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
            <span>{t('添加时间: ')}</span>
            <span className="font-semibold text-foreground">
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
