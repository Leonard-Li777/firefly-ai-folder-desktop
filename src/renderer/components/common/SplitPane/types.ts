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
  direction?: 'horizontal' | 'vertical'
  storageKey: string
  sections: SplitPaneSection[]
  className?: string
  /** 拖拽灵敏度，1.0 = 鼠标 1px → 分隔线 1px，默认为 1.0 */
  dragSensitivity?: number
  /** 是否使用原始存储键（不附加 sectionIdsStr 后缀） */
  rawKey?: boolean
  /** 拖拽释放结束回调（用于单次写盘等副作用） */
  onResizeEnd?: () => void
}
