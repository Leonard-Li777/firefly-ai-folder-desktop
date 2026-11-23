import { PageId, PAGE_IDS } from '../../../constants/page-ids'
import { LAYOUT_KEYS, type LayoutKey } from '@firefly/types'

export { LAYOUT_KEYS, type LayoutKey }

/** 可参与布局编排的三面板标识（分析队列不参与，保持现状） */
export const PANEL_IDS = {
  LIST: 'list', // 文件列表（页面主体，恒存在）
  PREVIEW: 'preview', // 文件预览
  DETAILS: 'details' // 文件属性面板
} as const

export type PanelId = (typeof PANEL_IDS)[keyof typeof PANEL_IDS]

export type SplitDirection = 'horizontal' | 'vertical'

export interface LayoutDefinition {
  /** 布局唯一受控键 */
  key: LayoutKey
  /** 按钮组图标 (Material Symbols name) */
  icon: string
  /** 该布局初始激活的面板集合（必须包含 list） */
  panels: PanelId[]
  /** 一级主分割方向（文件列表 vs 伴随面板容器） */
  primaryDirection: SplitDirection
  /** 二级伴随分割方向（预览 vs 属性，当且仅当伴随格激活时有效） */
  companionDirection: SplitDirection
  /** 主列表默认占用 flex 比例（默认 2） */
  primaryDefaultSize?: number
  /** 伴随面板容器内预览默认占用 flex 比例（默认 1） */
  companionDefaultSize?: number
}

/** 布局预设池 (LAYOUT_PRESETS) */
export const LAYOUT_PRESETS: Record<LayoutKey, LayoutDefinition> = {
  [LAYOUT_KEYS.LIST_ONLY]: {
    key: LAYOUT_KEYS.LIST_ONLY,
    icon: 'list',
    panels: [PANEL_IDS.LIST],
    primaryDirection: 'horizontal',
    companionDirection: 'vertical'
  },
  [LAYOUT_KEYS.LIST_PREVIEW]: {
    key: LAYOUT_KEYS.LIST_PREVIEW,
    icon: 'splitscreen',
    panels: [PANEL_IDS.LIST, PANEL_IDS.PREVIEW],
    primaryDirection: 'horizontal',
    companionDirection: 'vertical'
  },
  [LAYOUT_KEYS.LIST_DETAILS]: {
    key: LAYOUT_KEYS.LIST_DETAILS,
    icon: 'info',
    panels: [PANEL_IDS.LIST, PANEL_IDS.DETAILS],
    primaryDirection: 'horizontal',
    companionDirection: 'vertical'
  },
  [LAYOUT_KEYS.PIN_LIST_TOP]: {
    key: LAYOUT_KEYS.PIN_LIST_TOP,
    icon: 'space_dashboard',
    panels: [PANEL_IDS.LIST, PANEL_IDS.PREVIEW, PANEL_IDS.DETAILS],
    primaryDirection: 'vertical',
    companionDirection: 'horizontal',
    primaryDefaultSize: 2,
    companionDefaultSize: 1
  },
  [LAYOUT_KEYS.ALL_ROW]: {
    key: LAYOUT_KEYS.ALL_ROW,
    icon: 'view_column',
    panels: [PANEL_IDS.LIST, PANEL_IDS.PREVIEW, PANEL_IDS.DETAILS],
    primaryDirection: 'horizontal',
    companionDirection: 'horizontal',
    primaryDefaultSize: 2,
    companionDefaultSize: 1
  },
  [LAYOUT_KEYS.TRI]: {
    key: LAYOUT_KEYS.TRI,
    icon: 'dashboard',
    panels: [PANEL_IDS.LIST, PANEL_IDS.PREVIEW, PANEL_IDS.DETAILS],
    primaryDirection: 'horizontal',
    companionDirection: 'vertical',
    primaryDefaultSize: 2,
    companionDefaultSize: 1
  },
  [LAYOUT_KEYS.ALL_COLUMN]: {
    key: LAYOUT_KEYS.ALL_COLUMN,
    icon: 'view_stream',
    panels: [PANEL_IDS.LIST, PANEL_IDS.PREVIEW, PANEL_IDS.DETAILS],
    primaryDirection: 'vertical',
    companionDirection: 'vertical',
    primaryDefaultSize: 2,
    companionDefaultSize: 1
  }
}

/**
 * 页面布局能力声明：仅列出的 pageId 才渲染布局切换按钮组。
 * 值为该页可用的布局 key 列表（从通用预设池中挑选子集），数组前 4 项为「常用区」。
 */
