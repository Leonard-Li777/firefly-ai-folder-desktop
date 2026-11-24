import React from 'react'
import { renderHook, act } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { useFileListSelection } from '../hooks/useFileListSelection'
import { useDragSelectStore } from '../../../../stores/drag-select-store'
import { SEARCH_LIST_ROW_HEIGHT } from '../components/SearchListCard'

describe('FileList Drag Selection & Throttle Optimization', () => {
  beforeEach(() => {
    // 确保 mock electronAPI.utils 存在
    if (!window.electronAPI) {
      ;(window as any).electronAPI = {}
    }
    if (!window.electronAPI.utils) {
      window.electronAPI.utils = {
        isPathEqual: (a: string, b: string) => a.toLowerCase() === b.toLowerCase(),
        isSubPath: () => false,
        stripTrailingSlash: (p: string) => p,
        normalizeForCache: (p: string) => p.toLowerCase(),
        getPlatform: () => 'win32'
      } as any
    }

    useDragSelectStore.getState().endDrag()
  })

  describe('useDragSelectStore', () => {
    it('initializes with default state including currentScroll: 0', () => {
      const state = useDragSelectStore.getState()
      expect(state.isDragging).toBe(false)
      expect(state.dragStart).toBeNull()
      expect(state.dragEnd).toBeNull()
      expect(state.currentScroll).toBe(0)
      expect(state.dragSelectionPaths.size).toBe(0)
    })

    it('beginDrag updates dragStart and currentScroll without triggering FileList re-render', () => {
      act(() => {
        useDragSelectStore.getState().beginDrag({ x: 10, y: 20 }, 50)
      })
      const state = useDragSelectStore.getState()
      expect(state.isDragging).toBe(true)
      expect(state.dragStart).toEqual({ x: 10, y: 20 })
      expect(state.dragEnd).toEqual({ x: 10, y: 20 })
      expect(state.currentScroll).toBe(50)
      expect(state.dragSelectionPaths.size).toBe(0)
    })

    it('updateDrag updates dragEnd, paths, and currentScroll', () => {
      act(() => {
        useDragSelectStore.getState().beginDrag({ x: 0, y: 0 }, 0)
        useDragSelectStore
          .getState()
          .updateDrag({ x: 100, y: 200 }, new Set(['D:/test/file1.png']), 25)
      })
      const state = useDragSelectStore.getState()
      expect(state.dragEnd).toEqual({ x: 100, y: 200 })
      expect(state.currentScroll).toBe(25)
      expect(state.dragSelectionPaths.has('D:/test/file1.png')).toBe(true)
    })

    it('endDrag resets all dragging state cleanly', () => {
      act(() => {
        useDragSelectStore.getState().beginDrag({ x: 0, y: 0 }, 10)
        useDragSelectStore.getState().endDrag()
      })
      const state = useDragSelectStore.getState()
      expect(state.isDragging).toBe(false)
      expect(state.dragStart).toBeNull()
      expect(state.dragEnd).toBeNull()
      expect(state.currentScroll).toBe(0)
      expect(state.dragSelectionPaths.size).toBe(0)
    })
  })

  describe('Static & Anti-Degradation Guards', () => {
    const SOURCE_PATH = resolve(__dirname, '../hooks/useFileListSelection.ts')
    const sourceCode = readFileSync(SOURCE_PATH, 'utf-8')

    it('must implement search-list branch in calculateDragSelection', () => {
      expect(sourceCode).toContain("currentViewMode === 'search-list'")
      expect(sourceCode).toContain('SEARCH_LIST_ROW_HEIGHT')
    })

    it('must not debounce-starve handleMouseMove by cancelling rAF on every moveEvent', () => {
      // 严禁在 handleMouseMove 入口处使用 if (rafRef.current) cancelAnimationFrame(rafRef.current)
      // 这会导致高频划动时每一帧被下一帧取消，造成严重卡顿和饿死
      const moveHandlerSnippet = sourceCode.slice(
        sourceCode.indexOf('const handleMouseMove ='),
        sourceCode.indexOf('const handleMouseUp =')
      )
      expect(moveHandlerSnippet).not.toContain('cancelAnimationFrame(rafRef.current)')
      // 必须采用满帧节流守卫
      expect(moveHandlerSnippet).toContain('if (rafRef.current !== null) return')
    })

    it('must add is-drag-selecting class during drag to suppress child hover recalculations', () => {
      expect(sourceCode).toContain("classList.add('is-drag-selecting')")
      expect(sourceCode).toContain("classList.remove('is-drag-selecting')")
    })
  })

  describe('Search List Drag Selection Functional Tests', () => {
    it('correctly calculates and selects items in search-list mode', () => {
      const items = [
        { id: '1', name: 'File 1.pdf', path: 'D:/workspace/file1.pdf' },
        { id: '2', name: 'File 2.pdf', path: 'D:/workspace/file2.pdf' },
        { id: '3', name: 'File 3.pdf', path: 'D:/workspace/file3.pdf' },
        { id: '4', name: 'File 4.pdf', path: 'D:/workspace/file4.pdf' }
      ]

      const onFileSelect = vi.fn()
      const mockContainer = document.createElement('div')
      // 模拟 container bounding rect
      mockContainer.getBoundingClientRect = vi.fn(() => ({
        left: 0,
        top: 0,
        right: 800,
        bottom: 600,
        width: 800,
        height: 600,
        x: 0,
        y: 0,
        toJSON: () => {}
      }))

      const containerRef = { current: mockContainer }

      let rAFCallback: FrameRequestCallback | null = null
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
        rAFCallback = cb
        return 1
      })
      vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {
        rAFCallback = null
      })

      const { result } = renderHook(() =>
        useFileListSelection({
          items: items as any,
          selectedFiles: [],
          activeItem: null,
          onFileSelect,
          viewMode: 'search-list',
          containerSize: { width: 800, height: 600 },
          scrollOffset: 0,
          containerRef,
          gridCardWidth: SEARCH_LIST_ROW_HEIGHT
        })
      )

      // 1. 在容器上触发 MouseDown
      act(() => {
        result.current.handleMouseDown({
          button: 0,
          clientX: 50,
          clientY: 20,
          target: mockContainer,
          preventDefault: vi.fn()
        } as any)
      })

      // 2. 模拟鼠标划动至 clientY = 150 (跨越 File 1 和 File 2，两张卡片每张 104px)
      act(() => {
        window.dispatchEvent(
          new MouseEvent('mousemove', {
            clientX: 50,
            clientY: 150
          })
        )
      })

      // 3. 触发 rAF 调度
      expect(rAFCallback).not.toBeNull()
      act(() => {
        if (rAFCallback) rAFCallback(performance.now())
      })

      // 4. 验证 store 中的选中路径集合包含 file1 和 file2，但不包含 file3 / file4
      const dragState = useDragSelectStore.getState()
      expect(dragState.isDragging).toBe(true)
      expect(dragState.dragSelectionPaths.has('D:/workspace/file1.pdf')).toBe(true)
      expect(dragState.dragSelectionPaths.has('D:/workspace/file2.pdf')).toBe(true)
      expect(dragState.dragSelectionPaths.has('D:/workspace/file3.pdf')).toBe(false)
      expect(dragState.dragSelectionPaths.has('D:/workspace/file4.pdf')).toBe(false)

      // 5. 模拟鼠标松开 MouseUp
      act(() => {
        window.dispatchEvent(
          new MouseEvent('mouseup', {
            clientX: 50,
            clientY: 150
          })
        )
      })

      // 6. 验证 onFileSelect 成功被回调并接收到框选中的前两个文件
      expect(onFileSelect).toHaveBeenCalledTimes(1)
      const selectedCall = onFileSelect.mock.calls[0]
      expect(selectedCall[0]).toHaveLength(2)
      expect(selectedCall[0][0].path).toBe('D:/workspace/file1.pdf')
      expect(selectedCall[0][1].path).toBe('D:/workspace/file2.pdf')
      expect(selectedCall[1]).toBe(true) // isFromCheckbox / multi
    })
  })
})
