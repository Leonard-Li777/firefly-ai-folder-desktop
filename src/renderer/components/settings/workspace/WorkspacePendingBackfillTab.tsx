// @doc-anchor: docs/specs/video-fast-first-slice-and-idle-backfill-spec.md#34-目录设置新增常驻-tab待补分析文件workspacependingbackfilltabtsx
import React, { useEffect, useState, useCallback, useRef } from 'react'
import type { WorkspaceDirectory, WorkspacePendingBackfillVideoItem } from '@firefly/types'
import { UserTier } from '@firefly/types'
import { t } from '@app/languages'
import { Button } from '../../ui/button'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../ui/tabs'
import { toast } from '../../common/Toast'
import { useAnalysisQueueStore } from '../../../stores/analysis-queue-store'
import { useWorkspaceRuntimeContext } from '../../../stores/workspace-runtime-context-store'
import { useTierStore } from '../../../stores/tier-store'
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

/** 静态徽标常量（严禁进入翻译字典） */
const PRO_BADGE_TEXT = '★ PRO'

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

function getMissingReasonBadgeStyle(reason: string): string {
  switch (reason) {
    case 'missing_image_ocr':
      return 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-400 border-cyan-500/20'
    case 'missing_audio_transcript':
      return 'bg-purple-500/10 text-purple-700 dark:text-purple-400 border-purple-500/20'
    case 'missing_office_cover':
      return 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20'
    case 'missing_document_content':
      return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20'
    case 'missing_thumbnail':
      return 'bg-slate-500/10 text-slate-700 dark:text-slate-400 border-slate-500/20'
    default:
      return 'bg-muted text-muted-foreground border-border/50'
  }
}

/**
 * 目录设置 · 待补分析文件（方案 A 英雄卡片双栏工作台，Spec v2.1）
 * - 卡片 Tab 1：长视频深度分析（★ PRO 徽章、大字指标、盲区透视与转化闭环）
 * - 卡片 Tab 2：其它文件待补全（能力恢复徽章、大字指标与受控彩色标签）
 */
