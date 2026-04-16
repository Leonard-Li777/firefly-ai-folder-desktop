import { t } from '@app/languages'
import React, { useState, useEffect, useRef } from 'react'
import { MaterialIcon } from '../../lib/utils'
import { cn } from '../../lib/utils'
import { useSearchStore } from '../../stores/search-store'

interface SearchBarProps {
  type: 'real-directory' | 'virtual-directory'
  placeholder?: string
  onSearch: (keyword: string) => void
  className?: string
  debounceMs?: number // 防抖延迟时间（毫秒）
  onToggleSuggestions?: (isOpen: boolean) => void // 下拉菜单状态变化回调
}

/**
 * 搜索栏组件
 * 支持实时搜索、搜索历史、搜索建议、防抖处理
 */
export const SearchBar: React.FC<SearchBarProps> = ({
  type,
  placeholder = t('搜索...'),
  onSearch,
  className,
  debounceMs = 300, // 默认300ms防抖
  onToggleSuggestions
}) => {
  const {
    realDirectoryKeyword,
    virtualDirectoryKeyword,
    setRealDirectoryKeyword,
    setVirtualDirectoryKeyword,
    getSearchSuggestions,
    addSearchHistory
  } = useSearchStore()

  const keyword = type === 'real-directory' ? realDirectoryKeyword : virtualDirectoryKeyword
  const setKeyword = type === 'real-directory' ? setRealDirectoryKeyword : setVirtualDirectoryKeyword

  const [localKeyword, setLocalKeyword] = useState(keyword)
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(-1)

  const inputRef = useRef<HTMLInputElement>(null)
  const suggestionsRef = useRef<HTMLDivElement>(null)
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null)

  // 同步外部关键词变化
  useEffect(() => {
    setLocalKeyword(keyword)
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
      if (
        suggestionsRef.current &&
        !suggestionsRef.current.contains(event.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(event.target as Node)
      ) {
        setShowSuggestions(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // 处理输入变化（带防抖）
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    setLocalKeyword(value)

    // 清除之前的防抖计时器
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }

    // 设置新的防抖计时器
    debounceTimerRef.current = setTimeout(() => {
      // 延迟执行搜索
      onSearch(value)
      setKeyword(value)

      // 只有在非空搜索时才添加到历史记录
      if (value.trim()) {
        addSearchHistory(value, type)
      }
    }, debounceMs)

    // 立即更新建议列表（不需要防抖）
    const newSuggestions = getSearchSuggestions(type, value)
    setSuggestions(newSuggestions)
    setShowSuggestions(newSuggestions.length > 0)
    setSelectedSuggestionIndex(-1)
  }

  // 清理防抖计时器
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
    }
  }, [])

  // 处理输入框聚焦
  const handleFocus = () => {
    const newSuggestions = getSearchSuggestions(type, localKeyword)
    setSuggestions(newSuggestions)
    if (newSuggestions.length > 0) {
      setShowSuggestions(true)
    }
  }

  // 处理键盘事件
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showSuggestions || suggestions.length === 0) {
      if (e.key === 'Enter') {
        // Enter执行搜索
        onSearch(localKeyword)
        setKeyword(localKeyword)
        setShowSuggestions(false)
      }
      return
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setSelectedSuggestionIndex(prev =>
          prev < suggestions.length - 1 ? prev + 1 : prev
        )
        break
      case 'ArrowUp':
        e.preventDefault()
        setSelectedSuggestionIndex(prev => prev > 0 ? prev - 1 : -1)
        break
      case 'Enter':
        e.preventDefault()
        if (selectedSuggestionIndex >= 0) {
          handleSelectSuggestion(suggestions[selectedSuggestionIndex])
        } else {
          onSearch(localKeyword)
          setKeyword(localKeyword)
          setShowSuggestions(false)
        }
        break
      case 'Escape':
        setShowSuggestions(false)
        setSelectedSuggestionIndex(-1)
        break
    }
  }

  // 选择建议
  const handleSelectSuggestion = (suggestion: string) => {
    // 清除防抖计时器
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }

    setLocalKeyword(suggestion)
    setKeyword(suggestion)
    onSearch(suggestion)

    // 选择建议时，也添加到历史记录
    if (suggestion.trim()) {
      addSearchHistory(suggestion, type)
    }

    setShowSuggestions(false)
    setSelectedSuggestionIndex(-1)
  }

  // 清除搜索
  const handleClear = () => {
    // 清除防抖计时器
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }

    setLocalKeyword('')
    setKeyword('')
    onSearch('')
    setShowSuggestions(false)
    setSelectedSuggestionIndex(-1)
    inputRef.current?.focus()
  }

  return (
    <div className={cn('relative', className)}>
      <div className="relative">
        {/* 搜索图标 */}
        <div className="absolute left-3 top-3/5 -translate-y-1/2 text-muted-foreground dark:text-muted-foreground">
          <MaterialIcon icon="search" className="text-xl" />
        </div>

        {/* 输入框 */}
        <input
          ref={inputRef}
          type="text"
          value={localKeyword}
          onChange={handleInputChange}
          onFocus={handleFocus}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className={cn(
            'w-full pl-10 pr-10 py-2 rounded-lg',
            'text-foreground dark:text-foreground',
            'placeholder:text-muted-foreground/60 dark:placeholder:text-muted-foreground/60',
            'focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent',
            'transition-all duration-200',
            'text-sm'
          )}
          title={t('输入关键词进行搜索')}
        />

        {/* 清除按钮 */}
        {localKeyword && (
          <button
            onClick={handleClear}
            className={cn(
              'absolute right-3 top-1/2 -translate-y-1/2',
              'text-muted-foreground dark:text-muted-foreground',
              'hover:text-foreground dark:hover:text-foreground',
              'transition-colors duration-200',
              'cursor-pointer'
            )}
            title={t('清除搜索内容')}
          >
            <MaterialIcon icon="close" className="text-xl" />
          </button>
        )}
      </div>

      {/* 搜索建议下拉列表 */}
      {showSuggestions && suggestions.length > 0 && (
        <div
          ref={suggestionsRef}
          className={cn(
            'absolute top-full left-0 right-0 mt-1',
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
              <MaterialIcon icon="history" className="text-muted-foreground dark:text-muted-foreground text-lg" />
              <span className="text-sm text-foreground dark:text-foreground">{suggestion}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

