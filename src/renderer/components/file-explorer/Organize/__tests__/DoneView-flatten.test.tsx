/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React, { useState } from 'react'
import { render, fireEvent } from '@testing-library/react'
import { DoneView } from '../components/DoneView'
import { flattenDirectoriesToRoot, mergeRescueResult } from '../utils/helpers'
import { SENTINEL_NAMES } from '@firefly/shared'
import { useOrganizeStore } from '../../../../stores/organize-store'
import { VirtualDirectoryNode } from '@firefly/types'
import { OrganizeOptions } from '../types'

const { mockT } = vi.hoisted(() => {
  const tFn = (key: string, params?: any) => {
    if (params && typeof params === 'object') {
      let res = key
      for (const k in params) {
        res = res.replace(new RegExp('\\{' + k + '\\}', 'g'), params[k])
      }
      return res
    }
    return key
  }
  return { mockT: tFn }
})

vi.mock('@app/languages', () => ({
  t: mockT,
  $t: (key: string) => key,
  Translate: ({ children }: any) => children,
  i18nScope: { t: mockT, activeLanguage: 'zh-CN', defaultLanguage: 'zh-CN' },
  default: { t: mockT, activeLanguage: 'zh-CN', defaultLanguage: 'zh-CN' }
}))

vi.mock('@voerkai18n/react', () => ({
  useVoerkaI18n: () => ({ t: mockT, activeLanguage: 'zh-CN', defaultLanguage: 'zh-CN' })
}))

vi.mock('../../../../stores/settings-store', () => {
  const mockStore: any = (selector?: any) => {
    const state = { getConfigValue: () => false }
    return selector ? selector(state) : state
  }
  mockStore.getState = () => ({ getConfigValue: () => false })
  return { useSettingsStore: mockStore }
})

vi.mock('../../../common/FileTypeIcon', () => ({
  FileTypeIcon: () => <span data-testid="file-icon" />,
  extractFileExtension: () => 'pdf'
}))

let capturedVDirTreeNodes: VirtualDirectoryNode[] = []
vi.mock('../components/VDirTree', async () => {
  const actual: any = await vi.importActual('../components/VDirTree')
  const RealVDirTree = actual.VDirTree
  return {
    ...actual,
    VDirTree: (props: any) => {
      capturedVDirTreeNodes = props.nodes
      return <RealVDirTree {...props} />
    }
  }
})

