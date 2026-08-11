import React, { memo } from 'react'
import { MaterialIcon } from '../../lib/utils'

interface BreadcrumbsProps {
  currentPath: string
  basePath: string
  onNavigate: (path: string) => void
}

export const Breadcrumbs = memo(({ currentPath, basePath, onNavigate }: BreadcrumbsProps) => {
  const { isSubPath } = window.electronAPI!.utils

  if (!currentPath || !basePath || !isSubPath(basePath, currentPath)) {
    return <span className="truncate">{currentPath}</span>
  }

  if (currentPath === basePath) {
    return <span className="text-muted-foreground truncate">{basePath}</span>
  }

  const relativePath = currentPath.substring(basePath.length).replace(/^[/\\]/, '')
  const parts = relativePath.split(/[/\\]/).filter(Boolean)

  return (
    <div className="flex items-center overflow-x-auto custom-scrollbar-hide">
      <button
        className="text-muted-foreground hover:text-primary hover:underline transition-colors flex-shrink-0 truncate cursor-pointer"
        onClick={() => onNavigate(basePath)}
        title={basePath}
      >
        {basePath}
      </button>
      {parts.map((part, index) => {
        const sep = window.electronAPI!.utils.getPlatform?.() === 'win32' ? '\\' : '/'
        const fullPath = [basePath, ...parts.slice(0, index + 1)].join(sep)
        return (
          <React.Fragment key={index}>
            <MaterialIcon
              icon="chevron_right"
              className="text-muted-foreground mx-0.5 text-[16px] flex-shrink-0"
            />
            <button
              className="hover:text-primary hover:underline transition-colors flex-shrink-0 truncate"
              onClick={() => onNavigate(fullPath)}
              title={part}
            >
              {part}
            </button>
          </React.Fragment>
        )
      })}
    </div>
  )
})

Breadcrumbs.displayName = 'Breadcrumbs'
