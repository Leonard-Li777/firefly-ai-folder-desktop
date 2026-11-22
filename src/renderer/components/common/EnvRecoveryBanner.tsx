import React, { useState, useCallback } from 'react'
import { X, Sparkles } from 'lucide-react'
import { t } from '@app/languages'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { toast } from './Toast'
import {
  dismissWorkspaceRecoveryBanner,
  enqueueWorkspaceRecoveryItems
} from '../../lib/workspace-policy/workspace-ai-client'

/**
 * 待补全通栏横幅 (Environment Recovery Banner)
 *
 * 显示位置：Footer 顶部独立一行通栏（区别于 Footer 内部的行内状态文本）。
 * 文案：分别展示「待补全 OCR/封面等」的非视频缺口文件数与「待续跑长视频索引」的文件数。
 * 行为：
 *  - 立即补全：全部待补文件入队
 *  - 查看待补项：跳转工作目录设置 → 待补全文件 Tab
 *  - 知道了 / X：记录关闭，24 小时内即使有新文件进入待补也不再出现
 * 横幅自身不维护显隐；可见性由父级依据快照 recoverableCount > 0 判定。
 * 横幅负责在用户主动关闭时上报 dismiss（主进程记 24h 静默）并回调父级刷新快照。
 */
export interface EnvRecoveryBannerProps {
  workspaceId: number
  /** 待补非视频缺口文件数（OCR/封面/缩略图/内容等） */
  nonVideoCount: number
  /** 待续跑长视频索引文件数 */
  pendingVideoCount: number
  /** 关闭或触发操作后刷新运行时快照，使横幅按新计数显隐 */
  onRefresh: () => void
  /** 跳转到「待补全文件」设置页 */
  onOpenRecoveryQueue: () => void
  className?: string
}

export const EnvRecoveryBanner: React.FC<EnvRecoveryBannerProps> = ({
  workspaceId,
  nonVideoCount,
  pendingVideoCount,
  onRefresh,
  onOpenRecoveryQueue,
  className
}) => {
  const [busy, setBusy] = useState(false)

  /** 组合文案：两类待补分别用大白话描述，缺一类则只显示存在的那类 */
  const buildText = useCallback((): string => {
    const parts: string[] = []
    if (nonVideoCount > 0) {
      parts.push(t('有 {count} 个文件待补全 OCR、封面等内容', { count: nonVideoCount }))
    }
    if (pendingVideoCount > 0) {
      parts.push(t('有 {count} 个文件待续跑长视频索引', { count: pendingVideoCount }))
    }
    return parts.join(t('，'))
  }, [nonVideoCount, pendingVideoCount])

  const handleDismiss = useCallback(
    async (e?: React.MouseEvent) => {
      e?.stopPropagation()
      try {
        await dismissWorkspaceRecoveryBanner(workspaceId)
      } catch (err) {
        // 关闭失败不阻断 UI，但显式上报（严禁静默降级）
        console.warn('[EnvRecoveryBanner] 记录横幅关闭失败', err)
      }
      onRefresh()
    },
    [workspaceId, onRefresh]
  )

  const handleRecoverAll = useCallback(
    async (e?: React.MouseEvent) => {
      e?.stopPropagation()
      if (busy) return
      setBusy(true)
      try {
        const res = await enqueueWorkspaceRecoveryItems(workspaceId)
        if (res.success) {
          toast.success(
            t('已将 {count} 个文件加入补全队列，正在后台处理', {
              count: res.queued ?? nonVideoCount + pendingVideoCount
            })
          )
        } else {
          toast.error(res.error || t('补全触发失败，请稍后重试'))
        }
      } catch (err: any) {
        toast.error(err?.message || t('补全触发异常'))
      } finally {
        setBusy(false)
        onRefresh()
      }
    },
    [workspaceId, busy, nonVideoCount, pendingVideoCount, onRefresh]
  )

  return (
    <div
      data-testid="env-recovery-banner"
      role="status"
      className={cn(
        'w-full flex items-center justify-between gap-2 px-6 py-1.5 text-xs',
        'border-b border-amber-200/60 dark:border-amber-800/40',
        'bg-amber-50/95 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200',
        'backdrop-blur-sm select-none',
        className
      )}
    >
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <Sparkles className="w-3.5 h-3.5 shrink-0 text-amber-500" />
        <span className="truncate">{buildText()}</span>

        {/* 操作区：左对齐，紧随文案（立即补全 / 查看待补项 = 按钮形态，知道了 = 下划线） */}
        <div className="flex items-center gap-2 shrink-0 ml-1">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={handleRecoverAll}
            className="h-6 px-2 text-xs rounded gap-1 border-amber-400/60 text-amber-800 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/50 cursor-pointer shadow-2xs shrink-0"
          >
            {t('立即补全')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={e => {
              e.stopPropagation()
              onOpenRecoveryQueue()
            }}
            className="h-6 px-2 text-xs rounded gap-1 border-amber-400/60 text-amber-800 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/50 cursor-pointer shadow-2xs shrink-0"
          >
            {t('查看待补项')}
          </Button>
          <button
            type="button"
            onClick={handleDismiss}
            className="text-xs text-amber-700 dark:text-amber-300 underline underline-offset-2 hover:opacity-80 cursor-pointer px-1 shrink-0"
          >
            {t('知道了')}
          </button>
        </div>
      </div>

      {/* 关闭：唯一右对齐元素 */}
      <button
        type="button"
        onClick={handleDismiss}
        aria-label={t('关闭')}
        title={t('关闭')}
        className="p-1 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors cursor-pointer shrink-0"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}

export default EnvRecoveryBanner
