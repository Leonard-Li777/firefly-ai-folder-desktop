import i18nScope, { t } from '../../../../languages'
import {
  LAYOUT_KEYS,
  LayoutKey,
  PANEL_IDS,
  PAGE_IDS,
  LayoutDefinition,
  PageLayoutCapability
} from './types'

/** 常用区最大展示数量 */
export const MAX_COMMON_LAYOUT_COUNT = 3

/** 7 套标准预设池定义（恒定包含 list，且首项为 list） */
export const LAYOUT_PRESETS: Record<LayoutKey, LayoutDefinition> = {
  [LAYOUT_KEYS.LIST_ONLY]: {
    key: LAYOUT_KEYS.LIST_ONLY,
    name: '仅列表',
    icon: 'view_list',
    panels: [PANEL_IDS.LIST],
    primaryDirection: 'horizontal',
    companionDirection: 'horizontal',
    primaryDefaultSize: 1,
    companionDefaultSize: 1
  },
  [LAYOUT_KEYS.LIST_PREVIEW]: {
    key: LAYOUT_KEYS.LIST_PREVIEW,
    name: '列表+预览',
    icon: 'vertical_split',
    panels: [PANEL_IDS.LIST, PANEL_IDS.PREVIEW],
    primaryDirection: 'horizontal',
    companionDirection: 'vertical',
    primaryDefaultSize: 1.5,
    companionDefaultSize: 1
  },
  [LAYOUT_KEYS.LIST_DETAILS]: {
    key: LAYOUT_KEYS.LIST_DETAILS,
    name: '列表+属性',
    icon: 'view_sidebar',
    panels: [PANEL_IDS.LIST, PANEL_IDS.DETAILS],
    primaryDirection: 'horizontal',
    companionDirection: 'vertical',
    primaryDefaultSize: 1.5,
    companionDefaultSize: 1
  },
  [LAYOUT_KEYS.PIN_LIST_TOP]: {
    key: LAYOUT_KEYS.PIN_LIST_TOP,
    name: '品字布局',
    icon: 'view_quilt',
    panels: [PANEL_IDS.LIST, PANEL_IDS.PREVIEW, PANEL_IDS.DETAILS],
    primaryDirection: 'vertical',
    companionDirection: 'horizontal',
    primaryDefaultSize: 1,
    companionDefaultSize: 1
  },
  [LAYOUT_KEYS.ALL_ROW]: {
    key: LAYOUT_KEYS.ALL_ROW,
    name: '全横排',
    icon: 'view_column',
    panels: [PANEL_IDS.LIST, PANEL_IDS.PREVIEW, PANEL_IDS.DETAILS],
    primaryDirection: 'horizontal',
    companionDirection: 'horizontal',
    primaryDefaultSize: 1,
    companionDefaultSize: 1
  },
  [LAYOUT_KEYS.TRI]: {
    key: LAYOUT_KEYS.TRI,
    name: '三宫格',
    icon: 'space_dashboard',
    panels: [PANEL_IDS.LIST, PANEL_IDS.PREVIEW, PANEL_IDS.DETAILS],
    primaryDirection: 'horizontal',
    companionDirection: 'vertical',
    primaryDefaultSize: 1.5,
    companionDefaultSize: 1
  },
  [LAYOUT_KEYS.ALL_COLUMN]: {
    key: LAYOUT_KEYS.ALL_COLUMN,
    name: '全竖排',
    icon: 'table_rows',
    panels: [PANEL_IDS.LIST, PANEL_IDS.PREVIEW, PANEL_IDS.DETAILS],
    primaryDirection: 'vertical',
    companionDirection: 'vertical',
    primaryDefaultSize: 1,
    companionDefaultSize: 1
  }
}

/** 7 套受控预设顺序池 */
export const ALL_LAYOUT_KEYS: readonly LayoutKey[] = [
  LAYOUT_KEYS.ALL_ROW,
  LAYOUT_KEYS.TRI,
  LAYOUT_KEYS.PIN_LIST_TOP,
  LAYOUT_KEYS.LIST_PREVIEW,
  LAYOUT_KEYS.LIST_DETAILS,
  LAYOUT_KEYS.ALL_COLUMN,
  LAYOUT_KEYS.LIST_ONLY
]

/** 页面能力门控表 */
export const PAGE_LAYOUT_CAPABILITY: Record<string, PageLayoutCapability> = {
  [PAGE_IDS.REAL_DIRECTORY]: {
    allowedPresets: ALL_LAYOUT_KEYS,
    defaultLayout: LAYOUT_KEYS.ALL_ROW,
    supportsSwitcher: true
  },
  [PAGE_IDS.ANALYZED_DIRECTORY]: {
    allowedPresets: ALL_LAYOUT_KEYS,
    defaultLayout: LAYOUT_KEYS.ALL_ROW,
    supportsSwitcher: true
  },
  [PAGE_IDS.VIRTUAL_DIRECTORY]: {
    allowedPresets: ALL_LAYOUT_KEYS,
    defaultLayout: LAYOUT_KEYS.ALL_ROW,
    supportsSwitcher: true
  },
  [PAGE_IDS.SEARCH_OVERLAY]: {
    allowedPresets: ALL_LAYOUT_KEYS,
    defaultLayout: LAYOUT_KEYS.ALL_ROW,
    supportsSwitcher: true
  },
  [PAGE_IDS.ORGANIZE]: {
    allowedPresets: [LAYOUT_KEYS.LIST_ONLY],
    defaultLayout: LAYOUT_KEYS.LIST_ONLY,
    supportsSwitcher: false
  }
}

/** 检查页面是否支持布局切换器 */
export function isLayoutSwitcherEnabled(pageId?: string | null): boolean {
  if (!pageId) return false
  return Boolean(PAGE_LAYOUT_CAPABILITY[pageId]?.supportsSwitcher)
}

/** 获取页面支持的布局列表 */
export function getPageLayouts(pageId?: string | null): readonly LayoutKey[] {
  if (!pageId) return []
  return PAGE_LAYOUT_CAPABILITY[pageId]?.allowedPresets ?? []
}

/** 获取页面默认布局 */
export function getPageDefaultLayout(pageId?: string | null): LayoutKey {
  if (!pageId) return LAYOUT_KEYS.ALL_ROW
  return PAGE_LAYOUT_CAPABILITY[pageId]?.defaultLayout ?? LAYOUT_KEYS.ALL_ROW
}

/** 获取布局详细定义 */
export function getLayoutDefinition(key: LayoutKey): LayoutDefinition {
  return LAYOUT_PRESETS[key] ?? LAYOUT_PRESETS[LAYOUT_KEYS.ALL_ROW]
}

/**
 * 静态大白话布局名称映射（严禁 t(变量)，严格遵循构建期提取铁律）
 */
export function getLayoutLabel(key: LayoutKey): string {
  switch (key) {
    case LAYOUT_KEYS.LIST_ONLY:
      return t('仅列表')
    case LAYOUT_KEYS.LIST_PREVIEW:
      return t('列表+预览')
    case LAYOUT_KEYS.LIST_DETAILS:
      return t('列表+属性')
    case LAYOUT_KEYS.PIN_LIST_TOP:
      return t('品字布局')
    case LAYOUT_KEYS.ALL_ROW:
      return t('全横排')
    case LAYOUT_KEYS.TRI:
      return t('三宫格')
    case LAYOUT_KEYS.ALL_COLUMN:
      return t('全竖排')
    default:
      return t('默认布局')
  }
}
