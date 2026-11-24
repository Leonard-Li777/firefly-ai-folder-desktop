import React from 'react'
import i18nScope, { t } from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'
import { MaterialIcon } from '../../../../lib/utils'
import { Button } from '../../../ui/button'

interface DetailsBottomActionsProps {
  isDirectory: boolean
  showDirectory: boolean
  analysisResult: any
  reanalyzing: boolean
  queueStatus?: string | null
  deleting: boolean
  isFileAnalysis: (res: any) => boolean
  isDirAnalysis: (res: any) => boolean
  handleReanalyze: () => void
  handleDirectoryReanalyze: () => void
  handleBatchAnalyzeSubfiles: () => void
  onOpenClearDialog: () => void
}

export const DetailsBottomActions: React.FC<DetailsBottomActionsProps> = ({
  isDirectory,
  showDirectory,
  analysisResult,
  reanalyzing,
  queueStatus,
  deleting,
  isFileAnalysis,
  isDirAnalysis,
  handleReanalyze,
  handleDirectoryReanalyze,
  handleBatchAnalyzeSubfiles,
  onOpenClearDialog
}) => {
  const { t } = useVoerkaI18n(i18nScope)
  const isDirMode = isDirectory || showDirectory

  // 分析状态文本指示
  const statusText = React.useMemo(() => {
    if (reanalyzing) {
      return queueStatus === 'pending' ? t('队列排队中...') : t('AI 正在深度解析...')
    }
    if (isDirMode) {
      if (analysisResult && isDirAnalysis(analysisResult)) {
        const analyzed = analysisResult.analyzedFileCount ?? 0
        const total = analysisResult.fileCount ?? 0
        return t('目录已分析 {analyzed} / {total} 个文件', { analyzed, total })
      }
      return t('未生成目录整体画像')
    }
    if (analysisResult && isFileAnalysis(analysisResult) && analysisResult.isAnalyzed) {
      return t('已完成智能解析')
    }
    return t('未分析')
  }, [reanalyzing, queueStatus, isDirMode, analysisResult, isDirAnalysis, isFileAnalysis, t])

  const showClearButton = Boolean(
    analysisResult &&
      ((isFileAnalysis(analysisResult) && analysisResult.isAnalyzed) ||
        isDirAnalysis(analysisResult))
  )

  return (
    <div
      data-testid="details-bottom-actions"
      className="border-t border-border/40 px-3.5 py-2.5 bg-card shrink-0 mt-auto flex items-center justify-between gap-3 overflow-hidden select-none"
    >
      {/* 左侧：轻量状态与统计指示槽（宽屏展示，窄屏截断折叠） */}
      <div className="flex-1 min-w-0 text-xs text-muted-foreground/80 truncate hidden @[540px]/details:block">
        <span className="truncate">{statusText}</span>
      </div>

      {/* 右侧：紧凑操作按钮集群（固定靠右，严禁通栏拉伸） */}
      <div className="flex items-center gap-2 justify-end shrink-0 w-full @[540px]/details:w-auto">
        {isDirMode ? (
          <>
            {/* 目录画像按钮 */}
            <Button
              variant="secondary"
              size="sm"
              className="h-8 px-2.5 min-w-[88px] max-w-[130px] text-xs truncate flex-1 @[540px]/details:flex-initial"
              onClick={handleDirectoryReanalyze}
              disabled={reanalyzing}
              title={t('分析目录特征，以指导目录中文件的后续分析')}
            >
              {reanalyzing ? (
                <div className="animate-spin rounded-full h-3.5 w-3.5 border-t-2 border-b-2 border-primary mr-1 shrink-0" />
              ) : (
                <MaterialIcon icon="auto_awesome" className="text-sm mr-1 shrink-0" />
              )}
              <span className="truncate">{t('目录画像')}</span>
            </Button>

            {/* 批量分析子文件 */}
            <Button
              variant="default"
              size="sm"
              className="h-8 px-3 min-w-[96px] max-w-[140px] text-xs font-medium truncate flex-1 @[540px]/details:flex-initial"
              onClick={handleBatchAnalyzeSubfiles}
              disabled={reanalyzing}
              title={t('分析整个目录中的文件')}
            >
              <MaterialIcon icon="refresh" className="text-sm mr-1.5 shrink-0" />
              <span className="truncate">
                {analysisResult && isDirAnalysis(analysisResult) && analysisResult.analyzedFileCount > 0
                  ? t('重新分析')
                  : t('分析子文件')}
              </span>
            </Button>
          </>
        ) : (
          /* 单文件分析操作 */
          <Button
            variant="default"
            size="sm"
            className="h-8 px-3 min-w-[96px] max-w-[140px] text-xs font-medium truncate flex-1 @[540px]/details:flex-initial"
            onClick={handleReanalyze}
            disabled={reanalyzing}
          >
            {reanalyzing ? (
              <div className="animate-spin rounded-full h-3.5 w-3.5 border-t-2 border-b-2 border-primary mr-1.5 shrink-0" />
            ) : (
              <MaterialIcon icon="refresh" className="text-sm mr-1.5 shrink-0" />
            )}
            <span className="truncate">
              {analysisResult && isFileAnalysis(analysisResult) && analysisResult.isAnalyzed
                ? t('重新分析')
                : t('立即分析')}
            </span>
          </Button>
        )}

        {/* 清空结果方块按钮 (h-8 w-8) */}
        {showClearButton && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 p-0 shrink-0 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
            onClick={onOpenClearDialog}
            disabled={deleting || reanalyzing}
            title={t('清空分析结果')}
          >
            <MaterialIcon icon="delete_forever" className="text-base" />
          </Button>
        )}
      </div>
    </div>
  )
}
