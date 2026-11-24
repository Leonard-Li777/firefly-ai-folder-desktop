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

// Mock window.PointerEvent for JSDOM
if (typeof window.PointerEvent === 'undefined') {
  ;(window as any).PointerEvent = class PointerEvent extends MouseEvent {}
}

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

vi.mock('../../../lib/posthog', () => ({ captureEvent: vi.fn() }))

import { DirectoryHeader } from '../DirectoryHeader'
import { useSearchStore } from '../../../stores/search-store'
import { useLayoutSwitcherStore } from '../../../stores/layout-switcher-store'
import { PAGE_IDS, LAYOUT_KEYS } from '../layout-switcher'
import type { WorkspaceDirectory } from '@firefly/types'

describe('DirectoryHeader (LayoutSwitcherButtons & LayoutActionSlot 恒定槽位)', () => {
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
    onAddWorkspaceDirectory: vi.fn(),
    dropdownRef: { current: null },
    onSearch: vi.fn()
  }

  beforeEach(() => {
    localStorage.clear()
    act(() => {
      useSearchStore.getState().setIsSearchOverlayOpen(false)
      useLayoutSwitcherStore.getState().resetAll()
    })
    vi.clearAllMocks()
  })

  it('AC-1: organize 下未打开搜索浮层时，槽位包装器恒定存在但按钮组物理不存在', () => {
    render(
      <MemoryRouter>
        <DirectoryHeader {...mockProps} layoutPageId={undefined} />
      </MemoryRouter>
    )

    // 槽位包装器必须存在
    const slot = screen.getByTestId('layout-action-slot')
    expect(slot).toBeDefined()
    // 防腐断言：严禁挂载 @container/*（container-type: inline-size），避免 flex 项固有宽度坍缩为 0px 导致按钮组溢出窗口
    expect(slot.className).not.toContain('@container/')
    expect(slot.className).toContain('shrink-0')

    // 按钮组必须物理不存在
    expect(screen.queryByTestId('layout-switcher-group')).toBeNull()
  })

  it('AC-1: organize 打开搜索浮层时水合为 search-overlay，槽位结构恒定且按钮组挂载', () => {
    const { rerender } = render(
      <MemoryRouter>
        <DirectoryHeader {...mockProps} layoutPageId={undefined} />
      </MemoryRouter>
    )

    const slotBefore = screen.getByTestId('layout-action-slot')
    const classNameBefore = slotBefore.className
    expect(screen.queryByTestId('layout-switcher-group')).toBeNull()

    // 打开搜索浮层
    act(() => {
      useSearchStore.getState().setIsSearchOverlayOpen(true)
    })

    rerender(
      <MemoryRouter>
        <DirectoryHeader {...mockProps} layoutPageId={undefined} />
      </MemoryRouter>
    )

    const slotAfter = screen.getByTestId('layout-action-slot')
    expect(slotAfter.className).toBe(classNameBefore)

    // 按钮组挂载，且当前激活为默认全横排
    const group = screen.getByTestId('layout-switcher-group')
    expect(group).toBeDefined()

    // 激活项为 all-row
    const allRowBtn = screen.getByTestId(`layout-btn-${LAYOUT_KEYS.ALL_ROW}`)
    expect(allRowBtn.getAttribute('aria-pressed')).toBe('true')
  })

  it('AC-3: 在 real-directory 下常用区渲染 3 项，当前激活项在首位并高亮', () => {
    render(
      <MemoryRouter>
        <DirectoryHeader {...mockProps} layoutPageId={PAGE_IDS.REAL_DIRECTORY} />
      </MemoryRouter>
    )

    const group = screen.getByTestId('layout-switcher-group')
    expect(group).toBeDefined()

    // 默认全横排高亮
    const activeBtn = screen.getByTestId(`layout-btn-${LAYOUT_KEYS.ALL_ROW}`)
    expect(activeBtn.getAttribute('aria-pressed')).toBe('true')

    // 常用区总共 3 项
    const buttons = group.querySelectorAll('button[data-testid^="layout-btn-"]')
    expect(buttons.length).toBe(3)
  })

  it('AC-4: 下拉菜单 Portal 至 document.body，点击项可完成布局切换', () => {
    render(
      <MemoryRouter>
        <DirectoryHeader {...mockProps} layoutPageId={PAGE_IDS.REAL_DIRECTORY} />
      </MemoryRouter>
    )

    const moreBtn = screen.getByTestId('layout-switcher-more-btn')
    expect(moreBtn).toBeDefined()

    // 点击展开下拉
    fireEvent.click(moreBtn)

    const dropdown = screen.getByTestId('layout-switcher-dropdown')
    expect(dropdown).toBeDefined()
    expect(dropdown.parentElement).toBe(document.body)

    // 点击三宫格 tri
    const triItem = screen.getByTestId(`dropdown-item-${LAYOUT_KEYS.TRI}`)
    fireEvent.click(triItem)

    // 下拉应自动关闭
    expect(screen.queryByTestId('layout-switcher-dropdown')).toBeNull()

    // store 中当前页面布局应已变为 tri
    expect(useLayoutSwitcherStore.getState().getLayoutKey(PAGE_IDS.REAL_DIRECTORY)).toBe(
      LAYOUT_KEYS.TRI
    )
  })

  it('AC-5: 第二排具备响应式弹性契约，Hub 区域支持等比压缩且布局槽位防挤出 (shrink-0)', () => {
    render(
      <MemoryRouter>
        <DirectoryHeader {...mockProps} layoutPageId={PAGE_IDS.REAL_DIRECTORY} />
      </MemoryRouter>
    )

    // 1. Hub 区域允许等比压缩 (包含 shrink 与 min-w-0)
    const hub = screen.getByTestId('directory-header-hub')
    expect(hub).toBeDefined()
    expect(hub.className).toContain('shrink')
    expect(hub.className).toContain('min-w-0')

    // 2. 布局按钮槽位具备 shrink-0，避免宽度不足时被挤压或溢出
    const slot = screen.getByTestId('layout-action-slot')
    expect(slot).toBeDefined()
    expect(slot.className).toContain('shrink-0')

    // 3. 布局按钮组常用区外部 3 个按钮保持常驻可见，不被响应式断点隐藏
    const group = screen.getByTestId('layout-switcher-group')
    const buttons = group.querySelectorAll('button[data-testid^="layout-btn-"]')
    expect(buttons.length).toBe(3)
    buttons.forEach(btn => {
      expect(btn.className).not.toContain('max-[879px]:hidden')
    })
  })

  it('AC-6: 导出页面 (/virtual-directory/export) 禁用布局切换器，不显示布局按钮组', () => {
    render(
      <MemoryRouter initialEntries={['/virtual-directory/export']}>
        <DirectoryHeader {...mockProps} layoutPageId={PAGE_IDS.VIRTUAL_DIRECTORY} />
      </MemoryRouter>
    )

    // 槽位包装器恒定存在以杜绝抖动，但布局按钮组不渲染
    const slot = screen.getByTestId('layout-action-slot')
    expect(slot).toBeDefined()
    expect(screen.queryByTestId('layout-switcher-group')).toBeNull()
  })
})
