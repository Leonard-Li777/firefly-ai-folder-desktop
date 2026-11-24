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
  getPageLayouts,
  getLayoutDefinition,
  isLayoutSwitcherEnabled
} from '../components/file-explorer/layout-switcher'

const LEGACY_STORAGE_KEY = 'layout_switcher_v1_layouts'

/** 安全持久化包装器内存降级缓存 (防御 localStorage 异常或隐私模式) */
const memoryStorageFallback = new Map<string, string>()

export const safeLayoutStorage = {
  getItem: (key: string): string | null => {
    try {
      return localStorage.getItem(key)
    } catch {
      return memoryStorageFallback.get(key) ?? null
    }
  },
  setItem: (key: string, value: string): void => {
    try {
      localStorage.setItem(key, value)
    } catch (e) {
      memoryStorageFallback.set(key, value)
      console.warn(`[safeLayoutStorage] localStorage 写入受阻，退化为内存保持: ${key}`, e)
    }
  },
  removeItem: (key: string): void => {
    try {
      localStorage.removeItem(key)
    } catch {
      // ignore
    }
    memoryStorageFallback.delete(key)
  }
}

/** 生成按页面与工作区隔离的布局存储键 (L3 Spec §3.4.3) */
export function buildLayoutStorageKey(
  pageId: string,
  workspaceId?: number | string | null
): string {
  return workspaceId != null ? `hub_layout_v1_${pageId}_${workspaceId}` : `hub_layout_v1_${pageId}`
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

export interface UserLayoutItem {
  key: LayoutKey
  visiblePanels: PanelId[]
}

export interface ResolveLayoutDecisionParams {
  pageId: PageId | string
  workspaceId?: number | string | null
  workspaceConfig?: any
  persistedUserLayout?: { key?: LayoutKey; visiblePanels?: PanelId[] } | null
}

export interface ResolveLayoutDecisionResult {
  key: LayoutKey
  visiblePanels: PanelId[]
  source: 'user' | 'workflow' | 'page_default'
}

/**
 * 纯函数三级解析代数流水线 (L3 Spec §2.2)
 *
 * Level 1: 用户显式意图 (User Explicit Action)
 *    ↓ 检查安全缓存: safeLayoutStorage.getItem(`hub_layout_v1_${pageId}_${workspaceId}`)
 *    ↓ 命中合法有效布局 ➔ 权威采纳（source: 'user'，严格守恒 ADR-0062）
 * Level 2: 工作流推荐基线 (Workflow Default Layout)
 *    ↓ 消毒解析当前工作区: parseWorkspaceConfig(currentWorkspaceDirectory?.workspace_config)
 *    ↓ 命中 readyConfig.defaultLayout 且在页面白名单内 ➔ 采纳工作流适配布局（source: 'workflow'）
 * Level 3: 页面能力保底 (Page Capability Fallback)
 *    ↓ 取受控单一事实源常量 getPageDefaultLayout(pageId) ?? 'all-row'
 *    ↓ 终态收敛保底（source: 'page_default'，确保首屏外观稳定）
 */
export function resolveLayoutDecision(
  params: ResolveLayoutDecisionParams
): ResolveLayoutDecisionResult {
  const { pageId, workspaceConfig, persistedUserLayout } = params
  const allowedPresets = getPageLayouts(pageId)
  const defaultPageKey = getPageDefaultLayout(pageId)

  // Level 1: 用户显式覆盖 (User Explicit Action)
  if (persistedUserLayout?.key && allowedPresets.includes(persistedUserLayout.key)) {
    const preset = getLayoutDefinition(persistedUserLayout.key)
    let visible = persistedUserLayout.visiblePanels
    if (!visible || !Array.isArray(visible) || !visible.includes(PANEL_IDS.LIST)) {
      visible = preset.panels as PanelId[]
    }
    return {
      key: persistedUserLayout.key,
      visiblePanels: visible,
      source: 'user'
    }
  }

  // Level 2: 工作流推荐基线 (Workflow Default Layout)
  if (workspaceConfig) {
    let parsed: any = workspaceConfig
    if (typeof workspaceConfig === 'string') {
      try {
        parsed = JSON.parse(workspaceConfig)
      } catch {
        parsed = null
      }
    }
    const workflowDefault = parsed?.defaultLayout
    if (
      typeof workflowDefault === 'string' &&
      allowedPresets.includes(workflowDefault as LayoutKey)
    ) {
      const targetKey = workflowDefault as LayoutKey
      const preset = getLayoutDefinition(targetKey)
      return {
        key: targetKey,
        visiblePanels: preset.panels as PanelId[],
        source: 'workflow'
      }
    }
  }

  // Level 3: 页面能力保底 (Page Capability Fallback)
  const fallbackKey = allowedPresets.includes(defaultPageKey)
    ? defaultPageKey
    : (allowedPresets[0] ?? LAYOUT_KEYS.ALL_ROW)
  const preset = getLayoutDefinition(fallbackKey)
  return {
    key: fallbackKey,
    visiblePanels: preset.panels as PanelId[],
    source: 'page_default'
  }
}

export interface LayoutSwitcherState {
  /** 兼容旧代码的全局页面布局字典 */
  pageLayouts: Record<string, LayoutKey>
  /** 兼容旧代码的全局可见面板字典 */
  visiblePanels: Record<string, PanelId[]>
  /** 复合键 `${pageId}:${workspaceId ?? 'global'}` 维度的用户显式覆盖状态字典 */
  userOverrides: Record<string, UserLayoutItem>

  /** 获取当前环境下的最终有效布局（纯函数三级流水线解析） */
  getEffectiveLayout: (
    pageId: string,
    workspaceId?: number | string | null,
    workspaceConfig?: any
  ) => LayoutKey

  /** 兼容别名：等同于 getEffectiveLayout */
  getLayoutKey: (
    pageId: string,
    workspaceId?: number | string | null,
    workspaceConfig?: any
  ) => LayoutKey

  /** 获取当前可见面板集合 */
  getVisiblePanels: (
    pageId: string,
    workspaceId?: number | string | null,
    workspaceConfig?: any
  ) => PanelId[]

  /** 切换布局：更新当前工作区覆盖并安全持久化 */
  setPageLayout: (pageId: string, key: LayoutKey, workspaceId?: number | string | null) => void

  /** 关闭单个面板：更新 visiblePanels 并持久化 */
  closePanel: (pageId: string, panel: PanelId, workspaceId?: number | string | null) => void

  /** 重新展开单个面板：状态代数升级，更新 visiblePanels 并持久化 */
  openPanel: (pageId: string, panel: PanelId, workspaceId?: number | string | null) => void

  /** 重置单个页面布局为默认 */
  resetPageLayout: (pageId: string, workspaceId?: number | string | null) => void

  /** 全量清空内存状态 */
  resetAll: () => void

  /**
   * 重置工作区布局偏好（工作区设置切换工作流时调用）：
   * 若未指定 pageId，自动穿透清扫该工作区在所有 Hub 页面上的持久化键并同步重置 State
   */
  clearUserLayout: (workspaceId?: string | number, pageId?: PageId | string) => void
}

/** 用户覆盖持久化对象内存缓存（避免反复 JSON.parse 产生新数组引用破坏 React 19 快照比对） */
export const persistedDiskCache = new Map<string, UserLayoutItem | null>()

/** 清空磁盘缓存镜像（单测与强重置使用） */
export function clearPersistedLayoutCache(): void {
  persistedDiskCache.clear()
}

/** 读取已持久化的用户单项覆盖 */
function readPersistedUserOverride(
  pageId: string,
  workspaceId?: number | string | null
): UserLayoutItem | null {
  const storageKey = buildLayoutStorageKey(pageId, workspaceId)
  if (persistedDiskCache.has(storageKey)) {
    return persistedDiskCache.get(storageKey) ?? null
  }
  const raw = safeLayoutStorage.getItem(storageKey)
  if (!raw) {
    persistedDiskCache.set(storageKey, null)
    return null
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      const key = parsed.key as LayoutKey
      if (LAYOUT_PRESETS[key]) {
        let panels: PanelId[] = Array.isArray(parsed.visiblePanels)
          ? parsed.visiblePanels.filter((p: any) => Object.values(PANEL_IDS).includes(p))
          : (LAYOUT_PRESETS[key].panels as PanelId[])
        if (!panels.includes(PANEL_IDS.LIST)) {
          panels.unshift(PANEL_IDS.LIST)
        }
        const item: UserLayoutItem = { key, visiblePanels: panels }
        persistedDiskCache.set(storageKey, item)
        return item
      }
    }
  } catch {
    // ignore corrupted json
  }
  persistedDiskCache.set(storageKey, null)
  return null
}

