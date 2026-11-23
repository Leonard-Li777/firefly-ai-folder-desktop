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
      { id: 'bottom', type: 'flex', defaultSize: 1, content: <div data-testid="bottom">Bottom</div> }
    ]

    render(<SplitPane storageKey="vert-test-1" sections={sections} direction="vertical" />)

    const handle = screen.getByRole('separator')
    expect(handle).toHaveAttribute('aria-orientation', 'horizontal')
    expect(handle.className).toContain('cursor-row-resize')
  })

  it('AC-2: 1:1 像素手势传递 (垂直方向 clientY 拖拽 50px)', () => {
    const sections: SplitPaneSection[] = [
      { id: 'top', type: 'pixel', defaultSize: 200, minSize: 100, content: <div data-testid="top">Top</div> },
      { id: 'bottom', type: 'flex', defaultSize: 1, minSize: 100, content: <div data-testid="bottom">Bottom</div> }
    ]

    render(<SplitPane storageKey="vert-test-2" sections={sections} direction="vertical" />)

    const topPanel = screen.getByTestId('top').parentElement!
    expect(topPanel.style.height).toBe('200px')

    const handle = screen.getByRole('separator')
    act(() => {
      fireEvent.pointerDown(handle, { clientX: 100, clientY: 200, pointerId: 1, buttons: 1, button: 0 })
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
      { id: 'bottom', type: 'flex', defaultSize: 1, content: <div data-testid="bottom">Bottom</div> }
    ]

    render(<SplitPane storageKey="vert-test-3" sections={sections} direction="vertical" />)

    const handle = screen.getByRole('separator')
    handle.setPointerCapture = setPointerCapture
    handle.releasePointerCapture = releasePointerCapture
    handle.hasPointerCapture = hasPointerCapture

    act(() => {
      fireEvent.pointerDown(handle, { clientX: 100, clientY: 200, pointerId: 42, buttons: 1, button: 0 })
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
      { id: 'bottom', type: 'flex', defaultSize: 1, content: <div data-testid="bottom">Bottom</div> }
    ]

    render(<SplitPane storageKey="vert-test-8" sections={sections} direction="vertical" />)

    const topPanel = screen.getByTestId('top').parentElement!
    const handle = screen.getByRole('separator')

    // 先拖拽增加到 260px
    act(() => {
      fireEvent.pointerDown(handle, { clientX: 100, clientY: 200, pointerId: 1, buttons: 1, button: 0 })
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
})
