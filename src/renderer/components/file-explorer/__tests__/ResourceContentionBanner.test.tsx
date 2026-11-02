import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ResourceContentionBanner } from '../ResourceContentionBanner'
import { useAnalysisQueueStore } from '../../../stores/analysis-queue-store'
import { useTTSAudioStore } from '../../../stores/tts-audio-store'
import { useOrganizeStore, Stage } from '../../../stores/organize-store'

// Mock 语言包
vi.mock('@app/languages', () => ({
  t: (str: string) => str,
  default: {}
}))

// Mock useUiJank
let mockJanky = false
vi.mock('../../../hooks/useUiJank', () => ({
  useUiJank: () => mockJanky
}))

describe('ResourceContentionBanner (算力争抢提示条)', () => {
  const renderBanner = (initialPath = '/') => {
    return render(
      <MemoryRouter initialEntries={[initialPath]}>
        <ResourceContentionBanner />
      </MemoryRouter>
    )
  }

  beforeEach(() => {
    mockJanky = true
    act(() => {
      useAnalysisQueueStore.setState({
        snapshot: {
          running: true,
          activeRunningWorkspaceId: 'ws-123',
          queueLength: 5,
          totalItems: 10,
          completedItems: 5,
          failedItems: 0,
          status: 'analyzing',
          isPaused: false,
          activeTasks: []
        } as any
      })
      useTTSAudioStore.setState({
        status: 'idle',
        isSynthesizing: false
      })
      useOrganizeStore.setState({
        stage: 'root-mode-select'
      })
    })
  })

  it('条件基础闸：界面不卡顿（janky: false）时不显示', () => {
    mockJanky = false
    act(() => {
      useTTSAudioStore.setState({ isSynthesizing: true })
    })

    const { container } = renderBanner('/')
    expect(container.firstChild).toBeNull()
  })

  it('条件基础闸：分析队列未在跑（queueRunning: false）时不显示', () => {
    act(() => {
      useAnalysisQueueStore.setState({
        snapshot: { running: false, activeRunningWorkspaceId: null } as any
      })
      useTTSAudioStore.setState({ isSynthesizing: true })
    })

    const { container } = renderBanner('/')
    expect(container.firstChild).toBeNull()
  })

  describe('条件 1：语音合成正在进行（无视页面，只要卡顿且队列在跑均显示）', () => {
    it('在普通首页 / 时，底层正在合成（isSynthesizing: true）显示提示条', () => {
      act(() => {
        useTTSAudioStore.setState({ isSynthesizing: true })
      })

      renderBanner('/')
      expect(screen.getByText('检测到界面卡顿，文件分析队列可能占用了较多算力，暂停它可让当前操作更流畅')).toBeDefined()
      expect(screen.getByText('暂停文件分析')).toBeDefined()
    })

    it('在虚拟目录页面 /virtual-directory 时，TTS 处于 playing 状态显示提示条', () => {
      act(() => {
        useTTSAudioStore.setState({ status: 'playing' })
      })

      renderBanner('/virtual-directory')
      expect(screen.getByText('暂停文件分析')).toBeDefined()
    })

    it('在 loading 或 exporting 状态时显示提示条', () => {
      act(() => {
        useTTSAudioStore.setState({ status: 'loading' })
      })
      const { rerender } = render(
        <MemoryRouter initialEntries={['/real-directory']}>
          <ResourceContentionBanner />
        </MemoryRouter>
      )
      expect(screen.getByText('暂停文件分析')).toBeDefined()

      act(() => {
        useTTSAudioStore.setState({ status: 'exporting' })
      })
      rerender(
        <MemoryRouter initialEntries={['/real-directory']}>
          <ResourceContentionBanner />
        </MemoryRouter>
      )
      expect(screen.getByText('暂停文件分析')).toBeDefined()
    })

    it('TTS 为 idle 且未在合成时，普通页面不显示', () => {
      act(() => {
        useTTSAudioStore.setState({ status: 'idle', isSynthesizing: false })
      })

      const { container } = renderBanner('/real-directory')
      expect(container.firstChild).toBeNull()
    })
  })

  describe('条件 2：用户位于批量整理（/organize）且处于指定 stage', () => {
    it('页面位于非 /organize（如 /real-directory），即便 stage 是 organizing 也不显示', () => {
      act(() => {
        useOrganizeStore.setState({ stage: 'organizing' })
      })

      const { container } = renderBanner('/real-directory')
      expect(container.firstChild).toBeNull()
    })

    it('页面位于 /organize 且处于自动归类 stage (organizing) 时显示提示条', () => {
      act(() => {
        useOrganizeStore.setState({ stage: 'organizing' })
      })

      renderBanner('/organize')
      expect(screen.getByText('暂停文件分析')).toBeDefined()
    })

    it('页面位于 /organize 且处于完成 stage (done) 时显示提示条', () => {
      act(() => {
        useOrganizeStore.setState({ stage: 'done' })
      })

      renderBanner('/organize')
      expect(screen.getByText('暂停文件分析')).toBeDefined()
    })

    it('页面位于 /organize 且处于智能聚类 stage (smart-clustering) 时显示提示条', () => {
      act(() => {
        useOrganizeStore.setState({ stage: 'smart-clustering' })
      })

      renderBanner('/organize')
      expect(screen.getByText('暂停文件分析')).toBeDefined()
    })

    it('页面位于 /organize 但处于其它 stage（如 mode-select / batch-rename 等）时不显示', () => {
      const otherStages: Stage[] = [
        'root-mode-select',
        'mode-select',
        'batch-rename',
        'batch-tag',
        'batch-duplicate',
        'candidates',
        'external-ai',
        'custom-tree',
        'structure'
      ]

      for (const stage of otherStages) {
        act(() => {
          useOrganizeStore.setState({ stage })
        })
        const { container } = renderBanner('/organize')
        expect(container.firstChild).toBeNull()
      }
    })
  })

  describe('操作交互：暂停与关闭', () => {
    it('点击暂停按钮触发 analysisQueueStore.pause(activeRunningWorkspaceId)', () => {
      const pauseSpy = vi.fn()
      act(() => {
        useAnalysisQueueStore.setState({
          pause: pauseSpy
        } as any)
        useTTSAudioStore.setState({ isSynthesizing: true })
      })

      renderBanner('/')
      const pauseBtn = screen.getByText('暂停文件分析')
      fireEvent.click(pauseBtn)

      expect(pauseSpy).toHaveBeenCalledWith('ws-123')
    })

    it('点击关闭 (X) 按钮后本次卡顿隐藏，卡顿恢复后重置', () => {
      act(() => {
        useTTSAudioStore.setState({ isSynthesizing: true })
      })

      const { container, rerender } = renderBanner('/')
      expect(screen.getByText('暂停文件分析')).toBeDefined()

      // 点击关闭
      const closeBtn = screen.getByRole('button', { name: '关闭提示' })
      fireEvent.click(closeBtn)
      expect(container.firstChild).toBeNull()

      // 卡顿解除
      mockJanky = false
      rerender(
        <MemoryRouter initialEntries={['/']}>
          <ResourceContentionBanner />
        </MemoryRouter>
      )
      expect(container.firstChild).toBeNull()

      // 再次发生卡顿，提示条重新恢复显示
      mockJanky = true
      rerender(
        <MemoryRouter initialEntries={['/']}>
          <ResourceContentionBanner />
        </MemoryRouter>
      )
      expect(screen.getByText('暂停文件分析')).toBeDefined()
    })
  })
})
