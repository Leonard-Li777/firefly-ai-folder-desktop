import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import FileViewer, { type FileViewerHandle } from '@file-viewer/react'
import standardPreset from '@file-viewer/preset-standard'
import { Loading } from '../Loading'
import { ErrorBoundary } from '../ErrorBoundary'
import { t } from '@app/languages'
import { MaterialIcon } from '../../../lib/utils'
import { useConfigStore } from '../../../stores/config-store'
import { logger, LogCategory } from '@firefly/shared'

// 定义非常见/专业格式的动态按需 import 映射表（Vite 会自动代码分割为独立异步 Chunk）
const SPECIALIST_RENDERER_LOADERS: Record<string, () => Promise<any>> = {
  // CAD 工程图纸
  dwg: () => import('@file-viewer/renderer-cad').then(m => m.cadRenderer),
  dxf: () => import('@file-viewer/renderer-cad').then(m => m.cadRenderer),
  dwf: () => import('@file-viewer/renderer-cad').then(m => m.cadRenderer),
  dwfx: () => import('@file-viewer/renderer-cad').then(m => m.cadRenderer),
  xps: () => import('@file-viewer/renderer-cad').then(m => m.cadRenderer),

  // 3D 工业模型与网格
  step: () => import('@file-viewer/renderer-3d').then(m => m.modelRenderer),
  stp: () => import('@file-viewer/renderer-3d').then(m => m.modelRenderer),
  iges: () => import('@file-viewer/renderer-3d').then(m => m.modelRenderer),
  igs: () => import('@file-viewer/renderer-3d').then(m => m.modelRenderer),
  gltf: () => import('@file-viewer/renderer-3d').then(m => m.modelRenderer),
  glb: () => import('@file-viewer/renderer-3d').then(m => m.modelRenderer),
  obj: () => import('@file-viewer/renderer-3d').then(m => m.modelRenderer),
  stl: () => import('@file-viewer/renderer-3d').then(m => m.modelRenderer),
  ply: () => import('@file-viewer/renderer-3d').then(m => m.modelRenderer),
  fbx: () => import('@file-viewer/renderer-3d').then(m => m.modelRenderer),
  dae: () => import('@file-viewer/renderer-3d').then(m => m.modelRenderer),
  '3ds': () => import('@file-viewer/renderer-3d').then(m => m.modelRenderer),
  '3mf': () => import('@file-viewer/renderer-3d').then(m => m.modelRenderer),
  amf: () => import('@file-viewer/renderer-3d').then(m => m.modelRenderer),
  usd: () => import('@file-viewer/renderer-3d').then(m => m.modelRenderer),
  usda: () => import('@file-viewer/renderer-3d').then(m => m.modelRenderer),
  usdc: () => import('@file-viewer/renderer-3d').then(m => m.modelRenderer),
  usdz: () => import('@file-viewer/renderer-3d').then(m => m.modelRenderer),
  ifc: () => import('@file-viewer/renderer-3d').then(m => m.modelRenderer),
  '3dm': () => import('@file-viewer/renderer-3d').then(m => m.modelRenderer),

  // DICOM 医疗影像 (3.0 新特性)
  dcm: () => import('@file-viewer/renderer-dicom').then(m => m.dicomRenderer),
  dicom: () => import('@file-viewer/renderer-dicom').then(m => m.dicomRenderer),

  // 电子签名与存证容器 (3.0 新特性)
  p7m: () => import('@file-viewer/renderer-signature').then(m => m.signatureRenderer),
  p7s: () => import('@file-viewer/renderer-signature').then(m => m.signatureRenderer),
  asics: () => import('@file-viewer/renderer-signature').then(m => m.signatureRenderer),
  asice: () => import('@file-viewer/renderer-signature').then(m => m.signatureRenderer),
  jws: () => import('@file-viewer/renderer-signature').then(m => m.signatureRenderer),
  asc: () => import('@file-viewer/renderer-signature').then(m => m.signatureRenderer),
  sig: () => import('@file-viewer/renderer-signature').then(m => m.signatureRenderer),

  // 地理信息 GIS
  geojson: () => import('@file-viewer/renderer-geo').then(m => m.geoRenderer),
  kml: () => import('@file-viewer/renderer-geo').then(m => m.geoRenderer),
  gpx: () => import('@file-viewer/renderer-geo').then(m => m.geoRenderer),
  shp: () => import('@file-viewer/renderer-geo').then(m => m.geoRenderer),

  // 思维导图
  xmind: () => import('@file-viewer/renderer-mindmap').then(m => m.mindmapRenderer),

  // 流程图与专业绘图
  excalidraw: () => import('@file-viewer/renderer-drawing').then(m => m.drawingRenderer),
  drawio: () => import('@file-viewer/renderer-drawing').then(m => m.drawingRenderer),
  dio: () => import('@file-viewer/renderer-drawing').then(m => m.drawingRenderer),
  mermaid: () => import('@file-viewer/renderer-drawing').then(m => m.drawingRenderer),
  mmd: () => import('@file-viewer/renderer-drawing').then(m => m.drawingRenderer),
  plantuml: () => import('@file-viewer/renderer-drawing').then(m => m.drawingRenderer),
  puml: () => import('@file-viewer/renderer-drawing').then(m => m.drawingRenderer),

  // Typst 现代排版
  typ: () => import('@file-viewer/renderer-typst').then(m => m.typstRenderer),
  typst: () => import('@file-viewer/renderer-typst').then(m => m.typstRenderer),

  // EDA 电子电路
  olb: () => import('@file-viewer/renderer-eda').then(m => m.edaRenderer),
  dra: () => import('@file-viewer/renderer-eda').then(m => m.edaRenderer),
  gds: () => import('@file-viewer/renderer-eda').then(m => m.edaRenderer),
  oas: () => import('@file-viewer/renderer-eda').then(m => m.edaRenderer),
  oasis: () => import('@file-viewer/renderer-eda').then(m => m.edaRenderer),

  // 数据 / 设计文件 / 电子书
  psd: () => import('@file-viewer/renderer-data').then(m => m.dataRenderer),
  sqlite: () => import('@file-viewer/renderer-data').then(m => m.dataRenderer),
  parquet: () => import('@file-viewer/renderer-data').then(m => m.dataRenderer),
  avro: () => import('@file-viewer/renderer-data').then(m => m.dataRenderer),
  wasm: () => import('@file-viewer/renderer-data').then(m => m.dataRenderer),
  webarchive: () => import('@file-viewer/renderer-data').then(m => m.dataRenderer),
  epub: () => import('@file-viewer/renderer-epub').then(m => m.ebookRenderer),
  umd: () => import('@file-viewer/renderer-epub').then(m => m.ebookRenderer)
}

