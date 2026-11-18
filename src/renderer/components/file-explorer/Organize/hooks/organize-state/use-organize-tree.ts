import { useCallback, useState } from 'react'
import { VirtualDirectory, VirtualDirectoryNode } from '@firefly/types'
import { LogCategory, logger } from '@firefly/shared'
import i18nScope from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'
import { toast } from '../../../../common/Toast'
import { useOrganizeStore } from '../../../../../stores/organize-store'
import {
  getFileUniqueKey,
  isUnclassifiedNodeName,
  recalculateNodeFileCounts,
  sanitizeDirectoryName
} from '../../utils/helpers'
import { UNCLASSIFIED_NAME } from './constants'

interface UseOrganizeTreeParams {
  allWorkspaceFiles: any[]
  incrementalVdId: number | null
  setIncrementalVdId: (v: number | null) => void
  currentVDir: VirtualDirectory | null
  setCurrentVDir: (v: VirtualDirectory | null) => void
  setIncrementalFiles: (updater: (prev: any[]) => any[]) => void
}

/**
 * 目录树编辑域：重命名 / 新增子目录 / 删除（含二次确认）/ 拖拽移动，并同步增量整理快照。
 */
export function useOrganizeTree({
  allWorkspaceFiles,
  incrementalVdId,
  setIncrementalVdId,
  currentVDir,
  setCurrentVDir,
  setIncrementalFiles
}: UseOrganizeTreeParams) {
  const { t } = useVoerkaI18n(i18nScope)

  const stage = useOrganizeStore(s => s.stage)
  const draftTree = useOrganizeStore(s => s.draftTree)
  const finalTree = useOrganizeStore(s => s.finalTree)
  const setDraftTree = useOrganizeStore(s => s.setDraftTree)
  const setFinalTree = useOrganizeStore(s => s.setFinalTree)

  // ─── 重命名目录节点 ──────────────────────────────────────────────────────────
  const handleRenameTreeNode = useCallback((nodeKey: string, newName: string) => {
    const trimmedName = sanitizeDirectoryName(newName.trim())
    if (!trimmedName) return
    const pathParts = nodeKey.split('/')

    const renameByPath = (
      nodes: VirtualDirectoryNode[],
      pathSegments: string[]
    ): VirtualDirectoryNode[] => {
      if (pathSegments.length === 0) return nodes
      const [targetName, ...remainingSegments] = pathSegments

      return nodes.map(node => {
        const nodeName = sanitizeDirectoryName(node.name)
        if (nodeName !== targetName) return node
        if (remainingSegments.length === 0) {
          return { ...node, name: trimmedName }
        }
        return {
          ...node,
          subdirectories: renameByPath(node.subdirectories || [], remainingSegments)
        }
      })
    }

    setDraftTree(prev => renameByPath(prev, pathParts))
    setFinalTree(prev => renameByPath(prev, pathParts))
    toast.success(t('重命名目录成功'))
  }, [])

  // ─── 插入子目录节点 ──────────────────────────────────────────────────────────
  const handleAddSubdirTreeNode = useCallback((parentKey: string, subdirName: string) => {
    const trimmedName = sanitizeDirectoryName(subdirName.trim())
    if (!trimmedName) return

    const newChildNode: VirtualDirectoryNode = {
      name: trimmedName,
      files: [],
      subdirectories: [],
      fileCount: 0,
      parent: parentKey || null,
      totalSize: 0
    }

    if (!parentKey) {
      // 插入顶层根目录
      setDraftTree(prev => [...prev, newChildNode])
      setFinalTree(prev => [...prev, newChildNode])
      toast.success(t('创建根目录成功'))
      return
    }

    const pathParts = parentKey.split('/')
    const addByPath = (
      nodes: VirtualDirectoryNode[],
      pathSegments: string[]
    ): VirtualDirectoryNode[] => {
      if (pathSegments.length === 0) return nodes
      const [targetName, ...remainingSegments] = pathSegments

      return nodes.map(node => {
        const nodeName = sanitizeDirectoryName(node.name)
        if (nodeName !== targetName) return node
        if (remainingSegments.length === 0) {
          const subs = node.subdirectories || []
          if (subs.some(s => sanitizeDirectoryName(s.name) === trimmedName)) {
            toast.error(t('子目录名称已存在'))
            return node
          }
          return {
            ...node,
            subdirectories: [...subs, newChildNode]
          }
        }
        return {
          ...node,
          subdirectories: addByPath(node.subdirectories || [], remainingSegments)
        }
      })
    }

    setDraftTree(prev => addByPath(prev, pathParts))
    setFinalTree(prev => addByPath(prev, pathParts))
    toast.success(t('新增子目录成功'))
  }, [])

  // ─── 删除目录节点 ──────────────────────────────────────────────────────────
  const [deleteConfirmNodeKey, setDeleteConfirmNodeKey] = useState<string | null>(null)
  const [deleteConfirmNodeName, setDeleteConfirmNodeName] = useState<string>('')

  const extractSubtreeFiles = useCallback((node: VirtualDirectoryNode): any[] => {
    let files: any[] = []
    if (Array.isArray(node.files)) {
      files = [...node.files]
    }
    if (Array.isArray(node.subdirectories)) {
      for (const sub of node.subdirectories) {
        files = [...files, ...extractSubtreeFiles(sub)]
      }
    }
    return files
  }, [])

  const executeDeleteTreeNode = useCallback(
    async (nodeKey: string, dirName: string) => {
      const pathParts = nodeKey.split('/')

      // 1. 显式在活动树中定位要删除的节点，并提取该节点及其所有子树下的关联文件
      const currentTree = stage === 'structure' ? draftTree : finalTree
      let targetNodeToDelete: VirtualDirectoryNode | null = null

      const findTargetNode = (nodes: VirtualDirectoryNode[], segments: string[]) => {
        if (segments.length === 0 || !Array.isArray(nodes)) return
        const [targetName, ...remaining] = segments
        for (const node of nodes) {
          const nodeName = sanitizeDirectoryName(node.name)
          if (nodeName === targetName) {
            if (remaining.length === 0) {
              targetNodeToDelete = node
              return
            }
            findTargetNode(node.subdirectories || [], remaining)
          }
        }
      }
      findTargetNode(currentTree, pathParts)

      const rawExtractedFiles = targetNodeToDelete ? extractSubtreeFiles(targetNodeToDelete) : []

      const allWorkspaceMap = new Map((allWorkspaceFiles || []).map(f => [String(f.id), f]))
      const formattedDeletedFiles = rawExtractedFiles.map(f => {
        const rawId = f.fileId ?? f.id
        const matched = rawId != null ? allWorkspaceMap.get(String(rawId)) : null
        const ext =
          f.extension ||
          matched?.extension ||
          (f.path || f.originalPath || matched?.path)?.split('.').pop()?.toLowerCase() ||
          ''
        return {
          ...(matched || {}),
          ...f,
          id: rawId != null ? Number(rawId) : f.id,
          fileId: rawId != null ? Number(rawId) : f.fileId,
          path: f.path || f.originalPath || matched?.path || '',
          originalPath: f.originalPath || f.path || matched?.path || '',
          extension: ext,
          isUnclassified: true
        }
      })

      // 2. 物理从树结构中移除该节点，并将被删除的文件移动至未归类节点
      const removeAndMoveToUnclassified = (
        treeNodes: VirtualDirectoryNode[]
      ): VirtualDirectoryNode[] => {
        const removeByPath = (
          nodes: VirtualDirectoryNode[],
          pathSegments: string[]
        ): VirtualDirectoryNode[] => {
          if (pathSegments.length === 0 || !Array.isArray(nodes)) return nodes
          const [targetName, ...remainingSegments] = pathSegments

          return nodes
            .filter(node => {
              const nodeName = sanitizeDirectoryName(node.name)
              if (nodeName !== targetName) return true
              if (remainingSegments.length === 0) return false
              return true
            })
            .map(node => {
              const nodeName = sanitizeDirectoryName(node.name)
              if (nodeName !== targetName) return node
              return {
                ...node,
                subdirectories: removeByPath(node.subdirectories || [], remainingSegments)
              }
            })
        }

        const newTree = removeByPath(treeNodes, pathParts)

        if (formattedDeletedFiles.length > 0) {
          let unclassifiedNode = newTree.find(
            n => isUnclassifiedNodeName(n.name)
          )
          if (!unclassifiedNode) {
            unclassifiedNode = {
              name: UNCLASSIFIED_NAME,
              parent: null,
              subdirectories: [],
              files: [],
              fileCount: 0,
              totalSize: 0
            }
            newTree.push(unclassifiedNode)
          }

          const existingKeys = new Set((unclassifiedNode.files || []).map(f => getFileUniqueKey(f)))
          const toAppend = formattedDeletedFiles.filter(f => !existingKeys.has(getFileUniqueKey(f)))
          unclassifiedNode.files = [...(unclassifiedNode.files || []), ...toAppend]
          unclassifiedNode.fileCount = unclassifiedNode.files.length
        }

        return recalculateNodeFileCounts(newTree)
      }

      let updatedTree: VirtualDirectoryNode[] = []
      setDraftTree(prev => {
        const res = removeAndMoveToUnclassified(prev)
        updatedTree = res
        return res
      })
      setFinalTree(prev => removeAndMoveToUnclassified(prev))

      // 3. 在增量整理模式下，将已被删除目录中的文件全量推入 incrementalFiles，保证未归类文件列表中包含这些文件
      if (formattedDeletedFiles.length > 0) {
        setIncrementalFiles(prev => {
          const prevKeys = new Set((prev || []).map(f => getFileUniqueKey(f)))
          const toAdd = formattedDeletedFiles.filter(f => !prevKeys.has(getFileUniqueKey(f)))
          return [...(prev || []), ...toAdd]
        })

        const targetVDirId = incrementalVdId || currentVDir?.id
        if (targetVDirId && updatedTree.length > 0) {
          try {
            await window.electronAPI!.virtualDirectory.syncIncrementalDirectoryTree(
              targetVDirId,
              updatedTree
            )
            window.dispatchEvent(
              new CustomEvent('vdir:incremental-updated', { detail: { vdirId: targetVDirId } })
            )
          } catch (err: any) {
            logger.warn(LogCategory.FILE_ORGANIZATION, '删除目录同步写盘失败:', err)
            if (err?.message?.includes('does not exist')) {
              setIncrementalVdId(null)
              setCurrentVDir(null)
            }
          }
        }

        toast.success(
          t('已删除目录「{name}」，包含的文件已移至未归类', { name: dirName || nodeKey })
        )
      } else {
        const targetVDirId = incrementalVdId || currentVDir?.id
        if (targetVDirId && updatedTree.length > 0) {
          try {
            await window.electronAPI!.virtualDirectory.syncIncrementalDirectoryTree(
              targetVDirId,
              updatedTree
            )
            window.dispatchEvent(
              new CustomEvent('vdir:incremental-updated', { detail: { vdirId: targetVDirId } })
            )
          } catch (err: any) {
            logger.warn(LogCategory.FILE_ORGANIZATION, '删除空目录同步写盘失败:', err)
            if (err?.message?.includes('does not exist')) {
              setIncrementalVdId(null)
              setCurrentVDir(null)
            }
          }
        }
        toast.success(t('已删除空目录「{name}」', { name: dirName || nodeKey }))
      }
    },
    [
      stage,
      draftTree,
      finalTree,
      allWorkspaceFiles,
      extractSubtreeFiles,
      incrementalVdId,
      currentVDir?.id
    ]
  )

  const requestDeleteTreeNode = useCallback(
    (nodeKey: string) => {
      if (!nodeKey) return
      const parts = nodeKey.split('/')
      const dirName = parts[parts.length - 1] || nodeKey

      const checkContainsFiles = (
        nodes: VirtualDirectoryNode[],
        pathSegments: string[]
      ): boolean => {
        if (pathSegments.length === 0) return false
        const [targetName, ...remainingSegments] = pathSegments
        for (const node of nodes) {
          const nodeName = sanitizeDirectoryName(node.name)
          if (nodeName === targetName) {
            if (remainingSegments.length === 0) {
              return extractSubtreeFiles(node).length > 0
            }
            return checkContainsFiles(node.subdirectories || [], remainingSegments)
          }
        }
        return false
      }

      const currentActiveTree = stage === 'structure' ? draftTree : finalTree
      const containsFiles = checkContainsFiles(currentActiveTree, parts)

      if (!containsFiles) {
        // 空目录：直接删除，不弹出 confirm 对话框
        executeDeleteTreeNode(nodeKey, dirName)
      } else {
        // 包含文件：弹出二次确认 confirm 对话框
        setDeleteConfirmNodeKey(nodeKey)
        setDeleteConfirmNodeName(dirName)
      }
    },
    [draftTree, finalTree, stage, extractSubtreeFiles, executeDeleteTreeNode]
  )

  const cancelDeleteTreeNode = useCallback(() => {
    setDeleteConfirmNodeKey(null)
    setDeleteConfirmNodeName('')
  }, [])

  const confirmDeleteTreeNode = useCallback(async () => {
    if (!deleteConfirmNodeKey) return
    const nodeKey = deleteConfirmNodeKey
    const dirName = deleteConfirmNodeName
    setDeleteConfirmNodeKey(null)
    setDeleteConfirmNodeName('')

    await executeDeleteTreeNode(nodeKey, dirName)
  }, [deleteConfirmNodeKey, deleteConfirmNodeName, executeDeleteTreeNode])

  // ─── 拖拽移动节点或文件 ──────────────────────────────────────────────────────────
  const handleMoveNodeOrFile = useCallback(
    async (draggedData: any, targetNodeKey: string) => {
      if (!draggedData || !targetNodeKey) return
      const targetPathParts = targetNodeKey.split('/')

      // 1. 拖拽的是物理文件 (type === 'file')
      if (draggedData.type === 'file' || draggedData.file) {
        const fileObj = draggedData.file || draggedData
        const fileKey = getFileUniqueKey(fileObj)
        if (!fileKey) return

        const moveFileInTree = (nodes: VirtualDirectoryNode[]): VirtualDirectoryNode[] => {
          let extractedFile: any = null

          const removeFile = (list: VirtualDirectoryNode[]): VirtualDirectoryNode[] => {
            return list.map(node => {
              let files = node.files || []
              const matched = files.find(f => getFileUniqueKey(f) === fileKey)
              if (matched) {
                extractedFile = matched
                files = files.filter(f => getFileUniqueKey(f) !== fileKey)
              }
              return {
                ...node,
                files,
                fileCount: files.length,
                subdirectories: removeFile(node.subdirectories || [])
              }
            })
          }

          const cleanedTree = removeFile(nodes)
          const targetFile = extractedFile || fileObj

          const appendFileToTarget = (
            list: VirtualDirectoryNode[],
            segments: string[]
          ): VirtualDirectoryNode[] => {
            if (segments.length === 0) return list
            const [tName, ...rest] = segments

            return list.map(node => {
              const nName = sanitizeDirectoryName(node.name)
              if (nName !== tName) return node
              if (rest.length === 0) {
                const currentFiles = node.files || []
                const exists = currentFiles.some(f => getFileUniqueKey(f) === fileKey)
                const updatedFiles = exists
                  ? currentFiles
                  : [...currentFiles, { ...targetFile, isUnclassified: false }]
                return {
                  ...node,
                  files: updatedFiles,
                  fileCount: updatedFiles.length
                }
              }
              return {
                ...node,
                subdirectories: appendFileToTarget(node.subdirectories || [], rest)
              }
            })
          }

          const resTree = appendFileToTarget(cleanedTree, targetPathParts)
          return recalculateNodeFileCounts(resTree)
        }

        let updatedTree: VirtualDirectoryNode[] = []
        setDraftTree(prev => {
          const res = moveFileInTree(prev)
          updatedTree = res
          return res
        })
        setFinalTree(prev => moveFileInTree(prev))

        const targetVDirId = incrementalVdId || currentVDir?.id
        if (targetVDirId && updatedTree.length > 0) {
          try {
            await window.electronAPI!.virtualDirectory.syncIncrementalDirectoryTree(
              targetVDirId,
              updatedTree
            )
            window.dispatchEvent(
              new CustomEvent('vdir:incremental-updated', { detail: { vdirId: targetVDirId } })
            )
          } catch (err: any) {
            logger.warn(LogCategory.FILE_ORGANIZATION, '文件拖拽同步写盘失败:', err)
            if (err?.message?.includes('does not exist')) {
              setIncrementalVdId(null)
              setCurrentVDir(null)
            }
          }
        }

        toast.success(
          t('已移动文件至「{target}」', {
            target: targetPathParts[targetPathParts.length - 1] || targetNodeKey
          })
        )
        return
      }

      // 2. 拖拽的是目录节点 (type === 'dir' 或包含 nodeKey)
      const sourceNodeKey = draggedData.nodeKey || draggedData.key
      if (!sourceNodeKey || sourceNodeKey === targetNodeKey) return
      if (targetNodeKey.startsWith(`${sourceNodeKey}/`)) {
        toast.warning(t('不能将父目录拖放到其子目录中'))
        return
      }

      const sourcePathParts = sourceNodeKey.split('/')
      let movedDirectoryNode: VirtualDirectoryNode | null = null

      const moveDirInTree = (nodes: VirtualDirectoryNode[]): VirtualDirectoryNode[] => {
        const removeDir = (
          list: VirtualDirectoryNode[],
          segments: string[]
        ): VirtualDirectoryNode[] => {
          if (segments.length === 0) return list
          const [sName, ...rest] = segments
          return list
            .filter(node => {
              const nName = sanitizeDirectoryName(node.name)
              if (nName !== sName) return true
              if (rest.length === 0) {
                movedDirectoryNode = node
                return false
              }
              return true
            })
            .map(node => {
              const nName = sanitizeDirectoryName(node.name)
              if (nName !== sName) return node
              return {
                ...node,
                subdirectories: removeDir(node.subdirectories || [], rest)
              }
            })
        }

        const cleanedTree = removeDir(nodes, sourcePathParts)
        if (!movedDirectoryNode) return nodes

        const appendDirToTarget = (
          list: VirtualDirectoryNode[],
          segments: string[]
        ): VirtualDirectoryNode[] => {
          if (segments.length === 0) return list
          const [tName, ...rest] = segments
          return list.map(node => {
            const nName = sanitizeDirectoryName(node.name)
            if (nName !== tName) return node
            if (rest.length === 0) {
              const currentSubdirs = node.subdirectories || []
              const exists = currentSubdirs.some(
                s =>
                  sanitizeDirectoryName(s.name) ===
                  sanitizeDirectoryName((movedDirectoryNode as any).name)
              )
              const updatedSubdirs = exists
                ? currentSubdirs
                : [...currentSubdirs, movedDirectoryNode!]
              return {
                ...node,
                subdirectories: updatedSubdirs
              }
            }
            return {
              ...node,
              subdirectories: appendDirToTarget(node.subdirectories || [], rest)
            }
          })
        }

        const resTree = appendDirToTarget(cleanedTree, targetPathParts)
        return recalculateNodeFileCounts(resTree)
      }

      let updatedTree: VirtualDirectoryNode[] = []
      setDraftTree(prev => {
        const res = moveDirInTree(prev)
        updatedTree = res
        return res
      })
      setFinalTree(prev => moveDirInTree(prev))

      const targetVDirId = incrementalVdId || currentVDir?.id
      if (targetVDirId && updatedTree.length > 0) {
        try {
          await window.electronAPI!.virtualDirectory.syncIncrementalDirectoryTree(
            targetVDirId,
            updatedTree
          )
          window.dispatchEvent(
            new CustomEvent('vdir:incremental-updated', { detail: { vdirId: targetVDirId } })
          )
        } catch (err: any) {
          logger.warn(LogCategory.FILE_ORGANIZATION, '目录拖拽同步写盘失败:', err)
          if (err?.message?.includes('does not exist')) {
            setIncrementalVdId(null)
            setCurrentVDir(null)
          }
        }
      }

      toast.success(
        t('已将目录「{source}」放入「{target}」', {
          source: sourcePathParts[sourcePathParts.length - 1],
          target: targetPathParts[targetPathParts.length - 1]
        })
      )
    },
    [incrementalVdId, currentVDir?.id]
  )

  return {
    deleteConfirmNodeKey,
    deleteConfirmNodeName,
    handleRenameTreeNode,
    handleAddSubdirTreeNode,
    requestDeleteTreeNode,
    executeDeleteTreeNode,
    cancelDeleteTreeNode,
    confirmDeleteTreeNode,
    handleMoveNodeOrFile
  }
}
