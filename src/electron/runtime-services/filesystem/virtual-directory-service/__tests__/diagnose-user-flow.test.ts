import { describe, it, expect, beforeEach, vi } from 'vitest'
import '../../../../../../pro/tests/mocks/electron-mock'
vi.mock('electron-conf', () => ({
  Conf: class {
    get() { return undefined }
    set() {}
  }
}))
import Database from 'better-sqlite3'
import { VirtualDirectoryService } from '../VirtualDirectoryService'
import { GENESIS_V1_SCHEMA } from '../../../database/database'
import { exportTreeToFiles } from '../../../../../../src/renderer/components/file-explorer/Organize/utils/exportTreeToFiles'
import { filterEmptyDirectoryNodes } from '../../../../../../src/renderer/components/file-explorer/Organize/utils/helpers'
import { reshapeDirectoryTree } from '../../../../../../src/renderer/components/file-explorer/Organize/utils/reshape-directory-tree'
import { pathsToDirectoryNodes } from '../../../../../../src/renderer/components/file-explorer/Organize/utils/treeFromPaths'
import { VirtualDirectoryNode } from '@firefly/types'

describe('User Flow Diagnostic: 微调新增目录与是否勾选【不创建空目录】选项验证', () => {
  let db: Database.Database
  let vdirService: VirtualDirectoryService

  beforeEach(() => {
    db = new Database(':memory:')
    db.function('decompress_text', (val) => val)
    db.function('compress_text', (val) => val)
    db.exec(GENESIS_V1_SCHEMA)
    vdirService = new VirtualDirectoryService(db)

    // 插入测试工作区与工作区文件
    db.prepare("INSERT INTO workspaces (workspace_id, name, path) VALUES (1, 'TestWS', 'D:/test')").run()
    db.prepare("INSERT INTO workspace_directories (id, workspace_id, name, path) VALUES (1, 1, 'test', 'D:/test')").run()

    const now = new Date().toISOString()
    // 插入两个测试文件
    db.prepare(
      'INSERT INTO files (file_fingerprint, smart_name, extension, size, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('fp_doc', '需求文档.docx', 'docx', 1024, now, now)
    db.prepare(
      'INSERT INTO workspace_files (id, workspace_id, directory_id, file_fingerprint, name, path, is_analyzed, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(101, 1, 1, 'fp_doc', '需求文档.docx', 'D:/test/需求文档.docx', 1, now, now)

    db.prepare(
      'INSERT INTO files (file_fingerprint, smart_name, extension, size, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('fp_lnk', '快捷方式.lnk', 'lnk', 512, now, now)
    db.prepare(
      'INSERT INTO workspace_files (id, workspace_id, directory_id, file_fingerprint, name, path, is_analyzed, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(102, 1, 1, 'fp_lnk', '快捷方式.lnk', 'D:/test/快捷方式.lnk', 1, now, now)
  })

  it('规则 1: 用户【未勾选】不创建空目录 (skipEmptyDirs=false) 时，所有空目录必须生成 .keep 占位并完整创建', async () => {
    const vdir = await vdirService.createFromStrategy(1, '保留空目录测试', 'blueprint', 'identity-blueprint')

    const blueprintPaths = ['01-需求文档/PRD文档', '02-设计稿', '03-交付文件']
    const outlineTree = pathsToDirectoryNodes(blueprintPaths)
    const newChildNode: VirtualDirectoryNode = {
      name: '06-快捷方式',
      files: [],
      subdirectories: [],
      fileCount: 0,
      parent: null,
      totalSize: 0
    }
    const draftTree = [...outlineTree, newChildNode]

    const filesMap = {
      101: { id: 101, name: '需求文档.docx', size: 1024, fileFingerprint: 'fp_doc' },
      102: { id: 102, name: '快捷方式.lnk', size: 512, fileFingerprint: 'fp_lnk' }
    }
    // 只有 01-需求文档 和 06-快捷方式 分配到了文件；02-设计稿 和 03-交付文件 为纯空目录
    const rawMatches = {
      101: [{ path: '01-需求文档/PRD文档', score: 0.8 }],
      102: [{ path: '06-快捷方式', score: 0.9 }]
    }

    const reshaped = reshapeDirectoryTree({
      baseTreeOutline: draftTree,
      rawMatches,
      filesMap,
      y: 0.4,
      n: 1
    })

    // skipEmptyDirs=false：直接同步整棵树（包含空目录）
    await vdirService.syncIncrementalDirectoryTree(vdir.id, reshaped.tree)

    const snapshot = await vdirService.getTreeSnapshotAsTree(vdir.id)
    const rootDirNames = snapshot.tree.map(n => n.name)

    // 空目录 02-设计稿 与 03-交付文件 完整保留并创建！
    expect(rootDirNames).toContain('01-需求文档')
    expect(rootDirNames).toContain('02-设计稿')
    expect(rootDirNames).toContain('03-交付文件')
    expect(rootDirNames).toContain('06-快捷方式')
  })

  it('规则 2: 用户【勾选】了不创建空目录 (skipEmptyDirs=true) 时，任何纯空目录绝不创建，仅创建有文件的目录', async () => {
    const vdir = await vdirService.createFromStrategy(1, '不创建空目录测试', 'blueprint', 'identity-blueprint')

    const blueprintPaths = ['01-需求文档/PRD文档', '02-设计稿', '03-交付文件']
    const outlineTree = pathsToDirectoryNodes(blueprintPaths)
    const newChildNode: VirtualDirectoryNode = {
      name: '06-快捷方式',
      files: [],
      subdirectories: [],
      fileCount: 0,
      parent: null,
      totalSize: 0
    }
    const draftTree = [...outlineTree, newChildNode]

    const filesMap = {
      101: { id: 101, name: '需求文档.docx', size: 1024, fileFingerprint: 'fp_doc' },
      102: { id: 102, name: '快捷方式.lnk', size: 512, fileFingerprint: 'fp_lnk' }
    }
    // 01-需求文档 和 06-快捷方式 有文件；02-设计稿 和 03-交付文件 为空
    const rawMatches = {
      101: [{ path: '01-需求文档/PRD文档', score: 0.8 }],
      102: [{ path: '06-快捷方式', score: 0.9 }]
    }

    const reshaped = reshapeDirectoryTree({
      baseTreeOutline: draftTree,
      rawMatches,
      filesMap,
      y: 0.4,
      n: 1
    })

    // skipEmptyDirs=true：过滤空目录后再同步/保存
    const filteredTree = filterEmptyDirectoryNodes(reshaped.tree)
    await vdirService.syncIncrementalDirectoryTree(vdir.id, filteredTree)

    const snapshot = await vdirService.getTreeSnapshotAsTree(vdir.id)
    const rootDirNames = snapshot.tree.map(n => n.name)

    // 有文件的目录被创建
    expect(rootDirNames).toContain('01-需求文档')
    expect(rootDirNames).toContain('06-快捷方式')

    // 空目录 02-设计稿 与 03-交付文件 绝不创建！
    expect(rootDirNames).not.toContain('02-设计稿')
    expect(rootDirNames).not.toContain('03-交付文件')
  })

  it('规则 3: 滑块拉高全员落入未归类时，根据 skipEmptyDirs 选项决定是否保留空大纲目录', async () => {
    const vdirKeep = await vdirService.createFromStrategy(1, '滑块全未归类-保留大纲', 'blueprint', 'identity-blueprint')
    const vdirSkip = await vdirService.createFromStrategy(1, '滑块全未归类-不保留大纲', 'blueprint', 'identity-blueprint')

    const draftTree = pathsToDirectoryNodes(['01-文档', '02-设计'])
    const filesMap = {
      101: { id: 101, name: '需求文档.docx', size: 1024, fileFingerprint: 'fp_doc' }
    }
    const rawMatches = {
      101: [{ path: '01-文档', score: 0.2 }]
    }

    // 及格线拉到 0.8，导致文件落入未归类
    const reshaped = reshapeDirectoryTree({
      baseTreeOutline: draftTree,
      rawMatches,
      filesMap,
      y: 0.8,
      n: 1
    })

    // 分支 A: skipEmptyDirs = false（未勾选）-> 大纲目录保留
    await vdirService.syncIncrementalDirectoryTree(vdirKeep.id, reshaped.tree)
    const snapshotKeep = await vdirService.getTreeSnapshotAsTree(vdirKeep.id)
    const namesKeep = snapshotKeep.tree.map(n => n.name)
    expect(namesKeep).toContain('01-文档')
    expect(namesKeep).toContain('02-设计')
    expect(namesKeep).toContain('未归类')

    // 分支 B: skipEmptyDirs = true（勾选）-> 空大纲目录全部被过滤，仅剩未归类
    const filtered = filterEmptyDirectoryNodes(reshaped.tree)
    await vdirService.syncIncrementalDirectoryTree(vdirSkip.id, filtered)
    const snapshotSkip = await vdirService.getTreeSnapshotAsTree(vdirSkip.id)
    const namesSkip = snapshotSkip.tree.map(n => n.name)
    expect(namesSkip).not.toContain('01-文档')
    expect(namesSkip).not.toContain('02-设计')
    expect(namesSkip).toContain('未归类')
  })

  it('规则 4: exportTreeToFiles 的 skipEmptyDirs 参数控制', () => {
    const tree: VirtualDirectoryNode[] = [
      {
        name: '01-空目录',
        files: [],
        subdirectories: [],
        fileCount: 0,
        parent: null,
        totalSize: 0
      },
      {
        name: '02-有文件目录',
        files: [{ fileId: 101, name: 'a.txt', size: 100 } as any],
        subdirectories: [],
        fileCount: 1,
        parent: null,
        totalSize: 100
      }
    ]
    const fallbackFile = { fileId: 101, fileFingerprint: 'fp101' }

    // 默认 skipEmptyDirs = false
    const filesWithKeep = exportTreeToFiles(tree, fallbackFile, false)
    expect(filesWithKeep.some(f => f.relativePath === '01-空目录/.keep')).toBe(true)

    // skipEmptyDirs = true
    const filesWithoutKeep = exportTreeToFiles(tree, fallbackFile, true)
    expect(filesWithoutKeep.some(f => f.relativePath === '01-空目录/.keep')).toBe(false)
    expect(filesWithoutKeep.some(f => f.relativePath.startsWith('02-有文件目录/'))).toBe(true)
  })
})
