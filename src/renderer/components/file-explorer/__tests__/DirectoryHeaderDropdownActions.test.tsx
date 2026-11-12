// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

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

;(window as any).electronAPI = {
  userTier: {
    getProfile: vi.fn().mockResolvedValue({ tier: 'free', status: 'ACTIVE' })
  },
  utils: {
    isPathEqual: (a: string, b: string) => a === b
  }
}

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

vi.mock('../../../lib/posthog', () => ({ captureEvent: vi.fn() }))

vi.mock('../../../lib/utils', () => ({
  cn: (...args: any[]) => args.filter(Boolean).join(' '),
  MaterialIcon: ({ icon, className }: any) => <span className={className}>{icon}</span>
}))

import { DirectoryHeader } from '../DirectoryHeader'
import { useSettingsStore } from '../../../stores/settings-store'
import { SettingsCategory, type WorkspaceDirectory } from '@firefly/types'

describe('DirectoryHeader 工作目录下拉菜单操作按钮', () => {
  const mockWorkspace: WorkspaceDirectory = {
    id: 42,
    name: '测试工作目录',
    path: 'D:/test-workspace',
    type: 'SPEEDY',
    recursive: true,
    isActive: true
  }

  const baseProps = {
    currentWorkspaceDirectory: mockWorkspace,
    workspaceDirectories: [mockWorkspace],
    showDirectoryDropdown: true,
    isRealDirectory: true,
    onToggleDirectoryDropdown: vi.fn(),
    onSelectWorkspaceDirectory: vi.fn(),
    onAddWorkspaceDirectory: vi.fn(),
    dropdownRef: React.createRef<HTMLDivElement>(),
    onSearch: vi.fn()
  }

  beforeEach(() => {
    vi.clearAllMocks()
    act(() => {
      useSettingsStore.setState({
        isWorkspaceSettingsOpen: false,
        isSystemSettingsOpen: false,
        isOpen: false,
        targetWorkspaceId: null,
        targetWorkspaceTab: null
      })
    })
  })

  it('同时展示「工作流向导」与「工作目录设置」按钮，且不再展示「调整策略」', () => {
    render(
      <MemoryRouter>
        <DirectoryHeader {...baseProps} />
      </MemoryRouter>
    )

    expect(screen.getByRole('button', { name: /工作流向导/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /工作目录设置/ })).toBeDefined()
    expect(screen.queryByText('调整策略')).toBeNull()
  })

  it('点击「工作流向导」时打开工作区向导 (targetTab: wizard) 并关闭下拉菜单', async () => {
    const openSettingsSpy = vi
      .spyOn(useSettingsStore.getState(), 'openSettings')
      .mockResolvedValue()

    render(
      <MemoryRouter>
        <DirectoryHeader {...baseProps} />
      </MemoryRouter>
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /工作流向导/ }))
    })

    expect(baseProps.onToggleDirectoryDropdown).toHaveBeenCalledWith(false)
    expect(openSettingsSpy).toHaveBeenCalledWith(SettingsCategory.WORKSPACE_CONFIG, {
      workspaceId: 42,
      targetTab: 'wizard'
    })
  })

  it('点击「工作目录设置」时打开工作目录设置面板并关闭下拉菜单', async () => {
    const openSettingsSpy = vi
      .spyOn(useSettingsStore.getState(), 'openSettings')
      .mockResolvedValue()

    render(
      <MemoryRouter>
        <DirectoryHeader {...baseProps} />
      </MemoryRouter>
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /工作目录设置/ }))
    })

    expect(baseProps.onToggleDirectoryDropdown).toHaveBeenCalledWith(false)
    expect(openSettingsSpy).toHaveBeenCalledWith(SettingsCategory.WORKSPACE_CONFIG, {
      workspaceId: 42
    })
  })

  it('settings-store 关闭工作目录设置时一并清空 targetWorkspaceTab', async () => {
    await act(async () => {
      await useSettingsStore.getState().openWorkspaceSettings({
        workspaceId: 42,
        targetTab: 'wizard'
      })
    })
    expect(useSettingsStore.getState().targetWorkspaceTab).toBe('wizard')

    await act(async () => {
      await useSettingsStore.getState().closeWorkspaceSettings()
    })
    expect(useSettingsStore.getState().targetWorkspaceId).toBeNull()
    expect(useSettingsStore.getState().targetWorkspaceTab).toBeNull()
  })
})
