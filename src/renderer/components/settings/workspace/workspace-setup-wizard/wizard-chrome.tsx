import { Button } from '../../../ui/button'
import { cn } from '../../../../lib/utils'
import { t } from '@app/languages'
import {
  AlertCircle,
  RefreshCw,
  Copy,
  X,
  ArrowLeft,
  ArrowRight,
  Loader2,
  Check
} from 'lucide-react'
import type { Dispatch, SetStateAction } from 'react'
import type {
  DirectoryDistribution,
  DirectoryProfileResult,
  PolicyCommitErrorState
} from './types'

interface WizardHeaderProps {
  currentStep: 1 | 2
  setCurrentStep: Dispatch<SetStateAction<1 | 2>>
}

export const WizardHeader = ({ currentStep, setCurrentStep }: WizardHeaderProps) => {
  return (
    <>
      {/* 顶部指示导航与步骤进度条 */}
      <div className="flex items-center justify-between flex-wrap gap-2 pb-2 border-b border-border/60 shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center font-bold text-xs shadow-2xs">
            FF
          </div>
          <div>
            <h3 className="text-base sm:text-lg font-bold text-foreground flex items-center gap-2">
              <span>{t('工作目录工作流向导')}</span>
            </h3>
            <p className="text-xs text-muted-foreground">
              {t('智能感知目录生态，自动化装配专属虚拟归档管道')}
            </p>
          </div>
        </div>

        {/* 步骤胶囊指示器 */}
        <div className="flex items-center gap-2 text-xs font-semibold">
          <div
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-full transition-all cursor-pointer',
              currentStep === 1
                ? 'bg-primary text-primary-foreground shadow-xs'
                : 'bg-emerald-600 text-white shadow-2xs'
            )}
            onClick={() => setCurrentStep(1)}
          >
            <span className="w-4 h-4 rounded-full bg-white/20 flex items-center justify-center text-[10px]">
              1
            </span>
            <span>{t('选择工作流')}</span>
          </div>
          <div className="w-6 h-0.5 bg-border/80" />
          <div
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-full transition-all',
              currentStep === 2
                ? 'bg-primary text-primary-foreground shadow-xs'
                : 'bg-muted text-muted-foreground'
            )}
          >
            <span className="w-4 h-4 rounded-full bg-black/10 dark:bg-white/10 flex items-center justify-center text-[10px]">
              2
            </span>
            <span>{t('包含与排除规则确认')}</span>
          </div>
        </div>
      </div>
    </>
  )
}

interface CommitErrorBannerProps {
  commitError: PolicyCommitErrorState | null
  submitPolicy: (flowMode: 'complete' | 'customize') => Promise<void>
  copyErrorDetails: () => void
  setCommitError: Dispatch<SetStateAction<PolicyCommitErrorState | null>>
}

export const CommitErrorBanner = ({
  commitError,
  submitPolicy,
  copyErrorDetails,
  setCommitError
}: CommitErrorBannerProps) => {
  return (
    <>
      {/* 页内常驻错误条 (当提交遇到 STORAGE / PERMISSION / CONFLICT / UNKNOWN 故障时触发) */}
      {commitError && (
        <div className="p-3 rounded-xl border border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300 flex items-start justify-between gap-3 shrink-0 shadow-2xs animate-in fade-in">
          <div className="flex items-start gap-2.5 min-w-0">
            <AlertCircle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
            <div className="space-y-0.5 min-w-0 text-xs">
              <div className="font-bold flex items-center gap-2">
                <span>{t('策略保存失败')}</span>
                <span className="px-1.5 py-0.2 rounded font-mono text-[10px] bg-rose-500/20 text-rose-800 dark:text-rose-200">
                  {commitError.code}
                </span>
              </div>
              <p className="truncate text-rose-600 dark:text-rose-300">{commitError.message}</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => submitPolicy('complete')}
              className="h-7 text-xs px-2.5 border-rose-300 text-rose-700 hover:bg-rose-100 dark:border-rose-800 dark:text-rose-300"
            >
              <RefreshCw className="w-3 h-3 mr-1" />
              <span>{t('重试保存')}</span>
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={copyErrorDetails}
              className="h-7 text-xs px-2 text-rose-700 hover:bg-rose-100 dark:text-rose-300"
              title={t('复制错误诊断信息')}
            >
              <Copy className="w-3 h-3" />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setCommitError(null)}
              className="h-7 w-7 p-0 text-rose-700 hover:bg-rose-100 dark:text-rose-300"
              title={t('留在当前页')}
            >
              <X className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      )}
    </>
  )
}

