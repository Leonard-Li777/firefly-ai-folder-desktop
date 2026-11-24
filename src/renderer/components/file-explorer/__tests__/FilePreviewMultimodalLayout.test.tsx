// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { FilePreview, computeMediaMultimodalSideBySide } from '../FilePreview'
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

    // 4. 验证内层容器具备左右响应式排布类与默认 layout-direction 标记
    const inner = multimodalBox.parentElement
    expect(inner?.className).toContain('@[600px]/preview:flex-row')
    expect(inner?.getAttribute('data-layout-direction')).toBe('auto')
  })

  it('多模态描述标题头容器具备 flex-wrap 与 gap 弹性换行样式，保障 TTS 工具条空间自适应', () => {
    render(
      <FilePreview
        filePath="D:/photos/landscape.jpg"
        fileName="landscape.jpg"
        extension="jpg"
        multimodalContent="这是一张壮阔的日落雪山风景图，红霞漫天，湖面波光粼粼。"
      />
    )

    const headerTitle = screen.getByText('多模态描述')
    const headerContainer = headerTitle.parentElement
    expect(headerContainer?.className).toContain('flex-wrap')
    expect(headerContainer?.className).toContain('gap-1.5')
  })

  it('图片触发 onLoad 事件后，正确记录 naturalWidth 与 naturalHeight 并触发响应式计算', () => {
    render(
      <FilePreview
        filePath="D:/photos/portrait.jpg"
        fileName="portrait.jpg"
        extension="jpg"
        multimodalContent="一位优雅的现代都市人物肖像，光影柔和。"
      />
    )

    const img = screen.getByRole('img', { name: 'portrait.jpg' })
    expect(img).toBeDefined()

    // 触发 onLoad
    fireEvent.load(img, {
      currentTarget: { naturalWidth: 1080, naturalHeight: 1920 }
    })

    const inner = screen.getByTestId('preview-media-inner')
    expect(inner).toBeDefined()
  })

  it('多模态描述在竖排时应挨着预览图而不是吸底：内层具备 my-auto 与 max-h-full，正文区具备 shrink 紧贴内容', () => {
    render(
      <FilePreview
        filePath="D:/photos/landscape.jpg"
        fileName="landscape.jpg"
        extension="jpg"
        multimodalContent="这是一张壮阔的日落雪山风景图，红霞漫天，湖面波光粼粼。"
      />
    )

    const multimodalBox = screen.getByTestId('preview-multimodal-box')
    const inner = screen.getByTestId('preview-media-inner')
    const img = screen.getByRole('img', { name: 'landscape.jpg' })
    const body = img.parentElement

    // 1. 内层容器具备 my-auto 与 max-h-full，使得内容作为一个整体在视口中居中，杜绝吸底
    expect(inner.className).toContain('my-auto')
    expect(inner.className).toContain('max-h-full')

    // 2. 正文包裹层具备 shrink 且不强制在竖排下撑满，使多模态描述紧挨预览图下方
    expect(body?.className).toContain('shrink')
    expect(body?.className).toContain('max-h-full')
  })

  it('多模态描述在竖排时杜绝百分比高度循环依赖，使用绝对像素动态高度防狭缝压缩，媒体容器移除 overflow-hidden 防边缘裁切', () => {
    let resizeCallback: (
      entries: Array<{ contentRect: { width: number; height: number } }>
    ) => void = () => {}
    const originalRO = window.ResizeObserver
    window.ResizeObserver = class {
      constructor(cb: any) {
        resizeCallback = cb
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as any

    try {
      render(
        <FilePreview
          filePath="D:/photos/taskmgr.png"
          fileName="taskmgr.png"
          extension="png"
          multimodalContent="这是一张特宽任务管理器截图，上下有任务栏和状态列表。"
        />
      )

      const multimodalBox = screen.getByTestId('preview-multimodal-box')
      const img = screen.getByRole('img', { name: 'taskmgr.png' })
      const body = img.parentElement

      // 1. 类名验证：绝对禁止出现锁死卡片高度在图片 43% 以下的百分比类名
      expect(multimodalBox.className).not.toContain('max-h-[30%]')
      expect(multimodalBox.className).not.toContain('max-h-[28%]')

      // 2. 媒体外层 flex 容器移除 overflow-hidden，防止特宽/超高图片顶端或底端像素被裁切
      expect(body?.className).not.toContain('overflow-hidden')

      // 3. 模拟容器尺寸通知（高 800px，宽 500px 竖排模式）
      act(() => {
        resizeCallback([{ contentRect: { width: 500, height: 800 } }])
      })

      // 4. 验证动态绝对像素上限已挂载：
      // verticalMultimodalMaxHeight = Math.min(360, Math.max(160, Math.round(800 * 0.48))) = 360px
      // maxVerticalMediaHeight = Math.max(80, 800 - 260 - 36) = 504px
      expect(multimodalBox.style.maxHeight).toBe('360px')
      expect(img.style.maxHeight).toBe('504px')
    } finally {
      window.ResizeObserver = originalRO
    }
  })

  it('视频预览在竖排模式下同样具备多模态动态绝对像素高度与媒体防挤压样式', () => {
    let resizeCallback: (
      entries: Array<{ contentRect: { width: number; height: number } }>
    ) => void = () => {}
    const originalRO = window.ResizeObserver
    window.ResizeObserver = class {
      constructor(cb: any) {
        resizeCallback = cb
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as any

    try {
      render(
        <FilePreview
          filePath="D:/videos/presentation.mp4"
          fileName="presentation.mp4"
          extension="mp4"
          multimodalContent="这是一个演示视频，介绍了产品架构与技术细节。"
        />
      )

      const multimodalBox = screen.getByTestId('preview-multimodal-box')
      expect(multimodalBox.className).not.toContain('max-h-[30%]')
      expect(multimodalBox.className).not.toContain('max-h-[28%]')

      act(() => {
        resizeCallback([{ contentRect: { width: 480, height: 600 } }])
      })

      // verticalMultimodalMaxHeight = Math.min(360, Math.max(160, Math.round(600 * 0.48))) = 288px
      expect(multimodalBox.style.maxHeight).toBe('288px')
    } finally {
      window.ResizeObserver = originalRO
    }
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

  describe('computeMediaMultimodalSideBySide 尺寸感知智能自适应算法', () => {
    it('竖图 (9:16) 在容器未达 600px 但右侧留白充足时切换为左右分栏', () => {
      // 竖图 1080x1920，容器 520x500，图片渲染宽约 263px，右侧剩余 257px >= 200px
      const result = computeMediaMultimodalSideBySide({
        containerWidth: 520,
        containerHeight: 500,
        naturalWidth: 1080,
        naturalHeight: 1920,
        mediaFitMode: 'contain',
        hasMultimodalContent: true
      })
      expect(result).toBe(true)
    })

    it('小图在全显模式下缩放很小且右侧留白充裕时切换为左右分栏', () => {
      // 小方图 200x200，容器 520x400，图片理论占用仅需 200px，右侧剩余空间充裕
      const result = computeMediaMultimodalSideBySide({
        containerWidth: 520,
        containerHeight: 400,
        naturalWidth: 200,
        naturalHeight: 200,
        mediaFitMode: 'contain',
        hasMultimodalContent: true
      })
      expect(result).toBe(true)
    })

    it('横图 (16:9) 在容器宽度紧凑时保持上下排布以避免被压扁', () => {
      // 横图 1920x1080，容器 560x400，图片横向撑满，右侧留白不足
      const result = computeMediaMultimodalSideBySide({
        containerWidth: 560,
        containerHeight: 400,
        naturalWidth: 1920,
        naturalHeight: 1080,
        mediaFitMode: 'contain',
        hasMultimodalContent: true
      })
      expect(result).toBe(false)
    })

    it('大宽屏 (>= 720px) 下无论横图竖图均支持左右分栏', () => {
      const result = computeMediaMultimodalSideBySide({
        containerWidth: 800,
        containerHeight: 600,
        naturalWidth: 1920,
        naturalHeight: 1080,
        mediaFitMode: 'contain',
        hasMultimodalContent: true
      })
      expect(result).toBe(true)
    })

    it('极窄容器 (< 440px) 保持上下排布避免双栏拥挤', () => {
      const result = computeMediaMultimodalSideBySide({
        containerWidth: 380,
        containerHeight: 500,
        naturalWidth: 1080,
        naturalHeight: 1920,
        mediaFitMode: 'contain',
        hasMultimodalContent: true
      })
      expect(result).toBe(false)
    })

    it('无多模态描述或容器未完成尺寸测量时返回安全基线', () => {
      expect(
        computeMediaMultimodalSideBySide({
          containerWidth: 800,
          containerHeight: 600,
          naturalWidth: 1080,
          naturalHeight: 1920,
          mediaFitMode: 'contain',
          hasMultimodalContent: false
        })
      ).toBe(false)

      expect(
        computeMediaMultimodalSideBySide({
          containerWidth: 0,
          containerHeight: 0,
          naturalWidth: 1080,
          naturalHeight: 1920,
          mediaFitMode: 'contain',
          hasMultimodalContent: true
        })
      ).toBeNull()
    })

    it('适宽模式与原始尺寸模式行为符合预期', () => {
      // 适宽：超宽屏左右分栏
      expect(
        computeMediaMultimodalSideBySide({
          containerWidth: 760,
          containerHeight: 500,
          naturalWidth: 1000,
          naturalHeight: 800,
          mediaFitMode: 'fit-width',
          hasMultimodalContent: true
        })
      ).toBe(true)

      // 适宽：常规宽度上下滚动排布
      expect(
        computeMediaMultimodalSideBySide({
          containerWidth: 620,
          containerHeight: 500,
          naturalWidth: 1000,
          naturalHeight: 800,
          mediaFitMode: 'fit-width',
          hasMultimodalContent: true
        })
      ).toBe(false)

      // 原始尺寸：保持上下
      expect(
        computeMediaMultimodalSideBySide({
          containerWidth: 800,
          containerHeight: 600,
          naturalWidth: 1000,
          naturalHeight: 800,
          mediaFitMode: 'original',
          hasMultimodalContent: true
        })
      ).toBe(false)
    })
  })
})
