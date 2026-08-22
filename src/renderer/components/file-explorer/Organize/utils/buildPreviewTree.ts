import { VirtualDirectoryNode, SelectedTag, DimensionGroup } from '@firefly/types'

/**
 * 按维度层级构建预览树
 *
 * 规则：
 * 1. 基于 dimensionGroups 的 parentDimensionIds 构建维度树
 * 2. 只包含有选中标签的维度
 * 3. 父子维度关联的标签嵌套，无关联的维度独立（同级平铺）
 * 4. 子维度标签按 triggerConditions 匹配对应的父标签节点
 * 5. 文件分配：每层独立匹配，文件可出现在多个匹配标签下
 */
export function buildPreviewTree(
  selectedTags: SelectedTag[],
  dimensionGroups: DimensionGroup[],
  allFiles: any[],
  options: {
    enableNestedClassification: boolean
  }
): VirtualDirectoryNode[] {
  if (selectedTags.length === 0) return []

  // 1. 按维度分组选中标签
  const tagsByDimension: Record<number, SelectedTag[]> = {}
  selectedTags.forEach(tag => {
    const dimId = Number(tag.dimensionId)
    if (!tagsByDimension[dimId]) {
      tagsByDimension[dimId] = []
    }
    tagsByDimension[dimId].push(tag)
  })
  // 按 id 和 name 建立维度快速查找 map
  const dimGroupsById = new Map(dimensionGroups.map(g => [g.id, g]))
  const dimGroupsByName = new Map(dimensionGroups.map(g => [g.name, g]))

  const selectedDimIds = new Set(selectedTags.map(t => Number(t.dimensionId)))
  const childDimsByParent = new Map<number, DimensionGroup[]>()
  const hasActiveParent = new Set<number>()

  for (const g of dimensionGroups) {
    if (!selectedDimIds.has(g.id)) continue

    if (g.parentDimensionIds && g.parentDimensionIds.length > 0) {
      for (const pid of g.parentDimensionIds) {
        if (!selectedDimIds.has(pid)) continue

        // 检查选中的父标签是否真正触发了子维度
        const parentTags = tagsByDimension[pid] || []
        const hasMatchingTrigger = parentTags.some(pt => {
          if (!g.triggerConditions) return true
          const tc = g.triggerConditions.find((c: any) => c.parentDimension === pt.dimensionName)
          return !tc || tc.triggerTags.includes(pt.tagValue)
        })
        if (!hasMatchingTrigger) continue

        const childGroup = dimGroupsById.get(g.id)
        if (childGroup) {
          if (!childDimsByParent.has(pid)) {
            childDimsByParent.set(pid, [])
          }
          const currentChildren = childDimsByParent.get(pid)!
          if (!currentChildren.some(c => c.id === g.id)) {
            currentChildren.push(childGroup)
          }
          hasActiveParent.add(g.id)
        }
      }
    }
  }

  // 根维度 = 有选中标签但未被嵌套的维度
  const rootDimIds = Array.from(selectedDimIds).filter(id => !hasActiveParent.has(id))

  // 按 level 排序
  const sortByLevel = (ids: number[]) =>
    [...ids].sort((a, b) => {
      const groupA = dimGroupsById.get(a)
      const groupB = dimGroupsById.get(b)
      return (groupA?.level ?? 0) - (groupB?.level ?? 0)
    })

  const sortedRootIds = sortByLevel(rootDimIds)

  // 子维度有选中标签但其父维度无选中标签时，提升到根节点
  const orphanChildDimIds: number[] = []
  for (const [parentId, childDims] of childDimsByParent) {
    const parentHasSelectedTags = tagsByDimension[parentId]?.length > 0
    if (!parentHasSelectedTags) {
      orphanChildDimIds.push(...childDims.map(d => d.id))
    }
  }

  const allLevelDimIds = sortByLevel([...sortedRootIds, ...orphanChildDimIds])

  // 2. 递归构建预览树节点
  function buildNodes(
    dimIds: number[],
    parentDimensionName?: string,
    parentTagValue?: string
  ): VirtualDirectoryNode[] {
    const nodes: VirtualDirectoryNode[] = []

    for (const dimId of dimIds) {
      const group = dimGroupsById.get(dimId)
      if (!group) continue
      const tags = tagsByDimension[dimId] || []
      const childDims = childDimsByParent.get(dimId)

      // 对每个选中标签创建节点
      for (const tag of tags) {
        // 如果指定了父标签上下文，检查 triggerConditions 是否匹配
        if (parentDimensionName && parentTagValue && group.triggerConditions) {
          const matchingTc = group.triggerConditions.find(
            tc => tc.parentDimension === parentDimensionName
          )
          if (matchingTc && !matchingTc.triggerTags.includes(parentTagValue)) {
            continue // 此标签不匹配当前父标签上下文
          }
        }

        // 检查是否有子维度需要嵌套
        let nestedNodes: VirtualDirectoryNode[] = []
        if (options.enableNestedClassification && childDims && childDims.length > 0) {
          const childDimIds = sortByLevel(childDims.map(d => d.id))
          nestedNodes = buildNodes(childDimIds, group.name, tag.tagValue)
        }

        const node: VirtualDirectoryNode = {
          name: tag.tagValue,
          parent: null,
          subdirectories: nestedNodes,
          files: [],
          fileCount: 0,
          totalSize: 0
        }
        nodes.push(node)
      }
    }

    return nodes
  }

  const rootNodes = buildNodes(allLevelDimIds)

  // 3. 倒排索引桶分发算法 (O(N + M) 线性算法)
  // 建立 tag -> node[] 的哈希索引，替代原有 O(N*M) 的双重嵌套笛卡尔积遍历
  const tagToNodesMap = new Map<string, VirtualDirectoryNode[]>()

  function indexNodes(nodes: VirtualDirectoryNode[]) {
    for (const node of nodes) {
      if (!tagToNodesMap.has(node.name)) {
        tagToNodesMap.set(node.name, [])
      }
      tagToNodesMap.get(node.name)!.push(node)
      if (node.subdirectories && node.subdirectories.length > 0) {
        indexNodes(node.subdirectories)
      }
    }
  }
  indexNodes(rootNodes)

  // 单次遍历文件列表（O(M)），实现秒级 Hash 桶分配
  for (const file of allFiles) {
    if (file.isDirectory) continue
    const fileRef = createFileRef(file)

    if (file.tags && Array.isArray(file.tags) && file.tags.length > 0) {
      for (const tagItem of file.tags) {
        const tagVal =
          typeof tagItem === 'string'
            ? tagItem
            : tagItem?.tagValue || tagItem?.name || tagItem?.value
        if (!tagVal) continue

        const targetNodes = tagToNodesMap.get(tagVal)
        if (targetNodes) {
          for (const node of targetNodes) {
            node.files.push(fileRef)
            node.fileCount++
            node.totalSize += file.size || 0
          }
        }
      }
    } else {
      // 兜底分配：给所有的根节点分配
      for (const node of rootNodes) {
        node.files.push(fileRef)
        node.fileCount++
        node.totalSize += file.size || 0
      }
    }
  }

  function createFileRef(file: any) {
    const rawName = file._rawName ?? file.name
    const rawSmartName = file._rawSmartName ?? file.smartName ?? rawName
    return {
      fileId: typeof file.id === 'string' ? parseInt(file.id.replace('disk-', '')) : file.id,
      fileFingerprint: file.fileFingerprint || '',
      relativePath: '',
      _rawName: rawName,
      _rawSmartName: rawSmartName,
      name: rawName || '',
      smartName: rawSmartName || rawName || '',
      originalPath: file.path,
      size: file.size
    }
  }

  return rootNodes
}
