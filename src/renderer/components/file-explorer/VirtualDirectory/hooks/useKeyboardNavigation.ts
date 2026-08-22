import React, { useMemo, useCallback } from 'react'
import { getFileNameFromPath } from '@firefly/shared'
import { VirtualDirectoryNode } from '@firefly/types'
import { usePreviewOverlayStore } from '../../../../stores/preview-overlay-store'
import { PAGE_IDS } from '../../../../constants/page-ids'

interface UseKeyboardNavigationProps {
  treeData: VirtualDirectoryNode[]
  rootNode?: VirtualDirectoryNode | null
  expandedKeys: Set<string>
  activeItem: any | null
  setActiveItem: (item: any | null) => void
  setSelectedNode: (node: VirtualDirectoryNode | null) => void
  setSelectedFileListFiles: (files: any[]) => void
  fileListFiles: any[]
}

export const findParentDirectoryForFile = (
  nodes: VirtualDirectoryNode[],
  rootNode: VirtualDirectoryNode | null | undefined,
  fileNode: any
): VirtualDirectoryNode | null | 'ROOT' => {
  const isPathEqual =
    window.electronAPI?.utils?.isPathEqual ||
    ((p1: string, p2: string) => p1 === p2 || p1.replace(/\\/g, '/') === p2.replace(/\\/g, '/'))
  const filePath = fileNode.originalPath || fileNode.path
  const fileId = fileNode.fileId || fileNode.id

  if (rootNode?.rootFiles) {
    const isRootFile = rootNode.rootFiles.some((f: any) => {
      if (fileId && (f.fileId === fileId || f.id === fileId)) return true
      if (filePath && f.originalPath && isPathEqual(f.originalPath, filePath)) return true
      return false
    })
    if (isRootFile) return 'ROOT'
  }

  const searchSubdirs = (dirList: VirtualDirectoryNode[]): VirtualDirectoryNode | null => {
    for (const node of dirList) {
      if (node.files) {
        const match = node.files.some((f: any) => {
          if (fileId && (f.fileId === fileId || f.id === fileId)) return true
          if (filePath && f.originalPath && isPathEqual(f.originalPath, filePath)) return true
          return false
        })
        if (match) return node
      }
      if (node.subdirectories) {
        const found = searchSubdirs(node.subdirectories)
        if (found) return found
      }
    }
    return null
  }

  return searchSubdirs(nodes)
}

export const useKeyboardNavigation = ({
  treeData,
  rootNode,
  expandedKeys,
  activeItem,
  setActiveItem,
  setSelectedNode,
  setSelectedFileListFiles,
  fileListFiles
}: UseKeyboardNavigationProps) => {
  // 将树节点扁平化为可见的有序列表（按展开状态），用于键盘导航
  const flatVisibleNodes = useMemo(() => {
    const result: any[] = []
    const traverse = (nodes: VirtualDirectoryNode[]) => {
      for (const node of nodes) {
        result.push(node)
        const key = `dir-${node.name}`
        if (expandedKeys.has(key) && node.subdirectories) {
          traverse(node.subdirectories)
        }
        // 展开状态下也加入文件
        if (expandedKeys.has(key) && node.files) {
          for (const f of node.files) {
            result.push({
              ...f,
              isFile: true,
              name: f.smartName || getFileNameFromPath(f.originalPath) || 'unknown',
              subdirectories: [],
              files: []
            })
          }
        }
      }
    }
    traverse(treeData)
    return result
  }, [treeData, expandedKeys])

  // 树目录键盘导航处理
  const handleTreeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      if (flatVisibleNodes.length === 0) return

      e.preventDefault()

      // 找到当前 activeItem 在扁平列表中的索引
      let currentIndex = -1
      if (activeItem) {
        currentIndex = flatVisibleNodes.findIndex(node => {
          if ((node as any).isFile) {
            const isPathEqual =
              window.electronAPI?.utils?.isPathEqual ||
              ((p1: string, p2: string) =>
                p1 === p2 || p1.replace(/\\/g, '/') === p2.replace(/\\/g, '/'))
            const p1 = (node as any).originalPath
            const p2 = (activeItem as any).originalPath
            return p1 && p2 ? isPathEqual(p1, p2) : p1 === p2
          }
          return node === activeItem
        })
      }

      let nextIndex: number
      if (e.key === 'ArrowDown') {
        nextIndex = currentIndex < flatVisibleNodes.length - 1 ? currentIndex + 1 : 0
      } else {
        nextIndex = currentIndex > 0 ? currentIndex - 1 : flatVisibleNodes.length - 1
      }

      const nextNode = flatVisibleNodes[nextIndex]
      if (!nextNode) return

      if ((nextNode as any).isFile) {
        const parentRes = findParentDirectoryForFile(treeData, rootNode, nextNode)
        if (parentRes === 'ROOT') {
          setSelectedNode(null)
        } else if (parentRes) {
          setSelectedNode(parentRes)
        }

        // 优先从 fileListFiles 中找到对应的文件对象（确保有 path 属性供 FileList 使用）
        const { isPathEqual } = window.electronAPI!.utils
        const origPath = (nextNode as any).originalPath
        const matchedFile = origPath
          ? fileListFiles.find(f => f.path && isPathEqual(f.path, origPath))
          : undefined
        if (matchedFile) {
          setActiveItem(matchedFile)
          setSelectedFileListFiles([matchedFile])
        } else {
          const node = nextNode as any
          const formatted = {
            ...node,
            path: node.originalPath,
            id: node.fileId || node.file_id || node.id
          }
          setActiveItem(formatted)
          setSelectedFileListFiles([formatted])
        }
      } else {
        setActiveItem(nextNode)
        setSelectedNode(nextNode)
        setSelectedFileListFiles([])
      }

      // 分栏预览模式下，单击可预览文件则切换预览
      const splitState = usePreviewOverlayStore.getState()
      const pageMode = splitState.pageStates[PAGE_IDS.VIRTUAL_DIRECTORY]?.mode ?? 'split'
      if (pageMode === 'split' && (nextNode as any).isFile) {
        const filePath = (nextNode as any).originalPath
        if (filePath) {
          const ext = filePath.split('.').pop() || ''
          splitState.openPreview(
            filePath,
            (nextNode as any).name || (nextNode as any).smartName || '',
            ext,
            PAGE_IDS.VIRTUAL_DIRECTORY
          )
        }
      }
    },
    [
      activeItem,
      flatVisibleNodes,
      fileListFiles,
      setActiveItem,
      setSelectedNode,
      setSelectedFileListFiles
    ]
  )

  return {
    flatVisibleNodes,
    handleTreeKeyDown
  }
}