interface DirectoryDistributionPanelProps {
  distribution: DirectoryDistribution | null
  profileResult: DirectoryProfileResult | null
  isProbing: boolean
}

export const DirectoryDistributionPanel = ({
  distribution,
  profileResult,
  isProbing
}: DirectoryDistributionPanelProps) => {
  return (
    <>
      {/* 全局常驻顶部：当前目录文件构成特征 (第 1、2 步全局常驻显示) */}
      <div className="rounded-xl border border-border/80 bg-gradient-to-br from-card via-card to-muted/20 p-3 shadow-xs shrink-0 space-y-2">
        <div className="flex items-center justify-between flex-wrap gap-2 text-xs">
          <div className="flex items-center gap-2 font-semibold text-foreground">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span>{t('当前目录文件构成特征')}</span>
            {distribution && (
              <span className="text-muted-foreground font-normal">
                ({t('抽样 {count} 个文件', { count: distribution.totalSampled })}
                {profileResult?.stats.durationMs ? ` · ${profileResult.stats.durationMs}ms` : ''})
              </span>
            )}
          </div>

          <div className="text-[11px] text-emerald-600 dark:text-emerald-400 font-semibold flex items-center gap-1">
            {isProbing ? (
              <>
                <Loader2 className="w-3 h-3 animate-spin text-primary" />
                <span>{t('正在深度扫描目录文件特征...')}</span>
              </>
            ) : profileResult?.stats?.totalSampled === 0 ? (
              <span className="text-muted-foreground font-normal">
                {t('空目录 (未检测到文件)')}
              </span>
            ) : (
              <>
                <Check className="w-3.5 h-3.5" />
                <span>{t('已完成多维画像嗅探')}</span>
              </>
            )}
          </div>
        </div>

        {/* 动态多维细分比例条 */}
        {distribution ? (
          <div className="space-y-2">
            <div className="h-2 w-full rounded-full overflow-hidden flex bg-muted/60">
              {distribution.segments.map(seg => (
                <div
                  key={seg.key}
                  style={{ width: `${seg.widthPct}%` }}
                  className={cn(seg.colorClass, 'transition-all duration-500')}
                  title={`${seg.label}: ${seg.pct}%`}
                />
              ))}
            </div>

            {/* 细分类图例占比药丸 */}
            <div className="flex items-center gap-3 sm:gap-4 flex-wrap text-[11px]">
              {distribution.segments.map(seg => {
                const SegIcon = seg.Icon
                return (
                  <span key={seg.key} className="flex items-center gap-1 text-muted-foreground">
                    <span className={cn('w-2 h-2 rounded-full', seg.colorClass)} />
                    <SegIcon className={cn('w-3 h-3', seg.textClass)} />
                    <span className="font-medium text-foreground/90">{seg.label}</span>
                    <span>{seg.pct}%</span>
                  </span>
                )
              })}
            </div>
          </div>
        ) : isProbing ? (
          <div className="text-xs text-muted-foreground flex items-center gap-2 py-1">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
            <span>{t('正在统计文件构成以推断最佳算力模型...')}</span>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground py-1">
            <span>{t('当前目录为空，放入文件后将自动分类整理')}</span>
          </div>
        )}
      </div>
    </>
  )
}

interface WizardFooterProps {
  currentStep: 1 | 2
  selectedWorkflow: any
  selectedWorkflowId: string
  top1Recommendation: any | null
  isSaving: boolean
  onSkip?: () => void
  submitPolicy: (flowMode: 'complete' | 'customize') => Promise<void>
  setSelectedWorkflowId: Dispatch<SetStateAction<string>>
  setCurrentStep: Dispatch<SetStateAction<1 | 2>>
}

