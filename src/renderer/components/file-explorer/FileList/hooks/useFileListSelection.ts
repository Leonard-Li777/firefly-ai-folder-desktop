import { useCallback, useEffect, useRef } from 'react'
import { FileType } from '../types'
import {
  HEADER_HEIGHT,
  ROW_HEIGHT,
  GRID_MIN_COLUMN_WIDTH,
  GRID_ROW_HEIGHT,
  SCROLLER_SELECTOR
} from '../constants'
import { DirectoryItem } from '@firefly/types'
import { usePreviewOverlayStore } from '../../../../stores/preview-overlay-store'
import { useDragSelectStore } from '../../../../stores/drag-select-store'

// 在分栏模式下，用所选文件触发预览
function tryTriggerSplitPreview(item: FileType | DirectoryItem, pageId?: string): void {
  const state = usePreviewOverlayStore.getState()
  if (!pageId) return
  const pageMode = state.pageStates[pageId]?.mode ?? 'split'
  if (pageMode !== 'split') return
  const ext = (item as any).extension || item.path?.split('.').pop() || ''
  state.openPreview(item.path || '', item.name, ext, pageId)
}

interface UseFileListSelectionProps {
  items: (FileType | DirectoryItem)[]
  selectedFiles: FileType[]
  getSelectedFiles?: () => FileType[]
  activeItem?: FileType | DirectoryItem | null
  onFileSelect: (files: (FileType | DirectoryItem | string)[], isFromCheckbox?: boolean) => void
  viewMode: string
  containerSize: { width: number; height: number }
  scrollOffset: number
  containerRef: React.RefObject<HTMLDivElement | null>
  onBack?: () => void
  onUp?: () => void
  onForward?: () => void
  listRef?: React.RefObject<any>
  pageId?: string
  gridCardWidth?: number
  gridShowFullFileName?: boolean
}

