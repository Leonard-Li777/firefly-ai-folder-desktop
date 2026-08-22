import { VirtualDirectoryNode } from '@firefly/types'
import { OrganizeMode } from '../types'
import { t } from '@app/languages'

/**
 * 富化整理树中的文件名称字段。
 *
 * 后端 reorganize IPC 返回的树结构中，文件对象只设了 smartName，缺失原始 name 字段。
 * 此函数通过 allFiles 查找表补充 name（原始文件名），确保文件名显示遵守 SWAP_FILE_NAME_DISPLAY 配置。
 */
export function enrichTreeFileNames(
  tree: VirtualDirectoryNode[],
  allFiles: Array<{ id: number | string; name?: string; smartName?: string }>
): VirtualDirectoryNode[] {
  if (
    !Array.isArray(tree) ||
    tree.length === 0 ||
    !Array.isArray(allFiles) ||
    allFiles.length === 0
  ) {
    return Array.isArray(tree) ? tree : []
  }

  const nameById = new Map<string, string>()
  const smartNameById = new Map<string, string>()
  const pathById = new Map<string, string>()
  for (const f of allFiles) {
    if (f.id != null) {
      const key = String(f.id)
      if (f.name) nameById.set(key, f.name)
      if (f.smartName) smartNameById.set(key, f.smartName)
      const filePath = (f as any).originalPath || (f as any).path
      if (filePath) pathById.set(key, filePath)
    }
  }

  const enrichNode = (nodes: VirtualDirectoryNode[]): VirtualDirectoryNode[] => {
    if (!Array.isArray(nodes)) return []
    return nodes.map(node => ({
      ...node,
      files: (Array.isArray(node.files) ? node.files : []).map(f => {
        const rawId = (f as any).fileId != null ? (f as any).fileId : (f as any).id
        const key = rawId != null ? String(rawId) : undefined
        const origName = key != null ? nameById.get(key) : undefined
        const origSmartName = key != null ? smartNameById.get(key) : undefined
        const origPath = key != null ? pathById.get(key) : undefined

        // 优先使用从工作区文件列表中查出的原始文件名 origName
        const rawFileName = origName || ((f as any).smartName ? (f as any).name : '') || ''
        // 智能名称：优先使用节点自带的 smartName，其次为 origSmartName，再回退到 f.name 或 origName
        const smartFileName =
          (f as any).smartName || origSmartName || (f as any).name || origName || ''

        return {
          ...f,
          name: rawFileName,
          smartName: smartFileName,
          // 后端树缺失原始路径，从工作区文件列表中补充，保证文件图标可获取系统原生高清图标
          originalPath: (f as any).originalPath || (f as any).path || origPath,
          path: (f as any).path || (f as any).originalPath || origPath
        }
      }),
      subdirectories: Array.isArray(node.subdirectories) ? enrichNode(node.subdirectories) : []
    }))
  }

  return enrichNode(tree)
}

/** 将已被用户确认 of draftTree 转化为后端所需的 selectedTagsTree 格式 */
export function convertTreeForBackend(nodes: any[]): any[] {
  return nodes.map(node => ({
    id: node.id || node.name,
    name: node.name,
    subdirectories: node.subdirectories ? convertTreeForBackend(node.subdirectories) : [],
    files: (node.files || []).map((f: any) => ({
      id: String(f.fileId !== undefined ? f.fileId : f.id),
      name: f.smartName || f.name
    }))
  }))
}

/** 统一判定节点或路径是否为“未归类” */
export function isUnclassifiedNodeName(name?: string): boolean {
  if (!name) return true
  const trimmed = String(name).trim().toLowerCase()
  return (
    trimmed === '未归类' ||
    trimmed === t('未归类').trim().toLowerCase() ||
    trimmed === 'unclassified'
  )
}

/** 判断目录节点在当前状态与模式下是否允许更名 */
export function isNodeRenameable(
  node: any,
  options: {
    currentVDirId?: number
    organizeMode?: string
    highFrequencyTags?: Set<string>
  }
): boolean {
  if (!node) return false
  if (isUnclassifiedNodeName(node.name) || !!node.isUnclassified || !!node.unclassified) {
    return false
  }
  const { currentVDirId, organizeMode, highFrequencyTags } = options
  // 仅限当前处于未落盘草稿阶段（!currentVDirId）、快速整理模式（fast-organize），且节点名称在 highFrequencyTags 列表中时禁止更名
  if (!currentVDirId && organizeMode === 'fast-organize' && highFrequencyTags) {
    const name = (node.name || '').trim()
    const nameLower = name.toLowerCase()
    if (highFrequencyTags.has(name) || highFrequencyTags.has(nameLower)) {
      return false
    }
  }
  return true
}

