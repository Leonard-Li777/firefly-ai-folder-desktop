import React from 'react'

/** 目录树默认展开模式 */
export type TreeExpandMode = 'expand-first' | 'collapse-all' | 'expand-all'

export interface TreeViewProps<TNode> {
  nodes: TNode[]
  getChildren: (node: TNode) => TNode[] | undefined
  getKey: (node: TNode) => string
  getLabel: (node: TNode) => React.ReactNode

  /** 默认展开模式（仅在未受控模式或首次初始化时生效） */
  expandMode?: TreeExpandMode

  defaultExpanded?: boolean | ((key: string) => boolean)
  expandedKeys?: Set<string>
  onExpandedChange?: (keys: Set<string>) => void

  selectable?: boolean
  selectedKeys?: Set<string>
  onSelect?: (key: string, node: TNode, event: React.MouseEvent) => void
  onDoubleClick?: (key: string, node: TNode, event: React.MouseEvent) => void
  multiSelect?: boolean
  onMultiSelectChange?: (keys: Set<string>) => void
  indeterminateKeys?: Set<string>

  renderNodeIcon?: (node: TNode) => React.ReactNode
  renderNodeMeta?: (node: TNode) => React.ReactNode
  renderNodeExtra?: (node: TNode) => React.ReactNode
  showConnectorLines?: boolean

  loadChildren?: (node: TNode) => Promise<TNode[]>

  isNodeDisabled?: (node: TNode) => boolean
  isNodeLoading?: (node: TNode) => boolean

  className?: string
  levelIndent?: number
  rowHeight?: number

  /** HTML5 原生 Drag and Drop 拖拽支持 */
  onDragStart?: (node: TNode, event: React.DragEvent) => void
  onDragOver?: (targetNode: TNode, event: React.DragEvent) => void
  onDragLeave?: (targetNode: TNode, event: React.DragEvent) => void
  onDrop?: (targetNode: TNode, event: React.DragEvent) => void
  canDrag?: (node: TNode) => boolean
  canDrop?: (targetNode: TNode) => boolean
}
