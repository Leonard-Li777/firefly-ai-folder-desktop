import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import {
  IdentityBlueprintSelectView,
  RecommendedIdentityItem,
  RecommendedStructureItem
} from '../components/IdentityBlueprintSelectView'

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

// Mock 语言包
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

describe('IdentityBlueprintSelectView Component', () => {
  const mockMatchPerspectives = vi.fn()
  const mockSelectStructure = vi.fn()
  const mockOnBack = vi.fn()

  const mockIdentities: RecommendedIdentityItem[] = [
    {
      identityId: 'ui_designer',
      domainId: 'domain_creative',
      categoryId: 'cat_design',
      name: 'UI设计师',
      description: '负责界面视觉与用户交互规范',
      score: 0.92,
      breadcrumbs: ['创意与媒体', '视觉设计', 'UI设计师'],
      taskTags: ['原型', '组件库', '设计规范'],
      associatedTemplateIds: ['tpl_ui_design'],
      aliases: ['界面设计', 'GUI设计师']
    },
    {
      identityId: 'accountant',
      domainId: 'domain_finance',
      categoryId: 'cat_accounting',
      name: '财务会计',
      description: '负责财务凭证与税务审核',
      score: 0.81,
      breadcrumbs: ['商业与金融', '财务审计', '财务会计'],
      taskTags: ['发票', '凭证', '报表'],
      associatedTemplateIds: ['tpl_finance_accounting'],
      aliases: ['出纳', '财务专员']
    }
  ]

  const mockStructures: RecommendedStructureItem[] = [
    {
      templateId: 'tpl_ui_design',
      name: 'UI/UX 设计全生命周期模板',
      targetIdentities: ['ui_designer'],
      paths: ['01_需求与调研/用户访谈', '02_设计资产/设计规范', '03_交付成果/高保真原型'],
      score: 0.94,
      rationale: '与当前选中的 UI设计师 强相关，覆盖完整设计流',
      lifecycleStages: ['需求', '设计', '交付']
    },
    {
      templateId: 'tpl_finance_accounting',
      name: '标准财务会计归档模板',
      targetIdentities: ['accountant'],
      paths: ['01_原始凭证/发票收据', '02_月度报表/资产负债表'],
      score: 0.83,
      rationale: '适合财务凭证与报表归档'
    }
  ]

  beforeEach(() => {
    vi.clearAllMocks()

    mockMatchPerspectives.mockResolvedValue({
      recommendedIdentities: mockIdentities,
      recommendedStructures: mockStructures
    })

    ;(window as any).electronAPI = {
      organizeRealDirectory: {
        matchPerspectivesAndStructures: mockMatchPerspectives
      }
    }
  })

  it('首启应自动触发协同推荐，并展示身份与推荐结构卡片', async () => {
    render(
      <IdentityBlueprintSelectView
        workspaceId={1}
        workspaceDirectoryPath="/test/workspace"
        fileIds={[101, 102]}
        onSelectStructure={mockSelectStructure}
        onBack={mockOnBack}
      />
    )

    expect(mockMatchPerspectives).toHaveBeenCalledWith({
      workspaceId: 1,
      fileIds: [101, 102],
      naturalLanguagePrompt: '',
      language: 'zh-CN'
    })

    await waitFor(() => {
      // 检查身份树渲染
      expect(screen.getByText('UI设计师')).toBeInTheDocument()
      // 检查推荐结构卡片渲染
      expect(screen.getByText('UI/UX 设计全生命周期模板')).toBeInTheDocument()
      expect(screen.getByText('标准财务会计归档模板')).toBeInTheDocument()
    })
  })

  it('用户输入自然语言意图并回车应重新触发协同匹配', async () => {
    render(
      <IdentityBlueprintSelectView
        workspaceId={1}
        workspaceDirectoryPath="/test/workspace"
        onSelectStructure={mockSelectStructure}
      />
    )

    await waitFor(() => {
      expect(screen.getByText('UI设计师')).toBeInTheDocument()
    })

    const input = screen.getByPlaceholderText(/搜索身份或输入诉求/)
    fireEvent.change(input, { target: { value: '摄影与短视频制作' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })

    await waitFor(() => {
      expect(mockMatchPerspectives).toHaveBeenCalledWith({
        workspaceId: 1,
        fileIds: [],
        naturalLanguagePrompt: '摄影与短视频制作',
        language: 'zh-CN'
      })
    })
  })

  it('点击结构卡片的“使用此结构”按钮应触发 onSelectStructure 回调', async () => {
    render(
      <IdentityBlueprintSelectView
        workspaceId={1}
        workspaceDirectoryPath="/test/workspace"
        onSelectStructure={mockSelectStructure}
      />
    )

    await waitFor(() => {
      expect(screen.getByText('UI/UX 设计全生命周期模板')).toBeInTheDocument()
    })

    const useBtns = screen.getAllByText('使用此结构')
    expect(useBtns.length).toBeGreaterThan(0)
    fireEvent.click(useBtns[0])

    expect(mockSelectStructure).toHaveBeenCalledWith({
      templateId: 'tpl_ui_design',
      name: 'UI/UX 设计全生命周期模板',
      paths: ['01_需求与调研/用户访谈', '02_设计资产/设计规范', '03_交付成果/高保真原型'],
      rationale: '与当前选中的 UI设计师 强相关，覆盖完整设计流',
      identities: []
    })
  })

  it('勾选产品经理身份时，应优先置顶敏捷产品规划模板而非UI/UX设计模板', async () => {
    const pmIdentities: RecommendedIdentityItem[] = [
      {
        identityId: 'id.pm.product',
        domainId: 'domain_work_it',
        categoryId: 'cat_product_design',
        name: '产品经理 (PM)',
        description: '负责PRD需求文档与功能路线图',
        score: 0.95,
        breadcrumbs: ['数字化技术与研发', '产品规划与体验设计', '产品经理 (PM)'],
        taskTags: ['需求', 'PRD'],
        associatedTemplateIds: ['tpl_pm_product_workflow']
      }
    ]

    const pmStructures: RecommendedStructureItem[] = [
      {
        templateId: 'tpl_ui_ux_standard',
        name: '专业 UI/UX 设计素材库',
        targetIdentities: ['id.designer.ui'], // 已移除了 id.pm.product
        paths: ['10-设计规范与组件库'],
        score: 0.88,
        rationale: '设计规范'
      },
      {
        templateId: 'tpl_pm_product_workflow',
        name: '敏捷产品经理与PRD需求规划工作流',
        targetIdentities: ['id.pm.product'],
        paths: ['01-战略路线图与商业分析', '03-需求规划与PRD文档'],
        score: 0.92,
        rationale: '覆盖产品愿景规划与PRD规格书'
      }
    ]

    mockMatchPerspectives.mockResolvedValueOnce({
      recommendedIdentities: pmIdentities,
      recommendedStructures: pmStructures
    })

    render(
      <IdentityBlueprintSelectView
        workspaceId={1}
        workspaceDirectoryPath="/test/workspace"
        onSelectStructure={mockSelectStructure}
      />
    )

    await waitFor(() => {
      expect(screen.getByText('产品经理 (PM)')).toBeInTheDocument()
    })

    // 点击复选框勾选“产品经理 (PM)”
    const pmCheckbox = screen.getByRole('checkbox', { name: /产品经理/i })
    fireEvent.click(pmCheckbox)

    // 勾选后，displayStructures 必须将 targetIdentities 包含 id.pm.product 的模板排在首位
    await waitFor(() => {
      const titles = screen.getAllByRole('heading', { level: 4 })
      const titleTexts = titles.map(el => el.textContent)
      expect(titleTexts[0]).toContain('敏捷产品经理与PRD需求规划工作流')
      expect(titleTexts[0]).not.toContain('专业 UI/UX 设计素材库')
    })
  })

  it('用户输入搜索词时应即时过滤身份列表并自动展开匹配项', async () => {
    render(
      <IdentityBlueprintSelectView
        workspaceId={1}
        workspaceDirectoryPath="/test/workspace"
        onSelectStructure={mockSelectStructure}
      />
    )

    await waitFor(() => {
      expect(screen.getByText('UI设计师')).toBeInTheDocument()
    })

    const searchInput = screen.getByPlaceholderText(/搜索身份或输入诉求/i)
    fireEvent.change(searchInput, { target: { value: '财务' } })

    // 即时过滤：搜索自动展开命中分类，界面上应展示财务会计，而 UI设计师 被过滤隐藏
    await waitFor(() => {
      expect(screen.getByText('财务会计')).toBeInTheDocument()
      expect(screen.queryByText('UI设计师')).not.toBeInTheDocument()
      expect(screen.getByText(/搜索结果 \(1 个身份\)/i)).toBeInTheDocument()
    })

    // 输入无匹配的词时应展示友好空状态
    fireEvent.change(searchInput, { target: { value: '不存在的奇异外星人角色' } })
    await waitFor(() => {
      expect(screen.getByText(/未找到匹配“不存在的奇异外星人角色”的身份/i)).toBeInTheDocument()
    })
  })

  it('用户输入身份别名时也应精准命中该身份并自动展开', async () => {
    render(
      <IdentityBlueprintSelectView
        workspaceId={1}
        workspaceDirectoryPath="/test/workspace"
        onSelectStructure={mockSelectStructure}
      />
    )

    await waitFor(() => {
      expect(screen.getByText('UI设计师')).toBeInTheDocument()
    })

    const searchInput = screen.getByPlaceholderText(/搜索身份或输入诉求/i)
    // 输入别名“出纳”（属于财务会计）
    fireEvent.change(searchInput, { target: { value: '出纳' } })

    await waitFor(() => {
      expect(screen.getByText('财务会计')).toBeInTheDocument()
      expect(screen.queryByText('UI设计师')).not.toBeInTheDocument()
      expect(screen.getByText(/搜索结果 \(1 个身份\)/i)).toBeInTheDocument()
    })
  })
})
