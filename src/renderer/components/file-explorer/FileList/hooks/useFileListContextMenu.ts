import { useCallback, useMemo, useState, useRef, useLayoutEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { FileType } from '../types'
import { DirectoryItem } from '@firefly/types'
import { ContextMenuItem } from '../../../common/ContextMenu'
import { t } from '@app/languages'
import { LogCategory, logger } from '@firefly/shared'
import { toast } from '../../../common/Toast'
import { useAnalysisQueueStore } from '../../../../stores/analysis-queue-store'
import { usePreviewOverlayStore } from '../../../../stores/preview-overlay-store'
import { useSearchStore } from '../../../../stores/search-store'
import { runBatchAnalyze } from '../../batch-analyze'

interface UseFileListContextMenuProps {
  selectedFiles: FileType[]
  onFileSelect: (files: (FileType | DirectoryItem | string)[], isFromCheckbox?: boolean) => void
  /** 当前所在目录路径，供「批量重新分析」的目录画像前置使用（右键菜单无目录上下文时为空） */
  currentPath?: string
}

export const useFileListContextMenu = ({
  selectedFiles,
  onFileSelect,
  currentPath
}: UseFileListContextMenuProps) => {
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    item: FileType | DirectoryItem
  } | null>(null)
  const { isPathEqual } = window.electronAPI!.utils
  const navigate = useNavigate()
  const { pathname } = useLocation()
  /** 整理页自身即工作台，再给「进入工作台」的入口会形成自我跳转，需整组隐藏 */
  const isOrganizePage = pathname === '/organize'

  const selectedFilesRef = useRef(selectedFiles)
  const onFileSelectRef = useRef(onFileSelect)

  useLayoutEffect(() => {
    selectedFilesRef.current = selectedFiles
    onFileSelectRef.current = onFileSelect
  }, [selectedFiles, onFileSelect])

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, item: FileType | DirectoryItem) => {
      e.preventDefault()
      e.stopPropagation()

      const isItemSelected = selectedFilesRef.current.some(f => isPathEqual(f.path, item.path))
      if (!isItemSelected) {
        onFileSelectRef.current([item], false)
      }

      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        item
      })
    },
    [isPathEqual]
  )

  /**
   * 可进入整理工作台（批量更名 / 批量标签 / 批量整理）的文件集合。
   *
   * 判定口径与后端 `getLightweightWorkspaceFiles` 的 SQL 同源：
   * `wf.is_analyzed = 1 AND (wf.status IS NULL OR wf.status = 1)`，另外目录本就没有工作台语义。
   * 对「状态未知」的条目采取放行口径（仅排除明确否定标记），避免不同数据源字段缺失时
   * 把入口误判为永久不可用；最终准入仍由后端 SQL 裁决。
   */
  const workbenchFiles = useMemo(
    () =>
      selectedFiles.filter(f => {
        if ('isDirectory' in f && (f as any).isDirectory) return false
        if ((f as any).status === 0) return false
        if ((f as any).isAnalyzed === false) return false
        if ((f as any).isUnanalyzed === true) return false
        return true
      }),
    [selectedFiles]
  )

  /** 跳转整理工作台，并把不可用的选中项显式告知用户（禁止静默丢弃） */
  const navigateToWorkbench = useCallback(
    (initialStage: 'batch-rename' | 'batch-tag' | 'mode-select') => {
      const excludedCount = selectedFiles.length - workbenchFiles.length
      const selectedFileIds = workbenchFiles
        .map(f => Number(f.id))
        .filter(id => Number.isFinite(id))
      const selectedFilePaths = workbenchFiles.map(f => f.path).filter(Boolean)

      // 安全门禁：整理页在「未携带 id 与 path」时会回退到工作区全量文件，
      // 一旦没有任何可传递的定位信息就只能中止，避免把整库文件倒进工作台。
      if (selectedFileIds.length === 0 && selectedFilePaths.length === 0) {
        toast.error(t('未能确定待整理文件，请重新选择后再试'))
        return
      }

      if (excludedCount > 0) {
        toast.info(
          t('已排除 {count} 个不可整理的选中项（未分析、已失效或目录）', {
            count: excludedCount
          })
        )
      }

      // 全域搜索浮层挂载在路由之外，导航不会自动收起；不清空关键词会把工作台压在浮层底下
      useSearchStore.getState().clearGlobalSearch()

      navigate('/organize', {
        state: {
          selectedFileIds,
          selectedFilePaths,
          initialStage
        }
      })
    },
    [navigate, selectedFiles, workbenchFiles]
  )

  const contextMenuItems = useMemo((): ContextMenuItem[] => {
    if (!contextMenu) return []
    const item = contextMenu.item
    const isDirectory = 'isDirectory' in item && item.isDirectory

    let analysisStatus: string | undefined = undefined
    let isAnalyzed = false

    if (!isDirectory) {
      const fileItem = item as FileType
      const queueItems = useAnalysisQueueStore.getState().snapshot.items
      const queueItem = queueItems.find(q => isPathEqual(q.path, fileItem.path))

      if (queueItem) {
        analysisStatus = queueItem.status
      } else if (fileItem.isAnalyzed) {
        analysisStatus = 'completed'
      }
      isAnalyzed = analysisStatus === 'completed'
    }

    // ─── 多选菜单：只保留批量动作，且仅四项 ───────────────────────────────────
    if (selectedFiles.length > 1 && !isOrganizePage) {
      const queueSnapshotItems = useAnalysisQueueStore.getState().snapshot.items
      const hasBusySelected = selectedFiles.some(f =>
        queueSnapshotItems.some(
          q => isPathEqual(q.path, f.path) && (q.status === 'analyzing' || q.status === 'pending')
        )
      )
      const noWorkbenchTarget = workbenchFiles.length === 0

      return [
        {
          label: t('批量重新分析'),
          icon: 'refresh',
          disabled: hasBusySelected,
          onClick: () => {
            // 复用批量分析按钮的执行路径（含已分析文件二次确认弹窗、目录画像前置与队列面板强制展开）
            void runBatchAnalyze({ files: selectedFiles, currentPath })
          }
        },
        {
          label: t('批量更名'),
          icon: 'drive_file_rename_outline',
          disabled: noWorkbenchTarget,
          onClick: () => navigateToWorkbench('batch-rename')
        },
        {
          label: t('批量标签'),
          icon: 'label',
          disabled: noWorkbenchTarget,
          onClick: () => navigateToWorkbench('batch-tag')
        },
        {
          label: t('批量整理'),
          icon: 'auto_fix_high',
          disabled: noWorkbenchTarget,
          onClick: () => navigateToWorkbench('mode-select')
        }
      ]
    }

    const isAnalyzingOrPending = analysisStatus === 'analyzing' || analysisStatus === 'pending'

    const itemsToAnalyze = selectedFiles.some(f => isPathEqual(f.path, item.path))
      ? selectedFiles
      : [item]
    const queueItems = itemsToAnalyze.map(f => ({
      path: f.path,
      name: f.name,
      size: 'size' in f ? (f as any).size : 0,
      type: ('extension' in f ? (f as any).extension : 'directory') || ''
    }))

    // 工作台入口只对文件和已分析文件开放；整理页内与批量分析确认弹窗内整组隐藏
    // （确认弹窗里的 FileList 是只读回显，跳工作台会把弹窗留在工作台之上）
    const showWorkbenchEntries =
      !isDirectory && !isOrganizePage && !useAnalysisQueueStore.getState().showConfirmModal
    // 单选入口的可达性与准入集合必须一致：已分析但物理失效（status === 0）的文件
    // 会被后端准入过泸掉，若仅看分析状态就会跳进一个空工作台
    const itemInWorkbenchScope = workbenchFiles.some(f => isPathEqual(f.path, item.path))
    const workbenchEntriesDisabled = !isAnalyzed || !itemInWorkbenchScope

    return [
      // 非目录文件添加"预览"菜单项
      ...(!isDirectory
        ? [
            {
              label: t('预览'),
              icon: 'visibility',
              onClick: () => {
                const ext = ('extension' in item ? (item as any).extension : '') || ''
                usePreviewOverlayStore
                  .getState()
                  .openPreview(
                    item.path,
                    ('smartName' in item ? (item as any).smartName : undefined) || item.name || '',
                    ext
                  )
              }
            } as ContextMenuItem
          ]
        : []),
      {
        label: t('用默认程序打开'),
        icon: 'open_in_new',
        onClick: async () => {
          try {
            await window.electronAPI!.utils.openFileWithDefaultApp(item.path)
          } catch (error: any) {
            logger.error(LogCategory.RENDERER, '打开文件失败:', error)
            toast.error(t('打开文件失败'))
          }
        }
      },
      ...(!isDirectory
        ? [
            {
              label: t('在外部应用中精准定位打开'),
              icon: 'launch',
              onClick: async () => {
                try {
                  const rawCat = (item as any).category
                  const cat = typeof rawCat === 'object' && rawCat !== null ? rawCat.label : rawCat
                  const outcome = await window.electronAPI!.utils.launchExternalDeepLink({
                    filePath: item.path,
                    category: cat || '',
                    seekSeconds: (item as any).matchedChunk?.startSec
                  })
                  if (outcome.fallbackToDefault) {
                    toast.info(t('未检测到支持精准定位的外部应用，已按默认方式打开'))
                  }
                } catch (error: any) {
                  logger.error(LogCategory.RENDERER, '外部深链定位打开失败:', error)
                  toast.error(t('打开文件失败'))
                }
              }
            } as ContextMenuItem
          ]
        : []),
      {
        label: t('复制文件路径'),
        icon: 'content_copy',
        onClick: async () => {
          try {
            const isCurrentItemSelected = selectedFiles.some(f => isPathEqual(f.path, item.path))
            const itemsToCopy = isCurrentItemSelected ? selectedFiles : [item]
            const paths = itemsToCopy.map(f => f.path)

            if (paths.length === 1) {
              await window.electronAPI!.utils.copyFileToClipboard(paths[0])
            } else {
              await window.electronAPI!.utils.copyFilesToClipboard(paths)
            }
            toast.success(t('已复制到剪贴板'))
          } catch (error: any) {
            logger.error(LogCategory.RENDERER, '复制文件失败:', error)
            toast.error(t('复制失败'))
          }
        }
      },
      isAnalyzed
        ? {
            label: t('重新分析'),
            icon: 'refresh',
            disabled: isAnalyzingOrPending,
            onClick: async () => {
              try {
                await useAnalysisQueueStore.getState().addItems(queueItems, true)
                toast.success(t('已加入分析队列'))
              } catch (error) {
                logger.error(LogCategory.RENDERER, '加入分析队列失败:', error)
                toast.error(t('操作失败'))
              }
            }
          }
        : {
            label: t('立即分析'),
            icon: 'analytics',
            disabled: isAnalyzingOrPending,
            onClick: async () => {
              try {
                await useAnalysisQueueStore.getState().addItems(queueItems, false)
                toast.success(t('已加入分析队列'))
              } catch (error) {
                logger.error(LogCategory.RENDERER, '加入分析队列失败:', error)
                toast.error(t('操作失败'))
              }
            }
          },
      // 单文件直达工作台：把当前文件作为待整理文件带入批量更名 / 批量标签
      ...(showWorkbenchEntries
        ? [
            {
              label: t('从模板改智能文件名'),
              icon: 'drive_file_rename_outline',
              divider: true,
              disabled: workbenchEntriesDisabled,
              onClick: () => navigateToWorkbench('batch-rename')
            } as ContextMenuItem,
            {
              label: t('更改标签'),
              icon: 'label',
              disabled: workbenchEntriesDisabled,
              onClick: () => navigateToWorkbench('batch-tag')
            } as ContextMenuItem
          ]
        : []),
      {
        label: t('在真实目录中定位'),
        icon: 'folder_open',
        divider: true,
        onClick: async () => {
          try {
            await window.electronAPI!.utils.showItemInFolder(item.path)
          } catch (error: any) {
            logger.error(LogCategory.RENDERER, '打开目录失败:', error)
            toast.error(t('打开目录失败'))
          }
        }
      },
      {
        label: t('在虚拟目录中定位'),
        icon: 'account_tree',
        onClick: async () => {
          try {
            const hardlinkPath = await window.electronAPI!.analyzedDirectory.findFirstHardlink(
              item.path
            )
            if (hardlinkPath) {
              await window.electronAPI!.utils.showItemInFolder(hardlinkPath)
            } else {
              toast.info(t('请先导出虚拟目录（虚拟目录不占硬盘空间）'))
            }
          } catch (error: any) {
            logger.error(LogCategory.RENDERER, '查找虚拟目录硬链接失败:', error)
            toast.error(t('操作失败'))
          }
        }
      }
    ]
  }, [
    contextMenu,
    t,
    selectedFiles,
    isPathEqual,
    isOrganizePage,
    currentPath,
    workbenchFiles,
    navigateToWorkbench
  ])

  return {
    contextMenu,
    setContextMenu,
    handleContextMenu,
    contextMenuItems
  }
}