export const WizardFooter = ({
  currentStep,
  selectedWorkflow,
  selectedWorkflowId,
  top1Recommendation,
  isSaving,
  onSkip,
  submitPolicy,
  setSelectedWorkflowId,
  setCurrentStep
}: WizardFooterProps) => {
  return (
    <>
      {/* ================= 底部操作栏 (双强主出口) ================= */}
      <div className="pt-3 border-t border-border flex flex-col sm:flex-row items-center justify-between gap-3 shrink-0">
        <div>
          {currentStep === 1 ? (
            <span className="text-xs text-muted-foreground">
              {t('已选定工作流:')}{' '}
              <strong className="text-foreground">{selectedWorkflow.name}</strong>
            </span>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setCurrentStep(1)}
              className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-border text-foreground hover:bg-muted/50 cursor-pointer"
            >
              <ArrowLeft className="w-3.5 h-3.5 mr-1" />
              <span>{t('上一步：重选工作流')}</span>
            </Button>
          )}
        </div>

        <div className="flex items-center gap-2.5 w-full sm:w-auto justify-end">
          {/* 跳过向导按钮每步仅渲染一个：Step 1 用此处通用按钮，Step 2 在下方双出口分支内渲染 skip-wizard-btn-step2 */}
          {onSkip && currentStep === 1 && (
            <Button
              type="button"
              variant="ghost"
              size="default"
              onClick={onSkip}
              data-testid="skip-wizard-btn"
              className="w-full sm:w-auto flex items-center justify-center gap-1.5 text-xs font-semibold px-3 text-muted-foreground hover:text-foreground h-9"
            >
              <span>{t('跳过向导')}</span>
            </Button>
          )}
          {currentStep === 1 ? (
            <Button
              type="button"
              variant="default"
              size="default"
              disabled={!selectedWorkflowId && !top1Recommendation}
              onClick={() => {
                if (!selectedWorkflowId && top1Recommendation) {
                  setSelectedWorkflowId(top1Recommendation.id)
                }
                setCurrentStep(2)
              }}
              className="w-full sm:w-auto flex items-center justify-center gap-2 text-xs font-bold px-5 bg-primary text-primary-foreground hover:bg-primary/90 h-9 shadow-xs"
            >
              <span>{t('下一步')}</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </Button>
          ) : (
            /* 步骤 2 并行双强主出口 (Ticket 04 AC-4.6) */
            <div className="flex items-center gap-2.5 w-full sm:w-auto">
              {onSkip && (
                <Button
                  type="button"
                  variant="ghost"
                  size="default"
                  onClick={onSkip}
                  data-testid="skip-wizard-btn-step2"
                  className="w-full sm:w-auto flex items-center justify-center gap-1.5 text-xs font-semibold px-3 text-muted-foreground hover:text-foreground h-9"
                >
                  <span>{t('跳过向导')}</span>
                </Button>
              )}

              {/* 出口 1：个性化微调工作目录配置 (高亮边框强调；悬停沿用主题主色文字与浅底，规避暗色模式下 --primary-foreground 深黑对比度失真) */}
              <Button
                type="button"
                variant="outline"
                size="default"
                disabled={isSaving}
                onClick={() => submitPolicy('customize')}
                className="w-full sm:w-auto flex items-center justify-center gap-1.5 text-xs font-bold px-4 border-2 border-primary text-primary hover:bg-primary/10 hover:text-primary hover:border-primary dark:hover:bg-primary/20 dark:hover:text-primary dark:hover:border-primary h-9 shadow-xs transition-all"
              >
                {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <span>⚙️</span>}
                <span>{t('个性化微调工作目录配置')}</span>
              </Button>

              {/* 出口 2：立即应用并进入工作目录 (主色按钮) */}
              <Button
                type="button"
                variant="default"
                size="default"
                disabled={isSaving}
                onClick={() => submitPolicy('complete')}
                className="w-full sm:w-auto flex items-center justify-center gap-1.5 text-xs font-bold px-5 bg-emerald-600 hover:bg-emerald-700 text-white h-9 shadow-xs transition-all"
              >
                {isSaving ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Check className="w-3.5 h-3.5" />
                )}
                <span>{t('立即应用并进入工作目录')}</span>
              </Button>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