/** 辅助去重合并两个文件列表 */
function mergeFiles(filesA: any[] = [], filesB: any[] = []): any[] {
  const seen = new Set<string>()
  const merged: any[] = []
  for (const f of [...filesA, ...filesB]) {
    if (!f) continue
    const fid = String(
      (f as any).fileId ?? (f as any).id ?? (f as any).fileFingerprint ?? (f as any).name
    )
    if (!seen.has(fid)) {
      seen.add(fid)
      merged.push(f)
    }
  }
  return merged
}

/** 合并整理结果树与草稿树，统一整合“未归类”节点，保留草稿树中用户手动创建的所有空目录 */
export function mergeTreesWithDraft(
  resultTree: VirtualDirectoryNode[],
  draftTree: VirtualDirectoryNode[]
): VirtualDirectoryNode[] {
  if (!Array.isArray(draftTree) || draftTree.length === 0) return resultTree || []
  if (!Array.isArray(resultTree) || resultTree.length === 0) return draftTree || []

  // 1. 构建 resultMap 映射，同时将所有“未归类”节点聚合成单一的未归类节点
  const resultMap = new Map<string, VirtualDirectoryNode>()
  let unclassifiedResultNode: VirtualDirectoryNode | null = null

  for (const node of resultTree) {
    if (!node || !node.name) continue
    if (
      isUnclassifiedNodeName(node.name) ||
      (node as any).isUnclassified ||
      (node as any).unclassified
    ) {
      if (!unclassifiedResultNode) {
        unclassifiedResultNode = { ...node, name: t('未归类'), isUnclassified: true } as any
      } else {
        unclassifiedResultNode.files = mergeFiles(unclassifiedResultNode.files, node.files)
        unclassifiedResultNode.subdirectories = mergeTreesWithDraft(
          unclassifiedResultNode.subdirectories || [],
          node.subdirectories || []
        )
      }
    } else {
      resultMap.set(node.name.trim(), node)
    }
  }

  let unclassifiedDraftNode: VirtualDirectoryNode | null = null
  const mergedNodes: VirtualDirectoryNode[] = []

  // 2. 遍历 draftTree 进行同名节点合并
  for (const draftNode of draftTree) {
    if (!draftNode) continue
    if (
      isUnclassifiedNodeName(draftNode.name) ||
      (draftNode as any).isUnclassified ||
      (draftNode as any).unclassified
    ) {
      if (!unclassifiedDraftNode) {
        unclassifiedDraftNode = { ...draftNode, name: t('未归类'), isUnclassified: true } as any
      } else {
        unclassifiedDraftNode.files = mergeFiles(unclassifiedDraftNode.files, draftNode.files)
        unclassifiedDraftNode.subdirectories = mergeTreesWithDraft(
          unclassifiedDraftNode.subdirectories || [],
          draftNode.subdirectories || []
        )
      }
      continue
    }

    const key = (draftNode.name || '').trim()
    const matched = resultMap.get(key)
    if (matched) {
      const mergedSubs = mergeTreesWithDraft(
        matched.subdirectories || [],
        draftNode.subdirectories || []
      )
      const mergedFiles = mergeFiles(matched.files, draftNode.files)
      mergedNodes.push({
        ...matched,
        files: mergedFiles,
        fileCount: mergedFiles.length,
        subdirectories: mergedSubs
      })
      resultMap.delete(key)
    } else {
      mergedNodes.push({
        ...draftNode,
        files: draftNode.files || [],
        fileCount: (draftNode.files || []).length,
        subdirectories: mergeTreesWithDraft([], draftNode.subdirectories || [])
      })
    }
  }

  // 3. 将 resultMap 中剩余的非未归类节点加入
  for (const [_, extraNode] of resultMap) {
    mergedNodes.push(extraNode)
  }

  // 4. 合并并净化全局唯一的“未归类”节点
  if (unclassifiedResultNode || unclassifiedDraftNode) {
    const combinedUnclassifiedFiles = mergeFiles(
      unclassifiedResultNode?.files,
      unclassifiedDraftNode?.files
    )
    const combinedUnclassifiedSubs = mergeTreesWithDraft(
      unclassifiedResultNode?.subdirectories || [],
      unclassifiedDraftNode?.subdirectories || []
    )

    // 收集所有已分入有效分类目录下的 fileId
    const classifiedFileIds = new Set<string>()
    const collectClassifiedIds = (nodes: VirtualDirectoryNode[]) => {
      for (const n of nodes) {
        if (Array.isArray(n.files)) {
          for (const f of n.files) {
            const fid = String(
              (f as any).fileId ?? (f as any).id ?? (f as any).fileFingerprint ?? (f as any).name
            )
            classifiedFileIds.add(fid)
          }
        }
        if (Array.isArray(n.subdirectories)) {
          collectClassifiedIds(n.subdirectories)
        }
      }
    }
    collectClassifiedIds(mergedNodes)

    // 从未归类节点中过滤掉已经分配到有效目录中的文件
    const cleanUnclassifiedFiles = combinedUnclassifiedFiles.filter(f => {
      const fid = String(
        (f as any).fileId ?? (f as any).id ?? (f as any).fileFingerprint ?? (f as any).name
      )
      return !classifiedFileIds.has(fid)
    })

    mergedNodes.push({
      name: t('未归类'),
      isUnclassified: true,
      parent: null,
      subdirectories: combinedUnclassifiedSubs,
      files: cleanUnclassifiedFiles,
      fileCount: cleanUnclassifiedFiles.length,
      totalSize: cleanUnclassifiedFiles.reduce((sum, f) => sum + (f.size || 0), 0)
    } as any)
  }

  return recalculateNodeFileCounts(mergedNodes)
}

