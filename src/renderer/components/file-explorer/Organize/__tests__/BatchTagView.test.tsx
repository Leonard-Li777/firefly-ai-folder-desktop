import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { BatchTagView } from '../components/BatchTagView'
import { DimensionGroup } from '@firefly/types'
import { concept } from '@firefly/shared'

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
    warning: vi.fn(),
    error: vi.fn()
  }
}))

describe('BatchTagView 批量打标视图回归测试', () => {
  const mockFiles = [
    {
      id: 1,
      name: 'file1.txt',
      dimensionTags: [
        { dimensionId: 17, dimensionName: '安全等级', tagValue: '公开' },
        { dimensionId: 4, dimensionName: '作者', tagValue: '老舍' }
      ]
    },
    {
      id: 2,
      name: 'file2.txt',
      dimensionTags: [
        { dimensionId: 4, dimensionName: '作者', tagValue: '鲁迅' }
      ]
    }
  ]

  const mockPresetGroups: DimensionGroup[] = [
    {
      id: 2,
      name: '文件用途',
      code: concept('文件用途'),
      metadata: { flag: { isPanDimension: false } },
      tags: [
        { dimensionId: 2, tagValue: '文件用途', fileCount: 0 }, // 应该被门禁过滤（自身维度名）
        { dimensionId: 2, tagValue: '办公', fileCount: 0 }
      ]
    },
    {
      id: 17,
      name: '安全等级',
      code: concept('安全等级'),
      metadata: { flag: { isPanDimension: false }, triggerConditions: [{ parentDimension: concept('文件用途') }] },
      tags: [
        { dimensionId: 17, tagValue: '安全等级', fileCount: 0 }, // 应该被门禁过滤（自身维度名）
        { dimensionId: 17, tagValue: '公开', fileCount: 1 },
        { dimensionId: 17, tagValue: '内部', fileCount: 0 }
      ]
    },
    {
      id: 4,
      name: '作者',
      code: concept('作者'),
      metadata: { flag: { isPanDimension: true } },
      tags: [
        { dimensionId: 4, tagValue: '作者', fileCount: 0 }, // 应该被门禁过滤（自身维度名）
        { dimensionId: 4, tagValue: '老舍', fileCount: 1 },
        { dimensionId: 4, tagValue: '鲁迅', fileCount: 1 }
      ]
    },
    {
      id: 28,
      name: '内容标签',
      code: concept('内容标签'),
      metadata: { flag: { isPanDimension: true } },
      tags: [
        { dimensionId: 28, tagValue: '塔防', fileCount: 0 }
      ]
    }
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    ;(window as any).electronAPI = {
      analyzedDirectory: {
        getDimensionGroups: vi.fn().mockResolvedValue({ groups: mockPresetGroups })
      }
    }
  })

  it('防首屏空态误判：在预设加载中绝不提前显示“未找到匹配的维度或标签”', () => {
    // 模拟尚未完成加载（返回 pending Promise）
    ;(window as any).electronAPI.analyzedDirectory.getDimensionGroups = vi.fn().mockReturnValue(new Promise(() => {}))

    render(
      <BatchTagView
        files={mockFiles}
        dimensionGroups={[]}
        onSaveTags={vi.fn()}
      />
    )

    // 应展示正在加载中
    expect(screen.getByText('正在加载维度与标签...')).toBeInTheDocument()
    // 绝不能出现“未找到匹配的维度或标签”
    expect(screen.queryByText('未找到匹配的维度或标签')).not.toBeInTheDocument()
  })

  it('预设维度加载完成后正常呈现两列布局（分类维度在左，泛维度在右）', async () => {
    render(
      <BatchTagView
        files={mockFiles}
        dimensionGroups={[]}
        onSaveTags={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('section-standard-dimensions')).toBeInTheDocument()
      expect(screen.getByTestId('section-pan-dimensions')).toBeInTheDocument()
    })

    // 展开所有分类维度以查看子维度与标签
    fireEvent.click(screen.getByText('全部展开'))

    // 左列分类维度包含“文件用途”、“安全等级”
    const leftCol = screen.getByTestId('section-standard-dimensions')
    expect(leftCol).toHaveTextContent('文件用途')
    expect(leftCol).toHaveTextContent('安全等级')

    // 右列泛维度包含“作者”、“内容标签”
    const rightCol = screen.getByTestId('section-pan-dimensions')
    expect(rightCol).toHaveTextContent('作者')
    expect(rightCol).toHaveTextContent('内容标签')
  })

  it('铁律校验：维度名自身绝不能作为其卡片下的可选标签', async () => {
    render(
      <BatchTagView
        files={mockFiles}
        dimensionGroups={[]}
        onSaveTags={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('section-standard-dimensions')).toBeInTheDocument()
    })

    // 展开所有分类维度
    fireEvent.click(screen.getByText('全部展开'))

    // 作者卡片下的标签应该有“老舍”、“鲁迅”，但绝不能有“作者”胶囊
    const rightCol = screen.getByTestId('section-pan-dimensions')
    expect(rightCol).toHaveTextContent('老舍')
    expect(rightCol).toHaveTextContent('鲁迅')

    // 安全等级卡片下有“公开”、“内部”，但不应有“安全等级”胶囊
    const leftCol = screen.getByTestId('section-standard-dimensions')
    expect(leftCol).toHaveTextContent('公开')
    expect(leftCol).toHaveTextContent('内部')
  })

  it('标签胶囊只显示文件命中数，不显示“文件总数”分母', async () => {
    render(
      <BatchTagView
        files={mockFiles}
        dimensionGroups={[]}
        onSaveTags={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('section-standard-dimensions')).toBeInTheDocument()
    })

    // 文件命中数为 1 的标签（如“公开”），应该显示 "1"，绝不能显示 "1/2"
    expect(screen.queryByText('1/2')).not.toBeInTheDocument()
  })

  it('搜索功能：仅当无任何匹配时才显示空态提示', async () => {
    render(
      <BatchTagView
        files={mockFiles}
        dimensionGroups={[]}
        onSaveTags={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('section-standard-dimensions')).toBeInTheDocument()
    })

    const searchInput = screen.getByPlaceholderText('搜索标签或维度...')
    fireEvent.change(searchInput, { target: { value: '不存在的虚无标签xyz' } })

    expect(screen.getByText('未找到匹配的维度或标签')).toBeInTheDocument()
  })

  it('在泛维度（如作者）中新建标签时，新标签归属于该泛维度', async () => {
    const handleSaveTags = vi.fn().mockResolvedValue(undefined)
    render(
      <BatchTagView
        files={mockFiles}
        dimensionGroups={[]}
        onSaveTags={handleSaveTags}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('section-pan-dimensions')).toBeInTheDocument()
    })

    // 找到泛维度列中的作者卡片，点击“新建标签”按钮
    const rightCol = screen.getByTestId('section-pan-dimensions')
    const addButtons = screen.getAllByText('新建标签')
    fireEvent.click(addButtons[0]) // 作者卡片排在前面

    const tagInput = screen.getByPlaceholderText('输入新标签名...')
    fireEvent.change(tagInput, { target: { value: '刘慈欣' } })
    fireEvent.keyDown(tagInput, { key: 'Enter', code: 'Enter' })

    // 检查“刘慈欣”是否出现在卡片中
    expect(rightCol).toHaveTextContent('刘慈欣')

    // 触发保存操作
    const saveTrigger = document.getElementById('btn-save-tags-trigger')
    expect(saveTrigger).toBeInTheDocument()
    fireEvent.click(saveTrigger!)

    await waitFor(() => {
      expect(handleSaveTags).toHaveBeenCalledWith(
        expect.objectContaining({
          newTags: expect.arrayContaining([
            expect.objectContaining({
              dimensionId: 4,
              dimensionName: '作者',
              tagName: '刘慈欣'
            })
          ])
        })
      )
    })
  })
})