// 缓存已加载的动态渲染器实例，避免重复加载
const loadedSpecialistRenderersCache = new Map<string, any>()

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
  const [specialistRenderers, setSpecialistRenderers] = useState<any[]>([])
  const viewerRef = useRef<FileViewerHandle>(null)
  const config = useConfigStore(s => s.config)
  const viewerLocale = useMemo(() => resolveViewerLocale(config?.language), [config?.language])

  const timeRef = useRef<number>(0)

  // 1. 根据文件类型选择加载策略：归档文件通过 IPC 读取为 ArrayBuffer，其余格式使用直连 URL；并按需加载专用渲染器
  useEffect(() => {
    let isMounted = true
    setIsLoading(true)
    setError(null)
    setFileUrl(null)
    setFileBuffer(null)
    setSpecialistRenderers([])
    timeRef.current = performance.now()

    const ext = fileName.toLowerCase().split('.').pop() || ''
    const isArchive = ['zip', 'cbz', 'rar', 'cbr', '7z', 'tar', 'gz'].includes(ext)

    logger.info(LogCategory.RENDERER, `[FlyfishPreview] 开始准备文件预览`, {
      filePath,
      fileName,
      ext,
      isArchive
    })

    ;(async () => {
      try {
        // 动态加载非常见/专业格式渲染器
        const specialistLoader = SPECIALIST_RENDERER_LOADERS[ext]
        if (specialistLoader) {
          if (loadedSpecialistRenderersCache.has(ext)) {
            if (isMounted) {
              setSpecialistRenderers([loadedSpecialistRenderersCache.get(ext)])
            }
          } else {
            logger.info(
              LogCategory.RENDERER,
              `[FlyfishPreview] ⏱️ 正在动态按需加载格式 [${ext}] 的专用渲染器模块...`
            )
            const dynamicRenderer = await specialistLoader()
            loadedSpecialistRenderersCache.set(ext, dynamicRenderer)
            if (isMounted) {
              setSpecialistRenderers([dynamicRenderer])
              logger.info(
                LogCategory.RENDERER,
                `[FlyfishPreview] ✅ 动态按需加载格式 [${ext}] 专用渲染器成功`
              )
            }
          }
        }

        // 在 Electron 环境下优先通过原生 IPC 读取纯净 ArrayBuffer，彻底规避 Chromium file:/// 协议沙箱限制与 URL 编码问题
        if (window.electronAPI?.utils?.readFileBuffer) {
          logger.info(
            LogCategory.RENDERER,
            `[FlyfishPreview] ⏱️ 使用 IPC Buffer 模式加载本地文件: ${fileName}`
          )
          const uint8Array = await window.electronAPI.utils.readFileBuffer(filePath)
          if (!isMounted) return
          // 关键切片：避免 Node.js Buffer Pool 内存池切片复用导致的底层 byteOffset 脏数据污染
          const cleanBuffer = uint8Array.buffer.slice(
            uint8Array.byteOffset,
            uint8Array.byteOffset + uint8Array.byteLength
          ) as ArrayBuffer
          setFileBuffer(cleanBuffer)
          setLoadMode('buffer')
          logger.info(
            LogCategory.RENDERER,
            `[FlyfishPreview] ⏱️ IPC 读取文件成功, 耗时: ${(performance.now() - timeRef.current).toFixed(2)}ms, byteLength=${cleanBuffer.byteLength}`
          )
        } else {
          // 纯 Web / 测试降级环境：走直连 URL 模式
          logger.info(
            LogCategory.RENDERER,
            `[FlyfishPreview] ⏱️ Web 降级模式使用直连 URL 加载: ${fileName}`
          )
          let url = filePath.replace(/\\/g, '/')
          if (!url.startsWith('file:///')) {
            url = `file:///${url}`
          }
          // 1. 手动转义 # 和 ?，防止 file:/// URL 被识别为 hash 锚点或 query 参数
          url = url.replace(/#/g, '%23').replace(/\?/g, '%3F')
          // 2. 使用 encodeURI 对其余路径字符进行 URI 编码
          let encodedUrl = encodeURI(url)
          // 3. 补充防御：如果 encodeURI 保留了 [ 和 ]，对其强制转义
          encodedUrl = encodedUrl.replace(/\[/g, '%5B').replace(/\]/g, '%5D')

          logger.info(LogCategory.RENDERER, `[FlyfishPreview] 构建预览 URL 成功`, {
            originalFilePath: filePath,
            encodedUrl
          })

          if (!isMounted) return
          setFileUrl(encodedUrl)
          setLoadMode('url')
        }
      } catch (e) {
        logger.error(LogCategory.RENDERER, '准备预览数据或动态加载渲染器失败:', e)
        if (isMounted) {
          setIsLoading(false)
          setError(t('无法加载文件预览，请检查文件权限或格式。'))
        }
      }
    })()

    return () => {
      isMounted = false
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
      styleIsolation: 'shadow' as const,
      toolbar: { position: 'bottom-right' as const },
      preset: standardPreset,
      rendererMode: 'extend' as const,
      renderers: specialistRenderers,
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
  }, [theme, viewerLocale, specialistRenderers])

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
            filename={fileName}
            type={fileName.toLowerCase().split('.').pop() || undefined}
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
            filename={fileName}
            type={fileName.toLowerCase().split('.').pop() || undefined}
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
