// @doc-anchor: docs/specs/video-fast-first-slice-and-idle-backfill-spec.md#34-目录设置新增常驻-tab待补分析文件workspacependingbackfilltabtsx
import React, { useEffect, useState, useCallback } from 'react'
import type {
  WorkspaceDirectory,
  WorkspacePendingBackfillVideoItem
} from '@firefly/types'
import { t } from '@app/languages'
import { Button } from '../../ui/button'
import { toast } from '../../common/Toast'
import { useAnalysisQueueStore } from '../../../stores/analysis-queue-store'
import {
  fetchWorkspacePendingBackfillVideos,
  startVideoBackfill,
  pauseVideoBackfill,
  prioritizeVideoBackfill,
  retryFailedVideoBackfill,
  fetchWorkspaceRecoveryQueue,
  enqueueWorkspaceRecoveryItems,
  clearWorkspaceRecoveryItems,
  type RecoverableFileItem
} from '../../../lib/workspace-policy/workspace-ai-client'
import { cn } from '../../../lib/utils'

export interface WorkspacePendingBackfillTabProps {
  workspace: WorkspaceDirectory
  isActive?: boolean
  onNavigateTab?: (tabId: 'basic_ai_engine') => void
}

function formatMissingReasonLabel(reason: string): string {
  switch (reason) {
    case 'missing_image_ocr':
      return t('图片文字识别')
    case 'missing_office_cover':
      return t('文档首页封面')
    case 'missing_thumbnail':
      return t('缩略图')
    case 'missing_audio_transcript':
      return t('语音转文字')
    case 'missing_document_content':
      return t('文档正文提取')
    default:
      return t('内容补全')
  }
}

/**
 * 目录设置 · 待补分析文件（统一双区工作台，Spec §3.4）
 * - 区块 1：长视频空闲自动补全（纯画面补全，单切片可抢占让路）
 * - 区块 2：其它待补全文件（能力恢复：图片文字识别/文档封面/语音转文字等，补齐后自动重跑标签与整理）
 */
