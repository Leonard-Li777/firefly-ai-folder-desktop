import { FileCategory, getFileCategory } from '@firefly/shared'
import React, { useEffect, useState } from 'react'

import { Button } from '../ui/button'
import { EmptyState } from '../common/EmptyState'
import { MaterialIcon } from '../../lib/utils'
import { t } from '@app/languages'

interface FilePreviewProps {
  filePath: string
  fileName: string
  extension?: string
}

export const FilePreview: React.FC<FilePreviewProps> = ({ filePath, fileName, extension }) => {
  const category = extension ? getFileCategory('file.' + extension) : getFileCategory(fileName)
  const [textContent, setTextContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isTextFile, setIsTextFile] = useState<boolean | null>(null)
  const [isTruncated, setIsTruncated] = useState(false)
  const [fileSize, setFileSize] = useState(0)

  useEffect(() => {
    if (category !== FileCategory.UNKNOWN) {
      setIsTextFile(null)
      return
    }
    window.electronAPI
      ?.getFileAnalysisResult?.(filePath)
      ?.then(result => setIsTextFile(result?.category?.is_text ?? false))
      ?.catch(() => setIsTextFile(false))
  }, [filePath, category])

  const isTextCapable =
    category === FileCategory.TEXT ||
    category === FileCategory.EBOOK ||
    category === FileCategory.CODE ||
    (category === FileCategory.UNKNOWN && isTextFile === true)

  useEffect(() => {
    if (!isTextCapable) return
    setLoading(true)
    setIsTruncated(false)
    setFileSize(0)

    const loadTextContent = async () => {
      try {
        // 走 preview/read-text-limit IPC：读取上限 100KB 字节，
        // 超过上限时截断并标记 isTruncated，避免对大文件整体读取与解码导致预览卡顿
        const readResult = await window.electronAPI?.preview?.readTextLimit?.(filePath, 100000)
        if (!readResult || !readResult.success) {
          throw new Error(readResult?.error || t('readTextLimit 返回失败'))
        }
        setTextContent(readResult.text)
        setIsTruncated(!!readResult.isTruncated)
        if (readResult.size) setFileSize(readResult.size)
      } catch (err) {
        setError(t('无法读取文件内容'))
        console.error(err)
      } finally {
        setLoading(false)
      }
    }

    loadTextContent()
  }, [filePath, isTextCapable])

  const handleOpenExternal = () => {
    window.electronAPI?.utils?.openFileWithDefaultApp?.(filePath)
  }

  const handleShowInFolder = () => {
    window.electronAPI.utils.showItemInFolder(filePath)
  }

  const fileUrl = React.useMemo(() => {
    const raw = window.electronAPI?.utils
      ? window.electronAPI.utils.normalizeForCache(filePath)
      : filePath
    // 转为 file:// URL，编码非 ASCII 字符
    const normalized = raw.replace(/\\/g, '/')
    const encoded = normalized
      .split('/')
      .map((seg, i) => {
        if (i === 0 && /^[a-zA-Z]:$/.test(seg)) return seg
        // eslint-disable-next-line no-control-regex
        return /^[\x00-\x7F]*$/.test(seg) ? seg : encodeURIComponent(seg)
      })
      .join('/')
    return `file://${encoded.startsWith('/') ? '' : '/'}${encoded}`
  }, [filePath])

  const fileExt = filePath.split('.').pop()?.toUpperCase() || 'UNKNOWN'

  const formatSize = (bytes: number) => {
    if (!bytes) return '0 Bytes'
    const k = 1024
    const sizes = ['Bytes', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
  }

  if (category === FileCategory.UNKNOWN && isTextFile === null) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
        <MaterialIcon icon="error_outline" className="text-4xl mb-2" />
        <p>{error}</p>
      </div>
    )
  }

  const renderUnsupported = () => (
    <EmptyState
      icon="visibility_off"
      title={t('当前文件类型（.{ext}）暂不支持预览', { ext: fileExt })}
      description={t(
        '该格式暂无内置预览插件，我们将持续拓展支持的类型。建议您使用外部默认关联程序打开查看。'
      )}
    >
      <div className="flex items-center gap-3">
        <Button
          onClick={handleOpenExternal}
          variant="outline"
          className="font-bold rounded-xl shadow-md"
        >
          <MaterialIcon icon="open_in_new" className="mr-1.5 text-sm" />
          {t('用系统默认程序打开')}
        </Button>
        <Button onClick={handleShowInFolder} variant="outline" className="font-bold rounded-xl">
          <MaterialIcon icon="folder_open" className="mr-1.5 text-sm" />
          {t('在文件夹中定位')}
        </Button>
      </div>
    </EmptyState>
  )

  switch (category) {
    case FileCategory.IMAGE:
      return (
        <div className="flex items-center justify-center h-full p-4 ph-no-capture">
          <img
            src={fileUrl}
            alt={fileName}
            className="max-w-full max-h-full object-contain shadow-lg"
          />
        </div>
      )
    case FileCategory.VIDEO:
      return (
        <div className="flex items-center justify-center h-full p-4 ph-no-capture">
          <video src={fileUrl} controls className="max-w-full max-h-full shadow-lg">
            {t('您的浏览器不支持视频播放')}
          </video>
        </div>
      )
    case FileCategory.AUDIO:
      return (
        <div className="flex flex-col items-center justify-center h-full p-4 ph-no-capture">
          <MaterialIcon icon="audiotrack" className="text-8xl text-primary mb-8" />
          <audio src={fileUrl} controls className="w-full max-w-md">
            {t('您的浏览器不支持音频播放')}
          </audio>
        </div>
      )
    case FileCategory.TEXT:
    case FileCategory.EBOOK:
    case FileCategory.CODE:
    default:
      if (textContent !== null) {
        return (
          <div className="h-full flex flex-col overflow-hidden ph-no-capture">
            {isTruncated && (
              <div className="flex items-center justify-between px-6 py-2.5 bg-amber-500/10 border-b border-amber-500/20 text-[11px] text-amber-700 font-medium shrink-0">
                <div className="flex items-center min-w-0">
                  <MaterialIcon
                    icon="warning"
                    className="mr-2 text-sm text-amber-600 animate-bounce"
                  />
                  <span className="truncate">
                    {t(
                      '当前文本文件体积较大（{size}），为保证流畅度系统已截断展示前 100,000 字。',
                      {
                        size: formatSize(fileSize)
                      }
                    )}
                  </span>
                </div>
                <button
                  onClick={handleOpenExternal}
                  className="px-3 py-1 bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition-colors shadow-sm font-bold ml-3 shrink-0"
                >
                  {t('打开完整文件')}
                </button>
              </div>
            )}
            <div className="flex-1 overflow-auto p-4 bg-muted/20">
              <pre className="text-[15px] whitespace-pre-wrap break-words text-foreground/90 dark:text-foreground/70 leading-8 tracking-wide font-sans selection:bg-primary/20">
                {textContent}
              </pre>
            </div>
          </div>
        )
      }
      return renderUnsupported()
  }
}
