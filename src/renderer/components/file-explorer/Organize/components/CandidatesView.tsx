import React, { useState } from 'react'
import { OrganizeMode } from '../types'
import { MaterialIcon, cn } from '../../../../lib/utils'
import { t } from '@app/languages'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../../../ui/dialog'
import { getPerspectiveIcon } from '../utils/helpers'
import { Button } from '../../../ui/button'

export function CandidatesView({
  candidates,
  isLoading,
  organizeMode,
  onSelectCandidate,
  isLimitPredict = false,
  onRegenerate
}: {
  candidates: any[]
  isLoading: boolean
  organizeMode: OrganizeMode
  onSelectCandidate: (c: any) => void
  isLimitPredict?: boolean
  onRegenerate?: () => void
}) {
  const [selectedDetail, setSelectedDetail] = useState<any>(null)

  const displayCount = candidates.length > 0 ? candidates.length : isLimitPredict ? 2 : 3

  return (
    <div className="flex-1 flex flex-col px-6 md:px-12 lg:px-20 py-8 md:py-12 overflow-hidden">
      <div className="text-center mb-6 shrink-0">
        <h2 className="text-3xl font-black mb-4 tracking-tight flex items-center justify-center gap-3">
          <MaterialIcon icon="auto_awesome" className="text-primary animate-pulse" />
          {t('AI 智能推荐整理方案')}{' '}
          <span className="ml-2 text-sm px-3 py-1 rounded-full bg-primary/15 text-primary font-bold border border-primary/30">
            {organizeMode === 'fast-organize' ? t('快速整理') : t('精细整理')}
          </span>
        </h2>
        <p className="text-muted-foreground">{t('基于您的文件内容，AI 生成了以下多视角方案')}</p>
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
                'relative p-8 rounded-2xl border border-primary/10 bg-card/50 flex flex-col overflow-hidden animate-pulse shadow-xs h-full',
                displayCount === 1 ? 'max-w-xl w-full' : 'w-full'
              )}
            >
              <div className="flex items-center mb-6 shrink-0">
                <div className="w-10 h-10 rounded-xl bg-muted mr-4" />
                <div className="flex-1 space-y-2.5">
                  <div className="h-5 bg-muted rounded-md w-2/3" />
                  <div className="h-3 bg-muted rounded-md w-1/3" />
                </div>
              </div>
              <div className="space-y-3 flex-1 min-h-0">
                <div className="h-4 bg-muted rounded-md w-full" />
                <div className="h-4 bg-muted rounded-md w-5/6" />
                <div className="h-4 bg-muted rounded-md w-4/5" />
                <div className="h-4 bg-muted rounded-md w-3/4" />
                <div className="h-4 bg-muted rounded-md w-2/3" />
              </div>
              <div className="py-4 border-y border-border/40 my-4 shrink-0">
                <div className="h-3 bg-muted rounded-md w-3/4" />
              </div>
              <div className="h-11 bg-muted rounded-2xl w-full shrink-0" />
            </div>
          ))
        ) : candidates.length > 0 ? (
          candidates.map((c, i) => {
            const iconName = getPerspectiveIcon(c.perspective)
            return (
              <div
                key={i}
                className={cn(
                  'group relative p-8 rounded-2xl border border-border/80 dark:border-primary/15 bg-card hover:border-primary/40 dark:hover:border-primary/40 hover:shadow-xl dark:hover:bg-primary/[0.01] transition-all duration-300 flex flex-col overflow-hidden shadow-xs h-full',
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

                <div className="flex items-center mb-4 shrink-0">
                  <div className="p-2.5 rounded-xl bg-primary/10 text-primary mr-4 shrink-0">
                    <MaterialIcon icon={iconName} className="text-xl" />
                  </div>
                  <div className="min-w-0 pr-12">
                    <span className="text-[10px] font-bold text-primary/80 dark:text-primary/70 uppercase tracking-widest mb-0.5 block select-none">
                      {c.perspective}
                    </span>
                    <h3
                      className="text-lg font-bold text-foreground leading-snug line-clamp-2"
                      title={c.name}
                    >
                      {c.name}
                    </h3>
                  </div>
                </div>

                <div className="flex-1 overflow-hidden min-h-0 mb-4 bg-muted/30 dark:bg-muted/10 p-3.5 rounded-xl border border-border/20 relative group-hover:border-border/40 transition-colors flex flex-col">
                  <div className="flex-1 overflow-y-auto pr-1 custom-scrollbar">
                    {c.strategy && c.strategy.trim() ? (
                      <div className="text-[13px] leading-relaxed text-muted-foreground font-mono whitespace-pre-wrap break-words">
                        {c.strategy}
                      </div>
                    ) : (
                      <div className="flex items-center justify-center h-full text-muted-foreground">
                        {t('生成失败，请点击顶部工具栏：重新生成')}
                      </div>
                    )}
                  </div>
                  <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-muted/60 dark:from-zinc-900/60 to-transparent pointer-events-none" />
                  <button
                    onClick={() => setSelectedDetail(c)}
                    className="absolute bottom-2 right-2 text-[10px] font-bold text-primary/95 bg-background dark:bg-zinc-900 px-2 py-0.5 rounded border border-border/30 shadow-xs hover:border-primary/40 transition-all cursor-pointer flex items-center gap-0.5"
                  >
                    <MaterialIcon icon="open_in_new" className="text-[9px]" />
                    {t('展开策略')}
                  </button>
                </div>

                {c.rationale && (
                  <div className="shrink-0 pl-3 py-1 border-l-2 border-primary/30 mb-5 select-none">
                    <p
                      className="text-xs text-muted-foreground/80 line-clamp-3 leading-relaxed italic whitespace-pre-line"
                      title={c.rationale}
                    >
                      {c.rationale}
                    </p>
                  </div>
                )}

                <Button
                  onClick={() => onSelectCandidate(c)}
                  className="w-full rounded-xl py-5 font-bold shadow-md shadow-primary/10 transition-all hover:scale-[1.01] active:scale-[0.98] cursor-pointer shrink-0"
                >
                  <MaterialIcon icon="check_circle" className="text-sm mr-1" />
                  {t('采用此方案')}
                </Button>
              </div>
            )
          })
        ) : (
          <div className="col-span-full py-16 px-8 rounded-2xl border border-dashed border-border/60 bg-muted/10 flex flex-col items-center justify-center text-center max-w-xl mx-auto my-auto shadow-xs">
            <div className="w-16 h-16 rounded-2xl bg-destructive/10 dark:bg-destructive/20 text-destructive flex items-center justify-center mb-6 shadow-inner">
              <MaterialIcon icon="smart_toy" className="text-3xl" />
            </div>
            <h3 className="text-xl font-bold text-foreground mb-3 tracking-tight">
              {t('推荐方案生成失败')}
            </h3>
            <p className="text-sm text-muted-foreground max-w-md mb-8 leading-relaxed">
              {t('未获取到推荐的整理方案。这可能是因为 AI 引擎繁忙。')}
            </p>
            <Button
              onClick={onRegenerate}
              className="rounded-xl px-6 py-5 font-bold shadow-md shadow-primary/10 transition-all hover:scale-[1.02] active:scale-[0.98] cursor-pointer flex items-center gap-2"
            >
              <MaterialIcon icon="refresh" className="text-sm animate-spin-slow" />
              {t('重新生成方案')}
            </Button>
          </div>
        )}
      </div>

      <div className="mt-6 text-center text-xs text-muted-foreground flex items-center justify-center gap-1.5 shrink-0 opacity-80">
        <MaterialIcon icon="info" className="text-sm text-primary/75" />
        <span>
          {t(
            '推荐4B以上本地模型或云端模型，文件需要AI分析模式有完整描述和标签，才能获得最佳整理效果'
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

              <div className="p-6 space-y-6 overflow-y-auto custom-scrollbar">
                <div className="space-y-2.5">
                  <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                    <MaterialIcon icon="menu_book" className="text-sm" />
                    <span>{t('整理策略')}</span>
                  </h4>
                  <div className="bg-muted/30 rounded-xl p-4 border border-border/30 overflow-y-auto max-h-[300px]">
                    <div className="text-sm leading-relaxed text-foreground whitespace-pre-wrap break-words">
                      {selectedDetail.strategy}
                    </div>
                  </div>
                </div>

                {selectedDetail.rationale && (
                  <div className="space-y-2.5">
                    <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                      <MaterialIcon icon="info" className="text-sm" />
                      <span>{t('推荐理由')}</span>
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
                  {t('采用此方案')}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
