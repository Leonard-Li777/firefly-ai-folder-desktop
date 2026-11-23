import { describe, it, expect } from 'vitest'
import {
  PANEL_IDS,
  LAYOUT_KEYS,
  PAGE_IDS,
  LAYOUT_PRESETS,
  ALL_LAYOUT_KEYS,
  getPageLayouts,
  isLayoutSwitcherEnabled,
  getPageDefaultLayout,
  getLayoutDefinition,
  getLayoutLabel
} from '../index'

describe('Layout Types, Presets & Capability Gating (Ticket 02)', () => {
  it('AC-1: 7 套预设的 panels 均包含 list，且首项恒为 list', () => {
    expect(ALL_LAYOUT_KEYS).toHaveLength(7)

    for (const key of ALL_LAYOUT_KEYS) {
      const def = LAYOUT_PRESETS[key]
      expect(def).toBeDefined()
      expect(def.key).toBe(key)
      expect(def.panels).toContain(PANEL_IDS.LIST)
      expect(def.panels[0]).toBe(PANEL_IDS.LIST)
    }
  })

  it('AC-2: 页面门控白名单准确性', () => {
    // 真实目录、已分析、虚拟目录、全局搜索浮层支持全部 7 套预设
    expect(getPageLayouts(PAGE_IDS.REAL_DIRECTORY)).toHaveLength(7)
    expect(getPageLayouts(PAGE_IDS.ANALYZED_DIRECTORY)).toHaveLength(7)
    expect(getPageLayouts(PAGE_IDS.VIRTUAL_DIRECTORY)).toHaveLength(7)
    expect(getPageLayouts(PAGE_IDS.SEARCH_OVERLAY)).toHaveLength(7)

    // 整理页不声明门控，返回空数组
    expect(getPageLayouts(PAGE_IDS.ORGANIZE)).toEqual([])
    expect(getPageLayouts(null)).toEqual([])
    expect(getPageLayouts(undefined)).toEqual([])
  })

  it('AC-3: 门控使能判定', () => {
    expect(isLayoutSwitcherEnabled(PAGE_IDS.REAL_DIRECTORY)).toBe(true)
    expect(isLayoutSwitcherEnabled(PAGE_IDS.ANALYZED_DIRECTORY)).toBe(true)
    expect(isLayoutSwitcherEnabled(PAGE_IDS.VIRTUAL_DIRECTORY)).toBe(true)
    expect(isLayoutSwitcherEnabled(PAGE_IDS.SEARCH_OVERLAY)).toBe(true)

    // ORGANIZE 及未知页面禁止渲染切换器
    expect(isLayoutSwitcherEnabled(PAGE_IDS.ORGANIZE)).toBe(false)
    expect(isLayoutSwitcherEnabled('unknown-page')).toBe(false)
    expect(isLayoutSwitcherEnabled(null)).toBe(false)
  })

  it('AC-4: 默认预设与静态 i18n 标签映射', () => {
    expect(getPageDefaultLayout(PAGE_IDS.REAL_DIRECTORY)).toBe(LAYOUT_KEYS.ALL_ROW)

    // 静态文案映射健全性
    expect(getLayoutLabel(LAYOUT_KEYS.LIST_ONLY)).toBe('仅列表')
    expect(getLayoutLabel(LAYOUT_KEYS.LIST_PREVIEW)).toBe('列表+预览')
    expect(getLayoutLabel(LAYOUT_KEYS.LIST_DETAILS)).toBe('列表+属性')
    expect(getLayoutLabel(LAYOUT_KEYS.PIN_LIST_TOP)).toBe('品字布局')
    expect(getLayoutLabel(LAYOUT_KEYS.ALL_ROW)).toBe('全横排')
    expect(getLayoutLabel(LAYOUT_KEYS.TRI)).toBe('三宫格')
    expect(getLayoutLabel(LAYOUT_KEYS.ALL_COLUMN)).toBe('全竖排')

    // fallback 行为
    const fallbackDef = getLayoutDefinition('invalid-key' as any)
    expect(fallbackDef.key).toBe(LAYOUT_KEYS.ALL_ROW)
  })
})
