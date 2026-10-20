import React, { useState, useMemo } from 'react'
import { OrganizeMode } from '../types'
import { MaterialIcon, cn } from '../../../../lib/utils'
import { t } from '@app/languages'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../../../ui/dialog'
import { getPerspectiveIcon, parseStrategyToTree } from '../utils/helpers'
import { Button } from '../../../ui/button'
import { toast } from '../../../common/Toast'
import { VirtualDirectoryNode } from '@firefly/types'

function countDirectoryNodes(nodes: VirtualDirectoryNode[]): number {
  if (!nodes) return 0
  let count = 0
  for (const n of nodes) {
    count += 1 + countDirectoryNodes(n.subdirectories || [])
  }
  return count
}

function ReadonlyDirectoryTree({
  nodes,
  depth = 0
}: {
  nodes: VirtualDirectoryNode[]
  depth?: number
}) {
  if (!nodes || nodes.length === 0) return null
  return (
    <div className="space-y-1">
      {nodes.map((node, idx) => (
        <div key={idx} className="text-xs">
          <div
            className="flex items-center gap-1.5 py-1 px-1.5 rounded-md hover:bg-muted/40 transition-colors"
            style={{ paddingLeft: `${depth * 14 + 4}px` }}
          >
            <MaterialIcon
              icon={depth === 0 ? 'folder' : 'folder_open'}
              className={cn(
                'text-sm shrink-0',
                depth === 0 ? 'text-primary' : 'text-primary/70'
              )}
            />
            <span className="font-medium text-foreground truncate">{node.name}</span>
          </div>
          {node.subdirectories && node.subdirectories.length > 0 && (
            <ReadonlyDirectoryTree nodes={node.subdirectories} depth={depth + 1} />
          )}
        </div>
      ))}
    </div>
  )
}

