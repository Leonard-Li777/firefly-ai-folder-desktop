import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { WorkspacePendingBackfillTab } from '../WorkspacePendingBackfillTab'
import { UserTier } from '../../../../stores/tier-store'

const mockFetchVideos = vi.fn()
const mockFetchRecovery = vi.fn()
const mockStartBackfill = vi.fn()
const mockPauseBackfill = vi.fn()
const mockPrioritize = vi.fn()
const mockRetryFailed = vi.fn()
const mockEnqueueRecovery = vi.fn()
const mockClearRecovery = vi.fn()
const mockRefreshRuntimeContext = vi.fn().mockResolvedValue(undefined)
const mockOpenUpgradeDialog = vi.fn()

let mockRuntimeContext = {
  refresh: mockRefreshRuntimeContext,
  snapshot: {
    isProTier: true
  }
}

vi.mock('@app/languages', () => ({
  t: (str: string, params?: Record<string, any>) => {
    if (!params) return str
    return Object.entries(params).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), str)
  }
}))

vi.mock('../../../../stores/workspace-runtime-context-store', () => ({
  useWorkspaceRuntimeContext: (selector: any) => selector(mockRuntimeContext)
}))

vi.mock('../../../../stores/tier-store', () => ({
  UserTier: {
    FREE: 'free',
    PRO: 'pro'
  },
  useTierStore: Object.assign(
    (selector: any) =>
      selector({
        tier: UserTier.PRO,
        openUpgradeDialog: mockOpenUpgradeDialog
      }),
    {
      getState: () => ({
        tier: UserTier.PRO,
        openUpgradeDialog: mockOpenUpgradeDialog
      })
    }
  )
}))

vi.mock('../../../../stores/analysis-queue-store', () => ({
  useAnalysisQueueStore: (selector: any) =>
    selector({
      snapshot: {
        running: false,
        items: [],
        videoBackfill: {
          running: true,
          userPaused: false,
          pendingVideoCount: 1,
          pendingSliceCount: 4,
          current: {
            fileFingerprint: 'fp_v1',
            workspaceId: 7,
            fileName: 'vlog_30m.mp4',
            filePath: 'D:\\media\\vlog_30m.mp4',
            completedSlices: 2,
            targetSlices: 6,
            totalSlices: 6,
            currentSliceIndex: 2,
            progressPct: 42
          }
        }
      }
    })
}))

vi.mock('../../../../lib/workspace-policy/workspace-ai-client', () => ({
  fetchWorkspacePendingBackfillVideos: (...args: any[]) => mockFetchVideos(...args),
  fetchWorkspaceRecoveryQueue: (...args: any[]) => mockFetchRecovery(...args),
  startVideoBackfill: (...args: any[]) => mockStartBackfill(...args),
  pauseVideoBackfill: (...args: any[]) => mockPauseBackfill(...args),
  prioritizeVideoBackfill: (...args: any[]) => mockPrioritize(...args),
  retryFailedVideoBackfill: (...args: any[]) => mockRetryFailed(...args),
  enqueueWorkspaceRecoveryItems: (...args: any[]) => mockEnqueueRecovery(...args),
  clearWorkspaceRecoveryItems: (...args: any[]) => mockClearRecovery(...args)
}))