export const useFileListSelection = ({
  items,
  selectedFiles,
  getSelectedFiles,
  activeItem,
  onFileSelect,
  viewMode,
  containerSize,
  scrollOffset,
  containerRef,
  onBack,
  onUp,
  onForward,
  listRef,
  pageId,
  gridCardWidth = 200,
  gridShowFullFileName = false
}: UseFileListSelectionProps) => {
  const lastSelectedIndexRef = useRef<number | null>(null)
  const isDraggingRef = useRef(false)
  const currentMousePosRef = useRef({ x: 0, y: 0 })
  const rafRef = useRef<number | null>(null)

  const { isPathEqual } = window.electronAPI!.utils

  // 获取最新的 selectedFiles
  const getLatestSelectedFiles = useCallback(() => {
    if (typeof getSelectedFiles === 'function') return getSelectedFiles()
    return selectedFiles
  }, [getSelectedFiles, selectedFiles])

  // 最新属性 Ref 缓存以避免闭包延迟
  const propsRef = useRef({
    items,
    onFileSelect,
    scrollOffset,
    viewMode,
    getLatestSelectedFiles,
    onBack,
    onUp,
    onForward,
    gridCardWidth,
    gridShowFullFileName
  })

  useEffect(() => {
    propsRef.current = {
      items,
      onFileSelect,
      scrollOffset,
      viewMode,
      getLatestSelectedFiles,
      onBack,
      onUp,
      onForward,
      gridCardWidth,
      gridShowFullFileName
    }
  }, [
    items,
    onFileSelect,
    scrollOffset,
    viewMode,
    getLatestSelectedFiles,
    onBack,
    onUp,
    onForward,
    gridCardWidth,
    gridShowFullFileName
  ])

  const calculateDragSelection = useCallback(
    (currentDragEnd: { x: number; y: number }) => {
      if (!containerRef.current) return new Set<string>()

      const dragStartAbs = useDragSelectStore.getState().dragStart || { x: 0, y: 0 }
      const x1 = Math.min(dragStartAbs.x, currentDragEnd.x)
      const x2 = Math.max(dragStartAbs.x, currentDragEnd.x)
      const y1 = Math.min(dragStartAbs.y, currentDragEnd.y)
      const y2 = Math.max(dragStartAbs.y, currentDragEnd.y)

      const newlySelectedPaths = new Set<string>()
      const currentViewMode = propsRef.current.viewMode
      const currentItems = propsRef.current.items

      const currentCardWidth = propsRef.current.gridCardWidth || gridCardWidth || 200
      const currentShowFullFileName = propsRef.current.gridShowFullFileName ?? gridShowFullFileName

      if (currentViewMode === 'list' || currentViewMode === 'table' || !currentViewMode) {
        const listRowHeight = Math.max(30, Math.round(32 + ((currentCardWidth - 50) / 350) * 48))
        const startIdx = Math.max(0, Math.floor((y1 - HEADER_HEIGHT) / listRowHeight))
        const endIdx = Math.min(
          currentItems.length - 1,
          Math.floor((y2 - HEADER_HEIGHT) / listRowHeight)
        )

        for (let i = startIdx; i <= endIdx; i++) {
          const item = currentItems[i]
          if (item?.path) newlySelectedPaths.add(item.path)
        }
      } else if (currentViewMode === 'grid') {
        const gridWidth = Math.max(0, containerSize.width - 24)
        const availableWidth = Math.max(0, containerSize.width - 48)
        const effectiveWidth = currentCardWidth || GRID_MIN_COLUMN_WIDTH || 160
        const columnCount = Math.max(1, Math.floor(availableWidth / effectiveWidth))
        // 单元格列宽弹性填满容器（每列含间隙），与渲染层保持一致；Grid 填满无留白，无需居中偏移
        const columnWidth = containerSize.width > 0 ? gridWidth / columnCount : effectiveWidth
        const offsetLeft = 0
        const cardWidth = Math.min(effectiveWidth, columnWidth)
        const extraTextPadding = currentShowFullFileName ? 90 : 50
        // 垂直方向使用独立的小间隙（与渲染层 rowGap 一致），行高基于卡片宽而非弹性列宽
        const rowGap = Math.max(4, Math.round(cardWidth * 0.05))
        const rowHeight = Math.max(50, Math.round(cardWidth + extraTextPadding + rowGap))

        const adjX1 = Math.max(0, x1 - offsetLeft)
        const adjX2 = Math.max(0, x2 - offsetLeft)
        const startRow = Math.max(0, Math.floor(y1 / rowHeight))
        const endRow = Math.min(
          Math.ceil(currentItems.length / columnCount) - 1,
          Math.floor(y2 / rowHeight)
        )
        const startCol = Math.max(0, Math.floor(adjX1 / columnWidth))
        const endCol = Math.min(columnCount - 1, Math.floor(adjX2 / columnWidth))

        for (let r = startRow; r <= endRow; r++) {
          for (let c = startCol; c <= endCol; c++) {
            const index = r * columnCount + c
            const item = currentItems[index]
            if (!item?.path) continue

            const itemLeft = c * columnWidth
            const itemRight = (c + 1) * columnWidth
            const itemTop = r * rowHeight
            const itemBottom = (r + 1) * rowHeight

            const isOverlapping =
              adjX2 > itemLeft && adjX1 < itemRight && y2 > itemTop && y1 < itemBottom

            if (isOverlapping) {
              newlySelectedPaths.add(item.path)
            }
          }
        }
      } else if (currentViewMode === 'waterfall') {
        const containerRect = containerRef.current.getBoundingClientRect()
        const elements = containerRef.current.querySelectorAll('[data-index]')

        let currentScroll = 0
        const scrollers = containerRef.current.querySelectorAll(SCROLLER_SELECTOR)
        const scroller = Array.from(scrollers).find(
          s => s.scrollHeight > s.clientHeight
        ) as HTMLElement
        if (scroller && typeof scroller.scrollTop === 'number') {
          currentScroll = scroller.scrollTop
        }

        elements.forEach(el => {
          const rect = el.getBoundingClientRect()
          const itemLeft = rect.left - containerRect.left
          const itemTop = rect.top - containerRect.top + currentScroll
          const itemRight = itemLeft + rect.width
          const itemBottom = itemTop + rect.height

          const isOverlapping =
            x2 > itemLeft + 10 && x1 < itemRight - 10 && y2 > itemTop + 10 && y1 < itemBottom - 10

          if (isOverlapping) {
            const indexStr = el.getAttribute('data-index')
            if (indexStr) {
              const idx = parseInt(indexStr, 10)
              if (currentItems[idx] && currentItems[idx].path) {
                newlySelectedPaths.add(currentItems[idx].path)
              }
            }
          }
        })
      }
      return newlySelectedPaths
    },
    [containerSize.width, containerRef]
  )

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return
      const target = e.target as HTMLElement
      if (
        ['INPUT', 'BUTTON', 'A', 'LABEL'].includes(target.tagName) ||
        target.closest('button') ||
        target.closest('input') ||
        target.closest('.checkbox-cell')
      ) {
        return
      }

      // 禁止文本选中，同时保证点击能获得焦点
      e.preventDefault()

      if (target.closest('thead') || target.closest('.header-row')) {
        return
      }

      // Add a ref to store initial screen coordinates for drag detection without DOM reads
      const startClientX = e.clientX
      const startClientY = e.clientY

      // We don't read getBoundingClientRect() or querySelector() here anymore to avoid layout thrashing on simple clicks.
      isDraggingRef.current = false

      let originalUserSelect: string | null = null

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current)

        rafRef.current = requestAnimationFrame(() => {
          if (!containerRef.current) return

          const dx = Math.abs(moveEvent.clientX - startClientX)
          const dy = Math.abs(moveEvent.clientY - startClientY)

          if (dx > 5 || dy > 5) {
            const mRect = containerRef.current.getBoundingClientRect()
            const mx = moveEvent.clientX - mRect.left
            const my = moveEvent.clientY - mRect.top

            currentMousePosRef.current = { x: mx, y: my }

            const mAbsoluteX = mx
            let mCurrentScroll = propsRef.current.scrollOffset
            const scrollers = containerRef.current.querySelectorAll(SCROLLER_SELECTOR)
            const scroller = Array.from(scrollers).find(
              s => s.scrollHeight > s.clientHeight
            ) as HTMLElement
            if (scroller && typeof scroller.scrollTop === 'number') {
              mCurrentScroll = scroller.scrollTop
            }
            const mAbsoluteY = my + mCurrentScroll

            if (!isDraggingRef.current) {
              // First time we cross the threshold, calculate the dragStart absolute position
              const startAbsoluteX = startClientX - mRect.left
              const startAbsoluteY = startClientY - mRect.top + mCurrentScroll
              const dragStartAbs = { x: startAbsoluteX, y: startAbsoluteY }

              isDraggingRef.current = true
              useDragSelectStore.getState().beginDrag(dragStartAbs)

              // Defer userSelect modification until drag actually starts to prevent lag
              originalUserSelect = document.body.style.userSelect
              document.body.style.userSelect = 'none'
            }

            const newDragEnd = { x: mAbsoluteX, y: mAbsoluteY }
            // 直接写入 store，避免触发 FileList 组件重渲染；消费方按需订阅
            useDragSelectStore.getState().updateDrag(newDragEnd, calculateDragSelection(newDragEnd))
          }
        })
      }

      const handleMouseUp = (upEvent: MouseEvent) => {
        window.removeEventListener('mousemove', handleMouseMove)
        window.removeEventListener('mouseup', handleMouseUp)

        if (originalUserSelect !== null) {
          document.body.style.userSelect = originalUserSelect
        }

        if (rafRef.current) cancelAnimationFrame(rafRef.current)

        let finalSelectionPaths = new Set<string>()
        if (isDraggingRef.current) {
          const mRect = containerRef.current!.getBoundingClientRect()
          const mx = upEvent.clientX - mRect.left
          const my = upEvent.clientY - mRect.top

          const scrollers = containerRef.current!.querySelectorAll(SCROLLER_SELECTOR)
          const scroller = Array.from(scrollers).find(
            s => s.scrollHeight > s.clientHeight
          ) as HTMLElement
          const mCurrentScroll = scroller ? scroller.scrollTop : propsRef.current.scrollOffset

          finalSelectionPaths = calculateDragSelection({ x: mx, y: my + mCurrentScroll })
          useDragSelectStore.getState().endDrag()

          // 拖拽释放时的 click 事件会冒泡到卡片（原先由 [&_*]:pointer-events-none 抑制），
          // 这里在捕获阶段吞掉紧随 mouseup 的一次 click，避免误触发卡片点击/勾选
          const suppressClick = (clickEvent: MouseEvent) => {
            clickEvent.preventDefault()
            clickEvent.stopPropagation()
            document.removeEventListener('click', suppressClick, true)
          }
          document.addEventListener('click', suppressClick, true)
        }

        setTimeout(() => {
          isDraggingRef.current = false
        }, 50)

        if (!isDraggingRef.current) return

        const newlySelectedItems = propsRef.current.items.filter(
          item => item.path && finalSelectionPaths.has(item.path)
        )
        const isCtrlOrMeta = upEvent.ctrlKey || upEvent.metaKey

        if (isCtrlOrMeta) {
          if (newlySelectedItems.length > 0) {
            const currentSelected = propsRef.current.getLatestSelectedFiles()
            const combinedSelection = [...currentSelected]
            newlySelectedItems.forEach(newItem => {
              if (!combinedSelection.some(f => isPathEqual(f.path, newItem.path))) {
                combinedSelection.push(newItem as FileType)
              }
            })
            propsRef.current.onFileSelect(combinedSelection, true)
          }
        } else {
          propsRef.current.onFileSelect(newlySelectedItems, true)
        }
      }

      window.addEventListener('mousemove', handleMouseMove)
      window.addEventListener('mouseup', handleMouseUp)
    },
    [calculateDragSelection, containerSize.width, containerRef, isPathEqual]
  )

  const handleItemClick = useCallback(
    (index: number, e: React.MouseEvent) => {
      if (isDraggingRef.current) return

      const {
        items: currentItems,
        onFileSelect: currentOnFileSelect,
        getLatestSelectedFiles: getCurrentSelection
      } = propsRef.current
      const item = currentItems[index]
      if (!item) return

      const isCtrlOrMeta = e.ctrlKey || e.metaKey
      const isShift = e.shiftKey

      if (isShift && lastSelectedIndexRef.current !== null) {
        const start = Math.min(lastSelectedIndexRef.current, index)
        const end = Math.max(lastSelectedIndexRef.current, index)
        const rangeItems = currentItems.slice(start, end + 1)

        let finalSelection: (FileType | DirectoryItem)[]
        const currentSelected = getCurrentSelection()
        if (isCtrlOrMeta) {
          const newSelected = [...currentSelected]
          rangeItems.forEach(rangeItem => {
            if (!newSelected.some(f => isPathEqual(f.path, rangeItem.path))) {
              newSelected.push(rangeItem as FileType)
            }
          })
          finalSelection = newSelected
        } else {
          finalSelection = rangeItems
        }
        currentOnFileSelect(finalSelection, true)
      } else if (isCtrlOrMeta) {
        const currentSelected = getCurrentSelection()
        const isSelected = currentSelected.some(f => isPathEqual(f.path, item.path))
        let newSelected: (FileType | DirectoryItem)[]

        if (isSelected) {
          newSelected = currentSelected.filter(f => !isPathEqual(f.path, item.path))
        } else {
          newSelected = [...currentSelected, item as FileType]
        }

        currentOnFileSelect(newSelected, true)
        lastSelectedIndexRef.current = index
      } else {
        currentOnFileSelect([item], false)
        lastSelectedIndexRef.current = index
      }
    },
    [isPathEqual]
  )

  const scrollToIndex = useCallback(
    (index: number) => {
      if (containerRef.current) {
        const el = containerRef.current.querySelector(`[data-index="${index}"]`)
        if (el) {
          el.scrollIntoView({ block: 'nearest' })
          return
        }
      }

      if (!listRef?.current) return
      try {
        if (viewMode === 'grid') {
          const availableWidth = Math.max(0, containerSize.width - 48)
          const effectiveWidth = gridCardWidth || GRID_MIN_COLUMN_WIDTH || 160
          const columnCount = Math.max(1, Math.floor(availableWidth / effectiveWidth))
          const rowIndex = Math.floor(index / columnCount)
          const columnIndex = index % columnCount
          if (typeof listRef.current.scrollToItem === 'function') {
            listRef.current.scrollToItem({ columnIndex, rowIndex })
          }
        } else {
          if (typeof listRef.current.scrollToItem === 'function') {
            listRef.current.scrollToItem(index)
          }
        }
      } catch (err) {
        // Ignore scroll errors
      }
    },
    [listRef, viewMode, containerSize.width, containerRef]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const {
        items: currentItems,
        onFileSelect: currentOnFileSelect,
        onBack: currentOnBack,
        onUp: currentOnUp,
        onForward: currentOnForward,
        viewMode: currentViewMode
      } = propsRef.current
      const target = e.target as HTMLElement
      const isInput =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable

      if (isInput) return

      if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        currentOnFileSelect(
          currentItems.map(item => item.path!),
          true
        )
      } else if (e.key === 'Escape') {
        currentOnFileSelect([], true)
      } else if (e.key === 'Backspace') {
        e.preventDefault()
        currentOnBack?.()
      } else if (e.altKey) {
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          currentOnUp?.()
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault()
          currentOnBack?.()
        } else if (e.key === 'ArrowRight') {
          e.preventDefault()
          currentOnForward?.()
        }
      } else {
        if (currentItems.length === 0) return

        const isGridOrWaterfall = currentViewMode === 'grid' || currentViewMode === 'waterfall'
        if (isGridOrWaterfall) {
          if (
            e.key === 'ArrowUp' ||
            e.key === 'ArrowDown' ||
            e.key === 'ArrowLeft' ||
            e.key === 'ArrowRight'
          ) {
            e.preventDefault()
            let columnCount = 1
            if (currentViewMode === 'grid') {
              const availableWidth = Math.max(0, containerSize.width - 48)
              columnCount = Math.max(
                1,
                Math.floor(availableWidth / (gridCardWidth || GRID_MIN_COLUMN_WIDTH || 160))
              )
            } else if (currentViewMode === 'waterfall') {
              columnCount = Math.max(1, Math.floor((containerSize.width - 16) / gridCardWidth))
            }

            let activeIndex = -1
            if (activeItem) {
              activeIndex = currentItems.findIndex(item => isPathEqual(item.path, activeItem.path))
            }

            if (activeIndex === -1) {
              currentOnFileSelect([currentItems[0]], false)
              lastSelectedIndexRef.current = 0
              scrollToIndex(0)
              return
            }

            const r = Math.floor(activeIndex / columnCount)
            const c = activeIndex % columnCount
            let nextIndex = activeIndex

            if (e.key === 'ArrowLeft') {
              const minIndex = r * columnCount
              const maxIndex = Math.min(currentItems.length - 1, (r + 1) * columnCount - 1)
              const rowItemsCount = maxIndex - minIndex + 1
              const localCol = activeIndex - minIndex
              const newLocalCol = (localCol - 1 + rowItemsCount) % rowItemsCount
              nextIndex = minIndex + newLocalCol
            } else if (e.key === 'ArrowRight') {
              const minIndex = r * columnCount
              const maxIndex = Math.min(currentItems.length - 1, (r + 1) * columnCount - 1)
              const rowItemsCount = maxIndex - minIndex + 1
              const localCol = activeIndex - minIndex
              const newLocalCol = (localCol + 1) % rowItemsCount
              nextIndex = minIndex + newLocalCol
            } else if (e.key === 'ArrowUp') {
              const totalRows = Math.ceil(currentItems.length / columnCount)
              for (let step = 1; step <= totalRows; step++) {
                const tempRow = (r - step + totalRows) % totalRows
                const idx = tempRow * columnCount + c
                if (idx >= 0 && idx < currentItems.length) {
                  nextIndex = idx
                  break
                }
              }
            } else if (e.key === 'ArrowDown') {
              const totalRows = Math.ceil(currentItems.length / columnCount)
              for (let step = 1; step <= totalRows; step++) {
                const tempRow = (r + step) % totalRows
                const idx = tempRow * columnCount + c
                if (idx >= 0 && idx < currentItems.length) {
                  nextIndex = idx
                  break
                }
              }
            }

            const nextItem = currentItems[nextIndex]
            if (nextItem) {
              currentOnFileSelect([nextItem], false)
              lastSelectedIndexRef.current = nextIndex
              scrollToIndex(nextIndex)
              tryTriggerSplitPreview(nextItem, pageId)
            }
          }
        } else {
          if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
            e.preventDefault()
            let nextIndex = 0
            if (activeItem) {
              const activeIndex = currentItems.findIndex(item =>
                isPathEqual(item.path, activeItem.path)
              )
              if (activeIndex > 0) {
                nextIndex = activeIndex - 1
              } else if (activeIndex === 0) {
                nextIndex = 0
              }
            }
            const nextItem = currentItems[nextIndex]
            if (nextItem) {
              currentOnFileSelect([nextItem], false)
              lastSelectedIndexRef.current = nextIndex
              scrollToIndex(nextIndex)
              tryTriggerSplitPreview(nextItem, pageId)
            }
          } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
            e.preventDefault()
            let nextIndex = 0
            if (activeItem) {
              const activeIndex = currentItems.findIndex(item =>
                isPathEqual(item.path, activeItem.path)
              )
              if (activeIndex !== -1 && activeIndex < currentItems.length - 1) {
                nextIndex = activeIndex + 1
              } else if (activeIndex === currentItems.length - 1) {
                nextIndex = currentItems.length - 1
              }
            }
            const nextItem = currentItems[nextIndex]
            if (nextItem) {
              currentOnFileSelect([nextItem], false)
              lastSelectedIndexRef.current = nextIndex
              scrollToIndex(nextIndex)
              tryTriggerSplitPreview(nextItem, pageId)
            }
          }
        }
      }
    },
    [activeItem, isPathEqual, scrollToIndex, containerSize.width, pageId]
  )

  // 当拖拽期间滚动（拖到容器边缘自动滚动）时，更新拖拽终点并重新计算选中的文件路径。
  // 直接从 store 读写，不订阅 store，避免拖拽状态每帧触发 FileList 重渲染
  useEffect(() => {
    const dragState = useDragSelectStore.getState()
    if (!dragState.isDragging || !dragState.dragStart) return

    let currentScroll = scrollOffset
    if (containerRef.current) {
      const scrollers = containerRef.current.querySelectorAll(SCROLLER_SELECTOR)
      const scroller = Array.from(scrollers).find(
        s => s.scrollHeight > s.clientHeight
      ) as HTMLElement
      if (scroller && typeof scroller.scrollTop === 'number') {
        currentScroll = scroller.scrollTop
      }
    }

    const absoluteX = currentMousePosRef.current.x
    const absoluteY = currentMousePosRef.current.y + currentScroll
    const newDragEnd = { x: absoluteX, y: absoluteY }

    if (newDragEnd.x !== dragState.dragEnd?.x || newDragEnd.y !== dragState.dragEnd?.y) {
      const dx = Math.abs(absoluteX - dragState.dragStart.x)
      const dy = Math.abs(absoluteY - dragState.dragStart.y)
      if (dx > 5 || dy > 5) {
        isDraggingRef.current = true
        useDragSelectStore.setState({
          dragEnd: newDragEnd,
          dragSelectionPaths: calculateDragSelection(newDragEnd)
        })
      }
    }
  }, [scrollOffset, calculateDragSelection, containerRef])

  return {
    handleMouseDown,
    handleItemClick,
    handleKeyDown,
    isDraggingRef
  }
}
