import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { CustomTreeView } from '../components/CustomTreeView'

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

describe('CustomTreeView 自定义目录树 Stage 组件', () => {
  const mockOnBack = vi.fn()
  const mockOnSubmit = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  it('应当正确渲染自定义目录树双栏界面与默认示例', () => {
    render(
      <CustomTreeView
        onBack={mockOnBack}
        onSubmit={mockOnSubmit}
        workspaceDirectoryPath="/path/to/my-workspace"
      />
    )

    expect(screen.getByText('自定义目录树')).toBeDefined()
    expect(screen.getByText('实时目录树预览')).toBeDefined()
    expect(screen.getByText('下一步：微调目录结构')).toBeDefined()
  })

  it('外部 AI 模式下应当展示外部 AI 标题与相应占位提示', () => {
    render(
      <CustomTreeView
        isExternalAi={true}
        onBack={mockOnBack}
        onSubmit={mockOnSubmit}
        workspaceDirectoryPath="/path/to/my-workspace"
      />
    )

    expect(screen.getByText('导入外部 AI 生成的目录结构')).toBeDefined()
    expect(screen.getByText('外部AI生成')).toBeDefined()
  })

  it('当文本内容为空时下一步按钮应当禁用', () => {
    render(
      <CustomTreeView
        isExternalAi={true}
        initialStrategy=""
        onBack={mockOnBack}
        onSubmit={mockOnSubmit}
      />
    )

    const nextButton = screen.getByText('下一步：微调目录结构').closest('button')
    expect(nextButton?.disabled).toBe(true)
  })

  it('输入 Markdown 目录树后应当实时解析并支持点击下一步提交', () => {
    render(
      <CustomTreeView
        onBack={mockOnBack}
        onSubmit={mockOnSubmit}
        workspaceDirectoryPath="/path/to/my-workspace"
      />
    )

    const nextButton = screen.getByText('下一步：微调目录结构').closest('button')
    expect(nextButton?.disabled).toBe(false)

    fireEvent.click(nextButton!)
    expect(mockOnSubmit).toHaveBeenCalled()
    const [calledName, calledStrategy, calledTree] = mockOnSubmit.mock.calls[0]
    expect(calledName).toBeDefined()
    expect(calledStrategy).toContain('办公文档')
    expect(Array.isArray(calledTree)).toBe(true)
    expect(calledTree.length).toBeGreaterThan(0)
  })

  it('首行包含【虚拟目录名称：xxxx】时应当自动提取并填入目录名', () => {
    render(
      <CustomTreeView
        initialStrategy={`虚拟目录名称：研发项目综合方案\n- 源码\n- 文档`}
        onBack={mockOnBack}
        onSubmit={mockOnSubmit}
      />
    )

    const nextButton = screen.getByText('下一步：微调目录结构').closest('button')
    fireEvent.click(nextButton!)

    expect(mockOnSubmit).toHaveBeenCalled()
    const [calledName] = mockOnSubmit.mock.calls[0]
    expect(calledName).toBe('研发项目综合方案')
  })

  it('点击返回按钮应当正确触发 onBack 回调', () => {
    render(
      <CustomTreeView
        onBack={mockOnBack}
        onSubmit={mockOnSubmit}
      />
    )

    fireEvent.click(screen.getByText('返回模式选择'))
    expect(mockOnBack).toHaveBeenCalledTimes(1)
  })

  it('应当能够从 localStorage 恢复缓存的目录名称和策略草稿', () => {
    const wsPath = '/path/to/my-workspace'
    localStorage.setItem(`organize_custom_name_${wsPath}`, '缓存的草稿方案')
    localStorage.setItem(`organize_custom_strategy_${wsPath}`, '- 缓存目录1\n- 缓存目录2')

    render(
      <CustomTreeView
        onBack={mockOnBack}
        onSubmit={mockOnSubmit}
        workspaceDirectoryPath={wsPath}
      />
    )

    const input = screen.getByPlaceholderText('例：办公文员视角、行政综合、研发项目') as HTMLInputElement
    expect(input.value).toBe('缓存的草稿方案')
    expect(screen.getByText('缓存目录1')).toBeDefined()
  })

  it('点击清空时应当同步清除 localStorage 缓存', () => {
    const wsPath = '/path/to/my-workspace'
    localStorage.setItem(`organize_custom_name_${wsPath}`, '待清空方案')
    localStorage.setItem(`organize_custom_strategy_${wsPath}`, '- 待清空目录')

    render(
      <CustomTreeView
        onBack={mockOnBack}
        onSubmit={mockOnSubmit}
        workspaceDirectoryPath={wsPath}
      />
    )

    fireEvent.click(screen.getByText('清空'))

    expect(localStorage.getItem(`organize_custom_name_${wsPath}`)).toBeNull()
    expect(localStorage.getItem(`organize_custom_strategy_${wsPath}`)).toBeNull()
  })
})
