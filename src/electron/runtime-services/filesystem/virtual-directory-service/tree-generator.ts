import { VirtualDirectoryFileRow, VirtualDirectoryNode } from '@firefly/types'
import { LogCategory, logger } from '@firefly/shared'

export async function getTreeSnapshotAsTree(
  listFiles: (id: number) => Promise<VirtualDirectoryFileRow[]>,
  virtualDirectoryId: number
): Promise<{
  tree: VirtualDirectoryNode[]
  fileMap: Map<string, VirtualDirectoryFileRow>
  rootNode: VirtualDirectoryNode
}> {
  const files = await listFiles(virtualDirectoryId)
  const fileMap = new Map<string, VirtualDirectoryFileRow>()
  const root: VirtualDirectoryNode = {
    name: 'Root',
    parent: null,
    subdirectories: [],
    files: [],
    fileCount: 0,
    totalSize: 0
  }

  for (const file of files) {
    const fingerprint = file.fileFingerprint || (file as any).file_fingerprint
    if (fingerprint) {
      fileMap.set(fingerprint, file)
    }
    const relPath = file.relativePath || (file as any).relative_path
    if (!relPath) {
      logger.warn(
        LogCategory.VIRTUAL_DIRECTORY,
        'getTreeSnapshotAsTree 发现文件记录缺失相对路径:',
        file
      )
      continue
    }
    const parts = relPath.split(/[\\\/]/).filter(Boolean)
    let current = root
    // 只为目录部分创建节点，最后一个组件视为文件名（即使它是目录路径）
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]
      let sub = current.subdirectories.find(s => s.name === part)
      if (!sub) {
        sub = {
          name: part,
          parent: current.name === 'Root' ? null : current.name,
          subdirectories: [],
          files: [],
          fileCount: 0,
          totalSize: 0
        }
        current.subdirectories.push(sub)
      }
      current = sub
    }
    current.files.push(file)
    current.fileCount++
    current.totalSize += file.size || 0
  }

  // 将根级文件也一并返回
  const rootNode: VirtualDirectoryNode = {
    name: '',
    parent: null,
    subdirectories: root.subdirectories,
    files: [],
    fileCount: 0,
    totalSize: 0,
    rootFiles: root.files
  }

  return { tree: root.subdirectories, fileMap, rootNode }
}
