// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// Mock ResizeObserver
let resizeCallback: ((entries: any[]) => void) | null = null
global.ResizeObserver = class {
  callback: any
  constructor(cb: any) {
    this.callback = cb
    resizeCallback = cb
  }
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

// Mock electronAPI
;(window as any).electronAPI = {
  userTier: {
    getProfile: vi.fn().mockResolvedValue({ tier: 'free', status: 'ACTIVE' })
  },
  utils: {
    isPathEqual: (a: string, b: string) => a === b,
    normalizePath: (p: string) => p
  }
}

// Mock 语言包
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

// Mock FileList 组件以隔离纯布局树逻辑
vi.mock('../../FileList', () => ({
  FileList: () => <div data-testid="mock-file-list">FileList Content</div>
}))

import { FileExplorerLayout } from '../index'
import { useLayoutSwitcherStore } from '../../../../stores/layout-switcher-store'
import { usePreviewOverlayStore } from '../../../../stores/preview-overlay-store'
import { PAGE_IDS, LAYOUT_KEYS, PANEL_IDS } from '../../layout-switcher'
import type { FileItem } from '@firefly/types'

describe('FileExplorerLayout (恒定两级树拓扑架构与资源静默)', () => {
  const mockFiles: FileItem[] = [
    {
      id: 'f-1',
      name: 'sample.mp4',
      path: 'D:/test/sample.mp4',
      extension: 'mp4',
      size: 1024,
      createdAt: new Date(),
      updatedAt: new Date(),
      isDirectory: false
    }
  ]

  beforeEach(() => {
    localStorage.clear()
    act(() => {
      useLayoutSwitcherStore.getState().resetAll()
      usePreviewOverlayStore.getState().resetForTest?.()
    })
    vi.clearAllMocks()
  })

  it('AC-1: 恒定两级树骨架 - 外层与内层 SplitPane 恒定挂载', () => {
    render(
      <MemoryRouter>
        <FileExplorerLayout files={mockFiles} pageId={PAGE_IDS.REAL_DIRECTORY} />
      </MemoryRouter>
    )

    // 列表主体恒显
    expect(screen.getByTestId('file-list-main')).toBeDefined()

    // 默认 all-row 预设下，预览与属性槽位均挂载激活
    expect(screen.getByTestId('file-preview-slot')).toBeDefined()
    expect(screen.getByTestId('file-details-slot')).toBeDefined()
  })

  it('AC-2: 折叠槽位完全静默 - 关闭面板后槽位 content 为 null，DOM 中无残留', () => {
    render(
      <MemoryRouter>
        <FileExplorerLayout files={mockFiles} pageId={PAGE_IDS.REAL_DIRECTORY} />
      </MemoryRouter>
    )

    // 点击关闭预览按钮
    const previewClose = screen.getByTestId('preview-close-button')
    act(() => {
      fireEvent.click(previewClose)
    })

    // 预览槽位内部应被彻底卸载（content 为 null，无 file-preview-slot）
    expect(screen.queryByTestId('file-preview-slot')).toBeNull()
    // 属性面板依然存在
    expect(screen.getByTestId('file-details-slot')).toBeDefined()

    // 点击关闭属性面板
    const detailsClose = screen.getByTestId('details-close-button')
    act(() => {
      fireEvent.click(detailsClose)
    })

    // 属性面板槽位也彻底卸载
    expect(screen.queryByTestId('file-details-slot')).toBeNull()

    // 列表主体依然绝对保留且恒显
    expect(screen.getByTestId('file-list-main')).toBeDefined()
  })

  it('AC-3: 关预览不调用 clearPreview，preview-overlay-store 保留选定条目', () => {
    act(() => {
      usePreviewOverlayStore
        .getState()
        .openPreview('D:/test/sample.mp4', 'sample.mp4', 'mp4', PAGE_IDS.REAL_DIRECTORY)
    })

    render(
      <MemoryRouter>
        <FileExplorerLayout files={mockFiles} pageId={PAGE_IDS.REAL_DIRECTORY} />
      </MemoryRouter>
    )

    const closeBtn = screen.getByTestId('preview-close-button')
    act(() => {
      fireEvent.click(closeBtn)
    })

    // layout-switcher 标记 preview 关闭
    const visible = useLayoutSwitcherStore.getState().getVisiblePanels(PAGE_IDS.REAL_DIRECTORY)
    expect(visible.includes(PANEL_IDS.PREVIEW)).toBe(false)

    // preview-overlay-store 的页面状态未被破坏
    const pageState = usePreviewOverlayStore.getState().pageStates[PAGE_IDS.REAL_DIRECTORY]
    expect(pageState?.filePath).toBe('D:/test/sample.mp4')
  })

  it('AC-5: 宏观预设切换清空折叠记忆，一键恢复全部面板', () => {
    const { rerender } = render(
      <MemoryRouter>
        <FileExplorerLayout files={mockFiles} pageId={PAGE_IDS.REAL_DIRECTORY} />
      </MemoryRouter>
    )

    // 先关闭详情面板
    act(() => {
      useLayoutSwitcherStore.getState().closePanel(PAGE_IDS.REAL_DIRECTORY, PANEL_IDS.DETAILS)
    })
    rerender(
      <MemoryRouter>
        <FileExplorerLayout files={mockFiles} pageId={PAGE_IDS.REAL_DIRECTORY} />
      </MemoryRouter>
    )
    expect(screen.queryByTestId('file-details-slot')).toBeNull()

    // 切换到 tri 预设（一键恢复预设所包含的所有面板）
    act(() => {
      useLayoutSwitcherStore.getState().setPageLayout(PAGE_IDS.REAL_DIRECTORY, LAYOUT_KEYS.TRI)
    })
    rerender(
      <MemoryRouter>
        <FileExplorerLayout files={mockFiles} pageId={PAGE_IDS.REAL_DIRECTORY} />
      </MemoryRouter>
    )

    // 两个伴随面板均恢复可见
    expect(screen.getByTestId('file-preview-slot')).toBeDefined()
    expect(screen.getByTestId('file-details-slot')).toBeDefined()
  })

  it('AC-6: 预设比例纯净性 - 无缓存初次加载时外层与内层均为纯净 flex 比例，杜绝 420:1 溢出', () => {
    render(
      <MemoryRouter>
        <FileExplorerLayout files={mockFiles} pageId={PAGE_IDS.REAL_DIRECTORY} />
      </MemoryRouter>
    )

    const fileListElement = screen.getByTestId('file-list-main')
    const outerSectionDiv = fileListElement.parentElement
    expect(outerSectionDiv).toBeDefined()
    const style = outerSectionDiv?.getAttribute('style') || ''
    // flex-grow 应为纯净小数字比例（如 1 或 1.5），绝对严禁 480/420 这类像素污染值
    const match = style.match(/flex:\s*([\d.]+)/)
    expect(match).not.toBeNull()
    const flexGrow = parseFloat(match![1])
    expect(flexGrow).toBeGreaterThanOrEqual(0.5)
    expect(flexGrow).toBeLessThanOrEqual(3)
  })
})
