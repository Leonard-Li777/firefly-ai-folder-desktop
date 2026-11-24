import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import React from 'react'
import { SplitPane } from '../index'
import { SplitPaneSection } from '../types'

// JSDOM 缺少 PointerEvent 实现，在此为其补充基础垫片
if (typeof window.PointerEvent === 'undefined') {
  class PointerEventShim extends MouseEvent {
    pointerId: number
    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params)
      this.pointerId = params.pointerId ?? 0
    }
  }
  // @ts-expect-error test shim
  window.PointerEvent = PointerEventShim
}

describe('SplitPane Vertical Mode & Gesture Protocol (Ticket 01)', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('AC-1: 垂直手柄样式与光标呈现横向分割与 cursor-row-resize', () => {
    const sections: SplitPaneSection[] = [
      { id: 'top', type: 'pixel', defaultSize: 200, content: <div data-testid="top">Top</div> },
      {
        id: 'bottom',
        type: 'flex',
        defaultSize: 1,
        content: <div data-testid="bottom">Bottom</div>
      }
    ]

    render(<SplitPane storageKey="vert-test-1" sections={sections} direction="vertical" />)

    const handle = screen.getByRole('separator')
    expect(handle).toHaveAttribute('aria-orientation', 'horizontal')
    expect(handle.className).toContain('cursor-row-resize')
  })

  it('AC-2: 1:1 像素手势传递 (垂直方向 clientY 拖拽 50px)', () => {
    const sections: SplitPaneSection[] = [
      {
        id: 'top',
        type: 'pixel',
        defaultSize: 200,
        minSize: 100,
        content: <div data-testid="top">Top</div>
      },
      {
        id: 'bottom',
        type: 'flex',
        defaultSize: 1,
        minSize: 100,
        content: <div data-testid="bottom">Bottom</div>
      }
    ]

    render(<SplitPane storageKey="vert-test-2" sections={sections} direction="vertical" />)

    const topPanel = screen.getByTestId('top').parentElement!
    expect(topPanel.style.height).toBe('200px')

    const handle = screen.getByRole('separator')
    act(() => {
      fireEvent.pointerDown(handle, {
        clientX: 100,
        clientY: 200,
        pointerId: 1,
        buttons: 1,
        button: 0
      })
      fireEvent.mouseMove(document, { clientX: 100, clientY: 250, buttons: 1 })
      fireEvent.pointerUp(handle, { clientX: 100, clientY: 250, pointerId: 1, button: 0 })
    })

    expect(topPanel.style.height).toBe('250px')
  })

  it('AC-3 & AC-4: PointerCapture 生命周期与拖拽期间锁定状态', () => {
    const setPointerCapture = vi.fn()
    const releasePointerCapture = vi.fn()
    const hasPointerCapture = vi.fn().mockReturnValue(true)

    const sections: SplitPaneSection[] = [
      { id: 'top', type: 'pixel', defaultSize: 200, content: <div data-testid="top">Top</div> },
      {
        id: 'bottom',
        type: 'flex',
        defaultSize: 1,
        content: <div data-testid="bottom">Bottom</div>
      }
    ]

    render(<SplitPane storageKey="vert-test-3" sections={sections} direction="vertical" />)

    const handle = screen.getByRole('separator')
    handle.setPointerCapture = setPointerCapture
    handle.releasePointerCapture = releasePointerCapture
    handle.hasPointerCapture = hasPointerCapture

    act(() => {
      fireEvent.pointerDown(handle, {
        clientX: 100,
        clientY: 200,
        pointerId: 42,
        buttons: 1,
        button: 0
      })
    })

    expect(setPointerCapture).toHaveBeenCalledWith(42)
    expect(document.body.classList.contains('split-pane-resizing')).toBe(true)
    expect(document.body.style.cursor).toBe('row-resize')

    act(() => {
      fireEvent.lostPointerCapture(handle, { pointerId: 42 })
    })

    expect(document.body.classList.contains('split-pane-resizing')).toBe(false)
    expect(document.body.style.cursor).toBe('')
  })

  it('AC-6: flex 折叠支持与把手隐藏守卫', () => {
    const sections: SplitPaneSection[] = [
      { id: 'list', type: 'pixel', defaultSize: 300, content: <div data-testid="list">List</div> },
      {
        id: 'companion',
        type: 'flex',
        defaultSize: 1,
        collapsed: true,
        collapsedSize: 0,
        content: <div data-testid="companion">Companion</div>
      }
    ]

    render(<SplitPane storageKey="vert-test-6" sections={sections} direction="horizontal" />)

    const companionPanel = screen.getByTestId('companion').parentElement!
    expect(companionPanel.style.display).toBe('none')
    expect(companionPanel.style.flex).toBe('0 0 0px')

    // 把手隐藏：因为 companion 折叠且尺寸为 0，相邻把手不渲染
    const handles = screen.queryAllByRole('separator')
    expect(handles).toHaveLength(0)
  })

  it('AC-7: 孤岛唯一可见格自动满铺公理', () => {
    const sections: SplitPaneSection[] = [
      {
        id: 'list',
        type: 'pixel',
        defaultSize: 300, // 原始固定尺寸 300px
        content: <div data-testid="list">List</div>
      },
      {
        id: 'companion',
        type: 'flex',
        defaultSize: 1,
        collapsed: true,
        collapsedSize: 0,
        content: <div data-testid="companion">Companion</div>
      }
    ]

    render(<SplitPane storageKey="vert-test-7" sections={sections} direction="horizontal" />)

    const listPanel = screen.getByTestId('list').parentElement!
    // 孤岛唯一可见格：即使类型为 pixel，也必须 100% 满铺容器
    expect(listPanel.style.flex).toBe('1 1 auto')
    expect(listPanel.style.width).toBe('100%')
    expect(listPanel.style.height).toBe('100%')
  })

  it('AC-8: 把手双击重置默认比例', () => {
    const sections: SplitPaneSection[] = [
      { id: 'top', type: 'pixel', defaultSize: 200, content: <div data-testid="top">Top</div> },
      {
        id: 'bottom',
        type: 'flex',
        defaultSize: 1,
        content: <div data-testid="bottom">Bottom</div>
      }
    ]

    render(<SplitPane storageKey="vert-test-8" sections={sections} direction="vertical" />)

    const topPanel = screen.getByTestId('top').parentElement!
    const handle = screen.getByRole('separator')

    // 先拖拽增加到 260px
    act(() => {
      fireEvent.pointerDown(handle, {
        clientX: 100,
        clientY: 200,
        pointerId: 1,
        buttons: 1,
        button: 0
      })
      fireEvent.mouseMove(document, { clientX: 100, clientY: 260, buttons: 1 })
      fireEvent.pointerUp(handle, { clientX: 100, clientY: 260, pointerId: 1, button: 0 })
    })
    expect(topPanel.style.height).toBe('260px')

    // 双击把手恢复到 defaultSize (200px)
    act(() => {
      fireEvent.doubleClick(handle)
    })
    expect(topPanel.style.height).toBe('200px')
  })

  it('AC-9: 水平手柄 hover 到相邻面板滚动条时热区对指针透明（不抢滚动条 hover/拖动）', () => {
    const sections: SplitPaneSection[] = [
      {
        id: 'dim-tree',
        type: 'pixel',
        defaultSize: 230,
        content: <div data-testid="dim-tree">Dimension Tree</div>
      },
      {
        id: 'file-list',
        type: 'flex',
        defaultSize: 2,
        content: <div data-testid="file-list">File List</div>
      }
    ]

    render(
      <SplitPane storageKey="scrollbar-penetration" sections={sections} direction="horizontal" />
    )

    const handle = screen.getByRole('separator')
    // 拖拽热区是 handle 内的第一个子 div（带 cursor-col-resize）
    const hitArea = handle.querySelector('div.cursor-col-resize') as HTMLElement
    expect(hitArea).not.toBeNull()

    // JSDOM 未实现 elementsFromPoint，注入垫片返回我们构造的「可滚动容器」
    const scrollEl = document.createElement('div')
    Object.defineProperty(scrollEl, 'offsetWidth', { value: 230 })
    Object.defineProperty(scrollEl, 'clientWidth', { value: 222 })
    Object.defineProperty(scrollEl, 'scrollHeight', { value: 1000 })
    Object.defineProperty(scrollEl, 'clientHeight', { value: 300 })
    scrollEl.getBoundingClientRect = () => ({ left: 0, right: 230, top: 0, bottom: 300 }) as DOMRect

    // JSDOM 缺少 elementsFromPoint / 自定义滚动条样式，注入垫片模拟「可滚动容器 + auto 滚动条」
    const originalElementsFromPoint = (document as any).elementsFromPoint
    ;(document as any).elementsFromPoint = () => [scrollEl]
    const originalGetComputedStyle = window.getComputedStyle
    window.getComputedStyle = (() =>
      ({
        overflowY: 'auto',
        borderLeftWidth: '0px',
        borderRightWidth: '0px'
      }) as CSSStyleDeclaration) as any

    // 未 hover 滚动条前，热区保持可响应（未设 pointer-events:none）
    expect(hitArea.style.pointerEvents).not.toBe('none')

    // hover 落在滚动条条带上（x = 226，落在 right=230 左侧的 8px 滚动条宽度内）
    act(() => {
      fireEvent.pointerMove(handle, { clientX: 226, clientY: 150, buttons: 0 })
    })
    // 热区必须对指针透明，把 hover/拖动交还给原生滚动条
    expect(hitArea.style.pointerEvents).toBe('none')

    // 当指针靠近分割线中心（x = 229，落入距离分割线 <= 2px 核心区），热区恢复响应，保证分割线 hover 与焦点优先
    act(() => {
      document.dispatchEvent(new PointerEvent('pointermove', { clientX: 229, clientY: 150 }))
    })
    expect(hitArea.style.pointerEvents).not.toBe('none')

    // 还原垫片
    if (originalElementsFromPoint === undefined) {
      delete (document as any).elementsFromPoint
    } else {
      ;(document as any).elementsFromPoint = originalElementsFromPoint
    }
    window.getComputedStyle = originalGetComputedStyle
  })
})
