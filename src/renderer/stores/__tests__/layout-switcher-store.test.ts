import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  useLayoutSwitcherStore,
  getDirectionalStorageKey
} from '../layout-switcher-store'
import {
  PANEL_IDS,
  LAYOUT_KEYS,
  PAGE_IDS
} from '../../components/file-explorer/layout-switcher'

describe('Layout Switcher Store & State Algebra (Ticket 04)', () => {
  beforeEach(() => {
    localStorage.clear()
    useLayoutSwitcherStore.setState({ pageLayouts: {}, visiblePanels: {} })
  })

  afterEach(() => {
    localStorage.clear()
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
})
