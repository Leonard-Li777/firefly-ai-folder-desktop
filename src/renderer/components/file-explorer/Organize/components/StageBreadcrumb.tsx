import React from 'react'
import { Stage } from '../types'
import { MaterialIcon, cn } from '../../../../lib/utils'
import { t } from '@app/languages'
import { useOrganizeStore } from '../../../../stores/organize-store'

export function StageBreadcrumb({ stage }: { stage: Stage }) {
  const organizeMode = useOrganizeStore(s => s.organizeMode)
  const currentVDir = useOrganizeStore(s => s.currentVDir)
  const searchParams = new URLSearchParams(window.location.search)
  const vdIdParam = searchParams.get('vdId')
  const actionParam = searchParams.get('action')
  const modeParam = searchParams.get('mode')

  // 如果是从已有虚拟目录直接“继续整理”进入完成阶段（action=continue 或 currentVDir 为非草稿直达 done），前面未经历任何 stage
  const isDirectDone = Boolean(
    stage === 'done' &&
    ((vdIdParam && actionParam !== 'regenerate' && modeParam !== 'incremental-organize') ||
      (currentVDir &&
        currentVDir.source !== 'draft' &&
        organizeMode !== 'fast-organize' &&
        organizeMode !== 'fine-organize'))
  )

  const allSteps: Array<{ key: Stage; label: string; icon: string }> = [
    { key: 'mode-select', label: t('选择模式'), icon: 'tune' },
    { key: 'candidates', label: t('选择方案'), icon: 'auto_awesome_motion' },
    { key: 'structure', label: t('目录预览'), icon: 'folder_open' },
    { key: 'organizing', label: t('整理中'), icon: 'auto_fix_high' },
    { key: 'done', label: t('完成'), icon: 'check_circle' }
  ]

  const steps = isDirectDone
    ? [{ key: 'done' as Stage, label: t('继续整理'), icon: 'check_circle' }]
    : organizeMode === 'incremental-organize' || currentVDir?.source === 'draft'
      ? allSteps.filter(s => s.key !== 'candidates')
      : allSteps

  const currentIdx = steps.findIndex(s => s.key === stage)

  return (
    <div className="flex items-center gap-1 text-xs">
      {steps.map((step, idx) => (
        <React.Fragment key={step.key}>
          <span
            className={cn(
              'flex items-center gap-1.5 px-2.5 py-1 rounded-full font-semibold transition-all duration-300',
              idx === currentIdx
                ? 'bg-primary/10 text-primary shadow-xs ring-1 ring-primary/5'
                : idx < currentIdx
                  ? 'bg-primary/5 text-primary/70 dark:text-primary/80 border border-primary/10'
                  : 'text-muted-foreground/40'
            )}
          >
            <MaterialIcon icon={idx < currentIdx ? 'check' : step.icon} className="text-[13px]" />
            {step.label}
          </span>
          {idx < steps.length - 1 && (
            <MaterialIcon icon="chevron_right" className="text-[13px] text-muted-foreground/30" />
          )}
        </React.Fragment>
      ))}
    </div>
  )
}
