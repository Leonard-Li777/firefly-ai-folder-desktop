import { VirtualDirectoryNode } from '@firefly/types'
import { SENTINEL_NAMES } from '@firefly/shared'
import { isUnclassifiedNodeName } from './helpers'

export interface FilePathMatchItem {
  path: string
  score: number
}

export interface ReshapeOptions {
  baseTreeOutline: VirtualDirectoryNode[]
  rawMatches: Record<number | string, FilePathMatchItem[]>
  filesMap: Record<number | string, any>
  y: number // 及格线阈值 [0.40, 0.90]，默认 0.60
  n: number // 多目录归属上限 [1, 5]，默认 1
  userPinnedFileMap?: Map<number | string, string[]> // 用户手动微调指定路径映射（锁定保护）
}

export interface ReshapeResult {
  tree: VirtualDirectoryNode[]
  unclassifiedCount: number
}

/** 路径规范化函数：统一转为斜杠并去除首尾空斜杠 */
function normalizePathKey(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim()
}

/** 纯前端内存重塑算法：毫秒级根据及格线 y 与归属上限 n 重新组织目录树 */
export function reshapeDirectoryTree(options: ReshapeOptions): ReshapeResult {
  const {
    baseTreeOutline,
    rawMatches = {},
    filesMap = {},
    y = 0.6,
    n = 1,
    userPinnedFileMap
  } = options

  // 1. 约束 y 与 n 在合法区间
  const clampedY = Math.max(0.4, Math.min(0.9, y))
  const clampedN = Math.max(1, Math.min(5, Math.floor(n)))

  // 2. 深拷贝结构树（排除原有的未归类节点，清空所有 files）
  const cloneOutline = (nodes: VirtualDirectoryNode[], parentKey = ''): VirtualDirectoryNode[] => {
    if (!Array.isArray(nodes)) return []
    return nodes
      .filter(node => !isUnclassifiedNodeName(node.name))
      .map(node => {
        const currentPath = parentKey ? `${parentKey}/${node.name}` : node.name
        return {
          ...node,
          files: [],
          fileCount: 0,
          totalSize: 0,
          subdirectories: cloneOutline(node.subdirectories || [], currentPath)
        }
      })
  }

  const tree = cloneOutline(baseTreeOutline)

  // 3. 构建路径到节点的快速查找索引表 (Map<normalizedPath, VirtualDirectoryNode>)
  const nodePathMap = new Map<string, VirtualDirectoryNode>()

  const indexNodes = (nodes: VirtualDirectoryNode[], parentPath = '') => {
    for (const node of nodes) {
      const currentPath = parentPath ? `${parentPath}/${node.name}` : node.name
      const normalizedKey = normalizePathKey(currentPath)
      nodePathMap.set(normalizedKey, node)

      // 同时建立单级叶节点名回退索引（以便匹配扁平路径）
      if (!nodePathMap.has(node.name)) {
        nodePathMap.set(node.name, node)
      }

      if (node.subdirectories && node.subdirectories.length > 0) {
        indexNodes(node.subdirectories, currentPath)
      }
    }
  }
  indexNodes(tree)

  // 4. 初始化未归类节点
  const unclassifiedNode: VirtualDirectoryNode = {
    name: SENTINEL_NAMES.UNCLASSIFIED,
    parent: null,
    subdirectories: [],
    files: [],
    fileCount: 0,
    totalSize: 0
  }

  // 5. 遍历待整理文件集合，根据打分与保护策略分派
  const allFileKeys = Object.keys(filesMap)

  for (const fileKey of allFileKeys) {
    const file = filesMap[fileKey]
    if (!file) continue

    const fileIdNum = Number(fileKey)
    const fileIdStr = String(fileKey)

    // 5.1 检查是否被用户在 UI 上手动微调过（Pinned 锁定保护）
    const pinnedPaths =
      userPinnedFileMap?.get(fileKey) ||
      (Number.isFinite(fileIdNum) ? userPinnedFileMap?.get(fileIdNum) : undefined) ||
      userPinnedFileMap?.get(fileIdStr)

    if (pinnedPaths && pinnedPaths.length > 0) {
      for (const p of pinnedPaths) {
        const normalized = normalizePathKey(p)
        const targetNode = nodePathMap.get(normalized) || nodePathMap.get(p)
        if (targetNode) {
          targetNode.files.push(file)
        } else {
          unclassifiedNode.files.push(file)
        }
      }
      continue
    }

    // 5.2 获取该文件的候选路径余弦匹配得分
    const matches: FilePathMatchItem[] =
      rawMatches[fileKey] ||
      (Number.isFinite(fileIdNum) ? rawMatches[fileIdNum] : undefined) ||
      rawMatches[fileIdStr] ||
      []

    // 5.3 过滤满足及格线的分支 (score >= y)
    const passed = matches.filter(m => m.score >= clampedY)

    if (passed.length === 0) {
      // 不及格：收拢至未归类节点
      unclassifiedNode.files.push(file)
      continue
    }

    // 5.4 截取最多 n 个多归属候选路径
    // 如果 matches 尚未排序，先按 score 降序排
    const sortedPassed = passed.slice().sort((a, b) => b.score - a.score)
    const topCandidates = sortedPassed.slice(0, clampedN)

    // 5.5 挂载到胜出节点
    for (const cp of topCandidates) {
      const normalized = normalizePathKey(cp.path)
      const targetNode = nodePathMap.get(normalized) || nodePathMap.get(cp.path)
      if (targetNode) {
        targetNode.files.push(file)
      } else {
        unclassifiedNode.files.push(file)
      }
    }
  }

  // 6. 递归重算整棵分类树节点的 fileCount 与 totalSize
  const computeCounts = (node: VirtualDirectoryNode): { count: number; size: number } => {
    let count = node.files.length
    let size = node.files.reduce((acc, f) => acc + (f.size || 0), 0)

    for (const sub of node.subdirectories || []) {
      const subResult = computeCounts(sub)
      count += subResult.count
      size += subResult.size
    }

    node.fileCount = count
    node.totalSize = size
    return { count, size }
  }

  for (const root of tree) {
    computeCounts(root)
  }

  // 7. 处理未归类节点
  unclassifiedNode.fileCount = unclassifiedNode.files.length
  unclassifiedNode.totalSize = unclassifiedNode.files.reduce((acc, f) => acc + (f.size || 0), 0)

  if (unclassifiedNode.files.length > 0) {
    tree.push(unclassifiedNode)
  }

  return {
    tree,
    unclassifiedCount: unclassifiedNode.files.length
  }
}
