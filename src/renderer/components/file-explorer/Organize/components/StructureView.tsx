import React, { useMemo } from 'react'
import { VirtualDirectoryNode } from '@firefly/types'
import { OrganizeMode } from '../types'
import { SplitPane } from '../../../common/SplitPane'
import { PlanSidebar } from './PlanSidebar'
import { MaterialIcon } from '../../../../lib/utils'
import { Button } from '../../../ui/button'
import { t } from '@app/languages'
import { EmptyState } from '../../../common/EmptyState'
import { VDirTree } from './VDirTree'

export function StructureView({
  tree,
  isReadOnly,
  organizeMode,
  draft,
  candidate,
  isGenerating,
  onReorganize,
  onDeleteNode,
  onRenameNode,
  onAddSubdir,
  onMoveNodeOrFile,
  highFrequencyTags,
  currentVDir
}: {
  tree: VirtualDirectoryNode[]
  isReadOnly: boolean
  organizeMode: OrganizeMode
  draft: { name: string; strategy: string; source: any } | null
  candidate: any
  isGenerating?: boolean
  onReorganize?: () => void
  onDeleteNode?: (nodeKey: string) => void
  onRenameNode?: (nodeKey: string, newName: string) => void
  onAddSubdir?: (parentKey: string, subdirName: string) => void
  onMoveNodeOrFile?: (draggedData: any, targetNodeKey: string) => void
  highFrequencyTags?: Set<string>
  currentVDir?: any
}) {
  const [deleteTargetKey, setDeleteTargetKey] = React.useState<string | null>(null)

  // 在目录预览 Stage (StructureView) 中，只展示纯目录树结构，严格移除所有文件节点
  const pureDirectoryTree = useMemo(() => {
    const filterDirectoriesOnly = (nodes: VirtualDirectoryNode[]): VirtualDirectoryNode[] => {
      return (nodes || []).map(node => ({
        ...node,
        files: [], // 强制清空文件，保证预览 Stage 只展示纯目录
        subdirectories: filterDirectoriesOnly(node.subdirectories || [])
      }))
    }
    return filterDirectoriesOnly(tree)
  }, [tree])

  const handleDeleteRequest = (nodeKey: string) => {
    if (isIncremental) {
      setDeleteTargetKey(nodeKey)
    } else {
      onDeleteNode?.(nodeKey)
    }
  }

  const isIncremental = organizeMode === ('incremental-organize' as OrganizeMode)
  // 仅针对在数据库 SQLite 中已真实落盘的整理任务（已落盘草稿或已保存虚拟目录，id > 0）隐藏“换一个”按钮；
  // 快速整理/精细整理在未点击“开始整理”落盘前的内存预览阶段（currentVDir 为 null），“换一个”按钮正常呈现！
  const isPersistedVDir = Boolean(
    currentVDir && typeof currentVDir.id === 'number' && currentVDir.id > 0
  )

  const confirmDelete = () => {
    if (deleteTargetKey) {
      onDeleteNode?.(deleteTargetKey)
      setDeleteTargetKey(null)
    }
  }

  return (
    <div className="h-full flex flex-col overflow-hidden bg-background">
      <div className="flex-1 min-h-0 relative">
        <SplitPane
          direction="horizontal"
          storageKey="organize-structure-preview"
          className="h-full"
          sections={[
            {
              id: 'plan-sidebar',
              type: 'flex' as const,
              defaultSize: 320,
              minSize: 260,
              content: <PlanSidebar draft={draft} candidate={candidate} />
            },
            {
              id: 'tree-content',
              type: 'flex' as const,
              defaultSize: 1,
              minSize: 300,
              content: (
                <div className="h-full overflow-auto p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <MaterialIcon icon="folder_open" className="text-primary text-sm" />
                    <span className="text-sm font-bold">{t('目录树预览')}</span>
                    {!isGenerating && !isIncremental && !isPersistedVDir && onReorganize && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={onReorganize}
                        className="h-7 px-3 text-xs rounded-lg gap-1.5 border-primary/20 text-primary hover:bg-primary/5 hover:text-primary font-bold shadow-xs ml-2"
                      >
                        <MaterialIcon icon="refresh" className="text-sm" />
                        {t('换一个')}
                      </Button>
                    )}
                    {isGenerating && (
                      <span className="text-[10px] bg-primary/10 text-primary px-2 py-0.5 rounded-full flex items-center gap-1">
                        <span className="relative flex h-2 w-2">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                          <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
                        </span>
                        {t('AI 正在生成目录树...')}
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground/50">
                      {t('已按文件数量裁剪目录个数')}
                    </span>
                  </div>
                  {isGenerating && tree.length === 0 ? (
                    <EmptyState isLoading={true} title={t('AI 正在分析文件并生成目录结构...')} />
                  ) : tree.length === 0 ? (
                    <EmptyState icon="folder_off" title={t('暂无目录结构')} />
                  ) : (
                    <VDirTree
                      nodes={pureDirectoryTree}
                      onDeleteNode={handleDeleteRequest}
                      onRenameNode={onRenameNode}
                      onAddSubdir={onAddSubdir}
                      onMoveNodeOrFile={onMoveNodeOrFile}
                      allowEdit={!isReadOnly}
                      organizeMode={organizeMode}
                      highFrequencyTags={highFrequencyTags}
                      currentVDirId={currentVDir?.id}
                    />
                  )}
                </div>
              )
            }
          ]}
        />

        {/* 增量整理模式删除目录确认 Modal */}
        {deleteTargetKey && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4">
            <div className="bg-card border border-border rounded-2xl p-6 w-full max-w-sm shadow-xl flex flex-col gap-4">
              <div className="flex items-center gap-3 text-amber-500">
                <MaterialIcon icon="warning" className="text-2xl" />
                <h3 className="text-base font-bold text-foreground">{t('确认删除此目录？')}</h3>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                {t('删除此目录后，原本归属于该目录下的文件将会重新移至“未归类”文件夹中。')}
              </p>
              <div className="flex items-center justify-end gap-2 pt-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setDeleteTargetKey(null)}
                  className="text-xs rounded-xl"
                >
                  {t('取消')}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={confirmDelete}
                  className="text-xs rounded-xl font-bold"
                >
                  {t('确认删除')}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
