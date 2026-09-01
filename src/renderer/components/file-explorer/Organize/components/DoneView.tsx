import React from 'react'
import { VirtualDirectoryNode } from '@firefly/types'
import { OrganizeMode, OrganizeOptions } from '../types'
import { SplitPane } from '../../../common/SplitPane'
import { PlanSidebar } from './PlanSidebar'
import { MaterialIcon } from '../../../../lib/utils'
import { FileTypeIcon, extractFileExtension } from '../../../common/FileTypeIcon'
import i18nScope, { t } from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'
import { Checkbox } from '../../../ui/checkbox'
import { Button } from '../../../ui/button'
import { VDirTree } from './VDirTree'
import {
  sanitizeDirectoryName,
  countRealFiles,
  recalculateNodeFileCounts,
  getAllFileKeys
} from '../utils/helpers'
import { useSettingsStore } from '../../../../stores/settings-store'

export function DoneView({
  tree,
  organizeMode,
  onReorganize,
  onRescue,
  isRescuing = false,
  isAutoRescuing = false,
  onAutoRescue,
  hasRescueFailed,
  progressInfo,
  draft,
  candidate,
  options,
  setOptions,
  onDeleteNode,
  onRenameNode,
  onAddSubdir,
  onMoveNodeOrFile,
  toOrganizeFiles = [],
  currentVDir,
  highFrequencyTags
}: {
  tree: VirtualDirectoryNode[]
  organizeMode: OrganizeMode
  onReorganize: () => void
  onRescue: (force?: boolean) => void
  isRescuing?: boolean
  isAutoRescuing?: boolean
  onAutoRescue?: () => void
  hasRescueFailed: boolean
  progressInfo?: { current: number; total: number; message?: string }
  draft: { name: string; strategy: string; source: any } | null
  candidate: any
  options: OrganizeOptions
  setOptions: (options: OrganizeOptions | ((prev: OrganizeOptions) => OrganizeOptions)) => void
  onDeleteNode?: (nodeKey: string) => void
  onRenameNode?: (nodeKey: string, newName: string) => void
  onAddSubdir?: (parentKey: string, subdirName: string) => void
  onMoveNodeOrFile?: (draggedData: any, targetNodeKey: string) => void
  toOrganizeFiles?: any[]
  currentVDir?: any
  highFrequencyTags?: Set<string>
}) {
  const { t, activeLanguage } = useVoerkaI18n(i18nScope)
  const [showPreviousClassified, setShowPreviousClassified] = React.useState(false)

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

  const getConfigValue = useSettingsStore.getState().getConfigValue
  const swapFileNameDisplay = getConfigValue<boolean>('SWAP_FILE_NAME_DISPLAY') ?? false
  const unclassifiedNode = tree.find(n => n.name === t('未归类') || n.name === '未归类')

  const isUnclassifiedName = (name: string) => name === '未归类' || name === t('未归类')
  const filterUnclassified = (nodes: VirtualDirectoryNode[]): VirtualDirectoryNode[] =>
    nodes
      .filter(n => !isUnclassifiedName(n.name))
      .map(n => {
        const subs = filterUnclassified(n.subdirectories || [])
        const cleanFiles = (n.files || []).filter(
          f =>
            f.name !== '未归类' &&
            f.name !== t('未归类') &&
            f.smartName !== '未归类' &&
            f.smartName !== t('未归类') &&
            !f.isUnclassified &&
            !f.unclassified
        )
        return {
          ...n,
          files: cleanFiles,
          subdirectories: subs
        }
      })
      .filter(n => {
        // 如果 options.skipEmptyDirs 启用，但节点有子目录，保留；
        // 如果节点既无文件也无子目录，但在草稿/大纲阶段或节点带有名称，保留其结构
        if (options?.skipEmptyDirs) {
          const hasFiles = (n.files || []).length > 0
          const hasSubs = (n.subdirectories || []).length > 0
          // 保留包含子目录或文件的节点，保留非空名称的大纲节点
          return hasFiles || hasSubs || Boolean(n.name)
        }
        return true
      })

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

  const rawClassifiedTree = filterUnclassified(tree)
  const fullClassifiedTree = recalculateNodeFileCounts(rawClassifiedTree)

  const isIncremental = Boolean(organizeMode === 'incremental-organize')

  const classifiedTree = isIncremental
    ? showPreviousClassified || toOrganizeSet.size === 0
      ? fullClassifiedTree
      : recalculateNodeFileCounts(filterPendingFilesOnly(fullClassifiedTree))
    : fullClassifiedTree

  const classifiedCount = countRealFiles(classifiedTree)
  const totalClassifiedCount = countRealFiles(fullClassifiedTree)
  const currentBatchClassifiedCount = countRealFiles(
    recalculateNodeFileCounts(filterPendingFilesOnly(fullClassifiedTree))
  )

  const rawUnclassifiedFiles = unclassifiedNode ? unclassifiedNode.files || [] : []

  // 深度收集全量实体分类树 (fullClassifiedTree) 中所有已归类文件的全特征 Key
  const allClassifiedKeys = React.useMemo(() => {
    const keys = new Set<string>()
    const collect = (nodes: VirtualDirectoryNode[]) => {
      for (const n of nodes) {
        if (n.name === '未归类' || n.name === t('未归类') || n.name === 'Unclassified') continue
        if (Array.isArray(n.files)) {
          for (const f of n.files) {
            for (const k of getAllFileKeys(f)) {
              keys.add(k)
            }
          }
        }
        if (Array.isArray(n.subdirectories)) {
          collect(n.subdirectories)
        }
      }
    }
    collect(fullClassifiedTree)
    return keys
  }, [fullClassifiedTree, activeLanguage])

  // 严格二次校验：若文件在实体分类目录中已归类，100% 从未归类面板中剔除，同时全维度防重！
  const unclassifiedFiles = React.useMemo(() => {
    const seenKeys = new Set<string>()
    return rawUnclassifiedFiles.filter((f: any) => {
      if (!f) return false
      const fKeys = getAllFileKeys(f)
      if (fKeys.length === 0) return false
      if (fKeys.some(k => allClassifiedKeys.has(k))) return false

      const isSeen = fKeys.some(k => seenKeys.has(k))
      if (isSeen) return false

      fKeys.forEach(k => seenKeys.add(k))
      return true
    })
  }, [rawUnclassifiedFiles, allClassifiedKeys])

  const unmatchedCount = unclassifiedFiles.length

  const showUnclassified = unclassifiedFiles.length > 0

  const renderRules = () => (
    <div className="border-t border-border/80 bg-muted/5 p-4 space-y-3 shrink-0 mt-3 rounded-xl">
      <div className="flex items-center gap-6 flex-wrap">
        <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground cursor-pointer transition-colors">
          <Checkbox
            checked={options.flattenToRoot}
            onCheckedChange={checked => setOptions(prev => ({ ...prev, flattenToRoot: !!checked }))}
          />
          <span>{t('平铺到根目录')}</span>
        </label>
        <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground cursor-pointer transition-colors">
          <Checkbox
            checked={options.skipEmptyDirs}
            onCheckedChange={checked => setOptions(prev => ({ ...prev, skipEmptyDirs: !!checked }))}
          />
          <span>{t('不生成空目录')}</span>
        </label>
        <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground cursor-pointer transition-colors">
          <Checkbox
            checked={options.deduplicateFiles}
            onCheckedChange={checked =>
              setOptions(prev => ({ ...prev, deduplicateFiles: !!checked }))
            }
          />
          <span>{t('文件去重')}</span>
        </label>
      </div>
    </div>
  )

  return (
    <SplitPane
      direction="horizontal"
      storageKey="organize-done"
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
          id: 'done-content',
          type: 'flex' as const,
          defaultSize: 1,
          minSize: 300,
          content: (
            <div className="h-full flex flex-col overflow-hidden">
              <div className="px-4 py-2 border-b bg-emerald-50/30 dark:bg-emerald-900/5 flex-shrink-0">
                <div className="flex items-center gap-4 flex-wrap">
                  <div className="flex items-center gap-2 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                    <MaterialIcon icon="check_circle" className="text-emerald-500 text-sm" />
                    <span>
                      {isIncremental
                        ? showPreviousClassified
                          ? t('整理完成，全量共 {count} 个文件已归类', {
                              count: totalClassifiedCount
                            })
                          : t('整理完成，新增 {current} 个，共计 {total} 个文件已归类', {
                              total: totalClassifiedCount,
                              current: currentBatchClassifiedCount
                            })
                        : t('整理完成，共 {count} 个文件已归类', { count: classifiedCount })}
                    </span>
                    {unmatchedCount > 0 && (
                      <span className="text-muted-foreground ml-2 border-l pl-2 border-muted-foreground/20">
                        {t('其中 {unmatched} 个文件未归类', { unmatched: unmatchedCount })}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={onReorganize}
                      className="h-8 text-xs gap-1"
                    >
                      <MaterialIcon icon="refresh" className="text-sm" />
                      {t('重新整理')}
                    </Button>
                  </div>
                </div>
              </div>

              <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                {showUnclassified ? (
                  <SplitPane
                    direction="horizontal"
                    storageKey="organize-done-trees"
                    className="flex-1"
                    sections={[
                      {
                        id: 'classified-tree',
                        type: 'flex' as const,
                        defaultSize: 1,
                        minSize: 200,
                        content: (
                          <div className="h-full flex flex-col overflow-hidden p-4">
                            <div className="flex-1 overflow-auto">
                              <VDirTree
                                nodes={classifiedTree}
                                onDeleteNode={onDeleteNode}
                                onRenameNode={onRenameNode}
                                onAddSubdir={onAddSubdir}
                                onMoveNodeOrFile={onMoveNodeOrFile}
                                highFrequencyTags={highFrequencyTags}
                                currentVDirId={currentVDir?.id}
                                extraHeaderAction={
                                  isIncremental ? (
                                    <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground cursor-pointer transition-colors select-none">
                                      <Checkbox
                                        checked={showPreviousClassified}
                                        onCheckedChange={checked =>
                                          setShowPreviousClassified(!!checked)
                                        }
                                      />
                                      <span>{t('显示前次已归类文件')}</span>
                                    </label>
                                  ) : undefined
                                }
                              />
                            </div>
                            {renderRules()}
                          </div>
                        )
                      },
                      {
                        id: 'unclassified-list',
                        type: 'pixel' as const,
                        defaultSize: 300,
                        minSize: 200,
                        content: (
                          <div className="h-full flex flex-col overflow-hidden p-4 border-l border-border bg-muted/10">
                            <div className="mb-2 flex items-center justify-between flex-wrap gap-2">
                              <div className="text-xs font-semibold text-muted-foreground flex items-center gap-1 shrink-0 whitespace-nowrap">
                                <MaterialIcon
                                  icon="help_outline"
                                  className="text-xs text-yellow-500"
                                />
                                <span>
                                  {t('未归类文件 ({count})', { count: unclassifiedFiles.length })}
                                </span>
                                {hasRescueFailed && (
                                  <span className="text-[10px] text-amber-600 dark:text-amber-400 flex items-center gap-0.5 select-none bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/20 whitespace-nowrap shrink-0">
                                    <MaterialIcon icon="info" className="text-[12px]" />
                                    {t('已尝试找补')}
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => onRescue(true)}
                                  disabled={isRescuing || isAutoRescuing}
                                  className="h-6 px-2 text-[10px] gap-0.5 whitespace-nowrap shrink-0"
                                >
                                  <MaterialIcon
                                    icon={isRescuing && !isAutoRescuing ? 'sync' : 'auto_fix_high'}
                                    className={`text-xs ${isRescuing && !isAutoRescuing ? 'animate-spin' : ''}`}
                                  />
                                  {isRescuing && !isAutoRescuing ? t('找补中...') : t('再找补一次')}
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={onAutoRescue}
                                  disabled={isRescuing || isAutoRescuing}
                                  className="h-6 px-2 text-[10px] gap-0.5 whitespace-nowrap shrink-0"
                                >
                                  <MaterialIcon
                                    icon={isAutoRescuing ? 'sync' : 'auto_mode'}
                                    className={`text-xs ${isAutoRescuing ? 'animate-spin' : ''}`}
                                  />
                                  {isAutoRescuing ? t('自动找补中...') : t('自动找补')}
                                </Button>
                              </div>
                            </div>

                            {/* 找补批次进度条 Banner */}
                            {(isRescuing || isAutoRescuing) && (
                              <div className="bg-primary/10 border-b border-primary/20 px-3 py-2 space-y-1.5 animate-in fade-in duration-200 mb-2 rounded-md">
                                <div className="flex items-center justify-between text-[11px] font-semibold text-foreground">
                                  <span className="flex items-center gap-1.5">
                                    <MaterialIcon
                                      icon="sync"
                                      className="text-primary text-xs animate-spin shrink-0"
                                    />
                                    <span>
                                      {progressInfo?.message || t('正在执行 AI 找补归类...')}
                                    </span>
                                  </span>
                                  <span className="tabular-nums text-primary font-bold text-[10px]">
                                    {t('第 {current} / {total} 批次', {
                                      current: progressInfo?.current || 1,
                                      total: progressInfo?.total || 1
                                    })}
                                  </span>
                                </div>
                                <div className="w-full h-1.5 bg-primary/20 rounded-full overflow-hidden">
                                  <div
                                    className="h-full bg-primary rounded-full transition-all duration-300 ease-out"
                                    style={{
                                      width: `${Math.min(
                                        100,
                                        Math.max(
                                          10,
                                          ((progressInfo?.current || 1) /
                                            (progressInfo?.total || 1)) *
                                            100
                                        )
                                      )}%`
                                    }}
                                  />
                                </div>
                              </div>
                            )}

                            <div className="flex-1 overflow-y-auto space-y-1">
                              {unclassifiedFiles.map((file, idx) => (
                                <div
                                  key={`unclassified-${file.fileId || file.id || idx}`}
                                  draggable
                                  onDragStart={e => {
                                    e.stopPropagation()
                                    const data = { type: 'file', file }
                                    e.dataTransfer.setData('application/json', JSON.stringify(data))
                                    e.dataTransfer.effectAllowed = 'move'
                                  }}
                                  className="flex items-center py-1.5 px-2 text-sm text-muted-foreground hover:bg-accent/50 rounded group cursor-grab active:cursor-grabbing select-none"
                                >
                                  <FileTypeIcon
                                    path={file.originalPath}
                                    extension={extractFileExtension(file.originalPath || file.name)}
                                    className="w-4 h-4 object-contain mr-2 shrink-0"
                                    fallbackClassName="text-sm text-muted-foreground/60"
                                  />
                                  <span
                                    className="truncate flex-1"
                                    title={
                                      swapFileNameDisplay
                                        ? file.name || file.smartName || ''
                                        : file.smartName || file.name
                                    }
                                  >
                                    {swapFileNameDisplay
                                      ? file.name || file.smartName || ''
                                      : file.smartName || file.name}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )
                      }
                    ]}
                  />
                ) : (
                  <div className="flex-1 flex flex-col overflow-hidden p-4">
                    <div className="flex-1 overflow-auto">
                      <VDirTree
                        nodes={classifiedTree}
                        onDeleteNode={onDeleteNode}
                        onRenameNode={onRenameNode}
                        onAddSubdir={onAddSubdir}
                        onMoveNodeOrFile={onMoveNodeOrFile}
                        highFrequencyTags={highFrequencyTags}
                        currentVDirId={currentVDir?.id}
                      />
                    </div>
                    {renderRules()}
                  </div>
                )}
              </div>
            </div>
          )
        }
      ]}
    />
  )
}
