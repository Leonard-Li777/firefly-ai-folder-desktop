import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { WorkspacePendingBackfillTab } from '../WorkspacePendingBackfillTab'

const mockFetchVideos = vi.fn()
const mockFetchRecovery = vi.fn()
const mockStartBackfill = vi.fn()
const mockPauseBackfill = vi.fn()
const mockPrioritize = vi.fn()
const mockRetryFailed = vi.fn()
const mockEnqueueRecovery = vi.fn()
const mockClearRecovery = vi.fn()
const mockRefreshRuntimeContext = vi.fn().mockResolvedValue(undefined)

vi.mock('@app/languages', () => ({
  t: (str: string, params?: Record<string, any>) => {
    if (!params) return str
    return Object.entries(params).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), str)
  }
}))

vi.mock('../../../../stores/workspace-runtime-context-store', () => ({
  useWorkspaceRuntimeContext: (selector: any) =>
    selector({
      refresh: mockRefreshRuntimeContext
    })
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

describe('WorkspacePendingBackfillTab (Ticket 04 / V-05)', () => {
  const workspace = { id: 7, name: '影视素材库', path: 'D:\\media' } as any

  beforeEach(() => {
    vi.clearAllMocks()
    mockFetchVideos.mockResolvedValue({
      success: true,
      workspaceId: 7,
      effectiveLimitSec: 1800,
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
        // 视频项应被区块 2 自动过滤防重复
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

  it('V-05: 正确渲染双区数据（长视频补全 + 非视频环境恢复），并响应暂停、优先与重试操作', async () => {
    render(<WorkspacePendingBackfillTab workspace={workspace} isActive={true} />)

    await waitFor(() => {
      expect(screen.getByTestId('pending-backfill-video-section')).toBeTruthy()
      expect(screen.getByTestId('pending-backfill-env-section')).toBeTruthy()
    })

    expect(screen.getByText('vlog_30m.mp4')).toBeTruthy()
    expect(screen.getByText('talk_20m.mp4')).toBeTruthy()
    expect(screen.getByText('scan.pdf')).toBeTruthy()

    // 暂停后台补全
    fireEvent.click(screen.getByText('暂停后台补全'))
    await waitFor(() => expect(mockPauseBackfill).toHaveBeenCalledTimes(1))

    // 优先补全非当前视频
    fireEvent.click(screen.getByText('优先补全此文件'))
    await waitFor(() => expect(mockPrioritize).toHaveBeenCalledWith(7, 'fp_v2'))

    // 重试全部失败片段
    fireEvent.click(screen.getByText(/重试全部失败片段/))
    await waitFor(() => expect(mockRetryFailed).toHaveBeenCalledWith(7))

    // 切换到其它待补全文件 Tab，验证其内操作
    fireEvent.click(screen.getByRole('tab', { name: /其它待补全文件/ }))

    // 区块 2 立即补全全部非视频项（精准作用域，传入区块 2 待补文件 ID，杜绝把长视频切片误入队）
    fireEvent.click(screen.getByText('立即补全全部'))
    await waitFor(() => expect(mockEnqueueRecovery).toHaveBeenCalledWith(7, [101]))

    // 单项文件的「立即补全」按钮
    const singleRecoverBtn = screen.getByText('立即补全')
    expect(singleRecoverBtn).toBeTruthy()
    fireEvent.click(singleRecoverBtn)
    await waitFor(() => expect(mockEnqueueRecovery).toHaveBeenCalledWith(7, [101]))

    // 清除待补列表按钮（顶部与区块 2 均支持，点击清空当前工作区所有待补项）
    mockClearRecovery.mockResolvedValue({ success: true, cleared: 3 })
    const clearButtons = screen.getAllByText('清除待补列表')
    expect(clearButtons.length).toBeGreaterThanOrEqual(1)
    fireEvent.click(clearButtons[0])
    await waitFor(() => {
      expect(mockClearRecovery).toHaveBeenCalledWith(7, expect.arrayContaining([101, 102, 103]))
      expect(mockRefreshRuntimeContext).toHaveBeenCalled()
    })
  })

  it('V-06: 支持单个长视频行级「不再补全」操作', async () => {
    render(<WorkspacePendingBackfillTab workspace={workspace} isActive={true} />)

    await waitFor(() => {
      expect(screen.getByText('talk_20m.mp4')).toBeTruthy()
    })

    mockClearRecovery.mockResolvedValue({ success: true, cleared: 1 })
    const clearSingleBtns = screen.getAllByText('不再补全')
    expect(clearSingleBtns.length).toBe(2)
    fireEvent.click(clearSingleBtns[1])
    await waitFor(() => {
      expect(mockClearRecovery).toHaveBeenCalledWith(7, [103])
      expect(mockRefreshRuntimeContext).toHaveBeenCalled()
    })
  })

  it('V-07: 正确渲染双 Tab 导航与徽标，并支持点击 Tab 或统计卡片切换视图', async () => {
    render(<WorkspacePendingBackfillTab workspace={workspace} isActive={true} />)

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /长视频切片补全/ })).toBeTruthy()
      expect(screen.getByRole('tab', { name: /其它待补全文件/ })).toBeTruthy()
    })

    // 验证 Tab 徽标数字
    expect(screen.getByRole('tab', { name: /长视频切片补全/ })).toHaveTextContent('2')
    expect(screen.getByRole('tab', { name: /其它待补全文件/ })).toHaveTextContent('1')

    // 初始默认在长视频 Tab，长视频区域可见，环境区域隐藏
    const videoTab = screen.getByTestId('pending-backfill-videos-tab')
    const envTab = screen.getByTestId('pending-backfill-env-tab')
    expect(videoTab.classList.contains('hidden')).toBe(false)
    expect(envTab.classList.contains('hidden')).toBe(true)

    // 点击 Tab 切换到其它待补全文件
    fireEvent.click(screen.getByRole('tab', { name: /其它待补全文件/ }))
    await waitFor(() => {
      expect(videoTab.classList.contains('hidden')).toBe(true)
      expect(envTab.classList.contains('hidden')).toBe(false)
    })

    // 点击统计卡片「待补长视频」切回长视频 Tab
    fireEvent.click(screen.getByText('待补长视频'))
    await waitFor(() => {
      expect(videoTab.classList.contains('hidden')).toBe(false)
      expect(envTab.classList.contains('hidden')).toBe(true)
    })

    // 点击统计卡片「其它待补缺口」切换到能力恢复 Tab
    fireEvent.click(screen.getByText('其它待补缺口'))
    await waitFor(() => {
      expect(videoTab.classList.contains('hidden')).toBe(true)
      expect(envTab.classList.contains('hidden')).toBe(false)
    })
  })

  it('V-08: 单一 Tab 无数据时，展示对应的轻量空态卡片', async () => {
    // 仅有视频，无其它文件
    mockFetchRecovery.mockResolvedValueOnce({
      success: true,
      items: []
    })

    render(<WorkspacePendingBackfillTab workspace={workspace} isActive={true} />)

    await waitFor(() => {
      expect(screen.getByText('长视频切片补全')).toBeTruthy()
    })

    // 切换到其它待补全文件 Tab
    fireEvent.click(screen.getByRole('tab', { name: /其它待补全文件/ }))
    await waitFor(() => {
      expect(screen.getByTestId('pending-backfill-env-empty')).toBeTruthy()
      expect(
        screen.getByText('当前目录暂无其它环境恢复或缺失正文/OCR/转录的待补文件。')
      ).toBeTruthy()
    })
  })
})
