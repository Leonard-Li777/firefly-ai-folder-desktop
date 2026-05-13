import React from 'react'
import { t } from '@app/languages'
import { OrganizeProgress } from '@yonuc/types/organize-types'

interface OrganizeProgressDialogProps {
  currentFile: string
  processedCount: number
  totalCount: number
  percentage: number
  estimatedTimeRemaining: number // 秒
  onCancel?: () => void
}

/**
 * 整理进度对话框
 * 显示文件整理的实时进度
 */
export const OrganizeProgressDialog: React.FC<OrganizeProgressDialogProps> = ({
  currentFile,
  processedCount,
  totalCount,
  percentage,
  estimatedTimeRemaining,
  onCancel,
}) => {
  const formatTime = (seconds: number): string => {
    if (seconds < 60) return t('约 {seconds} 秒', { seconds: Math.ceil(seconds) })
    const minutes = Math.ceil(seconds / 60)
    return t('约 {minutes} 分钟', { minutes })
  }

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-card text-card-foreground rounded-lg shadow-xl max-w-md w-full p-6 border border-border">
        <h2 className="text-xl font-bold mb-4 text-foreground">{t('整理进度')}</h2>

        <div className="mb-4">
          <div className="w-full bg-secondary rounded-full h-6 mb-2 overflow-hidden">
            <div
              className="bg-blue-500 h-6 transition-all duration-300 flex items-center justify-center text-white text-xs font-semibold"
              style={{ width: `${percentage}%` }}
            >
              {percentage > 10 && `${percentage}%`}
            </div>
          </div>
          {percentage <= 10 && (
            <p className="text-center text-lg font-semibold text-foreground">{percentage}%</p>
          )}
        </div>

        <div className="space-y-2 text-muted-foreground mb-6">
          <div className="flex items-start">
            <span className="font-semibold min-w-[90px] text-foreground">{t('正在处理：')}</span>
            <span className="flex-1 truncate" title={currentFile}>
              {currentFile || t('准备中...')}
            </span>
          </div>
          <div className="flex items-center">
            <span className="font-semibold min-w-[90px] text-foreground">{t('已完成：')}</span>
            <span>
              {t('{processedCount} / {totalCount} 文件', { processedCount, totalCount })}
            </span>
          </div>
          {estimatedTimeRemaining > 0 && (
            <div className="flex items-center">
              <span className="font-semibold min-w-[90px] text-foreground">{t('预计剩余：')}</span>
              <span>{formatTime(estimatedTimeRemaining)}</span>
            </div>
          )}
        </div>

        {onCancel && (
          <button
            onClick={onCancel}
            className="w-full px-4 py-2 border border-red-500 text-red-500 rounded hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
          >
            {t('取消整理')}
          </button>
        )}
      </div>
    </div>
  )
}

