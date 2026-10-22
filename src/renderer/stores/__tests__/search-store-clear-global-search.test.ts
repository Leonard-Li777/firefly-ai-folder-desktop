import { describe, it, expect, beforeEach } from 'vitest'
import { useSearchStore } from '../search-store'

/**
 * 退出搜索模式的收口验收锁：
 * 顶部搜索框一次输入会双写「全域关键词」与「当前页面本地关键词」，
 * 若 clearGlobalSearch 只清全域一侧，底层页面会滞留 search-list 视图并继续显示搜索结果。
 */
describe('search-store / clearGlobalSearch 退出搜索收口', () => {
  beforeEach(() => {
    useSearchStore.setState({
      globalSearchKeyword: '',
      searchTokens: [],
      isSearchOverlayOpen: false,
      realDirectoryKeyword: '',
      analyzedDirectoryKeyword: '',
      virtualDirectoryKeyword: ''
    })
  })

  it('退出搜索时同步复位三路页面本地关键词，杜绝真实目录页滞留搜索列表', () => {
    const state = useSearchStore.getState()
    state.setGlobalSearchKeyword('mp4')
    state.setRealDirectoryKeyword('mp4')
    state.setAnalyzedDirectoryKeyword('mp4')
    state.setSearchTokens(['mp4'])

    expect(useSearchStore.getState().isSearchOverlayOpen).toBe(true)

    useSearchStore.getState().clearGlobalSearch()

    const after = useSearchStore.getState()
    expect(after.globalSearchKeyword).toBe('')
    expect(after.isSearchOverlayOpen).toBe(false)
    expect(after.searchTokens).toEqual([])
    expect(after.realDirectoryKeyword).toBe('')
    // setAnalyzedDirectoryKeyword 会同时写入 analyzed 与 virtual 两路，退出时均须清空
    expect(after.analyzedDirectoryKeyword).toBe('')
    expect(after.virtualDirectoryKeyword).toBe('')
  })
})