export const WorkspacePendingBackfillTab: React.FC<WorkspacePendingBackfillTabProps> = ({
  workspace,
  isActive = true,
  onNavigateTab
}) => {
  const videoBackfill = useAnalysisQueueStore(s => s.snapshot?.videoBackfill)
  const mainQueueRunning = useAnalysisQueueStore(s => s.snapshot?.running === true)
  const refreshRuntimeContext = useWorkspaceRuntimeContext(s => s.refresh)
  const runtimeSnapshot = useWorkspaceRuntimeContext(s => s.snapshot)

  // 权威判定会员 Pro 状态：工作区运行时快照优先，回落响应式 tier-store 枚举判定
  const storeTier = useTierStore(s => s.tier)
  const isPro = runtimeSnapshot?.isProTier ?? (storeTier !== UserTier.FREE)

  const [videoItems, setVideoItems] = useState<WorkspacePendingBackfillVideoItem[]>([])
  const [effectiveLimitSec, setEffectiveLimitSec] = useState<number>(300)
  const [envItems, setEnvItems] = useState<RecoverableFileItem[]>([])
  const [loading, setLoading] = useState<boolean>(false)
  const [busyAction, setBusyAction] = useState<boolean>(false)
  const [activeTab, setActiveTab] = useState<'videos' | 'env'>('videos')
  const userSwitchedRef = useRef<boolean>(false)

  const handleTabChange = (val: string) => {
    userSwitchedRef.current = true
    setActiveTab(val as 'videos' | 'env')
  }

  useEffect(() => {
    if (!userSwitchedRef.current) {
      if (videoItems.length === 0 && envItems.length > 0) {
        setActiveTab('env')
      } else if (videoItems.length > 0) {
        setActiveTab('videos')
      }
    }
  }, [videoItems.length, envItems.length])

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

  const handleOpenUpgradeDialog = () => {
    useTierStore.getState().openUpgradeDialog()
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

  const handleClearAllItems = async (targetFileIds?: number[]) => {
    if (workspace?.id == null) return
    setBusyAction(true)
    try {
      let ids = targetFileIds
      if (!ids) {
        const idSet = new Set<number>()
        for (const v of videoItems) {
          if (v.workspaceFileId != null) idSet.add(v.workspaceFileId)
        }
        for (const e of envItems) {
          if (e.workspaceFileId != null) idSet.add(e.workspaceFileId)
        }
        ids = Array.from(idSet)
      }
      const res = await clearWorkspaceRecoveryItems(
        workspace.id,
        ids && ids.length > 0 ? ids : undefined
      )
      if (res.success) {
        toast.info(t('已清除待补列表'))
        if (!targetFileIds) {
          setVideoItems([])
          setEnvItems([])
        }
        await loadData()
        await refreshRuntimeContext()
      } else {
        toast.error(res.error || t('清除待补列表失败'))
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
  const totalMissingCapabilities = envItems.reduce((sum, e) => sum + e.missingReasons.length, 0)
  const hasVideos = videoItems.length > 0
  const hasEnv = envItems.length > 0

  return (
    <div className="flex-1 overflow-y-auto p-5 space-y-5">
      {/* 顶部全局运行状态通知条 */}
      <div className="flex items-center justify-between gap-3 text-xs bg-muted/40 rounded-lg px-3.5 py-2 border border-border/50">
        <div className="flex items-center gap-2">
          <span className="font-medium text-foreground">{t('空闲自动补全工作台')}</span>
          <span className="text-muted-foreground">·</span>
          {mainQueueRunning ? (
            <span className="text-amber-600 dark:text-amber-400 font-medium">
              {t('主队列忙碌，自动让路中')}
            </span>
          ) : videoBackfill?.userPaused ? (
            <span className="text-muted-foreground">{t('后台补全已暂停')}</span>
          ) : videoBackfill?.running ? (
            <span className="text-cyan-600 dark:text-cyan-400 font-medium animate-pulse">
              {t('正在后台补全')}
            </span>
          ) : (
            <span className="text-muted-foreground">
              {hasVideos ? t('等待空闲补全') : t('暂无待补视频')}
            </span>
          )}
        </div>
        <div className="text-muted-foreground text-[11px]">
          {t('空闲时自动逐段补全；导入新文件时自动暂停让路')}
        </div>
      </div>

      {/* 方案 A 英雄卡片式双栏大号 Tab */}
      {(hasVideos || hasEnv) && (
        <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full space-y-4">
          <TabsList className="grid grid-cols-2 gap-4 h-auto bg-transparent p-0 border-0">
            {/* 左卡：长视频深度分析 */}
            <TabsTrigger
              value="videos"
              className={cn(
                'h-auto p-4 rounded-xl border flex flex-col items-start gap-2.5 text-left transition-all cursor-pointer',
                'border-border/70 hover:border-border/90 bg-card/60',
                'data-[state=active]:border-primary data-[state=active]:bg-primary/5 data-[state=active]:ring-2 data-[state=active]:ring-primary/20 data-[state=active]:shadow-xs'
              )}
              onClick={() => handleTabChange('videos')}
            >
              <div className="w-full flex items-center justify-between gap-2">
                <span className="text-sm font-bold text-foreground flex items-center gap-2">
                  <span className="text-base leading-none">🎬</span>
                  {t('长视频深度分析')}
                </span>
                <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30">
                  {PRO_BADGE_TEXT}
                </span>
              </div>
              <div className="w-full flex items-baseline gap-4 mt-0.5">
                <div>
                  <span className="text-2xl font-bold font-mono text-foreground">{videoItems.length}</span>
                  <span className="text-xs text-muted-foreground ml-1.5">{t('部视频')}</span>
                </div>
                <div>
                  <span className="text-2xl font-bold font-mono text-foreground">{remainingMinutes}</span>
                  <span className="text-xs text-muted-foreground ml-1.5">{t('分钟待补')}</span>
                </div>
              </div>
              <div className="text-[11px] text-muted-foreground">
                {t('自动逐段切片建立全文台词与画面索引')}
              </div>
            </TabsTrigger>

            {/* 右卡：其它文件待补全 */}
            <TabsTrigger
              value="env"
              className={cn(
                'h-auto p-4 rounded-xl border flex flex-col items-start gap-2.5 text-left transition-all cursor-pointer',
                'border-border/70 hover:border-border/90 bg-card/60',
                'data-[state=active]:border-primary data-[state=active]:bg-primary/5 data-[state=active]:ring-2 data-[state=active]:ring-primary/20 data-[state=active]:shadow-xs'
              )}
              onClick={() => handleTabChange('env')}
            >
              <div className="w-full flex items-center justify-between gap-2">
                <span className="text-sm font-bold text-foreground flex items-center gap-2">
                  <span className="text-base leading-none">📑</span>
                  {t('其它文件待补全')}
                </span>
                <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-600 dark:text-blue-400 border border-blue-500/30">
                  {t('能力恢复')}
                </span>
              </div>
              <div className="w-full flex items-baseline gap-4 mt-0.5">
                <div>
                  <span className="text-2xl font-bold font-mono text-foreground">{envItems.length}</span>
                  <span className="text-xs text-muted-foreground ml-1.5">{t('个文件')}</span>
                </div>
                <div>
                  <span className="text-2xl font-bold font-mono text-foreground">{totalMissingCapabilities}</span>
                  <span className="text-xs text-muted-foreground ml-1.5">{t('项能力缺口')}</span>
                </div>
              </div>
              <div className="text-[11px] text-muted-foreground">
                {t('文档正文、OCR文字或语音转录缺口')}
              </div>
            </TabsTrigger>
          </TabsList>

          {/* 选项卡内容 1：长视频 */}
          <TabsContent
            value="videos"
            forceMount
            data-testid="pending-backfill-videos-tab"
            className={cn(
              'space-y-3 mt-2 focus-visible:outline-none',
              activeTab !== 'videos' && 'hidden'
            )}
          >
            {hasVideos ? (
              <div className="space-y-3" data-testid="pending-backfill-video-section">
                {/* 视频操作控制栏 */}
                <div className="flex flex-wrap items-center justify-between gap-3 bg-card/40 p-3 rounded-lg border border-border/50">
                  <div>
                    <div className="text-xs font-semibold text-foreground">
                      {t('待补全长视频清单')}
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {t('已按 5 分钟切片切分；支持优先补全单部视频或重试失败片段')}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    {!isPro ? (
                      <Button
                        type="button"
                        size="sm"
                        className="bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-white font-semibold shadow-xs"
                        onClick={handleOpenUpgradeDialog}
                      >
                        {t('👑 升级 Pro 立即补全')}
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant={canStartBackfill ? 'default' : 'outline'}
                        disabled={busyAction}
                        onClick={() => void handleToggleBackfill()}
                      >
                        {canStartBackfill ? t('立即补全全部长视频') : t('暂停后台补全')}
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
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busyAction}
                      onClick={() => void handleClearAllItems()}
                    >
                      {t('清除待补列表')}
                    </Button>
                  </div>
                </div>

                {/* 免费用户 Pro 权益升级横幅（对齐 UI 定稿 pending-backfill-redesign.html） */}
                {!isPro && (
                  <div
                    data-testid="pending-backfill-free-upgrade-banner"
                    className="rounded-xl border border-amber-500/40 bg-gradient-to-r from-amber-500/15 via-orange-500/5 to-transparent p-4 flex items-center justify-between gap-3 flex-wrap"
                  >
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <div className="w-8 h-8 rounded-xl bg-amber-500/20 text-amber-600 dark:text-amber-400 flex items-center justify-center text-base shrink-0 font-bold shadow-xs">
                        👑
                      </div>
                      <div className="text-xs leading-relaxed">
                        <div className="font-bold text-amber-800 dark:text-amber-200 text-sm">
                          {t('免费版已为您完成前 5 分钟画面分析与秒级检索')}
                        </div>
                        <div className="text-muted-foreground mt-0.5">
                          {t(
                            '升级 Pro 可自动解锁长视频剩余 {minutes} 分钟全量画面分析，支持最长 3 小时整部视频任意画面找图。',
                            { minutes: remainingMinutes }
                          )}
                        </div>
                      </div>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      className="px-4 py-2 rounded-xl text-xs font-bold text-white bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700 shadow-sm shrink-0"
                      onClick={handleOpenUpgradeDialog}
                    >
                      {t('立即升级 Pro 解锁 →')}
                    </Button>
                  </div>
                )}

                {/* 视频卡片列表 */}
                <div className="space-y-2.5">
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
                          'rounded-xl border p-3.5 space-y-2.5 bg-card/60 transition-colors',
                          isCurrent ? 'border-cyan-500/50 bg-cyan-500/5' : 'border-border/60 hover:border-border'
                        )}
                      >
                        <div className="flex items-center justify-between gap-3 flex-wrap">
                          <div className="min-w-0 flex-1 flex items-center gap-3">
                            {/* 视频缩略图槽位 */}
                            <div className="w-12 h-10 rounded-md bg-muted/80 border border-border/60 flex items-center justify-center shrink-0 text-muted-foreground text-sm font-mono">
                              ▶
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-xs font-semibold text-foreground truncate">
                                  {v.name}
                                </span>
                                {isCurrent ? (
                                  <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 animate-pulse">
                                    {t('补全中')} {pct}%
                                  </span>
                                ) : v.failedSlices > 0 ? (
                                  <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400">
                                    {t('部分片段失败')} ({v.failedSlices})
                                  </span>
                                ) : (
                                  <span className="text-[11px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                                    {t('等待空闲补全')}
                                  </span>
                                )}
                              </div>
                              <div className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-2 flex-wrap">
                                <span>
                                  {t('已分析 {done} / 目标 {target} 分钟（共 {total} 分钟）', {
                                    done: completedMins,
                                    target: targetMins,
                                    total: totalMins
                                  })}
                                </span>
                                {!isPro && (
                                  <span className="text-amber-600/90 dark:text-amber-400/90 font-medium">
                                    · {t('超出部分未建立索引无法检索')}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>

                          {/* 单卡操作栏（绝无假优先按钮） */}
                          <div className="flex items-center gap-2 shrink-0">
                            {!isPro ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="h-7 text-xs shrink-0 border-amber-500/40 text-amber-600 dark:text-amber-400 hover:bg-amber-500/10 font-semibold"
                                onClick={handleOpenUpgradeDialog}
                              >
                                {t('👑 解锁整片分析')}
                              </Button>
                            ) : !isCurrent ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="h-7 text-xs shrink-0"
                                onClick={() => void handlePrioritizeVideo(v.fileFingerprint)}
                              >
                                {t('优先补全此文件')}
                              </Button>
                            ) : null}
                            {v.workspaceFileId != null && (
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="h-7 text-xs shrink-0 text-muted-foreground hover:text-foreground"
                                disabled={busyAction}
                                onClick={() => void handleClearAllItems([v.workspaceFileId!])}
                              >
                                {t('不再补全')}
                              </Button>
                            )}
                          </div>
                        </div>

                        {/* 连续平滑分段进度条 */}
                        <div className="h-2 w-full rounded-full bg-muted/80 overflow-hidden flex">
                          <div
                            className={cn(
                              'h-full rounded-full transition-all duration-300',
                              isCurrent ? 'bg-cyan-500' : 'bg-emerald-500'
                            )}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            ) : (
              <div
                data-testid="pending-backfill-video-empty"
                className="rounded-xl border border-dashed border-border/80 p-8 text-center space-y-1 bg-card/20"
              >
                <div className="text-xs font-semibold text-foreground">
                  {t('当前目录暂无待续跑的长视频片段。')}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {t('当导入时长超过 5 分钟的长视频时，首段分析完成后剩余片段会自动在此排队。')}
                </p>
              </div>
            )}
          </TabsContent>

          {/* 选项卡内容 2：其它待补全文件 */}
          <TabsContent
            value="env"
            forceMount
            data-testid="pending-backfill-env-tab"
            className={cn(
              'space-y-3 mt-2 focus-visible:outline-none',
              activeTab !== 'env' && 'hidden'
            )}
          >
            {hasEnv ? (
              <div className="space-y-3" data-testid="pending-backfill-env-section">
                <div className="flex flex-wrap items-center justify-between gap-2 bg-card/40 p-3 rounded-lg border border-border/50">
                  <div>
                    <div className="text-xs font-semibold text-foreground">
                      {t('其它待补全文件（能力恢复）')}
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {t('补齐图片文字识别、文档封面或语音转文字后，将自动重新整理标签与描述。')}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={busyAction}
                      onClick={() =>
                        void handleRecoverEnvItems(envItems.map(i => i.workspaceFileId))
                      }
                    >
                      {t('立即补全全部')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busyAction}
                      onClick={() => void handleClearAllItems()}
                    >
                      {t('清除待补列表')}
                    </Button>
                  </div>
                </div>

                <div className="space-y-2">
                  {envItems.map(item => (
                    <div
                      key={item.workspaceFileId}
                      className="rounded-lg border border-border/60 bg-card/50 px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2 hover:border-border transition-colors"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-semibold text-foreground truncate">
                          {item.name}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">{item.path}</div>
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {item.missingReasons.map(r => (
                          <span
                            key={r}
                            className={cn(
                              'text-xs px-2 py-0.5 rounded-full border font-medium',
                              getMissingReasonBadgeStyle(r)
                            )}
                          >
                            {formatMissingReasonLabel(r)}
                          </span>
                        ))}
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs ml-1"
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
            ) : (
              <div
                data-testid="pending-backfill-env-empty"
                className="rounded-xl border border-dashed border-border/80 p-8 text-center space-y-1 bg-card/20"
              >
                <div className="text-xs font-semibold text-foreground">
                  {t('当前目录暂无其它环境恢复或缺失正文/OCR/转录的待补文件。')}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {t('若环境恢复（如补全模型、安装依赖组件）后发现缺口，会自动在此列出以便一键补齐。')}
                </p>
              </div>
            )}
          </TabsContent>
        </Tabs>
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
