import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { UserTier } from '@firefly/types'
import { WorkspacePendingBackfillTab } from '../WorkspacePendingBackfillTab'
import { useTierStore } from '../../../../stores/tier-store'

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

let mockRuntimeContext: {
  refresh: typeof mockRefreshRuntimeContext
  snapshot: { isProTier: boolean } | null
} = {
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

vi.mock('../../../../stores/tier-store', async () => {
  const { create } = await import('zustand')
  const useMockTierStore = create<{
    tier: string
    openUpgradeDialog: () => void
  }>(() => ({
    tier: 'pro',
    openUpgradeDialog: () => mockOpenUpgradeDialog()
  }))
  return {
    useTierStore: useMockTierStore
  }
})

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
    ;(useTierStore as any).setState({ tier: UserTier.PRO })
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

    // 铁律验证：严禁出现欺诈性的假「优先补全此文件」按钮，也禁止向免费用户渲染无作用的「重试全部失败片段」按钮
    expect(screen.queryByText('优先补全此文件')).toBeNull()
    expect(screen.queryByText(/重试全部失败片段/)).toBeNull()

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

  it('V-05: runtimeSnapshot 为 null 时响应式回落 useTierStore(s => s.tier)，升级后实时隐藏升级 Banner', async () => {
    mockRuntimeContext = {
      refresh: mockRefreshRuntimeContext,
      snapshot: null
    }
    ;(useTierStore as any).setState({ tier: UserTier.FREE })

    render(<WorkspacePendingBackfillTab workspace={workspace} isActive={true} />)

    await waitFor(() => {
      expect(screen.getByTestId('pending-backfill-free-upgrade-banner')).toBeTruthy()
    })
    expect(screen.queryByText('暂停后台补全')).toBeNull()

    // 模拟异步刷新为 AGENT / PRO：组件通过 Zustand selector 立即重渲染并隐藏 Banner
    act(() => {
      ;(useTierStore as any).setState({ tier: UserTier.AGENT })
    })
    await waitFor(() => {
      expect(screen.queryByTestId('pending-backfill-free-upgrade-banner')).toBeNull()
    })
    expect(screen.getByText('暂停后台补全')).toBeTruthy()
  })

  it('V-06: remainingMinutes 边界守卫——不足 30 秒按至少 1 分钟展示，含 NaN 时安全消毒不溢出', async () => {
    mockRuntimeContext = {
      refresh: mockRefreshRuntimeContext,
      snapshot: { isProTier: false }
    }
    mockFetchVideos.mockResolvedValueOnce({
      success: true,
      workspaceId: 7,
      effectiveLimitSec: 300,
      configuredLimitSec: 1800,
      items: [
        {
          workspaceFileId: 201,
          fileFingerprint: 'fp_short_tail',
          path: 'D:\\media\\tail.mp4',
          name: 'tail.mp4',
          completedSlices: 1,
          targetSlices: 2,
          totalSlices: 2,
          completedDurationSec: 300,
          targetDurationSec: 320,
          totalDurationSec: 320,
          failedSlices: 0
        },
        {
          workspaceFileId: 202,
          fileFingerprint: 'fp_nan',
          path: 'D:\\media\\nan.mp4',
          name: 'nan.mp4',
          completedSlices: 1,
          targetSlices: 2,
          totalSlices: 2,
          completedDurationSec: Number.NaN,
          targetDurationSec: Number.NaN,
          totalDurationSec: 300,
          failedSlices: 0
        }
      ],
      snapshot: { running: false, userPaused: false, pendingVideoCount: 2, pendingSliceCount: 2 }
    })

    render(<WorkspacePendingBackfillTab workspace={workspace} isActive={true} />)

    await waitFor(() => {
      expect(screen.getByTestId('pending-backfill-free-upgrade-banner')).toBeTruthy()
    })
    // 20s 尾片 + 脏 NaN 项安全消毒：精准兜底为至少 1 分钟（严禁渲染 NaN 或 0 分钟）
    expect(screen.queryByText(/NaN/)).toBeNull()
    expect(screen.queryByText(/剩余 0 分钟/)).toBeNull()
    expect(
      screen.getByText(
        '升级 Pro 可自动解锁长视频剩余 1 分钟全量画面分析，支持最长 3 小时整部视频任意画面找图。'
      )
    ).toBeTruthy()
  })

  it('V-07: 真实 workspace-ai-client 对 agent / enterprise / max / pro / free 的 isProTier 归一化判定', async () => {
    const actualClient = await vi.importActual<
      typeof import('../../../../lib/workspace-policy/workspace-ai-client')
    >('../../../../lib/workspace-policy/workspace-ai-client')
    const prevApi = (window as any).electronAPI
    try {
      const invokeCase = async (userTier: unknown) => {
        ;(window as any).electronAPI = {
          getWorkspaceRuntimeContextSnapshot: vi.fn().mockResolvedValue({
            contextEpoch: 1,
            workspaceId: 7,
            snapshot: {
              userTier,
              isGenerativeAiEnabled: true,
              globalEmbeddingProfile: 'gemma_unified',
              globalPluginStates: {},
              libreOfficeInstalled: true,
              videoInferenceBackend: 'gpu'
            }
          })
        }
        return actualClient.fetchWorkspaceRuntimeContext(7)
      }

      expect((await invokeCase('free'))?.isProTier).toBe(false)
      expect((await invokeCase('pro'))?.isProTier).toBe(true)
      expect((await invokeCase('enterprise'))?.isProTier).toBe(true)
      expect((await invokeCase('agent'))?.isProTier).toBe(true)
      expect((await invokeCase('  AGENT  '))?.isProTier).toBe(true)
      expect((await invokeCase('max'))?.isProTier).toBe(true)
    } finally {
      ;(window as any).electronAPI = prevApi
    }
  })

  it('V-08: 缺口码语义归并——同一文件严禁并列渲染两枚相同「内容补全」徽章', async () => {
    mockFetchRecovery.mockResolvedValueOnce({
      success: true,
      items: [
        {
          workspaceFileId: 301,
          fileFingerprint: 'fp_img_tags',
          path: 'F:\\Desktop\\DSC01864.jpg',
          name: 'DSC01864.jpg',
          fileSize: 4096,
          missingReasons: ['missing_visual_tags', 'missing_file_vector'],
          isPendingVideo: false
        },
        {
          workspaceFileId: 302,
          fileFingerprint: 'fp_img_unknown',
          path: 'F:\\Desktop\\DSC02307.jpg',
          name: 'DSC02307.jpg',
          fileSize: 4096,
          missingReasons: ['precise_recovery_item', 'no_fingerprint'],
          isPendingVideo: false
        }
      ]
    })

    render(<WorkspacePendingBackfillTab workspace={workspace} isActive={true} />)

    await waitFor(() => {
      expect(screen.getByText('DSC01864.jpg')).toBeTruthy()
    })

    // 已受控缺口码各自映射为大白话展示名，不再共用兜底文案
    expect(screen.getAllByText('画面内容识别')).toHaveLength(1)
    expect(screen.getAllByText('内容索引')).toHaveLength(1)
    // 未登记缺口码统一合并为一枚「内容补全」，同一行不重复渲染
    expect(screen.getAllByText('内容补全')).toHaveLength(1)
  })
})
