import React from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { Button } from '../../../ui/button'
import { t } from '@app/languages'
import { getWorkflowIconComponent, getPersonaLabels } from './helpers'
import type { CurrentWhitelist, FileImpactStats } from './types'

interface RuleConfirmationStepProps {
  selectedWorkflow: any
  selectedTemplateConfig: any
  currentWhitelist: CurrentWhitelist
  fileImpactStats: FileImpactStats
  currentCustomExcludeRules: string[]
  setCurrentStep: Dispatch<SetStateAction<1 | 2>>
}

export const RuleConfirmationStep = ({
  selectedWorkflow,
  selectedTemplateConfig,
  currentWhitelist,
  fileImpactStats,
  currentCustomExcludeRules,
  setCurrentStep
}: RuleConfirmationStepProps) => {
  return (
    <>
        /* ========== 步骤 2 视图：包含与排除规则确认 (大白话版) ========== */
        <div className="flex-1 flex flex-col overflow-y-auto pr-1 space-y-4">
          {/* 选定工作流横幅标头 */}
          <div className="bg-card border border-border rounded-xl p-4 flex items-center justify-between shadow-2xs shrink-0">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
                {React.createElement(getWorkflowIconComponent(selectedWorkflow.id), {
                  className: 'w-5 h-5'
                })}
              </div>
              <div className="min-w-0 space-y-0.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <h4 className="text-base font-bold text-foreground">{selectedWorkflow.name}</h4>
                  <span className="text-xs px-2 py-0.5 rounded bg-primary/10 text-primary font-semibold">
                    {getPersonaLabels()[selectedWorkflow?.persona] || selectedWorkflow?.persona}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground truncate">{selectedWorkflow.summary}</p>
              </div>
            </div>

            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setCurrentStep(1)}
              className="text-xs font-semibold text-primary hover:underline cursor-pointer shrink-0"
            >
              {t('更换其他工作流')}
            </Button>
          </div>

          {/* 核心板块 1：大白话「包含」卡片 (实测命中数计算) */}
          <div className="bg-emerald-500/[0.04] dark:bg-emerald-500/[0.08] border border-emerald-500/30 rounded-xl p-4 space-y-2.5 shrink-0">
            <div className="flex items-center gap-2.5">
              <span className="w-6 h-6 rounded-md bg-emerald-600 text-white flex items-center justify-center text-xs font-bold">
                ✓
              </span>
              <div className="flex items-center gap-2">
                <h4 className="text-sm font-bold text-emerald-700 dark:text-emerald-400">
                  {t('包含')}
                </h4>
                <span className="text-xs font-semibold text-emerald-700/80 dark:text-emerald-300/80">
                  {t('以下文件才会显示在工作目录中')}
                </span>
              </div>
            </div>

            {/* 实测命中数描述 (Ticket 04 AC-4.3) */}
            <div className="text-xs font-medium text-emerald-800 dark:text-emerald-200 bg-emerald-500/10 p-2 rounded-lg border border-emerald-500/20">
              {fileImpactStats.description}
            </div>

            {/* 纳管扩展名徽章列表 */}
            {currentWhitelist.labels.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {currentWhitelist.labels.map((rule, idx) => (
                  <span
                    key={idx}
                    className="px-2.5 py-1 rounded-md text-xs font-mono font-bold bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30"
                  >
                    {rule}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* 核心板块 2：大白话专属「排除」卡片 (无专属排除时整块 DOM 彻底隐藏 toBeNull) */}
          {currentCustomExcludeRules.length > 0 && (
            <div
              id="section-exclude"
              className="bg-amber-500/[0.04] dark:bg-amber-500/[0.08] border border-amber-500/30 rounded-xl p-4 space-y-2.5 shrink-0"
            >
              <div className="flex items-center gap-2.5">
                <span className="w-6 h-6 rounded-md bg-amber-600 text-white flex items-center justify-center text-xs font-bold">
                  ✕
                </span>
                <div className="flex items-center gap-2">
                  <h4 className="text-sm font-bold text-amber-700 dark:text-amber-400">
                    {t('排除')}
                  </h4>
                  <span className="text-xs font-medium text-amber-700/80 dark:text-amber-300/80">
                    {t('当前工作区专属排除目录与规则')}
                  </span>
                </div>
              </div>

              <div className="flex flex-wrap gap-1.5 pt-1">
                {currentCustomExcludeRules.map((rule, idx) => (
                  <span
                    key={idx}
                    className="px-2.5 py-1 rounded-md text-xs font-mono font-bold bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/30"
                  >
                    {rule}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* 核心板块 3：检索式引擎与智能规范化命名格式 (全大白话规范) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 shrink-0">
            <div className="bg-card border border-border rounded-xl p-3.5 space-y-2">
              <div className="text-xs font-bold text-foreground flex items-center gap-1.5">
                <span>⚡ {t('检索式引擎')}</span>
              </div>
              <div className="text-xs text-muted-foreground space-y-1.5">
                <div className="flex justify-between items-center">
                  <span>{t('处理模式：')}</span>
                  <span className="font-semibold text-foreground">
                    {selectedWorkflow.analysis_mode === 'deep'
                      ? t('全景多模态深度解析')
                      : t('快速智能命名与轻量归档')}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span>{t('索引级别：')}</span>
                  <span className="font-semibold text-foreground">{t('标准轻量级检索底座')}</span>
                </div>
              </div>
            </div>

            <div className="bg-card border border-border rounded-xl p-3.5 space-y-2">
              <div className="text-xs font-bold text-foreground flex items-center gap-1.5">
                <span>🏷️ {t('智能规范化命名格式')}</span>
              </div>
              <div className="bg-muted/60 p-2 rounded-lg font-mono text-xs text-primary font-bold truncate">
                {selectedWorkflow.naming_template ||
                  selectedTemplateConfig?.namingTemplate ||
                  '{YYYYMMDD}_{SceneType}_{FileName}.{ext}'}
              </div>
              <p className="text-[11px] text-muted-foreground">
                {t('整理时自动按此规律展示，原始磁盘文件名绝不受破坏。')}
              </p>
            </div>
          </div>

          {/* 醒目温馨通知：引导按需微调 */}
          <div className="bg-primary/[0.05] border border-primary/20 rounded-xl p-3.5 flex items-start gap-3 shrink-0">
            <span className="text-base">💡</span>
            <div className="space-y-1 text-xs">
              <div className="font-bold text-foreground">{t('随时支持按需微调')}</div>
              <p className="text-muted-foreground leading-relaxed">
                {t(
                  '以上是系统为您预先搭配的推荐配置。启动后，您可随时在「工作目录设置 ➔ 文件准入与包含排除」中任意添加其他文件扩展名、修改排除规则，或在「检索式引擎」中调整分析深度。'
                )}
              </p>
            </div>
          </div>
        </div>
    </>
  )
}
