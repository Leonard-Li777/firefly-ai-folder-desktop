// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen } from '@testing-library/react'
import { FilePreview } from '../FilePreview'
import { PreviewSection } from '../FileDetailsPanel/components/PreviewSection'

// Mock electronAPI
;(window as any).electronAPI = {
  utils: {
    isPathEqual: (a: string, b: string) => a === b,
    toSafeFileUrl: (p: string) => `file://${p}`
  }
}

// Mock 语言包
vi.mock('@app/languages', () => ({
  t: (str: string) => str,
  default: {}
}))

vi.mock('@voerkai18n/react', () => ({
  useVoerkaI18n: () => ({
    t: (str: string) => str,
    activeLanguage: 'zh-CN'
  })
}))

vi.mock('../../../lib/posthog', () => ({ captureEvent: vi.fn() }))

describe('FilePreview & PreviewSection 响应式弹性与多模态布局契约', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('图片预览包含多模态描述时，容器具备 @container/preview 且内层具备左右自适应类', () => {
    render(
      <FilePreview
        filePath="D:/photos/landscape.jpg"
        fileName="landscape.jpg"
        extension="jpg"
        multimodalContent="这是一张壮阔的日落雪山风景图，红霞漫天，湖面波光粼粼。"
      />
    )

    // 1. 验证多模态描述文本卡片已渲染
    const multimodalBox = screen.getByTestId('preview-multimodal-box')
    expect(multimodalBox).toBeDefined()
    expect(multimodalBox.textContent).toContain('多模态描述')
    expect(multimodalBox.textContent).toContain('这是一张壮阔的日落雪山风景图')

    // 2. 验证容器查询标记与左右响应式类名
    const outer = multimodalBox.closest('.\\@container\\/preview')
    expect(outer).toBeDefined()

    // 3. 验证在 contain 模式下，多模态卡片支持左右并排 (@[600px]/preview)
    expect(multimodalBox.className).toContain('@[600px]/preview:w-80')
    expect(multimodalBox.className).toContain('@[600px]/preview:max-h-full')

    // 4. 验证内层容器具备左右响应式排布类
    const inner = multimodalBox.parentElement
    expect(inner?.className).toContain('@[600px]/preview:flex-row')
  })

  it('PreviewSection 中分析耗时超长模型名具备 w-full min-w-0 防撑破与完整 title', () => {
    const mockStats = {
      durationMs: 2345,
      model: 'MiniCPM-V 4.7 1B（识图小钢炮•越狱）'
    }
    const mockAnalysis = {
      analysisStats: mockStats,
      itemType: 'file'
    }

    render(
      <PreviewSection
        displayUrl="file://D:/photos/landscape.jpg"
        item={{ path: 'D:/photos/landscape.jpg', name: 'landscape.jpg' }}
        isDirectory={false}
        showDirectory={false}
        analysisResult={mockAnalysis}
        isFileAnalysis={() => true}
      />
    )

    // 验证分析耗时展示
    expect(screen.getByText(/分析耗时/)).toBeDefined()
    expect(screen.getByText(/MiniCPM-V 4.7 1B（识图小钢炮•越狱）/)).toBeDefined()

    // 验证外层容器与胶囊具备防撑破契约
    const timeSpan = screen.getByText(/分析耗时/)
    const pill = timeSpan.closest('.rounded-full')
    expect(pill).toBeDefined()
    expect(pill?.className).toContain('min-w-0')
    expect(pill?.className).toContain('overflow-hidden')
    expect(pill?.getAttribute('title')).toContain('MiniCPM-V 4.7 1B（识图小钢炮•越狱）')

    const wrapper = pill?.parentElement
    expect(wrapper?.className).toContain('min-w-0')
    expect(wrapper?.className).toContain('w-full')
  })
})