/** 根据视角名称智能匹配图标 */
export function getPerspectiveIcon(perspective: string): string {
  const p = perspective || ''
  if (p.includes('时间') || p.includes('日期') || p.includes('创建') || p.includes('修改')) {
    return 'schedule'
  }
  if (p.includes('类型') || p.includes('格式') || p.includes('后缀') || p.includes('文件')) {
    return 'category'
  }
  if (p.includes('大小') || p.includes('空间') || p.includes('存储') || p.includes('容量')) {
    return 'storage'
  }
  if (p.includes('项目') || p.includes('模块') || p.includes('任务') || p.includes('工作')) {
    return 'work_outline'
  }
  return 'insights'
}

/** 清洗目录名：先移除非法特殊字符，再校验目录名长度（正常范围 1-40 字），保留正常范围的目录名 */
export function sanitizeDirectoryName(name: string): string {
  if (!name) return '未归类'
  // 1. 先去掉非法特殊字符（使用 Unicode 属性转义 \p{L} 匹配所有语言字母，\p{N} 匹配数字）
  let cleaned = name.replace(/[^\p{L}\p{N}\s.\-_（）()【】\[\]]/gu, '').trim()

  // 2. 检查并裁切非法的先导与结尾特殊字符（保留如 [情感]电台 等合法成对括号开头的名称）
  const pairedBrackets = [
    { open: '[', close: ']' },
    { open: '【', close: '】' },
    { open: '(', close: ')' },
    { open: '（', close: '）' }
  ]
  const startsWithPaired = pairedBrackets.some(
    b => cleaned.startsWith(b.open) && cleaned.includes(b.close)
  )
  const endsWithPaired = pairedBrackets.some(
    b => cleaned.endsWith(b.close) && cleaned.includes(b.open)
  )

  if (!startsWithPaired) {
    // 裁剪首部非字母、数字、开括号的无用特殊符号
    cleaned = cleaned.replace(/^[^\p{L}\p{N}\[【(（]+/gu, '').trim()
  }
  if (!endsWithPaired) {
    // 裁剪尾部非字母、数字、闭括号的无用特殊符号
    cleaned = cleaned.replace(/[^\p{L}\p{N}\]】)）]+$/gu, '').trim()
  }

  // 3. 如果清洗后为空，标记为未归类
  if (!cleaned) {
    return '未归类'
  }

  // 4. 校验目录名长度在正常范围（1 ~ 40个字符），超出范围则视为不规范名称
  if (cleaned.length > 40) {
    return '未归类'
  }

  // 5. 过滤“未知”等无意义的名称
  if (cleaned === t('未知') || cleaned === '未知') {
    return '未归类'
  }

  // 6. 过滤包含或纯文件扩展名拼接形式的不合规目录名（如 .bat .ps1、.txt、.jpg、file_type .bat 等）
  if (/(^|\s)\.[a-zA-Z0-9]+($|\s)/.test(cleaned)) {
    return '未归类'
  }

  return cleaned
}

