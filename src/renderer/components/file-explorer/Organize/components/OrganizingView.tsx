import React from 'react'
import { VirtualDirectoryNode } from '@firefly/types'
import { ProgressInfo, OrganizeMode } from '../types'
import { SplitPane } from '../../../common/SplitPane'
import { PlanSidebar } from './PlanSidebar'
import { MaterialIcon } from '../../../../lib/utils'
import { t } from '@app/languages'
import { EmptyState } from '../../../common/EmptyState'
import { VDirTree } from './VDirTree'
import { Checkbox } from '../../../../components/ui/checkbox'
import { recalculateNodeFileCounts } from '../utils/helpers'

export function OrganizingView({
  tree,
  progressInfo,
  isPaused,
  organizeMode,
  draft,
  candidate,
  toOrganizeFiles,
  highFrequencyTags
}: {
  tree: VirtualDirectoryNode[]
  progressInfo: ProgressInfo
  isPaused: boolean
  organizeMode: OrganizeMode
  draft: { name: string; strategy: string; source: any } | null
  candidate: any
  toOrganizeFiles?: any[]
  highFrequencyTags?: Set<string>
}) {
  const [showPreviousClassified, setShowPreviousClassified] = React.useState(false)
  const isIncremental = organizeMode === 'incremental-organize'

  const toOrganizeSet = React.useMemo(() => {
    const set = new Set<string>()
    if (Array.isArray(toOrganizeFiles)) {
      for (const f of toOrganizeFiles) {
        if (!f) continue
        if (f.id != null) set.add(String(f.id))
        if (f.fileId != null) set.add(String(f.fileId))
        if (f.fileFingerprint) set.add(String(f.fileFingerprint))
        if (f.path) set.add(String(f.path))
        if (f.name) set.add(String(f.name))
      }
    }
    return set
  }, [toOrganizeFiles])

  const percent =
    progressInfo.total > 0 ? Math.round((progressInfo.current / progressInfo.total) * 100) : 0

  const isUnclassifiedName = (name: string) => name === '未归类' || name === t('未归类')

  const filterPendingFilesOnly = React.useCallback(
    (nodes: VirtualDirectoryNode[]): VirtualDirectoryNode[] => {
      if (!Array.isArray(nodes)) return []

      const processNode = (node: VirtualDirectoryNode): VirtualDirectoryNode => {
        const subs = (node.subdirectories || []).map(processNode)

        const files = (node.files || []).filter(f => {
          if (toOrganizeSet.size === 0) return true
          const fid = String(
            (f as any).fileId ??
              (f as any).id ??
              (f as any).fileFingerprint ??
              (f as any).path ??
              (f as any).name
          )
          return toOrganizeSet.has(fid)
        })

        return {
          ...node,
          files,
          subdirectories: subs,
          fileCount: files.length + subs.reduce((sum, s) => sum + (s.fileCount || 0), 0)
        }
      }

      return nodes.map(processNode)
    },
    [toOrganizeSet]
  )

  const displayTree = React.useMemo(() => {
    const filterUnclassifiedNodes = (nodes: VirtualDirectoryNode[]): VirtualDirectoryNode[] => {
      return (nodes || [])
        .filter(n => !isUnclassifiedName(n?.name || ''))
        .map(n => ({
          ...n,
          subdirectories: filterUnclassifiedNodes(n.subdirectories || [])
        }))
    }
    const rawTree = filterUnclassifiedNodes(tree)
    const fullTree = recalculateNodeFileCounts(rawTree)

    if (isIncremental) {
      return showPreviousClassified
        ? fullTree
        : recalculateNodeFileCounts(filterPendingFilesOnly(fullTree))
    }
    return fullTree
  }, [tree, isIncremental, showPreviousClassified, filterPendingFilesOnly])

  return (
    <SplitPane
      direction="horizontal"
      storageKey="organize-organizing"
      className="flex-1"
      sections={[
        {
          id: 'plan-sidebar',
          type: 'pixel' as const,
          defaultSize: 300,
          minSize: 200,
          content: <PlanSidebar draft={draft} candidate={candidate} />
        },
        {
          id: 'progress-content',
          type: 'flex' as const,
          defaultSize: 1,
          minSize: 300,
          content: (
            <div className="h-full flex flex-col overflow-hidden">
              <div className="px-4 pt-3 pb-2 border-b bg-muted/5 flex-shrink-0">
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2">
                    {isPaused ? (
                      <MaterialIcon icon="pause_circle" className="text-yellow-500 text-sm" />
                    ) : (
                      <span className="relative flex h-3 w-3">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-3 w-3 bg-primary"></span>
                      </span>
                    )}
                    <span className="text-xs font-medium">
                      {isPaused
                        ? t('已暂停')
                        : t('正在整理第 {current}/{total} 批次', {
                            current: progressInfo.current,
                            total: progressInfo.total
                          })}
                    </span>
                  </div>
                  <span className="text-xs text-muted-foreground">{percent}%</span>
                </div>
                <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary rounded-full transition-all duration-500"
                    style={{ width: `${percent}%` }}
                  />
                </div>
              </div>

              <div className="flex-1 overflow-auto p-4">
                {displayTree.length === 0 ? (
                  <EmptyState isLoading={true} title={t('正在初始化...')} />
                ) : (
                  <VDirTree
                    nodes={displayTree}
                    allowEdit={false}
                    highFrequencyTags={highFrequencyTags}
                    extraHeaderAction={
                      isIncremental ? (
                        <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground cursor-pointer transition-colors select-none">
                          <Checkbox
                            checked={showPreviousClassified}
                            onCheckedChange={checked => setShowPreviousClassified(!!checked)}
                          />
                          <span>{t('显示前次已归类文件')}</span>
                        </label>
                      ) : undefined
                    }
                  />
                )}
              </div>
            </div>
          )
        }
      ]}
    />
  )
}
