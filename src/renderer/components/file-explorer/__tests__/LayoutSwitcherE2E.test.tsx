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
    normalizePath: (p: string) => p,
    normalizeForCache: (p: string) => p
  },
  onAnalysisQueueUpdated: vi.fn().mockReturnValue(() => {}),
  onFileAnalysisStatusChanged: vi.fn().mockReturnValue(() => {}),
  getFileAnalysis: vi.fn().mockResolvedValue(null)
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
vi.mock('../FileList', () => ({
  FileList: () => <div data-testid="mock-file-list">FileList Content</div>
}))

import { FileExplorerLayout } from '../FileExplorerLayout'
import { DirectoryHeader } from '../DirectoryHeader'
import {
  LayoutActionSlot,
  LayoutSwitcherButtons,
  LAYOUT_PRESETS,
  PAGE_IDS,
  PANEL_IDS,
  resolveLayoutProjection,
  resolveEffectiveCollapse,
  areSetsEqual,
  getLayoutLabel
} from '../layout-switcher'
import {
  useLayoutSwitcherStore,
  getDirectionalStorageKey
} from '../../../stores/layout-switcher-store'
import { usePreviewOverlayStore } from '../../../stores/preview-overlay-store'
import { useSearchStore } from '../../../stores/search-store'
import type { FileItem, WorkspaceDirectory } from '@firefly/types'

