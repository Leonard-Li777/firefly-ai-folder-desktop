import { VirtualDirectoryNode, VirtualDirectoryFileInput } from '@firefly/types'
import { useSettingsStore } from '../../../../stores/settings-store'

export function exportTreeToFiles(
  tree: VirtualDirectoryNode[],
  fallbackFile?: { fileId: number; fileFingerprint?: string }
): VirtualDirectoryFileInput[] {
  const result: VirtualDirectoryFileInput[] = []
  const getConfigValue = useSettingsStore.getState().getConfigValue
  const swapFileNameDisplay = getConfigValue<boolean>('SWAP_FILE_NAME_DISPLAY') ?? false

  // 首先在整棵树中找到任意一个真实文件的 fileId 与 fileFingerprint，作为空目录占位记录的 fileId 锚点
  let anyFile: { fileId: number; fileFingerprint: string } | undefined = fallbackFile
    ? { fileId: fallbackFile.fileId, fileFingerprint: String(fallbackFile.fileFingerprint || '') }
    : undefined
  const findAnyFile = (nodes: VirtualDirectoryNode[]) => {
    for (const n of nodes || []) {
      if (!n) continue
      if (Array.isArray(n.files) && n.files.length > 0) {
        const f = n.files[0]
        const fid = (f as any).fileId ?? (f as any).id
        if (fid) {
          anyFile = { fileId: Number(fid), fileFingerprint: String(f.fileFingerprint || '') }
          return
        }
      }
      if (Array.isArray(n.subdirectories) && n.subdirectories.length > 0) {
        findAnyFile(n.subdirectories)
        if (anyFile) return
      }
    }
  }
  if (!anyFile) {
    findAnyFile(tree)
  }

  const processNode = (node: VirtualDirectoryNode, currentPath: string) => {
    if (!node || !node.name) return
    const nodePath = currentPath ? `${currentPath}/${node.name}` : node.name
    const hasFiles = Array.isArray(node.files) && node.files.length > 0
    const hasSubs = Array.isArray(node.subdirectories) && node.subdirectories.length > 0

    if (hasFiles) {
      for (const file of node.files) {
        const fid = (file as any).fileId ?? (file as any).id
        const fileName = swapFileNameDisplay
          ? file.name || file.smartName || `file_${fid}`
          : file.smartName || file.name || `file_${fid}`
        result.push({
          fileId: Number(fid),
          fileFingerprint: file.fileFingerprint,
          relativePath: `${nodePath}/${fileName}`
        })
      }
    }

    if (hasSubs) {
      for (const sub of node.subdirectories) {
        processNode(sub, nodePath)
      }
    }

    // 如果该节点既没有文件也没有子目录（纯空目录），且存在可用的 fileId 锚点，为该空目录写一条 .keep 占位映射
    if (!hasFiles && !hasSubs && anyFile) {
      result.push({
        fileId: anyFile.fileId,
        fileFingerprint: anyFile.fileFingerprint,
        relativePath: `${nodePath}/.keep`
      })
    }
  }

  for (const node of tree || []) {
    processNode(node, '')
  }

  return result
}
