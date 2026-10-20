import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { SmartClusteringView, SmartClusteringViewHandle } from '../components/SmartClusteringView'
import { VirtualDirectoryNode } from '@firefly/types'

// Mock 语言包
vi.mock('@app/languages', () => ({
  t: (key: string, params?: any) => {
    if (params && typeof params === 'object') {
      let res = key
      for (const k in params) {
        res = res.replace(new RegExp('\\{' + k + '\\}', 'g'), params[k])
      }
      return res
    }
    return key
  },
  $t: (key: string) => key,
  Translate: ({ children }: any) => children,
  i18nScope: { t: (s: string) => s, activeLanguage: 'zh-CN', defaultLanguage: 'zh-CN' },
  default: { t: (s: string) => s, activeLanguage: 'zh-CN', defaultLanguage: 'zh-CN' }
}))

describe('SmartClusteringView Component', () => {
  const mockSmartClusterHac = vi.fn()
  const mockSaveVirtualDirectory = vi.fn()
  const mockOnBack = vi.fn()

  const sampleNodes: VirtualDirectoryNode[] = [
    {
      name: '2026年度财务',
      parent: null,
      fileCount: 3,
      totalSize: 1024,
      files: [
        {
          id: 1,
          name: 'Q1报表.xlsx',
          extension: 'xlsx',
          size: 512,
          originalPath: '/data/Q1报表.xlsx'
        }
      ],
      subdirectories: []
    },
    {
      name: '设计稿素材',
      parent: null,
      fileCount: 1,
      totalSize: 2048,
      files: [],
      subdirectories: []
    }
  ]

  beforeEach(() => {
    vi.clearAllMocks()

    mockSmartClusterHac.mockResolvedValue({
      success: true,
      directories: sampleNodes,
      durationMs: 120,
      summary: '成功聚类 2 个核心主题，共覆盖 4 个文件'
    })

    // Mock window.electronAPI
    ;(window as any).electronAPI = {
      organizeRealDirectory: {
        smartClusterHac: mockSmartClusterHac
      }
    }
  })

  it('首次加载应自动以空提示词发起基准聚类并展示结果', async () => {
    render(
      <SmartClusteringView
        workspaceId={1}
        workspaceDirectoryPath="/test/workspace"
        onSaveVirtualDirectory={mockSaveVirtualDirectory}
        onBack={mockOnBack}
      />
    )

    expect(mockSmartClusterHac).toHaveBeenCalledWith({
      workspaceId: 1,
      workspaceDirectoryPath: '/test/workspace',
      fileIds: undefined,
      prompt: ''
    })

    // 等待渲染完成
    await waitFor(() => {
      expect(screen.getByText('2026年度财务')).toBeInTheDocument()
      expect(screen.getByText('设计稿素材')).toBeInTheDocument()
    })
  })

  it('点击示例场景词应上屏并触发重新聚类', async () => {
    render(
      <SmartClusteringView
        workspaceId={1}
        workspaceDirectoryPath="/test/workspace"
        onSaveVirtualDirectory={mockSaveVirtualDirectory}
      />
    )

    await waitFor(() => {
      expect(screen.getByText('2026年度财务')).toBeInTheDocument()
    })

    const exampleChip = screen.getByText('按年份与财务类型归类')
    fireEvent.click(exampleChip)

    await waitFor(() => {
      expect(mockSmartClusterHac).toHaveBeenCalledWith({
        workspaceId: 1,
        workspaceDirectoryPath: '/test/workspace',
        fileIds: undefined,
        prompt: '按年份与财务类型归类'
      })
    })
  })

  it('经句柄保存应使用提示词或默认名称调用 onSaveVirtualDirectory', async () => {
    const ref = React.createRef<SmartClusteringViewHandle>()
    render(
      <SmartClusteringView
        ref={ref}
        workspaceId={1}
        workspaceDirectoryPath="/test/workspace"
        onSaveVirtualDirectory={mockSaveVirtualDirectory}
      />
    )

    await waitFor(() => {
      expect(screen.getByText('2026年度财务')).toBeInTheDocument()
    })

    await act(async () => {
      await ref.current?.save()
    })

    await waitFor(() => {
      expect(mockSaveVirtualDirectory).toHaveBeenCalledWith(
        expect.stringContaining('智能聚类整理'),
        sampleNodes
      )
    })
  })

  it('如果用户输入了提示词，保存时应优先采用用户提示词作为虚拟目录名称', async () => {
    const ref = React.createRef<SmartClusteringViewHandle>()
    render(
      <SmartClusteringView
        ref={ref}
        workspaceId={1}
        workspaceDirectoryPath="/test/workspace"
        onSaveVirtualDirectory={mockSaveVirtualDirectory}
      />
    )

    await waitFor(() => {
      expect(screen.getByText('2026年度财务')).toBeInTheDocument()
    })

    const textarea = screen.getByPlaceholderText(/如：按年份和财务归类/)
    fireEvent.change(textarea, { target: { value: '2026年Q1财务专项目录' } })

    await act(async () => {
      await ref.current?.save()
    })

    await waitFor(() => {
      expect(mockSaveVirtualDirectory).toHaveBeenCalledWith('2026年Q1财务专项目录', sampleNodes)
    })
  })

  it('保存为虚拟目录按钮不应再渲染在视图内部（已统一迁至面包屑栏右侧）', async () => {
    render(
      <SmartClusteringView
        workspaceId={1}
        workspaceDirectoryPath="/test/workspace"
        onSaveVirtualDirectory={mockSaveVirtualDirectory}
      />
    )

    await waitFor(() => {
      expect(screen.getByText('2026年度财务')).toBeInTheDocument()
    })

    expect(screen.queryByText('保存为虚拟目录')).toBeNull()
  })

  it('聚类完成后应经 onSaveStateChange 上报保存按钮可用态，供面包屑栏按钮同步', async () => {
    const mockOnSaveStateChange = vi.fn()
    render(
      <SmartClusteringView
        workspaceId={1}
        workspaceDirectoryPath="/test/workspace"
        onSaveVirtualDirectory={mockSaveVirtualDirectory}
        onSaveStateChange={mockOnSaveStateChange}
      />
    )

    await waitFor(() => {
      expect(screen.getByText('2026年度财务')).toBeInTheDocument()
    })

    await waitFor(() => {
      expect(mockOnSaveStateChange).toHaveBeenLastCalledWith({ canSave: true, isSaving: false })
    })
  })
})
