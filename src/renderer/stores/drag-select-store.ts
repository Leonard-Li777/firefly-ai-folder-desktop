import { create } from 'zustand'

/**
 * 拖拽框选状态存储
 *
 * 将框选过程中的高频变化状态（鼠标位置、选中路径集合）从 React state 移出，
 * 避免每次 mousemove 都触发 FileList 整树重渲染。各消费方通过 selector 精确订阅：
 * - SelectionBox 订阅 dragStart/dragEnd，每帧轻量更新选框
 * - 卡片组件订阅 dragSelectionPaths.has(path)，仅当自身选中布尔翻转时才重渲染
 */

export interface DragSelectState {
  isDragging: boolean
  dragStart: { x: number; y: number } | null
  dragEnd: { x: number; y: number } | null
  dragSelectionPaths: Set<string>
  beginDrag: (start: { x: number; y: number }) => void
  updateDrag: (end: { x: number; y: number }, paths: Set<string>) => void
  endDrag: () => void
}

export const useDragSelectStore = create<DragSelectState>(set => ({
  isDragging: false,
  dragStart: null,
  dragEnd: null,
  dragSelectionPaths: new Set(),
  beginDrag: start =>
    set({ isDragging: true, dragStart: start, dragEnd: start, dragSelectionPaths: new Set() }),
  updateDrag: (end, paths) => set({ dragEnd: end, dragSelectionPaths: paths }),
  endDrag: () =>
    set({ isDragging: false, dragStart: null, dragEnd: null, dragSelectionPaths: new Set() })
}))
