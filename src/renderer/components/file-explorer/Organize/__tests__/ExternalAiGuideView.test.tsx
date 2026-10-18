import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ExternalAiGuideView } from '../components/ExternalAiGuideView'
import { openExternalLink } from '../../../../lib/external-link'

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

// Mock openExternalLink
vi.mock('../../../../lib/external-link', () => ({
  openExternalLink: vi.fn()
}))

// Mock toast
vi.mock('../../../common/Toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn()
  }
}))

describe('ExternalAiGuideView 外部 AI 引导视图组件', () => {
  const mockGeneratePrompt = vi.fn()
  const mockOnNext = vi.fn()
  const mockOnBack = vi.fn()

  const sampleFiles = [
    { id: 1, name: '项目汇报.docx', originalPath: '/workspace/项目汇报.docx' },
    { id: 2, name: '预算表.xlsx', originalPath: '/workspace/预算表.xlsx' }
  ]

  beforeEach(() => {
    vi.clearAllMocks()

    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: vi.fn().mockResolvedValue(undefined)
      },
      configurable: true
    })

    mockGeneratePrompt.mockResolvedValue(`### 提示词
虚拟目录名称：办公规划
- 办公文件
  - 项目汇报
  - 财务预算`)

    ;(window as any).electronAPI = {
      virtualDirectory: {
        generateExternalDirectoryPlanPrompt: mockGeneratePrompt
      }
    }
  })

  it('应当正确渲染外部 AI 引导页面的标题与文件数量信息', async () => {
    render(
      <ExternalAiGuideView
        files={sampleFiles}
        highFrequencyTags={['文档', '办公']}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />
    )

    expect(screen.getByText('外部 AI 生成目录结构')).toBeDefined()
    expect(screen.getByText(/2.*个待整理文件/)).toBeDefined()

    await waitFor(() => {
      expect(mockGeneratePrompt).toHaveBeenCalled()
    })
  })

  it('挂载后应当自动生成针对当前文件的提示词并显示在文本框中', async () => {
    render(
      <ExternalAiGuideView
        files={sampleFiles}
        highFrequencyTags={['文档', '办公']}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />
    )

    await waitFor(() => {
      expect(mockGeneratePrompt).toHaveBeenCalled()
      expect(screen.getByDisplayValue(/虚拟目录名称：办公规划/)).toBeDefined()
    })
  })

  it('点击【一键复制提示词】按钮应当将提示词写入剪贴板', async () => {
    render(
      <ExternalAiGuideView
        files={sampleFiles}
        highFrequencyTags={['文档', '办公']}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />
    )

    await waitFor(() => {
      expect(screen.getByDisplayValue(/虚拟目录名称：办公规划/)).toBeDefined()
    })

    const copyBtn = screen.getByText('一键复制提示词')
    fireEvent.click(copyBtn)

    await waitFor(() => {
      expect(screen.getByText('已复制')).toBeDefined()
    })

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining('虚拟目录名称：办公规划')
    )
  })

  it('点击外部大模型卡片应当安全调用 openExternalLink 在浏览器中打开', async () => {
    render(
      <ExternalAiGuideView
        files={sampleFiles}
        highFrequencyTags={['文档', '办公']}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />
    )

    await waitFor(() => {
      expect(mockGeneratePrompt).toHaveBeenCalled()
    })

    const doubaoCard = screen.getByText('字节跳动 · 豆包')
    fireEvent.click(doubaoCard)
    expect(openExternalLink).toHaveBeenCalledWith('https://www.doubao.com/chat/')

    const chatgptCard = screen.getByText('OpenAI · ChatGPT')
    fireEvent.click(chatgptCard)
    expect(openExternalLink).toHaveBeenCalledWith('https://chatgpt.com/')
  })

  it('点击下一步应当触发 onNext 呼出自定义导入弹窗', async () => {
    render(
      <ExternalAiGuideView
        files={sampleFiles}
        highFrequencyTags={['文档', '办公']}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />
    )

    await waitFor(() => {
      expect(mockGeneratePrompt).toHaveBeenCalled()
    })

    const nextBtn = screen.getByText('第三方 AI 已生成目录结构，下一步')
    fireEvent.click(nextBtn)
    expect(mockOnNext).toHaveBeenCalled()
  })

  it('点击返回应当触发 onBack 返回模式选择', async () => {
    render(
      <ExternalAiGuideView
        files={sampleFiles}
        highFrequencyTags={['文档', '办公']}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />
    )

    await waitFor(() => {
      expect(mockGeneratePrompt).toHaveBeenCalled()
    })

    const backBtn = screen.getByText('返回模式选择')
    fireEvent.click(backBtn)
    expect(mockOnBack).toHaveBeenCalled()
  })
})
