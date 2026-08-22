import { useCallback, useState, useEffect } from 'react'
import { ROW_HEIGHT, GRID_MIN_COLUMN_WIDTH, GRID_ROW_HEIGHT } from '../constants'

interface UseFileListScrollProps {
  items: any[]
  hasMore?: boolean
  onLoadMore?: () => void
  containerSize: { width: number; height: number }
  viewMode?: string
  currentPath?: string
}

export const useFileListScroll = ({
  items,
  hasMore,
  onLoadMore,
  containerSize,
  viewMode,
  currentPath
}: UseFileListScrollProps) => {
  const [scrollOffset, setScrollOffset] = useState(0)

  // 切换视图模式或路径时重置滚动偏移
  useEffect(() => {
    setScrollOffset(0)
  }, [viewMode, currentPath])

  const handleScroll = useCallback((params: any) => {
    let offset = 0;
    if (params) {
      if (typeof params === 'number') offset = params;
      else if (params.scrollOffset !== undefined) offset = Number(params.scrollOffset);
      else if (params.scrollTop !== undefined) offset = Number(params.scrollTop);
      else if (params.currentTarget && params.currentTarget.scrollTop !== undefined) offset = Number(params.currentTarget.scrollTop);
      else if (params.target && params.target.scrollTop !== undefined) offset = Number(params.target.scrollTop);
    }
    if (isNaN(offset)) offset = 0;
    setScrollOffset(offset)
    
    if (!hasMore || !onLoadMore) return
    const totalHeight = items.length * ROW_HEIGHT
    if (offset + containerSize.height >= totalHeight - 200) {
      onLoadMore()
    }
  }, [hasMore, onLoadMore, items.length, containerSize.height])

  const handleGridScroll = useCallback((params: any) => {
    let offset = 0;
    if (params) {
      if (typeof params === 'number') offset = params;
      else if (params.scrollTop !== undefined) offset = Number(params.scrollTop);
      else if (params.scrollOffset !== undefined) offset = Number(params.scrollOffset);
      else if (params.currentTarget && params.currentTarget.scrollTop !== undefined) offset = Number(params.currentTarget.scrollTop);
      else if (params.target && params.target.scrollTop !== undefined) offset = Number(params.target.scrollTop);
    }
    if (isNaN(offset)) offset = 0;
    setScrollOffset(offset)
    
    if (!hasMore || !onLoadMore) return
    const columnCount = Math.max(1, Math.floor(containerSize.width / GRID_MIN_COLUMN_WIDTH))
    const totalRows = Math.ceil(items.length / columnCount)
    const totalHeight = totalRows * GRID_ROW_HEIGHT
    if (offset + containerSize.height >= totalHeight - 500) {
      onLoadMore()
    }
  }, [hasMore, onLoadMore, items.length, containerSize.width, containerSize.height])

  return {
    scrollOffset,
    setScrollOffset,
    handleScroll,
    handleGridScroll
  }
}
