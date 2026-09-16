import React, { useCallback, useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '../ui/dialog'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { MaterialIcon } from '../../lib/utils'
import { DirectoryTreePreview } from './DirectoryTreePreview'
import { DirectoryNode } from '@firefly/types/organize-types'
import { t } from '@app/languages'
import { toast } from '../common/Toast'
import { logger } from '@firefly/shared'
import { LogCategory } from '@firefly/shared'

interface HacOrganizeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: number | undefined
  selectedFileIds?: number[]
  onSaved?: (vd: any) => void
}

/**
 * HAC 智能聚类整理对话框 (Issue #633)
 * 基于端侧 384d 密集向量进行约束层次聚类，生成目录整理方案预览，
 * 确认后可一键保存为虚拟目录
 */
export const HacOrganizeDialog: React.FC<HacOrganizeDialogProps> = ({
  open,
  onOpenChange,
  workspaceId,
  selectedFileIds,
  onSaved
}) => {
  const [isGenerating, setIsGenerating] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [summary, setSummary] = useState('')
  const [directories, setDirectories] = useState<DirectoryNode[]>([])
  const [vdName, setVdName] = useState('')
  const [userPrompt, setUserPrompt] = useState('')

  const loadScheme = useCallback(async (promptOverride?: string) => {
    if (!open || !workspaceId) return
    setIsGenerating(true)
    setSummary('')
    setDirectories([])
    try {
      const promptToUse = typeof promptOverride === 'string' ? promptOverride : userPrompt
      const result = await window.electronAPI!.virtualDirectory.generateHACClusterScheme(
        workspaceId,
        selectedFileIds && selectedFileIds.length > 0 ? selectedFileIds : undefined,
        promptToUse?.trim() || undefined
      )
      if (result && Array.isArray(result.directories)) {
        setSummary(result.summary || '')
        setDirectories(result.directories)
        setVdName('')
      } else {
        toast.info(t('当前文件暂无法进行智能聚类整理，请确认文件已完成 AI 分析'))
      }
    } catch (e) {
      logger.error(LogCategory.FILE_ORGANIZATION, '生成 HAC 聚类方案失败:', e)
      toast.error(t('生成智能聚类方案失败，请重试'))
    } finally {
      setIsGenerating(false)
    }
  }, [open, workspaceId, selectedFileIds, userPrompt])

  // 打开对话框时自动生成聚类方案
  useEffect(() => {
    if (open) {
      loadScheme('')
    }
  }, [open])

  const handleSave = async () => {
    if (!workspaceId || directories.length === 0) return
    const name = vdName.trim() || t('智能聚类整理')
    setIsSaving(true)
    try {
      const vd = await window.electronAPI!.virtualDirectory.saveFromPlan(workspaceId, name, {
        summary,
        directories
      })
      toast.success(t('已保存虚拟目录：{name}', { name: vd?.name || name }))
      onSaved?.(vd)
      onOpenChange(false)
    } catch (e) {
      logger.error(LogCategory.FILE_ORGANIZATION, '保存 HAC 聚类虚拟目录失败:', e)
      toast.error(t('保存虚拟目录失败，请重试'))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MaterialIcon icon="auto_awesome" className="text-primary text-lg" />
            {t('智能聚类整理')}
          </DialogTitle>
          <DialogDescription>
            {t('基于端侧 384d 密集向量自动聚类文件主题，零 Token 消耗，可预览后保存为虚拟目录')}
          </DialogDescription>
        </DialogHeader>

        {/* 提示词引导与重新聚类栏 */}
        <div className="flex items-center gap-2 py-1">
          <Input
            value={userPrompt}
            onChange={e => setUserPrompt(e.target.value)}
            placeholder={t('输入整理引导 Prompt（可选，例如：按年份与财务归类）')}
            className="flex-1 text-xs h-8"
            disabled={isGenerating}
            onKeyDown={e => {
              if (e.key === 'Enter' && !isGenerating) {
                loadScheme(userPrompt)
              }
            }}
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => loadScheme(userPrompt)}
            disabled={isGenerating}
            className="h-8 text-xs px-2.5 shrink-0"
          >
            <MaterialIcon icon={isGenerating ? 'hourglass_top' : 'refresh'} className="text-xs mr-1" />
            {t('重新聚类')}
          </Button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {isGenerating ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <div className="inline-block animate-spin rounded-full h-8 w-8 border-t-2 border-primary"></div>
              <p className="text-sm text-muted-foreground">{t('正在分析文件语义并聚类主题...')}</p>
            </div>
          ) : directories.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-2">
              <MaterialIcon icon="folder_off" className="text-4xl text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">{t('暂无聚类方案，请重试或更换引导词')}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {summary && (
                <div className="text-xs text-muted-foreground bg-muted/40 border border-border/60 rounded p-2.5">
                  {summary}
                </div>
              )}
              <DirectoryTreePreview directories={directories} isReadOnly />
            </div>
          )}
        </div>

        <DialogFooter className="mt-4">
          <div className="w-full flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="text-sm whitespace-nowrap text-muted-foreground">{t('虚拟目录名称')}</span>
              <Input
                value={vdName}
                onChange={e => setVdName(e.target.value)}
                placeholder={t('例如：我的智能聚类目录')}
                className="flex-1"
                disabled={directories.length === 0}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('取消')}
              </Button>
              <Button onClick={handleSave} disabled={directories.length === 0 || isSaving || isGenerating}>
                <MaterialIcon icon="save" className="text-sm mr-1.5" />
                {isSaving ? t('保存中...') : t('保存为虚拟目录')}
              </Button>
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default HacOrganizeDialog