// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// Mock ResizeObserver & IntersectionObserver
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as any

global.IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as any

// Mock window.electronAPI
;(window as any).electronAPI = {
  userTier: {
    getProfile: vi.fn().mockResolvedValue({ tier: 'free', status: 'ACTIVE' })
  },
  utils: {
    isPathEqual: (a: string, b: string) => a === b
  }
}

// Mock 语言包
vi.mock('@app/languages', () => ({
  t: (str: string, vars?: any) => {
    if (!vars) return str
    let res = str
    for (const [k, v] of Object.entries(vars)) {
      res = res.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
    }
    return res
  },
  default: {}
}))

vi.mock('@voerkai18n/react', () => ({
  useVoerkaI18n: () => ({
    t: (str: string, vars?: any) => {
      if (!vars) return str
      let res = str
      for (const [k, v] of Object.entries(vars)) {
        res = res.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
      }
      return res
    },
    activeLanguage: 'zh-CN'
  })
}))

// Mock posthog 模块
vi.mock('../../../lib/posthog', () => ({ captureEvent: vi.fn() }))

// Mock 全局图标与资源
vi.mock('../../../lib/utils', () => ({
  cn: (...args: any[]) => args.filter(Boolean).join(' '),
  MaterialIcon: ({ icon, className }: any) => <span className={className}>{icon}</span>
}))

import { DirectoryHeader } from '../DirectoryHeader'
import { usePluginCenterStore } from '../../../stores/plugin-center-store'
import type { WorkspaceDirectory } from '@firefly/types'

describe('DirectoryHeader (Hub 区域按钮联动关闭插件中心)', () => {
  const mockWorkspace: WorkspaceDirectory = {
    id: 1,
    name: '测试工作目录',
    path: 'D:/test-workspace',
    type: 'SPEEDY'
  }

  const mockProps = {
    currentWorkspaceDirectory: mockWorkspace,
    workspaceDirectories: [mockWorkspace],
    showDirectoryDropdown: false,
    isRealDirectory: true,
    onToggleDirectoryDropdown: vi.fn(),
    onSelectWorkspaceDirectory: vi.fn(),
    onAddWorkspaceDirectory: vi.fn()
  }

  beforeEach(() => {
    act(() => {
      usePluginCenterStore.getState().resetForTest()
    })
    vi.clearAllMocks()
  })

  it('点击工作目录选择按钮时自动关闭插件中心', () => {
    act(() => {
      usePluginCenterStore.getState().openOverlay()
    })
    expect(usePluginCenterStore.getState().isOverlayOpen).toBe(true)

    render(
      <MemoryRouter>
        <DirectoryHeader {...mockProps} />
      </MemoryRouter>
    )

    // 点击工作目录选择器按钮
    const dirButton = screen.getByTitle(/当前工作目录/)
    fireEvent.click(dirButton)

    // 插件中心应自动关闭
    expect(usePluginCenterStore.getState().isOverlayOpen).toBe(false)
    expect(mockProps.onToggleDirectoryDropdown).toHaveBeenCalled()
  })

  it('点击工作流步骤条 (Stepper) 按钮时自动关闭插件中心', () => {
    act(() => {
      usePluginCenterStore.getState().openOverlay()
    })
    expect(usePluginCenterStore.getState().isOverlayOpen).toBe(true)

    render(
      <MemoryRouter>
        <DirectoryHeader {...mockProps} />
      </MemoryRouter>
    )

    // 点击步骤条中的“整理”或“已分析”步骤
    const stepBtn = screen.getByTitle('整理')
    fireEvent.click(stepBtn)

    // 插件中心应自动关闭
    expect(usePluginCenterStore.getState().isOverlayOpen).toBe(false)
  })

  it('点击 Hub 区域内的任意子项通过捕获阶段均能关闭插件中心', () => {
    act(() => {
      usePluginCenterStore.getState().openOverlay()
    })
    expect(usePluginCenterStore.getState().isOverlayOpen).toBe(true)

    render(
      <MemoryRouter>
        <DirectoryHeader {...mockProps} />
      </MemoryRouter>
    )

    // 点击步骤条中的“虚拟目录”步骤
    const virtualStepBtn = screen.getByTitle('虚拟目录')
    fireEvent.click(virtualStepBtn)

    expect(usePluginCenterStore.getState().isOverlayOpen).toBe(false)
  })
})
