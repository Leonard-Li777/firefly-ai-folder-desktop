import { SelectedTag } from '@firefly/types'
import fs from 'fs-extra'
import path from 'node:path'
import Database from 'better-sqlite3'
import { VIRTUAL_DIRECTORY_ROOT } from './utils'
import { ConfigOrchestrator } from '../../../config/config-orchestrator'

export interface PreviewTreeProvider {
  db: Database.Database
  copyReadmeFile(virtualDirPath: string): Promise<void>
}

export class PreviewTreeExporter {
  constructor(private provider: PreviewTreeProvider) {}

  async generateFromPreviewTree(
    workspaceDirectoryPath: string,
    directoryTree: any[],
    tagFileMap: Map<string, any[]>,
    options: any
  ): Promise<any> {
    const workspaceResult = this.provider.db
      .prepare('SELECT id FROM workspace_directories WHERE path = ?')
      .get(workspaceDirectoryPath) as any
    if (!workspaceResult) throw new Error('Workspace directory not found')
    const workspaceId = workspaceResult.id

    const idToTagsMap = new Map<string, SelectedTag[]>()
    const idToRealIdMap = new Map<string, string>()

    for (const node of directoryTree) {
      const nodePreviewId = node.id || node.name
      let currentTags: SelectedTag[] = []
      if (node.dimensionId !== undefined && node.dimensionName && node.tagValue) {
        const selfTag: SelectedTag = {
          dimensionId: node.dimensionId,
          dimensionName: node.dimensionName,
          tagValue: node.tagValue,
          level: 0
        }
        currentTags =
          node.parent && idToTagsMap.has(node.parent)
            ? [...idToTagsMap.get(node.parent)!, selfTag]
            : [selfTag]
      }
      idToTagsMap.set(nodePreviewId, currentTags)

      const parentDbId = node.parent ? idToRealIdMap.get(node.parent) : null
      const existing = this.provider.db
        .prepare(
          'SELECT id FROM analyzed_directories WHERE name = ? AND workspace_id = ? AND (parent_id = ? OR (parent_id IS NULL AND ? IS NULL))'
        )
        .get(node.name, workspaceId, parentDbId, parentDbId) as any
      let dbId = existing ? existing.id : null

      if (dbId) {
        this.provider.db
          .prepare(
            'UPDATE analyzed_directories SET name = ?, filters = ?, updated_at = ? WHERE id = ?'
          )
          .run(node.name, JSON.stringify(currentTags), new Date().toISOString(), dbId)
      } else {
        const newId = `vdir-${Date.now()}-${Math.random().toString(36).substring(7)}`
        this.provider.db
          .prepare(
            'INSERT INTO analyzed_directories (id, name, filters, parent_id, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
          )
          .run(
            newId,
            node.name,
            JSON.stringify(currentTags),
            parentDbId,
            workspaceId,
            new Date().toISOString(),
            new Date().toISOString()
          )
        dbId = newId
      }

      idToRealIdMap.set(nodePreviewId, dbId.toString())
    }

    const virtualDirPath = path.join(workspaceDirectoryPath, VIRTUAL_DIRECTORY_ROOT)
    let totalFileCount = 0

    if (fs.existsSync(virtualDirPath)) {
      for (const item of fs.readdirSync(virtualDirPath)) {
        if (item.startsWith('ReadMe_') || item === '.thumbnail') continue
        await fs.remove(path.join(virtualDirPath, item))
      }
    } else {
      await fs.ensureDir(virtualDirPath)
    }

    await this.provider.copyReadmeFile(virtualDirPath)

    if (options.flattenToRoot) {
      const allFiles = new Map<string, any>()
      for (const node of directoryTree)
        node.files?.forEach((f: any) => {
          if (f.path) allFiles.set(f.path, f)
        })
      const swap =
        ConfigOrchestrator.getInstance().getValue<boolean>('SWAP_FILE_NAME_DISPLAY') ?? false
      for (const file of allFiles.values()) {
        try {
          const rawName = file._rawName ?? file.name
          const rawSmartName = file._rawSmartName ?? file.smartName ?? rawName
          const target = path.join(
            virtualDirPath,
            swap ? rawName || rawSmartName : rawSmartName || rawName
          )
          await fs.link(file.path, target).catch(() => fs.symlink(file.path, target))
          totalFileCount++
        } catch (_e) {
          console.warn('[预览导出] 创建链接/符号链接失败:', file.path, _e)
        }
      }
    } else {
      const swap =
        ConfigOrchestrator.getInstance().getValue<boolean>('SWAP_FILE_NAME_DISPLAY') ?? false
      const createNodeStructure = async (node: any, parentPath: string) => {
        const currentPath = path.join(parentPath, node.name)
        await fs.ensureDir(currentPath)
        for (const f of node.files || []) {
          if (f.path) {
            const rawName = f._rawName ?? f.name
            const rawSmartName = f._rawSmartName ?? f.smartName ?? rawName
            const target = path.join(
              currentPath,
              swap ? rawName || rawSmartName : rawSmartName || rawName
            )
            await fs.link(f.path, target).catch(() => fs.symlink(f.path, target))
            totalFileCount++
          }
        }
        const nodeIdentifier = node.id || node.name
        for (const child of directoryTree.filter(n => n !== node && n.parent === nodeIdentifier)) {
          await createNodeStructure(child, currentPath)
        }
      }
      for (const node of directoryTree.filter(node => !node.parent || node.parent === '')) {
        await createNodeStructure(node, virtualDirPath)
      }
    }

    return { success: true, fileCount: totalFileCount, message: 'Exported', virtualDirPath }
  }
}