/** 递归清洗整个目录树中所有节点的名称 */
export function sanitizeTree(
  nodes: VirtualDirectoryNode[],
  filterUnclassified = false
): VirtualDirectoryNode[] {
  const result: VirtualDirectoryNode[] = []

  for (const node of nodes) {
    const cleanedName = sanitizeDirectoryName(node.name)
    const cleanedSubdirs = node.subdirectories
      ? sanitizeTree(node.subdirectories, filterUnclassified)
      : []

    const isUnclassified = cleanedName === '未归类' || cleanedName === t('未归类')

    if (filterUnclassified && isUnclassified) {
      // 如果当前节点是不合规节点（如扩展名）被归为了「未归类」，但包含合法的子节点（如“文件”、“文档”），
      // 则提升（flatten）其合法子节点到当前层级，避免合法的合法目录被误杀
      if (cleanedSubdirs.length > 0) {
        result.push(...cleanedSubdirs)
      }
    } else {
      result.push({
        ...node,
        name: cleanedName,
        subdirectories: cleanedSubdirs
      })
    }
  }

  return result
}

/** 构建骨架目录树（State 2 预览） */
export function buildSkeletonTree(groups: any[], mode: OrganizeMode): VirtualDirectoryNode[] {
  if (!groups || groups.length === 0) return []

  // 快速整理：取文件数最高的前 N 个标签
  if (mode === 'fast-organize') {
    const allTags: Array<{ name: string; fileCount: number }> = []
    for (const g of groups) {
      for (const tag of g.tags || []) {
        allTags.push({ name: tag.tagValue, fileCount: tag.fileCount || 0 })
      }
    }
    const sorted = allTags.sort((a, b) => b.fileCount - a.fileCount)
    const topN = sorted.slice(0, Math.min(15, sorted.length))
    return topN.map(tag => ({
      name: sanitizeDirectoryName(tag.name),
      parent: null,
      subdirectories: [],
      files: [],
      fileCount: tag.fileCount,
      totalSize: 0
    }))
  }

  // 精细整理：按维度组织
  return groups.slice(0, 3).flatMap(g =>
    (g.tags || []).slice(0, 8).map((tag: any) => ({
      name: sanitizeDirectoryName(tag.tagValue),
      parent: null,
      subdirectories: [],
      files: [],
      fileCount: tag.fileCount || 0,
      totalSize: 0
    }))
  )
}

/** 基于方案策略构建预览树 */
export function buildPreviewTreeFromStrategy(
  candidate: any,
  groups: any[],
  mode: OrganizeMode
): VirtualDirectoryNode[] {
  if (!groups || groups.length === 0) return []

  // 收集所有标签
  const allTags: Array<{ name: string; fileCount: number; dimension: string }> = []
  for (const g of groups) {
    for (const tag of g.tags || []) {
      if ((tag.fileCount || 0) > 0) {
        allTags.push({
          name: tag.tagValue,
          fileCount: tag.fileCount || 0,
          dimension: g.name
        })
      }
    }
  }

  // 按文件数排序
  const sortedTags = allTags.sort((a, b) => b.fileCount - a.fileCount)

  if (mode === 'fast-organize') {
    // 快速整理：取前10个高频标签作为骨架
    const topTags = sortedTags.slice(0, Math.min(10, sortedTags.length))
    return topTags.map(tag => ({
      name: sanitizeDirectoryName(tag.name),
      parent: null,
      subdirectories: [],
      files: [],
      fileCount: tag.fileCount,
      totalSize: 0
    }))
  } else {
    // 精细整理：按维度分组展示
    const dimensionMap = new Map<string, Array<{ name: string; fileCount: number }>>()
    for (const tag of sortedTags) {
      if (!dimensionMap.has(tag.dimension)) {
        dimensionMap.set(tag.dimension, [])
      }
      dimensionMap.get(tag.dimension)!.push(tag)
    }

    const result: VirtualDirectoryNode[] = []
    for (const [dimName, tags] of dimensionMap) {
      result.push({
        name: sanitizeDirectoryName(dimName),
        parent: null,
        subdirectories: tags.slice(0, 5).map(t => ({
          name: sanitizeDirectoryName(t.name),
          parent: sanitizeDirectoryName(dimName),
          subdirectories: [],
          files: [],
          fileCount: t.fileCount,
          totalSize: 0
        })),
        files: [],
        fileCount: tags.reduce((sum, t) => sum + t.fileCount, 0),
        totalSize: 0
      })
    }
    return result
  }
}

