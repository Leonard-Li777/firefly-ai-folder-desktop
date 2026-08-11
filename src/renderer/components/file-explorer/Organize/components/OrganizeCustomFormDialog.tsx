import React, { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../../../ui/dialog'
import { Button } from '../../../ui/button'
import { Input } from '../../../ui/input'
import { Textarea } from '../../../ui/textarea'
import { MaterialIcon } from '../../../../lib/utils'
import { t } from '@app/languages'

interface OrganizeCustomFormDialogProps {
  open: boolean
  onClose: () => void
  onSubmit: (name: string, strategy: string) => void
  initialName?: string
  initialStrategy?: string
  workspacePath?: string
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
  workspacePath
}) => {
  const [name, setName] = useState(initialName)
  const [strategy, setStrategy] = useState(initialStrategy)
  const [isDirty, setIsDirty] = useState(false)

  useEffect(() => {
    if (open) {
      // 从 localStorage 读取当前工作空间的自定义方案
      if (workspacePath) {
        const savedName = localStorage.getItem(`organize_custom_name_${workspacePath}`)
        const savedStrategy = localStorage.getItem(`organize_custom_strategy_${workspacePath}`)
        setName(savedName || initialName || t('行政2025年归档'))
        if (savedStrategy || initialStrategy) {
          setStrategy(savedStrategy || initialStrategy)
          setIsDirty(true)
        } else {
          setStrategy('')
          setIsDirty(false)
        }
      } else {
        setName(initialName || t('行政2025年归档'))
        if (initialStrategy) {
          setStrategy(initialStrategy)
          setIsDirty(true)
        } else {
          setStrategy('')
          setIsDirty(false)
        }
      }
    }
  }, [open, initialName, initialStrategy, workspacePath])

  const handleSumbit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    const finalStrategy = isDirty ? strategy.trim() : DEFAULT_STRATEGY.trim()
    onSubmit(name.trim(), finalStrategy)
    // 保存到 localStorage
    if (workspacePath) {
      localStorage.setItem(`organize_custom_name_${workspacePath}`, name.trim())
      localStorage.setItem(`organize_custom_strategy_${workspacePath}`, finalStrategy)
    }
    setName('')
    setStrategy('')
    setIsDirty(false)
    onClose()
  }

  const handleReset = () => {
    setName(initialName || t('行政2025年归档'))
    setStrategy(DEFAULT_STRATEGY)
    setIsDirty(false)
    // 清除 localStorage 中的保存
    if (workspacePath) {
      localStorage.removeItem(`organize_custom_name_${workspacePath}`)
      localStorage.removeItem(`organize_custom_strategy_${workspacePath}`)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(val: boolean) => !val && onClose()}>
      <DialogContent className="sm:max-w-2xl p-0 overflow-hidden rounded-2xl border-border/60 shadow-2xl bg-card">
        <div className="p-6 pb-4 border-b border-border/40 bg-muted/20 relative">
          <div className="absolute top-0 right-0 p-6 text-primary/10 select-none pointer-events-none">
            <MaterialIcon icon="edit_note" className="text-7xl" />
          </div>
          <DialogHeader className="relative z-10">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-primary/10 text-primary">
                <MaterialIcon icon="settings_suggest" className="text-xl" />
              </div>
              <div>
                <DialogTitle className="text-lg font-bold tracking-tight">
                  {t('自定义目录树')}
                </DialogTitle>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {t('手动创建专属的整理视角与最终的目录树')}
                </p>
              </div>
            </div>
          </DialogHeader>
        </div>

        <form onSubmit={handleSumbit} className="p-6 space-y-5">
          <div className="space-y-2">
            <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <span>{t('虚拟目录名')}</span>
              <span className="text-destructive font-bold">*</span>
            </label>
            <Input
              value={name}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
              placeholder={t('例：办公文员视角、行政视角、财务视角、人事视角')}
              className="h-11 rounded-xl border-border/60 bg-background/50 focus-visible:ring-primary focus-visible:border-primary placeholder:text-muted-foreground/50 transition-all font-medium"
              required
            />
            <p className="text-[11px] text-muted-foreground/75 px-0.5">
              {t('此名称将作为最终物理文件夹的名字')}
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider">
              {t('整理策略')}
            </label>
            <Textarea
              value={isDirty ? strategy : DEFAULT_STRATEGY}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
                setIsDirty(true)
                setStrategy(e.target.value)
              }}
              placeholder={t('请直接给出目录树结构和文件归类策略')}
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
              disabled={!name.trim()}
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
