import { VirtualDirectoryNode } from '@firefly/types'

/**
 * 将规范相对路径数组转换为 VirtualDirectoryNode[] 嵌套树
 * 例如：['01_需求/PRD', '02_设计/高保真']
 */
export function pathsToDirectoryNodes(paths: string[]): VirtualDirectoryNode[] {
  interface TempNode {
    name: string
    parentKey?: string
    subMap: Map<string, TempNode>
  }

  const rootMap = new Map<string, TempNode>()

  for (const rawPath of paths) {
    const segments = rawPath.replace(/\\/g, '/').split('/').filter(Boolean)
    if (segments.length === 0) continue

    let parentKey = ''
    let currentMap = rootMap

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      const nodeKey = parentKey ? `${parentKey}/${seg}` : seg
      let node = currentMap.get(seg)
      if (!node) {
        node = {
          name: seg,
          parentKey: parentKey || undefined,
          subMap: new Map()
        }
        currentMap.set(seg, node)
      }
      parentKey = nodeKey
      currentMap = node.subMap
    }
  }

  const convertToNodes = (map: Map<string, TempNode>): VirtualDirectoryNode[] => {
    return Array.from(map.values()).map(temp => ({
      name: temp.name,
      parent: temp.parentKey || null,
      parentKey: temp.parentKey,
      files: [],
      fileCount: 0,
      totalSize: 0,
      subdirectories: temp.subMap.size > 0 ? convertToNodes(temp.subMap) : []
    }))
  }

  return convertToNodes(rootMap)
}