/** 收集所有文件 */
export function collectAllFiles(
  groups: any[],
  regenerateFiles: Array<{ id: number; name: string }> | null
): Array<{ id: number; name: string }> {
  if (regenerateFiles) {
    return regenerateFiles
  }
  const result: Array<{ id: number; name: string }> = []
  // 注意：原逻辑中这里循环了 groups 但没有 push 任何东西到 result
  // 这里保持原样
  return result
}

/** 统计未归类文件数 */
export function countUnclassified(tree: VirtualDirectoryNode[]): number {
  const unclassifiedNode = tree.find(n => n.name === t('未归类'))
  return unclassifiedNode?.fileCount || 0
}

/**
 * 将树结构清空恢复为纯粹的大纲/骨架树，将所有已有文件从具体节点中剥离，全量归还放到【未归类】节点中
 */
export function resetTreeToOutline(
  tree: VirtualDirectoryNode[],
  toOrganizeFiles: any[] = []
): VirtualDirectoryNode[] {
  if (!Array.isArray(tree)) return []

  const isUnclassifiedName = (name: string) => name === t('未归类')

  const cleanNodes = (nodes: VirtualDirectoryNode[]): VirtualDirectoryNode[] => {
    return nodes
      .filter(n => !isUnclassifiedName(n.name || ''))
      .map(node => ({
        ...node,
        files: [],
        fileCount: 0,
        subdirectories: Array.isArray(node.subdirectories) ? cleanNodes(node.subdirectories) : []
      }))
  }

  const result = cleanNodes(tree)
  result.push({
    name: t('未归类'),
    parent: null,
    subdirectories: [],
    files: [...toOrganizeFiles],
    fileCount: toOrganizeFiles.length,
    totalSize: 0
  })

  return result
}

/** 从 tree 中递归深度提取所有未归类文件 */
export function extractUnclassifiedFiles(tree: VirtualDirectoryNode[]): any[] {
  const result: any[] = []
  if (!Array.isArray(tree) || tree.length === 0) {
    return result
  }

  const isUnclassifiedName = (name: string) => name === t('未归类')

  const traverse = (nodes: VirtualDirectoryNode[], inUnclassifiedContext: boolean) => {
    if (!Array.isArray(nodes)) return
    for (const node of nodes) {
      const isUnclassNode = inUnclassifiedContext || isUnclassifiedName(node.name || '')
      if (Array.isArray(node.files)) {
        for (const f of node.files) {
          if (
            isUnclassNode ||
            (f as any).isUnclassified ||
            (f as any).unclassified ||
            isUnclassifiedName((f as any).name || '') ||
            isUnclassifiedName((f as any).smartName || '')
          ) {
            const rawId = (f as any).fileId ?? (f as any).id ?? 0
            const fileName =
              (f as any).name || (f as any).smartName || (f as any).originalPath || String(rawId)
            result.push({
              ...f,
              id: rawId,
              fileId: rawId,
              name: fileName
            })
          }
        }
      }
      if (Array.isArray(node.subdirectories) && node.subdirectories.length > 0) {
        traverse(node.subdirectories, isUnclassNode)
      }
    }
  }

  traverse(tree, false)
  return result
}

/** 构建 selectedTagsTree */
export function buildSelectedTagsTree(groups: any[]) {
  return (groups || []).map(g => ({
    id: String(g.id),
    name: g.name,
    subdirectories: (g.tags || []).map((tag: any) => ({
      id: tag.tagValue,
      name: tag.tagValue,
      fileCount: tag.fileCount || 0,
      files: [],
      subdirectories: []
    })),
    files: []
  }))
}

