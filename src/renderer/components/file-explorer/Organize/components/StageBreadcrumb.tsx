import React from 'react'
import { Stage } from '../types'
import { MaterialIcon, cn } from '../../../../lib/utils'
import { t } from '@app/languages'
import { useOrganizeStore } from '../../../../stores/organize-store'

export interface StageBreadcrumbProps {
  stage: Stage
  onSelectStage?: (stage: Stage) => void
  hasCandidates?: boolean
  hasStructure?: boolean
  hasDone?: boolean
}

export function StageBreadcrumb({
  stage,
  onSelectStage,
  hasCandidates,
  hasStructure,
  hasDone
}: StageBreadcrumbProps) {
  const activeBranch = useOrganizeStore(s => s.activeBranch) || 'organize'
  const visitedStages = useOrganizeStore(s => s.visitedStages) || ['root-mode-select']
  const organizeMode = useOrganizeStore(s => s.organizeMode)
  const currentVDir = useOrganizeStore(s => s.currentVDir)
  const draftTree = useOrganizeStore(s => s.draftTree)
  const finalTree = useOrganizeStore(s => s.finalTree)
  const progressInfo = useOrganizeStore(s => s.progressInfo)
  const isPaused = useOrganizeStore(s => s.isPaused)
  const setStoreStage = useOrganizeStore(s => s.setStage)
  const searchParams = new URLSearchParams(window.location.search)
  const vdIdParam = searchParams.get('vdId')
  const actionParam = searchParams.get('action')
  const modeParam = searchParams.get('mode')

  const handleStageClick = (targetStage: Stage) => {
    if (onSelectStage) {
      onSelectStage(targetStage)
    } else {
      setStoreStage(targetStage)
    }
  }

  const isDirectDone = Boolean(
    stage === 'done' &&
    ((vdIdParam && actionParam !== 'regenerate' && modeParam !== 'incremental-organize') ||
      (currentVDir &&
        currentVDir.source !== 'draft' &&
        organizeMode !== 'fast-organize' &&
        organizeMode !== 'fine-organize'))
  )

  // 根首页项
  const homeStep = { key: 'root-mode-select' as Stage, label: t('首页'), icon: 'home' }

  let steps: Array<{ key: Stage; label: string; icon: string }> = []

  if (activeBranch === 'batch-rename') {
    steps = [homeStep, { key: 'batch-rename', label: t('批量更名'), icon: 'drive_file_rename_outline' }]
  } else if (activeBranch === 'batch-tag') {
    steps = [homeStep, { key: 'batch-tag', label: t('批量标签'), icon: 'label' }]
  } else if (activeBranch === 'batch-duplicate') {
    steps = [homeStep, { key: 'batch-duplicate', label: t('批量查重'), icon: 'content_copy' }]
  } else if (isDirectDone) {
    steps = [homeStep, { key: 'done', label: t('继续整理'), icon: 'check_circle' }]
  } else {
    // 默认整理主流程分支
    const organizeSteps: Array<{ key: Stage; label: string; icon: string }> = [
      homeStep,
      { key: 'mode-select', label: t('批量整理'), icon: 'auto_fix_high' },
      { key: 'candidates', label: t('选择方案'), icon: 'auto_awesome_motion' },
      { key: 'structure', label: t('目录预览'), icon: 'folder_open' },
      { key: 'organizing', label: t('整理中'), icon: 'auto_fix_high' },
      { key: 'done', label: t('完成'), icon: 'check_circle' }
    ]

    steps =
      organizeMode === 'incremental-organize' || currentVDir?.source === 'draft'
        ? organizeSteps.filter(s => s.key !== 'candidates')
        : organizeSteps
  }

  const isStepLit = (key: Stage): boolean => {
    // 首页永远点亮
    if (key === 'root-mode-select') return true
    // 当前所在步骤点亮
    if (key === stage) return true
    // 用户历史访问到达过的步骤点亮
    if (visitedStages.includes(key)) return true
    // 批量整理在 organize 分支下若曾经选择过
    if (key === 'mode-select') {
      return visitedStages.includes('mode-select')
    }
    // 具备前置生成数据的步骤点亮
    if (key === 'candidates') {
      return Boolean(hasCandidates || draftTree?.length > 0 || (finalTree?.length ?? 0) > 0)
    }
    if (key === 'structure') {
      return Boolean(hasStructure || draftTree?.length > 0 || (finalTree?.length ?? 0) > 0)
    }
    if (key === 'organizing') {
      return Boolean((progressInfo?.total ?? 0) > 0 || isPaused)
    }
    if (key === 'done') {
      return Boolean(hasDone || (finalTree?.length ?? 0) > 0)
    }
    return false
  }

  return (
    <div className="flex items-center gap-1 text-xs shrink min-w-0 overflow-hidden">
      {steps.map((step, idx) => {
        const isActive = step.key === stage
        const isLit = isStepLit(step.key)
        const isClickable = isLit

        return (
          <React.Fragment key={step.key}>
            <span
              title={step.label}
              onClick={() => {
                if (isClickable) {
                  handleStageClick(step.key)
                }
              }}
              className={cn(
                'flex items-center gap-1 px-2.5 py-1 rounded-full font-semibold transition-all duration-200 min-w-0 shrink overflow-hidden select-none',
                isClickable ? 'cursor-pointer' : 'cursor-not-allowed opacity-35',
                isActive
                  ? 'bg-primary/20 text-primary shadow-xs ring-1 ring-primary/30 font-bold hover:bg-primary/25'
                  : isLit
                    ? 'bg-primary/10 text-primary/85 hover:bg-primary/20 border border-primary/20 hover:text-primary'
                    : 'text-muted-foreground/40'
              )}
            >
              <MaterialIcon
                icon={isLit && !isActive && step.key !== 'root-mode-select' ? 'check' : step.icon}
                className="text-[13px] shrink-0"
              />
              <span className="truncate min-w-0 whitespace-nowrap">{step.label}</span>
            </span>
            {idx < steps.length - 1 && (
              <MaterialIcon
                icon="chevron_right"
                className={cn(
                  'text-[13px] shrink-0 transition-colors',
                  isLit ? 'text-primary/40' : 'text-muted-foreground/30'
                )}
              />
            )}
          </React.Fragment>
        )
      })}
    </div>
  )
}
