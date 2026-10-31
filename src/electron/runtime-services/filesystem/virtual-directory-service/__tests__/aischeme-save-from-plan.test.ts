import { describe, it, expect, vi } from 'vitest'
import '../../../../../../pro/tests/mocks/electron-mock'
import { AISchemeGenerator, type AISchemeProvider } from '../AISchemeGenerator'

describe('AISchemeGenerator.saveFromPlan 智能聚类方案保存为虚拟目录', () => {
  it('应当正确保存多级嵌套目录树，保留所有层级结构及对应的文件相对路径', async () => {
    let capturedFiles: any[] = []

    const mockDb: any = {
      prepare: vi.fn((sql: string) => ({
        get: (fileId: number) => ({ file_fingerprint: `fp_${fileId}` })
      }))
    }

    const mockProvider: AISchemeProvider = {
      db: mockDb,
      createFromStrategy: vi.fn(async (_wsId, name) => ({
        id: 100,
        workspaceId: 1,
        name,
        source: 'ai_skill',
        fileCount: 0,
        createdAt: new Date(),
        updatedAt: new Date()
      } as any)),
      replaceFiles: vi.fn(async (_vdId, files) => {
        capturedFiles = files
      }),
      get: vi.fn(),
      getDimensionGroups: vi.fn()
    }

    const generator = new AISchemeGenerator(mockProvider)

    // 模拟智能聚类预览生成的典型多级嵌套目录树：
    // - 根目录 1: "工作文档" -> 子目录: "合同协议" (1 文件), "财务报表" (1 文件)
    // - 根目录 2: "多媒体素材" -> 直接包含 1 文件
    const nestedStructure: any = {
      summary: '端侧 HAC 智能聚类生成',
      directories: [
        {
          id: '工作文档',
          name: '工作文档',
          parent: '',
          subdirectories: [
            {
              id: '工作文档/合同协议',
              name: '合同协议',
              parent: '工作文档',
              subdirectories: [],
              files: [{ id: 1, name: '2026采购合同.pdf' }],
              fileCount: 1
            },
            {
              id: '工作文档/财务报表',
              name: '财务报表',
              parent: '工作文档',
              subdirectories: [],
              files: [{ id: 2, name: 'Q1报表.xlsx' }],
              fileCount: 1
            }
          ],
          files: [],
          fileCount: 2
        },
        {
          id: '多媒体素材',
          name: '多媒体素材',
          parent: '',
          subdirectories: [],
          files: [{ id: 3, name: '背景音乐.mp3' }],
          fileCount: 1
        }
      ]
    }

    await generator.saveFromPlan(1, '智能聚类整理_测试', nestedStructure)

    // 1. 验证被保存的文件总数不遗漏
    expect(capturedFiles.length).toBe(3)

    // 2. 提取所有文件的相对路径
    const relativePaths = capturedFiles.map(f => f.relativePath).sort()

    // 3. 验证多级目录层级没有丢失（不是只有一级）
    expect(relativePaths).toEqual([
      '多媒体素材/背景音乐.mp3',
      '工作文档/合同协议/2026采购合同.pdf',
      '工作文档/财务报表/Q1报表.xlsx'
    ].sort())

    // 4. 验证根目录数量与预览一致（包含了工作文档与多媒体素材，共 2 个根目录）
    const rootDirNames = new Set(relativePaths.map(p => p.split('/')[0]))
    expect(Array.from(rootDirNames).sort()).toEqual(['多媒体素材', '工作文档'].sort())
  })

  it('应当为无文件的空叶子目录自动生成 .keep 占位文件，防止目录树截断消失', async () => {
    let capturedFiles: any[] = []

    const mockDb: any = {
      prepare: vi.fn((sql: string) => ({
        get: (fileId: number) => ({ file_fingerprint: `fp_${fileId}` })
      }))
    }

    const mockProvider: AISchemeProvider = {
      db: mockDb,
      createFromStrategy: vi.fn(async (_wsId, name) => ({
        id: 101,
        workspaceId: 1,
        name,
        source: 'ai_skill',
        fileCount: 0,
        createdAt: new Date(),
        updatedAt: new Date()
      } as any)),
      replaceFiles: vi.fn(async (_vdId, files) => {
        capturedFiles = files
      }),
      get: vi.fn(),
      getDimensionGroups: vi.fn()
    }

    const generator = new AISchemeGenerator(mockProvider)

    const structureWithEmptyDir: any = {
      summary: '测试空目录占位',
      directories: [
        {
          id: '项目归档',
          name: '项目归档',
          parent: '',
          subdirectories: [
            {
              id: '项目归档/已完成项目',
              name: '已完成项目',
              parent: '项目归档',
              subdirectories: [],
              files: [{ id: 10, name: '总结报告.docx' }],
              fileCount: 1
            },
            {
              id: '项目归档/待归档暂存',
              name: '待归档暂存',
              parent: '项目归档',
              subdirectories: [],
              files: [],
              fileCount: 0
            }
          ],
          files: [],
          fileCount: 1
        }
      ]
    }

    await generator.saveFromPlan(1, '空目录测试', structureWithEmptyDir)

    const relativePaths = capturedFiles.map(f => f.relativePath).sort()
    expect(relativePaths).toEqual([
      '项目归档/已完成项目/总结报告.docx',
      '项目归档/待归档暂存/.keep'
    ].sort())
  })

  it('应当向后兼容扁平列表加 parent 指针的传统 AI 规划结构', async () => {
    let capturedFiles: any[] = []

    const mockDb: any = {
      prepare: vi.fn((sql: string) => ({
        get: (fileId: number) => ({ file_fingerprint: `fp_${fileId}` })
      }))
    }

    const mockProvider: AISchemeProvider = {
      db: mockDb,
      createFromStrategy: vi.fn(async (_wsId, name) => ({
        id: 102,
        workspaceId: 1,
        name,
        source: 'ai_skill',
        fileCount: 0,
        createdAt: new Date(),
        updatedAt: new Date()
      } as any)),
      replaceFiles: vi.fn(async (_vdId, files) => {
        capturedFiles = files
      }),
      get: vi.fn(),
      getDimensionGroups: vi.fn()
    }

    const generator = new AISchemeGenerator(mockProvider)

    const flatStructure: any = {
      summary: '旧扁平 AI 结构',
      directories: [
        {
          id: 'dir_root',
          name: '开发工程',
          parent: '',
          files: []
        },
        {
          id: 'dir_sub',
          name: '前端源码',
          parent: 'dir_root',
          files: [{ fileId: 20, name: 'App.tsx' }]
        }
      ]
    }

    await generator.saveFromPlan(1, '扁平兼容测试', flatStructure)

    const relativePaths = capturedFiles.map(f => f.relativePath)
    expect(relativePaths).toEqual(['开发工程/前端源码/App.tsx'])
  })
})
