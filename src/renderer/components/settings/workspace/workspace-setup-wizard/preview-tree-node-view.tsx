import React from 'react'
import { Folder } from 'lucide-react'
import type { PreviewNode } from '@firefly/shared'
import { FileTypeIcon, extractFileExtension } from '../../../common/FileTypeIcon'
import { t } from '@app/languages'
import { cn } from '../../../../lib/utils'

/**
 * 递归渲染 PreviewNode（支持目录与单点命名原型节点，对齐系统文件/目录预览图标样式）
 */
export const PreviewTreeNodeView: React.FC<{
  node: PreviewNode
  depth?: number
  isRoot?: boolean
  namingTemplate?: string
}> = ({ node, depth = 0, isRoot = false, namingTemplate }) => {
  const isPrototype = node.kind === 'naming-prototype'
  const hasChildren = !isPrototype && Array.isArray(node.children) && node.children.length > 0

  if (isPrototype) {
    const ext = extractFileExtension(node.name)
    return (
      <div
        className={cn(
          'select-none text-xs my-1 pl-2 border-l border-primary/50 space-y-1',
          depth > 0 && 'ml-3'
        )}
      >
        <div
          className="flex items-center gap-1.5 py-1.5 px-2 rounded-md bg-primary/10 border border-primary/30 text-primary font-mono text-[11px] shadow-2xs group"
          title={node.name}
        >
          <FileTypeIcon
            extension={ext}
            className="w-4 h-4 object-contain shrink-0"
            fallbackClassName="text-[16px] text-primary shrink-0 leading-none"
          />
          <span className="truncate font-semibold">{node.name}</span>
          <span className="ml-auto text-[9px] px-1.5 py-0.2 rounded bg-primary text-primary-foreground font-sans font-bold shrink-0">
            {t('命名样例')}
          </span>
        </div>
        {namingTemplate && (
          <div className="flex items-center gap-1.5 px-1 text-[10px] text-muted-foreground">
            <span className="px-1 py-0.2 rounded bg-muted text-foreground/80 font-sans font-medium shrink-0">
              {t('命名模板')}
            </span>
            <span className="font-mono truncate" title={namingTemplate}>
              {namingTemplate}
            </span>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={cn('select-none text-xs', depth > 0 && 'ml-3 pl-2 border-l border-border/50')}>
      <div className="flex items-center gap-1.5 py-1 text-foreground font-medium group">
        {isRoot ? (
          <Folder className="w-4 h-4 text-primary fill-primary/20 shrink-0" />
        ) : (
          <Folder className="w-3.5 h-3.5 text-amber-500 fill-amber-500/20 dark:text-amber-400 dark:fill-amber-400/20 shrink-0" />
        )}
        <span className={cn('truncate', isRoot && 'font-bold text-primary')}>{node.name}</span>
      </div>

      {hasChildren && (
        <div className="space-y-0.5">
          {node.children!.map((child, idx) => (
            <PreviewTreeNodeView
              key={`${child.name}-${idx}`}
              node={child}
              depth={depth + 1}
              namingTemplate={namingTemplate}
            />
          ))}
        </div>
      )}
    </div>
  )
}
