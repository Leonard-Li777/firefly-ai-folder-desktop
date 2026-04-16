import React from 'react'
import { OrganizeStatistics } from '@yonuc/types/organize-types'
import { MaterialIcon } from '../../lib/utils'
import { t } from '@app/languages'

interface OrganizeResultDialogProps {
  statistics: OrganizeStatistics
  onClose: () => void
  onOpenDirectory?: () => void
  onExportLog?: () => void
}

/**
 * 整理结果统计对话框
 * 显示整理操作的详细统计信息
 */
export const OrganizeResultDialog: React.FC<OrganizeResultDialogProps> = ({
  statistics,
  onClose,
  onOpenDirectory,
  onExportLog,
}) => {
  const successRate = statistics.totalFiles > 0
    ? Math.round((statistics.movedFiles / statistics.totalFiles) * 100)
    : 0

  const formatTime = (ms: number): string => {
    if (ms < 1000) return t('{ms} 毫秒', { ms })
    if (ms < 60000) return t('{seconds} 秒', { seconds: (ms / 1000).toFixed(1) })
    return t('{minutes} 分钟', { minutes: (ms / 60000).toFixed(1) })
  }

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-card text-card-foreground rounded-lg shadow-xl max-w-2xl w-full p-6 border border-border">
        <div className="flex items-center mb-4">
          {statistics.failedFiles === 0 ? (
            <MaterialIcon icon="check_circle" className="text-green-500 text-4xl mr-3" />
          ) : (
            <MaterialIcon icon="info" className="text-blue-500 text-4xl mr-3" />
          )}
          <div>
            <h2 className="text-xl font-bold text-foreground">{t('整理完成')}</h2>
            <p className="text-sm text-muted-foreground">
              {statistics.failedFiles === 0 ? t('所有文件已成功整理') : t('整理完成，部分文件失败')}
            </p>
          </div>
        </div>

        {/* 成功率进度条 */}
        <div className="mb-6">
          <div className="flex justify-between text-sm mb-1">
            <span className="text-muted-foreground">{t('成功率')}</span>
            <span className="font-semibold text-foreground">{`${successRate}%`}</span>
          </div>
          <div className="w-full bg-secondary rounded-full h-3 overflow-hidden">
            <div
              className={`h-3 transition-all duration-500 ${
                successRate === 100 ? 'bg-green-500' : 'bg-blue-500'
              }`}
              style={{ width: `${successRate}%` }}
            ></div>
          </div>
        </div>

        {/* 统计卡片 */}
        <div className="grid grid-cols-2 gap-4 mb-6">
          <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-900/50 rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-blue-600 dark:text-blue-400 mb-1">{t('总文件数')}</p>
                <p className="text-3xl font-bold text-blue-900 dark:text-blue-100">{statistics.totalFiles}</p>
              </div>
              <MaterialIcon icon="description" className="text-blue-400 text-4xl" />
            </div>
          </div>

          <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-900/50 rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-green-600 dark:text-green-400 mb-1">{t('成功移动')}</p>
                <p className="text-3xl font-bold text-green-900 dark:text-green-100">{statistics.movedFiles}</p>
              </div>
              <MaterialIcon icon="check_circle" className="text-green-400 text-4xl" />
            </div>
          </div>

          <div className="bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-900/50 rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-orange-600 dark:text-orange-400 mb-1">{t('创建目录')}</p>
                <p className="text-3xl font-bold text-orange-900 dark:text-orange-100">{statistics.createdDirectories}</p>
              </div>
              <MaterialIcon icon="folder" className="text-orange-400 text-4xl" />
            </div>
          </div>

          <div className={`${
            statistics.failedFiles > 0 
              ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-900/50' 
              : 'bg-muted/30 border-border'
          } border rounded-lg p-4`}>
            <div className="flex items-center justify-between">
              <div>
                <p className={`text-sm mb-1 ${
                  statistics.failedFiles > 0 ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground'
                }`}>{t('失败文件')}</p>
                <p className={`text-3xl font-bold ${
                  statistics.failedFiles > 0 ? 'text-red-900 dark:text-red-100' : 'text-foreground'
                }`}>{statistics.failedFiles}</p>
              </div>
              <MaterialIcon 
                icon={statistics.failedFiles > 0 ? "error" : "check"} 
                className={`text-4xl ${
                  statistics.failedFiles > 0 ? 'text-red-400' : 'text-muted-foreground'
                }`} 
              />
            </div>
          </div>
        </div>

        {/* 详细信息 */}
        <div className="bg-muted/30 rounded-lg p-4 mb-6">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="flex items-center">
              <MaterialIcon icon="schedule" className="text-muted-foreground text-base mr-2" />
              <span className="text-muted-foreground">{t('耗时：')}</span>
              <span className="ml-auto font-semibold text-foreground">{formatTime(statistics.elapsedTime)}</span>
            </div>
            <div className="flex items-center">
              <MaterialIcon icon="speed" className="text-muted-foreground text-base mr-2" />
              <span className="text-muted-foreground">{t('平均速度：')}</span>
              <span className="ml-auto font-semibold text-foreground">
                {statistics.elapsedTime > 0
                  ? t('{speed} 文件/秒', { speed: ((statistics.movedFiles / statistics.elapsedTime) * 1000).toFixed(1) })
                  : 'N/A'}
              </span>
            </div>
          </div>
        </div>

        {/* 错误列表（如果有） */}
        {statistics.errors.length > 0 && (
          <div className="mb-6">
            <h3 className="font-semibold text-red-700 dark:text-red-400 mb-2 flex items-center">
              <MaterialIcon icon="warning" className="text-base mr-1" />
              {t('失败文件列表')}
            </h3>
            <div className="bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-900/30 rounded p-3 max-h-32 overflow-y-auto">
              {statistics.errors.slice(0, 5).map((error, index) => (
                <div key={index} className="text-sm mb-2 last:mb-0">
                  <p className="font-medium text-red-900 dark:text-red-200 truncate" title={error.filePath}>
                    {error.filePath.split(/[/\\]/).pop()}
                  </p>
                  <p className="text-red-600 dark:text-red-400 text-xs ml-2">{error.error}</p>
                </div>
              ))}
              {statistics.errors.length > 5 && (
                <p className="text-xs text-red-600 dark:text-red-400 text-center mt-2">
                  {t('还有 {count} 个错误...', { count: statistics.errors.length - 5 })}
                </p>
              )}
            </div>
          </div>
        )}

        {/* 操作按钮 */}
        <div className="flex justify-end space-x-3">
          {onExportLog && statistics.errors.length > 0 && (
            <button
              onClick={onExportLog}
              className="px-4 py-2 border border-input rounded hover:bg-accent hover:text-accent-foreground text-foreground transition-colors flex items-center"
            >
              <MaterialIcon icon="download" className="text-base mr-1" />
              {t('导出日志')}
            </button>
          )}
          {onOpenDirectory && statistics.movedFiles > 0 && (
            <button
              onClick={onOpenDirectory}
              className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors flex items-center"
            >
              <MaterialIcon icon="folder_open" className="text-base mr-1" />
              {t('打开目录')}
            </button>
          )}
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-500 text-white rounded hover:bg-gray-600 transition-colors"
          >
            {t('关闭')}
          </button>
        </div>
      </div>
    </div>
  )
}

