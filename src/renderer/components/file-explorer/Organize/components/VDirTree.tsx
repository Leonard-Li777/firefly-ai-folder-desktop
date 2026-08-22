import React, { useState, useRef, useEffect } from 'react'
import { VirtualDirectoryNode } from '@firefly/types'
import { TreeView, TreeExpandMode } from '../../../common/TreeView'
import { MaterialIcon, cn } from '../../../../lib/utils'
import { FileTypeIcon, extractFileExtension } from '../../../common/FileTypeIcon'
import { Folder, Edit2, FolderPlus, Plus, Trash2, Check, X } from 'lucide-react'
import { t } from '@app/languages'
import { useSettingsStore } from '../../../../stores/settings-store'
import { Button } from '../../../ui/button'
import { isUnclassifiedNodeName, isNodeRenameable as checkNodeRenameable } from '../utils/helpers'

export function VDirTree({
  nodes,
  expandMode = 'expand-all',
  onDeleteNode,
  onRenameNode,
  onAddSubdir,
  onMoveNodeOrFile,
  allowEdit = true,
  extraHeaderAction,
  organizeMode,
  highFrequencyTags,
  currentVDirId
}: {
  nodes: VirtualDirectoryNode[]
  expandMode?: TreeExpandMode
  onDeleteNode?: (nodeKey: string) => void
  onRenameNode?: (nodeKey: string, newName: string) => void
  onAddSubdir?: (parentKey: string, subdirName: string) => void
  onMoveNodeOrFile?: (draggedData: any, targetNodeKey: string) => void
  allowEdit?: boolean
  extraHeaderAction?: React.ReactNode
  organizeMode?: string
  highFrequencyTags?: Set<string>
  currentVDirId?: number
}) {
  // ─── 行内编辑状态 ─────────────────────────────────────────────────────────────
  const [editingNodeKey, setEditingNodeKey] = useState<string | null>(null)
  const [editingText, setEditingText] = useState('')

  // ─── 行内新增节点状态 ─────────────────────────────────────────────────────────
  // addingParentKey 为 '' 代表新建根目录，为 nodeKey 代表在该节点下新建子目录
  const [addingParentKey, setAddingParentKey] = useState<string | null>(null)
  const [addingText, setAddingText] = useState('')

  const inputRef = useRef<HTMLInputElement>(null)

  /** 计算目录节点的路径唯一 key */
  const dirKey = (node: any): string => {
    if (node.id) return String(node.id)
    return node.parentKey ? `${node.parentKey}/${node.name}` : node.name
  }

  // 聚焦输入框
  useEffect(() => {
    if (editingNodeKey || addingParentKey !== null) {
      setTimeout(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      }, 50)
    }
  }, [editingNodeKey, addingParentKey])

  const isUnclassifiedNode = (node: any): boolean => {
    if (!node) return false
    return isUnclassifiedNodeName(node.name) || !!node.isUnclassified || !!node.unclassified
  }

  const isNodeRenameable = (node: any): boolean => {
    return checkNodeRenameable(node, { currentVDirId, organizeMode, highFrequencyTags })
  }

  const isHighFreqTagNode = (node: any): boolean => {
    if (!node || node.isFile || node.isAddingPlaceholder || isUnclassifiedNode(node)) return false
    if (!highFrequencyTags) return false
    const name = (node.name || '').trim()
    const nameLower = name.toLowerCase()
    return highFrequencyTags.has(name) || highFrequencyTags.has(nameLower)
  }

  // 触发行内重命名
  const handleStartRename = (node: any, key: string, currentName: string) => {
    if (!isNodeRenameable(node)) return
    setAddingParentKey(null)
    setEditingNodeKey(key)
    setEditingText(currentName)
  }

  // 确认行内重命名
  const handleSaveRename = () => {
    if (editingNodeKey && editingText.trim()) {
      onRenameNode?.(editingNodeKey, editingText.trim())
    }
    setEditingNodeKey(null)
    setEditingText('')
  }

  // ─── 内部受控的展开节点 State ──────────────────────────────────────────────────
  const [internalExpandedKeys, setInternalExpandedKeys] = useState<Set<string>>(new Set())

  // 触发行内新增子目录时自动展开父节点及祖先链
  const handleStartAdd = (node: any, parentKey: string) => {
    if (node && isUnclassifiedNode(node)) return
    setEditingNodeKey(null)
    setAddingParentKey(parentKey)
    setAddingText('')

    if (parentKey) {
      setInternalExpandedKeys(prev => {
        const next = new Set(prev)
        const parts = parentKey.split('/')
        let current = ''
        for (const p of parts) {
          current = current ? `${current}/${p}` : p
          next.add(current)
        }
        return next
      })
    }
  }

  // 确认行内新增子目录
  const handleSaveAdd = () => {
    if (addingParentKey !== null && addingText.trim()) {
      onAddSubdir?.(addingParentKey, addingText.trim())
    }
    setAddingParentKey(null)
    setAddingText('')
  }

  // 构造增强的树节点数据（注入行内新建子目录的 placeholder 临时节点）
  const injectAddingPlaceholder = (rawNodes: VirtualDirectoryNode[], parentPath = ''): any[] => {
    let result = (rawNodes || []).map((node: any) => {
      const sanitizedName = node.name ? String(node.name).trim() : ''
      const currentKey = node.id
        ? String(node.id)
        : parentPath
          ? `${parentPath}/${sanitizedName}`
          : sanitizedName

      let updatedSubdirs = node.subdirectories
        ? injectAddingPlaceholder(node.subdirectories, currentKey)
        : []

      // 如果当前节点正是新增子目录的父节点，插入 placeholder
      if (addingParentKey === currentKey) {
        const placeholderNode = {
          name: '',
          isAddingPlaceholder: true,
          parentKey: currentKey,
          subdirectories: [],
          files: [],
          fileCount: 0
        }
        updatedSubdirs = [...updatedSubdirs, placeholderNode]
      }

      return {
        ...node,
        parentKey: parentPath,
        subdirectories: updatedSubdirs
      }
    })

    if (addingParentKey === '' && parentPath === '') {
      result = [
        ...result,
        {
          name: '',
          isAddingPlaceholder: true,
          parentKey: '',
          subdirectories: [],
          files: [],
          fileCount: 0
        }
      ]
    }

    return result
  }

  const displayNodes = injectAddingPlaceholder(nodes)

  return (
    <div className="h-full flex flex-col relative select-none">
      {((allowEdit && onAddSubdir) || extraHeaderAction) && (
        <div className="p-2 border-b border-border/40 flex items-center justify-between gap-2 bg-muted/20 shrink-0">
          {allowEdit && onAddSubdir ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleStartAdd(null, '')}
              className="h-6 text-[11px] gap-1 text-primary hover:text-primary hover:bg-primary/10 px-2 rounded-md font-bold shrink-0"
            >
              <Plus className="w-3 h-3" />
              {t('新建根目录')}
            </Button>
          ) : (
            <div />
          )}
          {extraHeaderAction && (
            <div className="flex items-center shrink-0">{extraHeaderAction}</div>
          )}
        </div>
      )}

      <div className="flex-1 overflow-auto p-1">
        <TreeView<any>
          nodes={displayNodes}
          getChildren={(node: any) => {
            if (node.isAddingPlaceholder) return []
            const subdirs = (node.subdirectories || []).map((sub: any) => ({
              ...sub,
              parentKey: dirKey(node)
            }))
            const parentKey = dirKey(node)

            const seenIds = new Set<string>()
            const uniqueRawFiles = (node.files || []).filter((f: any) => {
              const fid = String(f.fileId || f.id || f.name)
              if (seenIds.has(fid)) return false
              seenIds.add(fid)

              const rawSmartName = f.smartName || ''
              const rawName = f.name || ''

              if (
                isUnclassifiedNodeName(rawSmartName) ||
                isUnclassifiedNodeName(rawName) ||
                f.isUnclassified ||
                f.unclassified
              ) {
                return false
              }
              return true
            })

            const files = uniqueRawFiles.map((f: any) => ({
              ...f,
              isFile: true,
              _rawName: f.name,
              _rawSmartName: f.smartName,
              name: f.smartName || f.name || '',
              parentKey,
              subdirectories: []
            }))
            return [...subdirs, ...files]
          }}
          getKey={(node: any) => {
            if (node.isAddingPlaceholder) return `adding-${node.parentKey}`
            return node.isFile
              ? `file-${node.parentKey}-${node.fileId || node.id || node.name}`
              : dirKey(node)
          }}
          getLabel={(node: any) => {
            const key = dirKey(node)

            // 1. 如果是行内新建占位节点
            if (node.isAddingPlaceholder) {
              return (
                <div
                  className="flex items-center gap-1 text-xs w-full py-0.5"
                  onClick={e => e.stopPropagation()}
                >
                  <input
                    ref={inputRef}
                    type="text"
                    value={addingText}
                    onChange={e => setAddingText(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') handleSaveAdd()
                      if (e.key === 'Escape') setAddingParentKey(null)
                    }}
                    onBlur={handleSaveAdd}
                    placeholder={t('按 Enter 确认创建')}
                    className="h-6 px-1.5 py-0.5 text-xs rounded border border-primary bg-background focus:outline-none focus:ring-1 focus:ring-primary flex-1 min-w-0"
                  />
                  <button
                    onClick={handleSaveAdd}
                    className="p-1 text-primary hover:bg-primary/20 rounded"
                    title={t('确认')}
                  >
                    <Check className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => setAddingParentKey(null)}
                    className="p-1 text-muted-foreground hover:bg-muted rounded"
                    title={t('取消')}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )
            }

            // 2. 如果当前节点处于行内重命名状态
            if (!node.isFile && editingNodeKey === key) {
              return (
                <div
                  className="flex items-center gap-1 text-xs w-full py-0.5"
                  onClick={e => e.stopPropagation()}
                >
                  <input
                    ref={inputRef}
                    type="text"
                    value={editingText}
                    onChange={e => setEditingText(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') handleSaveRename()
                      if (e.key === 'Escape') setEditingNodeKey(null)
                    }}
                    onBlur={handleSaveRename}
                    className="h-6 px-1.5 py-0.5 text-xs rounded border border-primary bg-background focus:outline-none focus:ring-1 focus:ring-primary flex-1 min-w-0"
                  />
                  <button
                    onClick={handleSaveRename}
                    className="p-1 text-primary hover:bg-primary/20 rounded"
                    title={t('保存')}
                  >
                    <Check className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => setEditingNodeKey(null)}
                    className="p-1 text-muted-foreground hover:bg-muted rounded"
                    title={t('取消')}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )
            }

            // 3. 常规节点展示
            if (node.isFile) {
              const getConfigValue = useSettingsStore.getState().getConfigValue
              const swap = getConfigValue<boolean>('SWAP_FILE_NAME_DISPLAY') ?? false
              return swap
                ? node._rawName || node._rawSmartName || ''
                : node._rawSmartName || node._rawName || ''
            }

            const isUnclassified = isUnclassifiedNode(node)
            const isHighFreq = isHighFreqTagNode(node)
            return (
              <div
                className="flex items-center gap-1.5 min-w-0"
                title={isUnclassified ? t('待分类文件汇总目录') : isHighFreq ? t('高频标签') : ''}
              >
                <span
                  className={cn(
                    'truncate font-medium transition-colors',
                    isUnclassified && 'text-amber-600 dark:text-amber-400 font-bold',
                    isHighFreq &&
                      !isUnclassified &&
                      'text-emerald-600 dark:text-emerald-400 font-medium'
                  )}
                >
                  {node.name}
                </span>
                {isUnclassified && (
                  <span className="text-[10px] px-1.5 py-0.2 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 font-semibold shrink-0 border border-amber-500/25">
                    {t('待分类')}
                  </span>
                )}
              </div>
            )
          }}
          expandMode={expandMode}
          expandedKeys={internalExpandedKeys}
          onExpandedChange={(keys: Set<string>) => setInternalExpandedKeys(keys)}
          renderNodeIcon={(node: any) =>
            node.isFile ? (
              <FileTypeIcon
                path={node.originalPath || node.path}
                extension={extractFileExtension(
                  node.originalPath || node.path || node._rawName || node.name
                )}
                className="w-4 h-4 object-contain flex-shrink-0"
                fallbackClassName="text-[14px] text-muted-foreground/60"
              />
            ) : isUnclassifiedNode(node) ? (
              <Folder className="w-4 h-4 text-amber-500 fill-amber-500/30 dark:text-amber-400 dark:fill-amber-400/30 flex-shrink-0" />
            ) : isHighFreqTagNode(node) ? (
              <Folder className="w-4 h-4 text-emerald-500 fill-emerald-500/20 dark:text-emerald-400 dark:fill-emerald-400/20 flex-shrink-0" />
            ) : (
              <Folder className="w-4 h-4 text-primary fill-primary/20 flex-shrink-0" />
            )
          }
          renderNodeMeta={(node: any) =>
            !node.isFile && !node.isAddingPlaceholder && node.fileCount > 0 ? (
              <span
                className={cn(
                  'text-[10px]',
                  isUnclassifiedNode(node)
                    ? 'text-amber-600/90 dark:text-amber-400/90 font-medium'
                    : 'text-muted-foreground'
                )}
              >
                {node.fileCount} {t('个文件')}
              </span>
            ) : null
          }
          renderNodeExtra={
            allowEdit
              ? (node: any) => {
                  if (node.isFile || node.isAddingPlaceholder || isUnclassifiedNode(node))
                    return null
                  const key = dirKey(node)
                  if (editingNodeKey === key) return null

                  return (
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity ml-auto select-none">
                      {onAddSubdir && (
                        <a
                          className="w-5 h-5 rounded hover:bg-primary/20 text-muted-foreground hover:text-primary flex items-center justify-center text-[12px] transition-colors"
                          onClick={e => {
                            e.stopPropagation()
                            handleStartAdd(node, key)
                          }}
                          title={t('插入子目录')}
                        >
                          <FolderPlus className="w-3 h-3" />
                        </a>
                      )}
                      {onRenameNode && isNodeRenameable(node) && (
                        <a
                          className="w-5 h-5 rounded hover:bg-primary/20 text-muted-foreground hover:text-primary flex items-center justify-center text-[12px] transition-colors"
                          onClick={e => {
                            e.stopPropagation()
                            handleStartRename(node, key, node.name)
                          }}
                          title={t('重命名目录')}
                        >
                          <Edit2 className="w-3 h-3" />
                        </a>
                      )}
                      {onDeleteNode && (
                        <a
                          className="w-5 h-5 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive flex items-center justify-center text-[12px] transition-colors"
                          onClick={e => {
                            e.stopPropagation()
                            onDeleteNode(key)
                          }}
                          title={t('删除目录')}
                        >
                          <Trash2 className="w-3 h-3" />
                        </a>
                      )}
                    </div>
                  )
                }
              : undefined
          }
          canDrag={(node: any) => {
            if (node.isAddingPlaceholder || isUnclassifiedNode(node)) return false
            return allowEdit
          }}
          canDrop={(targetNode: any) => {
            if (
              targetNode.isFile ||
              targetNode.isAddingPlaceholder ||
              isUnclassifiedNode(targetNode)
            )
              return false
            return allowEdit
          }}
          onDragStart={(node: any, event: React.DragEvent) => {
            const key = dirKey(node)
            const data = node.isFile
              ? { type: 'file', file: node }
              : { type: 'dir', nodeKey: key, name: node.name }
            event.dataTransfer.setData('application/json', JSON.stringify(data))
            event.dataTransfer.effectAllowed = 'move'
          }}
          onDrop={(targetNode: any, event: React.DragEvent) => {
            const targetKey = dirKey(targetNode)
            try {
              const json = event.dataTransfer.getData('application/json')
              if (json) {
                const data = JSON.parse(json)
                onMoveNodeOrFile?.(data, targetKey)
              }
            } catch (e) {
              // Ignore invalid JSON
            }
          }}
          className="h-full"
        />
      </div>
    </div>
  )
}
