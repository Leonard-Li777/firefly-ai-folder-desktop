import React, { useCallback, useEffect, useState } from 'react'
import { MaterialIcon } from '../../../../lib/utils'
import { formatDuration } from '@firefly/shared'
import { t } from '@app/languages'

export const PreviewSection: React.FC<any> = ({
  displayUrl,
  item,
  showDirectory,
  isDirectory,
  analysisResult,
  isFileAnalysis
}) => {
  const [imgError, setImgError] = useState(false)

  // displayUrl 变化时重置错误状态，避免旧图片的错误影响新图片
  useEffect(() => {
    setImgError(false)
  }, [displayUrl])

  const handleImgError = useCallback(() => {
    setImgError(true)
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
        <div className="relative w-full aspect-video bg-muted rounded-lg overflow-hidden border border-border shadow-sm flex items-center justify-center group">
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
        {analysisResult &&
          isFileAnalysis(analysisResult) &&
          (analysisResult.isHit || analysisResult.analysisStats) && (
            <div className="mt-3 flex justify-center">
              <div className="inline-flex items-center gap-1.5 bg-primary/10 text-primary px-3 py-1 rounded-full text-[10px] font-bold border border-primary/20 shadow-sm">
                {analysisResult.isHit ? (
                  <>
                    <MaterialIcon icon="cloud_done" className="text-xs" />
                    {t('来自云端缓存')}
                  </>
                ) : analysisResult.analysisStats ? (
                  <>
                    <MaterialIcon icon="timer" className="text-xs" />
                    <span>
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
            <div className="inline-flex items-center gap-1 bg-primary/10 text-primary px-2 py-0.5 rounded-full text-[10px] font-bold border border-primary/20">
              {analysisResult.isHit ? (
                <>
                  <MaterialIcon icon="cloud_done" className="text-xs" />
                  {t('来自云端缓存')}
                </>
              ) : analysisResult.analysisStats ? (
                <>
                  <MaterialIcon icon="timer" className="text-xs" />
                  <span>
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
