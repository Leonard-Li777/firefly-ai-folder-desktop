// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { FileList } from '../index'

// Mock react-router-dom
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: '/' })
}))

// Mock 语言包
vi.mock('@app/languages', () => ({
  t: (key: string) => key,
  $t: (key: string) => key,
  Translate: ({ children }: any) => children,
  i18nScope: { t: (s: string) => s, activeLanguage: 'zh-CN', defaultLanguage: 'zh-CN' },
  default: { t: (s: string) => s, activeLanguage: 'zh-CN', defaultLanguage: 'zh-CN' }
}))

// Mock Toast
vi.mock('../../../common/Toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn()
  }
}))

describe('FileList search-list 模式滚动条内缩防抢 hover', () => {
  const FILE_LIST_SOURCE = resolve(__dirname, '../index.tsx')
  const sourceCode = readFileSync(FILE_LIST_SOURCE, 'utf-8')

  beforeEach(() => {
    vi.clearAllMocks()
    global.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as any
    window.electronAPI = {
      getAnalysisQueue: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      utils: {
        isPathEqual: (a: string, b: string) => a.toLowerCase() === b.toLowerCase(),
        normalizeForCache: (p: string) => p.toLowerCase(),
        stripTrailingSlash: (p: string) => p.replace(/[\\/]+$/, ''),
        isSubPath: () => false,
        getPlatform: () => 'win32'
      }
    } as any
  })

  it('源码必须包含 search-list 专用的 mr-1.5 与 6px 安全边距计算，彻底防止被 SplitPaneHandle 抢 hover', () => {
    // 1. 必须包含 effectiveSearchListWidth 计算
    expect(sourceCode).toContain('effectiveSearchListWidth')
    expect(sourceCode).toContain(
      'containerSize.width > 6 ? containerSize.width - 6 : containerSize.width'
    )

    // 2. listWrapperRef 必须携带 mr-1.5
    expect(sourceCode).toContain('className="flex-1 overflow-hidden mr-1.5" ref={listWrapperRef}')

    // 3. ListComponent 必须传入 effectiveSearchListWidth
    expect(sourceCode).toContain("width={effectiveSearchListWidth || '100%'}")
  })

  it('渲染 search-list 视图时，列表容器必须带有 mr-1.5 内缩类名', () => {
    const mockFiles = [
      {
        id: '1',
        name: 'test.pdf',
        path: 'D:/test.pdf',
        size: 1024,
        extension: 'pdf'
      }
    ]

    const { container } = render(
      <FileList
        files={mockFiles as any}
        directories={[]}
        selectedFiles={[]}
        activeItem={null}
        onFileSelect={vi.fn()}
        onDirectoryChange={vi.fn()}
        viewMode="search-list"
        loading={false}
      />
    )

    // 找到包含 mr-1.5 的容器
    const wrapper = container.querySelector('.mr-1\\.5')
    expect(wrapper).not.toBeNull()
    expect(wrapper?.className).toContain('flex-1')
    expect(wrapper?.className).toContain('overflow-hidden')
  })
})
