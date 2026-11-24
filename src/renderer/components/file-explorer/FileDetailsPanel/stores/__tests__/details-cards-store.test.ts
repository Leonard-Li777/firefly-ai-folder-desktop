import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  useDetailsCardsStore,
  DETAILS_CARD_IDS,
  ALL_DETAILS_CARD_IDS,
  getDetailsCardTitle,
  getDetailsCardIcon,
  clearDetailsCardsMemoryCache
} from '../details-cards-store'

vi.mock('@app/languages', () => ({
  t: (str: string) => str
}))

describe('DetailsCardsStore (4微宫格卡片状态代数与单卡防御)', () => {
  beforeEach(() => {
    localStorage.clear()
    clearDetailsCardsMemoryCache()
    useDetailsCardsStore.setState({ visibleCardsByPage: {} })
  })

  it('初始状态：默认返回全集 4 张卡片', () => {
    const pageId = 'page_search'
    const cards = useDetailsCardsStore.getState().getVisibleCards(pageId)
    expect(cards).toEqual(ALL_DETAILS_CARD_IDS)
    expect(cards).toHaveLength(4)
  })

  it('关闭卡片：能够正常隐藏卡片并按顺序保持', () => {
    const pageId = 'page_search'
    const store = useDetailsCardsStore.getState()

    store.toggleCard(pageId, DETAILS_CARD_IDS.MINI_PREVIEW)
    let visible = useDetailsCardsStore.getState().getVisibleCards(pageId)
    expect(visible).not.toContain(DETAILS_CARD_IDS.MINI_PREVIEW)
    expect(visible).toEqual([
      DETAILS_CARD_IDS.SUMMARY,
      DETAILS_CARD_IDS.TAGS,
      DETAILS_CARD_IDS.METRICS
    ])

    // 重新打开
    store.toggleCard(pageId, DETAILS_CARD_IDS.MINI_PREVIEW)
    visible = useDetailsCardsStore.getState().getVisibleCards(pageId)
    expect(visible).toEqual(ALL_DETAILS_CARD_IDS)
  })

  it('单卡保留防御：当只剩 1 张卡片时禁止关闭（Anti-Ghost-Panel Invariant）', () => {
    const pageId = 'page_search'
    const store = useDetailsCardsStore.getState()

    // 依次关闭 3 张卡片
    store.toggleCard(pageId, DETAILS_CARD_IDS.MINI_PREVIEW)
    store.toggleCard(pageId, DETAILS_CARD_IDS.SUMMARY)
    store.toggleCard(pageId, DETAILS_CARD_IDS.TAGS)

    let visible = useDetailsCardsStore.getState().getVisibleCards(pageId)
    expect(visible).toEqual([DETAILS_CARD_IDS.METRICS])

    // 尝试关闭最后 1 张卡片
    store.toggleCard(pageId, DETAILS_CARD_IDS.METRICS)
    visible = useDetailsCardsStore.getState().getVisibleCards(pageId)
    // 依然保留最后 1 张，禁止变为空数组
    expect(visible).toEqual([DETAILS_CARD_IDS.METRICS])
  })

  it('多页面状态独立隔离：pageA 与 pageB 互不影响', () => {
    const store = useDetailsCardsStore.getState()
    store.toggleCard('pageA', DETAILS_CARD_IDS.MINI_PREVIEW)

    const cardsA = store.getVisibleCards('pageA')
    const cardsB = store.getVisibleCards('pageB')

    expect(cardsA).not.toContain(DETAILS_CARD_IDS.MINI_PREVIEW)
    expect(cardsB).toEqual(ALL_DETAILS_CARD_IDS)
  })

  it('持久化脏数据自愈：损坏或空缓存自动回退全显', () => {
    localStorage.setItem('firefly:details-cards:v1:corrupt_page', JSON.stringify([]))
    const cards1 = useDetailsCardsStore.getState().getVisibleCards('corrupt_page')
    expect(cards1).toEqual(ALL_DETAILS_CARD_IDS)

    localStorage.setItem('firefly:details-cards:v1:invalid_page', '{"invalid": "json')
    const cards2 = useDetailsCardsStore.getState().getVisibleCards('invalid_page')
    expect(cards2).toEqual(ALL_DETAILS_CARD_IDS)
  })

  it('纯函数标题与图标映射正确', () => {
    expect(getDetailsCardTitle(DETAILS_CARD_IDS.MINI_PREVIEW)).toBe('迷你预览')
    expect(getDetailsCardTitle(DETAILS_CARD_IDS.SUMMARY)).toBe('文件名与描述')
    expect(getDetailsCardTitle(DETAILS_CARD_IDS.TAGS)).toBe('受控标签')
    expect(getDetailsCardTitle(DETAILS_CARD_IDS.METRICS)).toBe('分析指标')

    expect(getDetailsCardIcon(DETAILS_CARD_IDS.MINI_PREVIEW)).toBe('image')
  })
})