export const WorkspacePendingBackfillTab: React.FC<WorkspacePendingBackfillTabProps> = ({
  workspace,
  isActive = true,
  onNavigateTab
}) => {
  const videoBackfill = useAnalysisQueueStore(s => s.snapshot?.videoBackfill)
  const mainQueueRunning = useAnalysisQueueStore(s => s.snapshot?.running === true)

  const [videoItems, setVideoItems] = useState<WorkspacePendingBackfillVideoItem[]>([])
  const [effectiveLimitSec, setEffectiveLimitSec] = useState<number>(300)
  const [envItems, setEnvItems] = useState<RecoverableFileItem[]>([])
  const [loading, setLoading] = useState<boolean>(false)
  const [busyAction, setBusyAction] = useState<boolean>(false)

  const loadData = useCallback(async () => {
    if (workspace?.id == null) return
    setLoading(true)
    try {
      const [videoRes, envRes] = await Promise.all([
        fetchWorkspacePendingBackfillVideos(workspace.id),
        fetchWorkspaceRecoveryQueue(workspace.id)
      ])
      if (videoRes?.success) {
        setVideoItems(videoRes.items || [])
        setEffectiveLimitSec(videoRes.effectiveLimitSec || 300)
      }
      if (envRes?.success) {
        // 区块 2 仅展示非视频缺口，防与区块 1 重复
        setEnvItems((envRes.items || []).filter(it => !it.isPendingVideo))
      }
    } finally {
      setLoading(false)
    }
  }, [workspace?.id])

  useEffect(() => {
    if (isActive) {
      void loadData()
    }
  }, [isActive, loadData, videoBackfill?.pendingSliceCount, videoBackfill?.running])

  const isBackfillRunning = Boolean(videoBackfill?.running)
  const canStartBackfill = Boolean(videoBackfill?.userPaused || !isBackfillRunning)

  const handleToggleBackfill = async () => {
    setBusyAction(true)
    try {
      if (canStartBackfill) {
        await startVideoBackfill(workspace.id)
        toast.success(t('已恢复后台空闲补全'))
      } else {
        await pauseVideoBackfill()
        toast.info(t('已暂停后台视频补全'))
      }
      await loadData()
    } finally {
      setBusyAction(false)
    }
  }

  const handleRetryAllFailed = async () => {
    if (workspace?.id == null) return
    setBusyAction(true)
    try {
      const res = await retryFailedVideoBackfill(workspace.id)
      if (res.resetCount > 0) {
        toast.success(t('已重置 {count} 个失败片段并开始重新补全', { count: res.resetCount }))
      }
      await loadData()
    } finally {
      setBusyAction(false)
    }
  }

  const handlePrioritizeVideo = async (fileFingerprint: string) => {
    if (workspace?.id == null) return
    await prioritizeVideoBackfill(workspace.id, fileFingerprint)
    toast.success(t('已设为优先补全'))
    await loadData()
  }

  const handleRecoverEnvItems = async (ids?: number[]) => {
    if (workspace?.id == null) return
    setBusyAction(true)
    try {
      const res = await enqueueWorkspaceRecoveryItems(workspace.id, ids)
      if (res.success) {
        toast.success(t('已将 {count} 个文件加入分析队列补全内容', { count: res.queued ?? 0 }))
        await loadData()
      }
    } finally {
      setBusyAction(false)
    }
  }

  const handleClearEnvItems = async () => {
    if (workspace?.id == null || envItems.length === 0) return
    setBusyAction(true)
    try {
      const ids = envItems.map(i => i.workspaceFileId)
      const res = await clearWorkspaceRecoveryItems(workspace.id, ids)
      if (res.success) {
        toast.info(t('已清除待补提示'))
        setEnvItems([])
      }
    } finally {
      setBusyAction(false)
    }
  }

  const totalFailedSlices = videoItems.reduce((sum, v) => sum + v.failedSlices, 0)
  const remainingMinutes = Math.round(
    videoItems.reduce(
      (sum, v) => sum + Math.max(0, v.targetDurationSec - v.completedDurationSec),
      0
    ) / 60
  )
  const limitMins = Math.round(effectiveLimitSec / 60)
  const hasVideos = videoItems.length > 0
  const hasEnv = envItems.length > 0

  return (
    <div className="flex-1 overflow-y-auto p-5 space-y-5">
      {/* 顶部汇总与全局控制栏 */}
      <div className="rounded-xl border border-border bg-muted/20 p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-sm font-bold text-foreground">{t('空闲自动补全工作台')}</h3>
              {mainQueueRunning ? (
                <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400">
                  {t('主队列忙碌，自动让路中')}
                </span>
              ) : videoBackfill?.userPaused ? (
                <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                  {t('后台补全已暂停')}
                </span>
              ) : videoBackfill?.running ? (
                <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-cyan-500/15 text-cyan-600 dark:text-cyan-400">
                  {t('正在后台补全')}
                </span>
              ) : (
                <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                  {hasVideos ? t('等待空闲补全') : t('暂无待补视频')}
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {t('电脑空闲时自动逐段补全长视频剩余画面；导入新文件时会自动暂停让路，绝不卡顿。')}
            </p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {hasVideos && (
              <Button
                type="button"
                size="sm"
                variant={canStartBackfill ? 'default' : 'outline'}
                disabled={busyAction}
                onClick={() => void handleToggleBackfill()}
              >
                {canStartBackfill ? t('立即开始补全') : t('暂停后台补全')}
              </Button>
            )}
            {totalFailedSlices > 0 && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busyAction}
                onClick={() => void handleRetryAllFailed()}
              >
                {t('重试全部失败片段')} ({totalFailedSlices})
              </Button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3 pt-2 border-t border-border/50">
          <div className="rounded-lg bg-card border border-border/60 px-3 py-2">
            <div className="text-xs text-muted-foreground">{t('待补长视频')}</div>
            <div className="text-base font-bold font-mono mt-0.5">
              {videoItems.length}{' '}
              <span className="text-xs font-normal text-muted-foreground">{t('个')}</span>
            </div>
          </div>
          <div className="rounded-lg bg-card border border-border/60 px-3 py-2">
            <div className="text-xs text-muted-foreground">{t('剩余待补画面时长')}</div>
            <div className="text-base font-bold font-mono mt-0.5">
              {remainingMinutes}{' '}
              <span className="text-xs font-normal text-muted-foreground">{t('分钟')}</span>
            </div>
          </div>
          <div className="rounded-lg bg-card border border-border/60 px-3 py-2">
            <div className="text-xs text-muted-foreground">{t('其它待补缺口')}</div>
            <div className="text-base font-bold font-mono mt-0.5">
              {envItems.length}{' '}
              <span className="text-xs font-normal text-muted-foreground">{t('个文件')}</span>
            </div>
          </div>
        </div>
      </div>

      {/* 区块 1：长视频空闲自动补全 */}
      {hasVideos && (
        <div className="space-y-2.5" data-testid="pending-backfill-video-section">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-semibold text-muted-foreground">
              {t('长视频空闲自动补全')} ·{' '}
              {t('按当前设定上限 {mins} 分钟补齐', { mins: limitMins })}
            </div>
            {onNavigateTab && (
              <button
                type="button"
                className="text-xs text-primary hover:underline cursor-pointer"
                onClick={() => onNavigateTab('basic_ai_engine')}
              >
                {t('调整时长上限')} →
              </button>
            )}
          </div>

          <div className="space-y-2">
            {videoItems.map(v => {
              const isCurrent =
                videoBackfill?.running &&
                videoBackfill.current?.fileFingerprint === v.fileFingerprint
              const completedSlices = isCurrent
                ? videoBackfill.current!.completedSlices
                : v.completedSlices
              const targetSlices = Math.max(1, v.targetSlices)
              const pct = isCurrent
                ? Math.round(videoBackfill.current!.progressPct)
                : Math.min(100, Math.round((completedSlices / targetSlices) * 100))
              const completedMins = Math.round(v.completedDurationSec / 60)
              const targetMins = Math.round(v.targetDurationSec / 60)
              const totalMins = Math.round(v.totalDurationSec / 60)

              return (
                <div
                  key={v.fileFingerprint}
                  className={cn(
                    'rounded-xl border p-3.5 space-y-2 bg-card/60',
                    isCurrent ? 'border-cyan-500/40' : 'border-border/60'
                  )}
                >
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-semibold text-foreground truncate">
                          {v.name}
                        </span>
                        {isCurrent ? (
                          <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-cyan-500/15 text-cyan-600 dark:text-cyan-400">
                            {t('补全中')} {pct}%
                          </span>
                        ) : v.failedSlices > 0 ? (
                          <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400">
                            {t('部分片段失败')} ({v.failedSlices})
                          </span>
                        ) : (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                            {t('等待空闲补全')}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {t('已分析 {done} / 目标 {target} 分钟（共 {total} 分钟）', {
                          done: completedMins,
                          target: targetMins,
                          total: totalMins
                        })}
                      </div>
                    </div>

                    {!isCurrent && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs shrink-0"
                        onClick={() => void handlePrioritizeVideo(v.fileFingerprint)}
                      >
                        {t('优先补全此文件')}
                      </Button>
                    )}
                  </div>

                  <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                    <div
                      className={cn(
                        'h-full rounded-full transition-all duration-300',
                        isCurrent ? 'bg-cyan-500' : 'bg-primary/60'
                      )}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* 区块 2：其它待补全文件（能力恢复：OCR / 封面 / 语音转文字等非视频缺口） */}
      {hasEnv && (
        <div
          className="space-y-2.5 pt-3 border-t border-border/60"
          data-testid="pending-backfill-env-section"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-xs font-semibold text-foreground">
                {t('其它待补全文件（能力恢复）')}
              </div>
              <p className="text-xs text-muted-foreground">
                {t('补齐图片文字识别、文档封面或语音转文字后，将自动重新整理标签与描述。')}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={busyAction}
                onClick={() => void handleRecoverEnvItems()}
              >
                {t('立即补全全部')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busyAction}
                onClick={() => void handleClearEnvItems()}
              >
                {t('不再提示')}
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            {envItems.map(item => (
              <div
                key={item.workspaceFileId}
                className="rounded-lg border border-border/60 bg-card/50 px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-foreground truncate">{item.name}</div>
                  <div className="text-xs text-muted-foreground truncate">{item.path}</div>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {item.missingReasons.map(r => (
                    <span
                      key={r}
                      className="text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground"
                    >
                      {formatMissingReasonLabel(r)}
                    </span>
                  ))}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    disabled={busyAction}
                    onClick={() => void handleRecoverEnvItems([item.workspaceFileId])}
                  >
                    {t('立即补全')}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 双区全空态 */}
      {!loading && !hasVideos && !hasEnv && (
        <div
          data-testid="pending-backfill-empty"
          className="rounded-xl border border-dashed border-border p-10 text-center space-y-1.5"
        >
          <div className="text-sm font-semibold text-foreground">
            {t('当前目录所有文件均已按设定标准分析完成，暂无待补全文件。')}
          </div>
          <p className="text-xs text-muted-foreground">
            {t('后续导入超过 5 分钟的长视频时，剩余画面会自动出现在这里并在空闲时补齐。')}
          </p>
        </div>
      )}
    </div>
  )
}
