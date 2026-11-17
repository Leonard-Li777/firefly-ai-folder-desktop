// @vitest-environment jsdom
/**
 * Footer 节能胶囊与 Hover 透视看板组件测试 (Ticket 12)
 * 遵循 L3 规格书: docs/specs/unified-module-hibernation-and-energy-transparency-spec.md §3.5 & Ticket 12
 */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@app/languages', () => ({
  t: (str: string, params?: Record<string, any>) => {
    if (!params) return str
    return Object.entries(params).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), str)
  },
  default: {}
}))

vi.mock('../../../languages', () => ({
  t: (str: string, params?: Record<string, any>) => {
    if (!params) return str
    return Object.entries(params).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), str)
  },
  default: {}
}))

vi.mock('../Toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn()
  }
}))

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { EnergyTransparencyBadge } from '../EnergyTransparencyBadge'
import { useHibernationStore } from '../../../stores/hibernation-store'
import { HibernationSnapshot } from '../../../../electron/runtime-services/hibernation/types'
import { toast } from '../Toast'

describe('Ticket 12: Footer 节能胶囊与 Hover 透视看板组件', () => {
  const initialHibernatedSnapshot: HibernationSnapshot = {
    enabled: true,
    isEnergySaving: true,
    totalResidentRamBytes: 380 * 1024 * 1024,
    totalResidentVramBytes: 0,
    totalSavedRamBytes: 315 * 1024 * 1024,
    totalSavedVramBytes: 1800 * 1024 * 1024,
    availableMemoryBytes: 2.1 * 1024 * 1024 * 1024,
    hasUncertainMemoryModules: false,
    hasUncertainVramModules: false,
    uncertainKinds: [],
    modules: [
      {
        id: 'asr-sensevoice-onnx',
        clusterId: 'analysis_suite',
        modelGeneration: 1,
        defaultMemoryKind: 'ram',
        effectiveMemoryKind: 'ram',
        i18nNameKey: '语音识别与字幕提取',
        availability: 'approved',
        state: 'resident',
        residentBytes: 250 * 1024 * 1024,
        lastActiveTimestamp: Date.now(),
        crashStreak: 0,
        unloadFailStreak: 0,
        blockedUnloadNoHandle: 0,
        blockedUnloadIdentity: null,
        activeTasks: 0
      },
      {
        id: 'pocket-cpu-int8-onnx',
        clusterId: 'analysis_suite',
        modelGeneration: 1,
        defaultMemoryKind: 'ram',
        effectiveMemoryKind: 'ram',
        i18nNameKey: '轻量CPU引擎',
        availability: 'draft',
        state: 'resident',
        residentBytes: 380 * 1024 * 1024,
        lastActiveTimestamp: Date.now(),
        crashStreak: 0,
        unloadFailStreak: 0,
        blockedUnloadNoHandle: 0,
        blockedUnloadIdentity: null,
        activeTasks: 0
      },
      {
        id: 'firefly-ai-engine',
        clusterId: 'analysis_suite',
        modelGeneration: 1,
        defaultMemoryKind: 'vram',
        effectiveMemoryKind: 'vram',
        i18nNameKey: '萤核AI引擎',
        availability: 'approved',
        state: 'hibernated',
        residentBytes: 0,
        lastReleased: {
          releaseId: 'rel-1',
          bytes: 1800 * 1024 * 1024,
          kind: 'vram',
          modelGeneration: 1,
          state: 'available',
          releasedAt: Date.now()
        },
        lastActiveTimestamp: Date.now(),
        crashStreak: 0,
        unloadFailStreak: 0,
        blockedUnloadNoHandle: 0,
        blockedUnloadIdentity: null,
        activeTasks: 0
      },
      {
        id: 'tts-m5-onnx',
        clusterId: 'tts_media',
        modelGeneration: 1,
        defaultMemoryKind: 'ram',
        effectiveMemoryKind: 'ram',
        i18nNameKey: '极速语音朗读',
        availability: 'approved',
        state: 'hibernated',
        residentBytes: 0,
        lastReleased: {
          releaseId: 'rel-2',
          bytes: 315 * 1024 * 1024,
          kind: 'ram',
          modelGeneration: 1,
          state: 'available',
          releasedAt: Date.now()
        },
        lastActiveTimestamp: Date.now(),
        crashStreak: 0,
        unloadFailStreak: 0,
        blockedUnloadNoHandle: 0,
        blockedUnloadIdentity: null,
        activeTasks: 0
      }
    ]
  }

  beforeEach(() => {
    act(() => {
      useHibernationStore.setState({
        snapshot: initialHibernatedSnapshot,
        loading: false,
        isReclaiming: false,
        lastReclaimedBytes: null,
        error: null,
        isSubscribed: false
      })
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('处于节能状态时，宽屏徽章展示节能中文案与休眠模块计数', () => {
    render(<EnergyTransparencyBadge />)
    expect(screen.getByText(/节能中 · 2个模块已休眠/)).toBeDefined()
  })

  it('全部驻留无休眠时，展示运行中文案', () => {
    act(() => {
      useHibernationStore.setState({
        snapshot: {
          ...initialHibernatedSnapshot,
          isEnergySaving: false,
          totalSavedRamBytes: 0,
          totalSavedVramBytes: 0,
          modules: initialHibernatedSnapshot.modules.map(m => ({
            ...m,
            state: 'resident' as const
          }))
        }
      })
    })

    render(<EnergyTransparencyBadge />)
    expect(screen.getByText(/⚡ 运行中/)).toBeDefined()
  })

  it('点击胶囊展开透视看板，完整展示分栏与电脑当前剩余内存', () => {
    render(<EnergyTransparencyBadge />)
    const button = screen.getByTestId('energy-badge-trigger')
    fireEvent.click(button)

    // 标题栏与内存
    expect(screen.getByText('系统内存与能耗管理')).toBeDefined()
    expect(screen.getByText(/电脑当前剩余内存/)).toBeDefined()
    expect(screen.getByText('(已触发智能休眠保护)')).toBeDefined()

    // 正在内存运行分栏（草稿态模块被过滤，仅展示 approved 运行模块）
    expect(screen.getByText('正在内存运行')).toBeDefined()
    expect(screen.getByText(/语音识别与字幕提取/)).toBeDefined()
    expect(screen.queryByText(/轻量CPU引擎/)).toBeNull()

    // 已休眠节能分栏（标准命名对齐 萤核AI引擎，并展示已释放标签与合计释放）
    expect(screen.getByText('已休眠节能')).toBeDefined()
    expect(screen.getByText(/萤核AI引擎/)).toBeDefined()
    expect(screen.getByText(/极速语音朗读/)).toBeDefined()
    expect(screen.getByText(/合计释放: 约/)).toBeDefined()
    expect(screen.getAllByText(/已释放/).length).toBeGreaterThanOrEqual(2)

    // 一键释放按钮
    expect(screen.getByText('一键释放可休眠内存')).toBeDefined()
  })

  it('当存在异常模块时，展示运行异常分栏并提供重试修复按钮', async () => {
    const errorSnapshot: HibernationSnapshot = {
      ...initialHibernatedSnapshot,
      modules: [
        ...initialHibernatedSnapshot.modules,
        {
          id: 'tts-moss-onnx',
          clusterId: 'tts_media',
          modelGeneration: 1,
          defaultMemoryKind: 'ram',
          effectiveMemoryKind: 'ram',
          i18nNameKey: '个性化声音克隆',
          availability: 'approved',
          state: 'error',
          lastFailureKind: 'unload',
          residentBytes: 450 * 1024 * 1024,
          lastActiveTimestamp: Date.now(),
          crashStreak: 0,
          unloadFailStreak: 1,
          blockedUnloadNoHandle: 0,
          blockedUnloadIdentity: null,
          activeTasks: 0
        }
      ]
    }

    const mockRetry = vi.fn().mockResolvedValue(true)
    act(() => {
      useHibernationStore.setState({
        snapshot: errorSnapshot,
        retryModule: mockRetry
      })
    })

    render(<EnergyTransparencyBadge />)
    fireEvent.click(screen.getByTestId('energy-badge-trigger'))

    expect(screen.getByText(/运行异常 \(点击可重试\)/)).toBeDefined()
    expect(screen.getByText(/个性化声音克隆/)).toBeDefined()

    const retryBtn = screen.getByRole('button', { name: /重试/ })
    await act(async () => {
      fireEvent.click(retryBtn)
    })

    expect(mockRetry).toHaveBeenCalledWith('tts-moss-onnx')
    expect(toast.success).toHaveBeenCalledWith('重试成功')
  })

  it('点击一键释放可休眠内存，触发 reclaimAll 并弹出成功提示', async () => {
    const mockReclaim = vi.fn().mockResolvedValue({
      success: true,
      releasedBytes: 380 * 1024 * 1024
    })

    act(() => {
      useHibernationStore.setState({
        reclaimAll: mockReclaim
      })
    })

    render(<EnergyTransparencyBadge />)
    fireEvent.click(screen.getByTestId('energy-badge-trigger'))

    const reclaimBtn = screen.getByRole('button', { name: /一键释放可休眠内存/ })
    await act(async () => {
      fireEvent.click(reclaimBtn)
    })

    expect(mockReclaim).toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledWith('已释放约 380 MB 内存')
  })

  it('当存在未决异常时，展示大白话确认中提示', () => {
    act(() => {
      useHibernationStore.setState({
        snapshot: {
          ...initialHibernatedSnapshot,
          hasUncertainMemoryModules: true,
          uncertainKinds: ['ram']
        }
      })
    })

    render(<EnergyTransparencyBadge />)
    fireEvent.click(screen.getByTestId('energy-badge-trigger'))

    expect(screen.getByText('部分内存占用正在确认中')).toBeDefined()
  })
})
