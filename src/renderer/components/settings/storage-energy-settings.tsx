import React, { useState, useEffect } from 'react'
import { FolderOpen, AlertTriangle, HardDrive, Trash2, Loader2, Check } from 'lucide-react'
import { Card } from '../ui/card'
import { Label } from '../ui/label'
import { Switch } from '../ui/switch'
import { Button } from '../ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '../ui/alert-dialog'
import { useSettingsConfig, useSettingsStore } from '../../stores/settings-store'
import { usePluginCenterStore, formatPluginErrorMessage } from '../../stores/plugin-center-store'
import { toast } from '../common/Toast'
import { t } from '@app/languages'

/**
 * 格式化字节为人类友好字符串 (1024 进制)
 */
function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = bytes
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex++
  }
  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

/**
 * 存储与节能设置组件 (系统全局设置独立 Tab)
 * 汇聚原本散落在「界面与显示偏好」中的三项与存储/能耗相关的配置：
 *  - 启用智能休眠节能
 *  - 插件存储目录 (含安全迁移与旧目录清理)
 *  - 缩略图与语音缓存目录 (全局共享公共资源目录)
 */
export const StorageEnergySettings: React.FC = () => {
  useSettingsConfig()
  const getConfigValue = useSettingsStore(s => s.getConfigValue)
  const updateConfigValue = useSettingsStore(s => s.updateConfigValue)

  // 目录管理与安全迁移 Store 订阅
  const dirInfo = usePluginCenterStore(s => s.dirInfo)
  const dirPhase = usePluginCenterStore(s => s.dirPhase)
  const isOldDirCleanupDismissed = usePluginCenterStore(s => s.isOldDirCleanupDismissed)
  const dirMigrationProgress = usePluginCenterStore(s => s.dirMigrationProgress)
  const loadDirInfo = usePluginCenterStore(s => s.loadDirInfo)
  const pickDirectory = usePluginCenterStore(s => s.pickDirectory)
  const validatePluginDir = usePluginCenterStore(s => s.validatePluginDir)
  const changePluginDir = usePluginCenterStore(s => s.changePluginDir)
  const cancelDirMigration = usePluginCenterStore(s => s.cancelDirMigration)
  const cleanupOldDir = usePluginCenterStore(s => s.cleanupOldDir)
  const dismissOldDirCleanup = usePluginCenterStore(s => s.dismissOldDirCleanup)
  const subscribeDirMigrationProgress = usePluginCenterStore(s => s.subscribeDirMigrationProgress)
  const restartApp = usePluginCenterStore(s => s.restartApp)

  const [migrationTarget, setMigrationTarget] = useState<string | null>(null)
  const [migrationDiagnostics, setMigrationDiagnostics] = useState<any | null>(null)
  const [showConfirmMigrationDialog, setShowConfirmMigrationDialog] = useState(false)
  const [showRestartDialog, setShowRestartDialog] = useState(false)
  const [isCleaningOldDir, setIsCleaningOldDir] = useState(false)
  const [isStartingMigration, setIsStartingMigration] = useState(false)

  // 全局公共资源目录（缩略图与语音合成音频共享目录）状态
  const [commonResourceInfo, setCommonResourceInfo] = useState<{
    currentPath: string
    configuredPath: string
    defaultPath: string
    isCustom: boolean
    isFallback: boolean
    fallbackReason?: string
  } | null>(null)
  const [isUpdatingCommonResourceDir, setIsUpdatingCommonResourceDir] = useState(false)

  const loadCommonResourceInfo = async () => {
    try {
      const api = (window.electronAPI as any)?.commonResourceDir
      if (!api?.getInfo) return
      const res = await api.getInfo()
      if (res?.success && res.data) {
        setCommonResourceInfo(res.data)
      }
    } catch (err) {
      console.warn('获取缩略图与语音缓存目录信息失败:', err)
    }
  }

  const handleChangeCommonResourceDir = async () => {
    const api = (window.electronAPI as any)?.commonResourceDir
    if (!api?.pick || !api?.setPath) return
    try {
      const pickRes = await api.pick()
      if (pickRes?.canceled || !pickRes?.path) return
      setIsUpdatingCommonResourceDir(true)
      const setRes = await api.setPath(pickRes.path)
      if (setRes?.success) {
        if (setRes.data) setCommonResourceInfo(setRes.data)
        else await loadCommonResourceInfo()
        toast.success(t('已更新缩略图与语音缓存目录，新生成的文件将保存到新位置'))
      } else {
        toast.error(setRes?.error || t('所选目录不可写入，请更换其他文件夹'))
      }
    } catch (err: any) {
      toast.error(err?.message || t('更改目录失败，请稍后重试'))
    } finally {
      setIsUpdatingCommonResourceDir(false)
    }
  }

  const handleResetCommonResourceDir = async () => {
    const api = (window.electronAPI as any)?.commonResourceDir
    if (!api?.reset) return
    try {
      setIsUpdatingCommonResourceDir(true)
      const resetRes = await api.reset()
      if (resetRes?.success) {
        if (resetRes.data) setCommonResourceInfo(resetRes.data)
        else await loadCommonResourceInfo()
        toast.success(t('已恢复为默认缓存目录'))
      } else {
        toast.error(resetRes?.error || t('恢复默认目录失败'))
      }
    } catch (err: any) {
      toast.error(err?.message || t('恢复默认目录失败'))
    } finally {
      setIsUpdatingCommonResourceDir(false)
    }
  }

  // 初始化拉取目录信息与监听进度
  useEffect(() => {
    loadDirInfo()
    loadCommonResourceInfo()
    const unsubscribe = subscribeDirMigrationProgress()
    return () => {
      unsubscribe()
    }
  }, [loadDirInfo, subscribeDirMigrationProgress])

  /**
   * 选择新目录并校验
   */
  const handlePickAndChangeDir = async () => {
    try {
      const chosenPath = await pickDirectory()
      if (!chosenPath) return

      const validation = await validatePluginDir(chosenPath)
      if (!validation.valid) {
        const errorMsg =
          formatPluginErrorMessage({ code: validation.errorCode }) ||
          validation.errorMessage ||
          t('所选路径不满足要求')
        toast.error(errorMsg)
        return
      }

      setMigrationTarget(chosenPath)
      setMigrationDiagnostics(validation.diagnostics || null)
      setShowConfirmMigrationDialog(true)
    } catch (err: any) {
      toast.error(formatPluginErrorMessage(err))
    }
  }

  /**
   * 确认并开始流式迁移
   */
  const handleConfirmMigration = async () => {
    if (!migrationTarget) return
    setShowConfirmMigrationDialog(false)
    setIsStartingMigration(true)
    try {
      const res = await changePluginDir(migrationTarget)
      if (res && !res.success && res.errorCode) {
        toast.error(formatPluginErrorMessage({ code: res.errorCode }))
      } else {
        setShowRestartDialog(true)
      }
    } catch (err: any) {
      toast.error(formatPluginErrorMessage(err))
    } finally {
      setIsStartingMigration(false)
    }
  }

  /**
   * 取消迁移
   */
  const handleCancelMigration = async () => {
    try {
      const res = await cancelDirMigration()
      if (!res.cancelled && res.errorCode) {
        toast.error(formatPluginErrorMessage({ code: res.errorCode }))
      } else {
        toast.info(t('已取消插件目录迁移'))
      }
    } catch (err: any) {
      toast.error(formatPluginErrorMessage(err))
    }
  }

  /**
   * 清理旧目录残留
   */
  const handleCleanupOldDir = async () => {
    setIsCleaningOldDir(true)
    try {
      const res = await cleanupOldDir()
      if (res.success) {
        toast.success(t(`旧插件目录清理完成，已释放 ${formatBytes(res.freedBytes)} 空间`))
      } else {
        toast.error(formatPluginErrorMessage({ code: res.errorCode || 'UNKNOWN_ERROR' }))
      }
    } catch (err: any) {
      toast.error(formatPluginErrorMessage(err))
    } finally {
      setIsCleaningOldDir(false)
    }
  }

  /**
   * 忽略旧目录清理
   */
  const handleDismissOldDirCleanup = async () => {
    await dismissOldDirCleanup()
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-2">{t('存储与节能')}</h3>
        <p className="text-sm text-muted-foreground">
          {t('管理模型与插件的存放位置、共享缓存目录，以及闲置时的节能策略')}
        </p>
      </div>

      {/* 智能休眠与能耗保护 */}
      <Card className="p-4 bg-card dark:bg-card">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <Label
              htmlFor="smart-hibernation"
              className="text-base font-medium text-card-foreground cursor-pointer"
            >
              {t('启用智能休眠节能')}
            </Label>
            <p className="text-sm text-muted-foreground">
              {t(
                '开启后将在模块闲置且电脑内存紧张时自动释放内存，为电脑节能省电；首次使用对应功能时需短暂加载，就绪后后续使用无需等待。'
              )}
            </p>
          </div>
          <Switch
            id="smart-hibernation"
            checked={getConfigValue<boolean>('ENABLE_SMART_MODULE_HIBERNATION' as any) ?? true}
            onCheckedChange={checked => {
              updateConfigValue('ENABLE_SMART_MODULE_HIBERNATION' as any, checked)
            }}
          />
        </div>
      </Card>

      {/* 插件存储目录设置 (Issue 06 Spec §7.4) */}
      <Card className="p-4" data-testid="plugin-dir-settings-card">
        <div className="space-y-4">
          <div>
            <Label className="text-base font-medium">{t('插件存储目录')}</Label>
            <p className="text-sm text-muted-foreground mt-1">
              {t('存放 AI 大脑模型与功能扩展组件的本地文件夹')}
            </p>
          </div>

          {/* 中文路径警告横幅 (RULE 2.16 & Spec §7.4) */}
          {dirInfo?.defaultDirNonAscii && (
            <div
              data-testid="non-ascii-warning-banner"
              className="flex items-start gap-2.5 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-400 text-xs"
            >
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                {t(
                  '当前默认插件存储路径包含中文字符，可能影响部分 AI 模型稳定运行，强烈建议更改到纯英文磁盘目录'
                )}
              </span>
            </div>
          )}

          {/* 待重启提示条 */}
          {dirPhase === 'PENDING_RESTART' && (
            <div
              data-testid="dir-pending-restart-card-banner"
              className="flex items-center justify-between p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs"
            >
              <div className="flex items-center gap-2 text-amber-700 dark:text-amber-400">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>{t('插件目录已迁移完成，需重启软件以加载新目录资源')}</span>
              </div>
              <Button
                size="sm"
                className="h-7 px-2.5 text-xs bg-amber-600 hover:bg-amber-700 text-white cursor-pointer"
                onClick={() => restartApp()}
              >
                {t('立即重启')}
              </Button>
            </div>
          )}

          {/* 迁移中进度展示 */}
          {dirPhase === 'MIGRATING' && (
            <div
              data-testid="dir-migration-progress-card"
              className="space-y-2 p-3 bg-muted/40 rounded-lg border border-border"
            >
              <div className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-1.5 font-medium text-primary">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  {t('正在迁移插件与模型文件...')}
                </span>
                <span className="font-mono text-muted-foreground">
                  {dirMigrationProgress?.percentage ?? 0}% ({dirMigrationProgress?.copiedFiles ?? 0}{' '}
                  / {dirMigrationProgress?.totalFiles ?? 0} {t('个文件')})
                </span>
              </div>
              <div className="w-full bg-secondary rounded-full h-2 overflow-hidden">
                <div
                  className="bg-primary h-full transition-all duration-300"
                  style={{ width: `${dirMigrationProgress?.percentage ?? 0}%` }}
                />
              </div>
              {dirMigrationProgress?.currentFile && (
                <p className="text-[11px] text-muted-foreground truncate font-mono">
                  {dirMigrationProgress.currentFile}
                </p>
              )}
              <div className="flex justify-end pt-1">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleCancelMigration}
                  className="h-7 text-xs"
                >
                  {t('取消迁移')}
                </Button>
              </div>
            </div>
          )}

          {/* 路径展示与更改操作 */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 rounded-lg bg-muted/30 border border-border">
            <div className="space-y-1 min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <HardDrive className="w-4 h-4 text-muted-foreground shrink-0" />
                <span className="text-xs font-mono font-medium truncate select-all">
                  {dirInfo?.currentPath || dirInfo?.currentDir || t('正在获取目录信息...')}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {t('已占用空间')}:{' '}
                <span className="font-medium text-foreground">
                  {formatBytes(dirInfo?.usedBytes)}
                </span>
              </p>
            </div>

            <Button
              size="sm"
              variant="outline"
              data-testid="change-plugin-dir-button"
              disabled={dirPhase === 'MIGRATING' || isStartingMigration}
              onClick={handlePickAndChangeDir}
              className="h-8 px-3 text-xs shrink-0 cursor-pointer flex items-center gap-1.5"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              <span>{t('更改目录')}</span>
            </Button>
          </div>
        </div>
      </Card>

      {/* 全局共享缩略图与语音缓存目录卡片 */}
      <Card className="p-4" data-testid="common-resource-dir-card">
        <div className="space-y-3">
          <div>
            <Label className="text-base font-medium text-foreground">
              {t('缩略图与语音缓存目录')}
            </Label>
            <p className="text-sm text-muted-foreground mt-1">
              {t(
                '统一存放所有工作目录共享的缩略图和语音朗读音频，更换文件夹或清理工作区时无需重新生成；可改存到空间更大的磁盘。'
              )}
            </p>
          </div>

          {commonResourceInfo?.isFallback && (
            <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-700 dark:text-amber-400">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                {t(
                  '您设置的目录当前不可访问或无法写入，已临时改存至系统临时文件夹，请检查磁盘连接或重新选择目录。'
                )}
              </span>
            </div>
          )}

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 rounded-lg bg-muted/30 border border-border">
            <div className="space-y-1 min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <HardDrive className="w-4 h-4 text-muted-foreground shrink-0" />
                <span
                  className="text-xs font-mono font-medium truncate select-all"
                  data-testid="common-resource-dir-path"
                >
                  {commonResourceInfo?.currentPath || t('正在获取目录信息...')}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {commonResourceInfo?.isCustom
                  ? t('当前使用自定义保存位置，切换后旧目录中已生成的缓存仍会自动复用。')
                  : t('当前使用软件默认数据目录，跨所有工作目录全局共享。')}
              </p>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {commonResourceInfo?.isCustom && (
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="reset-common-resource-dir-button"
                  disabled={isUpdatingCommonResourceDir}
                  onClick={handleResetCommonResourceDir}
                  className="h-8 px-2.5 text-xs cursor-pointer"
                >
                  {t('恢复默认')}
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                data-testid="change-common-resource-dir-button"
                disabled={isUpdatingCommonResourceDir}
                onClick={handleChangeCommonResourceDir}
                className="h-8 px-3 text-xs cursor-pointer flex items-center gap-1.5"
              >
                {isUpdatingCommonResourceDir ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <FolderOpen className="w-3.5 h-3.5" />
                )}
                <span>{t('更改目录')}</span>
              </Button>
            </div>
          </div>
        </div>
      </Card>

      {/* 旧插件目录清理卡片 (Spec §7.4 & Issue 04) */}
      {dirInfo?.previousPath &&
        !isOldDirCleanupDismissed &&
        dirInfo?.previousPathExists !== false && (
          <Card className="p-4 border-amber-500/20" data-testid="old-dir-cleanup-card">
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <Label className="text-base font-medium text-foreground flex items-center gap-1.5">
                    <Trash2 className="w-4 h-4 text-amber-500" />
                    <span>{t('清理旧插件目录残留')}</span>
                  </Label>
                  <p className="text-sm text-muted-foreground mt-1">
                    {t('检测到此前迁移遗留的旧目录，可安全清理以释放磁盘空间：')}
                  </p>
                </div>
              </div>

              <div className="p-2.5 rounded bg-muted/40 font-mono text-xs text-muted-foreground truncate select-all">
                {dirInfo.previousPath}
              </div>

              <div className="flex items-center justify-end gap-2 pt-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={handleDismissOldDirCleanup}
                  className="h-8 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
                >
                  {t('忽略')}
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  data-testid="cleanup-old-dir-btn"
                  disabled={isCleaningOldDir || dirPhase === 'MIGRATING'}
                  onClick={handleCleanupOldDir}
                  className="h-8 text-xs cursor-pointer flex items-center gap-1.5"
                >
                  {isCleaningOldDir ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="w-3.5 h-3.5" />
                  )}
                  <span>{t('立即清理')}</span>
                </Button>
              </div>
            </div>
          </Card>
        )}

      {/* 迁移确认对话框 */}
      <AlertDialog open={showConfirmMigrationDialog} onOpenChange={setShowConfirmMigrationDialog}>
        <AlertDialogContent className="border-2 border-border">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-lg">
              <FolderOpen className="w-5 h-5 text-primary" />
              {t('确认迁移插件存储目录')}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm text-foreground pt-1">
                <p>
                  {t(
                    '系统将把现有的插件与模型数据安全复制到新目录。迁移期间原目录资源保持只读保护。'
                  )}
                </p>
                <div className="p-3 bg-muted/40 rounded-lg space-y-1.5 font-mono text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('新存储路径')}:</span>
                    <span className="font-semibold truncate max-w-[240px]">{migrationTarget}</span>
                  </div>
                  {migrationDiagnostics && (
                    <>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{t('目标盘可用空间')}:</span>
                        <span>{formatBytes(migrationDiagnostics.targetFreeBytes)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{t('预估待迁移大小')}:</span>
                        <span>{formatBytes(migrationDiagnostics.requiredBytes)}</span>
                      </div>
                    </>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('迁移完成后需重启软件以正式加载新位置的模型与插件。')}
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button variant="outline" onClick={() => setShowConfirmMigrationDialog(false)}>
                {t('取消')}
              </Button>
            </AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button
                onClick={handleConfirmMigration}
                className="bg-primary text-primary-foreground"
              >
                {t('开始迁移')}
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 迁移完成重启提示框 */}
      <AlertDialog open={showRestartDialog} onOpenChange={setShowRestartDialog}>
        <AlertDialogContent className="border-2 border-border">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-primary flex items-center gap-2 text-lg">
              <Check className="w-5 h-5" />
              {t('插件目录迁移完成')}
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-2 text-sm text-foreground pt-1">
              {t('插件与模型已成功复制到新位置。需重启软件以加载新目录资源，您希望现在重启吗？')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button variant="outline" onClick={() => setShowRestartDialog(false)}>
                {t('稍后重启')}
              </Button>
            </AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button
                onClick={() => restartApp()}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {t('立即重启')}
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
