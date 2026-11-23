import { create } from 'zustand'
import { PageId } from '../constants/page-ids'
import {
  LAYOUT_KEYS,
  type LayoutKey,
  PANEL_IDS,
  type PanelId,
  LAYOUT_PRESETS,
  PAGE_DEFAULT_LAYOUT,
  PAGE_LAYOUT_CAPABILITY
} from '../components/file-explorer/layout-switcher/types'
import { parseWorkspaceConfig, type WorkspaceConfig } from '@firefly/types'

export const buildLayoutStorageKey = (
  pageId: string,
  workspaceId?: number | string | null
): string => {
  return workspaceId != null ? `hub_layout_v1_${pageId}_${workspaceId}` : `hub_layout_v1_${pageId}`
}

const memoryStorageFallback = new Map<string, string>()

export const safeLayoutStorage = {
  getItem: (key: string): string | null => {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        return window.localStorage.getItem(key)
      }
      return memoryStorageFallback.get(key) ?? null
    } catch {
      return memoryStorageFallback.get(key) ?? null
    }
  },
  setItem: (key: string, value: string): void => {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(key, value)
        return
      }
      memoryStorageFallback.set(key, value)
    } catch (e) {
      memoryStorageFallback.set(key, value)
      console.warn(`[safeLayoutStorage] localStorage 写入受阻，退化为内存保持: ${key}`, e)
    }
  },
  removeItem: (key: string): void => {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.removeItem(key)
      }
      memoryStorageFallback.delete(key)
    } catch {
      memoryStorageFallback.delete(key)
    }
  },
  /** 穿透清空某个工作区在所有页面上的布局覆盖 */
  clearWorkspace: (workspaceId: number | string, pageId?: PageId): void => {
    const wsIdStr = String(workspaceId)
    if (pageId) {
      const storageKey = buildLayoutStorageKey(pageId, workspaceId)
      safeLayoutStorage.removeItem(storageKey)
      return
    }
    // 遍历 localStorage 与 memoryStorageFallback
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const keysToRemove: string[] = []
        for (let i = 0; i < window.localStorage.length; i++) {
          const k = window.localStorage.key(i)
          if (k && k.startsWith('hub_layout_v1_') && k.endsWith(`_${wsIdStr}`)) {
            keysToRemove.push(k)
          }
        }
        for (const k of keysToRemove) {
          window.localStorage.removeItem(k)
        }
      }
    } catch {}

    for (const k of Array.from(memoryStorageFallback.keys())) {
      if (k.startsWith('hub_layout_v1_') && k.endsWith(`_${wsIdStr}`)) {
        memoryStorageFallback.delete(k)
      }
    }
  }
}

/**
 * 纯函数三级流水线决策函数：
 * Level 1: 用户显式意图 (safeLayoutStorage 命中有效布局)
 * Level 2: 工作流推荐基线 (readyConfig.defaultLayout 且在白名单内)
 * Level 3: 页面能力保底 (PAGE_DEFAULT_LAYOUT[pageId] ?? 'all-row')
 */