function CandidateCard({
  candidate: c,
  index: i,
  displayCount,
  onSelect,
  onOpenDetail
}: {
  candidate: any
  index: number
  displayCount: number
  onSelect: (c: any) => void
  onOpenDetail: (c: any) => void
}) {
  const iconName = getPerspectiveIcon(c.perspective)
  const parsedTree = useMemo(() => {
    return c.strategy ? parseStrategyToTree(c.strategy) : null
  }, [c.strategy])

  const totalDirs = useMemo(() => {
    return parsedTree ? countDirectoryNodes(parsedTree) : 0
  }, [parsedTree])

  return (
    <div
      className={cn(
        'group relative p-6 md:p-7 rounded-2xl border border-border/80 dark:border-primary/15 bg-card hover:border-primary/50 dark:hover:border-primary/50 hover:shadow-xl dark:hover:bg-primary/[0.01] transition-all duration-300 flex flex-col overflow-hidden shadow-xs h-full',
        displayCount === 1 ? 'max-w-xl w-full' : 'w-full'
      )}
    >
      {i === 0 && (
        <div className="absolute top-3 right-3 z-10 select-none">
          <span className="bg-primary/10 text-primary dark:bg-primary/20 dark:text-primary border border-primary/20 text-[9px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider">
            {t('AI 推荐')}
          </span>
        </div>
      )}
      <div className="absolute top-0 right-0 p-4 opacity-5 group-hover:opacity-10 transition-opacity pointer-events-none select-none">
        <MaterialIcon icon="auto_awesome" className="text-7xl text-primary" />
      </div>

      {/* 头部方案视角与虚拟目录名 */}
      <div className="flex items-center mb-4 shrink-0">
        <div className="p-2.5 rounded-xl bg-primary/10 text-primary mr-3.5 shrink-0">
          <MaterialIcon icon={iconName} className="text-xl" />
        </div>
        <div className="min-w-0 pr-10">
          <span className="text-[10px] font-bold text-primary/80 dark:text-primary/70 uppercase tracking-widest mb-0.5 block select-none">
            {c.perspective}
          </span>
          <h3
            className="text-base md:text-lg font-bold text-foreground leading-snug line-clamp-1"
            title={c.name}
          >
            {c.name}
          </h3>
        </div>
      </div>

      {/* 目录结构树预览区域 */}
      <div className="flex-1 overflow-hidden min-h-0 mb-3 bg-muted/20 dark:bg-muted/10 p-3 rounded-xl border border-border/30 relative group-hover:border-border/50 transition-colors flex flex-col">
        <div className="flex items-center justify-between pb-2 mb-2 border-b border-border/20 text-[11px] text-muted-foreground shrink-0 select-none">
          <span className="font-semibold flex items-center gap-1">
            <MaterialIcon icon="account_tree" className="text-xs text-primary" />
            {t('完整目录结构树')}
          </span>
          {totalDirs > 0 && (
            <span className="bg-primary/10 text-primary px-1.5 py-0.2 rounded text-[10px] font-bold">
              {totalDirs} {t('个目录')}
            </span>
          )}
        </div>

        <div className="flex-1 overflow-y-auto pr-1 custom-scrollbar">
          {parsedTree && parsedTree.length > 0 ? (
            <ReadonlyDirectoryTree nodes={parsedTree} />
          ) : c.strategy && c.strategy.trim() ? (
            <div className="text-[12px] leading-relaxed text-muted-foreground font-mono whitespace-pre-wrap break-words">
              {c.strategy}
            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
              {t('生成失败，请点击重新生成')}
            </div>
          )}
        </div>

        <div className="absolute bottom-1 right-2 flex items-center gap-1.5">
          {c.strategy && c.strategy.trim() && (
            <button
              onClick={async e => {
                e.stopPropagation()
                await navigator.clipboard.writeText(c.strategy.trim())
                toast.success(t('目录树策略已复制到剪贴板'))
              }}
              className="text-[10px] font-bold text-muted-foreground hover:text-foreground bg-background dark:bg-zinc-900 px-2 py-0.5 rounded border border-border/30 shadow-xs hover:border-primary/40 transition-all cursor-pointer flex items-center gap-0.5"
              title={t('复制目录树文本')}
            >
              <MaterialIcon icon="content_copy" className="text-[9px]" />
              {t('复制')}
            </button>
          )}
          <button
            onClick={() => onOpenDetail(c)}
            className="text-[10px] font-bold text-primary/95 bg-background dark:bg-zinc-900 px-2 py-0.5 rounded border border-border/30 shadow-xs hover:border-primary/40 transition-all cursor-pointer flex items-center gap-0.5"
          >
            <MaterialIcon icon="open_in_new" className="text-[9px]" />
            {t('展开')}
          </button>
        </div>
      </div>

      {/* 理由/理念 */}
      {c.rationale && (
        <div className="shrink-0 pl-2.5 py-0.5 border-l-2 border-primary/30 mb-4 select-none">
          <p
            className="text-[11px] text-muted-foreground/80 line-clamp-2 leading-relaxed italic whitespace-pre-line"
            title={c.rationale}
          >
            {c.rationale}
          </p>
        </div>
      )}

      {/* 采用按钮 */}
      <Button
        onClick={() => onSelect(c)}
        className="w-full rounded-xl py-4.5 font-bold shadow-md shadow-primary/10 transition-all hover:scale-[1.01] active:scale-[0.98] cursor-pointer shrink-0"
      >
        <MaterialIcon icon="check_circle" className="text-sm mr-1" />
        {t('采用此目录结构')}
      </Button>
    </div>
  )
}

