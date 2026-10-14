import { describe, it, expect } from 'vitest'
import { pathsToDirectoryNodes } from '../utils/treeFromPaths'

describe('pathsToDirectoryNodes', () => {
  it('处理空路径数组应返回空树', () => {
    const nodes = pathsToDirectoryNodes([])
    expect(nodes).toEqual([])
  })

  it('能正确将平铺规范路径拆分为树形结构', () => {
    const paths = [
      '01_需求/PRD文档',
      '01_需求/用户调研',
      '02_设计/高保真原型/移动端',
      '02_设计/高保真原型/桌面端',
      '03_归档'
    ]

    const nodes = pathsToDirectoryNodes(paths)
    expect(nodes).toHaveLength(3)

    const reqNode = nodes.find(n => n.name === '01_需求')
    expect(reqNode).toBeDefined()
    expect(reqNode?.subdirectories).toHaveLength(2)
    expect(reqNode?.subdirectories.map(s => s.name)).toEqual(['PRD文档', '用户调研'])

    const designNode = nodes.find(n => n.name === '02_设计')
    expect(designNode).toBeDefined()
    expect(designNode?.subdirectories).toHaveLength(1)
    expect(designNode?.subdirectories[0].name).toBe('高保真原型')
    expect(designNode?.subdirectories[0].subdirectories).toHaveLength(2)

    const archiveNode = nodes.find(n => n.name === '03_归档')
    expect(archiveNode).toBeDefined()
    expect(archiveNode?.subdirectories).toHaveLength(0)
  })

  it('能够兼容反斜杠路径分隔符', () => {
    const paths = ['项目资料\\合同', '项目资料\\发票']
    const nodes = pathsToDirectoryNodes(paths)
    expect(nodes).toHaveLength(1)
    expect(nodes[0].name).toBe('项目资料')
    expect(nodes[0].subdirectories).toHaveLength(2)
  })

  it('应正确设置 parent 与 parentKey 属性', () => {
    const paths = ['A/B/C']
    const nodes = pathsToDirectoryNodes(paths)
    expect(nodes[0].name).toBe('A')
    expect(nodes[0].parent).toBeNull()

    const nodeB = nodes[0].subdirectories[0]
    expect(nodeB.name).toBe('B')
    expect(nodeB.parent).toBe('A')

    const nodeC = nodeB.subdirectories[0]
    expect(nodeC.name).toBe('C')
    expect(nodeC.parent).toBe('A/B')
  })
})
