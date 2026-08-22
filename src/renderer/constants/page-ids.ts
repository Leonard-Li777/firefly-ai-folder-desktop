/**
 * 页面标识常量
 * 用于文件预览状态隔离，防止跨页面影响
 */
export const PAGE_IDS = {
  /** 真实目录页面 */
  REAL_DIRECTORY: 'real-directory',
  /** 已分析目录页面 */
  ANALYZED_DIRECTORY: 'analyzed-directory',
  /** 虚拟目录页面 */
  VIRTUAL_DIRECTORY: 'virtual-directory',
  /** 整理页面 */
  ORGANIZE: 'organize',
  /** 新窗口预览 */
  PREVIEW_WINDOW: 'preview-window',
  /** Pro 开通页面 */
  PRO_ACTIVATION: 'pro-activation',
  /** 企业版开通页面 */
  ENTERPRISE_ACTIVATION: 'enterprise-activation'
} as const

export type PageId = (typeof PAGE_IDS)[keyof typeof PAGE_IDS]