export function resolveLayoutDecision(params: {
  pageId: PageId
  workspaceId?: number | string | null
  workspaceConfig?: WorkspaceConfig | string | null
  persistedUserLayout?: { key: LayoutKey; visible?: PanelId[]; visiblePanels?: PanelId[] } | null
}): { key: LayoutKey; visiblePanels: PanelId[]; source: 'user' | 'workflow' | 'page_default' } {
  const { pageId, workspaceId, workspaceConfig, persistedUserLayout } = params
  const validPageKeys = PAGE_LAYOUT_CAPABILITY[pageId] ?? []

  // Level 1: 用户显式覆盖
  let userOverride = persistedUserLayout
  if (userOverride === undefined) {
    const key = buildLayoutStorageKey(pageId, workspaceId)
    const raw = safeLayoutStorage.getItem(key)
    if (raw) {
      try {
        userOverride = JSON.parse(raw)
      } catch {
        userOverride = null
      }
    } else {
      userOverride = null
    }
  }

  if (
    userOverride &&
    typeof userOverride.key === 'string' &&
    validPageKeys.includes(userOverride.key)
  ) {
    const preset = LAYOUT_PRESETS[userOverride.key]
    const rawVisible = Array.isArray(userOverride.visible)
      ? userOverride.visible
      : Array.isArray(userOverride.visiblePanels)
        ? userOverride.visiblePanels
        : preset.panels
    const visiblePanels = [
      PANEL_IDS.LIST,
      ...rawVisible.filter(p => p !== PANEL_IDS.LIST && preset.panels.includes(p))
    ]
    return {
      key: userOverride.key,
      visiblePanels,
      source: 'user'
    }
  }

  // Level 2: 工作流推荐基线
  const parsedConfig =
    typeof workspaceConfig === 'string'
      ? parseWorkspaceConfig(workspaceConfig)
      : workspaceConfig
  if (
    parsedConfig &&
    parsedConfig.status === 'ready' &&
    parsedConfig.defaultLayout &&
    validPageKeys.includes(parsedConfig.defaultLayout)
  ) {
    const preset = LAYOUT_PRESETS[parsedConfig.defaultLayout]
    return {
      key: parsedConfig.defaultLayout,
      visiblePanels: [...preset.panels],
      source: 'workflow'
    }
  }

  // Level 3: 页面能力保底
  const defaultKey = PAGE_DEFAULT_LAYOUT[pageId] ?? validPageKeys[0] ?? LAYOUT_KEYS.ALL_ROW
  const fallbackKey = validPageKeys.includes(defaultKey)
    ? defaultKey
    : validPageKeys[0] ?? LAYOUT_KEYS.ALL_ROW
  const fallbackPreset = LAYOUT_PRESETS[fallbackKey] ?? LAYOUT_PRESETS[LAYOUT_KEYS.ALL_ROW]
  return {
    key: fallbackKey,
    visiblePanels: [...fallbackPreset.panels],
    source: 'page_default'
  }
}

export interface LayoutSwitcherState {
  /** 复合键 `${pageId}:${workspaceId ?? 'global'}` 维度的用户显式覆盖状态字典 */
  userOverrides: Record<string, { key: LayoutKey; visible?: PanelId[]; visiblePanels: PanelId[] }>

  /** 获取当前环境下的最终有效布局（纯函数三级流水线解析） */
  getEffectiveLayout: (
    pageId: PageId,
    workspaceId?: number | string | null,
    workspaceConfig?: WorkspaceConfig | string | null
  ) => LayoutKey

  /** 切换布局：更新当前工作区覆盖并安全持久化 */
  setPageLayout: (pageId: PageId, key: LayoutKey, workspaceId?: number | string | null) => void

  /** 关闭单个面板：更新 visiblePanels 并持久化 */
  closePanel: (pageId: PageId, panel: PanelId, workspaceId?: number | string | null) => void

  /** 重新展开单个面板：必要时升级 key，更新 visiblePanels 并持久化 */
  openPanel: (pageId: PageId, panel: PanelId, workspaceId?: number | string | null) => void

  /**
   * 重置工作区布局偏好（工作区设置切换工作流时调用）：
   * 若未指定 pageId，自动穿透清扫该工作区在所有 Hub 页面上的持久化键并同步重置 State
   */
  clearUserLayout: (workspaceId: number | string, pageId?: PageId) => void

  /** 获取当前可见面板集合 */
  getVisiblePanels: (
    pageId: PageId,
    workspaceId?: number | string | null,
    workspaceConfig?: WorkspaceConfig | string | null
  ) => PanelId[]
}

