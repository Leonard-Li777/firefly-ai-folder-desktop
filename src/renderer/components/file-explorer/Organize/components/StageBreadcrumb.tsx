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

  const draft = useOrganizeStore(s => s.draft)
  const isDirectDone = Boolean(
    stage === 'done' &&
    ((vdIdParam && actionParam !== 'regenerate' && modeParam !== 'incremental-organize') ||
      (currentVDir &&
        currentVDir.source !== 'draft' &&
        organizeMode !== 'fine-organize'))
  )

  // 根整理首页项
  const homeStep = { key: 'root-mode-select' as Stage, label: t('整理首页'), icon: 'home' }

  let steps: Array<{ key: Stage; label: string; icon: string }> = []

  if (activeBranch === 'batch-rename') {
    steps = [homeStep, { key: 'batch-rename', label: t('批量更名'), icon: 'drive_file_rename_outline' }]
  } else if (activeBranch === 'batch-tag') {
    steps = [homeStep, { key: 'batch-tag', label: t('批量标签'), icon: 'label' }]
  } else if (activeBranch === 'batch-duplicate') {
    steps = [homeStep, { key: 'batch-duplicate', label: t('批量查重'), icon: 'content_copy' }]
  } else if (isDirectDone) {
    steps = [homeStep, { key: 'done', label: t('继续整理'), icon: 'check_circle' }]
  } else if (stage === 'smart-clustering' || organizeMode === 'smart-clustering') {
    steps = [
      homeStep,
      { key: 'mode-select', label: t('模式选择'), icon: 'auto_fix_high' },
      { key: 'smart-clustering', label: t('智能聚类'), icon: 'hub' }
    ]
  } else {
    // 默认整理主流程分支
    const isCustomTree = organizeMode === 'custom-tree' || stage === 'custom-tree' || draft?.source === 'custom-tree' || draft?.source === 'user-defined'
    const isExternalAi = stage === 'external-ai' || draft?.source === 'external-ai' || organizeMode === 'external-ai'
    const isIdentityMode = organizeMode === 'identity-blueprint'

    const intermediateSteps: Array<{ key: Stage; label: string; icon: string }> = []

    if (isExternalAi) {
      intermediateSteps.push({
        key: 'external-ai',
        label: t('外部AI引导'),
        icon: 'travel_explore'
      })
      if (
        stage === 'custom-tree' ||
        stage === 'structure' ||
        stage === 'organizing' ||
        stage === 'done' ||
        visitedStages.includes('custom-tree')
      ) {
        intermediateSteps.push({
          key: 'custom-tree',
          label: t('自定义目录树'),
          icon: 'account_tree'
        })
      }
    } else if (isCustomTree) {
      intermediateSteps.push({
        key: 'custom-tree',
        label: t('自定义目录树'),
        icon: 'account_tree'
      })
    } else {
      intermediateSteps.push({
        key: 'candidates',
        label: isIdentityMode ? t('身份蓝图') : t('选择方案'),
        icon: isIdentityMode ? 'psychology' : 'auto_awesome_motion'
      })
    }

    const organizeSteps: Array<{ key: Stage; label: string; icon: string }> = [
      homeStep,
      { key: 'mode-select', label: t('模式选择'), icon: 'auto_fix_high' },
      ...intermediateSteps,
      { key: 'structure', label: t('目录微调'), icon: 'folder_open' },
      { key: 'organizing', label: t('自动归类'), icon: 'auto_fix_high' },
      { key: 'done', label: t('完成'), icon: 'check_circle' }
    ]

    steps =
      organizeMode === 'incremental-organize' || currentVDir?.source === 'draft'
        ? organizeSteps.filter(s => s.key !== 'candidates' && s.key !== 'custom-tree' && s.key !== 'external-ai')
        : organizeSteps
  }

  const isStepLit = (key: Stage): boolean => {
    // 首页永远点亮
    if (key === 'root-mode-select') return true
    // 当前所在步骤点亮
    if (key === stage) return true
    // 用户历史访问到达过的步骤点亮
    if (visitedStages.includes(key)) return true
    // 智能聚类单 Stage
    if (key === 'smart-clustering') {
      return stage === 'smart-clustering' || visitedStages.includes('smart-clustering')
    }
    // 批量整理在 organize 分支下若曾经选择过
    if (key === 'mode-select') {
      return visitedStages.includes('mode-select')
    }
    // 外部 AI 步骤点亮
    if (key === 'external-ai') {
      return stage === 'external-ai' || visitedStages.includes('external-ai') || Boolean(draft?.source === 'external-ai')
    }
    // 自定义目录树步骤点亮
    if (key === 'custom-tree') {
      return stage === 'custom-tree' || visitedStages.includes('custom-tree') || Boolean(draftTree?.length > 0)
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
    <div className="flex items-center gap-1 text-xs shrink min-w-0 overflow-x-auto no-scrollbar py-0.5">
      {steps.map((step, idx) => {
        const isActive = step.key === stage
        const isLit = isStepLit(step.key)
        const isClickable = isLit
        // 首页使用 primary 实心按钮风格，与其它面包屑步骤区分
        const isHome = step.key === 'root-mode-select'

        return (
          <React.Fragment key={step.key}>
            <span
              title={
                isHome
                  ? t('返回整理首页，查看功能概览并切换其他路径')
                  : step.label
              }
              onClick={() => {
                if (isClickable) {
                  handleStageClick(step.key)
                }
              }}
              className={cn(
                'flex items-center gap-1 px-2.5 py-1 rounded-full font-semibold transition-all duration-200 shrink-0 overflow-hidden select-none',
                isClickable ? 'cursor-pointer' : 'cursor-not-allowed opacity-35',
                isHome
                  ? 'bg-primary text-primary-foreground shadow-md ring-1 ring-primary/40 hover:bg-primary/90 hover:shadow-lg hover:scale-[1.02] active:scale-[0.98]'
                  : isActive
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
