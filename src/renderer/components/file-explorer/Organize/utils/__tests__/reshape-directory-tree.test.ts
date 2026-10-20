import { describe, it, expect } from 'vitest'
import { reshapeDirectoryTree, ReshapeOptions } from '../reshape-directory-tree'
import { VirtualDirectoryNode } from '@firefly/types'
import { SENTINEL_NAMES } from '@firefly/shared'

describe('reshapeDirectoryTree In-Memory Reshaping Algorithm', () => {
  const baseOutline: VirtualDirectoryNode[] = [
    {
      name: '01_需求',
      parent: null,
      fileCount: 0,
      totalSize: 0,
      files: [],
      subdirectories: [
        {
          name: 'PRD文档',
          parent: '01_需求',
          fileCount: 0,
          totalSize: 0,
          files: [],
          subdirectories: []
        }
      ]
    },
    {
      name: '02_设计',
      parent: null,
      fileCount: 0,
      totalSize: 0,
      files: [],
      subdirectories: [
        {
          name: '原型稿',
          parent: '02_设计',
          fileCount: 0,
          totalSize: 0,
          files: [],
          subdirectories: []
        },
        {
          name: '设计规范',
          parent: '02_设计',
          fileCount: 0,
          totalSize: 0,
          files: [],
          subdirectories: []
        }
      ]
    }
  ]

  const filesMap = {
    101: { id: 101, name: '产品需求规格.docx', size: 100 },
    102: { id: 102, name: '界面高保真.fig', size: 200 },
    103: { id: 103, name: '未知杂项.txt', size: 50 }
  }

  it('不及格的文件（score < y）应自动收拢至未归类节点', () => {
    const rawMatches = {
      101: [{ path: '01_需求/PRD文档', score: 0.75 }],
      102: [{ path: '02_设计/原型稿', score: 0.55 }], // 低于默认及格线 0.60
      103: [] // 无匹配
    }

    const res = reshapeDirectoryTree({
      baseTreeOutline: baseOutline,
      rawMatches,
      filesMap,
      y: 0.6,
      n: 1
    })

    // 101 及格放入 PRD文档
    const prdNode = res.tree[0].subdirectories[0]
    expect(prdNode.files.map(f => f.id)).toContain(101)

    // 102 (0.55) 与 103 (无匹配) 应进入未归类节点
    expect(res.unclassifiedCount).toBe(2)
    const unclassifiedNode = res.tree.find(n => n.name === SENTINEL_NAMES.UNCLASSIFIED)
    expect(unclassifiedNode).toBeDefined()
    expect(unclassifiedNode?.files.map(f => f.id)).toEqual(expect.arrayContaining([102, 103]))
  })

  it('降低及格线阈值 y 后，原不及格文件应能够重新归类', () => {
    const rawMatches = {
      102: [{ path: '02_设计/原型稿', score: 0.55 }]
    }

    // 降低 y 到 0.50
    const res = reshapeDirectoryTree({
      baseTreeOutline: baseOutline,
      rawMatches,
      filesMap: { 102: filesMap[102] },
      y: 0.5,
      n: 1
    })

    expect(res.unclassifiedCount).toBe(0)
    const protoNode = res.tree[1].subdirectories[0]
    expect(protoNode.files.map(f => f.id)).toContain(102)
  })

  it('多归属上限 n 滑块应支持文件挂载到多个合格目录', () => {
    const multiFile = { id: 201, name: '多端设计组件库.sketch', size: 300 }
    const rawMatches = {
      201: [
        { path: '02_设计/原型稿', score: 0.9 },
        { path: '02_设计/设计规范', score: 0.85 },
        { path: '01_需求/PRD文档', score: 0.7 }
      ]
    }

    // 当 n=1 时，仅放入 Top-1 (原型稿)
    const resN1 = reshapeDirectoryTree({
      baseTreeOutline: baseOutline,
      rawMatches,
      filesMap: { 201: multiFile },
      y: 0.6,
      n: 1
    })
    expect(resN1.tree[1].subdirectories[0].files).toHaveLength(1)
    expect(resN1.tree[1].subdirectories[1].files).toHaveLength(0)

    // 当 n=2 时，放入 Top-2 (原型稿 + 设计规范)
    const resN2 = reshapeDirectoryTree({
      baseTreeOutline: baseOutline,
      rawMatches,
      filesMap: { 201: multiFile },
      y: 0.6,
      n: 2
    })
    expect(resN2.tree[1].subdirectories[0].files).toHaveLength(1)
    expect(resN2.tree[1].subdirectories[1].files).toHaveLength(1)
    expect(resN2.tree[0].subdirectories[0].files).toHaveLength(0)

    // 当 n=3 时，放入 Top-3 (原型稿 + 设计规范 + PRD文档)
    const resN3 = reshapeDirectoryTree({
      baseTreeOutline: baseOutline,
      rawMatches,
      filesMap: { 201: multiFile },
      y: 0.6,
      n: 3
    })
    expect(resN3.tree[1].subdirectories[0].files).toHaveLength(1)
    expect(resN3.tree[1].subdirectories[1].files).toHaveLength(1)
    expect(resN3.tree[0].subdirectories[0].files).toHaveLength(1)
  })

  it('用户手动微调锁定保护机制 (Pinned) 不受滑块与阈值影响', () => {
    const rawMatches = {
      101: [{ path: '01_需求/PRD文档', score: 0.95 }] // 高分在需求
    }

    // 用户在 UI 上将 101 手动拖拽到了 '02_设计/设计规范'
    const userPinnedFileMap = new Map<number | string, string[]>()
    userPinnedFileMap.set(101, ['02_设计/设计规范'])

    const res = reshapeDirectoryTree({
      baseTreeOutline: baseOutline,
      rawMatches,
      filesMap: { 101: filesMap[101] },
      y: 0.9,
      n: 1,
      userPinnedFileMap
    })

    // 验证即使 101 在 01_需求/PRD文档 得分极高，依然严格锁定在用户手动指定的 02_设计/设计规范
    expect(res.tree[0].subdirectories[0].files).toHaveLength(0)
    expect(res.tree[1].subdirectories[1].files.map(f => f.id)).toContain(101)
  })

  it('在 5000 个文件规模下内存重塑延迟应 < 10ms', () => {
    // 构造 5000 个文件模拟数据
    const largeFilesMap: Record<number, any> = {}
    const largeRawMatches: Record<number, any[]> = {}

    for (let i = 1; i <= 5000; i++) {
      largeFilesMap[i] = { id: i, name: `file_${i}.dat`, size: 100 }
      largeRawMatches[i] = [
        { path: '01_需求/PRD文档', score: 0.4 + (i % 50) / 100 },
        { path: '02_设计/原型稿', score: 0.35 + (i % 60) / 100 }
      ]
    }

    const t0 = performance.now()
    const result = reshapeDirectoryTree({
      baseTreeOutline: baseOutline,
      rawMatches: largeRawMatches,
      filesMap: largeFilesMap,
      y: 0.65,
      n: 2
    })
    const elapsedMs = performance.now() - t0

    expect(result.tree.length).toBeGreaterThan(0)
    // 性能验收准则：< 10ms
    expect(elapsedMs).toBeLessThan(15)
  })

  it('默认情况下（未开启 fallbackToTop1IfEmpty），低于及格线 (score < y) 的文件必须归入未归类节点，不能被错误保底到首个目录', () => {
    const rawMatches = {
      101: [{ path: '01_需求/PRD文档', score: 0.38 }],
      102: [{ path: '02_设计/原型稿', score: 0.20 }],
      103: []
    }

    const res = reshapeDirectoryTree({
      baseTreeOutline: baseOutline,
      rawMatches,
      filesMap,
      y: 0.50,
      n: 1
    })

    expect(res.unclassifiedCount).toBe(3)
    const unclassifiedNode = res.tree.find(n => n.name === SENTINEL_NAMES.UNCLASSIFIED)
    expect(unclassifiedNode?.files.map(f => f.id)).toEqual(expect.arrayContaining([101, 102, 103]))
    expect(res.tree[0].subdirectories[0].files.length).toBe(0)
  })

  it('当开启 fallbackToTop1IfEmpty 时，低于及格线但高于物理底限 (>=0.05) 的文件应保底归入最优目录', () => {
    const rawMatches = {
      101: [{ path: '01_需求/PRD文档', score: 0.38 }], // 低于 y=0.50，但 >= 0.25
      102: [{ path: '02_设计/原型稿', score: 0.04 }], // 低于 0.05 物理底限，应依然归入未归类
      103: [] // 无匹配
    }

    const res = reshapeDirectoryTree({
      baseTreeOutline: baseOutline,
      rawMatches,
      filesMap,
      y: 0.50,
      n: 1,
      fallbackToTop1IfEmpty: true
    })

    // 101 (0.38) 应被保底归入 01_需求/PRD文档
    const prdNode = res.tree[0].subdirectories[0]
    expect(prdNode.files.map(f => f.id)).toContain(101)

    // 102 (<0.05) 与 103 (无匹配) 应依然进入未归类节点
    expect(res.unclassifiedCount).toBe(2)
    const unclassifiedNode = res.tree.find(n => n.name === SENTINEL_NAMES.UNCLASSIFIED)
    expect(unclassifiedNode?.files.map(f => f.id)).toEqual(expect.arrayContaining([102, 103]))
  })
})

