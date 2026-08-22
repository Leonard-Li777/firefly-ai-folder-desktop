import { useCallback, useMemo, useState, useRef, useLayoutEffect } from 'react'
import { FileType } from '../types'
import { DirectoryItem } from '@firefly/types'
import { ContextMenuItem } from '../../../common/ContextMenu'
import { t } from '@app/languages'
import { LogCategory, logger } from '@firefly/shared'
import { toast } from '../../../common/Toast'
import { useAnalysisQueueStore } from '../../../../stores/analysis-queue-store'
import { usePreviewOverlayStore } from '../../../../stores/preview-overlay-store'

import { PageId } from '../../../../constants/page-ids'

interface UseFileListContextMenuProps {
  selectedFiles: FileType[]
  onFileSelect: (files: (FileType | DirectoryItem | string)[], isFromCheckbox?: boolean) => void
  pageId?: PageId
}

export const useFileListContextMenu = ({
  selectedFiles,
  onFileSelect
}: UseFileListContextMenuProps) => {
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    item: FileType | DirectoryItem
  } | null>(null)
  const { isPathEqual } = window.electronAPI!.utils
  const { addItems } = useAnalysisQueueStore()

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
                await addItems(queueItems, true)
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
                await addItems(queueItems, false)
                toast.success(t('已加入分析队列'))
              } catch (error) {
                logger.error(LogCategory.RENDERER, '加入分析队列失败:', error)
                toast.error(t('操作失败'))
              }
            }
          },
      {
        label: t('在真实目录中定位'),
        icon: 'folder_open',
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
    addItems
  ])

  return {
    contextMenu,
    setContextMenu,
    handleContextMenu,
    contextMenuItems
  }
}
