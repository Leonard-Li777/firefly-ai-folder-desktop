import { ReactNode } from 'react'

export interface SplitPaneSection {
  id: string
  content: ReactNode
  type: 'pixel' | 'flex'
  defaultSize: number
  minSize?: number
  collapsed?: boolean
  collapsedSize?: number
}

export interface SplitPaneProps {
  direction: 'horizontal' | 'vertical'
  storageKey: string
  sections: SplitPaneSection[]
  className?: string
  /** 拖拽灵敏度，1.0 = 鼠标 1px → 分隔线 1px，1.8 = 鼠标 1px → 分隔线 1.8px。
   *  默认 2.0，兼顾精确控制和灵活响应。 */
  dragSensitivity?: number
}
