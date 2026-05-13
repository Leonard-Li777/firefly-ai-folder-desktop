import { create } from 'zustand'

/**
 * 搜索历史项
 */
export interface SearchHistoryItem {
  id: string
  keyword: string
  timestamp: Date
  type: 'real-directory' | 'virtual-directory'
}

/**
 * 搜索状态接口
 */
interface SearchState {
  // 真实目录搜索
  realDirectoryKeyword: string
  setRealDirectoryKeyword: (keyword: string) => void
  
  // 虚拟目录搜索
  virtualDirectoryKeyword: string
  setVirtualDirectoryKeyword: (keyword: string) => void
  
  // 搜索历史记录
  searchHistory: SearchHistoryItem[]
  addSearchHistory: (keyword: string, type: 'real-directory' | 'virtual-directory') => void
  clearSearchHistory: () => void
  removeSearchHistoryItem: (id: string) => void
  getSearchSuggestions: (type: 'real-directory' | 'virtual-directory', currentKeyword: string) => string[]
  
  // 清除搜索
  clearRealDirectorySearch: () => void
  clearVirtualDirectorySearch: () => void
}

/**
 * 搜索状态管理store
 */
export const useSearchStore = create<SearchState>((set, get) => ({
  // 初始状态
  realDirectoryKeyword: '',
  virtualDirectoryKeyword: '',
  searchHistory: loadSearchHistory(),
  
  // 设置真实目录搜索关键词（不自动添加历史记录，由SearchBar组件控制）
  setRealDirectoryKeyword: (keyword: string) => {
    set({ realDirectoryKeyword: keyword })
  },
  
  // 设置虚拟目录搜索关键词（不自动添加历史记录，由SearchBar组件控制）
  setVirtualDirectoryKeyword: (keyword: string) => {
    set({ virtualDirectoryKeyword: keyword })
  },
  
  // 添加搜索历史
  addSearchHistory: (keyword: string, type: 'real-directory' | 'virtual-directory') => {
    const trimmedKeyword = keyword.trim()
    if (!trimmedKeyword) return
    
    const state = get()
    
    // 检查是否已存在相同的搜索记录
    const existingIndex = state.searchHistory.findIndex(
      item => item.keyword === trimmedKeyword && item.type === type
    )
    
    let newHistory: SearchHistoryItem[]
    
    if (existingIndex !== -1) {
      // 如果存在，更新时间戳并移到最前面
      const existingItem = state.searchHistory[existingIndex]
      newHistory = [
        { ...existingItem, timestamp: new Date() },
        ...state.searchHistory.filter((_, index) => index !== existingIndex)
      ]
    } else {
      // 如果不存在，添加新记录
      newHistory = [
        {
          id: `${Date.now()}-${Math.random()}`,
          keyword: trimmedKeyword,
          timestamp: new Date(),
          type
        },
        ...state.searchHistory
      ]
    }
    
    // 限制历史记录数量为50条
    if (newHistory.length > 50) {
      newHistory = newHistory.slice(0, 50)
    }
    
    set({ searchHistory: newHistory })
    saveSearchHistory(newHistory)
  },
  
  // 清除所有搜索历史
  clearSearchHistory: () => {
    set({ searchHistory: [] })
    saveSearchHistory([])
  },
  
  // 移除单条搜索历史
  removeSearchHistoryItem: (id: string) => {
    const state = get()
    const newHistory = state.searchHistory.filter(item => item.id !== id)
    set({ searchHistory: newHistory })
    saveSearchHistory(newHistory)
  },
  
  // 获取搜索建议
  getSearchSuggestions: (type: 'real-directory' | 'virtual-directory', currentKeyword: string) => {
    const state = get()
    const trimmedKeyword = currentKeyword.trim().toLowerCase()
    
    if (!trimmedKeyword) {
      // 如果没有输入，返回最近的5条历史记录
      return state.searchHistory
        .filter(item => item.type === type)
        .slice(0, 5)
        .map(item => item.keyword)
    }
    
    // 根据关键词过滤并返回匹配的历史记录
    return state.searchHistory
      .filter(item => 
        item.type === type && 
        item.keyword.toLowerCase().includes(trimmedKeyword)
      )
      .slice(0, 5)
      .map(item => item.keyword)
  },
  
  // 清除真实目录搜索
  clearRealDirectorySearch: () => {
    set({ realDirectoryKeyword: '' })
  },
  
  // 清除虚拟目录搜索
  clearVirtualDirectorySearch: () => {
    set({ virtualDirectoryKeyword: '' })
  }
}))

/**
 * 从localStorage加载搜索历史
 */
function loadSearchHistory(): SearchHistoryItem[] {
  try {
    const stored = localStorage.getItem('search-history')
    if (stored) {
      const parsed = JSON.parse(stored)
      // 转换时间戳字符串为Date对象
      return parsed.map((item: any) => ({
        ...item,
        timestamp: new Date(item.timestamp)
      }))
    }
  } catch (error) {
    console.error('加载搜索历史失败:', error)
  }
  return []
}

/**
 * 保存搜索历史到localStorage
 */
function saveSearchHistory(history: SearchHistoryItem[]): void {
  try {
    localStorage.setItem('search-history', JSON.stringify(history))
  } catch (error) {
    console.error('保存搜索历史失败:', error)
  }
}
