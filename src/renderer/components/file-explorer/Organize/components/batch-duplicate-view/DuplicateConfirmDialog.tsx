import React from 'react'
import { t } from '@app/languages'
import { MaterialIcon, cn } from '../../../../../lib/utils'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '../../../../ui/alert-dialog'
import { ConfirmDialogConfig, SelectedActionSummary } from './types'

interface DuplicateConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  confirmDialogConfig: ConfirmDialogConfig
  selectedActionSummary: SelectedActionSummary
  onConfirm: () => void
}

/**
 * 批量查重二次确认安全弹窗（根据勾选项目类型智能适配准确描述）
 */
export const DuplicateConfirmDialog: React.FC<DuplicateConfirmDialogProps> = ({
  open,
  onOpenChange,
  confirmDialogConfig,
  selectedActionSummary,
  onConfirm
}) => {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="confirm-destructive">
        <AlertDialogHeader>
          <AlertDialogTitle>{confirmDialogConfig.title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>{confirmDialogConfig.mainDescription}</p>

              {confirmDialogConfig.showDetailsCard && (
                <div className="mt-2.5 space-y-1.5 rounded-lg border border-border/60 bg-muted/40 p-2.5 text-xs text-foreground/85">
                  <div className="text-[11px] font-semibold text-muted-foreground mb-1">
                    {t('待处理项目明细：')}
                  </div>
                  {selectedActionSummary.trashCount > 0 && (
                    <div className="flex items-center justify-between text-destructive">
                      <span className="flex items-center gap-1.5 font-medium">
                        <MaterialIcon icon="delete" className="text-sm" />
                        <span>{t('移入系统回收站（可还原）')}</span>
                      </span>
                      <span className="font-semibold tabular-nums">
                        {t('{count} 个文件', { count: selectedActionSummary.trashCount })}
                      </span>
                    </div>
                  )}
                  {selectedActionSummary.renameCount > 0 && (
                    <div className="flex items-center justify-between text-amber-600 dark:text-amber-400">
                      <span className="flex items-center gap-1.5 font-medium">
                        <MaterialIcon icon="drive_file_rename_outline" className="text-sm" />
                        <span>{t('按推荐规范重命名')}</span>
                      </span>
                      <span className="font-semibold tabular-nums">
                        {t('{count} 个文件', { count: selectedActionSummary.renameCount })}
                      </span>
                    </div>
                  )}
                  {selectedActionSummary.extFixCount > 0 && (
                    <div className="flex items-center justify-between text-indigo-600 dark:text-indigo-400">
                      <span className="flex items-center gap-1.5 font-medium">
                        <MaterialIcon icon="build" className="text-sm" />
                        <span>{t('修正错误扩展名')}</span>
                      </span>
                      <span className="font-semibold tabular-nums">
                        {t('{count} 个文件', { count: selectedActionSummary.extFixCount })}
                      </span>
                    </div>
                  )}
                  {selectedActionSummary.exifCleanCount > 0 && (
                    <div className="flex items-center justify-between text-emerald-600 dark:text-emerald-400">
                      <span className="flex items-center gap-1.5 font-medium">
                        <MaterialIcon icon="privacy_tip" className="text-sm" />
                        <span>{t('清理 Exif 隐私（另存副本保留原件）')}</span>
                      </span>
                      <span className="font-semibold tabular-nums">
                        {t('{count} 个图片', { count: selectedActionSummary.exifCleanCount })}
                      </span>
                    </div>
                  )}
                  {selectedActionSummary.videoOptCount > 0 && (
                    <div className="flex items-center justify-between text-primary">
                      <span className="flex items-center gap-1.5 font-medium">
                        <MaterialIcon icon="auto_fix_high" className="text-sm" />
                        <span>{t('视频转码优化（另存副本保留原件）')}</span>
                      </span>
                      <span className="font-semibold tabular-nums">
                        {t('{count} 个视频', { count: selectedActionSummary.videoOptCount })}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {selectedActionSummary.hasTrash && selectedActionSummary.hasNonTrash && (
                <p className="text-[11px] text-muted-foreground pt-1">
                  {t(
                    '注：移入回收站的文件随时可在系统回收站中还原；更名、修正与优化类操作不删除原文件。'
                  )}
                </p>
              )}
              {selectedActionSummary.isPureNonTrash && confirmDialogConfig.showDetailsCard && (
                <p className="text-[11px] text-muted-foreground pt-1">
                  {t('注：本次批量处理不包含任何删除操作，原文件均会安全保留。')}
                </p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            data-testid="confirm-destructive-cancel"
            onClick={() => onOpenChange(false)}
          >
            {t('取消')}
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid="confirm-destructive-accept"
            className={cn(
              confirmDialogConfig.isDestructive
                ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                : 'bg-primary text-primary-foreground hover:bg-primary/90'
            )}
            onClick={() => {
              onOpenChange(false)
              onConfirm()
            }}
          >
            {confirmDialogConfig.confirmBtnText}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
