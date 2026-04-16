import React, { useState } from 'react'
import { FileConflict, ConflictResolutionOptions } from '@yonuc/types/organize-types'
import { MaterialIcon } from '../../lib/utils'
import path from 'path-browserify'
import { t } from '@app/languages'

interface ConflictResolutionDialogProps {
  conflicts: FileConflict[]
  onResolve: (options: ConflictResolutionOptions) => void
  onCancel: () => void
}

/**
 * 冲突解决对话框
 * 允许用户选择如何处理文件名冲突
 */
export const ConflictResolutionDialog: React.FC<ConflictResolutionDialogProps> = ({
  conflicts,
  onResolve,
  onCancel,
}) => {
  const [selectedAction, setSelectedAction] = useState<'rename' | 'skip' | 'overwrite'>('rename')
  const [applyToAll, setApplyToAll] = useState(true)
  const [renamePattern, setRenamePattern] = useState<'number' | 'timestamp' | 'source'>('number')

  const handleResolve = () => {
    const options: ConflictResolutionOptions = {
      action: selectedAction,
      applyToAll,
      renamePattern: selectedAction === 'rename' ? renamePattern : undefined,
    }
    onResolve(options)
  }

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  }

  const formatDate = (date: Date): string => {
    return new Date(date).toLocaleString('zh-CN')
  }

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-card text-card-foreground rounded-lg shadow-xl max-w-3xl w-full p-6 max-h-[85vh] flex flex-col border border-border">
        <div className="flex items-center mb-4">
          <MaterialIcon icon="warning" className="text-orange-500 text-3xl mr-3" />
          <h2 className="text-xl font-bold">{t('文件冲突')}</h2>
        </div>

        <div className="bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-900/50 rounded p-3 mb-4">
          <p className="text-orange-800 dark:text-orange-200 font-medium">
            {t('检测到 {count} 个文件冲突。请选择如何处理这些冲突。', { count: conflicts.length })}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto mb-4">
          <h3 className="font-semibold mb-3 text-foreground">{t('冲突文件列表：')}</h3>
          <div className="space-y-3">
            {conflicts.slice(0, 5).map((conflict, index) => (
              <div key={index} className="border border-border rounded-lg p-3 bg-muted/30 dark:bg-muted/10">
                <div className="flex items-start justify-between mb-2">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-foreground truncate" title={conflict.targetPath}>
                      {path.basename(conflict.targetPath)}
                    </p>
                    <p className="text-xs text-muted-foreground truncate" title={path.dirname(conflict.targetPath)}>
                      {path.dirname(conflict.targetPath)}
                    </p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="bg-background p-2 rounded border border-border">
                    <p className="text-muted-foreground text-xs mb-1">{t('现有文件：')}</p>
                    <p className="text-foreground">{formatFileSize(conflict.existingFile.size)}</p>
                    <p className="text-muted-foreground text-xs">{formatDate(conflict.existingFile.modifiedAt)}</p>
                  </div>
                  <div className="bg-blue-50 dark:bg-blue-900/20 p-2 rounded border border-blue-200 dark:border-blue-900/50">
                    <p className="text-blue-600 dark:text-blue-400 text-xs mb-1">{t('新文件：')}</p>
                    <p className="text-blue-900 dark:text-blue-100">{formatFileSize(conflict.newFile.size)}</p>
                    <p className="text-blue-600 dark:text-blue-400 text-xs">{formatDate(conflict.newFile.modifiedAt)}</p>
                  </div>
                </div>
              </div>
            ))}
            {conflicts.length > 5 && (
              <p className="text-sm text-muted-foreground text-center">
                {t('还有 {count} 个冲突文件未显示...', { count: conflicts.length - 5 })}
              </p>
            )}
          </div>
        </div>

        <div className="border-t border-border pt-4 mb-4 space-y-4">
          <div>
            <h4 className="font-semibold mb-3 text-foreground">{t('选择处理方式：')}</h4>
            <div className="space-y-2">
              <label className="flex items-start cursor-pointer p-3 rounded border border-border hover:bg-accent/50 transition-colors">
                <input
                  type="radio"
                  name="action"
                  value="rename"
                  checked={selectedAction === 'rename'}
                  onChange={(e) => setSelectedAction(e.target.value as any)}
                  className="mt-1 mr-3"
                />
                <div className="flex-1">
                  <div className="font-medium text-foreground">{t('重命名')}</div>
                  <div className="text-sm text-muted-foreground">{t('自动为新文件重命名，保留现有文件')}</div>
                  {selectedAction === 'rename' && (
                    <div className="mt-2 ml-2 space-y-1">
                      <label className="flex items-center text-sm">
                        <input
                          type="radio"
                          name="pattern"
                          value="number"
                          checked={renamePattern === 'number'}
                          onChange={(e) => setRenamePattern(e.target.value as any)}
                          className="mr-2"
                        />
                        <span className="text-muted-foreground">{t('添加序号 (file (1).txt)')}</span>
                      </label>
                      <label className="flex items-center text-sm">
                        <input
                          type="radio"
                          name="pattern"
                          value="timestamp"
                          checked={renamePattern === 'timestamp'}
                          onChange={(e) => setRenamePattern(e.target.value as any)}
                          className="mr-2"
                        />
                        <span className="text-muted-foreground">{t('添加时间戳 (file_20250120.txt)')}</span>
                      </label>
                      <label className="flex items-center text-sm">
                        <input
                          type="radio"
                          name="pattern"
                          value="source"
                          checked={renamePattern === 'source'}
                          onChange={(e) => setRenamePattern(e.target.value as any)}
                          className="mr-2"
                        />
                        <span className="text-muted-foreground">{t('添加来源目录名 (file_OldFolder.txt)')}</span>
                      </label>
                    </div>
                  )}
                </div>
              </label>

              <label className="flex items-start cursor-pointer p-3 rounded border border-border hover:bg-accent/50 transition-colors">
                <input
                  type="radio"
                  name="action"
                  value="skip"
                  checked={selectedAction === 'skip'}
                  onChange={(e) => setSelectedAction(e.target.value as any)}
                  className="mt-1 mr-3"
                />
                <div className="flex-1">
                  <div className="font-medium text-foreground">{t('跳过')}</div>
                  <div className="text-sm text-muted-foreground">{t('保留现有文件，不移动新文件')}</div>
                </div>
              </label>

              <label className="flex items-start cursor-pointer p-3 rounded border border-red-200 dark:border-red-700 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
                <input
                  type="radio"
                  name="action"
                  value="overwrite"
                  checked={selectedAction === 'overwrite'}
                  onChange={(e) => setSelectedAction(e.target.value as any)}
                  className="mt-1 mr-3"
                />
                <div className="flex-1">
                  <div className="font-medium text-red-700 dark:text-red-400">{t('覆盖')}</div>
                  <div className="text-sm text-red-600 dark:text-red-500">{t('删除现有文件，使用新文件替换（危险操作）')}</div>
                </div>
              </label>
            </div>
          </div>

          <label className="flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={applyToAll}
              onChange={(e) => setApplyToAll(e.target.checked)}
              className="mr-2 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <span className="text-sm text-muted-foreground">{t('应用于所有 {count} 个冲突文件', { count: conflicts.length })}</span>
          </label>
        </div>

        <div className="flex justify-end space-x-3">
          <button
            onClick={onCancel}
            className="px-4 py-2 border border-input rounded hover:bg-accent hover:text-accent-foreground text-foreground transition-colors"
          >
            {t('取消整理')}
          </button>
          <button
            onClick={handleResolve}
            className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors"
          >
            {t('确认并继续')}
          </button>
        </div>
      </div>
    </div>
  )
}
