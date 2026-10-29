import { describe, it, expect } from 'vitest'
import { reshapeDirectoryTree } from '../reshape-directory-tree'
import { exportTreeToFiles } from '../exportTreeToFiles'
import { VirtualDirectoryNode } from '@firefly/types'
import { SENTINEL_NAMES } from '@firefly/shared'

describe('Organize Save Lifecycle Diagnostics', () => {
  // 模拟从身份蓝图生成的目录结构大纲
  const blueprintTree: VirtualDirectoryNode[] = [
    {
      name: '01-需求文档',
      parent: null,
      fileCount: 0,
      totalSize: 0,
      files: [],
      subdirectories: [
        {
          name: 'PRD文档',
          parent: '01-需求文档',
          fileCount: 0,
          totalSize: 0,
          files: [],
          subdirectories: []
        }
      ]
    },
    {
      name: '02-设计稿',
      parent: null,
      fileCount: 0,
      totalSize: 0,
      files: [],
      subdirectories: []
    }
  ]

  // 用户在目录微调阶段添加顶层根目录 06-快捷方式
  const newChildNode: VirtualDirectoryNode = {
    name: '06-快捷方式',
    files: [],
    subdirectories: [],
    fileCount: 0,
    parent: null,
    totalSize: 0
  }

  const modifiedDraftTree: VirtualDirectoryNode[] = [...blueprintTree, newChildNode]

  const filesMap = {
    101: { id: 101, name: '产品需求.docx', size: 100, fileFingerprint: 'fp101' },
    102: { id: 102, name: '系统快捷方式.lnk', size: 50, fileFingerprint: 'fp102' }
  }

  it('场景 1: 文件分别匹配到目录与微调目录，验证 exportTreeToFiles 的输出', () => {
    const rawMatches = {
      101: [{ path: '01-需求文档/PRD文档', score: 0.85 }],
      102: [{ path: '06-快捷方式', score: 0.90 }]
    }

    const reshaped = reshapeDirectoryTree({
      baseTreeOutline: modifiedDraftTree,
      rawMatches,
      filesMap,
      y: 0.4,
      n: 1
    })

    console.log('Reshaped Tree nodes:', reshaped.tree.map(n => ({ name: n.name, files: n.files.length, subs: n.subdirectories?.map(s => s.name) })))

    const fallbackFile = { fileId: 101, fileFingerprint: 'fp101' }
    const files = exportTreeToFiles(reshaped.tree, fallbackFile)

    console.log('Exported files:', files)

    expect(files.some(f => f.relativePath.startsWith('01-需求文档/PRD文档'))).toBe(true)
    expect(files.some(f => f.relativePath.startsWith('06-快捷方式'))).toBe(true)
    // 02-设计稿 是空目录，应该有 .keep
    expect(files.some(f => f.relativePath === '02-设计稿/.keep')).toBe(true)
  })

  it('场景 2: 如果所有文件得分都低于及格线 (如拖高相似度滑块到 0.95)', () => {
    const rawMatches = {
      101: [{ path: '01-需求文档/PRD文档', score: 0.50 }],
      102: [{ path: '06-快捷方式', score: 0.60 }]
    }

    const reshaped = reshapeDirectoryTree({
      baseTreeOutline: modifiedDraftTree,
      rawMatches,
      filesMap,
      y: 0.95, // 拖高及格线
      n: 1
    })

    console.log('Scene 2 Reshaped Tree nodes:', reshaped.tree.map(n => ({ name: n.name, files: n.files.length, subs: n.subdirectories?.map(s => s.name) })))

    const fallbackFile = { fileId: 101, fileFingerprint: 'fp101' }
    const files = exportTreeToFiles(reshaped.tree, fallbackFile)

    console.log('Scene 2 Exported files:', files)
  })
})
