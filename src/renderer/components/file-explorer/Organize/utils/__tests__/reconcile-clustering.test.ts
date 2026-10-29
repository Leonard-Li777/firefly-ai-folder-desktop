import { describe, it, expect } from 'vitest'
import { VirtualDirectoryNode } from '@firefly/types'
import { SENTINEL_NAMES } from '@firefly/shared'
import { reconcileClusteringWithUserEdits, getFileUniqueId } from '../reconcile-clustering'

describe('reconcileClusteringWithUserEdits', () => {
  const baseSampleTree: VirtualDirectoryNode[] = [
    {
      name: '财务中心',
      parent: null,
      fileCount: 2,
      totalSize: 100,
      files: [
        { id: 1, name: '报表1.xlsx', size: 50 },
        { id: 2, name: '报表2.xlsx', size: 50 }
      ],
      subdirectories: []
    },
    {
      name: '研发项目',
      parent: null,
      fileCount: 1,
      totalSize: 80,
      files: [{ id: 3, name: '架构.pdf', size: 80 }],
      subdirectories: []
    }
  ]

  it('无自定义操作时应原样返回目录结构', () => {
    const res = reconcileClusteringWithUserEdits(baseSampleTree)
    expect(res.map(n => n.name)).toEqual(['财务中心', '研发项目'])
    expect(res[0].fileCount).toBe(2)
  })

  it('应用用户新增的根目录与子目录，重算时不被抹去', () => {
    const customizations = {
      addedNodes: [
        {
          parentKey: '',
          name: '待归档文件',
          node: {
            name: '待归档文件',
            parent: null,
            fileCount: 0,
            totalSize: 0,
            files: [],
            subdirectories: []
          }
        },
        {
          parentKey: '财务中心',
          name: '2026预算',
          node: {
            name: '2026预算',
            parent: '财务中心',
            fileCount: 0,
            totalSize: 0,
            files: [],
            subdirectories: []
          }
        }
      ]
    }

    const res = reconcileClusteringWithUserEdits(baseSampleTree, customizations)
    expect(res.some(n => n.name === '待归档文件')).toBe(true)

    const finance = res.find(n => n.name === '财务中心')!
    expect(finance.subdirectories?.some(s => s.name === '2026预算')).toBe(true)
  })

  it('应用重命名，将新聚类树中对应目录更新为用户最新指定的名称', () => {
    const customizations = {
      renamedNodes: new Map([['财务中心', '公司财务总账']])
    }

    const res = reconcileClusteringWithUserEdits(baseSampleTree, customizations)
    expect(res.some(n => n.name === '公司财务总账')).toBe(true)
    expect(res.some(n => n.name === '财务中心')).toBe(false)
    const renamed = res.find(n => n.name === '公司财务总账')!
    expect(renamed.files?.map(f => f.name)).toEqual(['报表1.xlsx', '报表2.xlsx'])
  })

  it('应用删除，被删除的目录不复活，其名下文件收拢至未归类节点', () => {
    const customizations = {
      deletedNodeKeys: new Set(['研发项目'])
    }

    const res = reconcileClusteringWithUserEdits(baseSampleTree, customizations)
    expect(res.some(n => n.name === '研发项目')).toBe(false)
    const unclassified = res.find(n => n.name === SENTINEL_NAMES.UNCLASSIFIED)!
    expect(unclassified).toBeDefined()
    expect(unclassified.files?.some(f => f.name === '架构.pdf')).toBe(true)
  })

  it('应用锁定移动的文件 (Pinned Files)，文件固定在目标目录且全局不重复', () => {
    const movedFile = { id: 1, name: '报表1.xlsx', size: 50 }
    const customizations = {
      addedNodes: [
        {
          parentKey: '',
          name: '特别审计',
          node: {
            name: '特别审计',
            parent: null,
            fileCount: 0,
            totalSize: 0,
            files: [],
            subdirectories: []
          }
        }
      ],
      pinnedFiles: new Map([['1', { file: movedFile, targetNodeKey: '特别审计' }]])
    }

    const res = reconcileClusteringWithUserEdits(baseSampleTree, customizations)
    const audit = res.find(n => n.name === '特别审计')!
    const finance = res.find(n => n.name === '财务中心')!

    expect(audit.files?.some(f => f.id === 1)).toBe(true)
    expect(finance.files?.some(f => f.id === 1)).toBe(false)
    expect(audit.fileCount).toBe(1)
    expect(finance.fileCount).toBe(1)
  })
  it('getFileUniqueId 能利用物理路径有效区分不同目录下的同名文件，避免误判与蒸发 (ISS-05)', () => {
    const file1 = { name: 'README.md', filePath: 'C:/projectA/README.md' }
    const file2 = { name: 'README.md', filePath: 'C:/projectB/README.md' }
    expect(getFileUniqueId(file1)).not.toBe(getFileUniqueId(file2))
    expect(getFileUniqueId(file1)).toBe('C:/projectA/README.md')
  })

  it('应用层级重命名时，子目录与父目录同时改名能通过双轨 rawKey 准确命中 (ISS-01)', () => {
    const nestedTree: VirtualDirectoryNode[] = [
      {
        name: '项目A',
        parent: null,
        fileCount: 1,
        totalSize: 10,
        files: [],
        subdirectories: [
          {
            name: '文档',
            parent: '项目A',
            fileCount: 1,
            totalSize: 10,
            files: [{ id: 10, name: 'doc.md' }],
            subdirectories: []
          }
        ]
      }
    ]

    const customizations = {
      renamedNodes: new Map([
        ['项目A', '核心项目A'],
        ['项目A/文档', '设计技术文档']
      ])
    }

    const res = reconcileClusteringWithUserEdits(nestedTree, customizations)
    expect(res[0].name).toBe('核心项目A')
    expect(res[0].subdirectories?.[0].name).toBe('设计技术文档')
  })

  it('自定义新增目录挂载为空骨架，文件锁定后自动打上 isPinned: true 标识 (ISS-06, ISS-09)', () => {
    const movedFile = { id: 100, name: '合同.pdf', size: 200 }
    const customizations = {
      addedNodes: [
        {
          parentKey: '',
          name: '法务审计',
          node: {
            name: '法务审计',
            parent: null,
            fileCount: 99,
            totalSize: 9999,
            files: [{ id: 999, name: '旧残留.txt' }], // 模拟脏历史快照
            subdirectories: []
          }
        }
      ],
      pinnedFiles: new Map([['100', { file: movedFile, targetNodeKey: '法务审计' }]])
    }

    const res = reconcileClusteringWithUserEdits(baseSampleTree, customizations)
    const legalNode = res.find(n => n.name === '法务审计')!
    expect(legalNode).toBeDefined()
    // 验证历史快照残留已被阶段 3 强制剔除
    expect(legalNode.files?.some(f => f.name === '旧残留.txt')).toBe(false)
    // 验证由阶段 4 精准注入锁定文件并打上 isPinned 标识
    expect(legalNode.files?.some(f => f.id === 100)).toBe(true)
    const pinnedFile = legalNode.files?.find(f => f.id === 100)
    expect(pinnedFile?.isPinned).toBe(true)
    expect(legalNode.fileCount).toBe(1)
  })

})
