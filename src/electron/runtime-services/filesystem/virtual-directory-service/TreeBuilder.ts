import { VirtualDirectoryNode, VirtualDirectoryFileRow } from '@firefly/types'
import { LogCategory, logger } from '@firefly/shared'

export interface VirtualDirectoryProvider {
  listFiles(
    virtualDirectoryId: number | string,
    options?: { includeKeepFiles?: boolean }
  ): Promise<VirtualDirectoryFileRow[]>
}

export class TreeBuilder {
  constructor(private provider: VirtualDirectoryProvider) {}

  async getTreeSnapshotAsTree(virtualDirectoryId: number | string): Promise<{
    tree: VirtualDirectoryNode[]
    fileMap: Map<string, VirtualDirectoryFileRow>
    rootNode: VirtualDirectoryNode
  }> {
    const files = await this.provider.listFiles(virtualDirectoryId, { includeKeepFiles: true })
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
      const relPath = file.relativePath || (file as any).relative_path
      const isKeep =
        relPath &&
        (relPath.endsWith('.keep') || relPath.endsWith('/.keep') || relPath.endsWith('\\.keep'))

      if (fingerprint && !isKeep) {
        fileMap.set(fingerprint, file)
      }
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
      // 只为目录部分创建节点，最后一个组件视为文件名（对于 .keep 占位记录，最后一个组件为 .keep）
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
      if (!isKeep) {
        current.files.push(file)
        current.fileCount++
        current.totalSize += file.size || 0
      }
    }

    // 将根级文件（如未归类或单组件路径文件）也组装合并入树节点中
    const resultTree = [...root.subdirectories]
    if (root.files.length > 0) {
      let unclassifiedNode = resultTree.find(n => n.name === '未归类')
      if (!unclassifiedNode) {
        unclassifiedNode = {
          name: '未归类',
          parent: null,
          subdirectories: [],
          files: [],
          fileCount: 0,
          totalSize: 0
        }
        resultTree.push(unclassifiedNode)
      }
      for (const rf of root.files) {
        const key = rf.fileFingerprint || (rf as any).file_fingerprint || rf.fileId || rf.name
        const exists = unclassifiedNode.files.some(
          f => (f.fileFingerprint || (f as any).file_fingerprint || f.fileId || f.name) === key
        )
        if (!exists) {
          unclassifiedNode.files.push(rf)
        }
      }
      unclassifiedNode.fileCount = unclassifiedNode.files.length
      unclassifiedNode.totalSize = unclassifiedNode.files.reduce((acc, f) => acc + (f.size || 0), 0)
    }

    const rootNode: VirtualDirectoryNode = {
      name: '',
      parent: null,
      subdirectories: resultTree,
      files: [],
      fileCount: 0,
      totalSize: 0,
      rootFiles: root.files
    }

    return { tree: resultTree, fileMap, rootNode }
  }
}
