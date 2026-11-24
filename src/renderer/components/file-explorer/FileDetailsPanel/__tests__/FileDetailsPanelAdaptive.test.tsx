// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// Mock window.electronAPI
;(window as any).electronAPI = {
  userTier: {
    getProfile: vi.fn().mockResolvedValue({ tier: 'free', status: 'ACTIVE' })
  },
  utils: {
    isPathEqual: (a: string, b: string) => a === b,
    normalizePath: (p: string) => p
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

import { FileDetailsPanel } from '../index'
import {
  useDetailsCardsStore,
  DETAILS_CARD_IDS,
  clearDetailsCardsMemoryCache
} from '../stores/details-cards-store'
import { PANEL_IDS } from '../../layout-switcher'
import { useLayoutSwitcherStore } from '../../../../stores/layout-switcher-store'
import type { FileItem } from '@firefly/types'

describe('FileDetailsPanel (微宫格四卡片架构与自适应布局)', () => {
  const mockFile: FileItem = {
    id: 'f-details-1',
    name: 'test-document.pdf',
    path: 'D:/test/test-document.pdf',
    extension: 'pdf',
    size: 2048,
    createdAt: new Date(),
    updatedAt: new Date(),
    isDirectory: false
  }

  const mockDir: FileItem = {
    id: 'd-details-1',
    name: 'photos',
    path: 'D:/test/photos',
    size: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    isDirectory: true
  }

  beforeEach(() => {
    localStorage.clear()
    clearDetailsCardsMemoryCache()
    useDetailsCardsStore.setState({ visibleCardsByPage: {} })
    useLayoutSwitcherStore.setState({ visiblePanels: {} })
    vi.clearAllMocks()
  })

  it('AC-1: 零粗重标题栏，动作槽接通父级 onClose', () => {
    const handleClose = vi.fn()
    render(
      <MemoryRouter>
        <FileDetailsPanel pageId="test_page" item={mockFile} onClose={handleClose} />
      </MemoryRouter>
    )

    // 原旧标题栏已移除
    expect(screen.queryByTestId('legacy-details-header')).toBeNull()

    // 动作槽就绪
    const actionStrip = screen.getByTestId('details-micro-action-strip')
    expect(actionStrip).toBeDefined()

    // 面板全局关闭按钮
    const closeBtn = screen.getByTestId('details-close-button')
    expect(closeBtn).toBeDefined()
    fireEvent.click(closeBtn)
    expect(handleClose).toHaveBeenCalledTimes(1)
  })

  it('AC-2 & AC-3: 四卡片独立闭合、药丸条唤回与单卡保留防御', () => {
    render(
      <MemoryRouter>
        <FileDetailsPanel pageId="test_page" item={mockFile} />
      </MemoryRouter>
    )

    // 4 张卡片默认全部可见
    expect(screen.getByTestId(`details-card-${DETAILS_CARD_IDS.MINI_PREVIEW}`)).toBeDefined()
    expect(screen.getByTestId(`details-card-${DETAILS_CARD_IDS.SUMMARY}`)).toBeDefined()
    expect(screen.getByTestId(`details-card-${DETAILS_CARD_IDS.TAGS}`)).toBeDefined()
    expect(screen.getByTestId(`details-card-${DETAILS_CARD_IDS.METRICS}`)).toBeDefined()

    // 1. 关闭卡片 1（迷你预览）
    const closePreviewBtn = screen.getByTestId(`close-card-${DETAILS_CARD_IDS.MINI_PREVIEW}`)
    fireEvent.click(closePreviewBtn)

    // 迷你预览消失，顶部出现药丸唤回
    expect(screen.queryByTestId(`details-card-${DETAILS_CARD_IDS.MINI_PREVIEW}`)).toBeNull()
    const restorePreviewBtn = screen.getByTestId(`restore-card-${DETAILS_CARD_IDS.MINI_PREVIEW}`)
    expect(restorePreviewBtn).toBeDefined()

    // 2. 点击药丸唤回卡片 1
    fireEvent.click(restorePreviewBtn)
    expect(screen.getByTestId(`details-card-${DETAILS_CARD_IDS.MINI_PREVIEW}`)).toBeDefined()
    expect(screen.queryByTestId(`restore-card-${DETAILS_CARD_IDS.MINI_PREVIEW}`)).toBeNull()

    // 3. 连续关闭 3 张卡片，验证单卡保留防御
    fireEvent.click(screen.getByTestId(`close-card-${DETAILS_CARD_IDS.MINI_PREVIEW}`))
    fireEvent.click(screen.getByTestId(`close-card-${DETAILS_CARD_IDS.SUMMARY}`))
    fireEvent.click(screen.getByTestId(`close-card-${DETAILS_CARD_IDS.TAGS}`))

    // 仅剩卡片 4（分析指标）
    expect(screen.getByTestId(`details-card-${DETAILS_CARD_IDS.METRICS}`)).toBeDefined()
    const lastCloseBtn = screen.getByTestId(`close-card-${DETAILS_CARD_IDS.METRICS}`)
    expect(lastCloseBtn).toHaveProperty('disabled', true)

    // 点击禁用的关闭按钮，卡片 4 依然存在，禁止出现幽灵空面板
    fireEvent.click(lastCloseBtn)
    expect(screen.getByTestId(`details-card-${DETAILS_CARD_IDS.METRICS}`)).toBeDefined()
  })

  it('AC-4: 容器感知网格与 auto-rows-min 高度流动模型', () => {
    render(
      <MemoryRouter>
        <FileDetailsPanel pageId="test_page" item={mockFile} />
      </MemoryRouter>
    )

    const container = screen.getByTestId('file-details-container')
    expect(container).toBeDefined()
    expect(container.className).toContain('grid-cols-1')
    expect(container.className).toContain('@[540px]/details:grid-cols-2')
    expect(container.className).toContain('auto-rows-min')
    expect(container.className).toContain('overflow-y-auto')
  })

  it('AC-5: 双预览冲突智能协调（大预览激活时 compact，折叠时 rich）', () => {
    // 1. 大预览折叠态 -> rich 模式
    const { unmount } = render(
      <MemoryRouter>
        <FileDetailsPanel pageId="test_page" item={mockFile} previewCollapsed={true} />
      </MemoryRouter>
    )

    const richPreview = screen.getByTestId('details-card-mini-preview')
    expect(richPreview.getAttribute('data-preview-mode')).toBe('rich')
    unmount()

    // 2. 大预览展开态 -> compact 紧凑模式
    render(
      <MemoryRouter>
        <FileDetailsPanel pageId="test_page" item={mockFile} previewCollapsed={false} />
      </MemoryRouter>
    )

    const compactPreview = screen.getByTestId('details-card-mini-preview')
    expect(compactPreview.getAttribute('data-preview-mode')).toBe('compact')
  })

  it('AC-6: 底部工具栏自适应限宽与靠右收敛', () => {
    render(
      <MemoryRouter>
        <FileDetailsPanel pageId="test_page" item={mockFile} />
      </MemoryRouter>
    )

    const bottomActions = screen.getByTestId('details-bottom-actions')
    expect(bottomActions).toBeDefined()

    // 主操作按钮包含 max-w-[140px]
    const analyzeBtn = screen.getByText('立即分析').closest('button')
    expect(analyzeBtn).toBeDefined()
    expect(analyzeBtn?.className).toContain('max-w-[140px]')
    expect(analyzeBtn?.className).toContain('h-8')

    // 按钮集群靠右收敛
    const btnCluster = analyzeBtn?.parentElement
    expect(btnCluster?.className).toContain('justify-end')
  })

  it('AC-7: 目录态多态水合与子文件批量分析', () => {
    render(
      <MemoryRouter>
        <FileDetailsPanel pageId="test_page" item={mockDir} />
      </MemoryRouter>
    )

    // 底部工具栏展示“目录画像”与“分析子文件”
    expect(screen.getByText('目录画像')).toBeDefined()
    expect(screen.getByText('分析子文件')).toBeDefined()

    // 目录画像按钮限宽契约
    const dirProfileBtn = screen.getByText('目录画像').closest('button')
    expect(dirProfileBtn?.className).toContain('max-w-[130px]')
    expect(dirProfileBtn?.className).toContain('h-8')
  })

  it('AC-8: 迷你预览卡片根据大预览区块开启状态动态排序（开启排末尾，关闭排首位）', () => {
    // 1. 大预览未开启（previewCollapsed: true），迷你预览排第一位
    const { unmount } = render(
      <MemoryRouter>
        <FileDetailsPanel pageId="test_page" item={mockFile} previewCollapsed={true} />
      </MemoryRouter>
    )

    const container = screen.getByTestId('file-details-container')
    const cards = container.children
    expect(cards[0].getAttribute('data-testid')).toBe(
      `details-card-${DETAILS_CARD_IDS.MINI_PREVIEW}`
    )
    expect(cards[cards.length - 1].getAttribute('data-testid')).toBe(
      `details-card-${DETAILS_CARD_IDS.METRICS}`
    )
    unmount()

    // 2. 大预览已开启（previewCollapsed: false），迷你预览排最后一位
    const { unmount: unmount2 } = render(
      <MemoryRouter>
        <FileDetailsPanel pageId="test_page" item={mockFile} previewCollapsed={false} />
      </MemoryRouter>
    )

    const containerExpanded = screen.getByTestId('file-details-container')
    const cardsExpanded = containerExpanded.children
    expect(cardsExpanded[0].getAttribute('data-testid')).toBe(
      `details-card-${DETAILS_CARD_IDS.SUMMARY}`
    )
    expect(cardsExpanded[cardsExpanded.length - 1].getAttribute('data-testid')).toBe(
      `details-card-${DETAILS_CARD_IDS.MINI_PREVIEW}`
    )
    unmount2()

    // 3. 不传 previewCollapsed，由 layoutSwitcherStore 决定
    useLayoutSwitcherStore.setState({
      visiblePanels: { test_page: [PANEL_IDS.DETAILS, PANEL_IDS.PREVIEW] }
    })
    render(
      <MemoryRouter>
        <FileDetailsPanel pageId="test_page" item={mockFile} />
      </MemoryRouter>
    )

    const containerFromStore = screen.getByTestId('file-details-container')
    const cardsFromStore = containerFromStore.children
    expect(cardsFromStore[cardsFromStore.length - 1].getAttribute('data-testid')).toBe(
      `details-card-${DETAILS_CARD_IDS.MINI_PREVIEW}`
    )
  })
})
