import React, { useState, useMemo } from 'react'
import {
  WorkspaceDirectory,
  WorkspaceConfig,
  parseWorkspaceConfig
} from '@firefly/types'
import { Card } from '../../ui/card'
import { Button } from '../../ui/button'
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
  Layers
} from 'lucide-react'

export interface WorkspaceMaintenanceTabProps {
  workspace: WorkspaceDirectory
  onRerunWizard: () => void
  onConfigSaved?: () => void
}

/**
 * 工作区专有：目录维护与安全重置面板 (TASK-11)
 *
 * 核心功能：
 * 1. 展示目录基础信息、路径与分析状态统计；
 * 2. 提供「重新运行设置向导」入口，随时切换场景意图；
 * 3. 承载两段式安全重置操作（由创世 DDL 与 NOT EXISTS 孤儿保护机制守护）。
 */
export const WorkspaceMaintenanceTab: React.FC<WorkspaceMaintenanceTabProps> = ({
  workspace,
  onRerunWizard,
  onConfigSaved
}) => {
  const [showResetDialog, setShowResetDialog] = useState(false)
  const [isResetting, setIsResetting] = useState(false)

  // 解析当前工作区配置
  const parsedConfig = useMemo<WorkspaceConfig>(() => {
    return parseWorkspaceConfig(workspace.workspace_config)
  }, [workspace.workspace_config])

  const isReady = parsedConfig.status === 'ready'

  // 执行两段式安全重置
  const handleExecuteReset = async () => {
    if (!workspace.path) return
    setIsResetting(true)
    try {
      if (window.electronAPI?.resetWorkspaceDirectory) {
        await window.electronAPI.resetWorkspaceDirectory(workspace.path)
        toast.success(
          t('工作区分析数据已安全重置，被其他目录共享的文件已依法完整保留。')
        )
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

  return (
    <div className="p-6 space-y-6 max-w-4xl mx-auto overflow-y-auto max-h-full">
      {/* 头部说明 */}
      <div className="pb-3 border-b border-border/60">
        <h3 className="text-lg font-bold flex items-center gap-2">
          <HardDrive className="w-5 h-5 text-primary" />
          <span>{t('目录维护与安全重置')}</span>
        </h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          {t('查看当前工作目录状态，重新运行分析策略向导，或安全重置该目录的分析数据。')}
        </p>
      </div>

      {/* 1. 目录物理信息与状态卡片 */}
      <Card className="p-5 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
              <FolderOpen className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h4 className="font-bold text-sm text-foreground truncate">{workspace.name}</h4>
              <p className="text-xs text-muted-foreground font-mono truncate mt-0.5">
                {workspace.path}
              </p>
            </div>
          </div>

          <div className="shrink-0">
            {isReady ? (
              <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-green-500/15 text-green-600 dark:text-green-400">
                {t('就绪 (Ready)')}
              </span>
            ) : (
              <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400">
                {t('挂起待配置 (Pending)')}
              </span>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-border/40 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-muted-foreground shrink-0" />
            <span>{t('当前生效意图: ')}</span>
            <span className="font-semibold text-foreground font-mono">
              {isReady ? parsedConfig.intent : t('未指定')}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-muted-foreground shrink-0" />
            <span>{t('添加时间: ')}</span>
            <span className="font-semibold text-foreground">
              {workspace.createdAt ? new Date(workspace.createdAt).toLocaleString() : '-'}
            </span>
          </div>
        </div>
      </Card>

      {/* 2. 重新运行向导入口 */}
      <Card className="p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-muted/20 border-border/70">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-primary shrink-0" />
            <h4 className="font-bold text-sm text-foreground">{t('重新运行场景设置向导')}</h4>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            {t(
              '如果不确定底层参数如何调整，可随时重新启动向导。系统将再次探测目录内容并提供 4 大场景预设。'
            )}
          </p>
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRerunWizard}
          className="text-xs font-semibold flex items-center gap-1.5 shrink-0 h-8"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          <span>{t('重新运行向导')}</span>
        </Button>
      </Card>

      {/* 3. 两段式安全重置操作 */}
      <Card className="p-5 border-destructive/30 bg-destructive/5 dark:bg-destructive/10 space-y-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-destructive shrink-0" />
          <h4 className="font-bold text-sm text-destructive">{t('安全重置目录分析数据')}</h4>
        </div>

        <p className="text-xs text-muted-foreground leading-relaxed">
          {t(
            '重置该目录下的所有 AI 标签、视频分镜快照与文本索引，重置后文件将重新进入待分析队列。系统内嵌「跨工作区孤儿保护机制」：若某些文件同时被其他工作目录包含，其向量与分析数据将安全保留，绝不误伤共享资产。'
          )}
        </p>

        <div className="pt-2 flex justify-end">
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={() => setShowResetDialog(true)}
            className="text-xs font-semibold flex items-center gap-1.5 h-8 px-3 shadow-xs"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>{t('重置分析数据...')}</span>
          </Button>
        </div>
      </Card>

      {/* 重置确认对话框 */}
      <AlertDialog open={showResetDialog} onOpenChange={setShowResetDialog}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              <span>{t('确认重置「{name}」？', { name: workspace.name })}</span>
            </AlertDialogTitle>
            <AlertDialogDescription className="text-xs leading-relaxed space-y-2">
              <p>
                {t('此操作将清空当前目录下所有文件的 AI 分析成果与分镜缓存，但不会删除物理磁盘上的真实文件。')}
              </p>
              <div className="p-2.5 rounded-lg bg-muted text-muted-foreground flex items-center gap-2 border border-border/50">
                <ShieldCheck className="h-4 w-4 text-green-500 shrink-0" />
                <span>{t('受孤儿保护机制守护：其他工作区引用的共享文件自动受到免疫保留。')}</span>
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
                <Trash2 className="h-4 w-4 mr-1.5" />
              )}
              <span>{t('确认安全重置')}</span>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
