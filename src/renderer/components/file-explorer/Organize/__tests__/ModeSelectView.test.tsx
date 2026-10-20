import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { ModeSelectView } from '../components/ModeSelectView'
import { useSettingsStore } from '../../../../stores/settings-store'
import { toast } from '../../../common/Toast'

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

// Mock toast
vi.mock('../../../common/Toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn()
  }
}))

describe('ModeSelectView 2+3 结构化网格与高级 AI 门禁', () => {
  const mockOnSelectMode = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({
      config: {
        aiServiceMode: 'local'
      } as any
    })
  })

  it('应当正确渲染 5 种整理模式卡片', () => {
    render(<ModeSelectView onSelectMode={mockOnSelectMode} />)

    expect(screen.getByText('身份蓝图')).toBeDefined()
    expect(screen.getByText('外部AI生成目录结构')).toBeDefined()
    expect(screen.getByText('智能聚类')).toBeDefined()
    expect(screen.getByText('由文件推导目录树')).toBeDefined()
    expect(screen.getByText('自定义目录树')).toBeDefined()
  })

  it('点击【身份蓝图】应当触发 identity-blueprint 回调', () => {
    render(<ModeSelectView onSelectMode={mockOnSelectMode} />)

    fireEvent.click(screen.getByText('身份蓝图'))
    expect(mockOnSelectMode).toHaveBeenCalledWith('identity-blueprint')
  })

  it('点击【外部AI生成目录结构】应当触发 external-ai 模式回调', () => {
    render(<ModeSelectView onSelectMode={mockOnSelectMode} />)

    fireEvent.click(screen.getByText('外部AI生成目录结构'))
    expect(mockOnSelectMode).toHaveBeenCalledWith('external-ai')
  })

  it('点击【智能聚类】应当触发 smart-clustering 回调', () => {
    render(<ModeSelectView onSelectMode={mockOnSelectMode} />)

    fireEvent.click(screen.getByText('智能聚类'))
    expect(mockOnSelectMode).toHaveBeenCalledWith('smart-clustering')
  })

  it('高级 AI 引擎就绪时，点击【由文件推导目录树】应当正常触发 fine-organize 回调并显示高中生模型建议', () => {
    useSettingsStore.setState({
      config: {
        aiServiceMode: 'local'
      } as any
    })

    render(<ModeSelectView onSelectMode={mockOnSelectMode} />)

    expect(screen.getByText(/建议使用“高中生”级别以上的模型才能获取较好效果/)).toBeDefined()
    fireEvent.click(screen.getByText('由文件推导目录树'))
    expect(mockOnSelectMode).toHaveBeenCalledWith('fine-organize')
  })

  it('高级 AI 引擎禁用时，由文件推导目录树卡片应当显示锁定标签，点击弹出 Toast 提示', () => {
    useSettingsStore.setState({
      config: {
        aiServiceMode: 'disabled'
      } as any
    })

    render(<ModeSelectView onSelectMode={mockOnSelectMode} />)

    expect(screen.getByText('需开启高级AI引擎')).toBeDefined()
    fireEvent.click(screen.getByText('由文件推导目录树'))
    expect(mockOnSelectMode).not.toHaveBeenCalled()
    expect(toast.info).toHaveBeenCalledWith(
      expect.stringContaining('由文件推导目录树需要高级AI引擎支持')
    )
  })

  it('点击【自定义目录树】应当触发 custom-tree 模式回调', () => {
    render(<ModeSelectView onSelectMode={mockOnSelectMode} />)

    fireEvent.click(screen.getByText('自定义目录树'))
    expect(mockOnSelectMode).toHaveBeenCalledWith('custom-tree')
  })
})
