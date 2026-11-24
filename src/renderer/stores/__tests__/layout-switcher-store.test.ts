import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  useLayoutSwitcherStore,
  getDirectionalStorageKey,
  buildLayoutStorageKey,
  resolveLayoutDecision,
  safeLayoutStorage,
  clearPersistedLayoutCache
} from '../layout-switcher-store'
import { PANEL_IDS, LAYOUT_KEYS, PAGE_IDS } from '../../components/file-explorer/layout-switcher'

describe('Layout Switcher Store & State Algebra (Ticket 04 & Workflow Adaptive Layout)', () => {
  beforeEach(() => {
    localStorage.clear()
    clearPersistedLayoutCache()
    useLayoutSwitcherStore.setState({
      pageLayouts: {},
      visiblePanels: {},
      userOverrides: {}
    })
  })

  afterEach(() => {
    localStorage.clear()
    clearPersistedLayoutCache()
  })

  it('AC-1: 列表恒显不可关 (closePanel 针对 list 为 no-op)', () => {
    const pageId = PAGE_IDS.REAL_DIRECTORY
    const store = useLayoutSwitcherStore.getState()

    // 初始状态包含 list
    expect(store.getVisiblePanels(pageId)[0]).toBe(PANEL_IDS.LIST)

    // 尝试关闭 list
    store.closePanel(pageId, PANEL_IDS.LIST)

    const panels = useLayoutSwitcherStore.getState().getVisiblePanels(pageId)
    expect(panels[0]).toBe(PANEL_IDS.LIST)
    expect(panels).toContain(PANEL_IDS.LIST)
  })

  it('AC-2: 状态代数升级闭包 (list-preview + details -> all-row)', () => {
    const pageId = PAGE_IDS.REAL_DIRECTORY
    const store = useLayoutSwitcherStore.getState()

    store.setPageLayout(pageId, LAYOUT_KEYS.LIST_PREVIEW)
    expect(store.getLayoutKey(pageId)).toBe(LAYOUT_KEYS.LIST_PREVIEW)
    expect(store.getVisiblePanels(pageId)).toEqual([PANEL_IDS.LIST, PANEL_IDS.PREVIEW])

    // 打开 details
    store.openPanel(pageId, PANEL_IDS.DETAILS)

    const updated = useLayoutSwitcherStore.getState()
    expect(updated.getLayoutKey(pageId)).toBe(LAYOUT_KEYS.ALL_ROW)
    expect(updated.getVisiblePanels(pageId)).toEqual([
      PANEL_IDS.LIST,
      PANEL_IDS.PREVIEW,
      PANEL_IDS.DETAILS
    ])
  })

  it('AC-2 补充: list-only + preview -> list-preview, list-only + details -> list-details', () => {
    const pageId = PAGE_IDS.REAL_DIRECTORY
    const store = useLayoutSwitcherStore.getState()

    store.setPageLayout(pageId, LAYOUT_KEYS.LIST_ONLY)
    store.openPanel(pageId, PANEL_IDS.PREVIEW)
    expect(useLayoutSwitcherStore.getState().getLayoutKey(pageId)).toBe(LAYOUT_KEYS.LIST_PREVIEW)

    store.setPageLayout(pageId, LAYOUT_KEYS.LIST_ONLY)
    store.openPanel(pageId, PANEL_IDS.DETAILS)
    expect(useLayoutSwitcherStore.getState().getLayoutKey(pageId)).toBe(LAYOUT_KEYS.LIST_DETAILS)
  })

  it('AC-3: 点击当前预设一键恢复所有面板', () => {
    const pageId = PAGE_IDS.REAL_DIRECTORY
    const store = useLayoutSwitcherStore.getState()

    store.setPageLayout(pageId, LAYOUT_KEYS.ALL_ROW)
    // 关闭 preview
    store.closePanel(pageId, PANEL_IDS.PREVIEW)
    expect(useLayoutSwitcherStore.getState().getVisiblePanels(pageId)).toEqual([
      PANEL_IDS.LIST,
      PANEL_IDS.DETAILS
    ])

    // 再次点击 all-row
    store.setPageLayout(pageId, LAYOUT_KEYS.ALL_ROW)
    expect(useLayoutSwitcherStore.getState().getVisiblePanels(pageId)).toEqual([
      PANEL_IDS.LIST,
      PANEL_IDS.PREVIEW,
      PANEL_IDS.DETAILS
    ])
  })

  it('AC-4: 方向敏感尺寸键生成', () => {
    const pageId = PAGE_IDS.REAL_DIRECTORY
    expect(getDirectionalStorageKey(pageId, 'primary', 'horizontal')).toBe(
      `hub_split_v1_${pageId}_primary_h`
    )
    expect(getDirectionalStorageKey(pageId, 'primary', 'vertical')).toBe(
      `hub_split_v1_${pageId}_primary_v`
    )
    expect(getDirectionalStorageKey(pageId, 'companion', 'horizontal')).toBe(
      `hub_split_v1_${pageId}_companion_h`
    )
    expect(getDirectionalStorageKey(pageId, 'companion', 'vertical')).toBe(
      `hub_split_v1_${pageId}_companion_v`
    )
  })

  it('AC-5: 存储持久化与脏数据自愈', () => {
    const pageId = PAGE_IDS.REAL_DIRECTORY
    const store = useLayoutSwitcherStore.getState()

    store.setPageLayout(pageId, LAYOUT_KEYS.TRI)

    const raw = localStorage.getItem('layout_switcher_v1_layouts')
    expect(raw).toBeDefined()
    const parsed = JSON.parse(raw!)
    expect(parsed.pageLayouts[pageId]).toBe(LAYOUT_KEYS.TRI)
  })

  it('AC-6: 纯函数三级代数决策 resolveLayoutDecision 严格遵循 Level 1 > Level 2 > Level 3', () => {
    const pageId = PAGE_IDS.REAL_DIRECTORY

    // 1. Level 3 页面保底 (无任何覆盖与工作流)
    const d3 = resolveLayoutDecision({ pageId })
    expect(d3.key).toBe(LAYOUT_KEYS.ALL_ROW)
    expect(d3.source).toBe('page_default')
    expect(d3.visiblePanels).toEqual([PANEL_IDS.LIST, PANEL_IDS.PREVIEW, PANEL_IDS.DETAILS])

    // 2. Level 2 工作流基线 (工作区配置了 defaultLayout: 'tri')
    const d2 = resolveLayoutDecision({
      pageId,
      workspaceConfig: { defaultLayout: LAYOUT_KEYS.TRI }
    })
    expect(d2.key).toBe(LAYOUT_KEYS.TRI)
    expect(d2.source).toBe('workflow')
    expect(d2.visiblePanels).toEqual([PANEL_IDS.LIST, PANEL_IDS.PREVIEW, PANEL_IDS.DETAILS])

    // 工作区配置以 JSON 字符串传入时同样正确解析
    const d2Json = resolveLayoutDecision({
      pageId,
      workspaceConfig: JSON.stringify({ defaultLayout: LAYOUT_KEYS.PIN_LIST_TOP })
    })
    expect(d2Json.key).toBe(LAYOUT_KEYS.PIN_LIST_TOP)
    expect(d2Json.source).toBe('workflow')

    // 3. Level 1 用户显式覆盖优先 (ADR-0062)
    const d1 = resolveLayoutDecision({
      pageId,
      workspaceConfig: { defaultLayout: LAYOUT_KEYS.TRI },
      persistedUserLayout: {
        key: LAYOUT_KEYS.LIST_PREVIEW,
        visiblePanels: [PANEL_IDS.LIST, PANEL_IDS.PREVIEW]
      }
    })
    expect(d1.key).toBe(LAYOUT_KEYS.LIST_PREVIEW)
    expect(d1.source).toBe('user')
    expect(d1.visiblePanels).toEqual([PANEL_IDS.LIST, PANEL_IDS.PREVIEW])

    // 4. 脏数据自愈：用户覆盖了非法 key 时平滑回退工作流或页面保底
    const dDirty = resolveLayoutDecision({
      pageId,
      workspaceConfig: { defaultLayout: LAYOUT_KEYS.TRI },
      persistedUserLayout: {
        key: 'invalid-layout-key' as any,
        visiblePanels: []
      }
    })
    expect(dDirty.key).toBe(LAYOUT_KEYS.TRI)
    expect(dDirty.source).toBe('workflow')
  })

  it('AC-7: 工作区多实例隔离持久化，互不污染', () => {
    const pageId = PAGE_IDS.REAL_DIRECTORY
    const store = useLayoutSwitcherStore.getState()

    // 影视工作区 (ID: 101, defaultLayout: 'tri')
    // 通用工作区 (ID: 102, defaultLayout: 'all-row')
    const ws101Config = { defaultLayout: LAYOUT_KEYS.TRI }
    const ws102Config = { defaultLayout: LAYOUT_KEYS.ALL_ROW }

    expect(store.getEffectiveLayout(pageId, 101, ws101Config)).toBe(LAYOUT_KEYS.TRI)
    expect(store.getEffectiveLayout(pageId, 102, ws102Config)).toBe(LAYOUT_KEYS.ALL_ROW)

    // 用户在工作区 101 手动切换为 list-preview
    store.setPageLayout(pageId, LAYOUT_KEYS.LIST_PREVIEW, 101)

    // 工作区 101 采纳用户覆盖；工作区 102 保持工作流基线不受影响
    expect(store.getEffectiveLayout(pageId, 101, ws101Config)).toBe(LAYOUT_KEYS.LIST_PREVIEW)
    expect(store.getEffectiveLayout(pageId, 102, ws102Config)).toBe(LAYOUT_KEYS.ALL_ROW)

    // 验证底层 safeLayoutStorage 隔离落盘
    const raw101 = safeLayoutStorage.getItem(buildLayoutStorageKey(pageId, 101))
    expect(raw101).toBeDefined()
    expect(JSON.parse(raw101!).key).toBe(LAYOUT_KEYS.LIST_PREVIEW)

    const raw102 = safeLayoutStorage.getItem(buildLayoutStorageKey(pageId, 102))
    expect(raw102).toBeNull()
  })

  it('AC-8: clearUserLayout 穿透清扫工作区各 Hub 页面覆盖，恢复工作流基线 (方案 A 闭环)', () => {
    const store = useLayoutSwitcherStore.getState()
    const wsId = 201
    const movieConfig = { defaultLayout: LAYOUT_KEYS.TRI }

    // 用户在真实目录和虚拟目录都手动设置了不同的布局
    store.setPageLayout(PAGE_IDS.REAL_DIRECTORY, LAYOUT_KEYS.LIST_ONLY, wsId)
    store.setPageLayout(PAGE_IDS.VIRTUAL_DIRECTORY, LAYOUT_KEYS.PIN_LIST_TOP, wsId)

    expect(store.getEffectiveLayout(PAGE_IDS.REAL_DIRECTORY, wsId, movieConfig)).toBe(
      LAYOUT_KEYS.LIST_ONLY
    )
    expect(store.getEffectiveLayout(PAGE_IDS.VIRTUAL_DIRECTORY, wsId, movieConfig)).toBe(
      LAYOUT_KEYS.PIN_LIST_TOP
    )

    // 用户在工作区设置中切换工作流，触发全 Hub 穿透清扫
    store.clearUserLayout(wsId)

    // 缓存已清扫，两页面均自适应恢复为工作流推荐的 'tri'
    expect(store.getEffectiveLayout(PAGE_IDS.REAL_DIRECTORY, wsId, movieConfig)).toBe(
      LAYOUT_KEYS.TRI
    )
    expect(store.getEffectiveLayout(PAGE_IDS.VIRTUAL_DIRECTORY, wsId, movieConfig)).toBe(
      LAYOUT_KEYS.TRI
    )
  })

  it('AC-9: buildLayoutStorageKey 隔离键规范', () => {
    expect(buildLayoutStorageKey(PAGE_IDS.REAL_DIRECTORY, 2)).toBe('hub_layout_v1_real-directory_2')
    expect(buildLayoutStorageKey(PAGE_IDS.REAL_DIRECTORY, 'ws-abc')).toBe(
      'hub_layout_v1_real-directory_ws-abc'
    )
    expect(buildLayoutStorageKey(PAGE_IDS.REAL_DIRECTORY, null)).toBe(
      'hub_layout_v1_real-directory'
    )
    expect(buildLayoutStorageKey(PAGE_IDS.REAL_DIRECTORY)).toBe('hub_layout_v1_real-directory')
  })

  it('AC-10: safeLayoutStorage 在 localStorage 异常或配额溢出时优雅降级并正确读回', () => {
    const testKey = 'test_quota_key'
    const testValue = JSON.stringify({ key: LAYOUT_KEYS.TRI })

    // 模拟 localStorage.setItem 抛出配额溢出错误
    const originalSetItem = localStorage.setItem
    localStorage.setItem = () => {
      throw new Error('QuotaExceededError')
    }

    try {
      // 写入降级至内存存储
      safeLayoutStorage.setItem(testKey, testValue)
      // 读回时即便 localStorage.getItem(testKey) 返回 null，也能从内存降级中正确读回
      const readBack = safeLayoutStorage.getItem(testKey)
      expect(readBack).toBe(testValue)
    } finally {
      localStorage.setItem = originalSetItem
      safeLayoutStorage.removeItem(testKey)
    }
  })

  it('AC-11: closePanel 传入 workspaceConfig 时保留工作流推荐布局 (tri)，不被错误降级为 all-row', () => {
    const pageId = PAGE_IDS.REAL_DIRECTORY
    const wsId = 301
    const movieConfig = { defaultLayout: LAYOUT_KEYS.TRI }
    const store = useLayoutSwitcherStore.getState()

    // 初始状态下工作区 301 为工作流推荐的 tri，可见三面板
    expect(store.getEffectiveLayout(pageId, wsId, movieConfig)).toBe(LAYOUT_KEYS.TRI)
    expect(store.getVisiblePanels(pageId, wsId, movieConfig)).toEqual([
      PANEL_IDS.LIST,
      PANEL_IDS.PREVIEW,
      PANEL_IDS.DETAILS
    ])

    // 用户在没有手动修改过全局布局的情况下关闭 details 面板
    store.closePanel(pageId, PANEL_IDS.DETAILS, wsId, movieConfig)

    // 有效布局应当依然保持为 TRI，可见面板仅剩 LIST 与 PREVIEW
    expect(store.getEffectiveLayout(pageId, wsId, movieConfig)).toBe(LAYOUT_KEYS.TRI)
    expect(store.getVisiblePanels(pageId, wsId, movieConfig)).toEqual([
      PANEL_IDS.LIST,
      PANEL_IDS.PREVIEW
    ])
  })
})