/** 兼容旧版 loadPersistedState */
function loadLegacyPersistedState(): {
  pageLayouts: Record<string, LayoutKey>
  visiblePanels: Record<string, PanelId[]>
} {
  try {
    const raw = safeLayoutStorage.getItem(LEGACY_STORAGE_KEY)
    if (!raw) return { pageLayouts: {}, visiblePanels: {} }
    const parsed = JSON.parse(raw)
    const safeLayouts: Record<string, LayoutKey> = {}
    const safePanels: Record<string, PanelId[]> = {}

    if (parsed.pageLayouts && typeof parsed.pageLayouts === 'object') {
      for (const [pId, key] of Object.entries(parsed.pageLayouts)) {
        if (LAYOUT_PRESETS[key as LayoutKey]) {
          safeLayouts[pId] = key as LayoutKey
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

const legacyPersisted = loadLegacyPersistedState()

export const useLayoutSwitcherStore = create<LayoutSwitcherState>((set, get) => ({
  pageLayouts: legacyPersisted.pageLayouts,
  visiblePanels: legacyPersisted.visiblePanels,
  userOverrides: {},

  getEffectiveLayout: (
    pageId: string,
    workspaceId?: number | string | null,
    workspaceConfig?: any
  ): LayoutKey => {
    const overrideKey = `${pageId}:${workspaceId ?? 'global'}`
    let userOverride = get().userOverrides[overrideKey]
    if (!userOverride) {
      // 检查 localStorage 中是否有持久化的该工作区覆盖
      const fromDisk = readPersistedUserOverride(pageId, workspaceId)
      if (fromDisk) {
        userOverride = fromDisk
      } else if (workspaceId == null && get().pageLayouts[pageId]) {
        // 兼容旧全局状态
        const legacyKey = get().pageLayouts[pageId]
        if (LAYOUT_PRESETS[legacyKey]) {
          userOverride = {
            key: legacyKey,
            visiblePanels: get().visiblePanels[pageId] ?? [...LAYOUT_PRESETS[legacyKey].panels]
          }
        }
      }
    }

    const decision = resolveLayoutDecision({
      pageId,
      workspaceId,
      workspaceConfig,
      persistedUserLayout: userOverride
    })
    return decision.key
  },

  getLayoutKey: (
    pageId: string,
    workspaceId?: number | string | null,
    workspaceConfig?: any
  ): LayoutKey => {
    return get().getEffectiveLayout(pageId, workspaceId, workspaceConfig)
  },

  getVisiblePanels: (
    pageId: string,
    workspaceId?: number | string | null,
    workspaceConfig?: any
  ): PanelId[] => {
    const overrideKey = `${pageId}:${workspaceId ?? 'global'}`
    let userOverride = get().userOverrides[overrideKey]
    if (!userOverride) {
      const fromDisk = readPersistedUserOverride(pageId, workspaceId)
      if (fromDisk) {
        userOverride = fromDisk
      } else if (workspaceId == null && get().visiblePanels[pageId]) {
        const legacyPanels = get().visiblePanels[pageId]
        if (legacyPanels && legacyPanels.length > 0 && legacyPanels.includes(PANEL_IDS.LIST)) {
          return legacyPanels
        }
      }
    }

    const decision = resolveLayoutDecision({
      pageId,
      workspaceId,
      workspaceConfig,
      persistedUserLayout: userOverride
    })
    return decision.visiblePanels
  },

  setPageLayout: (pageId: string, key: LayoutKey, workspaceId?: number | string | null) => {
    const targetDef = LAYOUT_PRESETS[key] ?? LAYOUT_PRESETS[LAYOUT_KEYS.ALL_ROW]
    // 切换布局无条件重置可见面板为预设完整集合（一键恢复 AC-3）
    const nextPanels = [...targetDef.panels]
    const overrideKey = `${pageId}:${workspaceId ?? 'global'}`
    const item: UserLayoutItem = { key: targetDef.key, visiblePanels: nextPanels }

    // 1. 持久化到安全存储 (工作区专用隔离键)
    const storageKey = buildLayoutStorageKey(pageId, workspaceId)
    persistedDiskCache.set(storageKey, item)
    safeLayoutStorage.setItem(storageKey, JSON.stringify(item))

    // 2. 兼容旧版单一存储键（保证旧单测与无工作区调用 100% 兼容）
    try {
      const currentLegacy = loadLegacyPersistedState()
      currentLegacy.pageLayouts[pageId] = targetDef.key
      currentLegacy.visiblePanels[pageId] = nextPanels
      safeLayoutStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(currentLegacy))
    } catch {
      // ignore
    }

    set(state => {
      const nextPageLayouts = { ...state.pageLayouts, [pageId]: targetDef.key }
      const nextVisiblePanels = { ...state.visiblePanels, [pageId]: nextPanels }
      const nextUserOverrides = { ...state.userOverrides, [overrideKey]: item }
      return {
        pageLayouts: nextPageLayouts,
        visiblePanels: nextVisiblePanels,
        userOverrides: nextUserOverrides
      }
    })
  },

  closePanel: (pageId: string, panel: PanelId, workspaceId?: number | string | null) => {
    // 列表恒显不可关！(AC-1)
    if (panel === PANEL_IDS.LIST) return

    const currentVisible = get().getVisiblePanels(pageId, workspaceId)
    if (!currentVisible.includes(panel)) return

    const nextVisible = currentVisible.filter(p => p !== panel)
    if (!nextVisible.includes(PANEL_IDS.LIST)) {
      nextVisible.unshift(PANEL_IDS.LIST)
    }

    const currentKey = get().getEffectiveLayout(pageId, workspaceId)
    const overrideKey = `${pageId}:${workspaceId ?? 'global'}`
    const item: UserLayoutItem = { key: currentKey, visiblePanels: nextVisible }

    const storageKey = buildLayoutStorageKey(pageId, workspaceId)
    persistedDiskCache.set(storageKey, item)
    safeLayoutStorage.setItem(storageKey, JSON.stringify(item))

    // 兼容旧版单一存储键
    try {
      const currentLegacy = loadLegacyPersistedState()
      currentLegacy.visiblePanels[pageId] = nextVisible
      safeLayoutStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(currentLegacy))
    } catch {
      // ignore
    }

    set(state => {
      const nextVisiblePanels = { ...state.visiblePanels, [pageId]: nextVisible }
      const nextUserOverrides = { ...state.userOverrides, [overrideKey]: item }
      return {
        visiblePanels: nextVisiblePanels,
        userOverrides: nextUserOverrides
      }
    })
  },

  openPanel: (pageId: string, panel: PanelId, workspaceId?: number | string | null) => {
    const currentVisible = get().getVisiblePanels(pageId, workspaceId)
    if (currentVisible.includes(panel)) return

    const currentKey = get().getEffectiveLayout(pageId, workspaceId)
    let nextKey = currentKey
    let nextPanels = [...currentVisible, panel]

    // 状态代数升级确定性映射表 (AC-2)
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

    const overrideKey = `${pageId}:${workspaceId ?? 'global'}`
    const item: UserLayoutItem = { key: nextKey, visiblePanels: nextPanels }

    const storageKey = buildLayoutStorageKey(pageId, workspaceId)
    persistedDiskCache.set(storageKey, item)
    safeLayoutStorage.setItem(storageKey, JSON.stringify(item))

    // 兼容旧版单一存储键
    try {
      const currentLegacy = loadLegacyPersistedState()
      currentLegacy.pageLayouts[pageId] = nextKey
      currentLegacy.visiblePanels[pageId] = nextPanels
      safeLayoutStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(currentLegacy))
    } catch {
      // ignore
    }

    set(state => {
      const nextPageLayouts = { ...state.pageLayouts, [pageId]: nextKey }
      const nextVisiblePanels = { ...state.visiblePanels, [pageId]: nextPanels }
      const nextUserOverrides = { ...state.userOverrides, [overrideKey]: item }
      return {
        pageLayouts: nextPageLayouts,
        visiblePanels: nextVisiblePanels,
        userOverrides: nextUserOverrides
      }
    })
  },

  resetPageLayout: (pageId: string, workspaceId?: number | string | null) => {
    const defaultKey = getPageDefaultLayout(pageId)
    get().setPageLayout(pageId, defaultKey, workspaceId)
  },

  resetAll: () => {
    persistedDiskCache.clear()
    safeLayoutStorage.removeItem(LEGACY_STORAGE_KEY)
    set({
      pageLayouts: {},
      visiblePanels: {},
      userOverrides: {}
    })
  },

  clearUserLayout: (workspaceId?: string | number, pageId?: PageId | string) => {
    if (workspaceId != null) {
      const hubPages = pageId
        ? [pageId]
        : [
            PAGE_IDS.REAL_DIRECTORY,
            PAGE_IDS.ANALYZED_DIRECTORY,
            PAGE_IDS.VIRTUAL_DIRECTORY,
            PAGE_IDS.SEARCH_OVERLAY
          ]
      for (const pId of hubPages) {
        const storageKey = buildLayoutStorageKey(pId, workspaceId)
        persistedDiskCache.delete(storageKey)
        safeLayoutStorage.removeItem(storageKey)
      }
      set(state => {
        const nextOverrides = { ...state.userOverrides }
        for (const pId of hubPages) {
          delete nextOverrides[`${pId}:${workspaceId}`]
        }
        return { userOverrides: nextOverrides }
      })
    } else {
      get().resetAll()
    }
  }
}))
