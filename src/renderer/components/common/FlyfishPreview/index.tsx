import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import FileViewer, { type FileViewerHandle } from '@file-viewer/react'
import { allRenderers } from '@file-viewer/preset-all'
import { Loading } from '../Loading'
import { ErrorBoundary } from '../ErrorBoundary'
import { t } from '@app/languages'
import { MaterialIcon } from '../../../lib/utils'
import { useConfigStore } from '../../../stores/config-store'
import { logger, LogCategory } from '@firefly/shared'

const configuredFileViewerRenderers = [allRenderers]

// 解析 file-viewer 静态资源根路径：资源目录与渲染进程入口（index.html/preview.html）同级，
// 即 <root>/file-viewer/。必须返回绝对 URL 且指向非版本化路径（wasm/cad/），
// 否则 cad 渲染器会按 core 默认的版本化路径（wasm/cad/0.8.0/）以及不含 file-viewer/ 前缀的
// 基础路径解析，导致 DWG worker 加载 404 而报 "DWG worker failed"。
function resolveFileViewerAssetBaseUrl(): string {
  if (typeof document === 'undefined') {
    return '/file-viewer/'
  }
  return new URL('file-viewer/', document.baseURI).href
}

function resolveViewerLocale(language: string | undefined): string {
  if (!language || language.startsWith('zh')) {
    return 'zh-CN'
  }
  return 'en-US'
}

export interface FlyfishPreviewProps {
  filePath: string
  fileName: string
  theme?: 'light' | 'dark' | 'system'
}

