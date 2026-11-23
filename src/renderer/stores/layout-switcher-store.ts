import { create } from 'zustand'
import {
  PANEL_IDS,
  PanelId,
  LAYOUT_KEYS,
  LayoutKey,
  PAGE_IDS,
  PageId,
  LAYOUT_PRESETS,
  getPageDefaultLayout,
  isLayoutSwitcherEnabled
} from '../components/file-explorer/layout-switcher'

const STORAGE_KEY = 'layout_switcher_v1_layouts'

export interface LayoutSwitcherState {
  pageLayouts: Record<string, LayoutKey>
  visiblePanels: Record<string, PanelId[]>

  setPageLayout: (pageId: string, key: LayoutKey) => void
  closePanel: (pageId: string, panel: PanelId) => void
  openPanel: (pageId: string, panel: PanelId) => void
  getVisiblePanels: (pageId: string) => PanelId[]
  getLayoutKey: (pageId: string) => LayoutKey
  resetPageLayout: (pageId: string) => void
  resetAll: () => void
  clearUserLayout: (workspaceId?: string | number) => void
}

/** 生成方向敏感持久化尺寸键 */
export function getDirectionalStorageKey(
  pageId: string,
  slot: 'primary' | 'companion',
  direction: 'horizontal' | 'vertical'
): string {
  const dirSuffix = direction === 'horizontal' ? 'h' : 'v'
  return `hub_split_v1_${pageId}_${slot}_${dirSuffix}`
}

interface PersistedData {
  pageLayouts: Record<string, LayoutKey>
  visiblePanels: Record<string, PanelId[]>
}

function loadPersistedState(): PersistedData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { pageLayouts: {}, visiblePanels: {} }
    const parsed = JSON.parse(raw) as Partial<PersistedData>
    const safeLayouts: Record<string, LayoutKey> = {}
    const safePanels: Record<string, PanelId[]> = {}

    if (parsed.pageLayouts && typeof parsed.pageLayouts === 'object') {
      for (const [pId, key] of Object.entries(parsed.pageLayouts)) {
        if (LAYOUT_PRESETS[key]) {
          safeLayouts[pId] = key
        }
      }
    }

    if (parsed.visiblePanels && typeof parsed.visiblePanels === 'object') {
      for (const [pId, panels] of Object.entries(parsed.visiblePanels)) {
        if (Array.isArray(panels)) {
          const valid = panels.filter(p => Object.values(PANEL_IDS).includes(p))
          if (!valid.includes(PANEL_IDS.LIST)) {
            valid.unshift(PANEL_IDS.LIST)
          }
          safePanels[pId] = valid
        }
      }
    }

    return { pageLayouts: safeLayouts, visiblePanels: safePanels }
  } catch {
    return { pageLayouts: {}, visiblePanels: {} }
  }
}

function persistState(state: {
  pageLayouts: Record<string, LayoutKey>
  visiblePanels: Record<string, PanelId[]>
}) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // ignore
  }
}

const initialPersisted = loadPersistedState()

