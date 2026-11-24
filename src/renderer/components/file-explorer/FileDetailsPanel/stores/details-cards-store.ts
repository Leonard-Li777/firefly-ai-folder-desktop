import { create } from 'zustand'
import { t } from '@app/languages'

/** 属性面板 4 大卡片受控唯一定识符 */
export const DETAILS_CARD_IDS = {
  MINI_PREVIEW: 'card_mini_preview',
  SUMMARY: 'card_summary',
  TAGS: 'card_tags',
  METRICS: 'card_metrics'
} as const

export type DetailsCardId = (typeof DETAILS_CARD_IDS)[keyof typeof DETAILS_CARD_IDS]

export const ALL_DETAILS_CARD_IDS: DetailsCardId[] = [
  DETAILS_CARD_IDS.MINI_PREVIEW,
  DETAILS_CARD_IDS.SUMMARY,
  DETAILS_CARD_IDS.TAGS,
  DETAILS_CARD_IDS.METRICS
]

/**
 * 严格遵循 i18n 构建期静态提取铁律：
 * 严禁在元数据对象中存储动态 t() 调用的 name，统一采用静态纯函数返回
 */
export const getDetailsCardTitle = (id: DetailsCardId): string => {
  const titles: Record<DetailsCardId, string> = {
    [DETAILS_CARD_IDS.MINI_PREVIEW]: t('迷你预览'),
    [DETAILS_CARD_IDS.SUMMARY]: t('文件名与描述'),
    [DETAILS_CARD_IDS.TAGS]: t('文件标签'),
    [DETAILS_CARD_IDS.METRICS]: t('分析指标')
  }
  return titles[id] ?? ''
}

export const getDetailsCardIcon = (id: DetailsCardId): string => {
  const icons: Record<DetailsCardId, string> = {
    [DETAILS_CARD_IDS.MINI_PREVIEW]: 'image',
    [DETAILS_CARD_IDS.SUMMARY]: 'article',
    [DETAILS_CARD_IDS.TAGS]: 'label',
    [DETAILS_CARD_IDS.METRICS]: 'analytics'
  }
  return icons[id] ?? 'extension'
}

const STORAGE_KEY_PREFIX = 'firefly:details-cards:v1:'

function getStoredCards(pageId: string): DetailsCardId[] | null {
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY_PREFIX}${pageId}`)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.length === 0) return null
    // 过滤掉非法或不存在的 ID
    const valid = parsed.filter((id): id is DetailsCardId =>
      ALL_DETAILS_CARD_IDS.includes(id as DetailsCardId)
    )
    return valid.length > 0 ? valid : null
  } catch {
    return null
  }
}

function saveStoredCards(pageId: string, cards: DetailsCardId[]): void {
  try {
    localStorage.setItem(`${STORAGE_KEY_PREFIX}${pageId}`, JSON.stringify(cards))
  } catch (err) {
    console.warn('[DetailsCardsStore] Failed to save cards to localStorage:', err)
  }
}

const pageCache = new Map<string, DetailsCardId[]>()

export function clearDetailsCardsMemoryCache(): void {
  pageCache.clear()
}

interface DetailsCardsState {
  /** pageId -> 当前可见的卡片列表（保持枚举顺序） */
  visibleCardsByPage: Record<string, DetailsCardId[]>

  /** 切换特定卡片的开闭状态（含单卡保留防御：只剩 1 张时禁止关闭） */
  toggleCard: (pageId: string, cardId: DetailsCardId) => void

  /** 重置指定页面的卡片集合至初始全显状态 */
  resetCards: (pageId: string) => void

  /** 获取指定页面的有效可见卡片列表（含损坏数据自愈兜底与引用守恒缓存） */
  getVisibleCards: (pageId: string) => DetailsCardId[]
}

export const useDetailsCardsStore = create<DetailsCardsState>((set, get) => ({
  visibleCardsByPage: {},

  getVisibleCards: (pageId: string) => {
    const state = get()
    if (state.visibleCardsByPage[pageId]) {
      pageCache.set(pageId, state.visibleCardsByPage[pageId])
      return state.visibleCardsByPage[pageId]
    }
    if (!pageCache.has(pageId)) {
      const stored = getStoredCards(pageId)
      pageCache.set(pageId, stored ?? ALL_DETAILS_CARD_IDS)
    }
    return pageCache.get(pageId)!
  },

  toggleCard: (pageId: string, cardId: DetailsCardId) => {
    const current = get().getVisibleCards(pageId)
    const isVisible = current.includes(cardId)

    if (isVisible) {
      // 单卡保留防御：如果当前只剩 1 张可见卡片，绝对禁止关闭
      if (current.length <= 1) {
        return
      }
      const next = current.filter(id => id !== cardId)
      saveStoredCards(pageId, next)
      pageCache.set(pageId, next)
      set(prev => ({
        visibleCardsByPage: {
          ...prev.visibleCardsByPage,
          [pageId]: next
        }
      }))
    } else {
      // 恢复显示，保持 ALL_DETAILS_CARD_IDS 的固定基线顺序
      const next = ALL_DETAILS_CARD_IDS.filter(id => id === cardId || current.includes(id))
      saveStoredCards(pageId, next)
      pageCache.set(pageId, next)
      set(prev => ({
        visibleCardsByPage: {
          ...prev.visibleCardsByPage,
          [pageId]: next
        }
      }))
    }
  },

  resetCards: (pageId: string) => {
    const initial = [...ALL_DETAILS_CARD_IDS]
    saveStoredCards(pageId, initial)
    pageCache.set(pageId, initial)
    set(prev => ({
      visibleCardsByPage: {
        ...prev.visibleCardsByPage,
        [pageId]: initial
      }
    }))
  }
}))