describe('WorkspacePendingBackfillTab (Spec v2.1 方案 A 英雄卡片与 Pro 漏斗)', () => {
  const workspace = { id: 7, name: '影视素材库', path: 'D:\\media' } as any

  beforeEach(() => {
    vi.clearAllMocks()
    mockRuntimeContext = {
      refresh: mockRefreshRuntimeContext,
      snapshot: {
        isProTier: true
      }
    }
    mockFetchVideos.mockResolvedValue({
      success: true,
      workspaceId: 7,
      effectiveLimitSec: 1800,
      configuredLimitSec: 1800,
      items: [
        {
          workspaceFileId: 102,
          fileFingerprint: 'fp_v1',
          path: 'D:\\media\\vlog_30m.mp4',
          name: 'vlog_30m.mp4',
          completedSlices: 2,
          targetSlices: 6,
          totalSlices: 6,
          completedDurationSec: 600,
          targetDurationSec: 1800,
          totalDurationSec: 1800,
          failedSlices: 0
        },
        {
          workspaceFileId: 103,
          fileFingerprint: 'fp_v2',
          path: 'D:\\media\\talk_20m.mp4',
          name: 'talk_20m.mp4',
          completedSlices: 1,
          targetSlices: 4,
          totalSlices: 4,
          completedDurationSec: 300,
          targetDurationSec: 1200,
          totalDurationSec: 1200,
          failedSlices: 1
        }
      ],
      snapshot: { running: true, userPaused: false, pendingVideoCount: 2, pendingSliceCount: 7 }
    })
    mockFetchRecovery.mockResolvedValue({
      success: true,
      items: [
        {
          workspaceFileId: 101,
          fileFingerprint: 'fp_pdf',
          path: 'D:\\media\\scan.pdf',
          name: 'scan.pdf',
          fileSize: 1024,
          missingReasons: ['missing_image_ocr'],
          isPendingVideo: false
        },
        {
          workspaceFileId: 102,
          fileFingerprint: 'fp_v1',
          path: 'D:\\media\\vlog_30m.mp4',
          name: 'vlog_30m.mp4',
          fileSize: 2048,
          missingReasons: ['pending_video'],
          isPendingVideo: true
        }
      ]
    })
    mockPauseBackfill.mockResolvedValue({ paused: true })
    mockPrioritize.mockResolvedValue({ ok: true })
    mockRetryFailed.mockResolvedValue({ resetCount: 1 })
    mockEnqueueRecovery.mockResolvedValue({ success: true, queued: 1 })
  })

  it('V-01: Pro 用户视角：正确渲染方案 A 英雄卡片 Tab 与操作（暂停、优先与重试）', async () => {
    render(<WorkspacePendingBackfillTab workspace={workspace} isActive={true} />)

    await waitFor(() => {
      expect(screen.getByTestId('pending-backfill-video-section')).toBeTruthy()
      expect(screen.getByTestId('pending-backfill-env-section')).toBeTruthy()
    })

    // 验证方案 A 英雄卡片 Tab 渲染
    expect(screen.getByRole('tab', { name: /长视频深度分析/ })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /其它文件待补全/ })).toBeTruthy()
    expect(screen.getByText('★ PRO')).toBeTruthy()
    // Pro 用户不显示免费升级 Pro 横幅 Banner
    expect(screen.queryByTestId('pending-backfill-free-upgrade-banner')).toBeNull()

    // 验证视频项渲染
    expect(screen.getByText('vlog_30m.mp4')).toBeTruthy()
    expect(screen.getByText('talk_20m.mp4')).toBeTruthy()
    expect(screen.getByText('scan.pdf')).toBeTruthy()

    // 暂停后台补全
    fireEvent.click(screen.getByText('暂停后台补全'))
    await waitFor(() => expect(mockPauseBackfill).toHaveBeenCalledTimes(1))

    // Pro 用户单卡优先补全
    fireEvent.click(screen.getByText('优先补全此文件'))
    await waitFor(() => expect(mockPrioritize).toHaveBeenCalledWith(7, 'fp_v2'))

    // 重试全部失败片段
    fireEvent.click(screen.getByText(/重试全部失败片段/))
    await waitFor(() => expect(mockRetryFailed).toHaveBeenCalledWith(7))
  })

  it('V-02: 免费用户视角：无假按钮铁律，顶部与单卡渲染升级 Pro 按钮并直达 UpgradeDialog', async () => {
    // 切换为免费用户上下文
    mockRuntimeContext = {
      refresh: mockRefreshRuntimeContext,
      snapshot: {
        isProTier: false
      }
    }

    render(<WorkspacePendingBackfillTab workspace={workspace} isActive={true} />)

    await waitFor(() => {
      expect(screen.getByTestId('pending-backfill-video-section')).toBeTruthy()
    })

    // 免费用户升级 Pro 权益横幅 Banner（含剩余分钟数大白话引导与升级按钮直达 UpgradeDialog）
    const upgradeBanner = screen.getByTestId('pending-backfill-free-upgrade-banner')
    expect(upgradeBanner).toBeTruthy()
    expect(screen.getByText('免费版已为您完成前 5 分钟画面分析与秒级检索')).toBeTruthy()
    expect(
      screen.getByText(
        '升级 Pro 可自动解锁长视频剩余 35 分钟全量画面分析，支持最长 3 小时整部视频任意画面找图。'
      )
    ).toBeTruthy()
    const bannerUpgradeBtn = screen.getByText('立即升级 Pro 解锁 →')
    fireEvent.click(bannerUpgradeBtn)
    expect(mockOpenUpgradeDialog).toHaveBeenCalledTimes(1)

    // 顶部主按钮显示为「👑 升级 Pro 立即补全」
    const upgradeTopBtn = screen.getByText('👑 升级 Pro 立即补全')
    expect(upgradeTopBtn).toBeTruthy()
    fireEvent.click(upgradeTopBtn)
    expect(mockOpenUpgradeDialog).toHaveBeenCalledTimes(2)

    // 单卡按钮明确渲染为「👑 解锁整片分析」
    const unlockCardBtns = screen.getAllByText('👑 解锁整片分析')
    expect(unlockCardBtns.length).toBeGreaterThanOrEqual(1)
    fireEvent.click(unlockCardBtns[0])
    expect(mockOpenUpgradeDialog).toHaveBeenCalledTimes(3)

    // 铁律验证：严禁出现欺诈性的假「优先补全此文件」按钮
    expect(screen.queryByText('优先补全此文件')).toBeNull()

    // 盲区透视提示
    expect(screen.getAllByText(/超出部分未建立索引无法检索/).length).toBeGreaterThanOrEqual(1)
  })

  it('V-03: 正确支持方案 A 英雄卡片 Tab 切换与能力恢复全链路操作', async () => {
    render(<WorkspacePendingBackfillTab workspace={workspace} isActive={true} />)

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /长视频深度分析/ })).toBeTruthy()
      expect(screen.getByRole('tab', { name: /其它文件待补全/ })).toBeTruthy()
    })

    const videoTab = screen.getByTestId('pending-backfill-videos-tab')
    const envTab = screen.getByTestId('pending-backfill-env-tab')
    expect(videoTab.classList.contains('hidden')).toBe(false)
    expect(envTab.classList.contains('hidden')).toBe(true)

    // 点击切换到其它文件 Tab
    fireEvent.click(screen.getByRole('tab', { name: /其它文件待补全/ }))
    await waitFor(() => {
      expect(videoTab.classList.contains('hidden')).toBe(true)
      expect(envTab.classList.contains('hidden')).toBe(false)
    })

    // 区块 2 立即补全全部
    fireEvent.click(screen.getByText('立即补全全部'))
    await waitFor(() => expect(mockEnqueueRecovery).toHaveBeenCalledWith(7, [101]))

    // 单项文件立即补全
    const singleRecoverBtn = screen.getByText('立即补全')
    expect(singleRecoverBtn).toBeTruthy()
    fireEvent.click(singleRecoverBtn)
    await waitFor(() => expect(mockEnqueueRecovery).toHaveBeenCalledWith(7, [101]))

    // 清除待补列表
    mockClearRecovery.mockResolvedValue({ success: true, cleared: 3 })
    const clearButtons = screen.getAllByText('清除待补列表')
    expect(clearButtons.length).toBeGreaterThanOrEqual(1)
    fireEvent.click(clearButtons[0])
    await waitFor(() => {
      expect(mockClearRecovery).toHaveBeenCalledWith(7, expect.arrayContaining([101, 102, 103]))
      expect(mockRefreshRuntimeContext).toHaveBeenCalled()
    })
  })

  it('V-04: 单一 Tab 无数据时，展示对应的轻量空态卡片', async () => {
    mockFetchRecovery.mockResolvedValueOnce({
      success: true,
      items: []
    })

    render(<WorkspacePendingBackfillTab workspace={workspace} isActive={true} />)

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /长视频深度分析/ })).toBeTruthy()
    })

    // 切换到其它文件待补全 Tab
    fireEvent.click(screen.getByRole('tab', { name: /其它文件待补全/ }))
    await waitFor(() => {
      expect(screen.getByTestId('pending-backfill-env-empty')).toBeTruthy()
      expect(
        screen.getByText('当前目录暂无其它环境恢复或缺失正文/OCR/转录的待补文件。')
      ).toBeTruthy()
    })
  })
})
