import { VirtualDirectoryNode } from '@firefly/types'
import { SENTINEL_NAMES } from '@firefly/shared'

export interface UserAddedDirectoryItem {
  parentKey: string
  name: string
  node: VirtualDirectoryNode
}

export interface UserMovedFileItem {
  file: any
  targetNodeKey: string
}

export interface UserCustomizations {
  addedNodes?: UserAddedDirectoryItem[]
  deletedNodeKeys?: Set<string>
  renamedNodes?: Map<string, string> // originalKey -> newName
  pinnedFiles?: Map<string, UserMovedFileItem> // fileUniqueKey -> item
}

/** 辅助函数：根据节点与父路径计算唯一路径 key */
export function getNodeKey(node: VirtualDirectoryNode, parentKey = ''): string {
  if (node.id) return String(node.id)
  const p = parentKey || node.parent
  return p ? `${p}/${node.name}` : node.name
}

/** 辅助函数：提取文件全局唯一 ID（防止同名跨目录文件误杀蒸发，保持原生路径分隔符） */
export function getFileUniqueId(file: any): string {
  if (!file) return ''
  return String(
    file.fileId ??
    file.id ??
    file.fileFingerprint ??
    file.filePath ??
    file.path ??
    file.relativePath ??
    (file.parentPath ? `${file.parentPath}/${file.name}` : file.name)
  )
}

/** 递归提取子树下的所有文件 */
export function extractSubtreeFiles(node: VirtualDirectoryNode): any[] {
  const files: any[] = [...(node.files || [])]
  if (node.subdirectories && node.subdirectories.length > 0) {
    for (const sub of node.subdirectories) {
      files.push(...extractSubtreeFiles(sub))
    }
  }
  return files
}

/** 深拷贝目录树节点 */
export function cloneTree(nodes: VirtualDirectoryNode[], parentKey: string | null = null): VirtualDirectoryNode[] {
  if (!Array.isArray(nodes)) return []
  return nodes.map(node => {
    const curKey = parentKey ? `${parentKey}/${node.name}` : node.name
    return {
      ...node,
      parent: parentKey,
      files: Array.isArray(node.files) ? [...node.files] : [],
      subdirectories: cloneTree(node.subdirectories || [], curKey)
    }
  })
}

/** 递归自底向上重算 fileCount 与 totalSize */
export function recomputeTreeCounts(nodes: VirtualDirectoryNode[]): VirtualDirectoryNode[] {
  return nodes.map(node => {
    const subdirs = recomputeTreeCounts(node.subdirectories || [])
    const files = node.files || []
    const directSize = files.reduce((sum, f) => sum + (f.size || 0), 0)
    const subSize = subdirs.reduce((sum, s) => sum + (s.totalSize || 0), 0)
    const fileCount = files.length + subdirs.reduce((sum, s) => sum + (s.fileCount || 0), 0)
    const totalSize = directSize + subSize
    return {
      ...node,
      files,
      subdirectories: subdirs,
      fileCount,
      totalSize
    }
  })
}

/**
 * 聚类重算结果与用户手动微调确定性融合算法 (Reconcile Clustering with User Edits)
 * 无论用户增、删、改（重命名/移动文件），聚类重新计算时均保留并应用用户的修改成果：
 * 1. 应用重命名 (Renames)：保留用户给目录修改的规范名称，支持双轨 rawKey 与 effectiveKey 级联
 * 2. 应用删除 (Deletions)：被用户删除的目录不复活，其名下归类文件收拢至未归类节点
 * 3. 应用新增 (Additions)：挂载干净的空骨架结构（files: []），由阶段 4 统一精准注入锁定文件
 * 4. 应用文件移动 (Pinned Files)：用户手动拖拽的文件锁定在目标目录并注入 isPinned: true，其余文件按聚类填充
 * 5. 孤立文件回收 (Orphans to Unclassified)：未收纳文件统一归入 SENTINEL_NAMES.UNCLASSIFIED
 * 6. 自底向上重新计算容量指标
 */
