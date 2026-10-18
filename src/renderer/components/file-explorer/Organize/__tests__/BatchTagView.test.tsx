import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { BatchTagView } from '../components/BatchTagView'
import { DimensionGroup } from '@firefly/types'
import { concept } from '@firefly/shared'
import { toast } from '../../../common/Toast'

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
      id: 16,
      name: '地理位置',
      code: concept('地理位置'),
      metadata: { flag: { isPanDimension: true, isRuleSubdivision: true } },
      tags: [
        { dimensionId: 16, tagValue: '地理位置', fileCount: 0 }
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
      },
      organizeBatch: {
        inspectControlledTags: vi.fn().mockResolvedValue({
          success: true,
          results: [
            {
              tagName: '刘慈欣',
              isControlled: false,
              matchedParent: false,
              code: null,
              canonicalName: null,
              parentCodes: []
            }
          ]
        })
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
    await waitFor(() => {
      expect(rightCol).toHaveTextContent('刘慈欣')
    })

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

  it('移除安全等级维度的“公开”标签并保存时，必须准确提交 removeTags 且包含安全等级上下文', async () => {
    const handleSaveTags = vi.fn().mockResolvedValue(undefined)
    render(
      <BatchTagView
        files={mockFiles}
        dimensionGroups={[]}
        onSaveTags={handleSaveTags}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('section-standard-dimensions')).toBeInTheDocument()
    })

    const leftCol = screen.getByTestId('section-standard-dimensions')
    await waitFor(() => {
      expect(leftCol).toHaveTextContent('安全等级')
    })

    // 找到安全等级下的“公开”标签胶囊并点击两次（Initial -> Add All -> Remove All）
    const publicPill = await waitFor(() => screen.getByText('公开'))
    fireEvent.click(publicPill) // -> add_all
    fireEvent.click(publicPill) // -> remove_all

    // 触发保存操作
    const saveTrigger = document.getElementById('btn-save-tags-trigger')
    expect(saveTrigger).toBeInTheDocument()
    fireEvent.click(saveTrigger!)

    await waitFor(() => {
      expect(handleSaveTags).toHaveBeenCalledWith(
        expect.objectContaining({
          removeTags: expect.arrayContaining([
            expect.objectContaining({
              dimensionId: 17,
              dimensionName: '安全等级',
              tagName: '公开'
            })
          ])
        })
      )
    })
  })

  it('防自身同名污染：在作者维度下输入“作者”时必须被拦截阻止添加并弹出警告 toast', async () => {
    render(
      <BatchTagView
        files={mockFiles}
        dimensionGroups={[]}
        onSaveTags={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('section-pan-dimensions')).toBeInTheDocument()
    })

    // 点击作者维度的“+ 新建”按钮进入输入态
    const authorCard = screen.getByText('作者').closest('.space-y-3')
    expect(authorCard).toBeInTheDocument()
    const addBtn = within(authorCard!).getByText('新建标签')
    fireEvent.click(addBtn)

    const input = await waitFor(() => screen.getByPlaceholderText('输入新标签名...'))
    expect(input).toBeInTheDocument()

    // 输入与维度同名的“作者”并敲回车
    fireEvent.change(input, { target: { value: '作者' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    // 必须触发警告且不应发起 Omni 预检
    expect(toast.warning).toHaveBeenCalledWith('维度名称不能作为标签，请输入具体标签名')
  })

  it('即时预检受控语义：输入受控标签后正确调用 inspectControlledTags 并携带目标父级 code', async () => {
    const inspectMock = vi.fn().mockResolvedValue({
      success: true,
      results: [
        {
          tagName: '塔防',
          isControlled: true,
          matchedParent: true,
          code: 'builtin.tower_defense',
          canonicalName: '塔防',
          parentCodes: ['builtin.game_type']
        }
      ]
    })
    ;(window as any).electronAPI.organizeBatch.inspectControlledTags = inspectMock

    render(
      <BatchTagView
        files={mockFiles}
        dimensionGroups={[]}
        onSaveTags={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('section-pan-dimensions')).toBeInTheDocument()
    })

    const authorCard = screen.getByText('作者').closest('.space-y-3')
    expect(authorCard).toBeInTheDocument()
    const addBtn = within(authorCard!).getByText('新建标签')
    fireEvent.click(addBtn)

    const input = await waitFor(() => screen.getByPlaceholderText('输入新标签名...'))
    fireEvent.change(input, { target: { value: '塔防' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(inspectMock).toHaveBeenCalledWith([
        { tagName: '塔防', targetParentCode: concept('作者') }
      ])
    })
  })

  it('悲观强阻断：Omni 服务超时或抛错时必须弹窗阻断添加并保留输入框文本', async () => {
    const inspectMock = vi.fn().mockRejectedValue(new Error('Omni timeout 1500ms'))
    ;(window as any).electronAPI.organizeBatch.inspectControlledTags = inspectMock

    render(
      <BatchTagView
        files={mockFiles}
        dimensionGroups={[]}
        onSaveTags={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('section-pan-dimensions')).toBeInTheDocument()
    })

    const authorCard = screen.getByText('作者').closest('.space-y-3')
    expect(authorCard).toBeInTheDocument()
    const addBtn = within(authorCard!).getByText('新建标签')
    fireEvent.click(addBtn)

    const input = await waitFor(() => screen.getByPlaceholderText('输入新标签名...'))
    fireEvent.change(input, { target: { value: '三体' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('受控标签鉴别失败: Omni 服务未就绪或响应超时')
    })

    // 输入框依然保持可见，严禁被假装成功清空
    expect(input).toBeInTheDocument()
    expect(input).toHaveValue('三体')
  })

  it('地理位置维度即使带有 isRuleSubdivision 标记，作为泛维度也绝不被过滤剔除，且能正常新建与保存标签', async () => {
    const onSaveTagsMock = vi.fn()
    const inspectMock = vi.fn().mockResolvedValue({
      success: true,
      results: [
        {
          tagName: '东京',
          isControlled: false,
          matchedParent: false,
          code: null,
          canonicalName: null,
          parentCodes: []
        }
      ]
    })
    ;(window as any).electronAPI.organizeBatch.inspectControlledTags = inspectMock

    render(
      <BatchTagView
        files={mockFiles}
        dimensionGroups={[]}
        onSaveTags={onSaveTagsMock}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('section-pan-dimensions')).toBeInTheDocument()
    })

    // 右列泛维度中必须稳定展示「地理位置」卡片
    const rightCol = screen.getByTestId('section-pan-dimensions')
    expect(rightCol).toHaveTextContent('地理位置')

    // 新建标签「东京」
    const geoCard = screen.getByText('地理位置').closest('.space-y-3')
    expect(geoCard).toBeInTheDocument()
    const addBtn = within(geoCard!).getByText('新建标签')
    fireEvent.click(addBtn)

    const input = await waitFor(() => screen.getByPlaceholderText('输入新标签名...'))
    fireEvent.change(input, { target: { value: '东京' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(inspectMock).toHaveBeenCalledWith([
        { tagName: '东京', targetParentCode: concept('地理位置') }
      ])
    })

    // 点击保存全部修改（外部顶栏保存按钮通过隐藏触发器触发）
    const saveTrigger = document.getElementById('btn-save-tags-trigger')
    expect(saveTrigger).toBeInTheDocument()
    fireEvent.click(saveTrigger!)

    await waitFor(() => {
      expect(onSaveTagsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          newTags: expect.arrayContaining([
            expect.objectContaining({
              dimensionId: 16,
              dimensionName: '地理位置',
              tagName: '东京'
            })
          ])
        })
      )
    })
  })
  it('动态泛维度归属与分类维度层级嵌套必须完全满足单一事实源规范', async () => {
    // 模拟全量预设包含：文件用途(根), 安全等级(子维度), 处理状态(子维度), 作者(泛维度), 地理位置(泛维度), 内容标签(泛维度)
    const customPresetGroups = [
      {
        id: 2,
        name: '文件用途',
        code: concept('文件用途'),
        metadata: { flag: { isPanDimension: false } },
        tags: [{ dimensionId: 2, tagValue: '办公文档', fileCount: 1 }]
      },
      {
        id: 17,
        name: '安全等级',
        code: concept('安全等级'),
        metadata: { flag: { isPanDimension: false } },
        triggerConditions: [{ parentDimension: concept('文件用途') }],
        tags: [{ dimensionId: 17, tagValue: '机密', fileCount: 0 }]
      },
      {
        id: 18,
        name: '处理状态',
        code: concept('处理状态'),
        metadata: { flag: { isPanDimension: false } },
        triggerConditions: [{ parentDimension: concept('文件用途') }],
        tags: [{ dimensionId: 18, tagValue: '待归档', fileCount: 0 }]
      },
      {
        id: 4,
        name: '作者',
        code: concept('作者'),
        metadata: { flag: { isPanDimension: true } },
        tags: [{ dimensionId: 4, tagValue: '刘慈欣', fileCount: 1 }]
      },
      {
        id: 16,
        name: '地理位置',
        code: concept('地理位置'),
        metadata: { flag: { isPanDimension: true } },
        tags: [{ dimensionId: 16, tagValue: '北京', fileCount: 0 }]
      },
      {
        id: 28,
        name: '内容标签',
        code: concept('内容标签'),
        metadata: { flag: { isPanDimension: true } },
        tags: [{ dimensionId: 28, tagValue: '科幻小说', fileCount: 0 }]
      }
    ]

    ;(window as any).electronAPI.analyzedDirectory.getDimensionGroups = vi
      .fn()
      .mockResolvedValue({ groups: customPresetGroups })

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

    const leftCol = screen.getByTestId('section-standard-dimensions')
    const rightCol = screen.getByTestId('section-pan-dimensions')

    // 1. 验证泛维度：作者、地理位置、内容标签全部归入右列泛维度区块
    expect(within(rightCol).getByText('作者')).toBeInTheDocument()
    expect(within(rightCol).getByText('地理位置')).toBeInTheDocument()
    expect(within(rightCol).getByText('内容标签')).toBeInTheDocument()

    // 泛维度绝不能出现在左列分类维度中
    expect(within(leftCol).queryByText('作者')).not.toBeInTheDocument()
    expect(within(leftCol).queryByText('地理位置')).not.toBeInTheDocument()
    expect(within(leftCol).queryByText('内容标签')).not.toBeInTheDocument()

    // 2. 验证分类维度层级：左列中只展示 1 个根分类卡片（文件用途）
    expect(within(leftCol).getByText('1 个根分类')).toBeInTheDocument()
    expect(within(leftCol).getByText('文件用途')).toBeInTheDocument()

    // 安全等级和处理状态必须作为子维度嵌套在文件用途卡片内部，而不是作为顶级独立卡片
    expect(within(leftCol).getByText('子维度 (2)')).toBeInTheDocument()
    expect(within(leftCol).getByText('安全等级')).toBeInTheDocument()
    expect(within(leftCol).getByText('处理状态')).toBeInTheDocument()
  })
})
