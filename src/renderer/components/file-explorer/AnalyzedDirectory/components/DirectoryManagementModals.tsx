import React from 'react'
import { SavedAnalyzedDirectory, WorkspaceDirectory } from '@firefly/types'
import { MaterialIcon } from '../../../../lib/utils'
import { t } from '@app/languages'
import { formatDateTime } from '@firefly/shared'

interface DirectoryManagementModalsProps {
  showManageModal: boolean
  setShowManageModal: (show: boolean) => void
  savedDirectories: SavedAnalyzedDirectory[]
  editingAnalyzedDirectoryId: string | null
  editingDirectoryName: string
  setEditingDirectoryName: (name: string) => void
  handleSaveEdit: (id: string) => void
  handleCancelEdit: () => void
  handleStartEdit: (dir: SavedAnalyzedDirectory) => void
  handleDeleteDirectory: (id: string) => void
}

/**
 * 虚拟目录管理弹窗
 * 负责重命名、删除和查看已保存的虚拟目录
 */
export const DirectoryManagementModals: React.FC<DirectoryManagementModalsProps> = ({
  showManageModal,
  setShowManageModal,
  savedDirectories,
  editingAnalyzedDirectoryId,
  editingDirectoryName,
  setEditingDirectoryName,
  handleSaveEdit,
  handleCancelEdit,
  handleStartEdit,
  handleDeleteDirectory
}) => {
  if (!showManageModal) return null

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-card dark:bg-card rounded-lg p-6 max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">{t('管理保存的虚拟目录')}</h3>
          <button
            className="p-2 text-muted-foreground dark:text-muted-foreground hover:text-foreground dark:text-foreground hover:bg-accent dark:bg-accent rounded-full transition-colors"
            onClick={() => {
              setShowManageModal(false)
              handleCancelEdit()
            }}
          >
            <MaterialIcon icon="close" className="text-xl" />
          </button>
        </div>

        {savedDirectories.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground dark:text-muted-foreground">
            {t('暂无已保存的虚拟目录')}
          </div>
        ) : (
          <div className="space-y-2">
            {savedDirectories.map(dir => (
              <div
                key={dir.id}
                className="flex items-center justify-between p-3 border border-border dark:border-border rounded-md hover:bg-muted dark:bg-muted"
              >
                {editingAnalyzedDirectoryId === dir.id ? (
                  <div className="flex-1 flex items-center space-x-2">
                    <input
                      type="text"
                      value={editingDirectoryName}
                      onChange={e => setEditingDirectoryName(e.target.value)}
                      className="flex-1 px-2 py-1 border-input dark:border-input rounded"
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleSaveEdit(dir.id)
                        else if (e.key === 'Escape') handleCancelEdit()
                      }}
                      autoFocus
                    />
                    <button
                      className="px-3 py-1 text-sm text-white bg-primary dark:bg-primary hover:bg-primary/90 rounded"
                      onClick={() => handleSaveEdit(dir.id)}
                    >
                      {t('保存')}
                    </button>
                    <button
                      className="px-3 py-1 text-sm text-foreground dark:text-foreground hover:bg-accent dark:hover:bg-accent rounded"
                      onClick={handleCancelEdit}
                    >
                      {t('取消')}
                    </button>
                  </div>
                ) : (
                  <div className="flex-1 flex items-center justify-between">
                    <div>
                      <div className="font-medium">{dir.name}</div>
                      <div className="text-xs text-muted-foreground dark:text-muted-foreground">
                        {t('创建时间: {time}', { time: formatDateTime(dir.createdAt) })}
                      </div>
                    </div>
                    <div className="flex items-center space-x-2">
                      <button
                        className="p-2 text-foreground/80 dark:text-foreground/80 hover:text-primary dark:text-primary hover:bg-primary/10 dark:bg-primary/20 rounded"
                        onClick={() => handleStartEdit(dir)}
                        title={t('重命名')}
                      >
                        <MaterialIcon icon="edit" className="text-base" />
                      </button>
                      <button
                        className="p-2 text-foreground/80 dark:text-foreground/80 hover:text-red-600 hover:bg-red-50 rounded"
                        onClick={() => handleDeleteDirectory(dir.id)}
                        title={t('删除')}
                      >
                        <MaterialIcon icon="delete" className="text-base" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="flex justify-end mt-6">
          <button
            className="px-4 py-2 text-sm text-foreground dark:text-foreground hover:bg-accent dark:hover:bg-accent rounded-md transition-colors"
            onClick={() => {
              setShowManageModal(false)
              handleCancelEdit()
            }}
          >
            {t('关闭')}
          </button>
        </div>
      </div>
    </div>
  )
}
