import React from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Button } from '../ui/button'
import { t } from '@app/languages'
import { useAnalysisQueueStore } from '../../stores/analysis-queue-store'
import { useSettingsStore } from '../../stores/settings-store'
import { MaterialIcon, cn } from '../../lib/utils'
import FileList from '../file-explorer/FileList'

/** 分析模式的展示名称，与设置页 analysis-settings 保持一致 */
const ANALYSIS_MODE_LABEL: Record<string, string> = {
  simple: '标准分析',
  quick_name: '增强分析',
  full: '全面分析'
}

/**
 * analysis_stage 的权威语义：
 * 0=未分析、1=基础身份/元数据提取完成、2=CPU 内容提取完成（即标准分析完成）、
 * 3=AI 质量评分完成（增强分析）、4=维度标签与智能命名完成（全面分析）。
 *
 * 注意：标准分析模式的完成标志是 stage=2，不是 stage=1。
 */
const STAGE_LABEL: Record<number, string> = {
  0: '未分析',
  1: '基础身份提取',
  2: '标准分析',
  3: '增强分析',
  4: '全面分析'
}

/** 把 stage 数值翻译为「已完成到哪一步」的中文描述 */
const describeStage = (stage: number): string => STAGE_LABEL[stage] ?? '未分析'

/**
 * 批量分析前的确认弹窗。
 *
 * 三类文件在此弹窗中的角色：
 * - 已完成（analyzed）    ：列出并提示，默认「跳过」以避免重复消耗算力；
 * - 分析不完整（insufficient）：已分析过但未达当前模式要求，**无论选哪个操作都会入队**，
 *                              仅在此说明，避免用户误以为它们会被忽略；
 * - 完全未分析            ：不列出，仅计入总数，同样会入队。
 *
 * 弹窗触发条件是「存在任一已有分析痕迹的文件」（analyzed 或 insufficient），
 * 而非仅限于 analyzed。因此存在「所选文件全部需要补全」的形态：
 * 此时不渲染已完成列表，「跳过已完成」按钮降级为「继续分析」语义
 * —— 两者后果一致（都入队），但表述需与实际情况相符。
 *
 * ⚠️ 文案必须基于「文件实际完成模式」（completed_mode），而非当前选择的模式。
 * 因为判定采用等级覆盖口径：在【增强分析】模式下，实际完成【全面分析】的文件
 * 同样可跳过，但不能声称它们「已完成【增强分析】分析」。
 */