export const useLayoutSwitcherStore = create<LayoutSwitcherState>((set, get) => ({
  pageLayouts: initialPersisted.pageLayouts,
  visiblePanels: initialPersisted.visiblePanels,

  getLayoutKey: (pageId: string) => {
    const custom = get().pageLayouts[pageId]
    if (custom && LAYOUT_PRESETS[custom]) {
      return custom
    }
    return getPageDefaultLayout(pageId)
  },

  getVisiblePanels: (pageId: string) => {
    const customPanels = get().visiblePanels[pageId]
    if (customPanels && customPanels.length > 0 && customPanels.includes(PANEL_IDS.LIST)) {
      return customPanels
    }
    const currentKey = get().getLayoutKey(pageId)
    const preset = LAYOUT_PRESETS[currentKey] ?? LAYOUT_PRESETS[LAYOUT_KEYS.ALL_ROW]
    return preset.panels as PanelId[]
  },

  setPageLayout: (pageId: string, key: LayoutKey) => {
    const targetDef = LAYOUT_PRESETS[key] ?? LAYOUT_PRESETS[LAYOUT_KEYS.ALL_ROW]
    // 切换布局无条件重置可见面板为预设完整集合（一键恢复）
    const nextPanels = [...targetDef.panels]

    set(state => {
      const nextPageLayouts = { ...state.pageLayouts, [pageId]: targetDef.key }
      const nextVisiblePanels = { ...state.visiblePanels, [pageId]: nextPanels }
      persistState({ pageLayouts: nextPageLayouts, visiblePanels: nextVisiblePanels })
      return {
        pageLayouts: nextPageLayouts,
        visiblePanels: nextVisiblePanels
      }
    })
  },

  closePanel: (pageId: string, panel: PanelId) => {
    // 列表恒显不可关！
    if (panel === PANEL_IDS.LIST) return

    const currentVisible = get().getVisiblePanels(pageId)
    if (!currentVisible.includes(panel)) return

    const nextVisible = currentVisible.filter(p => p !== panel)
    if (!nextVisible.includes(PANEL_IDS.LIST)) {
      nextVisible.unshift(PANEL_IDS.LIST)
    }

    set(state => {
      const nextVisiblePanels = { ...state.visiblePanels, [pageId]: nextVisible }
      persistState({ pageLayouts: state.pageLayouts, visiblePanels: nextVisiblePanels })
      return { visiblePanels: nextVisiblePanels }
    })
  },

  openPanel: (pageId: string, panel: PanelId) => {
    const currentVisible = get().getVisiblePanels(pageId)
    if (currentVisible.includes(panel)) return

    const currentKey = get().getLayoutKey(pageId)
    let nextKey = currentKey
    let nextPanels = [...currentVisible, panel]

    // 状态代数升级确定性映射表
    if (currentKey === LAYOUT_KEYS.LIST_ONLY) {
      if (panel === PANEL_IDS.PREVIEW) {
        nextKey = LAYOUT_KEYS.LIST_PREVIEW
        nextPanels = [PANEL_IDS.LIST, PANEL_IDS.PREVIEW]
      } else if (panel === PANEL_IDS.DETAILS) {
        nextKey = LAYOUT_KEYS.LIST_DETAILS
        nextPanels = [PANEL_IDS.LIST, PANEL_IDS.DETAILS]
      }
    } else if (currentKey === LAYOUT_KEYS.LIST_PREVIEW) {
      if (panel === PANEL_IDS.DETAILS) {
        nextKey = LAYOUT_KEYS.ALL_ROW
        nextPanels = [PANEL_IDS.LIST, PANEL_IDS.PREVIEW, PANEL_IDS.DETAILS]
      }
    } else if (currentKey === LAYOUT_KEYS.LIST_DETAILS) {
      if (panel === PANEL_IDS.PREVIEW) {
        nextKey = LAYOUT_KEYS.ALL_ROW
        nextPanels = [PANEL_IDS.LIST, PANEL_IDS.PREVIEW, PANEL_IDS.DETAILS]
      }
    } else {
      // 当前预设已含三面板，仅将面板重新加回可见集
      const preset = LAYOUT_PRESETS[currentKey]
      nextPanels = preset.panels.filter(p => p === panel || currentVisible.includes(p))
    }

    set(state => {
      const nextPageLayouts = { ...state.pageLayouts, [pageId]: nextKey }
      const nextVisiblePanels = { ...state.visiblePanels, [pageId]: nextPanels }
      persistState({ pageLayouts: nextPageLayouts, visiblePanels: nextVisiblePanels })
      return {
        pageLayouts: nextPageLayouts,
        visiblePanels: nextVisiblePanels
      }
    })
  },

  resetPageLayout: (pageId: string) => {
    const defaultKey = getPageDefaultLayout(pageId)
    get().setPageLayout(pageId, defaultKey)
  },

  resetAll: () => {
    set({
      pageLayouts: {},
      visiblePanels: {}
    })
  },

  clearUserLayout: (_workspaceId?: string | number) => {
    get().resetAll()
  }
}))