export const useLayoutSwitcherStore = create<LayoutSwitcherState>((set, get) => ({
  userOverrides: {},

  getEffectiveLayout: (pageId, workspaceId, workspaceConfig) => {
    const compositeKey = `${pageId}:${workspaceId ?? 'global'}`
    const inMemory = get().userOverrides[compositeKey]
    const decision = resolveLayoutDecision({
      pageId,
      workspaceId,
      workspaceConfig,
      persistedUserLayout: inMemory
    })
    return decision.key
  },

  getVisiblePanels: (pageId, workspaceId, workspaceConfig) => {
    const compositeKey = `${pageId}:${workspaceId ?? 'global'}`
    const inMemory = get().userOverrides[compositeKey]
    const decision = resolveLayoutDecision({
      pageId,
      workspaceId,
      workspaceConfig,
      persistedUserLayout: inMemory
    })
    return decision.visiblePanels
  },

  setPageLayout: (pageId, key, workspaceId) => {
    const validKeys = PAGE_LAYOUT_CAPABILITY[pageId] ?? []
    if (!validKeys.includes(key)) {
      return
    }
    const preset = LAYOUT_PRESETS[key]
    const visiblePanels = [...preset.panels]
    const storageKey = buildLayoutStorageKey(pageId, workspaceId)
    safeLayoutStorage.setItem(storageKey, JSON.stringify({ key, visible: visiblePanels }))

    const compositeKey = `${pageId}:${workspaceId ?? 'global'}`
    set(state => ({
      userOverrides: {
        ...state.userOverrides,
        [compositeKey]: { key, visible: visiblePanels, visiblePanels }
      }
    }))
  },

  closePanel: (pageId, panel, workspaceId) => {
    if (panel === PANEL_IDS.LIST) return // list 恒不可关
    const compositeKey = `${pageId}:${workspaceId ?? 'global'}`
    const currentKey = get().getEffectiveLayout(pageId, workspaceId)
    const currentPanels = get().getVisiblePanels(pageId, workspaceId)
    const nextPanels = currentPanels.filter(p => p !== panel)
    if (!nextPanels.includes(PANEL_IDS.LIST)) {
      nextPanels.unshift(PANEL_IDS.LIST)
    }

    const storageKey = buildLayoutStorageKey(pageId, workspaceId)
    safeLayoutStorage.setItem(storageKey, JSON.stringify({ key: currentKey, visible: nextPanels }))

    set(state => ({
      userOverrides: {
        ...state.userOverrides,
        [compositeKey]: { key: currentKey, visible: nextPanels, visiblePanels: nextPanels }
      }
    }))
  },

  openPanel: (pageId, panel, workspaceId) => {
    if (panel === PANEL_IDS.LIST) return
    const compositeKey = `${pageId}:${workspaceId ?? 'global'}`
    const currentKey = get().getEffectiveLayout(pageId, workspaceId)
    const currentPanels = get().getVisiblePanels(pageId, workspaceId)
    const currentPreset = LAYOUT_PRESETS[currentKey]

    let nextKey = currentKey
    if (currentPreset && !currentPreset.panels.includes(panel)) {
      // 需要按确定性映射平滑升级预设
      if (currentKey === LAYOUT_KEYS.LIST_ONLY) {
        nextKey = panel === PANEL_IDS.PREVIEW ? LAYOUT_KEYS.LIST_PREVIEW : LAYOUT_KEYS.LIST_DETAILS
      } else if (currentKey === LAYOUT_KEYS.LIST_PREVIEW && panel === PANEL_IDS.DETAILS) {
        nextKey = LAYOUT_KEYS.ALL_ROW
      } else if (currentKey === LAYOUT_KEYS.LIST_DETAILS && panel === PANEL_IDS.PREVIEW) {
        nextKey = LAYOUT_KEYS.ALL_ROW
      }
    }

    const nextPanelsSet = new Set(currentPanels)
    nextPanelsSet.add(PANEL_IDS.LIST)
    nextPanelsSet.add(panel)
    const targetPreset = LAYOUT_PRESETS[nextKey]
    const nextPanels = targetPreset.panels.filter(p => nextPanelsSet.has(p))

    const storageKey = buildLayoutStorageKey(pageId, workspaceId)
    safeLayoutStorage.setItem(storageKey, JSON.stringify({ key: nextKey, visible: nextPanels }))

    set(state => ({
      userOverrides: {
        ...state.userOverrides,
        [compositeKey]: { key: nextKey, visible: nextPanels, visiblePanels: nextPanels }
      }
    }))
  },

  clearUserLayout: (workspaceId, pageId) => {
    safeLayoutStorage.clearWorkspace(workspaceId, pageId)
    const wsIdStr = String(workspaceId)
    set(state => {
      const nextOverrides = { ...state.userOverrides }
      for (const k of Object.keys(nextOverrides)) {
        if (pageId) {
          if (k === `${pageId}:${wsIdStr}`) {
            delete nextOverrides[k]
          }
        } else {
          if (k.endsWith(`:${wsIdStr}`)) {
            delete nextOverrides[k]
          }
        }
      }
      return { userOverrides: nextOverrides }
    })
  }
}))
