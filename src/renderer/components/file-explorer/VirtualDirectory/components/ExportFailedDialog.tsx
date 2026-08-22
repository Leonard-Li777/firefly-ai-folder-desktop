import React, { useState } from 'react'
import { t } from '@app/languages'
import { getFileNameFromPath } from '@firefly/shared'
import { MaterialIcon } from '../../../../lib/utils'
import { Button } from '../../../ui/button'

interface ExportFailedDialogProps {
  isOpen: boolean
  onClose: () => void
  failedFiles: string[]
  exportedCount: number
  /** 失败文件的操作信息（源路径+目标路径），用于拷贝模式重试 */
  failedOperations?: Array<{ source: string; target: string }>
  /** 拷贝模式重试回调 */
  onRetryWithCopy?: (operations: Array<{ source: string; target: string }>) => Promise<void>
}

/**
 * 导出失败文件清单弹窗
 * 当导出操作有文件失败时，展示失败文件列表，并提供拷贝模式重试按钮
 */
export const ExportFailedDialog: React.FC<ExportFailedDialogProps> = ({
  isOpen,
  onClose,
  failedFiles,
  exportedCount,
  failedOperations,
  onRetryWithCopy
}) => {
  const [isRetrying, setIsRetrying] = useState(false)

  if (!isOpen) return null

  const handleRetryWithCopy = async () => {
    if (!failedOperations?.length || !onRetryWithCopy) return
    setIsRetrying(true)
    try {
      await onRetryWithCopy(failedOperations)
      onClose()
    } finally {
      setIsRetrying(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-card text-card-foreground rounded-lg shadow-xl max-w-lg w-full p-6 border border-border">
        {/* 头部 */}
        <div className="flex items-center mb-4">
          <MaterialIcon icon="warning" className="text-amber-500 text-4xl mr-3" />
          <div>
            <h2 className="text-xl font-bold text-foreground">{t('导出完成')}</h2>
            <p className="text-sm text-muted-foreground">
              {t('成功导出 {count} 个文件，{failed} 个文件失败', {
                count: exportedCount,
                failed: failedFiles.length
              })}
            </p>
          </div>
        </div>

        {/* 统计信息 */}
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-900/50 rounded-lg p-3">
            <p className="text-sm text-green-600 dark:text-green-400 mb-1">{t('成功')}</p>
            <p className="text-2xl font-bold text-green-900 dark:text-green-100">{exportedCount}</p>
          </div>
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-900/50 rounded-lg p-3">
            <p className="text-sm text-red-600 dark:text-red-400 mb-1">{t('失败')}</p>
            <p className="text-2xl font-bold text-red-900 dark:text-red-100">
              {failedFiles.length}
            </p>
          </div>
        </div>

        {/* 失败文件列表 */}
        {failedFiles.length > 0 && (
          <div className="mb-4">
            <h3 className="font-semibold text-red-700 dark:text-red-400 mb-2 flex items-center">
              <MaterialIcon icon="error" className="text-base mr-1" />
              {t('失败文件列表')}
            </h3>
            <div className="bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-900/30 rounded p-3 max-h-48 overflow-y-auto">
              {failedFiles.slice(0, 20).map((filePath, index) => (
                <div key={index} className="text-sm mb-2 last:mb-0 flex items-start">
                  <MaterialIcon
                    icon="cancel"
                    className="text-red-400 text-sm mr-2 mt-0.5 flex-shrink-0"
                  />
                  <div className="min-w-0">
                    <p className="text-red-900 dark:text-red-200 break-all" title={filePath}>
                      {getFileNameFromPath(filePath)}
                    </p>
                    <p className="text-red-500 dark:text-red-400 text-xs truncate">{filePath}</p>
                  </div>
                </div>
              ))}
              {failedFiles.length > 20 && (
                <p className="text-xs text-red-600 dark:text-red-400 text-center mt-2">
                  {t('还有 {count} 个文件...', { count: failedFiles.length - 20 })}
                </p>
              )}
            </div>
          </div>
        )}

        {/* 提示信息 */}
        <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-900/50 rounded p-3 mb-4">
          <div className="flex items-start">
            <MaterialIcon icon="info" className="text-blue-500 text-sm mr-2 mt-0.5 flex-shrink-0" />
            <p className="text-sm text-blue-700 dark:text-blue-300">
              {t(
                '失败文件可能是因为文件类型不支持创建链接（如 .lnk 快捷方式），或文件已被移动/删除。'
              )}
            </p>
          </div>
        </div>

        {/* 操作按钮 */}
        <div className="flex justify-end space-x-3">
          {failedOperations && failedOperations.length > 0 && onRetryWithCopy && (
            <div className="relative group">
              <Button variant="outline" onClick={handleRetryWithCopy} disabled={isRetrying}>
                {isRetrying ? (
                  <>
                    <MaterialIcon icon="sync" className="text-base mr-1 animate-spin" />
                    {t('正在重试...')}
                  </>
                ) : (
                  <>
                    <MaterialIcon icon="content_copy" className="text-base mr-1" />
                    {t('拷贝模式重试')}
                  </>
                )}
              </Button>
              {/* 悬浮 tooltip */}
              <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 hidden group-hover:block z-50">
                <div className="bg-gray-900 text-white text-xs rounded py-1.5 px-3 whitespace-nowrap shadow-lg">
                  {t('失败文件通过复制重试，此模式会占用空间')}
                  <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-gray-900" />
                </div>
              </div>
            </div>
          )}
          <Button variant="default" onClick={onClose}>
            {t('我知道了')}
          </Button>
        </div>
      </div>
    </div>
  )
}
