import React, { useState, useEffect, useRef } from 'react'
import { t } from '@app/languages'
import { MaterialIcon } from '../../../lib/utils'
import { FileCategory, getFileCategory, CATEGORY_EXT_MAP } from '@firefly/shared'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { EmptyState } from '../../common/EmptyState'
import { Button } from '../../ui/button'

interface FilePreviewProps {
  filePath: string
  fileName: string
  onClose?: () => void
}

export const FilePreview: React.FC<FilePreviewProps> = ({ filePath, fileName, onClose }) => {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [category, setCategory] = useState<FileCategory>(FileCategory.UNKNOWN)
  const [content, setContent] = useState<string>('')
  const [isTruncated, setIsTruncated] = useState(false)
  const [fileSize, setFileSize] = useState<number>(0)
  const [imageSrc, setImageSrc] = useState<string>('')

  // 音视频特有的状态
  const [mediaError, setMediaError] = useState(false)

  const currentRequestPath = useRef<string>(filePath)

  useEffect(() => {
    currentRequestPath.current = filePath
    setLoading(true)
    setError(null)
    setContent('')
    setIsTruncated(false)
    setFileSize(0)
    setImageSrc('')
    setMediaError(false)

    const detectAndLoad = async () => {
      try {
        const ext = '.' + filePath.split('.').pop()?.toLowerCase()

        // 严格按照需求中描述的顺序进行匹配
        let fileCat = FileCategory.UNKNOWN

        // 1. 如果是 IMAGE，直接使用 img 标签展示
        if (CATEGORY_EXT_MAP[FileCategory.IMAGE]?.includes(ext)) {
          fileCat = FileCategory.IMAGE
        }
        // 2. 如果是 VIDEO、AUDIO，同样直接展示
        else if (CATEGORY_EXT_MAP[FileCategory.VIDEO]?.includes(ext)) {
          fileCat = FileCategory.VIDEO
        } else if (CATEGORY_EXT_MAP[FileCategory.AUDIO]?.includes(ext)) {
          fileCat = FileCategory.AUDIO
        }
        // 3. 如果是 DOCUMENT、SOURCE、OFFICE (排除 .txt)
        else if (
          (CATEGORY_EXT_MAP[FileCategory.DOCUMENT]?.includes(ext) && ext !== '.txt') ||
          CATEGORY_EXT_MAP[FileCategory.CODE]?.includes(ext) ||
          CATEGORY_EXT_MAP[FileCategory.OFFICE]?.includes(ext)
        ) {
          if (CATEGORY_EXT_MAP[FileCategory.CODE]?.includes(ext)) {
            fileCat = FileCategory.CODE
          } else if (CATEGORY_EXT_MAP[FileCategory.OFFICE]?.includes(ext)) {
            fileCat = FileCategory.OFFICE
          } else {
            fileCat = FileCategory.DOCUMENT
          }
        }
        // 4. 如果是 TEXT，直接 pre 标签展示
        else if (CATEGORY_EXT_MAP[FileCategory.TEXT]?.includes(ext) || ext === '.txt') {
          fileCat = FileCategory.TEXT
        }

        setCategory(fileCat)

        // 无论何种文件，优先尝试通过 getFileAnalysisResult 获取分析结果以获得描述/智能名称等
        const analysisResult = await window.electronAPI.getFileAnalysisResult(filePath)

        // 保证在组件被切换或用户点了新文件时，老请求结果不覆盖新状态
        if (currentRequestPath.current !== filePath) return

        if (analysisResult) {
          setFileSize(analysisResult.size || 0)
        }

        // 根据分类分流处理
        if (fileCat === FileCategory.IMAGE) {
          await handleImageLoad(filePath, analysisResult)
        } else if (fileCat === FileCategory.VIDEO || fileCat === FileCategory.AUDIO) {
          handleMediaLoad(filePath)
        } else if (
          fileCat === FileCategory.DOCUMENT ||
          fileCat === FileCategory.CODE ||
          fileCat === FileCategory.OFFICE
        ) {
          await handleDocumentLoad(filePath, fileCat, analysisResult)
        } else if (fileCat === FileCategory.TEXT) {
          await handleTextLoad(filePath)
        } else {
          // 5. 如果都不是，则通过 file 表中 category 字段中 is_text 属性是否为 true 兜底判定
          await handleFallbackLoad(filePath, analysisResult)
        }
      } catch (err) {
        if (currentRequestPath.current !== filePath) return
        setError(String(err))
        setLoading(false)
      }
    }

    detectAndLoad()
  }, [filePath])

  // ─── 1. 图片加载与转码 ───────────────────────────────────────────────────
  const handleImageLoad = async (path: string, analysisResult: any) => {
    const ext = '.' + path.split('.').pop()?.toLowerCase()
    const nativeImageExtensions = [
      '.jpg',
      '.jpeg',
      '.png',
      '.gif',
      '.webp',
      '.svg',
      '.ico',
      '.bmp',
      '.avif'
    ]

    if (nativeImageExtensions.includes(ext)) {
      // 浏览器原生支持的格式，直接使用 file:// URL 零开销加载
      const fileUrl = `file:///${path.replace(/\\/g, '/')}`
      setImageSrc(fileUrl)
      setLoading(false)
    } else {
      // 浏览器不支持的原生图片格式（如 HEIC, PSD, TIFF，RAW 等）
      // 优先请求主进程获取转码大图
      try {
        const transResult = await window.electronAPI.preview.getTempImage(path)
        if (currentRequestPath.current !== path) return

        if (transResult && transResult.success && transResult.absolutePath) {
          const transUrl = `file:///${transResult.absolutePath.replace(/\\/g, '/')}`
          setImageSrc(transUrl)
        } else {
          setError(transResult?.error || t('图片转码失败'))
        }
      } catch (err) {
        setError(t('图片转码服务异常') + ': ' + String(err))
      } finally {
        setLoading(false)
      }
    }
  }

  // ─── 2. 媒体加载 ────────────────────────────────────────────────────────
  const handleMediaLoad = (path: string) => {
    // 媒体文件本身不用提取文本，直接渲染 <video> / <audio>，所以 loading 可直接置为 false
    setLoading(false)
  }

  // ─── 3. 文档与Office处理 (react-markdown + markitdown-cli) ───────────────
  const handleDocumentLoad = async (path: string, cat: FileCategory, analysisResult: any) => {
    // 选项 B 缓存优先
    if (analysisResult && analysisResult.content) {
      // 数据库中已经存在分析好的 content
      let text = analysisResult.content
      if (cat === FileCategory.CODE) {
        const ext = path.split('.').pop()?.toLowerCase() || ''
        text = `\`\`\`${ext}\n${text}\n\`\`\``
      }
      setContent(text)
      setLoading(false)
    } else {
      // 缓存未命中：显示 Loading，异步启动 markitdown-cli 提取
      try {
        const extractResult = await window.electronAPI.preview.extractDocumentContent(path)
        if (currentRequestPath.current !== path) return

        if (extractResult && extractResult.success && extractResult.content) {
          let text = extractResult.content
          if (cat === FileCategory.CODE) {
            const ext = path.split('.').pop()?.toLowerCase() || ''
            text = `\`\`\`${ext}\n${text}\n\`\`\``
          }
          setContent(text)
        } else {
          setError(extractResult?.error || t('文档内容提取失败'))
        }
      } catch (err) {
        setError(t('文档提取服务发生异常') + ': ' + String(err))
      } finally {
        setLoading(false)
      }
    }
  }

  // ─── 4. TEXT纯文本加载 (带 1MB 限流截断) ──────────────────────────────────
  const handleTextLoad = async (path: string) => {
    try {
      const readResult = await window.electronAPI.preview.readTextLimit(path, 100000)
      if (currentRequestPath.current !== path) return

      if (readResult && readResult.success) {
        setContent(readResult.text)
        setIsTruncated(!!readResult.isTruncated)
        if (readResult.size) setFileSize(readResult.size)
      } else {
        setError(readResult?.error || t('文本内容读取失败'))
      }
    } catch (err) {
      setError(t('文本读取发生异常') + ': ' + String(err))
    } finally {
      setLoading(false)
    }
  }

  // ─── 5. 回退检查 Magika 的 is_text ──────────────────────────────────────
  const handleFallbackLoad = async (path: string, analysisResult: any) => {
    let isText = false

    if (analysisResult && analysisResult.category) {
      try {
        const magikaCat =
          typeof analysisResult.category === 'string'
            ? JSON.parse(analysisResult.category)
            : analysisResult.category
        if (magikaCat && magikaCat.is_text) {
          isText = true
        }
      } catch (e) {
        // Ignore JSON parse error
      }
    }

    if (isText) {
      setCategory(FileCategory.TEXT)
      await handleTextLoad(path)
    } else {
      // 不支持直接预览
      setCategory(FileCategory.UNKNOWN)
      setLoading(false)
    }
  }

  // ─── 6. 辅助工具方法 ──────────────────────────────────────────────────────
  const handleOpenExternal = () => {
    window.electronAPI.utils.openFileWithDefaultApp(filePath)
  }

  const handleShowInFolder = () => {
    window.electronAPI.utils.showItemInFolder(filePath)
  }

  const getFileUrl = (path: string) => {
    return `file:///${path.replace(/\\/g, '/')}`
  }

  const formatSize = (bytes: number) => {
    if (!bytes) return '0 Bytes'
    const k = 1024
    const sizes = ['Bytes', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
  }

  // ─── 7. 各分支渲染 ────────────────────────────────────────────────────────

  // Loading 状态渲染（具有柔和脉动光晕的骨架屏）
  if (loading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 bg-card/10 animate-pulse">
        <div className="w-16 h-16 rounded-2xl bg-muted/60 flex items-center justify-center mb-6">
          <MaterialIcon icon="hourglass_empty" className="text-3xl text-primary/70 animate-spin" />
        </div>
        <p className="text-sm font-bold text-muted-foreground">{t('正在准备文件预览...')}</p>
        <p className="text-xs text-muted-foreground/60 mt-1">{t('请稍候')}</p>
      </div>
    )
  }

  // 异常报错界面
  if (error) {
    return (
      <EmptyState
        icon="error_outline"
        title={t('预览文件时出错')}
        description={
          <div className="text-xs text-muted-foreground max-w-md leading-relaxed bg-muted/50 p-3 rounded-xl border mt-2 select-text text-left">
            {error}
          </div>
        }
      >
        <div className="flex items-center gap-3">
          <Button
            onClick={handleOpenExternal}
            variant="default"
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
  }

  // A. 图片预览渲染
  if (category === FileCategory.IMAGE && imageSrc) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden bg-muted/5 max-h-[70vh]">
        <div className="flex-1 overflow-auto flex items-center justify-center p-6 select-none">
          <img
            src={imageSrc}
            alt={fileName}
            className="max-w-full max-h-full object-contain rounded-xl shadow-xl border bg-card/30 transition-all duration-300 hover:scale-[1.01]"
            onError={() => {
              setError(t('图片加载失败，可能编码不被支持或文件已损坏。'))
            }}
          />
        </div>
      </div>
    )
  }

  // B. 视频和音频预览渲染
  if ((category === FileCategory.VIDEO || category === FileCategory.AUDIO) && !mediaError) {
    const isVideo = category === FileCategory.VIDEO
    const ext = '.' + filePath.split('.').pop()?.toLowerCase()

    // Chromium 原生支持的主流格式
    const playableVideoExts = ['.mp4', '.webm', '.ogg']
    const playableAudioExts = ['.mp3', '.wav', '.ogg', '.flac', '.aac']
    const isPlayable = isVideo ? playableVideoExts.includes(ext) : playableAudioExts.includes(ext)

    if (isPlayable) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center p-8 bg-muted/10">
          <div className="w-full max-w-3xl bg-card rounded-3xl shadow-2xl border overflow-hidden transition-all duration-300">
            {isVideo ? (
              <video
                src={getFileUrl(filePath)}
                controls
                className="w-full max-h-[60vh] aspect-video bg-black object-contain outline-none"
                onError={() => setMediaError(true)}
              />
            ) : (
              <div className="p-8 flex flex-col items-center">
                <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center mb-6 animate-pulse">
                  <MaterialIcon icon="music_note" className="text-4xl text-primary" />
                </div>
                <p
                  className="text-sm font-bold text-center truncate w-full px-4 mb-6"
                  title={fileName}
                >
                  {fileName}
                </p>
                <audio
                  src={getFileUrl(filePath)}
                  controls
                  className="w-full max-w-md outline-none"
                  onError={() => setMediaError(true)}
                />
              </div>
            )}
            <div className="p-4 bg-muted/30 border-t flex justify-between items-center text-xs text-muted-foreground px-6 font-medium">
              <span>{formatSize(fileSize)}</span>
              <button
                onClick={handleOpenExternal}
                className="hover:text-primary transition-colors flex items-center gap-1.5"
              >
                <MaterialIcon icon="launch" className="text-xs" />
                {t('使用外部播放器打开')}
              </button>
            </div>
          </div>
        </div>
      )
    } else {
      // 格式预判不支持
      setMediaError(true)
    }
  }

  // B-降级. 媒体格式不支持时的优雅降级界面
  if (category === FileCategory.VIDEO || category === FileCategory.AUDIO) {
    const ext = filePath.split('.').pop()?.toUpperCase() || ''
    return (
      <EmptyState
        icon="music_off"
        title={t('内置播放器不支持该格式')}
        description={t(
          '格式 .{ext} 不支持在应用内直接播放预览。为了获得完美的视听体验，建议您使用系统默认多媒体程序打开。',
          { ext }
        )}
      >
        <div className="flex items-center gap-3">
          <Button
            onClick={handleOpenExternal}
            variant="default"
            className="font-bold rounded-xl shadow-md"
          >
            <MaterialIcon icon="play_arrow" className="mr-1.5 text-sm" />
            {t('使用默认播放器打开')}
          </Button>
          <Button onClick={handleShowInFolder} variant="outline" className="font-bold rounded-xl">
            <MaterialIcon icon="folder_open" className="mr-1.5 text-sm" />
            {t('在文件夹中定位')}
          </Button>
        </div>
      </EmptyState>
    )
  }

  // C. 纯文本预览渲染 (带限流截断与大文本横幅)
  if (category === FileCategory.TEXT) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden bg-card/30">
        {isTruncated && (
          <div className="flex items-center justify-between px-6 py-2.5 bg-amber-500/10 border-b border-amber-500/20 text-[11px] text-amber-700 font-medium">
            <div className="flex items-center">
              <MaterialIcon icon="warning" className="mr-2 text-sm text-amber-600 animate-bounce" />
              <span>
                {t('当前文本文件体积较大（{size}），为保证流畅度系统已截断展示前 100,000 字。', {
                  size: formatSize(fileSize)
                })}
              </span>
            </div>
            <button
              onClick={handleOpenExternal}
              className="px-3 py-1 bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition-colors shadow-sm font-bold"
            >
              {t('打开完整文件')}
            </button>
          </div>
        )}
        <div className="flex-1 overflow-auto p-6 font-mono text-sm leading-relaxed whitespace-pre-wrap select-text select-all selection:bg-primary/20 bg-muted/5">
          <pre className="text-muted-foreground/90 font-sans text-xs overflow-x-auto leading-relaxed tracking-wide">
            {content}
          </pre>
        </div>
      </div>
    )
  }

  // D. Markdown 渲染 (DOCUMENT, SOURCE, OFFICE)
  if (
    category === FileCategory.DOCUMENT ||
    category === FileCategory.CODE ||
    category === FileCategory.OFFICE
  ) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden bg-card/30">
        <div className="flex-1 overflow-auto p-8 select-text selection:bg-primary/20 bg-muted/5">
          <div className="prose prose-sm dark:prose-invert max-w-4xl mx-auto leading-relaxed markdown-preview">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          </div>
        </div>
      </div>
    )
  }

  // E. 不支持格式的优雅兜底
  const fileExt = filePath.split('.').pop()?.toUpperCase() || 'UNKNOWN'
  return (
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
}

export default FilePreview