export function reconcileClusteringWithUserEdits(
  incomingNodes: VirtualDirectoryNode[],
  customizations?: UserCustomizations
): VirtualDirectoryNode[] {
  if (!customizations) {
    return incomingNodes || []
  }

  const {
    addedNodes = [],
    deletedNodeKeys = new Set<string>(),
    renamedNodes = new Map<string, string>(),
    pinnedFiles = new Map<string, UserMovedFileItem>()
  } = customizations

  // 如果没有任何自定义操作，直接返回克隆树
  if (
    addedNodes.length === 0 &&
    deletedNodeKeys.size === 0 &&
    renamedNodes.size === 0 &&
    pinnedFiles.size === 0
  ) {
    return cloneTree(incomingNodes || [])
  }

  let tree = cloneTree(incomingNodes || [])
  const orphanFiles: any[] = []

  // ─── 步骤 1：应用重命名（维护 rawKey 与 effectiveKey 双轨路径，支持级联与连续改名） ─────
  const applyRenames = (
    nodes: VirtualDirectoryNode[],
    rawParentKey = '',
    effectiveParentKey = ''
  ): VirtualDirectoryNode[] => {
    return nodes.map(node => {
      const rawKey = rawParentKey ? `${rawParentKey}/${node.name}` : node.name
      let currentName = node.name
      if (renamedNodes.has(rawKey)) {
        currentName = renamedNodes.get(rawKey)!
      } else if (renamedNodes.has(node.name)) {
        currentName = renamedNodes.get(node.name)!
      }
      const newEffectiveKey = effectiveParentKey ? `${effectiveParentKey}/${currentName}` : currentName
      return {
        ...node,
        name: currentName,
        parent: effectiveParentKey || null,
        subdirectories: applyRenames(node.subdirectories || [], rawKey, newEffectiveKey)
      }
    })
  }
  tree = applyRenames(tree)

  // ─── 步骤 2：应用删除并回收孤立文件 ─────────────────────────────────────────
  const applyDeletions = (nodes: VirtualDirectoryNode[], parentKey = ''): VirtualDirectoryNode[] => {
    const remaining: VirtualDirectoryNode[] = []
    for (const node of nodes) {
      const curKey = parentKey ? `${parentKey}/${node.name}` : node.name
      if (deletedNodeKeys.has(curKey) || deletedNodeKeys.has(node.name)) {
        orphanFiles.push(...extractSubtreeFiles(node))
      } else {
        remaining.push({
          ...node,
          subdirectories: applyDeletions(node.subdirectories || [], curKey)
        })
      }
    }
    return remaining
  }
  tree = applyDeletions(tree)

  // ─── 步骤 3：应用用户新增目录（强制空骨架 files: []，防脏快照双写） ───────────
  for (const item of addedNodes) {
    const cleanItemName = item.name.trim()
    if (!cleanItemName) continue

    if (!item.parentKey) {
      // 根目录添加
      const exists = tree.some(n => n.name === cleanItemName)
      if (!exists) {
        tree.push({
          ...item.node,
          name: cleanItemName,
          parent: null,
          files: [],
          subdirectories: []
        })
      }
    } else {
      // 子目录添加：查找目标父节点（支持原 parentKey 或已重命名后的 parentKey）
      let inserted = false
      const insertChild = (nodes: VirtualDirectoryNode[], currentParentKey = ''): VirtualDirectoryNode[] => {
        return nodes.map(node => {
          const curKey = currentParentKey ? `${currentParentKey}/${node.name}` : node.name
          if (curKey === item.parentKey || node.name === item.parentKey) {
            const subdirs = node.subdirectories || []
            if (!subdirs.some(s => s.name === cleanItemName)) {
              inserted = true
              return {
                ...node,
                subdirectories: [
                  ...subdirs,
                  {
                    ...item.node,
                    name: cleanItemName,
                    parent: curKey,
                    files: [],
                    subdirectories: []
                  }
                ]
              }
            }
          }
          if (node.subdirectories && node.subdirectories.length > 0) {
            return {
              ...node,
              subdirectories: insertChild(node.subdirectories, curKey)
            }
          }
          return node
        })
      }

      tree = insertChild(tree)

      // 若未找到父节点（如聚类参数导致旧父节点被合并或消失），提升为根节点防止目录丢失
      if (!inserted && !tree.some(n => n.name === cleanItemName)) {
        tree.push({
          ...item.node,
          name: cleanItemName,
          parent: null,
          files: [],
          subdirectories: []
        })
      }
    }
  }

  // ─── 步骤 4：应用锁定移动的文件 (Pinned Files) ──────────────────────────────
  if (pinnedFiles.size > 0) {
    // 4.1 从所有节点中剥离被锁定的文件（防文件在 AI 聚类与用户锁定目标间双写）
    const removePinned = (nodes: VirtualDirectoryNode[]): VirtualDirectoryNode[] => {
      return nodes.map(node => ({
        ...node,
        files: (node.files || []).filter(f => !pinnedFiles.has(getFileUniqueId(f))),
        subdirectories: removePinned(node.subdirectories || [])
      }))
    }
    tree = removePinned(tree)

    // 4.2 将锁定的文件定向注入至目标目录并标记 isPinned: true
    for (const [fileId, { file, targetNodeKey }] of pinnedFiles.entries()) {
      let placed = false
      const placeFile = (nodes: VirtualDirectoryNode[], parentKey = ''): VirtualDirectoryNode[] => {
        return nodes.map(node => {
          const curKey = parentKey ? `${parentKey}/${node.name}` : node.name
          if (curKey === targetNodeKey || node.name === targetNodeKey) {
            placed = true
            const currentFiles = node.files || []
            const exists = currentFiles.some(f => getFileUniqueId(f) === fileId)
            const pinnedFileObj = { ...file, isPinned: true }
            return {
              ...node,
              files: exists
                ? currentFiles.map(f => getFileUniqueId(f) === fileId ? { ...f, isPinned: true } : f)
                : [...currentFiles, pinnedFileObj]
            }
          }
          if (node.subdirectories && node.subdirectories.length > 0) {
            return {
              ...node,
              subdirectories: placeFile(node.subdirectories, curKey)
            }
          }
          return node
        })
      }

      tree = placeFile(tree)
      if (!placed) {
        orphanFiles.push({ ...file, isPinned: true })
      }
    }
  }

  // ─── 步骤 5：将删除节点产生的孤立文件汇入“未归类” ─────────────────────────────
  if (orphanFiles.length > 0) {
    // 过滤掉已在有效节点中的文件
    const assignedIds = new Set<string>()
    const collectAssigned = (nodes: VirtualDirectoryNode[]) => {
      for (const node of nodes) {
        for (const f of node.files || []) {
          assignedIds.add(getFileUniqueId(f))
        }
        if (node.subdirectories) collectAssigned(node.subdirectories)
      }
    }
    collectAssigned(tree)

    const unassignedOrphans = orphanFiles.filter(f => !assignedIds.has(getFileUniqueId(f)))

    if (unassignedOrphans.length > 0) {
      let unclassifiedFound = false
      const attachToUnclassified = (nodes: VirtualDirectoryNode[]): VirtualDirectoryNode[] => {
        return nodes.map(node => {
          if (node.name === SENTINEL_NAMES.UNCLASSIFIED || (node as any).isUnclassified) {
            unclassifiedFound = true
            const existing = node.files || []
            const newFiles = [...existing]
            for (const orph of unassignedOrphans) {
              if (!newFiles.some(f => getFileUniqueId(f) === getFileUniqueId(orph))) {
                newFiles.push(orph)
              }
            }
            return { ...node, files: newFiles }
          }
          if (node.subdirectories && node.subdirectories.length > 0) {
            return { ...node, subdirectories: attachToUnclassified(node.subdirectories) }
          }
          return node
        })
      }

      tree = attachToUnclassified(tree)

      if (!unclassifiedFound) {
        const unclassifiedNode: any = {
          name: SENTINEL_NAMES.UNCLASSIFIED,
          isUnclassified: true,
          parent: null,
          files: unassignedOrphans,
          subdirectories: [],
          fileCount: unassignedOrphans.length,
          totalSize: unassignedOrphans.reduce((sum, f) => sum + (f.size || 0), 0)
        }
        tree.push(unclassifiedNode)
      }
    }
  }

  // ─── 步骤 6：自底向上重算全量节点文件数与大小 ────────────────────────────────
  return recomputeTreeCounts(tree)
}
