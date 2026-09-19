import { useRef, useEffect } from 'react'

interface UseSearchViewAutoSwitchOptions {
  /** 当前搜索关键词，非空时自动切换至 search-list 视图 */
  keyword: string
  /** 当前视图模式 */
  viewMode: string
  /** 视图模式 setter */
  setViewMode: (mode: any) => void
}

/**
 * 搜索视图智能自适应切换：
 * - keyword 非空时平滑切换至 'search-list'，同时在内部记录用户原本的视图模式；
 * - keyword 清空后自动恢复用户原本的模式（如 'grid'）；
 * - 用户在搜索期间手动切换到其它模式视为退出搜索态，恢复时以最新手动选择为准。
 */
export const useSearchViewAutoSwitch = ({
  keyword,
  viewMode,
  setViewMode
}: UseSearchViewAutoSwitchOptions) => {
  /** 用户在进入搜索态之前的原始视图模式 */
  const previousModeRef = useRef<string | null>(null)
  /** 是否当前处于搜索态（viewMode 被替换为 search-list） */
  const isInSearchModeRef = useRef(false)

  useEffect(() => {
    const hasKeyword = Boolean(keyword && keyword.trim())

    if (hasKeyword) {
      // 进入搜索态：记录原模式（仅首次），并切换至 search-list
      if (!isInSearchModeRef.current) {
        previousModeRef.current = viewMode !== 'search-list' ? viewMode : previousModeRef.current
        isInSearchModeRef.current = true
      }
      if (viewMode !== 'search-list') {
        setViewMode('search-list')
      }
    } else if (isInSearchModeRef.current) {
      // 退出搜索态：恢复用户原本的视图模式
      isInSearchModeRef.current = false
      const restoreMode = previousModeRef.current || 'list'
      previousModeRef.current = null
      if (viewMode === 'search-list') {
        setViewMode(restoreMode)
      }
    }
  }, [keyword, viewMode, setViewMode])
}
