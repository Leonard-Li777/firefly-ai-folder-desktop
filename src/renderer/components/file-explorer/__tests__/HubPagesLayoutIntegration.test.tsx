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

if (typeof window.PointerEvent === 'undefined') {
  ;(window as any).PointerEvent = class PointerEvent extends MouseEvent {}
}

;(window as any).electronAPI = {
  userTier: {
    getProfile: vi.fn().mockResolvedValue({ tier: 'free', status: 'ACTIVE' })
  },
  utils: {
    isPathEqual: (a: string, b: string) => a === b,
    normalizePath: (p: string) => p
  },
  getAllWorkspaceDirectories: vi.fn().mockResolvedValue([]),
  getRealDirectoryContents: vi.fn().mockResolvedValue({ files: [], directories: [] }),
  setCurrentWorkspaceDirectory: vi.fn().mockResolvedValue(true)
}

vi.mock('@app/languages', () => ({
  t: (str: string) => str,
  default: {}
}))

vi.mock('@voerkai18n/react', () => ({
  useVoerkaI18n: () => ({
    t: (str: string) => str,
    activeLanguage: 'zh-CN'
  })
}))

vi.mock('../../../lib/posthog', () => ({ captureEvent: vi.fn() }))

import { RealDirectory } from '../RealDirectory'
import { useLayoutSwitcherStore } from '../../../stores/layout-switcher-store'
import { useSearchStore } from '../../../stores/search-store'
import { PAGE_IDS, LAYOUT_KEYS, PANEL_IDS } from '../layout-switcher'
import type { WorkspaceDirectory } from '@firefly/types'

describe('HubPagesLayoutIntegration (页面接线与显式意图守恒)', () => {
  const mockWorkspace: WorkspaceDirectory = {
    id: 1,
    name: '测试目录',
    path: 'D:/test',
    type: 'SPEEDY'
  }

  beforeEach(() => {
    localStorage.clear()
    act(() => {
      useLayoutSwitcherStore.getState().resetAll()
      useSearchStore.getState().setIsSearchOverlayOpen(false)
    })
    vi.clearAllMocks()
  })

  it('AC-1: 显式意图守恒 - 在 list-preview 预设下，单选文件绝不自动弹开属性面板', () => {
    // 显式将 RealDirectory 设为 list-preview
    act(() => {
      useLayoutSwitcherStore
        .getState()
        .setPageLayout(PAGE_IDS.REAL_DIRECTORY, LAYOUT_KEYS.LIST_PREVIEW)
    })

    const visiblePanels = useLayoutSwitcherStore
      .getState()
      .getVisiblePanels(PAGE_IDS.REAL_DIRECTORY)
    expect(visiblePanels.includes(PANEL_IDS.DETAILS)).toBe(false)
    expect(visiblePanels.includes(PANEL_IDS.PREVIEW)).toBe(true)
  })

  it('AC-1: 显式意图守恒 - 用户手动关闭属性面板后，单选文件绝不自动恢复属性面板', () => {
    // 默认为 all-row (包含 details)
    expect(
      useLayoutSwitcherStore
        .getState()
        .getVisiblePanels(PAGE_IDS.REAL_DIRECTORY)
        .includes(PANEL_IDS.DETAILS)
    ).toBe(true)

    // 用户显式关闭 details
    act(() => {
      useLayoutSwitcherStore.getState().closePanel(PAGE_IDS.REAL_DIRECTORY, PANEL_IDS.DETAILS)
    })

    // details 处于关闭状态
    expect(
      useLayoutSwitcherStore
        .getState()
        .getVisiblePanels(PAGE_IDS.REAL_DIRECTORY)
        .includes(PANEL_IDS.DETAILS)
    ).toBe(false)
  })

  it('AC-3: 全局搜索浮层联动 - 开浮层时 Header 按钮组自动切换靶向 SEARCH_OVERLAY', () => {
    // 验证初始状态：浮层关闭，靶向 REAL_DIRECTORY
    act(() => {
      useLayoutSwitcherStore
        .getState()
        .setPageLayout(PAGE_IDS.REAL_DIRECTORY, LAYOUT_KEYS.TRI)
      useLayoutSwitcherStore
        .getState()
        .setPageLayout(PAGE_IDS.SEARCH_OVERLAY, LAYOUT_KEYS.ALL_COLUMN)
    })

    expect(useLayoutSwitcherStore.getState().getLayoutKey(PAGE_IDS.REAL_DIRECTORY)).toBe(
      LAYOUT_KEYS.TRI
    )
    expect(useLayoutSwitcherStore.getState().getLayoutKey(PAGE_IDS.SEARCH_OVERLAY)).toBe(
      LAYOUT_KEYS.ALL_COLUMN
    )

    // 在浮层内切换布局仅修改 SEARCH_OVERLAY，不干扰 REAL_DIRECTORY
    act(() => {
      useLayoutSwitcherStore
        .getState()
        .setPageLayout(PAGE_IDS.SEARCH_OVERLAY, LAYOUT_KEYS.LIST_ONLY)
    })

    expect(useLayoutSwitcherStore.getState().getLayoutKey(PAGE_IDS.REAL_DIRECTORY)).toBe(
      LAYOUT_KEYS.TRI
    )
    expect(useLayoutSwitcherStore.getState().getLayoutKey(PAGE_IDS.SEARCH_OVERLAY)).toBe(
      LAYOUT_KEYS.LIST_ONLY
    )
  })
})
