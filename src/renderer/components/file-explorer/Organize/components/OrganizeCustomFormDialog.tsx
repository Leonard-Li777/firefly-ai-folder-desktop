import React, { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../../../ui/dialog'
import { Button } from '../../../ui/button'
import { Input } from '../../../ui/input'
import { Textarea } from '../../../ui/textarea'
import { MaterialIcon, cn } from '../../../../lib/utils'
import { t } from '@app/languages'
import { extractVirtualDirName, parseStrategyToTree } from '../utils/helpers'
import { OrganizeMode } from '../types'

interface OrganizeCustomFormDialogProps {
  open: boolean
  onClose: () => void
  onSubmit: (name: string, strategy: string, mode?: OrganizeMode) => void
  initialName?: string
  initialStrategy?: string
  workspacePath?: string
  targetMode?: OrganizeMode
}

const DEFAULT_STRATEGY = `以办公文员视角，按以下目录结构整理文档：

- 办公文档
  - 行政人事
    - 考勤记录
    - 请假审批
    - 员工档案
  - 财务报表
    - 月度报表
    - 预算审批
    - 发票管理
  - 合同协议
    - 采购合同
    - 服务协议
    - 保密协议
  - 会议纪要
    - 周会记录
    - 项目评审
    - 年度总结`

export const OrganizeCustomFormDialog: React.FC<OrganizeCustomFormDialogProps> = ({
  open,
  onClose,
  onSubmit,
  initialName = '',
  initialStrategy = '',
  workspacePath,
  targetMode = 'fast-organize'
}) => {
  const [name, setName] = useState(initialName)
  const [strategy, setStrategy] = useState(initialStrategy)
  const [isDirty, setIsDirty] = useState(false)

  const isExternalAiMode = targetMode === 'external-ai'
  const isFastMode = targetMode === 'fast-organize'

  const defaultFallbackName = workspacePath
    ? `${workspacePath.replace(/[/\\]$/, '').split(/[/\\]/).pop() || ''} ${t('整理方案')}`
    : t('自定义整理方案')

  useEffect(() => {
    if (open) {
      if (isExternalAiMode) {
        // 外部 AI 模式导入时，不沿用工作区旧任务的历史缓存名称
        setName(initialName || '')
        if (initialStrategy) {
          const { name: extractedName, cleanStrategy } = extractVirtualDirName(initialStrategy)
          if (extractedName && !initialName) {
            setName(extractedName)
          }
          setStrategy(cleanStrategy || initialStrategy)
          setIsDirty(true)
        } else {
          setStrategy('')
          setIsDirty(false)
        }
      } else if (workspacePath) {
        const savedName = localStorage.getItem(`organize_custom_name_${workspacePath}`)
        const savedStrategy = localStorage.getItem(`organize_custom_strategy_${workspacePath}`)
        setName(savedName || initialName || defaultFallbackName)
        if (savedStrategy || initialStrategy) {
          setStrategy(savedStrategy || initialStrategy)
          setIsDirty(true)
        } else {
          setStrategy('')
          setIsDirty(false)
        }
      } else {
        setName(initialName || defaultFallbackName)
        if (initialStrategy) {
          setStrategy(initialStrategy)
          setIsDirty(true)
        } else {
          setStrategy('')
          setIsDirty(false)
        }
      }
    }
  }, [open, initialName, initialStrategy, workspacePath, isExternalAiMode, defaultFallbackName])

  const handleStrategyChange = (newVal: string) => {
    setIsDirty(true)
    const { name: extractedName, cleanStrategy } = extractVirtualDirName(newVal)
    if (extractedName) {
      // 自动提取首行虚拟目录名填入输入框
      setName(extractedName)
      setStrategy(cleanStrategy)
    } else {
      setStrategy(newVal)
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    let finalStrategy = isExternalAiMode
      ? strategy.trim()
      : isDirty
        ? strategy.trim()
        : DEFAULT_STRATEGY.trim()
    if (!finalStrategy) return

    const { name: extractedName, cleanStrategy } = extractVirtualDirName(finalStrategy)
    if (extractedName && !name.trim()) {
      setName(extractedName)
    }
    if (cleanStrategy) {
      finalStrategy = cleanStrategy
    }

    let finalName = name.trim() || extractedName || ''
    if (!finalName) {
      // 动态兜底：若只有单一根目录则取该根目录名，若为多顶级分类并列结构则取工作区名兜底
      const parsedTree = parseStrategyToTree(finalStrategy)
      if (parsedTree && parsedTree.length === 1 && parsedTree[0].name) {
        finalName = parsedTree[0].name
      } else if (workspacePath) {
        finalName = defaultFallbackName
      } else if (parsedTree && parsedTree.length > 0 && parsedTree[0].name) {
        finalName = parsedTree[0].name
      } else {
        finalName = t('自定义整理方案')
      }
    }

    onSubmit(finalName, finalStrategy, targetMode)
    // 保存到 localStorage（仅非 external-ai 时保存通用缓存，防脏数据污染）
    if (workspacePath && !isExternalAiMode) {
      localStorage.setItem(`organize_custom_name_${workspacePath}`, finalName)
      localStorage.setItem(`organize_custom_strategy_${workspacePath}`, finalStrategy)
    }
    setName('')
    setStrategy('')
    setIsDirty(false)
    onClose()
  }

  const handleReset = () => {
    setName(initialName || defaultFallbackName)
    setStrategy(DEFAULT_STRATEGY)
    setIsDirty(false)
    if (workspacePath && !isExternalAiMode) {
      localStorage.removeItem(`organize_custom_name_${workspacePath}`)
      localStorage.removeItem(`organize_custom_strategy_${workspacePath}`)
    }
  }

  const currentStrategy = isExternalAiMode
    ? strategy.trim()
    : isDirty
      ? strategy.trim()
      : DEFAULT_STRATEGY.trim()
  const canSubmit = Boolean(currentStrategy)

  return (
    <Dialog open={open} onOpenChange={(val: boolean) => !val && onClose()}>
      <DialogContent className="sm:max-w-2xl p-0 overflow-hidden rounded-2xl border-border/60 shadow-2xl bg-card">
        <div className="p-6 pb-4 border-b border-border/40 bg-muted/20 relative">
          <div className="absolute top-0 right-0 p-6 text-primary/10 select-none pointer-events-none">
            <MaterialIcon icon="edit_note" className="text-7xl" />
          </div>
          <DialogHeader className="relative z-10">
            <div className="flex items-center gap-3">
              <div
                className={cn(
                  'p-2.5 rounded-xl',
                  isExternalAiMode
                    ? 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400'
                    : 'bg-primary/10 text-primary'
                )}
              >
                <MaterialIcon
                  icon={isExternalAiMode ? 'travel_explore' : 'settings_suggest'}
                  className="text-xl"
                />
              </div>
              <div>
                <DialogTitle className="text-lg font-bold tracking-tight flex items-center gap-2">
                  <span>
                    {isExternalAiMode
                      ? t('导入外部AI生成的目录结构')
                      : isFastMode
                        ? t('快速整理自定义目录树')
                        : t('精细整理自定义目录树')}
                  </span>
                  <span
                    className={cn(
                      'text-xs font-semibold px-2 py-0.5 rounded-full border',
                      isExternalAiMode
                        ? 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-cyan-500/20'
                        : isFastMode
                          ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20'
                          : 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20'
                    )}
                  >
                    {isExternalAiMode
                      ? t('外部AI生成')
                      : isFastMode
                        ? t('快速整理模式')
                        : t('精细整理模式')}
                  </span>
                </DialogTitle>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {isExternalAiMode
                    ? t('粘贴外部AI生成的目录树，首行可附带【虚拟目录名称：xxxx】自动识别')
                    : isFastMode
                      ? t('贴入外部AI生成的目录树，通过高频特征直接完成极速归类')
                      : t('贴入外部AI生成的目录树，后续将结合模型进行深度语义推理归类')}
                </p>
              </div>
            </div>
          </DialogHeader>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          <div className="space-y-2">
            <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <span>{t('虚拟目录名')}</span>
              <span className="text-destructive font-bold">*</span>
            </label>
            <Input
              value={name}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
              placeholder={t('例：办公文员视角、行政综合、研发项目')}
              className="h-11 rounded-xl border-border/60 bg-background/50 focus-visible:ring-primary focus-visible:border-primary placeholder:text-muted-foreground/50 transition-all font-medium"
            />
            <p className="text-[11px] text-muted-foreground/75 px-0.5">
              {t('此名称将作为最终物理文件夹的名字')}
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider">
              {t('整理策略与目录树')}
            </label>
            <Textarea
              value={isExternalAiMode ? strategy : (isDirty ? strategy : DEFAULT_STRATEGY)}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                handleStrategyChange(e.target.value)
              }
              placeholder={
                isExternalAiMode
                  ? t('请直接粘贴外部AI生成的目录树，首行可写：虚拟目录名称：xxxx')
                  : t('请直接给出目录树结构和文件归类策略')
              }
              rows={12}
              className="rounded-xl border-border/60 bg-background/50 focus-visible:ring-primary focus-visible:border-primary placeholder:text-muted-foreground/50 resize-none transition-all text-sm leading-relaxed"
            />
            <p className="text-[11px] text-muted-foreground/75 px-0.5">
              {t('AI完全按此目录结构生成文件树')}
            </p>
          </div>

          <DialogFooter className="pt-2 border-t border-border/40 gap-2 sm:gap-0">
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              className="rounded-xl font-semibold text-muted-foreground hover:bg-muted/50 hover:text-foreground"
            >
              {t('取消')}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={handleReset}
              className="rounded-xl font-semibold"
            >
              {t('恢复示例')}
            </Button>
            <Button
              type="submit"
              disabled={!canSubmit}
              className="rounded-xl font-bold bg-primary hover:bg-primary/95 text-primary-foreground shadow-lg shadow-primary/20 transition-all active:scale-[0.98]"
            >
              {t('确定')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
