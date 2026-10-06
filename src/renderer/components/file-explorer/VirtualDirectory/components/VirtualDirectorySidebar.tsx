import React from 'react'
import { t } from '@app/languages'
import { getFileNameFromPath } from '@firefly/shared'
import { TreeView } from '../../../../components/common/TreeView'
import { MaterialIcon, cn } from '../../../../lib/utils'
import { FileTypeIcon, extractFileExtension } from '../../../../components/common/FileTypeIcon'
import {
  VirtualDirectory as VirtualDirectoryType,
  VirtualDirectoryNode,
  WorkspaceDirectory,
  DimensionGroup,
  SelectedTag,
  UnionMode
} from '@firefly/types'
import { DimensionTreeSidebar } from '../../DimensionTreeSidebar'
import { useSettingsStore } from '../../../../stores/settings-store'
import { useKeyboardNavigation } from '../hooks/useKeyboardNavigation'
import { PAGE_IDS } from '../../../../constants/page-ids'

export interface VirtualDirectorySidebarProps {
  virtualDirectories: VirtualDirectoryType[]
  selectedId: number | null
  setSelectedId: (id: number | null) => void
  currentVD: VirtualDirectoryType | undefined
  isExportMode: boolean
  currentWorkspaceDirectory: WorkspaceDirectory | null
  dimensionGroups: DimensionGroup[]
  isDimensionLoading: boolean
  unionMode: UnionMode
  onSelectionChange: (
    tagsSet: Set<string>,
    reason: 'toggle' | 'selectAll' | 'invert' | 'clear',
    updatedParentTagMap: Map<string, string[]>
  ) => void
  onModeChange: (mode: UnionMode) => void
  onTagClick: (tag: SelectedTag) => void
  treeData: VirtualDirectoryNode[]
  rootNode: VirtualDirectoryNode | null
  selectedNode: VirtualDirectoryNode | null
  setSelectedNode: (node: VirtualDirectoryNode | null) => void
  activeItem: any | null
  setActiveItem: (item: any | null) => void
  setSelectedFileListFiles: (files: any[]) => void
  fileListFiles: any[]
  sidebarCollapsed: boolean
  setSidebarCollapsed: (collapsed: boolean) => void
  entitlements: any[] | undefined
  vdirSlotLimit: number
  computed_limits: any
  setRenamingId: (id: number | null) => void
  handleRegenerate: (vd: VirtualDirectoryType) => Promise<void>
  handleDelete: (id: number) => void
  vdirMultiSelectMode: boolean
  setVdirMultiSelectMode: (mode: boolean) => void
  vdirSidebarTab: 'directory' | 'dimensions'
  setVdirSidebarTab: (tab: 'directory' | 'dimensions') => void
  expandedKeys: Set<string>
  setExpandedKeys: React.Dispatch<React.SetStateAction<Set<string>>>
}

