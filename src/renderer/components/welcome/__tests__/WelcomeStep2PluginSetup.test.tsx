// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

vi.mock('@voerkai18n/react', async importOriginal => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    useVoerkaI18n: () => ({
      t: (str: string, vars?: any) => {
        if (!vars) return str
        let res = str
        for (const [k, v] of Object.entries(vars)) {
          res = res.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
        }
        return res
      }
    })
  }
})

vi.mock('../../lib/posthog', () => ({
  captureEvent: vi.fn()
}))

import { WelcomeStep2PluginSetup } from '../WelcomeStep2PluginSetup'

describe('WelcomeStep2PluginSetup (Ticket 02: 欢迎向导自适应装配与强门禁)', () => {
  let mockDetectSystemResources: any
  let mockInstall: any
  let mockSmokeTest: any
  let mockUpdateState: any
  let mockAbortAll: any
  let mockImportOfflinePackage: any
  let mockOnProgress: any

  beforeEach(() => {
    mockDetectSystemResources = vi.fn().mockResolvedValue({
      totalMemGB: 16,
      totalMemMB: 16384,
      gpuName: 'NVIDIA RTX 4070',
      vramGB: 8,
      isGpuSupported: true,
      storageFreeGB: 50
    })
    mockInstall = vi.fn().mockResolvedValue({ id: 'mock', install_state: 'active' })
    mockSmokeTest = vi.fn().mockResolvedValue({ success: true, latency_ms: 120 })
    mockUpdateState = vi.fn().mockResolvedValue({ id: 'mock', install_state: 'active' })
    mockAbortAll = vi.fn().mockResolvedValue(true)
    mockImportOfflinePackage = vi.fn().mockResolvedValue({ id: 'engine_gemma_unified', capability_slot: 'base_embedding' })
    mockOnProgress = vi.fn(() => () => {})
    ;(window as any).electronAPI = {
      detectSystemResources: mockDetectSystemResources,
      modularResource: {
        install: mockInstall,
        smokeTest: mockSmokeTest,
        updateState: mockUpdateState,
        abortAll: mockAbortAll,
        importOfflinePackage: mockImportOfflinePackage,
        onProgress: mockOnProgress
      }
    }
  })

  it('硬件自适应推荐：RAM ≥ 8GB 时默认推荐并高亮 Gemma Unified', async () => {
    mockDetectSystemResources.mockResolvedValueOnce({
      totalMemGB: 16,
      totalMemMB: 16384,
      gpuName: 'NVIDIA RTX 4070',
      vramGB: 8,
      isGpuSupported: true,
      storageFreeGB: 50
    })

    render(<WelcomeStep2PluginSetup onBack={vi.fn()} onComplete={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('16 GB')).toBeDefined()
    })

    expect(screen.getByText('推荐档位：高智能全能版（理解更深入）')).toBeDefined()
    // 默认精确体积计算 (Gemma + NSFW + ASR + TTS) = 653.6 MiB
    expect(screen.getByText('653.6 MiB')).toBeDefined()
  })

  it('硬件自适应推荐：RAM < 8GB 时默认推荐 Classic Light 且去重体积精确对齐', async () => {
    mockDetectSystemResources.mockResolvedValueOnce({
      totalMemGB: 4,
      totalMemMB: 4096,
      gpuName: 'Intel UHD Graphics',
      vramGB: 0,
      isGpuSupported: false,
      storageFreeGB: 30
    })

    render(<WelcomeStep2PluginSetup onBack={vi.fn()} onComplete={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('4 GB')).toBeDefined()
    })

    expect(screen.getByText('轻量档位：极速轻巧版（低配电脑秒开）')).toBeDefined()
    // RAM < 8GB 时，ASR 与 TTS 默认关闭，仅选 Classic Light (304.4) + NSFW (20.9) = 325.4 MiB (去重精确)
    expect(screen.getByText('325.4 MiB')).toBeDefined()
  })

  it('去重精确求和：仅选必装档位时的精准体积断言 (Gemma 242.2 MiB vs Classic 304.4 MiB)', async () => {
    mockDetectSystemResources.mockResolvedValueOnce({
      totalMemGB: 16,
      totalMemMB: 16384,
      gpuName: 'NVIDIA RTX 4070',
      vramGB: 8,
      isGpuSupported: true,
      storageFreeGB: 50
    })

    render(<WelcomeStep2PluginSetup onBack={vi.fn()} onComplete={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('16 GB')).toBeDefined()
    })

    // 取消所有推荐选配项，仅保留 Gemma Unified
    const nsfwBox = screen.getByText('私密与敏感照片识别')
    fireEvent.click(nsfwBox)
    const asrBox = screen.getByText('音视频转字幕与语音搜索')
    fireEvent.click(asrBox)
    const ttsBox = screen.getByText('离线语音朗读')
    fireEvent.click(ttsBox)

    // Gemma 仅自身体积: 242.2 MiB (卡片 Badge 与底部汇总各出现一次)
    expect(screen.getAllByText('242.2 MiB').length).toBe(2)

    // 切换至 Classic Light
    const classicBtn = screen.getByText('极速轻巧引擎（老电脑首选）')
    fireEvent.click(classicBtn)

    // Classic 仅自身体积: 304.4 MiB (卡片 Badge 与底部汇总各出现一次)
    expect(screen.getAllByText('304.4 MiB').length).toBe(2)

    // 勾选全部可选插件 (Classic + NSFW + ASR + TTS 去重求和): 715.8 MiB
    fireEvent.click(nsfwBox)
    fireEvent.click(asrBox)
    fireEvent.click(ttsBox)
    expect(screen.getByText('715.8 MiB')).toBeDefined()
  })

  it('ENOSPC Guard 磁盘门禁：磁盘剩余空间 < 2.0GB 时禁用安装按钮并展示告警', async () => {
    mockDetectSystemResources.mockResolvedValueOnce({
      totalMemGB: 16,
      totalMemMB: 16384,
      gpuName: 'NVIDIA RTX 4070',
      vramGB: 8,
      isGpuSupported: true,
      storageFreeGB: 1.2 // < 2.0GB
    })

    render(<WelcomeStep2PluginSetup onBack={vi.fn()} onComplete={vi.fn()} />)

    await waitFor(() => {
      expect(
        screen.getByText('磁盘剩余空间不足，请至少预留 2GB 空间以供下载与安装')
      ).toBeDefined()
    })

    const startBtn = screen.getByText('开启 Firefly')
    expect(startBtn.closest('button')?.disabled).toBe(true)
  })

  it('必装就绪放行强门禁：基础引擎自检通过前阻断进入主界面，自检通过后放行', async () => {
    const onCompleteMock = vi.fn()

    render(<WelcomeStep2PluginSetup onBack={vi.fn()} onComplete={onCompleteMock} />)

    await waitFor(() => {
      expect(screen.getByText('16 GB')).toBeDefined()
    })

    const startBtn = screen.getByText('开启 Firefly')
    await act(async () => {
      fireEvent.click(startBtn)
    })

    // 验证调用了 install 与 smokeTest
    expect(mockInstall).toHaveBeenCalledWith('engine_gemma_unified')
    expect(mockSmokeTest).toHaveBeenCalledWith({ profile: 'gemma_unified' })
    expect(mockUpdateState).toHaveBeenCalledWith('engine_gemma_unified', { active: true })

    // 基础引擎就绪后，“立即进入主界面”按钮出现且可用
    const enterBtn = screen.getByText('立即进入主界面')
    expect(enterBtn.closest('button')?.disabled).toBe(false)

    fireEvent.click(enterBtn)
    expect(onCompleteMock).toHaveBeenCalledTimes(1)
  })

  it('脱机网络强中断互斥：点击导入离线插件包时调用 abortAll() 与 importOfflinePackage()', async () => {
    window.alert = vi.fn()

    render(<WelcomeStep2PluginSetup onBack={vi.fn()} onComplete={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('16 GB')).toBeDefined()
    })

    const offlineBtn = screen.getByText('导入离线插件包')
    await act(async () => {
      fireEvent.click(offlineBtn)
    })

    expect(mockAbortAll).toHaveBeenCalledTimes(1)
    expect(mockImportOfflinePackage).toHaveBeenCalledTimes(1)
  })
})