/**
 * 解析用户编辑的目录树文本为 VirtualDirectoryNode[] 结构
 * 支持格式：markdown 列表格式，如：
 * - 办公文档
 *   - 行政人事
 *     - 考勤记录
 * @param strategyText 用户输入的策略文本
 * @returns 解析后的目录树，解析失败返回 null
 */
export function parseStrategyToTree(strategyText: string): VirtualDirectoryNode[] | null {
  if (!strategyText || !strategyText.trim()) return null

  const lines = strategyText.split('\n')
  const result: VirtualDirectoryNode[] = []
  const stack: Array<{ node: VirtualDirectoryNode; indent: number }> = []

  for (const line of lines) {
    const trimmedLine = line.trim()
    if (!trimmedLine) continue

    let content = ''
    const matchMd = trimmedLine.match(/^[-*]\s+(.+)/)
    if (matchMd) {
      content = matchMd[1].trim()
    } else {
      content = trimmedLine
        .replace(/^[│\s├└─|]+/, '')
        .replace(/[/\\].*$/, '')
        .replace(/（.*$/, '')
        .trim()
    }

    if (!content || content === '未归类' || content === '项目核心' || content === '核心项目')
      continue

    const indent = line.length - line.trimStart().length

    const newNode: VirtualDirectoryNode = {
      name: sanitizeDirectoryName(content),
      parent: null,
      subdirectories: [],
      files: [],
      fileCount: 0,
      totalSize: 0
    }

    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop()
    }

    if (stack.length === 0) {
      result.push(newNode)
    } else {
      const parentNode = stack[stack.length - 1].node
      newNode.parent = parentNode.name
      parentNode.subdirectories.push(newNode)
    }

    stack.push({ node: newNode, indent })
  }

  return result.length > 0 ? result : null
}

/** 获取文件唯一的比对 Key（兼容下划线/小驼峰/指纹/路径/名称形态） */
export function getFileUniqueKey(f: any): string {
  if (!f) return ''
  const rawId = f.fileId ?? f.file_id ?? f.id
  if (rawId != null && String(rawId) !== 'undefined' && String(rawId) !== '0') {
    return String(rawId)
  }
  const fp = f.fileFingerprint ?? f.file_fingerprint
  if (fp && String(fp) !== 'undefined') return String(fp)
  const p = f.path ?? f.originalPath
  if (p && String(p) !== 'undefined') return String(p)
  return String(f.name || f.smartName || '')
}

/** 收集文件所有的唯一识别特征 Key 集合（全维度多重比对防误判） */
export function getAllFileKeys(f: any): string[] {
  if (!f) return []
  const keys: string[] = []
  const rawId = f.fileId ?? f.file_id ?? f.id
  if (rawId != null && String(rawId) !== 'undefined' && String(rawId) !== '0') {
    keys.push(`id:${rawId}`)
  }
  const fp = f.fileFingerprint ?? f.file_fingerprint
  if (fp && String(fp) !== 'undefined') keys.push(`fp:${fp}`)
  const p = f.path ?? f.originalPath
  if (p && String(p) !== 'undefined') keys.push(`path:${p}`)
  const name = f.name || f.smartName
  if (name && String(name) !== 'undefined') keys.push(`name:${name}`)
  return keys
}

