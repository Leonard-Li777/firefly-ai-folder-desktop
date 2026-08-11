import React, { useState, useCallback, useEffect } from 'react'
import { TreeViewProps, TreeExpandMode } from './types'
export type { TreeExpandMode }
import { cn } from '../../../lib/utils'
import { ChevronRight, ChevronDown, Folder, File, Loader2 } from 'lucide-react'

/** 根据展开模式计算初始展开的节点 key 集合 */
function computeExpandKeys<TNode>(
  nodes: TNode[],
  getChildren: (node: TNode) => TNode[] | undefined,
  getKey: (node: TNode) => string,
  mode: TreeExpandMode
): Set<string> {
  const keys = new Set<string>()
  if (mode === 'collapse-all') return keys

  const walk = (currentNodes: TNode[], isFirstChain: boolean) => {
    for (let i = 0; i < currentNodes.length; i++) {
      const node = currentNodes[i]
      const children = getChildren(node)
      const hasChildren = children && children.length > 0

      if (mode === 'expand-all' && hasChildren) {
        keys.add(getKey(node))
        if (children) walk(children, false)
      } else if (mode === 'expand-first' && isFirstChain && i === 0 && hasChildren) {
        keys.add(getKey(node))
        if (children) walk(children, true)
      }
    }
  }

  walk(nodes, true)
  return keys
}

export function TreeView<TNode>({
  nodes,
  getChildren,
  getKey,
  getLabel,
  expandMode = 'expand-all',
  defaultExpanded = false,
  expandedKeys: propsExpandedKeys,
  onExpandedChange,
  selectable = true,
  selectedKeys,
  onSelect,
  onDoubleClick,
  multiSelect = false,
  onMultiSelectChange,
  indeterminateKeys = new Set(),
  renderNodeIcon,
  renderNodeMeta,
  renderNodeExtra,
  showConnectorLines = true,
  isNodeDisabled,
  isNodeLoading,
  className,
  levelIndent = 16,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  canDrag,
  canDrop
}: TreeViewProps<TNode>) {
  const [internalExpandedKeys, setInternalExpandedKeys] = useState<Set<string>>(new Set())

  const expandedKeys = propsExpandedKeys || internalExpandedKeys

  const lastKeysStrRef = React.useRef<string>('')

  // 当 nodes 变化时，根据 expandMode 初始化展开状态
  useEffect(() => {
    if (!nodes || nodes.length === 0) {
      lastKeysStrRef.current = ''
      return
    }

    const currentKeysStr = nodes.map(getKey).join(',')
    if (currentKeysStr === lastKeysStrRef.current) {
      return
    }
    lastKeysStrRef.current = currentKeysStr

    const initialKeys = computeExpandKeys(nodes, getChildren, getKey, expandMode)

    if (propsExpandedKeys !== undefined) {
      // 受控模式：通过 onExpandedChange 通知父组件
      onExpandedChange?.(initialKeys)
    } else {
      // 非受控模式：直接设置内部状态
      setInternalExpandedKeys(initialKeys)
    }
  }, [nodes, expandMode, getKey, getChildren])

  const toggleExpand = useCallback(
    (key: string) => {
      const next = new Set(expandedKeys)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      if (onExpandedChange) {
        onExpandedChange(next)
      } else {
        setInternalExpandedKeys(next)
      }
    },
    [expandedKeys, onExpandedChange]
  )

  const [dragOverKey, setDragOverKey] = useState<string | null>(null)

  const renderNode = (node: TNode, level = 0) => {
    const key = getKey(node)
    const children = getChildren(node)
    const hasChildren = children && children.length > 0
    const isExpanded = expandedKeys.has(key)
    const isSelected = selectedKeys?.has(key)
    const isDisabled = isNodeDisabled?.(node)
    const isLoading = isNodeLoading?.(node)
    const isDragOverTarget = dragOverKey === key

    const nodeCanDrag = canDrag ? canDrag(node) : true
    const nodeCanDrop = canDrop ? canDrop(node) : true

    return (
      <div key={key} className="flex flex-col">
        <div
          draggable={nodeCanDrag}
          onDragStart={e => {
            e.stopPropagation()
            onDragStart?.(node, e)
          }}
          onDragOver={e => {
            if (!nodeCanDrop) return
            e.preventDefault()
            e.stopPropagation()
            setDragOverKey(key)
            onDragOver?.(node, e)
          }}
          onDragLeave={e => {
            e.stopPropagation()
            setDragOverKey(prev => (prev === key ? null : prev))
            onDragLeave?.(node, e)
          }}
          onDrop={e => {
            if (!nodeCanDrop) return
            e.preventDefault()
            e.stopPropagation()
            setDragOverKey(null)
            onDrop?.(node, e)
          }}
          className={cn(
            'flex items-center py-1 px-2 cursor-pointer hover:bg-accent/50 rounded transition-all group select-none',
            isSelected && 'bg-accent text-accent-foreground',
            isDisabled && 'opacity-50 cursor-not-allowed',
            isDragOverTarget &&
              'bg-primary/20 ring-2 ring-primary ring-offset-1 text-primary font-bold shadow-xs'
          )}
          style={{ paddingLeft: `${level * levelIndent + 8}px` }}
          onClick={e => {
            if (isDisabled) return
            onSelect?.(key, node, e)
          }}
          onDoubleClick={e => {
            if (isDisabled) return
            onDoubleClick?.(key, node, e)
            // 双击目录名切换展开/收起
            if (hasChildren) toggleExpand(key)
          }}
        >
          <div
            className="w-4 h-4 flex items-center justify-center mr-1 text-muted-foreground hover:text-foreground"
            onClick={e => {
              e.stopPropagation()
              if (hasChildren) toggleExpand(key)
            }}
          >
            {hasChildren ? (
              isExpanded ? (
                <ChevronDown className="w-3 h-3" />
              ) : (
                <ChevronRight className="w-3 h-3" />
              )
            ) : null}
          </div>

          <div className="mr-2">
            {isLoading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : renderNodeIcon ? (
              renderNodeIcon(node)
            ) : hasChildren ? (
              <Folder className="w-4 h-4 text-primary fill-primary/20" />
            ) : (
              <File className="w-4 h-4 text-muted-foreground" />
            )}
          </div>

          <div className="flex-1 min-w-0 flex items-center">
            <span className="truncate text-sm font-medium">{getLabel(node)}</span>

            {renderNodeExtra && (
              <span className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 ml-1">
                {renderNodeExtra(node)}
              </span>
            )}
          </div>

          {renderNodeMeta && (
            <div className="ml-2 text-xs text-muted-foreground">{renderNodeMeta(node)}</div>
          )}
        </div>

        {isExpanded && children && (
          <div className="flex flex-col">{children.map(child => renderNode(child, level + 1))}</div>
        )}
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col overflow-auto custom-scrollbar', className)}>
      {nodes.map(node => renderNode(node))}
    </div>
  )
}
