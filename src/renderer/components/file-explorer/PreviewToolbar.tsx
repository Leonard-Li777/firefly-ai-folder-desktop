import React, { useCallback } from 'react'
import { t } from '@app/languages'
import { MaterialIcon } from '../../lib/utils'
import { Button } from '../ui/button'
import { Switch } from '../ui/switch'
import { Label } from '../ui/label'
import { usePreviewOverlayStore } from '../../stores/preview-overlay-store'

interface PreviewToolbarProps {
  /** 页面标识，用于操作对应页面的预览状态 */
  pageId: string
  /** 当前预览文件路径（可选），优先用于新窗口打开/默认程序打开，避免使用全局残留路径 */
  filePath?: string
  /** 文件名 */
  fileName: string
  /** 是否显示原文/预览切换开关 */
  showSwitch: boolean
  /** 是否显示原文内容 */
  showRawText: boolean
  /** 切换原文/预览显示 */
  onToggleRawText: (show: boolean) => void
  /** 是否为分栏模式（控制额外提示文字显示） */
  showHint?: boolean
  /** 额外提示文字 */
  hint?: string
  /** 是否显示模式切换按钮（全屏/分栏），新窗口模式不显示 */
  showModeToggle?: boolean
  /** 关闭按钮回调（可选），提供时优先调用，否则回退到 store 的 closePreview */
  onClose?: () => void
}

/**
 * 公共预览工具栏组件
 * 用于分栏模式和全屏模式，统一管理预览工具栏的UI和交互
 */
export const PreviewToolbar: React.FC<PreviewToolbarProps> = ({
  pageId,
  filePath: currentFilePath,
  fileName,
  showSwitch,
  showRawText,
  onToggleRawText,
  showHint = false,
  hint,
  showModeToggle = true,
  onClose
}) => {
  const {
    filePath: storeFilePath,
    pageStates,
    togglePreviewMode,
    closePreview
  } = usePreviewOverlayStore()
  const pageMode = pageStates[pageId]?.mode || 'split'

  // 优先使用当前预览文件路径，避免 store 中残留其他页面的文件路径导致打开错误文件
  const targetFilePath = currentFilePath || storeFilePath

  const handleOpenNewWindow = useCallback(() => {
    if (targetFilePath) {
      window.electronAPI?.preview.openNewWindow(targetFilePath)
    }
  }, [targetFilePath])

  const handleLaunch = useCallback(() => {
    if (targetFilePath) {
      window.electronAPI?.utils.openFileWithDefaultApp(targetFilePath).catch((err: Error) => {
        console.error('Failed to open file with default app:', err)
      })
    }
  }, [targetFilePath])

  const handleClose = useCallback(() => {
    if (onClose) {
      onClose()
    } else {
      closePreview(pageId)
    }
  }, [onClose, closePreview, pageId])

  const handleToggleMode = useCallback(() => {
    togglePreviewMode(pageId)
  }, [togglePreviewMode, pageId])

  return (
    <div className="flex items-center px-3 py-1.5 border-b border-border bg-muted/20 shrink-0 gap-2 min-w-0">
      {/* 文件名 - 可收缩 */}
      <span className="text-sm font-medium truncate min-w-0" title={fileName}>
        {fileName}
      </span>
      {/* 提示文字 - 小屏隐藏 */}
      {showHint && hint && (
        <span className="text-xs text-muted-foreground/50 shrink-0 hidden lg:inline whitespace-nowrap">
          ({hint})
        </span>
      )}
      {/* 右侧按钮组 - flex-shrink 允许收缩，但保持最小宽度 */}
      <div className="flex items-center gap-1 ml-auto shrink min-w-0">
        {showSwitch && (
          <div className="flex items-center gap-1 mr-1 border-r border-border pr-1 shrink-0">
            <Label
              htmlFor="preview-raw-toggle"
              className="text-xs cursor-pointer text-muted-foreground select-none hidden sm:inline"
            >
              {t('原文')}
            </Label>
            <Switch
              id="preview-raw-toggle"
              checked={!showRawText}
              onCheckedChange={checked => onToggleRawText(!checked)}
              className="scale-75"
            />
            <Label
              htmlFor="preview-raw-toggle"
              className="text-xs cursor-pointer text-muted-foreground select-none hidden sm:inline"
            >
              {t('预览')}
            </Label>
          </div>
        )}
        {/* 可收缩按钮组 */}
        <Button
          variant="ghost"
          onClick={handleOpenNewWindow}
          size="sm"
          className="shrink min-w-0 group/btn"
        >
          <MaterialIcon icon="open_in_new" className="shrink-0" />
          <span className="truncate min-w-0 hidden md:inline ml-1">{t('在新窗口打开')}</span>
        </Button>
        <Button
          variant="ghost"
          onClick={handleLaunch}
          size="sm"
          className="shrink min-w-0 group/btn"
        >
          <MaterialIcon icon="open_in_browser" className="shrink-0" />
          <span className="truncate min-w-0 hidden md:inline ml-1">{t('默认程序打开')}</span>
        </Button>
        {showModeToggle && (
          <Button
            variant="ghost"
            onClick={handleToggleMode}
            size="sm"
            className="shrink min-w-0 group/btn"
          >
            <MaterialIcon
              icon={pageMode === 'split' ? 'fullscreen' : 'view_column'}
              className="shrink-0"
            />
            <span className="truncate min-w-0 hidden lg:inline ml-1">
              {pageMode === 'split' ? t('全屏模式') : t('分栏模式')}
            </span>
          </Button>
        )}
        {/* 关闭按钮 - 不收缩 */}
        <Button
          variant="ghost"
          onClick={handleClose}
          title={t('关闭预览')}
          className="h-8 w-8 p-0 shrink-0"
        >
          <MaterialIcon icon="close" />
        </Button>
      </div>
    </div>
  )
}

export default PreviewToolbar
