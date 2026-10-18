import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { OrganizeCustomFormDialog } from '../components/OrganizeCustomFormDialog'

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

describe('OrganizeCustomFormDialog 外部 AI 导入与方案弹窗组件', () => {
  const mockOnClose = vi.fn()
  const mockOnSubmit = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  it('普通自定义模式下未编辑时应使用默认策略示例', () => {
    render(
      <OrganizeCustomFormDialog
        open={true}
        onClose={mockOnClose}
        onSubmit={mockOnSubmit}
        targetMode="fast-organize"
      />
    )

    const textarea = screen.getByPlaceholderText('请直接给出目录树结构和文件归类策略') as HTMLTextAreaElement
    expect(textarea.value).toContain('以办公文员视角，按以下目录结构整理文档')
  })

  it('外部 AI 模式下输入框必须保持空白以正确展示占位符，且禁用未输入空提交', () => {
    render(
      <OrganizeCustomFormDialog
        open={true}
        onClose={mockOnClose}
        onSubmit={mockOnSubmit}
        targetMode="external-ai"
      />
    )

    const textarea = screen.getByPlaceholderText(
      '请直接粘贴外部AI生成的目录树，首行可写：虚拟目录名称：xxxx'
    ) as HTMLTextAreaElement
    // 验证缺陷 1 已彻底修复：不再被默认办公文员示例强制填充
    expect(textarea.value).toBe('')

    // 确认按钮应当被禁用（canSubmit 为 false）
    const submitBtn = screen.getByText('确定')
    expect(submitBtn.closest('button')?.disabled).toBe(true)
  })

  it('外部 AI 模式下粘贴包含【虚拟目录名称：xxxx】的目录树时，自动提取虚拟目录名', () => {
    render(
      <OrganizeCustomFormDialog
        open={true}
        onClose={mockOnClose}
        onSubmit={mockOnSubmit}
        targetMode="external-ai"
      />
    )

    const textarea = screen.getByPlaceholderText(
      '请直接粘贴外部AI生成的目录树，首行可写：虚拟目录名称：xxxx'
    ) as HTMLTextAreaElement

    fireEvent.change(textarea, {
      target: {
        value: `虚拟目录名称：科研项目工程
- 论文
  - 草稿
- 实验数据`
      }
    })

    const nameInput = screen.getByPlaceholderText('例：办公文员视角、行政综合、研发项目') as HTMLInputElement
    expect(nameInput.value).toBe('科研项目工程')

    const submitBtn = screen.getByText('确定')
    expect(submitBtn.closest('button')?.disabled).toBe(false)
    fireEvent.click(submitBtn)

    expect(mockOnSubmit).toHaveBeenCalledWith(
      '科研项目工程',
      expect.stringContaining('- 论文'),
      'external-ai'
    )
  })
})
