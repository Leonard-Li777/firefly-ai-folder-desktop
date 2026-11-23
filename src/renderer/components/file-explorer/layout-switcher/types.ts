/**
 * Hub 页面布局切换核心受控类型定义
 * 严禁自然语言硬编码比对，遵循项目受控枚举铁律
 */

/** 可参与布局编排的三面板标识（分析队列不参与，保持现状） */
export const PANEL_IDS = {
  LIST: 'list', // 文件列表（页面主体，恒存在不可关闭）
  PREVIEW: 'preview', // 文件预览
  DETAILS: 'details' // 文件属性面板
} as const

export type PanelId = (typeof PANEL_IDS)[keyof typeof PANEL_IDS]

/** 7 套受控布局键枚举 */
export const LAYOUT_KEYS = {
  LIST_ONLY: 'list-only',
  LIST_PREVIEW: 'list-preview',
  LIST_DETAILS: 'list-details',
  PIN_LIST_TOP: 'pin-list-top',
  ALL_ROW: 'all-row',
  TRI: 'tri',
  ALL_COLUMN: 'all-column'
} as const

export type LayoutKey = (typeof LAYOUT_KEYS)[keyof typeof LAYOUT_KEYS]

/** 受控 Hub 页面标识 */
export const PAGE_IDS = {
  REAL_DIRECTORY: 'real-directory',
  ANALYZED_DIRECTORY: 'analyzed-directory',
  ORGANIZE: 'organize',
  VIRTUAL_DIRECTORY: 'virtual-directory',
  SEARCH_OVERLAY: 'search-overlay'
} as const

export type PageId = (typeof PAGE_IDS)[keyof typeof PAGE_IDS]

/** 布局声明式定义模型 */
export interface LayoutDefinition {
  key: LayoutKey
  name: string
  icon: string
  panels: readonly PanelId[] // 参与编排的面板集合，首项恒为 'list'
  primaryDirection: 'horizontal' | 'vertical'
  companionDirection: 'horizontal' | 'vertical'
  primaryDefaultSize?: number
  companionDefaultSize?: number
}

/** 页面能力配置模型 */
export interface PageLayoutCapability {
  allowedPresets: readonly LayoutKey[]
  defaultLayout: LayoutKey
  supportsSwitcher: boolean
}