export const VirtualDirectorySidebar: React.FC<VirtualDirectorySidebarProps> = React.memo(
  ({
    virtualDirectories,
    selectedId,
    setSelectedId,
    currentVD,
    isExportMode,
    currentWorkspaceDirectory,
    dimensionGroups,
    isDimensionLoading,
    unionMode,
    onSelectionChange,
    onModeChange,
    onTagClick,
    treeData,
    rootNode,
    selectedNode,
    setSelectedNode,
    activeItem,
    setActiveItem,
    setSelectedFileListFiles,
    fileListFiles,
    sidebarCollapsed,
    setSidebarCollapsed,
    entitlements,
    vdirSlotLimit,
    computed_limits,
    setRenamingId,
    handleRegenerate,
    handleDelete,
    vdirMultiSelectMode,
    setVdirMultiSelectMode,
    vdirSidebarTab,
    setVdirSidebarTab,
    expandedKeys,
    setExpandedKeys
  }) => {
    const swapFileNameDisplay =
      useSettingsStore(s => s.getConfigValue<boolean>('SWAP_FILE_NAME_DISPLAY')) ?? false

    const { handleTreeKeyDown } = useKeyboardNavigation({
      treeData,
      rootNode,
      expandedKeys,
      activeItem,
      setActiveItem,
      setSelectedNode,
      setSelectedFileListFiles,
      fileListFiles
    })

    const childrenCacheRef = React.useRef(
      new WeakMap<VirtualDirectoryNode, VirtualDirectoryNode[]>()
    )

    const getTreeChildren = React.useCallback((n: VirtualDirectoryNode) => {
      let cached = childrenCacheRef.current.get(n)
      if (cached) return cached

      const subdirs = n.subdirectories || []
      const files = (n.files || []).map((f: any) => ({
        ...f,
        isFile: true,
        _rawName: f.name,
        _rawSmartName: f.smartName,
        name: f.smartName || f.name || getFileNameFromPath(f.originalPath) || 'unknown',
        parent: n.name,
        subdirectories: [],
        files: [],
        fileCount: 0,
        totalSize: 0
      }))
      cached = [...subdirs, ...files] as VirtualDirectoryNode[]
      childrenCacheRef.current.set(n, cached)
      return cached
    }, [])

    return (
      <div className="flex flex-col h-full border-r bg-card/40">
        {/* Tab 选项卡 */}
        <div className="flex border-b border-border bg-card/60 px-2 flex-shrink-0 h-[44px]">
          <button
            onClick={() => {
              setVdirSidebarTab('directory')
              setActiveItem(selectedNode)
            }}
            className={cn(
              'flex-1 text-xs px-3 font-medium transition-colors text-center cursor-pointer relative flex items-center justify-center h-full',
              vdirSidebarTab === 'directory'
                ? 'text-primary font-semibold border-b-2 border-primary -mb-px'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {t('文件目录')}
          </button>
          <button
            onClick={() => {
              setVdirSidebarTab('dimensions')
              setActiveItem(null)
            }}
            className={cn(
              'flex-1 text-xs px-3 font-medium transition-colors text-center cursor-pointer relative flex items-center justify-center h-full',
              vdirSidebarTab === 'dimensions'
                ? 'text-primary font-semibold border-b-2 border-primary -mb-px'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {t('分类维度')}
          </button>
        </div>

        {vdirSidebarTab === 'dimensions' && !isExportMode && (
          <div className="px-3 py-2 border-b border-border/80 flex items-center justify-between flex-shrink-0 bg-muted/5">
            <span className="text-[11px] font-medium text-muted-foreground flex items-center gap-1">
              <MaterialIcon icon="tune" className="text-[12px]" />
              {t('筛选模式')}
            </span>
            <div className="flex items-center space-x-2">
              <span className="text-[11px] text-muted-foreground">{t('多选')}</span>
              <button
                role="switch"
                aria-checked={vdirMultiSelectMode}
                onClick={() => {
                  setVdirMultiSelectMode(!vdirMultiSelectMode)
                }}
                className={cn(
                  'relative inline-flex h-4.5 w-8 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none',
                  vdirMultiSelectMode ? 'bg-primary' : 'bg-muted-foreground/30'
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'pointer-events-none inline-block h-3.5 w-3.5 transform rounded-full bg-background shadow ring-0 transition duration-200 ease-in-out',
                    vdirMultiSelectMode ? 'translate-x-3.5' : 'translate-x-0'
                  )}
                />
              </button>
            </div>
          </div>
        )}

        <div
          className={cn(
            'flex-1 min-h-0',
            vdirSidebarTab === 'directory'
              ? 'overflow-y-auto overflow-x-hidden p-2'
              : 'flex flex-col overflow-hidden'
          )}
          tabIndex={0}
          onKeyDown={vdirSidebarTab === 'directory' ? handleTreeKeyDown : undefined}
        >
          {vdirSidebarTab === 'directory' ? (
            treeData.length > 0 && (
              <TreeView
                nodes={treeData}
                expandedKeys={expandedKeys}
                onExpandedChange={(keys: Set<string>) => setExpandedKeys(keys)}
                expandMode="expand-first"
                getChildren={getTreeChildren}
                getKey={(n: VirtualDirectoryNode) =>
                  (n as any).isFile
                    ? `file-${(n as any).fileId || (n as any).file_id || (n as any).id}-${(n as any).originalPath}`
                    : `dir-${n.name}`
                }
                getLabel={(n: VirtualDirectoryNode) => {
                  const node = n as any
                  let displayName = node.name
                  if (node.isFile) {
                    displayName = swapFileNameDisplay
                      ? node._rawName || node._rawSmartName || displayName
                      : node._rawSmartName || node._rawName || displayName
                  }
                  return (
                    <div className="flex items-center">
                      <span>{displayName}</span>
                      {!node.isFile && node.fileCount > 0 && (
                        <span className="ml-2 text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full">
                          {node.fileCount}
                        </span>
                      )}
                    </div>
                  )
                }}
                renderNodeIcon={(n: VirtualDirectoryNode) => {
                  const node = n as any
                  if (node.isFile) {
                    return (
                      <FileTypeIcon
                        path={node.originalPath || node.path}
                        extension={extractFileExtension(
                          node.originalPath || node.path || node._rawName || node.name || ''
                        )}
                        className="w-4 h-4 object-contain"
                        fallbackClassName="text-sm text-muted-foreground"
                      />
                    )
                  }
                  return <MaterialIcon icon="folder" className="text-sm text-primary" />
                }}
                onSelect={(_: any, node: VirtualDirectoryNode) => {
                  if ((node as any).isFile) {
                    const { isPathEqual } = window.electronAPI!.utils
                    const filePath = (node as any).originalPath || (node as any).path
                    const fileId = (node as any).fileId || (node as any).file_id || (node as any).id

                    // 查找文件对应的父级目录节点
                    let parentNode: VirtualDirectoryNode | null | 'ROOT' = null
                    if (
                      rootNode?.rootFiles?.some(
                        f =>
                          f.fileId === fileId ||
                          f.id === fileId ||
                          (filePath && f.originalPath && isPathEqual(f.originalPath, filePath))
                      )
                    ) {
                      parentNode = 'ROOT'
                    } else {
                      const searchDir = (
                        dirs: VirtualDirectoryNode[]
                      ): VirtualDirectoryNode | null => {
                        for (const d of dirs) {
                          if (
                            d.files?.some(
                              f =>
                                f.fileId === fileId ||
                                f.id === fileId ||
                                (filePath &&
                                  f.originalPath &&
                                  isPathEqual(f.originalPath, filePath))
                            )
                          ) {
                            return d
                          }
                          if (d.subdirectories && d.subdirectories.length > 0) {
                            const found = searchDir(d.subdirectories)
                            if (found) return found
                          }
                        }
                        return null
                      }
                      parentNode = searchDir(treeData)
                    }

                    if (parentNode === 'ROOT') {
                      setSelectedNode(rootNode)
                      setSelectedFileListFiles(rootNode?.rootFiles || [])
                    } else if (parentNode) {
                      setSelectedNode(parentNode)
                      setSelectedFileListFiles(parentNode.files || [])
                    }

                    setActiveItem(node)
                  } else {
                    setSelectedNode(node)
                    setSelectedFileListFiles(node.files || [])
                    setActiveItem(node)

                    // 点击目录节点时，自动展开/折叠
                    setExpandedKeys(prev => {
                      const next = new Set(prev)
                      const dirKey = `dir-${node.name}`
                      if (next.has(dirKey)) {
                        next.delete(dirKey)
                      } else {
                        next.add(dirKey)
                      }
                      return next
                    })
                  }
                }}
                selectedKeys={
                  (activeItem as any)?.isFile
                    ? new Set([
                        `file-${(activeItem as any).fileId || (activeItem as any).file_id || (activeItem as any).id}-${(activeItem as any).originalPath}`
                      ])
                    : selectedNode
                      ? new Set([`dir-${selectedNode.name}`])
                      : new Set()
                }
              />
            )
          ) : (
            <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
              {isDimensionLoading && dimensionGroups.length === 0 ? (
                <div className="text-center py-8">
                  <div className="inline-block animate-spin rounded-full h-8 w-8 border-t-2 border-primary mb-2"></div>
                  <p className="text-xs text-muted-foreground">{t('加载中...')}</p>
                </div>
              ) : dimensionGroups.length === 0 ? (
                <div className="text-center py-8 text-xs text-muted-foreground">
                  {t('暂无维度数据')}
                </div>
              ) : (
                <DimensionTreeSidebar
                  dimensionGroups={dimensionGroups}
                  showEmptyTags={false}
                  isExportMode={isExportMode || vdirMultiSelectMode}
                  showSelectAll={isExportMode || vdirMultiSelectMode}
                  storageKey="vdir"
                  workspacePath={currentWorkspaceDirectory?.path}
                  onSelectionChange={onSelectionChange}
                  onModeChange={onModeChange}
                  onTagClick={onTagClick}
                  initialUnionMode={unionMode}
                />
              )}
            </div>
          )}
        </div>
        {/* 左侧目录树底部状态栏 */}
        {currentVD && (
          <div className="px-4 py-1.5 border-t bg-muted/5 flex items-center text-xs text-muted-foreground">
            <MaterialIcon
              icon={vdirSidebarTab === 'directory' ? 'folder' : 'category'}
              className="mr-1.5 text-sm text-primary"
            />
            {vdirSidebarTab === 'directory'
              ? t('{count} 个子目录', { count: treeData.length })
              : t('{count} 个维度组', { count: dimensionGroups.length })}
          </div>
        )}
      </div>
    )
  }
)
