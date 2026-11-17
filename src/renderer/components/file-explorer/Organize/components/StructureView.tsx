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
  // 「换一个」按钮已移除，onReorganize 仅为兼容调用方传值而保留，组件内不再消费
  onReorganize?: () => void
  onDeleteNode?: (nodeKey: string) => void
  onRenameNode?: (nodeKey: string, newName: string) => void
  onAddSubdir?: (parentKey: string, subdirName: string) => void
  onMoveNodeOrFile?: (draggedData: any, targetNodeKey: string) => void
  highFrequencyTags?: Set<string>
  currentVDir?: any
}) {
  const [deleteTargetKey, setDeleteTargetKey] = React.useState<string | null>(null)

  // 在目录预览 Stage (StructureView) 中，只展示纯目录树结构，严格移除所有文件节点。
  // 增量整理模式（organizeMode === 'incremental-organize'）例外：保留每个节点的 fileCount，
  // 让用户在「增量整理」入场时能看到各目录当前已归类的文件计数；但 files 数组仍清空，避免
  // 整理中途 UI 展示过多细节。fileCount 从 node.files 长度加上子目录 fileCount 累加推导。
  const pureDirectoryTree = useMemo(() => {
    const isIncrementalMode = organizeMode === ('incremental-organize' as OrganizeMode)
    const buildNode = (nodes: VirtualDirectoryNode[]): VirtualDirectoryNode[] => {
      return (nodes || []).map(node => {
        const updatedSubs = buildNode(node.subdirectories || [])
        const subFileCount = updatedSubs.reduce((sum, s) => sum + (s.fileCount || 0), 0)
        return {
          ...node,
          files: [], // 强制清空文件列表，预览阶段只展示目录结构
          // 增量整理模式保留文件计数（来自快照数据），方便用户核验已归类数量；
          // 其余模式置 0（结构纯大纲，无需计数）
          fileCount: isIncrementalMode ? (node.files ? node.files.length : 0) + subFileCount : 0,
          subdirectories: updatedSubs
        }
      })
    }
    return buildNode(tree)
  }, [tree, organizeMode])

  const handleDeleteRequest = (nodeKey: string) => {
    if (isIncremental) {
      setDeleteTargetKey(nodeKey)
    } else {
      onDeleteNode?.(nodeKey)
    }
  }

  const isIncremental = organizeMode === ('incremental-organize' as OrganizeMode)

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
              // 与自动归类 stage (OrganizingView) 保持一致：方案侧栏固定像素宽，
              // 确保「目录树预览」区块默认占据扣除侧栏后的全部剩余空间
              type: 'pixel' as const,
              defaultSize: 300,
              minSize: 200,
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
                      {t('你可以对目录树进行微调')}
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
