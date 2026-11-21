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
  },
  getLocalWorkflows: vi.fn().mockResolvedValue({
    success: true,
    data: [{ id: 'wf-photo', name: '创意图库整理' }]
  })
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
import {
  SettingsCategory,
  DEFAULT_UNBOUND_AI_CONFIG,
  type WorkspaceDirectory
} from '@firefly/types'

/** 构造一份 ready 工作区配置（默认无自定义、无绑定） */
const makeReadyConfig = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    schemaVersion: 1,
    status: 'ready',
    policyVersion: 1,
    baseAIConfig: { ...DEFAULT_UNBOUND_AI_CONFIG },
    customExcludeRules: [],
    customIncludeRules: [],
    configuredAt: Date.now(),
    ...extra
  })

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

  describe('当前工作区配置状态卡（默认 | 工作流 | 自定义 三层闭环）', () => {
    const readyWorkspace = (config: Record<string, unknown>): WorkspaceDirectory => ({
      ...mockWorkspace,
      workspace_config: makeReadyConfig(config)
    })

    it('ready 但未绑定且无自定义：显示「未绑定工作流，当前为全局默认配置」，不误报自定义', () => {
      render(
        <MemoryRouter>
          <DirectoryHeader
            {...baseProps}
            currentWorkspaceDirectory={readyWorkspace({})}
            workspaceDirectories={[readyWorkspace({})]}
          />
        </MemoryRouter>
      )

      expect(screen.getByText('未绑定工作流，当前为全局默认配置')).toBeDefined()
      expect(screen.queryByText(/自定义分析方式/)).toBeNull()
      expect(screen.queryByText(/项自定义配置/)).toBeNull()
      expect(screen.getByRole('button', { name: /工作流向导/ })).toBeDefined()
    })

    it('绑定工作流（配置附加名优先）：显示「已绑定工作流：xxx」，按钮变为「重新绑定工作流」', () => {
      const bound = readyWorkspace({ workflowId: 'wf-123', workflowName: '设计稿整理' })
      render(
        <MemoryRouter>
          <DirectoryHeader
            {...baseProps}
            currentWorkspaceDirectory={bound}
            workspaceDirectories={[bound]}
          />
        </MemoryRouter>
      )

      expect(screen.getByText('已绑定工作流：设计稿整理')).toBeDefined()
      expect(screen.getByRole('button', { name: /重新绑定工作流/ })).toBeDefined()
      expect(screen.queryByRole('button', { name: /^工作流向导$/ })).toBeNull()
    })

    it('绑定工作流但配置未带名称：按 id 反查本地工作流列表兜底显示名称', async () => {
      const bound = readyWorkspace({ workflowId: 'wf-photo' })
      render(
        <MemoryRouter>
          <DirectoryHeader
            {...baseProps}
            currentWorkspaceDirectory={bound}
            workspaceDirectories={[bound]}
          />
        </MemoryRouter>
      )

      await act(async () => {
        await Promise.resolve()
      })
      expect(screen.getByText('已绑定工作流：创意图库整理')).toBeDefined()
    })

    it('等值回退不算自定义；存在真正偏离基线的覆盖项时显示自定义配置数', () => {
      // videoQuotaMax 等于基线 24 → 不算自定义；extractPages 由 3 改为 9 → 算 1 项
      const customized = readyWorkspace({
        workflowId: 'wf-123',
        workflowName: '设计稿整理',
        overrides: { videoQuotaMax: 24, extractPages: 9 }
      })
      render(
        <MemoryRouter>
          <DirectoryHeader
            {...baseProps}
            currentWorkspaceDirectory={customized}
            workspaceDirectories={[customized]}
          />
        </MemoryRouter>
      )

      expect(screen.getByText('另有 1 项自定义配置')).toBeDefined()
    })
  })
})
