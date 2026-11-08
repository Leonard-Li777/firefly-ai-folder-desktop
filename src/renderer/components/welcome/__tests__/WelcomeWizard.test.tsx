// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

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
      },
      activeLanguage: 'zh-CN',
      changeLanguage: vi.fn()
    })
  }
})

vi.mock('../../lib/posthog', () => ({
  captureEvent: vi.fn()
}))

vi.mock('@stores/config-store', () => ({
  useWelcomeStore: {
    getState: () => ({
      completeSetup: vi.fn().mockResolvedValue(true)
    })
  }
}))

vi.mock('@stores/settings-store', () => ({
  useSettingsStore: () => ({
    getConfigValue: vi.fn(() => 'zh-CN'),
    updateConfigValue: vi.fn().mockResolvedValue(true)
  })
}))

vi.mock('../common/Header', () => ({
  Header: () => <div data-testid="mock-header">Header</div>
}))

import { WelcomeWizard } from '../WelcomeWizard'

describe('WelcomeWizard 两步流转测试 (Ticket 02)', () => {
  beforeEach(() => {
    ;(window as any).electronAPI = {
      detectSystemResources: vi.fn().mockResolvedValue({
        totalMemGB: 16,
        totalMemMB: 16384,
        gpuName: 'NVIDIA RTX 4070',
        vramGB: 8,
        isGpuSupported: true,
        storageFreeGB: 50
      }),
      modularResource: {
        install: vi.fn().mockResolvedValue({ id: 'mock', install_state: 'active' }),
        smokeTest: vi.fn().mockResolvedValue({ success: true, latency_ms: 100 }),
        updateState: vi.fn().mockResolvedValue({ id: 'mock', install_state: 'active' }),
        abortAll: vi.fn().mockResolvedValue(true),
        onProgress: vi.fn(() => () => {})
      }
    }
  })

  it('初始进入 Step 1 语言选择，点击下一步顺利过渡到 Step 2 插件装配', async () => {
    render(<WelcomeWizard onComplete={vi.fn()} />)

    // Step 1 渲染
    expect(screen.getByText('欢迎使用 - 初始设置')).toBeDefined()
    expect(screen.getByText('继续')).toBeDefined()

    // 点击继续进入 Step 2
    const nextBtn = screen.getByText('继续')
    fireEvent.click(nextBtn)

    // Step 2 渲染
    await waitFor(() => {
      expect(screen.getByText('AI 能力与插件装配')).toBeDefined()
      expect(screen.getByText('物理内存 (RAM)')).toBeDefined()
    })

    // 在 Step 2 点击返回，回到 Step 1
    const backBtn = screen.getByText('返回')
    fireEvent.click(backBtn)

    expect(screen.getByText('欢迎使用 - 初始设置')).toBeDefined()
  })
})
