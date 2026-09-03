import React, { useCallback, useEffect, useRef, useState } from 'react'
import { MaterialIcon } from '../../../../lib/utils'
import { formatDuration } from '@firefly/shared'
import { t } from '@app/languages'

const HOVER_PREVIEW_DELAY = 500

export const PreviewSection: React.FC<any> = ({
  displayUrl,
  item,
  showDirectory,
  isDirectory,
  analysisResult,
  isFileAnalysis
}) => {
  const [imgError, setImgError] = useState(false)
  const [hoverPreview, setHoverPreview] = useState(false)
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const imgRef = useRef<HTMLDivElement>(null)

  // displayUrl 变化时重置错误状态，避免旧图片的错误影响新图片
  useEffect(() => {
    setImgError(false)
    setHoverPreview(false)
  }, [displayUrl])

  // 组件卸载时清除定时器
  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) {
        clearTimeout(hoverTimerRef.current)
      }
    }
  }, [])

  const handleImgError = useCallback(() => {
    setImgError(true)
  }, [])

  const handleMouseEnter = useCallback(() => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current)
    }
    hoverTimerRef.current = setTimeout(() => {
      setHoverPreview(true)
    }, HOVER_PREVIEW_DELAY)
  }, [])

  const handleMouseLeave = useCallback(() => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
    setHoverPreview(false)
  }, [])

  const iconName = showDirectory || isDirectory ? 'folder' : 'description'

  // 计算本次分析阶段真实物理耗时
  const getFreshRealDuration = (stats: any): number => {
    if (!stats) return 0
    const fresh = stats.performance?.fresh || stats
    return fresh.durationMs || stats.durationMs || 0
  }

  // 获取使用的 AI 模型名称（兼容 V2.2 结构：performance.fresh.model / performance.archive.model / 根级 model）
  const getModelName = (stats: any): string | null => {
    if (!stats) return null
    const model =
      stats.performance?.fresh?.model || stats.performance?.archive?.model || stats.model
    return model?.name || (typeof model === 'string' ? model : null)
  }

  const modelName = getModelName(analysisResult?.analysisStats)

  // 有 displayUrl 时始终渲染 <img>，加载失败时叠加图标作为兜底
  if (displayUrl) {
    return (
      <>
        <div
          ref={imgRef}
          className="relative w-full aspect-video bg-muted rounded-lg overflow-hidden border border-border shadow-sm flex items-center justify-center group"
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          {/* 图片加载失败时显示的兜底图标 */}
          {imgError && (
            <div className="absolute inset-0 flex items-center justify-center z-10">
              <MaterialIcon icon={iconName} className="text-6xl text-primary" />
            </div>
          )}
          <img
            src={displayUrl}
            alt={item?.name}
            className={`w-full h-full object-contain ${imgError ? 'opacity-0' : ''}`}
            onError={handleImgError}
          />
        </div>

        {/* Hover 延迟浮动大图预览 */}
        {hoverPreview && !imgError && (
          <HoverImagePreview displayUrl={displayUrl} itemName={item?.name} />
        )}
        {analysisResult &&
          isFileAnalysis(analysisResult) &&
          (analysisResult.isHit || analysisResult.analysisStats) && (
            <div className="mt-3 flex justify-center">
              <div className="inline-flex max-w-full items-center gap-1.5 bg-primary/10 text-primary px-3 py-1 rounded-full text-[10px] font-bold border border-primary/20 shadow-sm">
                {analysisResult.isHit ? (
                  <>
                    <MaterialIcon icon="cloud_done" className="text-xs shrink-0" />
                    {t('来自云端缓存')}
                  </>
                ) : analysisResult.analysisStats ? (
                  <>
                    <MaterialIcon icon="timer" className="text-xs shrink-0" />
                    <span className="min-w-0 truncate">
                      {t('分析耗时')}:{' '}
                      {formatDuration(getFreshRealDuration(analysisResult.analysisStats))}
                      {modelName && <span className="opacity-80 ml-1">({modelName})</span>}
                    </span>
                  </>
                ) : null}
              </div>
            </div>
          )}
      </>
    )
  }
  return (
    <div className="relative">
      <MaterialIcon icon={iconName} className="text-6xl text-primary mx-auto" />
      {analysisResult &&
        isFileAnalysis(analysisResult) &&
        (analysisResult.isHit || analysisResult.analysisStats) && (
          <div className="mt-2 flex justify-center">
            <div className="inline-flex max-w-full items-center gap-1 bg-primary/10 text-primary px-2 py-0.5 rounded-full text-[10px] font-bold border border-primary/20">
              {analysisResult.isHit ? (
                <>
                  <MaterialIcon icon="cloud_done" className="text-xs shrink-0" />
                  {t('来自云端缓存')}
                </>
              ) : analysisResult.analysisStats ? (
                <>
                  <MaterialIcon icon="timer" className="text-xs shrink-0" />
                  <span className="min-w-0 truncate">
                    {t('分析耗时')}:{' '}
                    {formatDuration(getFreshRealDuration(analysisResult.analysisStats))}
                    {modelName && <span className="opacity-80 ml-1">({modelName})</span>}
                  </span>
                </>
              ) : null}
            </div>
          </div>
        )}
    </div>
  )
}

// Hover 悬浮大图预览组件：自适应窗口大小，居中浮动显示原图
const HoverImagePreview: React.FC<{ displayUrl: string; itemName?: string }> = ({
  displayUrl,
  itemName
}) => {
  const [error, setError] = useState(false)

  useEffect(() => {
    setError(false)
  }, [displayUrl])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm pointer-events-none animate-in fade-in"
      role="presentation"
    >
      <div className="relative max-w-[85vw] max-h-[85vh] bg-background rounded-lg shadow-2xl border border-border overflow-hidden">
        {error ? (
          <div className="flex-1 min-w-[240px] min-h-[180px] flex items-center justify-center p-8">
            <MaterialIcon icon="broken_image" className="text-4xl text-muted-foreground" />
          </div>
        ) : (
          <img
            src={displayUrl}
            alt={itemName || ''}
            className="block max-w-[85vw] max-h-[85vh] w-auto h-auto object-contain"
            onError={() => setError(true)}
          />
        )}
      </div>
    </div>
  )
}
