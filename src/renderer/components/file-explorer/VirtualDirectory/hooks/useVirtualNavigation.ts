import { useMemo, useCallback } from 'react'
import { t } from '@app/languages'
import { getFileNameFromPath } from '@firefly/shared'
import { VirtualDirectory, VirtualDirectoryNode } from '@firefly/types'

interface UseVirtualNavigationProps {
  currentVD: VirtualDirectory | undefined
  treeData: VirtualDirectoryNode[]
  selectedNode: VirtualDirectoryNode | null
  setSelectedNode: (node: VirtualDirectoryNode | null) => void
  setPreviewFile: (file: any | null) => void
  setActiveItem: (item: any | null) => void
  setSelectedFileListFiles: (files: any[]) => void
}

export const useVirtualNavigation = ({
  currentVD,
  treeData,
  selectedNode,
  setSelectedNode,
  setPreviewFile,
  setActiveItem,
  setSelectedFileListFiles
}: UseVirtualNavigationProps) => {
  // 寻路逻辑：查找 selectedNode 在 tree 中的祖先路径链
  const selectedNodePathChain = useMemo(() => {
    if (!selectedNode || treeData.length === 0) return []

    const findChain = (
      nodes: VirtualDirectoryNode[],
      target: VirtualDirectoryNode,
      current: VirtualDirectoryNode[] = []
    ): VirtualDirectoryNode[] | null => {
      for (const node of nodes) {
        const next = [...current, node]
        if (node === target) return next
        if (node.subdirectories && node.subdirectories.length > 0) {
          const res = findChain(node.subdirectories, target, next)
          if (res) return res
        }
      }
      return null
    }

    return findChain(treeData, selectedNode) || []
  }, [treeData, selectedNode])

  const virtualBasePath = useMemo(() => currentVD?.name || t('全部文件'), [currentVD])

  const virtualCurrentPath = useMemo(() => {
    const sep = window.electronAPI!.utils.getPlatform?.() === 'win32' ? '\\' : '/'
    const pathNames = [virtualBasePath, ...selectedNodePathChain.map(n => n.name)]
    return pathNames.join(sep)
  }, [virtualBasePath, selectedNodePathChain])

  // 虚拟路径导航定位处理器
  const handleVirtualNavigate = useCallback(
    (path: string) => {
      const sep = window.electronAPI!.utils.getPlatform?.() === 'win32' ? '\\' : '/'
      const rootName = virtualBasePath

      if (path === rootName) {
        setSelectedNode(null)
        setPreviewFile(null)
        setActiveItem(null)
        setSelectedFileListFiles([])
        return
      }

      // 去掉前缀并拆分
      const relativePart = path.startsWith(rootName + sep)
        ? path.substring(rootName.length + 1)
        : path.substring(rootName.length)

      const parts = relativePart.split(sep).filter(Boolean)
      if (parts.length === 0) return

      // 在 treeData 中顺藤摸瓜寻找目标
      let currentNodeList = treeData
      let matchedNode: VirtualDirectoryNode | null = null
      let matchedFile: any = null

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]

        // 尝试匹配目录
        const foundNode = currentNodeList.find(n => n.name === part)
        if (foundNode) {
          matchedNode = foundNode
          currentNodeList = foundNode.subdirectories || []
        } else {
          // 如果是最后一位，且没找到目录，尝试匹配文件
          if (matchedNode) {
            const foundFile = matchedNode.files?.find(
              f => (f.smartName || f.name || getFileNameFromPath(f.originalPath)) === part
            )
            if (foundFile) {
              matchedFile = {
                ...foundFile,
                isFile: true,
                name:
                  foundFile.smartName ||
                  foundFile.name ||
                  getFileNameFromPath(foundFile.originalPath) ||
                  'unknown'
              }
            }
          }
          break
        }
      }

      if (matchedFile) {
        setPreviewFile(matchedFile)
        setActiveItem(matchedFile)
      } else if (matchedNode) {
        setSelectedNode(matchedNode)
        setPreviewFile(null)
        setActiveItem(matchedNode)
        setSelectedFileListFiles([])
      }
    },
    [
      virtualBasePath,
      treeData,
      setSelectedNode,
      setPreviewFile,
      setActiveItem,
      setSelectedFileListFiles
    ]
  )

  return {
    selectedNodePathChain,
    virtualBasePath,
    virtualCurrentPath,
    handleVirtualNavigate
  }
}