/** 合并补救结果 */
export function mergeRescueResult(
  original: VirtualDirectoryNode[],
  rescued: VirtualDirectoryNode[]
): VirtualDirectoryNode[] {
  // 1. 深拷贝 original 树，并过滤掉顶级“未归类”节点
  const cloneNode = (node: VirtualDirectoryNode): VirtualDirectoryNode => ({
    name: node.name,
    parent: node.parent,
    fileCount: node.fileCount,
    totalSize: node.totalSize,
    files: [...(node.files || [])],
    subdirectories: (node.subdirectories || []).map(cloneNode)
  })

  const isUnclassNodeName = (name: string) => name === t('未归类')

  const newTree = original.filter(n => !isUnclassNodeName(n.name)).map(cloneNode)

  // 2. 辅助函数：根据路径寻找或创建目录节点
  const findOrCreatePath = (
    tree: VirtualDirectoryNode[],
    pathParts: string[]
  ): VirtualDirectoryNode => {
    let currentLevel = tree
    let lastNode: VirtualDirectoryNode | null = null

    for (let i = 0; i < pathParts.length; i++) {
      const part = pathParts[i]
      let found = currentLevel.find(n => n.name === part)
      if (!found) {
        found = {
          name: sanitizeDirectoryName(part),
          parent: lastNode ? sanitizeDirectoryName(lastNode.name) : null,
          subdirectories: [],
          files: [],
          fileCount: 0,
          totalSize: 0
        }
        currentLevel.push(found)
      }
      lastNode = found
      currentLevel = found.subdirectories
    }
    return lastNode!
  }

  // 从 tree 中移除特定文件（根据 getAllFileKeys 跨节点去重）
  const removeFileFromTree = (nodes: VirtualDirectoryNode[], f: any) => {
    const targetKeys = new Set(getAllFileKeys(f))
    if (targetKeys.size === 0) return

    const walk = (list: VirtualDirectoryNode[]) => {
      for (const node of list) {
        if (Array.isArray(node.files)) {
          node.files = node.files.filter(existingFile => {
            const existingKeys = getAllFileKeys(existingFile)
            return !existingKeys.some(k => targetKeys.has(k))
          })
        }
        if (Array.isArray(node.subdirectories)) {
          walk(node.subdirectories)
        }
      }
    }
    walk(nodes)
  }

  // 3. 收集 rescued 树中所有被归类到非「未归类」节点的文件并合并
  const traverseRescued = (nodes: VirtualDirectoryNode[], pathParts: string[]) => {
    for (const node of nodes) {
      if (isUnclassNodeName(node.name)) {
        continue
      }
      const currentPath = [...pathParts, node.name]
      if (node.files && node.files.length > 0) {
        const targetNode = findOrCreatePath(newTree, currentPath)
        for (const f of node.files) {
          // 先从 newTree 的原有旧节点中彻底擦除该文件，避免在新旧节点中重复出现
          removeFileFromTree(newTree, f)
          targetNode.files.push(f)
        }
      }
      if (node.subdirectories) {
        traverseRescued(node.subdirectories, currentPath)
      }
    }
  }
  traverseRescued(rescued, [])

  // 4. 收集 newTree 中所有非未归类节点中已存在的文件全维度 Key 集合
  const classifiedFileKeys = new Set<string>()
  const collectClassifiedKeys = (nodes: VirtualDirectoryNode[]) => {
    for (const node of nodes) {
      if (isUnclassNodeName(node.name)) continue
      if (Array.isArray(node.files)) {
        for (const f of node.files) {
          const keys = getAllFileKeys(f)
          for (const k of keys) {
            classifiedFileKeys.add(k)
          }
        }
      }
      if (Array.isArray(node.subdirectories)) {
        collectClassifiedKeys(node.subdirectories)
      }
    }
  }
  collectClassifiedKeys(newTree)

  // 5. 过滤并精准合并「未归类」文件
  const originalUnclassified = original.find(n => isUnclassNodeName(n.name))
  const rescuedUnclassified = rescued.find(n => isUnclassNodeName(n.name))

  const candidateUnclassifiedFiles = [
    ...(rescuedUnclassified?.files || []),
    ...(originalUnclassified?.files || [])
  ]

  const cleanUnclassifiedFiles: any[] = []
  const seenUnclassifiedKeys = new Set<string>()

  for (const f of candidateUnclassifiedFiles) {
    if (!f) continue
    const fKeys = getAllFileKeys(f)
    if (fKeys.length === 0) continue

    // 1. 如果该文件的任意特征 Key（ID、指纹、路径、名称）已经在实体分类目录中出现，则 100% 绝对剔除！
    const isAlreadyClassified = fKeys.some(k => classifiedFileKeys.has(k))
    if (isAlreadyClassified) continue

    // 2. 如果该文件的任意特征 Key 已经在未归类收集池中出现过，绝不重复加入！
    const isAlreadySeen = fKeys.some(k => seenUnclassifiedKeys.has(k))
    if (isAlreadySeen) continue

    // 3. 记录全维度 Key，并将文件加入干净未归类池
    fKeys.forEach(k => seenUnclassifiedKeys.add(k))
    cleanUnclassifiedFiles.push(f)
  }

  newTree.push({
    name: t('未归类'),
    parent: null,
    subdirectories: [],
    files: cleanUnclassifiedFiles,
    fileCount: cleanUnclassifiedFiles.length,
    totalSize: 0
  })

  // 6. 递归重新计算所有节点的 fileCount
  const computeCounts = (node: VirtualDirectoryNode) => {
    let count = node.files.length
    for (const sub of node.subdirectories) {
      computeCounts(sub)
      count += sub.fileCount
    }
    node.fileCount = count
  }
  for (const root of newTree) {
    computeCounts(root)
  }

  return newTree
}

