import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { WorkflowCategory } from '@firefly/types'
import type { PreviewNode } from '@firefly/shared'
import { Button } from '../../../ui/button'
import { MaterialIcon, cn } from '../../../../lib/utils'
import { t } from '@app/languages'
import {
  Sparkles,
  CheckCircle2,
  ArrowRight,
  Filter,
  Tag,
  FolderTree,
  ShieldCheck
} from 'lucide-react'
import {
  extractWorkflowIncludedExtensions,
  getPersonaLabels,
  getWorkflowCategories,
  getWorkflowIconComponent
} from './helpers'
import { PreviewTreeNodeView } from './preview-tree-node-view'
import type { ScoreMapEntry } from './types'

interface WorkflowSelectionStepProps {
  currentStep: 1 | 2
  top1Recommendation: any | null
  isTopRecommendationHighlighted: boolean
  workflows: any[]
  displayedWorkflows: any[]
  activeCategory: WorkflowCategory | 'all'
  setActiveCategory: Dispatch<SetStateAction<WorkflowCategory | 'all'>>
  selectedWorkflowId: string
  setSelectedWorkflowId: Dispatch<SetStateAction<string>>
  hasUserInteractedRef: MutableRefObject<boolean>
  scoreMap: Map<string, ScoreMapEntry>
  previewTreeNodes: PreviewNode[]
  selectedNamingTemplate: string
  selectedWorkflow: any
  isShowingAllWorkflows: boolean
  setIsShowingAllWorkflows: Dispatch<SetStateAction<boolean>>
  setCurrentStep: Dispatch<SetStateAction<1 | 2>>
}