export function CandidatesView({
  candidates,
  isLoading,
  organizeMode,
  onSelectCandidate,
  isLimitPredict = false,
  onRegenerate,
  onSwitchToExternalAi
}: {
  candidates: any[]
  isLoading: boolean
  organizeMode: OrganizeMode
  onSelectCandidate: (c: any) => void
  isLimitPredict?: boolean
  onRegenerate?: () => void
  onSwitchToExternalAi?: () => void
}) {
  const [selectedDetail, setSelectedDetail] = useState<any>(null)
  const [loadingSeconds, setLoadingSeconds] = useState(0)

  // 软超时计时器：深度语义推理耗时感知
  React.useEffect(() => {
    let timer: NodeJS.Timeout | null = null
    if (isLoading) {
      setLoadingSeconds(0)
      timer = setInterval(() => {
        setLoadingSeconds(prev => prev + 1)
      }, 1000)
    } else {
      setLoadingSeconds(0)
    }
    return () => {
      if (timer) clearInterval(timer)
    }
  }, [isLoading])

  const displayCount = candidates.length > 0 ? candidates.length : isLimitPredict ? 2 : 3

  return (
    <div className="flex-1 flex flex-col px-6 md:px-12 lg:px-20 py-8 md:py-12 overflow-hidden">
      <div className="text-center mb-6 shrink-0">
        <h2 className="text-2xl md:text-3xl font-black mb-2 tracking-tight flex items-center justify-center gap-2.5">
          <MaterialIcon icon="auto_awesome" className="text-primary animate-pulse" />
          <span>{t('AI 精细规划目录结构直选')}</span>{' '}
          <span className="ml-1 text-xs px-2.5 py-0.5 rounded-full bg-purple-500/15 text-purple-600 dark:text-purple-400 font-bold border border-purple-500/30">
            {t('由文件推导目录树')}
          </span>
        </h2>
        {isLoading && loadingSeconds >= 15 && (
          <div className="mb-4 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-600 dark:text-amber-400 text-xs flex items-center justify-between shrink-0 animate-fade-in">
            <div className="flex items-center gap-2">
              <MaterialIcon icon="hourglass_top" className="text-sm animate-spin-slow shrink-0" />
              <span>{t('深度语义规划耗时较长（已耗时 {seconds} 秒），若本地模型响应缓慢，可切换为外部 AI 规划', { seconds: loadingSeconds })}</span>
            </div>
            {onSwitchToExternalAi && (
              <button
                onClick={onSwitchToExternalAi}
                className="font-bold underline hover:opacity-80 cursor-pointer ml-3 shrink-0"
              >
                {t('切换为外部 AI 规划')}
              </button>
            )}
          </div>
        )}

        <p className="text-xs md:text-sm text-muted-foreground">
          {t('AI 已深度规划生成 3 套完整层级目录结构树，点击直接采用并进入微调，无需二次等待')}
        </p>
      </div>

      <div
        className={cn(
          'flex-1 min-h-0 w-full overflow-hidden',
          displayCount === 1
            ? 'flex justify-center items-start'
            : displayCount === 2
              ? 'grid grid-cols-1 md:grid-cols-2 grid-rows-[minmax(0,1fr)] gap-6'
              : 'grid grid-cols-1 md:grid-cols-3 grid-rows-[minmax(0,1fr)] gap-6'
        )}
      >
        {isLoading ? (
          Array.from({ length: displayCount }).map((_, i) => (
            <div
              key={i}
              className={cn(
                'relative p-7 rounded-2xl border border-primary/10 bg-card/50 flex flex-col overflow-hidden animate-pulse shadow-xs h-full',
                displayCount === 1 ? 'max-w-xl w-full' : 'w-full'
              )}
            >
              <div className="flex items-center mb-5 shrink-0">
                <div className="w-10 h-10 rounded-xl bg-muted mr-3.5" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 bg-muted rounded-md w-1/3" />
                  <div className="h-5 bg-muted rounded-md w-2/3" />
                </div>
              </div>
              <div className="space-y-2.5 flex-1 min-h-0 bg-muted/20 rounded-xl p-3">
                <div className="h-3.5 bg-muted rounded-md w-1/2" />
                <div className="h-3 bg-muted rounded-md w-3/4 ml-4" />
                <div className="h-3 bg-muted rounded-md w-2/3 ml-8" />
                <div className="h-3 bg-muted rounded-md w-4/5 ml-4" />
                <div className="h-3 bg-muted rounded-md w-3/5 ml-8" />
              </div>
              <div className="py-3 border-y border-border/40 my-3 shrink-0">
                <div className="h-3 bg-muted rounded-md w-3/4" />
              </div>
              <div className="h-10 bg-muted rounded-xl w-full shrink-0" />
            </div>
          ))
        ) : candidates.length > 0 ? (
          candidates.map((c, i) => (
            <CandidateCard
              key={i}
              candidate={c}
              index={i}
              displayCount={displayCount}
              onSelect={onSelectCandidate}
              onOpenDetail={setSelectedDetail}
            />
          ))
        ) : (
          <div className="col-span-full py-16 px-8 rounded-2xl border border-dashed border-border/60 bg-muted/10 flex flex-col items-center justify-center text-center max-w-xl mx-auto my-auto shadow-xs">
            <div className="w-16 h-16 rounded-2xl bg-destructive/10 dark:bg-destructive/20 text-destructive flex items-center justify-center mb-6 shadow-inner">
              <MaterialIcon icon="smart_toy" className="text-3xl" />
            </div>
            <h3 className="text-xl font-bold text-foreground mb-3 tracking-tight">
              {t('推荐方案生成失败')}
            </h3>
            <p className="text-sm text-muted-foreground max-w-md mb-8 leading-relaxed">
              {t('未获取到推荐的整理方案。这可能是因为本地大模型繁忙或算力不足。')}
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Button
                onClick={onRegenerate}
                className="rounded-xl px-5 py-4 font-bold shadow-md shadow-primary/10 transition-all hover:scale-[1.02] active:scale-[0.98] cursor-pointer flex items-center gap-2"
              >
                <MaterialIcon icon="refresh" className="text-sm" />
                {t('重新生成方案')}
              </Button>
              {onSwitchToExternalAi && (
                <Button
                  variant="outline"
                  onClick={onSwitchToExternalAi}
                  className="rounded-xl px-5 py-4 font-bold border-cyan-500/40 text-cyan-600 dark:text-cyan-400 hover:bg-cyan-500/10 cursor-pointer flex items-center gap-2 transition-all hover:scale-[1.02] active:scale-[0.98]"
                >
                  <MaterialIcon icon="travel_explore" className="text-sm" />
                  {t('切换为外部 AI 规划')}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="mt-5 text-center text-xs text-muted-foreground flex items-center justify-center gap-1.5 shrink-0 opacity-80">
        <MaterialIcon icon="info" className="text-sm text-primary/75" />
        <span>
          {t(
            '建议使用“高中生”级别以上的模型才能获取较好效果；每个方案均自带推荐虚拟目录名与完整层级树'
          )}
        </span>
      </div>

      <Dialog open={!!selectedDetail} onOpenChange={val => !val && setSelectedDetail(null)}>
        <DialogContent className="sm:max-w-[800px] p-0 overflow-hidden rounded-2xl border-border/60 shadow-2xl bg-card">
          {selectedDetail && (
            <>
              <div className="p-6 pb-4 border-b border-border/40 bg-muted/20 relative">
                <div className="absolute top-0 right-0 p-6 text-primary/10 select-none pointer-events-none">
                  <MaterialIcon icon="auto_awesome" className="text-7xl" />
                </div>
                <DialogHeader className="relative z-10">
                  <div className="flex items-center gap-3">
                    <div className="p-2.5 rounded-xl bg-primary/10 text-primary">
                      <MaterialIcon icon="visibility" className="text-xl" />
                    </div>
                    <div>
                      <DialogTitle className="text-xl font-bold tracking-tight">
                        {selectedDetail.name}
                      </DialogTitle>
                      <span className="text-xs font-semibold text-primary uppercase tracking-widest mt-0.5 inline-block">
                        {selectedDetail.perspective}
                      </span>
                    </div>
                  </div>
                </DialogHeader>
              </div>

              <div className="p-6 space-y-6 overflow-y-auto custom-scrollbar max-h-[60vh]">
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                      <MaterialIcon icon="menu_book" className="text-sm" />
                      <span>{t('完整目录结构树')}</span>
                    </h4>
                    {selectedDetail.strategy && (
                      <button
                        onClick={async () => {
                          await navigator.clipboard.writeText(selectedDetail.strategy.trim())
                          toast.success(t('整理策略已复制到剪贴板'))
                        }}
                        className="text-xs text-primary hover:text-primary/80 font-medium flex items-center gap-1 cursor-pointer transition-colors"
                      >
                        <MaterialIcon icon="content_copy" className="text-xs" />
                        <span>{t('复制策略')}</span>
                      </button>
                    )}
                  </div>
                  <div className="bg-muted/30 rounded-xl p-4 border border-border/30 overflow-y-auto max-h-[300px]">
                    <div className="text-sm leading-relaxed text-foreground whitespace-pre-wrap break-words font-mono">
                      {selectedDetail.strategy}
                    </div>
                  </div>
                </div>

                {selectedDetail.rationale && (
                  <div className="space-y-2.5">
                    <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                      <MaterialIcon icon="info" className="text-sm" />
                      <span>{t('推荐理由与理念')}</span>
                    </h4>
                    <div className="bg-muted/30 rounded-xl p-4 border border-border/30">
                      <p className="text-sm leading-relaxed text-muted-foreground whitespace-pre-line">
                        {selectedDetail.rationale}
                      </p>
                    </div>
                  </div>
                )}
              </div>

              <DialogFooter className="p-6 pt-4 border-t border-border/40 bg-muted/10 gap-2 sm:gap-0">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setSelectedDetail(null)}
                  className="rounded-xl font-semibold text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                >
                  {t('关闭')}
                </Button>
                <Button
                  onClick={() => {
                    onSelectCandidate(selectedDetail)
                    setSelectedDetail(null)
                  }}
                  className="rounded-xl font-bold bg-primary hover:bg-primary/95 text-primary-foreground shadow-lg shadow-primary/20 transition-all active:scale-[0.98]"
                >
                  {t('采用此目录结构')}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
