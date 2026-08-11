import React from 'react'
import { MaterialIcon } from '../../lib/utils'
import path from 'path-browserify'
import { t } from '@app/languages'

interface OrganizeError {
  filePath: string
  error: string
}

interface OrganizeErrorDialogProps {
  successCount: number
  errors: OrganizeError[]
  onViewLog?: () => void
  onRetry?: () => void
  onClose: () => void
}

/**
 * 整理错误对话框
 * 显示整理过程中遇到的错误
 */
export const OrganizeErrorDialog: React.FC<OrganizeErrorDialogProps> = ({
  successCount,
  errors,
  onViewLog,
  onRetry,
  onClose,
}) => {
  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-card text-card-foreground rounded-lg shadow-xl max-w-2xl w-full p-6 max-h-[80vh] flex flex-col border border-border">
        <div className="flex items-center mb-4">
          <MaterialIcon icon="error" className="text-red-500 text-3xl mr-3" />
          <h2 className="text-xl font-bold">{t('整理过程中遇到错误')}</h2>
        </div>

        <div className="mb-4 space-y-1">
          <p className="text-green-600 flex items-center">
            <MaterialIcon icon="check_circle" className="text-base mr-1" />
            {t('已完成：{count} 个文件', { count: successCount })}
          </p>
          <p className="text-red-600 flex items-center">
            <MaterialIcon icon="cancel" className="text-base mr-1" />
            {t('失败：{count} 个文件', { count: errors.length })}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto mb-6">
          <h3 className="font-semibold mb-2">{t('失败文件列表：')}</h3>
          <div className="border border-border rounded p-3 bg-muted/30 dark:bg-muted/10 space-y-3">
            {errors.map((error, index) => (
              <div key={index} className="pb-3 last:pb-0 border-b border-border last:border-b-0">
                <p className="font-medium text-foreground truncate" title={error.filePath}>
                  {path.basename(error.filePath)}
                </p>
                <p className="text-sm text-red-500 mt-1">{t('错误：')}{error.error}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="flex justify-end space-x-3">
          {onViewLog && (
            <button
              onClick={onViewLog}
              className="px-4 py-2 border border-input rounded hover:bg-accent hover:text-accent-foreground text-foreground transition-colors"
            >
              {t('查看详细日志')}
            </button>
          )}
          {onRetry && (
            <button
              onClick={onRetry}
              className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors"
            >
              {t('重试失败文件')}
            </button>
          )}
          <button
            onClick={onClose}
            className="px-4 py-2 border border-input rounded hover:bg-accent hover:text-accent-foreground text-foreground transition-colors"
          >
            {t('关闭')}
          </button>
        </div>
      </div>
    </div>
  )
}

