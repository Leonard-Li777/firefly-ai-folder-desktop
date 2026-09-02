import { t } from '@app/languages'
import React, { useState, useEffect, useRef } from 'react'
import { MaterialIcon, cn } from '../../lib/utils'
import { useSearchStore } from '../../stores/search-store'
import { useDebounce } from '../../hooks'

interface SearchBarProps {
  type: 'real-directory' | 'virtual-directory' | 'analyzed-directory'
  placeholder?: string
  onSearch: (keyword: string) => void
  className?: string
  debounceMs?: number // 防抖延迟时间（毫秒）
  onToggleSuggestions?: (isOpen: boolean) => void // 下拉菜单状态变化回调
  compactMode?: boolean // 紧凑模式：未聚焦时仅显示搜索图标，点击后展开
}

/**
 * 搜索栏组件
 * 支持实时搜索、搜索历史、搜索建议、防抖处理
 */
const SearchBarComponent: React.FC<SearchBarProps> = ({
  type,
  placeholder = t('搜索...'),
  onSearch,
  className,
  debounceMs = 250, // 默认 250ms 防抖
  onToggleSuggestions,
  compactMode = false
}) => {
  const {
    realDirectoryKeyword,
    analyzedDirectoryKeyword,
    virtualDirectoryKeyword,
    setRealDirectoryKeyword,
    setAnalyzedDirectoryKeyword,
    setVirtualDirectoryKeyword,
    getSearchSuggestions,
    addSearchHistory
  } = useSearchStore()

  const keyword =
    type === 'real-directory'
      ? realDirectoryKeyword
      : type === 'virtual-directory'
        ? virtualDirectoryKeyword
        : analyzedDirectoryKeyword
  const setKeyword =
    type === 'real-directory'
      ? setRealDirectoryKeyword
      : type === 'virtual-directory'
        ? setVirtualDirectoryKeyword
        : setAnalyzedDirectoryKeyword

  const [localKeyword, setLocalKeyword] = useState(keyword)
  const debouncedKeyword = useDebounce(localKeyword, debounceMs)
  const lastSearchedKeywordRef = useRef(keyword)

  const [showSuggestions, setShowSuggestions] = useState(false)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(-1)
  const [isFocused, setIsFocused] = useState(false)
  const [isExpanded, setIsExpanded] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  const suggestionsRef = useRef<HTMLDivElement>(null)
  const [dropdownPos, setDropdownPos] = useState<{
    top: number
    left: number
    width: number
  } | null>(null)

  // compactMode 下是否显示为图标
  const showIconOnly = compactMode && !isExpanded && !localKeyword

  // Helper to execute search safely and avoid duplicates/redundancy
  const executeSearch = (value: string) => {
    if (value !== lastSearchedKeywordRef.current) {
      onSearch(value)
      setKeyword(value)
      lastSearchedKeywordRef.current = value

      if (value.trim()) {
        addSearchHistory(value, type)
      }
    }
  }

  // 延迟执行搜索（带防抖）
  useEffect(() => {
    executeSearch(debouncedKeyword)
  }, [debouncedKeyword])

  // 同步外部关键词变化
  useEffect(() => {
    setLocalKeyword(keyword)
    lastSearchedKeywordRef.current = keyword
  }, [keyword])

  // 通知外部下拉菜单状态变化
  useEffect(() => {
    onToggleSuggestions?.(showSuggestions)
  }, [showSuggestions, onToggleSuggestions])

  // 监听Ctrl+F快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault()
        inputRef.current?.focus()
      }

      // ESC清除搜索
      if (e.key === 'Escape' && document.activeElement === inputRef.current) {
        handleClear()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  // 点击外部区域关闭建议列表
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node
      if (
        suggestionsRef.current &&
        !suggestionsRef.current.contains(target) &&
        inputRef.current &&
        !inputRef.current.contains(target)
      ) {
        setShowSuggestions(false)
        // compactMode 下点击外部折叠回图标
        if (compactMode && !localKeyword) {
          setIsExpanded(false)
        }
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // 处理输入变化
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    setLocalKeyword(value)

    // 立即更新建议列表（不需要防抖）
    updateDropdownPos()
    const newSuggestions = getSearchSuggestions(type, value)
    setSuggestions(newSuggestions)
    setShowSuggestions(newSuggestions.length > 0)
    setSelectedSuggestionIndex(-1)
  }

  // 处理输入框聚焦
  const handleFocus = () => {
    setIsFocused(true)
    setIsExpanded(true)
    updateDropdownPos()
    const newSuggestions = getSearchSuggestions(type, localKeyword)
    setSuggestions(newSuggestions)
    if (newSuggestions.length > 0) {
      setShowSuggestions(true)
    }
  }

  const updateDropdownPos = () => {
    if (inputRef.current) {
      const rect = inputRef.current.getBoundingClientRect()
      setDropdownPos({ top: rect.bottom + 4, left: rect.left, width: rect.width })
    }
  }

  // 处理输入框失焦
  const handleBlur = () => {
    setTimeout(() => {
      setIsFocused(false)
      if (compactMode && !localKeyword) {
        setIsExpanded(false)
      }
    }, 150)
  }

  // 点击图标展开搜索
  const handleIconClick = () => {
    if (compactMode) {
      setIsExpanded(true)
      // 延迟聚焦以等待渲染完成
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }

  // 处理键盘事件
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showSuggestions || suggestions.length === 0) {
      if (e.key === 'Enter') {
        // Enter执行搜索
        executeSearch(localKeyword)
        setShowSuggestions(false)
      }
      return
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setSelectedSuggestionIndex(prev => (prev < suggestions.length - 1 ? prev + 1 : prev))
        break
      case 'ArrowUp':
        e.preventDefault()
        setSelectedSuggestionIndex(prev => (prev > 0 ? prev - 1 : -1))
        break
      case 'Enter':
        e.preventDefault()
        if (selectedSuggestionIndex >= 0) {
          handleSelectSuggestion(suggestions[selectedSuggestionIndex])
        } else {
          executeSearch(localKeyword)
          setShowSuggestions(false)
        }
        break
      case 'Escape':
        setShowSuggestions(false)
        setSelectedSuggestionIndex(-1)
        // compactMode 下按 ESC 折叠回图标
        if (compactMode && !localKeyword) {
          setIsExpanded(false)
          inputRef.current?.blur()
        }
        break
    }
  }

  // 选择建议
  const handleSelectSuggestion = (suggestion: string) => {
    setLocalKeyword(suggestion)
    executeSearch(suggestion)
    setShowSuggestions(false)
    setSelectedSuggestionIndex(-1)
  }

  // 清除搜索
  const handleClear = () => {
    setLocalKeyword('')
    executeSearch('')
    setShowSuggestions(false)
    setSelectedSuggestionIndex(-1)
    inputRef.current?.focus()
  }

  const basicPlaceholder = placeholder || t('搜索...')
  const detailedPlaceholder =
    type === 'real-directory'
      ? t('搜索文件名、特征描述、标签或扩展名...')
      : t('搜索已分析的文件名、特征、标签...')

  return (
    <div className={cn('relative', className)}>
      {/* compactMode 图标模式：仅显示搜索图标按钮 */}
      {showIconOnly ? (
        <button
          onClick={handleIconClick}
          className={cn(
            'flex items-center justify-center w-8 h-8 rounded-md',
            'text-muted-foreground dark:text-muted-foreground',
            'hover:bg-accent dark:hover:bg-accent',
            'transition-colors duration-200',
            'cursor-pointer'
          )}
          title={t('搜索')}
        >
          <MaterialIcon icon="search" className="text-[18px]" />
        </button>
      ) : (
        <>
          <div
            className={cn(
              'relative transition-all duration-300 ease-in-out',
              compactMode ? (isFocused || localKeyword ? 'w-80' : 'w-56') : 'w-full'
            )}
          >
            {/* 搜索图标 */}
            <div className="absolute top-1/2 -translate-y-1/2 text-muted-foreground dark:text-muted-foreground flex items-center justify-center pointer-events-none left-2.5">
              <MaterialIcon icon="search" className="text-[18px]" />
            </div>

            {/* 输入框 */}
            <input
              ref={inputRef}
              type="text"
              value={localKeyword}
              onChange={handleInputChange}
              onFocus={handleFocus}
              onBlur={handleBlur}
              onKeyDown={handleKeyDown}
              placeholder={isFocused ? detailedPlaceholder : basicPlaceholder}
              className={cn(
                'w-full py-1.5 rounded-md pl-9 pr-8 bg-background border',
                'text-foreground dark:text-foreground',
                'placeholder:text-muted-foreground/50 dark:placeholder:text-muted-foreground/50',
                'focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary',
                'transition-all duration-300',
                'text-xs leading-tight',
                // 有搜索内容时高亮呼吸提示
                localKeyword
                  ? 'border-orange-400 dark:border-orange-500 animate-breathe'
                  : 'border-input'
              )}
              title={t('输入关键词进行搜索')}
            />

            {/* 清除按钮 */}
            {localKeyword && (
              <button
                onClick={handleClear}
                className={cn(
                  'absolute right-2 top-1/2 -translate-y-1/2 flex items-center justify-center w-5 h-5 rounded-full',
                  'text-muted-foreground dark:text-muted-foreground',
                  'hover:bg-accent dark:hover:bg-accent',
                  'transition-colors duration-200',
                  'cursor-pointer'
                )}
                title={t('清除搜索内容')}
              >
                <MaterialIcon icon="close" className="text-[14px]" />
              </button>
            )}
          </div>

          {/* 搜索建议下拉列表 */}
          {showSuggestions && suggestions.length > 0 && dropdownPos && (
            <div
              ref={suggestionsRef}
              style={{
                position: 'fixed',
                top: dropdownPos.top,
                left: dropdownPos.left,
                width: dropdownPos.width
              }}
              className={cn(
                'bg-popover dark:bg-popover border border-border dark:border-border rounded-lg shadow-lg',
                'z-50 max-h-60 overflow-y-auto'
              )}
            >
              {suggestions.map((suggestion, index) => (
                <div
                  key={index}
                  className={cn(
                    'px-4 py-2 cursor-pointer',
                    'flex items-center space-x-2',
                    'hover:bg-accent dark:hover:bg-accent',
                    'transition-colors duration-150',
                    selectedSuggestionIndex === index && 'bg-accent/50 dark:bg-accent/50'
                  )}
                  onClick={() => handleSelectSuggestion(suggestion)}
                >
                  <MaterialIcon
                    icon="history"
                    className="text-muted-foreground dark:text-muted-foreground text-lg"
                  />
                  <span className="text-sm text-foreground dark:text-foreground">{suggestion}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// 使用 React.memo 优化渲染，避免在父级工具栏频繁更新时引发输入框 DOM 属性突变
export const SearchBar = React.memo(SearchBarComponent)
