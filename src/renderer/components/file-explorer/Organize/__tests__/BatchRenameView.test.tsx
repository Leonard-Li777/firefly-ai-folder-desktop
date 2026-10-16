import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { BatchRenameView } from '../components/BatchRenameView'

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
  useVoerkaI18n: () => ({ activeLanguage: 'zh-CN', t: mockT })
}))

// Mock SplitPane
vi.mock('../../../common/SplitPane', () => ({
  SplitPane: ({ sections }: any) => (
    <div data-testid="split-pane">
      {sections.map((s: any) => (
        <div key={s.id} data-testid={`section-${s.id}`}>
          {s.content}
        </div>
      ))}
    </div>
  )
}))

// Mock Toast
vi.mock('../../../common/Toast', () => ({
  toast: {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn()
  }
}))

describe('BatchRenameView - 属性标签资源池诊断与回归测试', () => {
  const mockFiles = [
    {
      id: 1,
      name: 'test_file.png',
      path: '/path/test_file.png',
      extension: 'png',
      size: 1024,
      is_analyzed: 1,
      isAnalyzed: true
    }
  ] as any

  const mockDimensionGroups = [
    {
      id: 1,
      name: '文件类型',
      level: 1,
      tags: [
        { dimensionId: 1, tagValue: '图片', fileCount: 1, level: 1 }
      ]
    },
    {
      id: 2,
      name: '文件用途',
      level: 1,
      tags: [
        { dimensionId: 2, tagValue: '工作文档', fileCount: 1, level: 1 }
      ]
    }
  ] as any

  beforeEach(() => {
    (window as any).electronAPI = {
      organizeBatch: {
        previewRename: vi.fn().mockResolvedValue([])
      }
    }
  })

  it('诊断 1: 核心与作者分类中必须包含「作者」标签，且分类徽标应为「核心与作者」', () => {
    render(
      <BatchRenameView
        files={mockFiles}
        dimensionGroups={mockDimensionGroups}
        onExecuteRename={vi.fn()}
      />
    )

    // 点击「核心与作者」Tab
    const coreTab = screen.getByRole('button', { name: /核心与作者/i })
    fireEvent.click(coreTab)

    // 分类徽标与 Tab 应均显示「核心与作者」而非「核心名称」
    const coreMatches = screen.getAllByText('核心与作者')
    expect(coreMatches.length).toBeGreaterThanOrEqual(2)

    // 必须有「作者」标签胶囊
    const authorButton = screen.getByRole('button', { name: /^作者\s*\{AUTHOR\}/ })
    expect(authorButton).toBeDefined()
    expect(authorButton.textContent).toContain('{AUTHOR}')
  })

  it('诊断 2: Tab 与类别名中严禁出现「无数据」，必须为「元数据」', () => {
    render(
      <BatchRenameView
        files={mockFiles}
        dimensionGroups={mockDimensionGroups}
        onExecuteRename={vi.fn()}
      />
    )

    // 严禁存在「无数据」按钮
    expect(screen.queryByRole('button', { name: /无数据/ })).toBeNull()

    // 必须存在「元数据」Tab 按钮
    const metaTab = screen.getByRole('button', { name: /元数据/ })
    expect(metaTab).toBeDefined()
    fireEvent.click(metaTab)

    // 必须包含分辨率、时长等元数据标签
    expect(screen.getByRole('button', { name: /分辨率/ })).toBeDefined()
  })

  it('诊断 3: 默认选中的「常用」Tab 必须正常展示，且常用中也应分类排布并补齐高频常用标签', () => {
    render(
      <BatchRenameView
        files={mockFiles}
        dimensionGroups={mockDimensionGroups}
        onExecuteRename={vi.fn()}
      />
    )

    // 默认展示「常用」内容，不应为空或提示「所有属性标签均已添加至上方模板」
    expect(screen.queryByText('所有属性标签均已添加至上方模板')).toBeNull()

    // 常用中应分类排布（包含子分类区块，如核心与作者、时间日期、分类维度、元数据、自增序号等）
    // 且常用中补齐了高频常用标签：如「原始文件名」、「扩展名」、「分辨率」等
    expect(screen.getByRole('button', { name: /原始文件名/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /文件扩展名/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /分辨率/ })).toBeDefined()
  })

  it('诊断 4: 分类维度中应包含子级维度，且子级维度需要按层级显示', () => {
    render(
      <BatchRenameView
        files={mockFiles}
        dimensionGroups={mockDimensionGroups}
        onExecuteRename={vi.fn()}
      />
    )

    // 切换到「分类维度」Tab
    const dimTab = screen.getByRole('button', { name: /分类维度/ })
    fireEvent.click(dimTab)

    // 应包含子级维度（如图片细分、视频细分、压缩包细分等）
    const imageSubDim = screen.getByRole('button', { name: /图片细分/ })
    expect(imageSubDim).toBeDefined()
    expect(screen.getByRole('button', { name: /压缩包细分/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /视频细分/ })).toBeDefined()

    // 子级维度应有层级提示与所属父级描述
    expect(imageSubDim.getAttribute('title')).toContain('文件类型')
  })

  it('诊断 5: 搜索过滤与模板去重应正确处理层级维度与元数据', () => {
    render(
      <BatchRenameView
        files={mockFiles}
        dimensionGroups={mockDimensionGroups}
        onExecuteRename={vi.fn()}
      />
    )

    // 搜索「细分」
    const searchInput = screen.getByPlaceholderText('过滤属性...')
    fireEvent.change(searchInput, { target: { value: '细分' } })

    // 应展示包含「细分」的维度
    expect(screen.getByRole('button', { name: /图片细分/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /压缩包细分/ })).toBeDefined()
  })
})