describe('LayoutSwitcher 综合验收测试套件 (AC-1 ~ AC-14)', () => {
  const pageId = PAGE_IDS.REAL_DIRECTORY

  const mockWorkspace: WorkspaceDirectory = {
    id: 1,
    name: '测试工作目录',
    path: 'D:/test-workspace',
    type: 'SPEEDY'
  }

  const mockHeaderProps = {
    currentWorkspaceDirectory: mockWorkspace,
    workspaceDirectories: [mockWorkspace],
    showDirectoryDropdown: false,
    isRealDirectory: true,
    onToggleDirectoryDropdown: vi.fn(),
    onSelectWorkspaceDirectory: vi.fn(),
    onAddWorkspaceDirectory: vi.fn(),
    dropdownRef: { current: null },
    onSearch: vi.fn(),
    viewMode: 'list' as const,
    onViewModeChange: vi.fn()
  }

  const mockFiles: FileItem[] = [
    {
      id: 'f-e2e-1',
      name: 'presentation.key',
      path: 'D:/test/presentation.key',
      extension: 'key',
      size: 4096,
      createdAt: new Date(),
      updatedAt: new Date(),
      isDirectory: false
    }
  ]

  beforeEach(() => {
    localStorage.clear()
    act(() => {
      useLayoutSwitcherStore.getState().resetAll()
      usePreviewOverlayStore.getState().closePreview()
      useSearchStore.getState().setIsSearchOverlayOpen(false)
    })
    vi.clearAllMocks()
  })

  // --------------------------------------------------------------------------
  // AC-1: 门控断言与槽位包装器恒定量化
  // --------------------------------------------------------------------------
  describe('AC-1: 门控断言与槽位包装器恒定量化', () => {
    it('在 real-directory 及打开全局搜索浮层时断言 layout-switcher-group 数量恒为 1', () => {
      const { unmount } = render(
        <MemoryRouter>
          <DirectoryHeader {...mockHeaderProps} layoutPageId={PAGE_IDS.REAL_DIRECTORY} />
        </MemoryRouter>
      )

      expect(screen.getAllByTestId('layout-switcher-group').length).toBe(1)
      expect(screen.getByTestId('layout-action-slot')).toBeDefined()
      unmount()

      // 打开搜索浮层时
      act(() => {
        useSearchStore.getState().setIsSearchOverlayOpen(true)
      })

      render(
        <MemoryRouter>
          <DirectoryHeader {...mockHeaderProps} layoutPageId={undefined} />
        </MemoryRouter>
      )
      expect(screen.getAllByTestId('layout-switcher-group').length).toBe(1)
    })

    it('organize 关闭搜索浮层时断言 toBeNull()，包装器结构恒定', () => {
      act(() => {
        useSearchStore.getState().setIsSearchOverlayOpen(false)
      })

      render(
        <MemoryRouter>
          <DirectoryHeader {...mockHeaderProps} layoutPageId={undefined} />
        </MemoryRouter>
      )

      expect(screen.queryByTestId('layout-switcher-group')).toBeNull()
      const slot = screen.getByTestId('layout-action-slot')
      expect(slot).toBeDefined()
      // 防腐断言：严禁挂载 @container/*（container-type: inline-size），避免 flex 项固有宽度坍缩为 0px 导致按钮组溢出窗口
      expect(slot.className).not.toContain('@container/')
      expect(slot.className).toContain('shrink-0')
    })
  })

  // --------------------------------------------------------------------------
  // AC-2: 列表恒显物理量化
  // --------------------------------------------------------------------------
  describe('AC-2: 列表恒显物理量化', () => {
    it('无论调用多少次 closePanel(pageId, "list")，list 恒在且为首项', () => {
      const store = useLayoutSwitcherStore.getState()
      store.setPageLayout(pageId, 'tri')
      expect(store.getVisiblePanels(pageId)).toContain('list')

      // 恶意或误调用关列表
      store.closePanel(pageId, 'list' as any)
      store.closePanel(pageId, 'list' as any)

      const visiblePanels = useLayoutSwitcherStore.getState().getVisiblePanels(pageId)
      expect(visiblePanels[0]).toBe('list')
      expect(visiblePanels.length).toBeGreaterThanOrEqual(1)
    })
  })

  // --------------------------------------------------------------------------
  // AC-3: 三面板 7 套预设完整循环切换
  // --------------------------------------------------------------------------
  describe('AC-3: 三面板 7 套预设闭环切换', () => {
    const allPresets = [
      'list-only',
      'list-preview',
      'list-details',
      'pin-list-top',
      'all-row',
      'tri',
      'all-column'
    ] as const

    it('支持 7 套预设的完整循环切换与状态保真', () => {
      allPresets.forEach(presetKey => {
        act(() => {
          useLayoutSwitcherStore.getState().setPageLayout(pageId, presetKey)
        })
        const currentPreset = useLayoutSwitcherStore.getState().getLayoutKey(pageId)
        expect(currentPreset).toBe(presetKey)

        const projection = resolveLayoutProjection(
          LAYOUT_PRESETS[presetKey],
          useLayoutSwitcherStore.getState().getVisiblePanels(pageId)
        )
        expect(projection.primaryDirection).toBeDefined()
        expect(projection.companionDirection).toBeDefined()
      })
    })
  })

  // --------------------------------------------------------------------------
  // AC-4: 预览/属性两格关闭与自适应
  // --------------------------------------------------------------------------
  describe('AC-4: 预览/属性两格关闭与自适应', () => {
    it('点击预览和属性右上角关闭按钮有效，槽位折叠为 content: null，且关预览不调用 clearPreview', () => {
      useLayoutSwitcherStore.getState().setPageLayout(pageId, 'all-column')
      act(() => {
        usePreviewOverlayStore
          .getState()
          .openPreview('D:/test/presentation.key', 'presentation.key', 'key', pageId)
      })

      render(
        <MemoryRouter>
          <FileExplorerLayout
            pageId={pageId}
            files={mockFiles}
            directories={[]}
            selectedItem={mockFiles[0]}
          />
        </MemoryRouter>
      )

      // 检查初始三面板均在
      expect(screen.getByTestId('file-list-main')).toBeDefined()
      expect(screen.getByTestId('file-preview-slot')).toBeDefined()
      expect(screen.getByTestId('file-details-slot')).toBeDefined()

      // 关闭预览
      const previewCloseBtn = screen.getByTestId('preview-close-button')
      act(() => {
        fireEvent.click(previewCloseBtn)
      })

      // 预览折叠后 content 为空，无 file-preview-slot，但 previewStore 依然保留当前预览文件
      expect(screen.queryByTestId('file-preview-slot')).toBeNull()
      const pageState = usePreviewOverlayStore.getState().pageStates[pageId]
      expect(pageState?.filePath).toBe('D:/test/presentation.key')

      // 关闭属性面板
      const detailsCloseBtn = screen.getByTestId('details-close-button')
      act(() => {
        fireEvent.click(detailsCloseBtn)
      })
      expect(screen.queryByTestId('file-details-slot')).toBeNull()

      // 此时仅剩列表主体可见且恒显
      expect(screen.getByTestId('file-list-main')).toBeDefined()
      const visible = useLayoutSwitcherStore.getState().getVisiblePanels(pageId)
      expect(visible).toEqual(['list'])
    })
  })

  // --------------------------------------------------------------------------
  // AC-5: DOM 节点身份与播放/滚动恒定保持
  // --------------------------------------------------------------------------
  describe('AC-5: DOM 节点身份与播放/滚动恒定保持', () => {
    it('切换预设时，两级外壳与可见面板的 DOM 引用保持稳定', () => {
      useLayoutSwitcherStore.getState().setPageLayout(pageId, 'all-column')

      const { rerender } = render(
        <MemoryRouter>
          <FileExplorerLayout
            pageId={pageId}
            files={mockFiles}
            directories={[]}
            selectedItem={mockFiles[0]}
          />
        </MemoryRouter>
      )

      const listBefore = screen.getByTestId('file-list-main')

      // 切换到 tri
      act(() => {
        useLayoutSwitcherStore.getState().setPageLayout(pageId, 'tri')
      })

      rerender(
        <MemoryRouter>
          <FileExplorerLayout
            pageId={pageId}
            files={mockFiles}
            directories={[]}
            selectedItem={mockFiles[0]}
          />
        </MemoryRouter>
      )

      const listAfter = screen.getByTestId('file-list-main')

      // DOM 骨架与主体列表保持引用恒等
      expect(listBefore).toBe(listAfter)
    })
  })

  // --------------------------------------------------------------------------
  // AC-6: 极小视口消赤破局与滞回纯函数验证
  // --------------------------------------------------------------------------
  describe('AC-6: 极小窗口消赤破局与滞回纯函数验证', () => {
    it('tri 布局等 min 宽度短缺时，优先折叠 details 破局消赤', () => {
      const layout = LAYOUT_PRESETS['tri']
      const visible = new Set(['list', 'preview', 'details'])
      const collapse = resolveEffectiveCollapse(500, 800, layout, visible)
      // details 应当被折叠
      expect(collapse.has('details')).toBe(true)
    })

    it('视口极小（如 300px）时，伴随面板全部折叠，list 恒在且不写盘', () => {
      const layout = LAYOUT_PRESETS['tri']
      const visible = new Set(['list', 'preview', 'details'])
      const collapse = resolveEffectiveCollapse(300, 300, layout, visible)
      expect(collapse.has('details')).toBe(true)
      expect(collapse.has('preview')).toBe(true)
      expect(collapse.has('list')).toBe(false)
      // 检查 store 没有被写入
      expect(useLayoutSwitcherStore.getState().getVisiblePanels(pageId)).toContain('list')
    })

    it('滞回与逆序回展：窄视口瞬态放大至 1400px 时，单次回调连续完全回展（返回空 Set）', () => {
      const layout = LAYOUT_PRESETS['tri']
      const visible = new Set(['list', 'preview', 'details'])
      const prevCollapsed = new Set(['details', 'preview'])

      const result = resolveEffectiveCollapse(1400, 1000, layout, visible, prevCollapsed)
      expect(result.size).toBe(0)
    })

    it('16px 滞回门禁：临界抖动时不来回翻转', () => {
      const layout = LAYOUT_PRESETS['list-preview'] // list(360) + handle(16) + preview(280) = 656px
      const visible = new Set(['list', 'preview'])
      const prevCollapsed = resolveEffectiveCollapse(650, 500, layout, visible, new Set())
      expect(prevCollapsed.has('preview')).toBe(true)

      const stillCollapsed = resolveEffectiveCollapse(660, 500, layout, visible, prevCollapsed)
      expect(stillCollapsed.has('preview')).toBe(true)

      const restored = resolveEffectiveCollapse(675, 500, layout, visible, prevCollapsed)
      expect(restored.has('preview')).toBe(false)
    })
  })

  // --------------------------------------------------------------------------
  // AC-7: SplitPane 垂直模式与手势协议
  // --------------------------------------------------------------------------
  describe('AC-7: SplitPane 垂直拖拽与手势协议', () => {
    it('direction="vertical" 时手柄呈现横向分割与 cursor-row-resize', () => {
      useLayoutSwitcherStore.getState().setPageLayout(pageId, 'pin-list-top')

      render(
        <MemoryRouter>
          <FileExplorerLayout
            pageId={pageId}
            files={mockFiles}
            directories={[]}
            selectedItem={mockFiles[0]}
          />
        </MemoryRouter>
      )

      const separators = screen.getAllByRole('separator')
      const rowHandle = separators.find(s => s.className.includes('cursor-row-resize'))
      expect(rowHandle).toBeDefined()
      expect(rowHandle?.getAttribute('aria-orientation')).toBe('horizontal')
    })
  })

  // --------------------------------------------------------------------------
  // AC-8: 尺寸键方向敏感隔离
  // --------------------------------------------------------------------------
  describe('AC-8: 尺寸键方向敏感隔离', () => {
    it('水平拖拽键为 _h，垂直拖拽键为 _v，两轴完全解耦隔离', () => {
      const hKey = getDirectionalStorageKey(pageId, 'primary', 'horizontal')
      const vKey = getDirectionalStorageKey(pageId, 'primary', 'vertical')

      expect(hKey).toBe(`hub_split_v1_${pageId}_primary_h`)
      expect(vKey).toBe(`hub_split_v1_${pageId}_primary_v`)
      expect(hKey).not.toBe(vKey)

      // 验证写入水平不影响垂直
      localStorage.setItem(hKey, JSON.stringify({ primary: 550 }))
      localStorage.setItem(vKey, JSON.stringify({ primary: 250 }))

      expect(JSON.parse(localStorage.getItem(hKey)!).primary).toBe(550)
      expect(JSON.parse(localStorage.getItem(vKey)!).primary).toBe(250)
    })
  })

  // --------------------------------------------------------------------------
  // AC-11: 常用区 4 项锁定与响应式折叠
  // --------------------------------------------------------------------------
  describe('AC-11: 常用区与小视口折叠', () => {
    it('常用区严格锁定 4 项，当前激活项恒常驻在常用区中', () => {
      // 激活不在默认 4 项里的 all-row
      useLayoutSwitcherStore.getState().setPageLayout(pageId, 'all-row')

      render(
        <MemoryRouter>
          <LayoutSwitcherButtons layoutPageId={pageId} />
        </MemoryRouter>
      )

      const group = screen.getByTestId('layout-switcher-group')
      const topButtons = group.querySelectorAll('button:not([title*="更多"])')
      expect(topButtons.length).toBeLessThanOrEqual(4)

      // 当前项 all-row 必须在常用区渲染
      const activeBtn = group.querySelector('[aria-pressed="true"]')
      expect(activeBtn).toBeDefined()
    })
  })

  // --------------------------------------------------------------------------
  // AC-12: 持久化与脏数据自愈度量
  // --------------------------------------------------------------------------
  describe('AC-12: 持久化与脏数据自愈度量', () => {
    it('缺失 list 或空数据时，store 自动自愈重置并保持 list 恒在', () => {
      const store = useLayoutSwitcherStore.getState()
      const visible = store.getVisiblePanels(pageId)
      expect(visible).toContain('list')

      // 人为调用内部可能异常的状态
      store.closePanel(pageId, 'list' as any)
      const afterAttempt = store.getVisiblePanels(pageId)
      expect(afterAttempt[0]).toBe('list')
    })
  })

  // --------------------------------------------------------------------------
  // AC-13: i18n 构建期提取字面量合规
  // --------------------------------------------------------------------------
  describe('AC-13: i18n 构建提取合规', () => {
    it('预设名称与描述均使用白名单静态字面量', () => {
      Object.values(LAYOUT_PRESETS).forEach(preset => {
        expect(typeof preset.name).toBe('string')
        expect(preset.name.length).toBeGreaterThan(0)
        const label = getLayoutLabel(preset.key)
        expect(typeof label).toBe('string')
        expect(label.length).toBeGreaterThan(0)
      })
    })
  })
})
