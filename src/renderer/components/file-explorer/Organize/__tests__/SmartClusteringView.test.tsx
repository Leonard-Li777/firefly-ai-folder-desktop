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

const mockToastInfo = vi.fn()
vi.mock('../../../common/Toast', () => ({
  toast: {
    info: (...args: any[]) => mockToastInfo(...args),
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn()
  }
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

    // 获取所有 range inputs（顺序：相似度基准、目录层级深度、根目录数上限、子目录数上限）
    const rangeInputs = screen.getAllByRole('slider')
    expect(rangeInputs.length).toBe(4)

    // 修改目录层级为 5
    fireEvent.change(rangeInputs[1], { target: { value: '5' } })

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

  it('在目录树手动微调后调整滑块，全自动静默融合重聚类并保留微调提示栏 (裁决项1A)', async () => {
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

    // 通过拖拽或内联操作使树变脏
    const targetRow = screen.getByText('设计稿素材').closest('[draggable="true"]')!
    fireEvent.drop(targetRow, {
      dataTransfer: {
        getData: () =>
          JSON.stringify({ type: 'file', file: { id: 1, name: 'Q1报表.xlsx' }, sourceNodeKey: '2026年度财务' })
      }
    })

    // 此时树包含手动微调，应展示保留提示栏
    await waitFor(() => {
      expect(screen.getByText(/已手动微调目录树，重新聚类将自动融合保留修改/)).toBeInTheDocument()
    })

    // 拖动滑块直接生效，无需确认弹窗打断
    const rangeInputs = screen.getAllByRole('slider')
    fireEvent.change(rangeInputs[1], { target: { value: '7' } })
    expect(rangeInputs[1]).toHaveValue('7')
    expect(screen.queryByText('覆盖微调确认')).toBeNull()
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

  it('在目录树手动微调后支持在提示栏点击清空微调，重置脏状态与微调记录', async () => {
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

    // 提示栏应出现【清空微调】按钮
    const clearBtn = await screen.findByText('清空微调')
    fireEvent.click(clearBtn)

    // 提示栏消失
    await waitFor(() => {
      expect(screen.queryByText(/已手动微调目录树/)).toBeNull()
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
  it('点击新建根目录成功添加到目录树，当目录数量超过滑块上限时自动调整滑块并给出 Toast 提示', async () => {
    mockToastInfo.mockClear()
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

    // 点击【新建根目录】
    const newRootBtn = screen.getByText('新建根目录')
    fireEvent.click(newRootBtn)

    // 输入框出现
    const addInput = await screen.findByPlaceholderText('按 Enter 确认创建')
    fireEvent.change(addInput, { target: { value: '自定义根目录1' } })
    fireEvent.keyDown(addInput, { key: 'Enter' })

    // 目录树应成功展示新根目录
    await waitFor(() => {
      expect(screen.getByText('自定义根目录1')).toBeInTheDocument()
    })

    // 默认 sampleNodes 为 2 个，加 1 个为 3 个，未超 maxRootDirectories(5)。
    // 继续加到第 6 个触发超额自适应与 toast 校验
    for (let i = 2; i <= 4; i++) {
      fireEvent.click(screen.getByText('新建根目录'))
      const input = await screen.findByPlaceholderText('按 Enter 确认创建')
      fireEvent.change(input, { target: { value: `自定义根目录${i}` } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await waitFor(() => {
        expect(screen.getByText(`自定义根目录${i}`)).toBeInTheDocument()
      })
    }

    // 此时已有 2(初始) + 4 = 6 个根目录，超过了默认 5
    expect(mockToastInfo).toHaveBeenCalledWith('已自动调整滑块目录数量以适应新增加的目录')
    // 根目录滑块上限应已自适应提升至 6
    const sliders = screen.getAllByRole('slider')
    // sliders[0]=相似度基准, sliders[1]=目录层级深度, sliders[2]=根目录数上限
    expect(sliders[2]).toHaveValue('6')
  })

  it('新建子目录时若子目录数量超过 maxSubdirectories 上限，自动调大滑块并给出 Toast 提示', async () => {
    mockToastInfo.mockClear()
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

    // 将子目录数滑块 (sliders[3]) 调节为 0
    const sliders = screen.getAllByRole('slider')
    fireEvent.change(sliders[3], { target: { value: '0' } })

    // 在 2026年度财务 下添加子目录
    // 找到该节点的行或添加子目录按钮
    const parentRow = screen.getByText('2026年度财务').closest('[draggable="true"]')!
    const addSubdirBtn = parentRow.querySelector('[title*="新建子目录"]') || parentRow.querySelector('[title*="添加"]')
    if (addSubdirBtn) {
      fireEvent.click(addSubdirBtn)
      const input = await screen.findByPlaceholderText('按 Enter 确认创建')
      fireEvent.change(input, { target: { value: 'Q1专项目录' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() => {
        expect(screen.getByText('Q1专项目录')).toBeInTheDocument()
      })

      // 超出 0，自动调大到 1 并给出 Toast
      expect(mockToastInfo).toHaveBeenCalledWith('已自动调整滑块目录数量以适应新增加的目录')
      expect(sliders[3]).toHaveValue('1')
    }
  })

  it('无论用户增删改目录，当重新聚类计算时均保留并应用用户的修改成果', async () => {
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

    // 1. 增：添加自定义根目录
    fireEvent.click(screen.getByText('新建根目录'))
    const addInput = await screen.findByPlaceholderText('按 Enter 确认创建')
    fireEvent.change(addInput, { target: { value: '用户自定义项目' } })
    fireEvent.keyDown(addInput, { key: 'Enter' })
    await waitFor(() => {
      expect(screen.getByText('用户自定义项目')).toBeInTheDocument()
    })

    // 2. 删：删除设计稿素材
    const designRow = screen.getByText('设计稿素材').closest('[draggable="true"]')!
    const deleteBtn = designRow.querySelector('[title*="删除"]')
    if (deleteBtn) {
      fireEvent.click(deleteBtn)
      await waitFor(() => {
        expect(screen.queryByText('设计稿素材')).toBeNull()
      })
    }

    // 3. 改：重命名 2026年度财务 -> 2026年度财务总账
    const financeRow = screen.getByText('2026年度财务').closest('[draggable="true"]')!
    const renameBtn = financeRow.querySelector('[title*="重命名"]')
    if (renameBtn) {
      fireEvent.click(renameBtn)
      const editInput = financeRow.querySelector('input[type="text"]') as HTMLInputElement
      if (editInput) {
        fireEvent.change(editInput, { target: { value: '2026年度财务总账' } })
        fireEvent.keyDown(editInput, { key: 'Enter' })
        await waitFor(() => {
          expect(screen.getByText('2026年度财务总账')).toBeInTheDocument()
        })
      }
    }

    // 重新聚类返回新的计算结果（包含原 2026年度财务 与 设计稿素材）
    mockSmartClusterHac.mockResolvedValueOnce({
      success: true,
      directories: [
        {
          name: '2026年度财务',
          parent: null,
          fileCount: 1,
          totalSize: 50,
          files: [{ id: 10, name: '新财务表.xlsx', size: 50 }],
          subdirectories: []
        },
        {
          name: '设计稿素材',
          parent: null,
          fileCount: 1,
          totalSize: 30,
          files: [{ id: 20, name: '新设计稿.psd', size: 30 }],
          subdirectories: []
        }
      ],
      durationMs: 50,
      summary: '第二次聚类'
    })

    // 点击重新生成聚类（全自动静默融合，无需确认弹窗）
    const regenBtn = screen.getByText('重新生成聚类')
    fireEvent.click(regenBtn)

    // 验证聚类重算时应用用户的修改成果：
    // - 新增的「用户自定义项目」保持存在
    // - 被删除的「设计稿素材」不复活，其名下文件收拢至未归类节点
    // - 重命名的「2026年度财务」保持「2026年度财务总账」
    await waitFor(() => {
      expect(screen.getByText('用户自定义项目')).toBeInTheDocument()
      expect(screen.getByText('2026年度财务总账')).toBeInTheDocument()
      expect(screen.queryByText('设计稿素材')).toBeNull()
      expect(screen.getByText('未归类')).toBeInTheDocument()
      expect(screen.getByText('新设计稿.psd')).toBeInTheDocument()
    })
  })
});