export const FlyfishPreview: React.FC<FlyfishPreviewProps> = ({
  filePath,
  fileName,
  theme = 'system'
}) => {
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [fileUrl, setFileUrl] = useState<string | null>(null)
  const [fileBuffer, setFileBuffer] = useState<ArrayBuffer | null>(null)
  const [loadMode, setLoadMode] = useState<'url' | 'buffer'>('url')
  const viewerRef = useRef<FileViewerHandle>(null)
  const config = useConfigStore(s => s.config)
  const viewerLocale = useMemo(() => resolveViewerLocale(config?.language), [config?.language])

  const timeRef = useRef<number>(0)

  // 1. 根据文件类型选择加载策略：归档文件通过 IPC 读取为 ArrayBuffer，其余格式使用直连 URL
  useEffect(() => {
    setIsLoading(true)
    setError(null)
    setFileUrl(null)
    setFileBuffer(null)
    timeRef.current = performance.now()

    const ext = fileName.toLowerCase().split('.').pop()
    const isArchive = ['zip', 'cbz', 'rar', 'cbr', '7z', 'tar', 'gz'].includes(ext || '')

    logger.info(LogCategory.RENDERER, `[FlyfishPreview] 开始准备文件预览`, {
      filePath,
      fileName,
      ext,
      isArchive
    })

    if (isArchive) {
      logger.info(
        LogCategory.RENDERER,
        `[FlyfishPreview] ⏱️ 归档格式使用 IPC Buffer 模式加载: ${fileName}`
      )
      ;(async () => {
        try {
          const uint8Array = await window.electronAPI.utils.readFileBuffer(filePath)
          setFileBuffer(uint8Array.buffer as ArrayBuffer)
          setLoadMode('buffer')
          logger.info(
            LogCategory.RENDERER,
            `[FlyfishPreview] ⏱️ IPC 读取归档成功, 耗时: ${(performance.now() - timeRef.current).toFixed(2)}ms, byteLength=${uint8Array.buffer.byteLength}`
          )
        } catch (e) {
          logger.error(LogCategory.RENDERER, '读取归档二进制失败:', e)
          setIsLoading(false)
          setError(t('无法加载文件预览，请检查文件权限或格式。'))
        }
      })()
    } else {
      logger.info(
        LogCategory.RENDERER,
        `[FlyfishPreview] ⏱️ 文档格式使用直连 URL 模式加载: ${fileName}`
      )
      try {
        let url = filePath.replace(/\\/g, '/')
        if (!url.startsWith('file:///')) {
          url = `file:///${url}`
        }
        // 1. 手动转义 # 和 ?，防止 file:/// URL 被 Chromium 识别为 hash 锚点或 query 参数
        url = url.replace(/#/g, '%23').replace(/\?/g, '%3F')
        // 2. 使用 encodeURI 对其余路径字符（如中文、空格等）进行 URI 编码
        let encodedUrl = encodeURI(url)
        // 3. 补充防御：如果 encodeURI 在特定引擎下保留了 [ 和 ]，对其强制转义（Chromium 解析 file:/// 未转义的 [ ] 会报 ERR_FAILED）
        encodedUrl = encodedUrl.replace(/\[/g, '%5B').replace(/\]/g, '%5D')

        logger.info(LogCategory.RENDERER, `[FlyfishPreview] 构建预览 URL 成功`, {
          originalFilePath: filePath,
          encodedUrl
        })

        setFileUrl(encodedUrl)
        setLoadMode('url')
      } catch (e) {
        logger.error(LogCategory.RENDERER, '构建文件 URL 失败:', e)
        setIsLoading(false)
        setError(t('无法加载文件预览，请检查文件路径或格式。'))
      }
    }
  }, [filePath, fileName])

  // 2. 事件处理
  const handleEvent = useCallback((event: { type: string; payload?: unknown }) => {
    const { type } = event
    logger.info(LogCategory.RENDERER, `[FlyfishPreview] ⏱️ 接收到渲染器事件: ${type}`)
    if (type === 'load-complete') {
      setIsLoading(false)
      logger.info(
        LogCategory.RENDERER,
        `[FlyfishPreview] ⏱️ 渲染总耗时 (自开始加载起): ${(performance.now() - timeRef.current).toFixed(2)}ms`
      )
    } else if (type === 'error') {
      const payload = event.payload as { message?: string } | undefined
      logger.error(LogCategory.RENDERER, 'FileViewer preview failed:', event)
      setIsLoading(false)
      setError(payload?.message || t('无法加载预览，请检查文件格式或重试。'))
    }
  }, [])

  // 3. memoize options 避免每次渲染创建新对象引用
  //    FileViewer 内部通过 useMemo 依赖 options 引用判断是否需要 update
  //    引用变化会触发 controller.update() → loadSource() 导致文件重新加载
  const viewerOptions = useMemo(() => {
    // vite-plugin 将 @flyfish-dev/cad-viewer/dist/wasm 拷贝到 file-viewer/wasm/cad/（非版本化），
    // 与 core 默认的版本化路径（wasm/cad/0.8.0/）不一致，这里显式指定绝对资源地址。
    const assetBaseUrl = resolveFileViewerAssetBaseUrl()
    return {
      theme,
      locale: viewerLocale,
      toolbar: { position: 'bottom-right' as const },
      builtinRenderers: 'none' as const,
      rendererMode: 'replace' as const,
      renderers: configuredFileViewerRenderers as any,
      docx: { worker: false },
      spreadsheet: { worker: false },
      archive: {},
      cad: {
        useWorker: true,
        wasmPath: `${assetBaseUrl}wasm/cad`,
        workerUrl: `${assetBaseUrl}wasm/cad/dwg-worker.js`,
        dwfWasmUrl: `${assetBaseUrl}wasm/cad/dwfv-render.wasm`
      }
    }
  }, [theme, viewerLocale])

  if (error) {
    return (
      <div className="relative w-full h-full flex flex-col items-center justify-center p-8 bg-background/50">
        <MaterialIcon icon="error_outline" className="text-4xl text-destructive/80 mb-4" />
        <h3 className="text-lg font-medium text-foreground mb-2">{t('预览加载失败')}</h3>
        <p className="text-sm text-muted-foreground text-center max-w-md">{error}</p>
      </div>
    )
  }

  return (
    <div className="relative w-full h-full bg-background ph-no-capture">
      <ErrorBoundary>
        {((loadMode === 'url' && !fileUrl) ||
          (loadMode === 'buffer' && !fileBuffer) ||
          isLoading) && (
          <div className="absolute inset-0 flex items-center justify-center z-10 bg-background/80 backdrop-blur-sm">
            <Loading title={t('加载预览中...')} />
          </div>
        )}
        {loadMode === 'buffer' && fileBuffer && (
          <FileViewer
            key={`${filePath}-${theme}`}
            ref={viewerRef}
            buffer={fileBuffer}
            name={fileName}
            options={viewerOptions}
            onEvent={handleEvent}
            className="w-full h-full"
          />
        )}
        {loadMode === 'url' && fileUrl && (
          <FileViewer
            key={`${fileUrl}-${theme}`}
            ref={viewerRef}
            url={fileUrl}
            name={fileName}
            options={viewerOptions}
            onEvent={handleEvent}
            className="w-full h-full"
          />
        )}
      </ErrorBoundary>
    </div>
  )
}

export default FlyfishPreview