export function AnalysisConfirmModal() {
  const {
    showConfirmModal,
    setShowConfirmModal,
    confirmModalFiles,
    confirmModalInsufficientFiles,
    confirmModalUntouchedCount,
    pendingAddItems,
    handleConfirmSkip,
    handleConfirmReanalyze
  } = useAnalysisQueueStore()

  // 响应式读取当前分析模式，用于文案「未达到当前【全面分析】模式的要求」
  const currentMode = useSettingsStore(
    s => (s.getConfigValue<string>('ANALYSIS_MODE') as string) ?? 'quick_name'
  )
  const currentModeLabel = t(ANALYSIS_MODE_LABEL[currentMode] || '增强分析')

  const totalCount = pendingAddItems.length
  const analyzedCount = confirmModalFiles.length
  const insufficientCount = confirmModalInsufficientFiles.length
  // 本次「跳过已完成」实际会入队的文件数（分析不完整 + 完全未分析）
  const willAnalyzeOnSkip = totalCount - analyzedCount

  /**
   * 按「文件实际完成分析所用模式」对可跳过文件分组。
   *
   * 为什么不能直接用当前模式：判定采用「等级覆盖」口径 —— 高级模式的产物
   * 对低级模式同样有效。因此在【增强分析】模式下，那批实际完成【全面分析】
   * 的文件也会被列为可跳过。若统一套用当前模式文案，就会显示成
   * 「已完成【增强分析】分析」，与文件的真实状态不符，用户会以为结果被降级。
   */
  const analyzedModeGroups = React.useMemo(() => {
    const counts = new Map<string, number>()
    for (const f of confirmModalFiles) {
      const mode = String((f as any).completedMode ?? '')
      counts.set(mode, (counts.get(mode) ?? 0) + 1)
    }
    // 按能力等级从高到低排序，让「更完整的结果」优先展示
    const order = ['full', 'quick_name', 'simple']
    return Array.from(counts.entries())
      .map(([mode, count]) => ({ mode, count }))
      .sort((a, b) => {
        const ai = order.indexOf(a.mode)
        const bi = order.indexOf(b.mode)
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
      })
  }, [confirmModalFiles])

  /** 把 completed_mode 取值转为展示文案，历史数据（null）退回按 stage 推断的通用表述 */
  const modeLabelOf = (mode: string): string =>
    ANALYSIS_MODE_LABEL[mode] ? t(ANALYSIS_MODE_LABEL[mode]) : t('分析')

  const mappedFiles = React.useMemo(() => {
    return confirmModalFiles.map((file, index) => {
      // 提取 parentPath
      const match = file.path.match(/^(.*)[/\\][^/\\]+$/)
      const parentPath = match ? match[1] : ''
      return {
        id: `confirm-file-${index}`,
        name: file.name,
        smartName: (file as any).smartName,
        path: file.path,
        parentPath,
        size: file.size,
        extension: file.type || '',
        modifiedAt: new Date(),
        isAnalyzed: true,
        qualityScore: (file as any).qualityScore,
        description: (file as any).description,
        tags: (file as any).tags,
        author: (file as any).author,
        language: (file as any).language
      }
    })
  }, [confirmModalFiles])

  /**
   * 「分析不完整」文件已完成到哪一步的汇总。
   *
   * 优先使用文件记录的 completed_mode（真实完成模式），仅当缺失时
   * （历史数据 / 中间态）才退回按 analysis_stage 推断阶段描述。
   *
   * 为什么必须优先用 completed_mode：stage 无法区分 quick_name 与 full
   * ——两者终态都是 4。若只用 stage，那批以【增强分析】完成、在【全面分析】
   * 模式下待补全的文件会被描述成「仅完成【全面分析】」，
   * 紧接着又说「尚未达到【全面分析】模式的要求」，自相矛盾。
   */
  const insufficientDoneLabel = React.useMemo(() => {
    const modeCounts = new Map<string, number>()
    let stageOnlyCount = 0
    for (const f of confirmModalInsufficientFiles) {
      const mode = String((f as any).completedMode ?? '')
      if (ANALYSIS_MODE_LABEL[mode]) {
        modeCounts.set(mode, (modeCounts.get(mode) ?? 0) + 1)
      } else {
        stageOnlyCount++
      }
    }

    const parts: string[] = []
    // 按能力等级从高到低
    for (const mode of ['full', 'quick_name', 'simple']) {
      if (modeCounts.has(mode)) parts.push(modeLabelOf(mode))
    }
    if (stageOnlyCount > 0) {
      // 无 completed_mode 的历史数据：按 stage 描述，取最高阶段作为代表
      const stages = new Set<number>()
      for (const f of confirmModalInsufficientFiles) {
        const mode = String((f as any).completedMode ?? '')
        if (ANALYSIS_MODE_LABEL[mode]) continue
        const stage = Number((f as any).analysisStage ?? 0)
        if (stage > 0) stages.add(stage)
      }
      const topStage = Math.max(...Array.from(stages), 0)
      parts.push(t(describeStage(topStage)))
    }
    return parts.length > 0 ? parts.join(' / ') : t('基础身份提取')
  }, [confirmModalInsufficientFiles, modeLabelOf])

  return (
    <Dialog open={showConfirmModal} onOpenChange={setShowConfirmModal}>
      <DialogContent className="max-w-[760px] max-h-[85vh] flex flex-col p-6 rounded-xl">
        <DialogHeader className="mb-2 flex-shrink-0">
          <DialogTitle className="text-lg font-bold text-foreground">
            {t('确认分析范围')}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="text-sm text-muted-foreground mt-1 space-y-1.5 leading-relaxed">
              {/* 总览：让用户清楚三种状态各有多少，不产生「会不会漏掉」的疑虑 */}
              <p>
                {t('已选择 {total} 个文件。', { total: totalCount })}
                {confirmModalUntouchedCount > 0 &&
                  ' ' +
                    t('其中 {count} 个完全未分析，将直接加入分析列表。', {
                      count: confirmModalUntouchedCount
                    })}
              </p>
              {/* 按文件「实际使用的模式」逐条列出，而非统一套用当前模式。
                  例如当前是【增强分析】，其中一批文件实际完成的是【全面分析】，
                  它们因等级覆盖而同样可跳过，但必须如实说明其真实完成模式。 */}
              {analyzedModeGroups.map(group => (
                <p key={group.mode} className="flex items-start gap-1.5">
                  <MaterialIcon
                    icon="check_circle"
                    className="text-sm mt-0.5 shrink-0 text-primary/70"
                  />
                  <span>
                    {ANALYSIS_MODE_LABEL[group.mode]
                      ? t('{count} 个已完成【{mode}】分析，无需重复分析。', {
                          count: group.count,
                          mode: modeLabelOf(group.mode)
                        })
                      : t('{count} 个已完成分析（历史数据未记录模式），无需重复分析。', {
                          count: group.count
                        })}
                  </span>
                </p>
              ))}
              {insufficientCount > 0 && (
                <p className="flex items-start gap-1.5">
                  <MaterialIcon
                    icon="pending"
                    className="text-sm mt-0.5 shrink-0 text-amber-500 dark:text-amber-400"
                  />
                  <span>
                    {t(
                      '{count} 个仅完成【{done}】，尚未达到当前【{current}】模式的要求，将一并加入分析列表。',
                      {
                        count: insufficientCount,
                        done: insufficientDoneLabel,
                        current: currentModeLabel
                      }
                    )}
                  </span>
                </p>
              )}
            </div>
          </DialogDescription>
        </DialogHeader>

        {/* 已完成文件列表 — 复用标准 FileList 呈现（智能文件名 + 原文件名双名称展示）
            仅在存在「可跳过」的文件时渲染；否则整块列表为空，纯属视觉噪音 */}
        {analyzedCount > 0 && (
          <div className="flex flex-col min-h-0 flex-1 gap-2">
            <div className="flex items-center justify-between text-xs shrink-0">
              {/* 单一模式且模式已记录时直接写明模式；多模式混合时用中性表述，避免误导 */}
              <span className="font-medium text-foreground">
                {analyzedModeGroups.length === 1 && ANALYSIS_MODE_LABEL[analyzedModeGroups[0].mode]
                  ? t('已完成【{mode}】分析的文件，本次将跳过', {
                      mode: modeLabelOf(analyzedModeGroups[0].mode)
                    })
                  : t('已完成分析的文件（均已满足当前模式要求），本次将跳过')}
              </span>
              <span className="text-muted-foreground">
                {t('{count} 个', { count: analyzedCount })}
              </span>
            </div>
            <div className="flex-1 h-[300px] min-h-[240px] border border-border/80 rounded-lg overflow-auto relative bg-muted/20">
              <FileList
                files={mappedFiles}
                directories={[]}
                selectedFiles={[]}
                onFileSelect={() => {}}
                onDirectoryChange={() => {}}
                currentPath=""
                viewMode="list"
                showAnalysisStatus={false}
                selectionEnabled={false}
                isRealDirectory={false}
                forceShowAllFields={true}
                showsmartName={true}
              />
            </div>
          </div>
        )}

        {/* 两种选择的实际结果说明，消除歧义 */}
        <div className="mt-3 shrink-0 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 space-y-1">
          <div className="flex items-start gap-2 text-xs">
            <MaterialIcon icon="skip_next" className="text-sm mt-px shrink-0 text-muted-foreground" />
            <span className="text-muted-foreground">
              {analyzedCount > 0
                ? t('跳过：将这 {skipped} 个已完成文件排除，仅分析其余 {rest} 个文件，不再消耗算力。', {
                    skipped: analyzedCount,
                    rest: willAnalyzeOnSkip
                  })
                : t('继续：按当前分析模式补全这 {rest} 个文件，已完成的部分不会重复提取。', {
                    rest: willAnalyzeOnSkip
                  })}
            </span>
          </div>
          <div className="flex items-start gap-2 text-xs">
            <MaterialIcon icon="refresh" className="text-sm mt-px shrink-0 text-muted-foreground" />
            <span className="text-muted-foreground">
              {t('重新分析：全部 {total} 个文件强制重新分析（例如更换模型后需要按新模型重跑）。', {
                total: totalCount
              })}
            </span>
          </div>
        </div>

        <DialogFooter className="mt-4 gap-2 flex-col sm:flex-row sm:justify-end">
          <Button
            variant="outline"
            onClick={() => setShowConfirmModal(false)}
            className="w-full sm:w-auto"
          >
            {t('取消')}
          </Button>
          {/* 次要动作：全部重跑（用户主动选择，非默认） */}
          <Button
            variant="secondary"
            onClick={handleConfirmReanalyze}
            className="w-full sm:w-auto border border-border bg-secondary hover:bg-secondary/80 text-secondary-foreground"
          >
            {totalCount > 0
              ? t('全部重新分析 ({count})', { count: totalCount })
              : t('全部重新分析')}
          </Button>
          {/* 主要动作：跳过已完成，符合「默认不重复消耗算力」的预期。
              无可跳过文件时（所选文件全部需要补全），降级为「继续分析」语义 */}
          <Button
            variant="default"
            onClick={handleConfirmSkip}
            disabled={willAnalyzeOnSkip === 0}
            className={cn(
              'w-full sm:w-auto bg-primary text-primary-foreground hover:bg-primary/90',
              willAnalyzeOnSkip === 0 && 'opacity-50'
            )}
          >
            {willAnalyzeOnSkip === 0
              ? t('跳过已完成')
              : analyzedCount > 0
                ? t('跳过已完成，分析其余 {count} 个', { count: willAnalyzeOnSkip })
                : t('继续分析 {count} 个文件（保留已完成部分）', { count: willAnalyzeOnSkip })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
