import React, { useState, useEffect } from 'react'
import { MaterialIcon } from '../../lib/utils'
import { toast } from '../common/Toast'
import { t } from '@app/languages'

interface OrganizeSession {
  sessionId: string
  timestamp: string
  workspaceDirectoryPath: string
  fileMoves: Array<{
    fileId: number
    oldPath: string
    newPath: string
    timestamp: string
  }>
  hasBackup: boolean
  backupDir?: string
}

interface UndoHistoryDialogProps {
  workspaceDirectoryPath: string
  onClose: () => void
  onUndo: (sessionId: string) => Promise<void>
}

/**
 * 撤销历史对话框
 * 显示可撤销的整理操作历史
 */
export const UndoHistoryDialog: React.FC<UndoHistoryDialogProps> = ({
  workspaceDirectoryPath,
  onClose,
  onUndo,
}) => {
  const [sessions, setSessions] = useState<OrganizeSession[]>([])
  const [loading, setLoading] = useState(true)
  const [undoing, setUndoing] = useState<string | null>(null)

  useEffect(() => {
    loadSessions()
  }, [])

  const loadSessions = async () => {
    try {
      setLoading(true)
      const loadedSessions = await window.electronAPI!.organizeRealDirectory.listSessions(
        workspaceDirectoryPath
      )
      setSessions(loadedSessions as any)
    } catch (error: any) {
      console.error('Failed to load sessions:', error)
      toast.error(t('加载历史记录失败: {error_message}', { error_message: error.message }))
    } finally {
      setLoading(false)
    }
  }

  const handleUndo = async (sessionId: string) => {
    try {
      setUndoing(sessionId)
      await onUndo(sessionId)
      // 重新加载会话列表
      await loadSessions()
      toast.success(t('撤销成功！文件已恢复到整理前的状态'))
    } catch (error: any) {
      console.error('Failed to undo:', error)
      toast.error(t('撤销失败: {error_message}', { error_message: error.message }))
    } finally {
      setUndoing(null)
    }
  }

  const handleDelete = async (sessionId: string) => {
    try {
      const confirmed = await window.electronAPI!.utils.showMessageBox({
        type: 'warning',
        title: t('删除会话'),
        message: t('确定要删除这个会话记录吗？删除后将无法撤销此次整理操作。'),
        buttons: [t('删除'), t('取消')],
        defaultId: 1,
      })

      if (confirmed.response === 0) {
        await window.electronAPI!.organizeRealDirectory.deleteSession({
          workspaceDirectoryPath,
          sessionId,
        })
        await loadSessions()
        toast.success(t('会话记录已删除'))
      }
    } catch (error: any) {
      console.error('Failed to delete session:', error)
      toast.error(t('删除失败: {error_message}', { error_message: error.message }))
    }
  }

  const formatDate = (timestamp: string): string => {
    return new Date(timestamp).toLocaleString('zh-CN')
  }

  const formatFileCount = (count: number): string => {
    if (count === 0) return t('无文件')
    return t('{count} 个文件', { count })
  }

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-card text-card-foreground rounded-lg shadow-xl max-w-4xl w-full p-6 max-h-[85vh] flex flex-col border border-border">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center">
            <MaterialIcon icon="history" className="text-blue-500 text-3xl mr-3" />
            <h2 className="text-xl font-bold text-foreground">{t('撤销历史')}</h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-accent rounded-full transition-colors"
          >
            <MaterialIcon icon="close" className="text-muted-foreground" />
          </button>
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <div className="inline-block animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500 mb-4"></div>
              <p className="text-muted-foreground">{t('加载历史记录...')}</p>
            </div>
          </div>
        ) : sessions.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center max-w-md">
              <MaterialIcon icon="info" className="text-6xl text-muted-foreground/30 mb-4" />
              <h3 className="text-xl font-semibold text-foreground mb-2">{t('暂无历史记录')}</h3>
              <p className="text-muted-foreground">
                {t('还没有执行过整理操作，或者历史记录已被清理。')}
              </p>
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            <div className="space-y-3">
              {sessions.map((session) => (
                <div
                  key={session.sessionId}
                  className="border border-border rounded-lg p-4 hover:bg-accent/50 transition-colors"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center mb-2">
                        <MaterialIcon icon="folder_move" className="text-blue-500 text-lg mr-2" />
                        <span className="font-semibold text-foreground">
                          {formatDate(session.timestamp)}
                        </span>
                        {session.hasBackup && (
                          <span className="ml-2 px-2 py-0.5 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 text-xs rounded">
                            {t('已备份')}
                          </span>
                        )}
                      </div>
                      <div className="ml-7 space-y-1 text-sm text-muted-foreground">
                        <div className="flex items-center">
                          <MaterialIcon icon="description" className="text-base mr-1" />
                          <span>{t('移动了 {count}', { count: formatFileCount(session.fileMoves.length) })}</span>
                        </div>
                        {session.backupDir && (
                          <div className="flex items-center">
                            <MaterialIcon icon="backup" className="text-base mr-1" />
                            <span className="truncate" title={session.backupDir}>
                              {t('备份位置: {backup_name}', { backup_name: session.backupDir.split(/[/\\]/).pop() })}
                            </span>
                          </div>
                        )}
                        <div className="flex items-center text-xs text-muted-foreground/70">
                          <MaterialIcon icon="tag" className="text-sm mr-1" />
                          <span className="font-mono">{session.sessionId}</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center space-x-2 ml-4">
                      <button
                        onClick={() => handleUndo(session.sessionId)}
                        disabled={undoing === session.sessionId}
                        className="px-3 py-1.5 bg-blue-500 text-white text-sm rounded hover:bg-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
                      >
                        {undoing === session.sessionId ? (
                          <>
                            <div className="animate-spin rounded-full h-3 w-3 border-t-2 border-b-2 border-white mr-2"></div>
                            {t('撤销中...')}
                          </>
                        ) : (
                          <>
                            <MaterialIcon icon="undo" className="text-sm mr-1" />
                            {t('撤销')}
                          </>
                        )}
                      </button>
                      <button
                        onClick={() => handleDelete(session.sessionId)}
                        disabled={undoing === session.sessionId}
                        className="p-2 text-muted-foreground hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded transition-colors disabled:opacity-50"
                        title={t('删除记录')}
                      >
                        <MaterialIcon icon="delete" className="text-base" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex justify-between items-center mt-6 pt-4 border-t border-border">
          <p className="text-sm text-muted-foreground">
            <MaterialIcon icon="info" className="text-sm mr-1 inline" />
            {t('撤销操作将恢复文件到整理前的位置')}
          </p>
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