export const PAGE_LAYOUT_CAPABILITY: Partial<Record<PageId, LayoutKey[]>> = {
  [PAGE_IDS.REAL_DIRECTORY]: [
    LAYOUT_KEYS.LIST_PREVIEW,
    LAYOUT_KEYS.PIN_LIST_TOP,
    LAYOUT_KEYS.TRI,
    LAYOUT_KEYS.LIST_DETAILS,
    LAYOUT_KEYS.ALL_ROW,
    LAYOUT_KEYS.LIST_ONLY,
    LAYOUT_KEYS.ALL_COLUMN
  ],
  [PAGE_IDS.ANALYZED_DIRECTORY]: [
    LAYOUT_KEYS.LIST_PREVIEW,
    LAYOUT_KEYS.PIN_LIST_TOP,
    LAYOUT_KEYS.TRI,
    LAYOUT_KEYS.LIST_DETAILS,
    LAYOUT_KEYS.ALL_ROW,
    LAYOUT_KEYS.LIST_ONLY,
    LAYOUT_KEYS.ALL_COLUMN
  ],
  [PAGE_IDS.VIRTUAL_DIRECTORY]: [
    LAYOUT_KEYS.LIST_PREVIEW,
    LAYOUT_KEYS.PIN_LIST_TOP,
    LAYOUT_KEYS.TRI,
    LAYOUT_KEYS.LIST_DETAILS,
    LAYOUT_KEYS.ALL_ROW,
    LAYOUT_KEYS.LIST_ONLY
  ],
  [PAGE_IDS.SEARCH_OVERLAY]: [
    LAYOUT_KEYS.LIST_PREVIEW,
    LAYOUT_KEYS.PIN_LIST_TOP,
    LAYOUT_KEYS.TRI,
    LAYOUT_KEYS.LIST_DETAILS,
    LAYOUT_KEYS.ALL_ROW,
    LAYOUT_KEYS.LIST_ONLY
  ]
}

/** 各 Hub 页面无工作区或无配置时的权威保底默认布局（100% 对齐现网三栏首屏外观） */
export const PAGE_DEFAULT_LAYOUT: Record<PageId, LayoutKey> = {
  [PAGE_IDS.REAL_DIRECTORY]: LAYOUT_KEYS.ALL_ROW,
  [PAGE_IDS.ANALYZED_DIRECTORY]: LAYOUT_KEYS.ALL_ROW,
  [PAGE_IDS.VIRTUAL_DIRECTORY]: LAYOUT_KEYS.ALL_ROW,
  [PAGE_IDS.SEARCH_OVERLAY]: LAYOUT_KEYS.ALL_ROW,
  [PAGE_IDS.ORGANIZE]: LAYOUT_KEYS.LIST_ONLY,
  [PAGE_IDS.PREVIEW_WINDOW]: LAYOUT_KEYS.LIST_PREVIEW,
  [PAGE_IDS.PRO_ACTIVATION]: LAYOUT_KEYS.LIST_ONLY,
  [PAGE_IDS.ENTERPRISE_ACTIVATION]: LAYOUT_KEYS.LIST_ONLY
}

export interface LayoutProjection {
  primaryDirection: SplitDirection
  companionDirection: SplitDirection
  /** 槽位折叠参数：由 SplitPaneSection.collapsed 消费，DOM 节点永不卸载 */
  collapsed: {
    companion: boolean
    preview: boolean
    details: boolean
  }
}

/**
 * 槽位参数推导全函数：任何输入不抛错，保证 list 恒可见
 * 严格清洗：visible ∩ layout.panels \ unavailablePanels ∪ {list}
 * 状态代数保证：21 种合法状态 + 7 组脏数据全覆盖，计算耗时 < 1ms
 */
export function resolveLayoutProjection(
  layout: LayoutDefinition,
  visiblePanels: Set<PanelId> | PanelId[],
  unavailablePanels?: Set<PanelId>
): LayoutProjection {
  const visibleSet = visiblePanels instanceof Set ? visiblePanels : new Set(visiblePanels)
  const effective = new Set<PanelId>()
  effective.add(PANEL_IDS.LIST)

  for (const p of visibleSet) {
    if (layout.panels.includes(p) && (!unavailablePanels || !unavailablePanels.has(p))) {
      effective.add(p)
    }
  }

  const hasPreview = effective.has(PANEL_IDS.PREVIEW)
  const hasDetails = effective.has(PANEL_IDS.DETAILS)
  const hasCompanion = hasPreview || hasDetails

  return {
    primaryDirection: layout.primaryDirection,
    companionDirection: layout.companionDirection,
    collapsed: {
      companion: !hasCompanion,
      preview: !hasPreview,
      details: !hasDetails
    }
  }
}

export function getPageLayouts(pageId: PageId | undefined): LayoutDefinition[] {
  if (!pageId) return []
  const keys = PAGE_LAYOUT_CAPABILITY[pageId]
  if (!keys || keys.length === 0) return []
  return keys.map(k => LAYOUT_PRESETS[k]).filter(Boolean)
}

export function isLayoutSwitcherEnabled(pageId: PageId | undefined): boolean {
  return getPageLayouts(pageId).length > 1
}