describe('DoneView 平铺到根目录：取消目录嵌套层级，将嵌套子目录提升到根目录', () => {
  const multiLevelTree: VirtualDirectoryNode[] = [
    {
      name: '技术资料',
      fileCount: 2,
      files: [],
      subdirectories: [
        {
          name: '后端文档',
          fileCount: 2,
          files: [
            {
              id: 1,
              fileId: 1,
              name: '架构设计.pdf',
              smartName: '架构设计.pdf',
              path: '/workspace/架构设计.pdf',
              originalPath: '/workspace/架构设计.pdf'
            } as any
          ],
          subdirectories: [
            {
              name: '数据库',
              fileCount: 1,
              files: [
                {
                  id: 2,
                  fileId: 2,
                  name: '数据库规范.md',
                  smartName: '数据库规范.md',
                  path: '/workspace/数据库规范.md',
                  originalPath: '/workspace/数据库规范.md'
                } as any
              ],
              subdirectories: []
            }
          ]
        }
      ]
    },
    {
      name: '项目归档',
      fileCount: 1,
      files: [
        {
          id: 3,
          fileId: 3,
          name: '复盘报告.docx',
          smartName: '复盘报告.docx',
          path: '/workspace/复盘报告.docx',
          originalPath: '/workspace/复盘报告.docx'
        } as any
      ],
      subdirectories: []
    }
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    capturedVDirTreeNodes = []
    useOrganizeStore.setState({
      thresholdScore: 0.4,
      maxCandidatesPerFile: 1,
      rawMatches: {},
      filesMap: {},
      draftTree: [],
      userPinnedFileMap: new Map()
    })
  })

  function DoneViewHarness() {
    const [options, setOptions] = useState<OrganizeOptions>({
      flattenToRoot: false,
      skipEmptyDirs: false,
      allowCreateNew: false
    } as any)

    return (
      <DoneView
        tree={multiLevelTree}
        organizeMode="identity-blueprint"
        onReorganize={vi.fn()}
        onRescue={vi.fn()}
        hasRescueFailed={false}
        draft={{ name: '测试方案', strategy: '', source: 'identity-blueprint' }}
        candidate={null}
        options={options}
        setOptions={setOptions}
      />
    )
  }

  it('勾选「平铺到根目录」后，所有嵌套子目录均提升为根目录且各自保留文件；配合「不生成空目录」滤除空父目录；取消勾选后恢复嵌套层级', () => {
    const { getByText, queryByText } = render(<DoneViewHarness />)

    // 1. 初始未勾选：保留 3 层嵌套结构
    expect(capturedVDirTreeNodes.map(n => n.name)).toEqual(['技术资料', '项目归档'])
    expect(capturedVDirTreeNodes[0].subdirectories.map(n => n.name)).toEqual(['后端文档'])
    expect(capturedVDirTreeNodes[0].subdirectories[0].subdirectories.map(n => n.name)).toEqual([
      '数据库'
    ])

    // 2. 勾选「平铺到根目录」：所有嵌套子目录全部提升到顶层，且无 subdirectories 嵌套
    const flattenLabel = getByText('平铺到根目录')
    fireEvent.click(flattenLabel)

    expect(capturedVDirTreeNodes.map(n => n.name)).toEqual([
      '技术资料',
      '后端文档',
      '数据库',
      '项目归档'
    ])
    expect(capturedVDirTreeNodes.every(n => (n.subdirectories || []).length === 0)).toBe(true)
    expect(capturedVDirTreeNodes.find(n => n.name === '后端文档')?.files.map(f => f.name)).toEqual([
      '架构设计.pdf'
    ])
    expect(capturedVDirTreeNodes.find(n => n.name === '数据库')?.files.map(f => f.name)).toEqual([
      '数据库规范.md'
    ])
    expect(capturedVDirTreeNodes.find(n => n.name === '项目归档')?.files.map(f => f.name)).toEqual([
      '复盘报告.docx'
    ])
    expect(getByText('架构设计.pdf')).toBeInTheDocument()
    expect(getByText('数据库规范.md')).toBeInTheDocument()
    expect(getByText('复盘报告.docx')).toBeInTheDocument()

    // 3. 同时勾选「不生成空目录」：平铺后自身无直属文件的「技术资料」自动滤除
    fireEvent.click(getByText('不生成空目录'))
    expect(capturedVDirTreeNodes.map(n => n.name)).toEqual(['后端文档', '数据库', '项目归档'])
    expect(queryByText('技术资料')).not.toBeInTheDocument()

    // 4. 取消勾选「平铺到根目录」：恢复原有嵌套目录层级
    fireEvent.click(flattenLabel)
    expect(capturedVDirTreeNodes.map(n => n.name)).toEqual(['技术资料', '项目归档'])
    expect(capturedVDirTreeNodes[0].subdirectories.map(n => n.name)).toEqual(['后端文档'])
  })

  it('flattenDirectoriesToRoot 遇到不同分支下同名子目录时应合并文件并去重', () => {
    const dupSubTree: VirtualDirectoryNode[] = [
      {
        name: '2025',
        files: [],
        fileCount: 1,
        subdirectories: [
          {
            name: '周报',
            files: [{ id: 10, name: 'W1.md' } as any],
            fileCount: 1,
            subdirectories: []
          }
        ]
      },
      {
        name: '2026',
        files: [],
        fileCount: 2,
        subdirectories: [
          {
            name: '周报',
            files: [{ id: 10, name: 'W1.md' } as any, { id: 11, name: 'W2.md' } as any],
            fileCount: 2,
            subdirectories: []
          }
        ]
      }
    ]

    const flattened = flattenDirectoriesToRoot(dupSubTree, true)
    expect(flattened.map(n => n.name)).toEqual(['周报'])
    expect(flattened[0].files.map(f => f.name)).toEqual(['W1.md', 'W2.md'])
    expect(flattened[0].fileCount).toBe(2)

    // 验证纯函数无副作用：原始同名子目录中的文件位置与归属丝毫未被污染
    expect(dupSubTree[0].subdirectories[0].files.map(f => f.name)).toEqual(['W1.md'])
    expect(dupSubTree[1].subdirectories[0].files.map(f => f.name)).toEqual(['W1.md', 'W2.md'])
  })

  it('勾选平铺合并同名目录后，取消勾选「平铺到根目录」应精准拆开并还原各分支原始文件位置', () => {
    const dupBranchTree: VirtualDirectoryNode[] = [
      {
        name: '2025',
        files: [],
        fileCount: 1,
        subdirectories: [
          {
            name: '周报',
            files: [
              {
                id: 10,
                fileId: 10,
                name: 'W1.md',
                smartName: 'W1.md',
                path: '/workspace/2025/W1.md',
                originalPath: '/workspace/2025/W1.md'
              } as any
            ],
            fileCount: 1,
            subdirectories: []
          }
        ]
      },
      {
        name: '2026',
        files: [],
        fileCount: 1,
        subdirectories: [
          {
            name: '周报',
            files: [
              {
                id: 11,
                fileId: 11,
                name: 'W2.md',
                smartName: 'W2.md',
                path: '/workspace/2026/W2.md',
                originalPath: '/workspace/2026/W2.md'
              } as any
            ],
            fileCount: 1,
            subdirectories: []
          }
        ]
      }
    ]

    function DupBranchHarness() {
      const [options, setOptions] = useState<OrganizeOptions>({
        flattenToRoot: false,
        skipEmptyDirs: false,
        allowCreateNew: false
      } as any)

      return (
        <DoneView
          tree={dupBranchTree}
          organizeMode="identity-blueprint"
          onReorganize={vi.fn()}
          onRescue={vi.fn()}
          hasRescueFailed={false}
          draft={{ name: '测试方案', strategy: '', source: 'identity-blueprint' }}
          candidate={null}
          options={options}
          setOptions={setOptions}
        />
      )
    }

    const { getByText } = render(<DupBranchHarness />)
    const flattenLabel = getByText('平铺到根目录')

    // 1. 勾选平铺：两个分支的「周报」在根目录合并为一个目录，包含 W1.md 和 W2.md
    fireEvent.click(flattenLabel)
    const mergedDir = capturedVDirTreeNodes.find(n => n.name === '周报')
    expect(capturedVDirTreeNodes.filter(n => n.name === '周报')).toHaveLength(1)
    expect(mergedDir?.files.map(f => f.name)).toEqual(['W1.md', 'W2.md'])

    // 2. 取消勾选平铺：拆开并完整还原到各自原始父目录位置
    fireEvent.click(flattenLabel)
    expect(capturedVDirTreeNodes.map(n => n.name)).toEqual(['2025', '2026'])
    expect(capturedVDirTreeNodes[0].subdirectories[0].name).toBe('周报')
    expect(capturedVDirTreeNodes[0].subdirectories[0].files.map(f => f.name)).toEqual(['W1.md'])
    expect(capturedVDirTreeNodes[1].subdirectories[0].name).toBe('周报')
    expect(capturedVDirTreeNodes[1].subdirectories[0].files.map(f => f.name)).toEqual(['W2.md'])
  })

  it('后端找补返回仅含 { fileId, smartName }（无 name 字段）的文件时，DoneView 左侧目录树必须正常显示该文件且保留原始完整元数据', () => {
    const originalTree: VirtualDirectoryNode[] = [
      {
        name: '技术资料',
        fileCount: 1,
        files: [
          {
            id: 1,
            fileId: 1,
            name: '已有文档.pdf',
            smartName: '已有文档.pdf',
            path: '/workspace/已有文档.pdf',
            originalPath: '/workspace/已有文档.pdf'
          } as any
        ],
        subdirectories: []
      },
      {
        name: SENTINEL_NAMES.UNCLASSIFIED,
        fileCount: 2,
        files: [
          {
            id: 2,
            fileId: 2,
            name: 'raw_file_2.pdf',
            smartName: '找补成功文档.pdf',
            path: '/workspace/raw_file_2.pdf',
            originalPath: '/workspace/raw_file_2.pdf',
            fileFingerprint: 'fp-2'
          } as any,
          {
            id: 3,
            fileId: 3,
            name: '仍未归类.pdf',
            smartName: '仍未归类.pdf',
            path: '/workspace/仍未归类.pdf',
            originalPath: '/workspace/仍未归类.pdf',
            fileFingerprint: 'fp-3'
          } as any
        ],
        subdirectories: []
      }
    ]

    // 精确模拟 core-engine buildIntermediatePreview 返回的瘦身结构（仅含 fileId + smartName，不含 name）
    const backendPreviewTree: VirtualDirectoryNode[] = [
      {
        name: '技术资料',
        fileCount: 1,
        files: [{ fileId: 2, smartName: '找补成功文档.pdf' } as any],
        subdirectories: []
      },
      {
        name: SENTINEL_NAMES.UNCLASSIFIED,
        fileCount: 1,
        files: [{ fileId: 3, smartName: '仍未归类.pdf' } as any],
        subdirectories: []
      }
    ]

    const merged = mergeRescueResult(originalTree, backendPreviewTree)

    const { getByText } = render(
      <DoneView
        tree={merged}
        organizeMode="identity-blueprint"
        onReorganize={vi.fn()}
        onRescue={vi.fn()}
        hasRescueFailed={false}
        draft={{ name: '测试方案', strategy: '', source: 'identity-blueprint' }}
        candidate={null}
        options={{ flattenToRoot: false, skipEmptyDirs: false, allowCreateNew: false } as any}
        setOptions={vi.fn()}
      />
    )

    // 左侧分类树中必须真实包含找补进来的文件，而不是被 DoneView filterUnclassified 静默过滤掉
    const techNode = capturedVDirTreeNodes.find(n => n.name === '技术资料')
    expect(techNode?.files.map((f: any) => f.smartName || f.name)).toEqual([
      '已有文档.pdf',
      '找补成功文档.pdf'
    ])
    // 且找补进来的文件保留了原始 name 与 originalPath 元数据
    const rescuedFile: any = techNode?.files.find((f: any) => f.fileId === 2)
    expect(rescuedFile?.name).toBe('raw_file_2.pdf')
    expect(rescuedFile?.originalPath).toBe('/workspace/raw_file_2.pdf')
    expect(getByText('找补成功文档.pdf')).toBeInTheDocument()
  })
})
