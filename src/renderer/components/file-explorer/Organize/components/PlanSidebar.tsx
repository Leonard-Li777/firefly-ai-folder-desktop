import React from 'react'
import { MaterialIcon } from '../../../../lib/utils'
import { t } from '@app/languages'

export function PlanSidebar({
  draft,
  candidate
}: {
  draft: {
    name: string
    strategy?: string
    source: any
    perspective?: string
    rationale?: string
    description?: string
  } | null
  candidate: any
}) {
  const perspectiveText = (draft as any)?.perspective || candidate?.perspective || ''
  const strategyText = draft?.strategy || candidate?.strategy || ''
  const rationaleText =
    (draft as any)?.rationale ||
    candidate?.rationale ||
    (draft as any)?.description ||
    candidate?.description ||
    ''

  return (
    <div className="h-full shrink-0 border-r bg-muted/10 p-4 overflow-y-auto flex flex-col gap-4">
      <div>
        {!!perspectiveText && (
          <div className="flex items-center gap-2 mb-1">
            <div className="p-1.5 rounded-lg bg-primary/10 text-primary">
              <MaterialIcon icon="auto_awesome" className="text-sm" />
            </div>
            <span className="text-xs font-semibold text-primary uppercase tracking-widest">
              {perspectiveText}
            </span>
          </div>
        )}
        <h3 className="text-base font-bold">{draft?.name || candidate?.name || t('未命名方案')}</h3>
      </div>

      {!!strategyText && (
        <div className="space-y-1.5">
          <h4 className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
            <MaterialIcon icon="menu_book" className="text-sm" />
            <span>{t('整理策略')}</span>
          </h4>
          <div className="bg-card rounded-lg p-3 border border-border/40">
            <div className="text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap break-words">
              {strategyText}
            </div>
          </div>
        </div>
      )}

      {!!rationaleText && (
        <div className="space-y-1.5">
          <h4 className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
            <MaterialIcon icon="info" className="text-sm" />
            <span>{t('推荐理由')}</span>
          </h4>
          <div className="bg-card rounded-lg p-3 border border-border/40">
            <p className="text-xs leading-relaxed text-muted-foreground whitespace-pre-line">
              {rationaleText}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
