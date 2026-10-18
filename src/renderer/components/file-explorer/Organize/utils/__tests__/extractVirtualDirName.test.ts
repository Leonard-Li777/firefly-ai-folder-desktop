import { describe, it, expect } from 'vitest'
import { extractVirtualDirName, parseStrategyToTree } from '../helpers'

describe('extractVirtualDirName & parseStrategyToTree 方案命名与树形结构解析', () => {
  it('应当正确提取中文冒号格式的虚拟目录名称，并返回纯净策略内容', () => {
    const raw = `虚拟目录名称：研发设计素材
- 研发项目
  - 核心架构
  - 前端设计
- 素材资源
  - 图标库
  - 规范文档`

    const result = extractVirtualDirName(raw)
    expect(result.name).toBe('研发设计素材')
    expect(result.cleanStrategy).toBe(`- 研发项目
  - 核心架构
  - 前端设计
- 素材资源
  - 图标库
  - 规范文档`)
  })

  it('应当正确提取 Markdown 标题和英文冒号的方案名称', () => {
    const raw = `### 虚拟目录名: 财务2025归档
- 财务文档
  - 报销凭证
  - 审计报表`

    const result = extractVirtualDirName(raw)
    expect(result.name).toBe('财务2025归档')
    expect(result.cleanStrategy).toBe(`- 财务文档
  - 报销凭证
  - 审计报表`)
  })

  it('应当支持提取被 Markdown 代码块包裹的内容并提取首行名称', () => {
    const raw = `好的，为您规划了以下方案：
\`\`\`markdown
虚拟目录名称：办公综合
- 办公综合
  - 行政人事
  - 财务法务
\`\`\`
希望对您有帮助！`

    const result = extractVirtualDirName(raw)
    expect(result.name).toBe('办公综合')
    expect(result.cleanStrategy).toBe(`- 办公综合
  - 行政人事
  - 财务法务`)
  })

  it('未提供虚拟目录名称前缀时应当平稳降级，name 为 undefined 且返回原始正文', () => {
    const raw = `- 个人文档
  - 读书笔记
  - 旅行照片`

    const result = extractVirtualDirName(raw)
    expect(result.name).toBeUndefined()
    expect(result.cleanStrategy).toBe(raw)
  })

  it('parseStrategyToTree 应当正确解析带有首行虚拟目录名的 Markdown 树', () => {
    const raw = `虚拟目录名称：设计资料
- 设计资料
  - UI原型
  - 图标资产`

    const tree = parseStrategyToTree(raw)
    expect(tree).not.toBeNull()
    expect(tree?.length).toBe(1)
    expect(tree?.[0].name).toBe('设计资料')
    expect(tree?.[0].subdirectories.length).toBe(2)
    expect(tree?.[0].subdirectories.map(s => s.name)).toEqual(['UI原型', '图标资产'])
  })

  it('parseStrategyToTree 修复验证：首行无制表符的根目录名紧随制表树形时不应被误跳过过滤', () => {
    const raw = `我的核心项目
├── 前端工程
│   └── 页面组件
└── 后端服务
    └── 接口服务`

    const tree = parseStrategyToTree(raw)
    expect(tree).not.toBeNull()
    expect(tree?.length).toBe(1)
    expect(tree?.[0].name).toBe('我的核心项目')
    expect(tree?.[0].subdirectories.length).toBe(2)
    expect(tree?.[0].subdirectories.map(s => s.name)).toEqual(['前端工程', '后端服务'])
  })
})
