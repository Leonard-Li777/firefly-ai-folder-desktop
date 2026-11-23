// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// Mock window.electronAPI
;(window as any).electronAPI = {
  userTier: {
    getProfile: vi.fn().mockResolvedValue({ tier: 'free', status: 'ACTIVE' })
  },
  utils: {
    isPathEqual: (a: string, b: string) => a === b,
    normalizePath: (p: string) => p
  },
  onAnalysisQueueUpdated: vi.fn().mockReturnValue(() => {}),
  onFileAnalysisStatusChanged: vi.fn().mockReturnValue(() => {}),
  getFileAnalysis: vi.fn().mockResolvedValue(null)
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

import { FileDetailsPanel } from '../index'
import type { FileItem } from '@firefly/types'

describe('FileDetailsPanel (容器感知响应式双列流)', () => {
  const mockFile: FileItem = {
    id: 'f-details-1',
    name: 'test-document.pdf',
    path: 'D:/test/test-document.pdf',
    extension: 'pdf',
    size: 2048,
    createdAt: new Date(),
    updatedAt: new Date(),
    isDirectory: false
  }

  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
  })

  it('AC-1 & AC-2: 根容器声明 @container/details 且包含 @[540px]/details:grid-cols-2 双列断点规则', () => {
    render(
      <MemoryRouter>
        <FileDetailsPanel item={mockFile} />
      </MemoryRouter>
    )

    const container = screen.getByTestId('file-details-container')
    expect(container).toBeDefined()
    expect(container.className).toContain('@container/details')
    expect(container.className).toContain('grid-cols-1')
    expect(container.className).toContain('@[540px]/details:grid-cols-2')
  })

  it('AC-3: 左右两列 DOM 外壳恒定共存，避免响应式切换导致子组件 Remount', () => {
    render(
      <MemoryRouter>
        <FileDetailsPanel item={mockFile} />
      </MemoryRouter>
    )

    const leftCol = screen.getByTestId('details-left-column')
    const rightCol = screen.getByTestId('details-right-column')
    expect(leftCol).toBeDefined()
    expect(rightCol).toBeDefined()
  })

  it('AC-4: 祖先尺寸链完整，两列外壳均持有 min-h-0 与 overflow-y-auto 独立滚动契约', () => {
    render(
      <MemoryRouter>
        <FileDetailsPanel item={mockFile} />
      </MemoryRouter>
    )

    const leftCol = screen.getByTestId('details-left-column')
    const rightCol = screen.getByTestId('details-right-column')

    expect(leftCol.className).toContain('min-h-0')
    expect(leftCol.className).toContain('min-w-0')
    expect(leftCol.className).toContain('overflow-y-auto')

    expect(rightCol.className).toContain('min-h-0')
    expect(rightCol.className).toContain('min-w-0')
    expect(rightCol.className).toContain('overflow-y-auto')
  })
})
