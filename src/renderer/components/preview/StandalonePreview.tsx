/**
 * 独立预览窗口组件
 * 用于新窗口预览模式，仅依赖 Flyfish + 少量 electronAPI
 * 不依赖主应用的任何 Zustand store 或路由系统
 */
import React, { useCallback } from 'react'
import { t } from '@app/languages'
import { MaterialIcon } from '../../lib/utils'
import { getPreviewRouteType } from '../../lib/preview-utils'
import { usePreviewContent } from '../file-explorer/hooks/usePreviewContent'
import { FlyfishPreview } from '../file-explorer/FlyfishPreview'
import { FilePreview } from '../file-explorer/FilePreview'
import { SupportedFormats } from '../common/SupportedFormats'
import { ErrorBoundary } from '../common/ErrorBoundary'
import { Label } from '../ui/label'
import { Switch } from '../ui/switch'

const StandalonePreview: React.FC = () => {
  const params = new URLSearchParams(window.location.hash.split('?')[1] || window.location.search)
  const filePath = params.get('path') || ''
  const fileName = filePath.split(/[\\/]/).pop() || ''
  const ext = fileName.split('.').pop() || ''

  const routeType = getPreviewRouteType(ext)

  const { showRawText, setShowRawText, rawTextContent, isTextLoading, isTextCapable, showSwitch } =
    usePreviewContent({ filePath, fileName, extension: ext })

  const handleOpenExternal = useCallback(() => {
    if (filePath) {
      window.electronAPI?.utils?.openFileWithDefaultApp?.(filePath)
    }
  }, [filePath])

  const handleClose = useCallback(() => {
    window.close()
  }, [])

  return (
    <div className="h-screen w-screen flex flex-col bg-background text-foreground overflow-hidden">
      {/* 工具栏 */}
      <div className="flex-none h-11 flex items-center justify-between px-3 border-b border-border bg-muted/20 shrink-0">
        <span className="text-sm font-medium truncate min-w-0" title={fileName}>
          {fileName}
        </span>
        <div className="flex items-center gap-1 ml-auto shrink-0">
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
                onCheckedChange={checked => setShowRawText(!checked)}
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
          <button
            onClick={handleOpenExternal}
            className="inline-flex items-center justify-center gap-1.5 text-xs h-7 px-2 rounded-md hover:bg-muted transition-colors whitespace-nowrap"
            title={t('默认程序打开')}
          >
            <MaterialIcon icon="open_in_browser" className="text-sm shrink-0" />
            <span className="hidden sm:inline">{t('默认程序打开')}</span>
          </button>
          <button
            onClick={handleClose}
            className="inline-flex items-center justify-center h-7 w-7 rounded-md hover:bg-muted transition-colors shrink-0"
            title={t('关闭')}
          >
            <MaterialIcon icon="close" className="text-sm" />
          </button>
        </div>
      </div>

      {/* 预览内容 */}
      <div className="flex-1 overflow-hidden relative">
        <ErrorBoundary>
          {showRawText && isTextCapable ? (
            isTextLoading ? (
              <div className="flex items-center justify-center h-full">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
              </div>
            ) : rawTextContent !== null ? (
              <div className="h-full w-full overflow-auto p-4 bg-muted/20">
                <pre className="text-[15px] whitespace-pre-wrap break-words text-foreground/90 dark:text-foreground/70 leading-8 tracking-wide font-sans selection:bg-primary/20">
                  {rawTextContent}
                </pre>
              </div>
            ) : (
              <div className="flex items-center justify-center h-full text-muted-foreground">
                {t('无法读取文件内容')}
              </div>
            )
          ) : routeType === 'flyfish' ? (
            <FlyfishPreview filePath={filePath} fileName={fileName} extension={ext} />
          ) : routeType === 'native' ? (
            <FilePreview filePath={filePath} fileName={fileName} extension={ext} />
          ) : (
            <div className="h-full flex flex-col items-center justify-start text-muted-foreground p-6 overflow-y-auto pt-8 select-none">
              <MaterialIcon icon="visibility_off" className="text-5xl mb-3 opacity-20 shrink-0" />
              <p className="text-sm font-medium mb-1 shrink-0">{t('当前文件类型暂不支持预览')}</p>
              <p className="text-xs text-muted-foreground/70 mb-5 shrink-0">
                {t('文件扩展名')}：.{ext}
              </p>
              <SupportedFormats />
            </div>
          )}
        </ErrorBoundary>
      </div>
    </div>
  )
}

export default StandalonePreview
