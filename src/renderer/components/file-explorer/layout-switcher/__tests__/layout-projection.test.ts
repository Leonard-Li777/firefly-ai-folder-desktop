import { describe, it, expect } from 'vitest'
import {
  PANEL_IDS,
  LAYOUT_KEYS,
  LAYOUT_PRESETS,
  resolveLayoutProjection,
  resolveEffectiveCollapse,
  computeRequiredSizes
} from '../index'

describe('Layout Projection & Collapse Engine (Ticket 03)', () => {
  describe('resolveLayoutProjection 槽位参数推导', () => {
    it('三面板全开时，槽位 collapsed 均为 false', () => {
      const layout = LAYOUT_PRESETS[LAYOUT_KEYS.ALL_ROW]
      const visible = new Set([PANEL_IDS.LIST, PANEL_IDS.PREVIEW, PANEL_IDS.DETAILS])

      const proj = resolveLayoutProjection(layout, visible)
      expect(proj.primaryDirection).toBe('horizontal')
      expect(proj.companionDirection).toBe('horizontal')
      expect(proj.collapsed.companion).toBe(false)
      expect(proj.collapsed.preview).toBe(false)
      expect(proj.collapsed.details).toBe(false)
    })

    it('list-only 预设下，伴随格折叠，preview 与 details 均折叠', () => {
      const layout = LAYOUT_PRESETS[LAYOUT_KEYS.LIST_ONLY]
      const visible = new Set([PANEL_IDS.LIST])

      const proj = resolveLayoutProjection(layout, visible)
      expect(proj.collapsed.companion).toBe(true)
      expect(proj.collapsed.preview).toBe(true)
      expect(proj.collapsed.details).toBe(true)
    })

    it('不可用面板 (unavailablePanels) 隔离折叠', () => {
      const layout = LAYOUT_PRESETS[LAYOUT_KEYS.ALL_ROW]
      const visible = new Set([PANEL_IDS.LIST, PANEL_IDS.PREVIEW, PANEL_IDS.DETAILS])
      const unavailable = new Set([PANEL_IDS.DETAILS])

      const proj = resolveLayoutProjection(layout, visible, unavailable)
      expect(proj.collapsed.companion).toBe(false)
      expect(proj.collapsed.preview).toBe(false)
      expect(proj.collapsed.details).toBe(true)
    })

    it('无论传入什么，list 恒显示，即使传入空 visible 也自愈包含 list', () => {
      const layout = LAYOUT_PRESETS[LAYOUT_KEYS.ALL_ROW]
      const visible = new Set<any>([])

      const proj = resolveLayoutProjection(layout, visible)
      expect(proj.collapsed.companion).toBe(true)
    })
  })

  describe('resolveEffectiveCollapse 多轴两阶段消赤与滞回引擎', () => {
    it('AC-1: 等 min 僵局破局 (tri 预设容器宽 600px)', () => {
      const layout = LAYOUT_PRESETS[LAYOUT_KEYS.TRI] // primary: horizontal, companion: vertical
      const visible = new Set([PANEL_IDS.LIST, PANEL_IDS.PREVIEW, PANEL_IDS.DETAILS])
      // 总需宽度 = list.w(360) + handle(16) + max(preview.w(280), details.w(280)) = 656px
      // 容器宽 600px < 656px，且高度 600px > 416px 充裕
      const collapsed = resolveEffectiveCollapse(600, 600, layout, visible)

      // 第一轮打破等 min 僵局折叠 details，伴随区仍需 280px；第二轮折叠 preview，伴随区归零，消赤收敛
      expect(collapsed.has(PANEL_IDS.DETAILS)).toBe(true)
      expect(collapsed.has(PANEL_IDS.PREVIEW)).toBe(true)
    })

    it('AC-2: 极窄视口兜底 (容器宽 300px < 360px)', () => {
      const layout = LAYOUT_PRESETS[LAYOUT_KEYS.ALL_ROW]
      const visible = new Set([PANEL_IDS.LIST, PANEL_IDS.PREVIEW, PANEL_IDS.DETAILS])

      const collapsed = resolveEffectiveCollapse(300, 500, layout, visible)
      // 两个伴随面板全部折叠，算法立即终止，list 恒不折叠
      expect(collapsed.size).toBe(2)
      expect(collapsed.has(PANEL_IDS.DETAILS)).toBe(true)
      expect(collapsed.has(PANEL_IDS.PREVIEW)).toBe(true)
      expect(collapsed.has(PANEL_IDS.LIST as any)).toBe(false)
    })

    it('AC-3: 临界阈值 16px 滞回防抖', () => {
      const layout = LAYOUT_PRESETS[LAYOUT_KEYS.LIST_PREVIEW] // list(360) + handle(16) + preview(280) = 656px
      const visible = new Set([PANEL_IDS.LIST, PANEL_IDS.PREVIEW])

      // 1. 在 650px 宽度下，preview 被折叠
      const prevCollapsed = resolveEffectiveCollapse(650, 500, layout, visible, new Set())
      expect(prevCollapsed.has(PANEL_IDS.PREVIEW)).toBe(true)

      // 2. 宽度微幅增加到 660px（虽然大于 656px，但未达到 656 + 16 = 672px 滞回门槛）
      const stillCollapsed = resolveEffectiveCollapse(660, 500, layout, visible, prevCollapsed)
      expect(stillCollapsed.has(PANEL_IDS.PREVIEW)).toBe(true) // 保持折叠，防频闪！

      // 3. 宽度继续增加到 675px（超过 672px 滞回门槛）
      const restored = resolveEffectiveCollapse(675, 500, layout, visible, prevCollapsed)
      expect(restored.has(PANEL_IDS.PREVIEW)).toBe(false) // 成功回展！
    })

    it('AC-4: 一次性大幅拉伸单次调用完全回展', () => {
      const layout = LAYOUT_PRESETS[LAYOUT_KEYS.ALL_ROW]
      const visible = new Set([PANEL_IDS.LIST, PANEL_IDS.PREVIEW, PANEL_IDS.DETAILS])
      const prevCollapsed = new Set([PANEL_IDS.PREVIEW, PANEL_IDS.DETAILS])

      // 一次性放大到 1400px (空间充裕)
      const result = resolveEffectiveCollapse(1400, 800, layout, visible, prevCollapsed)
      // 单次回调遍历完全收敛，返回空集合
      expect(result.size).toBe(0)
    })

    it('AC-5: 不可用面板隔离', () => {
      const layout = LAYOUT_PRESETS[LAYOUT_KEYS.ALL_ROW]
      const visible = new Set([PANEL_IDS.LIST, PANEL_IDS.PREVIEW, PANEL_IDS.DETAILS])
      const unavailable = new Set([PANEL_IDS.DETAILS])

      // details 业务不可用，不参与回展判定，也不算作瞬态折叠
      const collapsed = resolveEffectiveCollapse(
        1400,
        800,
        layout,
        visible,
        new Set([PANEL_IDS.DETAILS]),
        16,
        unavailable
      )
      expect(collapsed.has(PANEL_IDS.DETAILS)).toBe(false)
    })
  })
})
