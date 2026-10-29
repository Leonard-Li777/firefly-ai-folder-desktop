import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { SmartClusteringView, SmartClusteringViewHandle, computeAdaptiveClusteringParams } from '../components/SmartClusteringView'
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
      prompt: '',
      maxDepth: 3,
      maxRootDirectories: 5,
      maxSubdirectories: 5,
      similarityThreshold: 0.6,
      clusteringMode: 'balanced',
        force: false
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
        prompt: '按年份与财务类型归类',
        maxDepth: 3,
        maxRootDirectories: 5,
        maxSubdirectories: 5,
        similarityThreshold: 0.6,
        clusteringMode: 'balanced',
        force: false
      })
    })
  })

  it('未输入提示词时，保存应使用最大簇名称 + “整理”作为默认虚拟目录名', async () => {
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
      expect(mockSaveVirtualDirectory).toHaveBeenCalledWith('2026年度财务 整理', sampleNodes)
    })
  })

  it('所有目录均无文件时，保存应回退为“智能聚类整理_YYYYMMDD”', async () => {
    mockSmartClusterHac.mockResolvedValueOnce({
      success: true,
      directories: [
        {
          name: '空目录',
          parent: null,
          fileCount: 0,
          totalSize: 0,
          files: [],
          subdirectories: []
        }
      ],
      durationMs: 10,
      summary: '空结果'
    })

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
      expect(screen.getByText('空目录')).toBeInTheDocument()
    })

    await act(async () => {
      await ref.current?.save()
    })

    await waitFor(() => {
      expect(mockSaveVirtualDirectory).toHaveBeenCalledWith(
        expect.stringMatching(/^智能聚类整理_\d{8}$/),
        expect.any(Array)
      )
    })
  })

  it('拖拽文件到目标目录应执行移动（源目录移除、目标目录新增、fileCount 自底向上重算）', async () => {
    const moveNodes: VirtualDirectoryNode[] = [
      {
        name: '源目录',
        parent: null,
        fileCount: 2,
        totalSize: 0,
        files: [
          { id: 10, name: 'a.txt', extension: 'txt', size: 1, originalPath: '/data/a.txt' },
          { id: 11, name: 'b.txt', extension: 'txt', size: 1, originalPath: '/data/b.txt' }
        ],
        subdirectories: []
      },
      {
        name: '目标目录',
        parent: null,
        fileCount: 0,
        totalSize: 0,
        files: [],
        subdirectories: []
      }
    ]
    mockSmartClusterHac.mockResolvedValueOnce({
      success: true,
      directories: moveNodes,
      durationMs: 10,
      summary: '拖拽测试'
    })

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
      expect(screen.getByText('目标目录')).toBeInTheDocument()
      expect(screen.getByText('a.txt')).toBeInTheDocument()
    })

    const targetRow = screen.getByText('目标目录').closest('[draggable="true"]')!
    expect(targetRow).not.toBeNull()

    fireEvent.drop(targetRow, {
      dataTransfer: {
        getData: () =>
          JSON.stringify({ type: 'file', file: { id: 10, name: 'a.txt' }, sourceNodeKey: '源目录' })
      }
    })

    await act(async () => {
      await ref.current?.save()
    })

    const savedTree = mockSaveVirtualDirectory.mock.calls[0][1] as VirtualDirectoryNode[]
    const source = savedTree.find(n => n.name === '源目录')!
    const target = savedTree.find(n => n.name === '目标目录')!

    expect(source.files!.map(f => (f as any).id)).toEqual([11])
    expect(source.fileCount).toBe(1)
    expect(target.files!.map(f => (f as any).id)).toEqual([10])
    expect(target.fileCount).toBe(1)
    // 文件全局只出现一次，杜绝“移动变复制”
    const totalFileOccurrences = savedTree.reduce(
      (sum, node) => sum + (node.files?.length || 0),
      0
    )
    expect(totalFileOccurrences).toBe(2)
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

  it('四维调节滑块平铺展示且拖拽后防抖触发带新参数的聚类请求', async () => {
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

    // 检查 4 个滑块均渲染在界面上
    expect(screen.getByText('目录层级深度')).toBeInTheDocument()
    expect(screen.getByText('根目录数上限')).toBeInTheDocument()
    expect(screen.getByText('子目录数上限')).toBeInTheDocument()
    expect(screen.getByText('相似度基准')).toBeInTheDocument()

    // 获取所有 range inputs
    const rangeInputs = screen.getAllByRole('slider')
    expect(rangeInputs.length).toBe(4)

    // 修改目录层级为 5
    fireEvent.change(rangeInputs[0], { target: { value: '5' } })

    // 等待 400ms 防抖
    await waitFor(() => {
      expect(mockSmartClusterHac).toHaveBeenCalledWith({
        workspaceId: 1,
        workspaceDirectoryPath: '/test/workspace',
        fileIds: undefined,
        prompt: '',
        maxDepth: 5,
        maxRootDirectories: 5,
        maxSubdirectories: 5,
        similarityThreshold: 0.6,
        clusteringMode: 'balanced',
        force: false
      })
    }, { timeout: 2000 })
  })

  it('在目录树脏状态下调整滑块触发覆盖确认弹窗，点击取消应回滚滑块状态', async () => {
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

    // 重命名节点触发 isTreeDirty
    const renameInputs = screen.queryAllByRole('textbox')
    // 通过拖拽或内联操作使树变脏
    const targetRow = screen.getByText('设计稿素材').closest('[draggable="true"]')!
    fireEvent.drop(targetRow, {
      dataTransfer: {
        getData: () =>
          JSON.stringify({ type: 'file', file: { id: 1, name: 'Q1报表.xlsx' }, sourceNodeKey: '2026年度财务' })
      }
    })

    // 此时树已脏
    const rangeInputs = screen.getAllByRole('slider')
    // 拖动第 1 个滑块到 7
    fireEvent.change(rangeInputs[0], { target: { value: '7' } })

    // 应弹出覆盖确认弹窗
    await waitFor(() => {
      expect(screen.getByText('覆盖微调确认')).toBeInTheDocument()
    })

    // 点击取消
    const cancelBtn = screen.getByText('取消')
    fireEvent.click(cancelBtn)

    // 滑块值应回滚为 3
    await waitFor(() => {
      expect(rangeInputs[0]).toHaveValue('3')
    })
  })

  it('点击聚类策略胶囊控件应切换模式并重新触发聚类', async () => {
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

    // 默认平衡模式高亮
    const balancedBtn = screen.getByRole('radio', { name: /平衡推荐/ })
    expect(balancedBtn).toHaveAttribute('aria-checked', 'true')

    // 点击【精准严谨】
    const preciseBtn = screen.getByRole('radio', { name: /精准严谨/ })
    fireEvent.click(preciseBtn)

    await waitFor(() => {
      expect(mockSmartClusterHac).toHaveBeenCalledWith({
        workspaceId: 1,
        workspaceDirectoryPath: '/test/workspace',
        fileIds: undefined,
        prompt: '',
        maxDepth: 3,
        maxRootDirectories: 5,
        maxSubdirectories: 5,
        similarityThreshold: 0.6,
        clusteringMode: 'precise',
        force: false
      })
    })

    // 点击【全量收纳】
    const completeBtn = screen.getByRole('radio', { name: /全量收纳/ })
    fireEvent.click(completeBtn)

    await waitFor(() => {
      expect(mockSmartClusterHac).toHaveBeenCalledWith({
        workspaceId: 1,
        workspaceDirectoryPath: '/test/workspace',
        fileIds: undefined,
        prompt: '',
        maxDepth: 3,
        maxRootDirectories: 5,
        maxSubdirectories: 5,
        similarityThreshold: 0.6,
        clusteringMode: 'complete',
        force: false
      })
    })
  })

  it('在目录树脏状态下点击聚类策略胶囊应触发覆盖确认弹窗，点击取消应回滚模式', async () => {
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

    // 拖拽使目录树变脏
    const targetRow = screen.getByText('设计稿素材').closest('[draggable="true"]')!
    fireEvent.drop(targetRow, {
      dataTransfer: {
        getData: () =>
          JSON.stringify({ type: 'file', file: { id: 1, name: 'Q1报表.xlsx' }, sourceNodeKey: '2026年度财务' })
      }
    })

    // 点击【全量收纳】
    const completeBtn = screen.getByRole('radio', { name: /全量收纳/ })
    fireEvent.click(completeBtn)

    // 应弹出覆盖确认弹窗
    await waitFor(() => {
      expect(screen.getByText('覆盖微调确认')).toBeInTheDocument()
    })

    // 点击取消覆盖
    const cancelBtn = screen.getByText('取消')
    fireEvent.click(cancelBtn)

    // 弹窗关闭，模式仍保持 balanced (推荐)
    await waitFor(() => {
      const balancedBtn = screen.getByRole('radio', { name: /平衡推荐/ })
      expect(balancedBtn).toHaveAttribute('aria-checked', 'true')
    })
  })

  it('相似度基准滑块文案与刻度标签应正确解耦展示', async () => {
    render(
      <SmartClusteringView
        workspaceId={1}
        workspaceDirectoryPath="/test/workspace"
        onSaveVirtualDirectory={mockSaveVirtualDirectory}
      />
    )

    // 标题解耦为「相似度基准」
    expect(screen.getByText('相似度基准')).toBeInTheDocument()
    // 默认 60% 对应标准匹配
    expect(screen.getByText('60% (标准匹配)')).toBeInTheDocument()
    // 底部刻度
    expect(screen.getByText('0% (松散)')).toBeInTheDocument()
    expect(screen.getByText('60% (标准)')).toBeInTheDocument()
    expect(screen.getByText('100% (精细)')).toBeInTheDocument()
  })

  it('computeAdaptiveClusteringParams 纯函数应符合 Spec v2.1 §3.3 自适应推导公式', () => {
    // 1. 极小规模 / 兜底边界 (N <= 1)
    const p1 = computeAdaptiveClusteringParams(0)
    expect(p1).toEqual({ maxDepth: 2, maxRootDirectories: 3, maxSubdirectories: 2 })

    // 2. 真实桌面工作区场景 (N = 165)
    // sqrt(165) ≈ 12.845 => roots = round(10.28) = 10, subdirs = round(7.71) = 8, depth = 3
    const p165 = computeAdaptiveClusteringParams(165)
    expect(p165).toEqual({ maxDepth: 3, maxRootDirectories: 10, maxSubdirectories: 8 })

    // 3. 超大规模工作区 (N = 600)
    // N > 500 => depth = 4; sqrt(600) ≈ 24.49 => roots = clamp(20, 3, 20) = 20, subdirs = clamp(15, 2, 12) = 12
    const p600 = computeAdaptiveClusteringParams(600)
    expect(p600).toEqual({ maxDepth: 4, maxRootDirectories: 20, maxSubdirectories: 12 })
  })

  it('组件首启根据 fileIds 数量自适应默认滑块数值并驱动聚类', async () => {
    const fileIds165 = Array.from({ length: 165 }, (_, i) => i + 1)
    render(
      <SmartClusteringView
        workspaceId={1}
        workspaceDirectoryPath="/test/workspace"
        fileIds={fileIds165}
        onSaveVirtualDirectory={mockSaveVirtualDirectory}
      />
    )

    await waitFor(() => {
      expect(mockSmartClusterHac).toHaveBeenCalled()
    })

    // 首次调用传入参数应使用针对 165 份文件推导的自适应参数 (roots: 10, subdirs: 8, depth: 3)
    const callArgs = mockSmartClusterHac.mock.calls[0][0]
    expect(callArgs.maxRootDirectories).toBe(10)
    expect(callArgs.maxSubdirectories).toBe(8)
    expect(callArgs.maxDepth).toBe(3)
    expect(callArgs.clusteringMode).toBe('balanced')
  })
});