export const WorkflowSelectionStep = ({
  currentStep,
  top1Recommendation,
  isTopRecommendationHighlighted,
  workflows,
  displayedWorkflows,
  activeCategory,
  setActiveCategory,
  selectedWorkflowId,
  setSelectedWorkflowId,
  hasUserInteractedRef,
  scoreMap,
  previewTreeNodes,
  selectedNamingTemplate,
  selectedWorkflow,
  isShowingAllWorkflows,
  setIsShowingAllWorkflows,
  setCurrentStep
}: WorkflowSelectionStepProps) => {
  return (
    <>
      {/* ================= 步骤 1 专属：推荐首选通栏横幅 (在第 2 步隐藏) ================= */}
      {currentStep === 1 && top1Recommendation && (
        <div
          className={cn(
            'p-3 rounded-xl border flex items-center justify-between gap-4 shrink-0 shadow-2xs transition-colors',
            isTopRecommendationHighlighted
              ? 'border-primary/40 bg-gradient-to-r from-primary/15 via-primary/10 to-transparent ring-1 ring-primary/20'
              : 'border-border/50 bg-muted/30'
          )}
        >
          <div className="flex items-center gap-3 min-w-0">
            <div
              className={cn(
                'w-9 h-9 rounded-xl flex items-center justify-center text-sm font-bold shrink-0 shadow-xs',
                isTopRecommendationHighlighted
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground'
              )}
            >
              ★
            </div>
            <div className="min-w-0 space-y-0.5">
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className={cn(
                    'text-xs font-bold px-2 py-0.5 rounded-full shadow-2xs',
                    isTopRecommendationHighlighted
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground'
                  )}
                >
                  {isTopRecommendationHighlighted
                    ? `🔥 ${t('推荐首选 · 实测 {score} 分', { score: top1Recommendation.score })}`
                    : top1Recommendation.score >= 70
                      ? `★ ${t('参考首选 · 实测 {score} 分', { score: top1Recommendation.score })}`
                      : `💡 ${t('建议方案 · 契合度较低 ({score}分)', { score: top1Recommendation.score })}`}
                </span>
                <h4 className="text-sm font-bold text-foreground truncate">
                  {top1Recommendation.name}
                </h4>
                <span className="text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground font-medium">
                  {getPersonaLabels()[top1Recommendation?.persona] || top1Recommendation?.persona}
                </span>
              </div>
              <p className="text-xs text-muted-foreground truncate">
                {top1Recommendation.matchReason || top1Recommendation.summary}
              </p>
            </div>
          </div>

          <Button
            type="button"
            size="sm"
            variant="default"
            onClick={() => {
              hasUserInteractedRef.current = true
              setSelectedWorkflowId(top1Recommendation.id)
              setCurrentStep(2)
            }}
            className="px-3.5 py-1.5 text-xs font-bold bg-primary hover:bg-primary/90 text-primary-foreground shrink-0 shadow-xs"
          >
            <span>{t('采纳此推荐')}</span>
            <ArrowRight className="w-3.5 h-3.5 ml-1" />
          </Button>
        </div>
      )}

        /* ========== 步骤 1 视图：选择工作流 (左右分栏) ========== */
        <div className="flex-1 flex min-h-0 gap-4 overflow-hidden">
          {/* 左侧：工作流分类与卡片列表 */}
          <div className="flex-1 min-w-0 flex flex-col h-full overflow-y-auto pr-1 space-y-3">
            {/* 分类 Tab（首位展示“全部”） */}
            <div className="flex items-center justify-between flex-wrap gap-2 shrink-0">
              <span className="text-xs font-bold text-foreground">
                {t('全场景官方工作流矩阵库')}
              </span>

              <div className="flex items-center p-0.5 bg-muted/60 rounded-lg border border-border/60 gap-1">
                {getWorkflowCategories(workflows).map(cat => {
                  const isActive = activeCategory === cat.id
                  return (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={() => setActiveCategory(cat.id)}
                      className={cn(
                        'px-2.5 py-1 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer select-none',
                        isActive
                          ? 'bg-card text-foreground shadow-2xs border border-border'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                    >
                      <MaterialIcon icon={cat.icon} className="text-xs" />
                      <span>{cat.name}</span>
                      <span
                        className={cn(
                          'text-[10px] px-1 py-0.2 rounded-full font-mono',
                          isActive ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
                        )}
                      >
                        {cat.count}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* 工作流卡片列表 */}
            <div className="grid grid-cols-1 gap-2.5">
              {displayedWorkflows.map(wf => {
                const isSelected = selectedWorkflowId === wf.id
                const rec = scoreMap.get(wf.id)
                const IconComp = getWorkflowIconComponent(wf.id)

                return (
                  <div
                    key={wf.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      hasUserInteractedRef.current = true
                      setSelectedWorkflowId(wf.id)
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        hasUserInteractedRef.current = true
                        setSelectedWorkflowId(wf.id)
                      }
                    }}
                    className={cn(
                      'relative flex flex-col p-3 rounded-xl border text-left cursor-pointer transition-all duration-200 select-none group',
                      isSelected
                        ? 'bg-primary/5 dark:bg-primary/10 border-primary shadow-xs ring-2 ring-primary/80'
                        : 'bg-card hover:bg-muted/40 border-border/80 hover:border-border'
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div
                          className={cn(
                            'w-8 h-8 rounded-lg flex items-center justify-center transition-colors shrink-0',
                            isSelected
                              ? 'bg-primary text-primary-foreground shadow-xs'
                              : 'bg-muted text-muted-foreground group-hover:text-foreground'
                          )}
                        >
                          <IconComp className="w-4 h-4" />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <h5 className="font-bold text-xs sm:text-sm leading-snug truncate text-foreground">
                              {wf.name}
                            </h5>
                            <span className="text-[10px] font-medium text-muted-foreground bg-muted px-1.5 py-0.2 rounded">
                              {getPersonaLabels()[wf?.persona] || wf?.persona}
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        {rec && rec.score >= 60 && (
                          <span className="flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                            <Sparkles className="w-2.5 h-2.5 fill-current" />
                            <span>{rec.score}%</span>
                          </span>
                        )}
                        {isSelected ? (
                          <span className="text-primary font-bold flex items-center gap-1 text-xs">
                            <CheckCircle2 className="w-3.5 h-3.5 fill-current" />
                            <span className="hidden sm:inline">{t('已选中')}</span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground/50 group-hover:text-foreground text-[11px] transition-colors">
                            {t('选择')}
                          </span>
                        )}
                      </div>
                    </div>

                    <p className="text-xs text-muted-foreground leading-relaxed mt-1.5 line-clamp-1">
                      {rec?.matchReason || wf.summary}
                    </p>

                    {(() => {
                      const includedExts = extractWorkflowIncludedExtensions(wf)
                      const wfNamingTemplate = wf.naming_template || wf.naming_pattern
                      return (
                        <div className="mt-2 pt-1.5 border-t border-border/40 text-[11px] flex items-center justify-between text-muted-foreground gap-2">
                          <div className="min-w-0 flex items-center gap-1.5 flex-wrap">
                            <span className="font-semibold text-emerald-600 dark:text-emerald-400 shrink-0 flex items-center gap-1">
                              <Filter className="w-3 h-3 shrink-0" />
                              {t('包含扩展名:')}
                            </span>
                            {includedExts.length > 0 ? (
                              <div className="flex items-center gap-1 flex-wrap">
                                {includedExts.slice(0, 5).map(ext => (
                                  <span
                                    key={ext}
                                    className="px-1.5 py-0.2 rounded bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20 font-mono text-[10px]"
                                  >
                                    {ext}
                                  </span>
                                ))}
                                {includedExts.length > 5 && (
                                  <span className="text-[10px] font-mono text-muted-foreground">
                                    +{includedExts.length - 5}
                                  </span>
                                )}
                              </div>
                            ) : (
                              <span className="text-[11px] text-muted-foreground">
                                {t('全部受管格式')}
                              </span>
                            )}
                          </div>
                          {wfNamingTemplate && (
                            <div
                              className="truncate max-w-[140px] flex items-center gap-1 font-mono text-[10px] text-muted-foreground/70 hidden sm:flex shrink-0"
                              title={wfNamingTemplate}
                            >
                              <Tag className="w-3 h-3 text-primary/70 shrink-0" />
                              <span className="truncate">{wfNamingTemplate}</span>
                            </div>
                          )}
                        </div>
                      )
                    })()}
                  </div>
                )
              })}
            </div>

            {/* 列表底部：展开 70 套工作流切换按钮 (Ticket 04 AC-4.2) */}
            <div className="pt-2 text-center shrink-0">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setIsShowingAllWorkflows(!isShowingAllWorkflows)}
                className="w-full py-2.5 rounded-xl border border-border hover:bg-muted/40 text-xs font-semibold text-foreground flex items-center justify-center gap-2 cursor-pointer shadow-2xs"
              >
                <span>{isShowingAllWorkflows ? '▲' : '▼'}</span>
                <span>
                  {isShowingAllWorkflows
                    ? t('收起工作流列表 (仅展示推荐)')
                    : t('展示所有工作流 (共 {count} 套)', { count: workflows.length || 70 })}
                </span>
              </Button>
            </div>
          </div>

          {/* 右侧：纯函数单点原型目录树预览 (w-[330px]~w-[390px]) */}
          <div className="w-[320px] sm:w-[350px] lg:w-[380px] shrink-0 h-full flex flex-col rounded-xl border border-border/80 bg-muted/20 dark:bg-muted/10 p-3.5 overflow-hidden shadow-xs space-y-3">
            <div className="space-y-1.5 pb-2.5 border-b border-border/60 shrink-0">
              <div className="flex items-center justify-between gap-1.5">
                <div className="flex items-center gap-1.5 text-xs font-bold text-foreground truncate">
                  <FolderTree className="w-4 h-4 text-primary shrink-0" />
                  <span>{t('预期整理目录结构')}</span>
                </div>
                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20 shrink-0">
                  {getPersonaLabels()[selectedWorkflow?.persona] || selectedWorkflow?.persona}
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground leading-tight">
                {t('选用「{name}」将自动为您构建以下标准归档结构：', {
                  name: selectedWorkflow.name
                })}
              </p>
            </div>

            {/* 树状目录预览 (带命名原型) */}
            <div className="flex-1 overflow-y-auto pr-1 min-h-0 bg-card/60 rounded-lg border border-border/60 p-2.5 shadow-2xs">
              {previewTreeNodes.length > 0 ? (
                <div className="space-y-1">
                  {previewTreeNodes.map((rootNode, idx) => (
                    <PreviewTreeNodeView
                      key={`${rootNode.name}-${idx}`}
                      node={rootNode}
                      isRoot={true}
                      namingTemplate={selectedNamingTemplate}
                    />
                  ))}
                </div>
              ) : (
                <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
                  {t('暂无目录结构预览')}
                </div>
              )}
            </div>

            {/* 安全无损提示 */}
            <div className="flex items-start gap-1.5 pt-1 text-[11px] text-muted-foreground shrink-0 leading-normal">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-500 shrink-0 mt-0.5" />
              <span>
                {t('安全无损：通过虚拟标签树进行整理归档，绝不会物理移动或破坏您的原始磁盘文件。')}
              </span>
            </div>
          </div>
        </div>
    </>
  )
}
