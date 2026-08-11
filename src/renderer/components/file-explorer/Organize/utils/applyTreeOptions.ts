import { VirtualDirectoryNode } from '@firefly/types'

function cloneTree(nodes: VirtualDirectoryNode[]): VirtualDirectoryNode[] {
  return nodes.map(node => ({
    ...node,
    subdirectories: cloneTree(node.subdirectories),
    files: [...node.files]
  }))
}

export function applyTreeOptions(
  tree: VirtualDirectoryNode[],
  options: {
    flattenToRoot: boolean
    flattenDirectories: boolean
    skipEmptyDirectories: boolean
    deduplicateFiles: boolean
  },
  isManualMode: boolean
): { result: VirtualDirectoryNode[]; stats: { dedupedCount: number; skippedEmptyCount: number } } {
  let result = cloneTree(tree)
  let dedupedCount = 0
  let skippedEmptyCount = 0

  if (options.flattenToRoot) {
    const allFiles: any[] = []
    const collectFiles = (nodes: VirtualDirectoryNode[]) => {
      for (const node of nodes) {
        allFiles.push(...node.files)
        collectFiles(node.subdirectories)
      }
    }
    collectFiles(result)
    result = [
      {
        name: 'root',
        parent: null,
        subdirectories: [],
        files: allFiles,
        fileCount: allFiles.length,
        totalSize: allFiles.reduce((sum, f) => sum + (f.size || 0), 0)
      }
    ]
  } else if (options.flattenDirectories) {
    const flatten = (nodes: VirtualDirectoryNode[]): VirtualDirectoryNode[] => {
      const flatNodes: VirtualDirectoryNode[] = []
      for (const node of nodes) {
        const flatNode: VirtualDirectoryNode = {
          name: node.name,
          parent: null,
          subdirectories: [],
          files: [...node.files],
          fileCount: node.files.length,
          totalSize: node.files.reduce((sum: number, f: any) => sum + (f.size || 0), 0)
        }
        flatNodes.push(flatNode)
        if (node.subdirectories.length > 0) {
          flatNodes.push(...flatten(node.subdirectories))
        }
      }
      return flatNodes
    }
    result = flatten(result)
  }

  if (options.deduplicateFiles) {
    const seen = new Set<string>()
    const dedupe = (nodes: VirtualDirectoryNode[]) => {
      for (const node of nodes) {
        node.files = node.files.filter(f => {
          if (seen.has(f.fileFingerprint)) {
            dedupedCount++
            return false
          }
          seen.add(f.fileFingerprint)
          return true
        })
        node.fileCount = node.files.length
        node.totalSize = node.files.reduce((sum, f) => sum + (f.size || 0), 0)
        dedupe(node.subdirectories)
      }
    }
    dedupe(result)
  }

  if (options.skipEmptyDirectories) {
    const removeEmpty = (nodes: VirtualDirectoryNode[]): VirtualDirectoryNode[] => {
      return nodes.filter(node => {
        node.subdirectories = removeEmpty(node.subdirectories)
        const isEmpty =
          node.files.length === 0 && node.subdirectories.length === 0 && node.fileCount === 0
        if (isEmpty) skippedEmptyCount++
        return !isEmpty
      })
    }
    result = removeEmpty(result)
  }

  return { result, stats: { dedupedCount, skippedEmptyCount } }
}
