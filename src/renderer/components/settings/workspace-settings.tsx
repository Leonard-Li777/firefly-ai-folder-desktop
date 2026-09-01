import React, { useState, useEffect } from 'react'
import { Card } from '../ui/card'
import { Label } from '../ui/label'
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
import { useSettingsStore } from '../../stores/settings-store'
import { WorkspaceDirectory } from '@firefly/types'
import {
  Trash2,
  RefreshCw,
  FolderOpen,
  AlertTriangle,
  Calendar,
  HardDrive,
  Search,
  Eraser,
  FolderX
} from 'lucide-react'
import { toast } from '../common/Toast'
import { EmptyFolderCleanupDialog } from '../organize/EmptyFolderCleanupDialog'
import { RescanPreviewDialog } from './RescanPreviewDialog'
import { t } from '@app/languages'
import { formatFileSize, formatDateTime } from '@firefly/shared'

/**
 * 工作目录设置组件
 */
export const MonitoringSettings: React.FC = () => {
  const deleteWorkspaceDirectory = useSettingsStore(s => s.deleteWorkspaceDirectory)
  const resetWorkspaceDirectory = useSettingsStore(s => s.resetWorkspaceDirectory)
  const isLoading = useSettingsStore(s => s.isLoading)
  const error = useSettingsStore(s => s.error)
  const [workspaceDirectories, setWorkspaceDirectories] = useState<WorkspaceDirectory[]>([])
  const [loadingDirectories, setLoadingDirectories] = useState(true)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [showResetDialog, setShowResetDialog] = useState(false)
  const [currentDirectory, setCurrentDirectory] = useState<WorkspaceDirectory | null>(null)
  const [rescanResult, setRescanResult] = useState<any>(null)
  const [showEmptyFolderCleanupDialog, setShowEmptyFolderCleanupDialog] = useState(false)
  const [emptyFolderCleanupPath, setEmptyFolderCleanupPath] = useState<string>('')
  const [showRescanPreviewDialog, setShowRescanPreviewDialog] = useState(false)
  const [scanningWorkspaceId, setScanningWorkspaceId] = useState<number | null>(null)

  /**
   * 加载工作目录列表
   */
  const loadWorkspaceDirectories = async () => {
    try {
      setLoadingDirectories(true)
      console.log('开始加载工作目录...')

      if (typeof window.electronAPI?.getAllWorkspaceDirectories === 'function') {
        console.log('调用 getAllWorkspaceDirectories API...')
        const directories = await window.electronAPI!.getAllWorkspaceDirectories()
        console.log('获取到工作目录:', directories)
        setWorkspaceDirectories(directories || [])
      }
    } catch (error) {
      console.error('加载工作目录失败:', error)
      setWorkspaceDirectories([])
    } finally {
      setLoadingDirectories(false)
    }
  }

  useEffect(() => {
    loadWorkspaceDirectories()

    // 监听工作目录更新事件，当其他地方删除或添加目录时自动刷新
    const unsubscribe = window.electronAPI?.onWorkspaceDirectoriesUpdated?.(() => {
      console.log('收到工作目录更新事件，重新加载...')
      // 直接调用 API 获取最新数据，避免闭包问题
      window.electronAPI!.getAllWorkspaceDirectories().then(directories => {
        console.log('刷新后获取到工作目录:', directories)
        setWorkspaceDirectories(directories || [])
      })
    })

    return () => {
      if (unsubscribe) unsubscribe()
    }
  }, [])

  /**
   * 处理删除工作目录
   */
  const handleDeleteDirectory = (directory: WorkspaceDirectory) => {
    setCurrentDirectory(directory)
    setShowDeleteDialog(true)
  }

  /**
   * 确认删除工作目录
   */
  const handleConfirmDelete = async () => {
    if (!currentDirectory) return

    setShowDeleteDialog(false)

    try {
      console.log(`开始删除目录: ${currentDirectory.name}`)

      // 检查是否删除的是当前工作目录
      const currentWorkspaceDir = await window.electronAPI?.getCurrentWorkspaceDirectory()
      const isPathEqual =
        window.electronAPI?.utils?.isPathEqual || ((a: string, b: string) => a === b)
      const isDeletingCurrentDir =
        currentWorkspaceDir && isPathEqual(currentWorkspaceDir.path, currentDirectory.path)

      // 调用后端API删除工作目录
      if (typeof window.electronAPI?.deleteWorkspaceDirectory === 'function') {
        const result = await window.electronAPI!.deleteWorkspaceDirectory(currentDirectory.path)
        // 后端可能返回 success:false（如删除未生效），此时应视为失败并提示用户
        if (!result?.success) {
          throw new Error(result?.error || t('删除工作目录失败，请重试'))
        }
      }

      // 如果删除的是当前工作目录，清空当前选择
      if (
        isDeletingCurrentDir &&
        typeof window.electronAPI?.setCurrentWorkspaceDirectory === 'function'
      ) {
        await window.electronAPI!.setCurrentWorkspaceDirectory('')
      }

      // 重新加载目录列表
      await loadWorkspaceDirectories()

      console.log(`删除完成: ${currentDirectory.name}`)

      // 显示成功消息
      toast.success(t('工作目录 "{}" 已删除', [currentDirectory.name]))
    } catch (error) {
      console.error('删除工作目录失败:', error)
      toast.error(
        t('删除工作目录失败: {}', [error instanceof Error ? error.message : t('未知错误')])
      )
    } finally {
      setCurrentDirectory(null)
    }
  }

  /**
   * 处理重置工作目录
   */
  const handleResetDirectory = (directory: WorkspaceDirectory) => {
    setCurrentDirectory(directory)
    setShowResetDialog(true)
  }

  /**
   * 确认重置工作目录
   */
  const handleConfirmReset = async () => {
    if (!currentDirectory) return

    setShowResetDialog(false)

    try {
      console.log(`开始重置目录: ${currentDirectory.name}`)

      // 调用后端API重置工作目录
      if (typeof window.electronAPI?.resetWorkspaceDirectory === 'function') {
        await window.electronAPI!.resetWorkspaceDirectory(currentDirectory.path)
      }

      // 重新加载目录列表
      await loadWorkspaceDirectories()

      // 清理虚拟目录的选中状态缓存并触发事件
      localStorage.removeItem('virtualDir_selectedTags')
      localStorage.removeItem('virtualDir_selectionStack')
      window.dispatchEvent(new CustomEvent('workspace-reset'))

      console.log(`重置完成: ${currentDirectory.name}`)

      // 显示成功消息
      toast.success(t('目录 "{}" 已重置为未分析状态', [currentDirectory.name]))
    } catch (error) {
      console.error('重置工作目录失败:', error)
      toast.error(t('重置目录失败: {}', [error instanceof Error ? error.message : t('未知错误')]))
    } finally {
      setCurrentDirectory(null)
    }
  }

  /**
   * 处理重新扫描目录
   */
  const handleRescanDirectory = async (directory: WorkspaceDirectory) => {
    if (!directory.id) return

    try {
      console.log(`开始重新扫描目录: ${directory.name}`)
      setScanningWorkspaceId(directory.id)

      // 调用后端API重新扫描目录
      if (typeof window.electronAPI?.rescanWorkspaceDirectory === 'function') {
        const result = await window.electronAPI!.rescanWorkspaceDirectory(directory.id)
        console.log(`重新扫描完成: ${directory.name}`, result)

        // 重新加载目录列表以更新扫描时间
        await loadWorkspaceDirectories()

        // 检查是否有变更
        const hasChanges =
          ((result as any).stats?.newFiles?.length || 0) > 0 ||
          ((result as any).stats?.modifiedFiles?.length || 0) > 0

        if (hasChanges) {
          // 有变更，显示差异预览对话框
          setCurrentDirectory(directory)
          setRescanResult(result)
          setShowRescanPreviewDialog(true)
        } else {
          // 没有变化，显示Toast提示
          toast.info(t('当前目录无变更'))
        }
      } else {
        // 如果API不可用，显示提示
        console.log('rescanWorkspaceDirectory API 不可用')
        toast.warning(t('重新扫描API不可用\n目录: {}', [directory.name]))
      }
    } catch (error) {
      console.error('重新扫描目录失败:', error)
      toast.error(
        t('重新扫描目录失败: {}', [error instanceof Error ? error.message : t('未知错误')])
      )
    } finally {
      setScanningWorkspaceId(null)
    }
  }

  /**
   * 处理RescanPreviewDialog中的加入队列操作
   */
  const handleAddFilesToQueue = async (
    files: Array<{ path: string; name: string; size: number; type: string }>
  ) => {
    try {
      // 添加到分析队列
      if (typeof window.electronAPI?.addToAnalysisQueue === 'function') {
        await window.electronAPI!.addToAnalysisQueue(files, true)

        // 启动分析
        if (typeof window.electronAPI?.startAnalysis === 'function') {
          await window.electronAPI!.startAnalysis()
        }
      }
    } catch (error: any) {
      // 提取实际错误消息，去掉 IPC 调用前缀
      let errorMsg = error?.message || t('未知错误')
      const match = errorMsg.match(/Error invoking remote method '[^']+':\s*(.*)/)
      if (match && match[1]) {
        errorMsg = match[1]
      }

      // 配额错误显示友好消息
      if (errorMsg.includes('配额')) {
        toast.error(errorMsg)
      } else {
        console.error('加入分析队列失败:', error)
        toast.error(t('加入分析队列失败，请重试'))
      }
      throw error
    }
  }

  /**
   * 关闭RescanPreviewDialog
   */
  const handleCloseRescanPreview = () => {
    setShowRescanPreviewDialog(false)
    setRescanResult(null)
    setCurrentDirectory(null)
  }

  /**
   * 格式化日期
   */
  const formatDate = (date: Date | string | undefined) => {
    if (!date) return t('从未扫描')
    return formatDateTime(date)
  }

  /**
   * 获取目录状态
   */
  const getDirectoryStatus = (directory: WorkspaceDirectory) => {
    if (!directory.isActive) return null
    return { status: 'active', label: t('已激活'), color: 'text-green-600' }
  }

  if (loadingDirectories) {
    return (
      <div className="p-6 flex items-center justify-center">
        <div className="text-center">
          <RefreshCw className="h-8 w-8 animate-spin mx-auto mb-2 text-muted-foreground" />
          <p className="text-muted-foreground">{t('加载工作目录...')}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-2">{t('工作目录管理')}</h3>
        <p className="text-sm text-muted-foreground">
          {t('管理已添加的工作目录，可以删除或重置分析数据')}
        </p>
      </div>

      {/* 错误提示 */}
      {error && (
        <Card className="p-4 bg-destructive/10 border-destructive/20">
          <div className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-4 w-4" />
            <span className="text-sm">{error}</span>
          </div>
        </Card>
      )}

      {/* 工作目录列表 */}
      <Card className="p-4">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-base font-medium">{t('工作目录列表')}</Label>
              <p className="text-sm text-muted-foreground mt-1">
                {t('当前正在监控的目录及其状态')}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={loadWorkspaceDirectories}
              disabled={isLoading}
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
              {t('刷新')}
            </Button>
          </div>

          {workspaceDirectories.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <FolderOpen className="h-12 w-12 mx-auto mb-3 opacity-50" />
              <p>{t('暂无工作目录')}</p>
              <p className="text-sm">{t('请先添加要监控的目录')}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {workspaceDirectories.map(directory => {
                const status = getDirectoryStatus(directory)

                return (
                  <div key={directory.id} className="border rounded-lg p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex-1 space-y-2">
                        <div className="flex items-center gap-2">
                          <FolderOpen className="h-5 w-5 text-blue-600" />
                          <span className="font-medium">{directory.name}</span>
                          {/* 工作目录类型标识 */}
                          {directory.type && directory.type !== 'VDIR' && (
                            <span
                              className={`text-xs px-2 py-1 rounded font-medium ${
                                directory.type === 'SPEEDY'
                                  ? 'text-amber-600 bg-amber-500/10'
                                  : 'text-blue-600 bg-blue-500/10'
                              }`}
                            >
                              {directory.type === 'SPEEDY' ? t('极速') : t('私有')}
                            </span>
                          )}
                          {status && (
                            <span
                              className={`text-xs px-2 py-1 rounded ${status.color} bg-current/10`}
                            >
                              {status.label}
                            </span>
                          )}
                        </div>

                        <div className="text-sm text-muted-foreground ">
                          <div className="flex items-center gap-1 mb-1">
                            <HardDrive className="h-3 w-3" />
                            <span>{directory.path}</span>
                          </div>
                          <div className="flex items-center gap-1">
                            <Calendar className="h-3 w-3" />
                            <span>
                              {t('最后扫描: {}', [
                                directory.lastScanAt
                                  ? formatDate(directory.lastScanAt)
                                  : t('从未扫描')
                              ])}
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center gap-4 text-xs text-muted-foreground">
                          <span>
                            {t('递归监控: {}', [directory.recursive ? t('是') : t('否')])}
                          </span>
                          <span>{t('创建时间: {}', [formatDate(directory.createdAt)])}</span>
                        </div>

                        {/* 自动监听勾选项 */}
                        <div className="flex items-center gap-2 mt-2">
                          <input
                            type="checkbox"
                            id={`auto-watch-${directory.id}`}
                            checked={directory.autoWatch || false}
                            onChange={async e => {
                              try {
                                if (directory.id) {
                                  await window.electronAPI!.updateWorkspaceDirectoryAutoWatch(
                                    directory.id,
                                    e.target.checked
                                  )
                                  await loadWorkspaceDirectories()
                                }
                              } catch (error) {
                                console.error('更新autoWatch状态失败:', error)
                              }
                            }}
                            className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                          />
                          <label
                            htmlFor={`auto-watch-${directory.id}`}
                            className="text-sm text-muted-foreground cursor-pointer"
                          >
                            {t('监听文件变化（新增文件自动加入AI分析队列）')}
                          </label>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 ml-4">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleRescanDirectory(directory)}
                          disabled={isLoading || scanningWorkspaceId !== null}
                          title={t('重新扫描目录')}
                        >
                          {scanningWorkspaceId === directory.id ? (
                            <RefreshCw className="h-4 w-4 animate-spin" />
                          ) : (
                            <Search className="h-4 w-4" />
                          )}
                        </Button>

                        <Button
                          size="sm"
                          variant="outline"
                          onClick={async () => {
                            try {
                              // 主动触发：先扫描空文件夹
                              const scanResult = await window.electronAPI!.emptyFolder.scan(
                                directory.path
                              )

                              if (scanResult.emptyFolders?.length === 0) {
                                // 没有空文件夹，显示Toast提示
                                toast.info(t('未发现空文件夹'))
                              } else {
                                // 有空文件夹，显示清理对话框
                                setEmptyFolderCleanupPath(directory.path)
                                setShowEmptyFolderCleanupDialog(true)
                              }
                            } catch (error: any) {
                              console.error('扫描空文件夹失败:', error)
                              toast.error(t('扫描失败: {}', [error.message]))
                            }
                          }}
                          disabled={isLoading}
                          title={t('清理空文件夹')}
                        >
                          <FolderX className="h-4 w-4" />
                        </Button>

                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleResetDirectory(directory)}
                          disabled={isLoading}
                          title={t('重置为未分析状态')}
                        >
                          <Eraser className="h-4 w-4" />
                        </Button>

                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleDeleteDirectory(directory)}
                          disabled={isLoading}
                          title={t('删除工作目录')}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </Card>

      {/* 操作说明 */}
      <Card className="p-4">
        <div className="space-y-3">
          <Label className="text-base font-medium">{t('操作说明')}</Label>

          <div className="space-y-2 text-sm">
            <div className="flex items-start gap-2">
              <Search className="h-4 w-4 mt-0.5 text-blue-600" />
              <div>
                <span className="font-medium">{t('重新扫描:')}</span>
                <span className="text-muted-foreground ml-1">
                  {t('重新扫描目录中的文件，检测新增、删除或修改的文件')}
                </span>
              </div>
            </div>

            <div className="flex items-start gap-2">
              <FolderX className="h-4 w-4 mt-0.5 text-purple-600" />
              <div>
                <span className="font-medium">{t('清理空文件夹:')}</span>
                <span className="text-muted-foreground ml-1">
                  {t('扫描并删除工作目录中的空文件夹，支持树形预览和批量删除')}
                </span>
              </div>
            </div>

            <div className="flex items-start gap-2">
              <Eraser className="h-4 w-4 mt-0.5 text-orange-600" />
              <div>
                <span className="font-medium">{t('重置:')}</span>
                <span className="text-muted-foreground ml-1">
                  {t('删除该目录的所有AI分析结果和标签，但保留原始文件。目录将重置为未分析状态')}
                </span>
              </div>
            </div>

            <div className="flex items-start gap-2">
              <Trash2 className="h-4 w-4 mt-0.5 text-destructive" />
              <div>
                <span className="font-medium">{t('删除:')}</span>
                <span className="text-muted-foreground ml-1">
                  {t(
                    '完全删除工作目录及其所有相关数据，包括文件信息、分析结果、标签等。此操作不可逆'
                  )}
                </span>
              </div>
            </div>
          </div>
        </div>
      </Card>

      {/* 警告信息 */}
      <Card className="p-4 bg-amber-50 border-amber-200">
        <div className="flex items-start gap-2">
          <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5" />
          <div className="text-sm text-amber-800">
            <p className="font-medium mb-1">{t('重要提醒')}</p>
            <ul className="space-y-1 text-amber-700">
              <li>{t('• 删除工作目录将永久删除所有相关的AI分析数据')}</li>
              <li>{t('• 重置操作会清除分析结果，但不会删除原始文件')}</li>
              <li>{t('• 重新扫描可能需要较长时间，取决于目录大小')}</li>
            </ul>
          </div>
        </div>
      </Card>

      {/* 删除确认对话框 */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('移除工作目录')}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>{t('确定要移除工作目录 "{}" 吗？', [currentDirectory?.name])}</p>
                <div className="text-sm">
                  <p>
                    {t(
                      '此操作将完全移除工作目录，包括文件信息、分析结果、标签等。真实目录不会删除'
                    )}
                  </p>
                  <p className="mt-2 text-destructive font-medium">{t('此操作不可逆！')}</p>
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button variant="outline">{t('取消')}</Button>
            </AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button variant="destructive" className='text-destructive-foreground' onClick={handleConfirmDelete}>
                {t('移除')}
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 重置确认对话框 */}
      <AlertDialog open={showResetDialog} onOpenChange={setShowResetDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('重置工作目录')}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>{t('确定要重置目录 "{}" 吗？', [currentDirectory?.name])}</p>
                <div className="text-sm">
                  <p>
                    {t(
                      '此操作将删除该目录的所有AI分析结果和标签，但保留原始文件。目录将重置为未分析状态。'
                    )}
                  </p>
                  <p className="mt-2 text-destructive font-medium">{t('此操作不可逆！')}</p>
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button variant="outline">{t('取消')}</Button>
            </AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button variant="destructive" className='text-destructive-frontground' onClick={handleConfirmReset}>
                {t('重置')}
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 重新扫描差异预览对话框 */}
      {showRescanPreviewDialog && currentDirectory && rescanResult && (
        <RescanPreviewDialog
          isOpen={showRescanPreviewDialog}
          onClose={handleCloseRescanPreview}
          workspaceDirectoryPath={currentDirectory.path}
          workspaceDirectoryName={currentDirectory.name}
          newFiles={(rescanResult as any).stats?.newFiles || []}
          modifiedFiles={(rescanResult as any).stats?.modifiedFiles || []}
          onAddToQueue={handleAddFilesToQueue}
        />
      )}

      {/* 空文件夹清理对话框 */}
      {showEmptyFolderCleanupDialog && emptyFolderCleanupPath && (
        <EmptyFolderCleanupDialog
          isOpen={showEmptyFolderCleanupDialog}
          onClose={() => {
            setShowEmptyFolderCleanupDialog(false)
            setEmptyFolderCleanupPath('')
          }}
          workspaceDirectoryPath={emptyFolderCleanupPath}
        />
      )}
    </div>
  )
}