/**
 * 从 VirtualDirectoryNode 树中递归提取所有文件及其相对路径，
 * 供 replaceFiles 提交保存到 SQLite virtual_directory_files 表。
 */
export function extractFilesFromTree(
  nodes: VirtualDirectoryNode[],
  parentPath = ''
): Array<{ fileId: number; relativePath: string }> {
  const result: Array<{ fileId: number; relativePath: string }> = []
  if (!Array.isArray(nodes)) return result

  const traverse = (nodesList: VirtualDirectoryNode[], currentPath: string) => {
    if (!Array.isArray(nodesList)) return
    for (const node of nodesList) {
      const dirName = (node.name || '').trim()
      const dirPath = currentPath ? (dirName ? `${currentPath}/${dirName}` : currentPath) : dirName

      if (Array.isArray(node.files)) {
        for (const file of node.files) {
          const rawId = (file as any).fileId ?? (file as any).id
          if (rawId != null) {
            const numId = Number(rawId)
            if (!isNaN(numId)) {
              const fileName = file.name || (file as any).smartName || `file_${numId}`
              const relPath = dirPath ? `${dirPath}/${fileName}` : fileName
              result.push({ fileId: numId, relativePath: relPath })
            }
          }
        }
      }

      if (Array.isArray(node.subdirectories)) {
        traverse(node.subdirectories, dirPath)
      }
    }
  }

  traverse(nodes, parentPath)
  return result
}

/** 递归统计树节点列表中所有物理文件的真实总数量 */
export function countRealFiles(nodes: VirtualDirectoryNode[]): number {
  let count = 0
  if (!Array.isArray(nodes)) return 0
  for (const node of nodes) {
    if (Array.isArray(node.files)) {
      count += node.files.length
    }
    if (Array.isArray(node.subdirectories) && node.subdirectories.length > 0) {
      count += countRealFiles(node.subdirectories)
    }
  }
  return count
}

/** 递归重新计算并同步整棵树中所有节点的 fileCount 属性（直属文件数 + 所有子目录文件数） */
export function recalculateNodeFileCounts(nodes: VirtualDirectoryNode[]): VirtualDirectoryNode[] {
  if (!Array.isArray(nodes)) return []
  const processNode = (node: VirtualDirectoryNode): VirtualDirectoryNode => {
    const subs = Array.isArray(node.subdirectories) ? node.subdirectories.map(processNode) : []
    const directFilesCount = Array.isArray(node.files) ? node.files.length : 0
    const subsFilesCount = subs.reduce((sum, s) => sum + (s.fileCount || 0), 0)
    return {
      ...node,
      subdirectories: subs,
      fileCount: directFilesCount + subsFilesCount
    }
  }
  return nodes.map(processNode)
}

/** 根据 strategy 策略描述秒级提取大纲目录树节点 */
export function parseStrategyToNodes(strategy: string): VirtualDirectoryNode[] {
  if (!strategy) return []
  const lines = strategy
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
  const rootNodes: VirtualDirectoryNode[] = []

  for (const line of lines) {
    const cleanName = line
      .replace(/^[│\s├└─|]+/, '')
      .replace(/[/\\].*$/, '')
      .replace(/（.*$/, '')
      .trim()
    if (
      !cleanName ||
      cleanName === t('未归类') ||
      cleanName === t('项目核心') ||
      cleanName === t('核心项目')
    )
      continue
    if (!rootNodes.some(n => n.name === cleanName)) {
      rootNodes.push({
        name: sanitizeDirectoryName(cleanName),
        parent: null,
        subdirectories: [],
        files: [],
        fileCount: 0,
        totalSize: 0
      })
    }
  }
  return rootNodes
}
