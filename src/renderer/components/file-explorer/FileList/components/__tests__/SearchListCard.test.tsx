import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { SearchListCard, SEARCH_LIST_ROW_HEIGHT, sanitizeSnippetHtml } from '../SearchListCard'
import type { FileType } from '../../types'

vi.mock('@app/languages', () => ({
  default: {},
  t: (key: string, params?: Record<string, unknown>) => {
    if (params && typeof params === 'object') {
      let res = key
      for (const k in params) {
        res = res.replace(new RegExp('\\{' + k + '\\}', 'g'), String(params[k]))
      }
      return res
    }
    return key
  }
}))

vi.mock('../../../../common/SystemFileIcon', () => ({
  SystemFileIcon: (props: any) => (
    <div data-testid="system-file-icon" data-path={props.path} data-ext={props.extension}>
      {props.fallback || 'ICON'}
    </div>
  )
}))

vi.mock('../../../common/Toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn()
  }
}))

describe('SearchListCard Component', () => {
  const defaultFormatSize = (size?: number) => `${size || 0} B`
  const mockItemClick = vi.fn()
  const mockContextMenu = vi.fn()
  const mockDoubleClick = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    window.electronAPI = {
      utils: {
        launchExternalDeepLink: vi.fn().mockResolvedValue({ success: true }),
        isPathEqual: (p1: string, p2: string) => p1 === p2
      },
      addToAnalysisQueue: vi.fn().mockResolvedValue(true)
    } as any
  })

  it('exports SEARCH_LIST_ROW_HEIGHT as 104', () => {
    expect(SEARCH_LIST_ROW_HEIGHT).toBe(104)
  })

  describe('sanitizeSnippetHtml', () => {
    it('allows trusted <mark> tags while escaping other dangerous HTML tags', () => {
      const dangerous = '<script>alert(1)</script><mark>高亮文本</mark><img src="x" onerror="steal()" />'
      const sanitized = sanitizeSnippetHtml(dangerous)
      expect(sanitized).toContain('<mark>高亮文本</mark>')
      expect(sanitized).not.toContain('<script>')
      expect(sanitized).toContain('&lt;script&gt;')
      expect(sanitized).not.toContain('<img')
      expect(sanitized).toContain('&lt;img')
    })

    it('handles empty or undefined input gracefully', () => {
      expect(sanitizeSnippetHtml('')).toBe('')
      expect(sanitizeSnippetHtml(undefined)).toBe('')
    })
  })

  describe('Text / Document rendering', () => {
    const textItem: FileType = {
      id: 'doc-1',
      name: '项目规划书.docx',
      smartName: '2026战略规划.docx',
      path: 'D:\\workspace\\docs\\项目规划书.docx',
      parentPath: 'D:\\workspace\\docs',
      size: 1024 * 1024 * 2.5,
      extension: 'docx',
      modifiedAt: new Date('2026-10-18T10:00:00Z'),
      snippet: '关于<mark>搜索架构</mark>重构的深度分析',
      tags: ['规划', '核心架构'],
      similarity: 0.92,
      matchType: 'semantic'
    }

    it('renders smartName and original name in Row 1', () => {
      render(
        <SearchListCard
          item={textItem}
          safeItemName="项目规划书.docx"
          formatFileSize={defaultFormatSize}
          onItemClick={mockItemClick}
          onContextMenu={mockContextMenu}
          onDoubleClick={mockDoubleClick}
          index={0}
        />
      )

      expect(screen.getByText('2026战略规划.docx')).toBeDefined()
      expect(screen.getAllByText('项目规划书.docx').length).toBeGreaterThan(0)
    })

    it('renders real filename in Row 2 with path title for hover and renders tags', () => {
      const { container } = render(
        <SearchListCard
          item={textItem}
          safeItemName="项目规划书.docx"
          formatFileSize={defaultFormatSize}
          onItemClick={mockItemClick}
          onContextMenu={mockContextMenu}
          index={0}
        />
      )

      const realNameEl = container.querySelector('[title="D:\\\\workspace\\\\docs\\\\项目规划书.docx"]')
      expect(realNameEl).toBeDefined()
      expect(screen.getByText('#规划')).toBeDefined()
      expect(screen.getByText('#核心架构')).toBeDefined()
    })

    it('renders sanitized snippet in Row 3', () => {
      render(
        <SearchListCard
          item={textItem}
          safeItemName="项目规划书.docx"
          formatFileSize={defaultFormatSize}
          onItemClick={mockItemClick}
          onContextMenu={mockContextMenu}
          index={0}
        />
      )

      expect(screen.getByText('搜索架构')).toBeDefined()
    })

    it('renders two-tier right-aligned metrics with fixed 188px column', () => {
      const { container } = render(
        <SearchListCard
          item={textItem}
          safeItemName="项目规划书.docx"
          formatFileSize={defaultFormatSize}
          onItemClick={mockItemClick}
          onContextMenu={mockContextMenu}
          index={0}
        />
      )

      const fixedMetricCol = container.querySelector('.w-\\[188px\\]')
      expect(fixedMetricCol).toBeDefined()
      expect(container.querySelector('.w-\\[70px\\]')).toBeDefined()
      expect(container.querySelector('.w-\\[108px\\]')).toBeDefined()
    })
  })

  describe('Image rendering', () => {
    const imageItem: FileType = {
      id: 'img-1',
      name: 'concept-car.png',
      path: 'D:\\workspace\\gallery\\concept-car.png',
      parentPath: 'D:\\workspace\\gallery',
      size: 1024 * 500,
      extension: 'png',
      modifiedAt: new Date('2026-10-20T08:00:00Z'),
      multimodalContent: '一辆深蓝色纯电动跑车，停在展台中心反光强烈',
      similarity: 0.96,
      matchType: 'semantic'
    }

    it('renders image thumbnail in left 64x64px area with safe file protocol', () => {
      const { container } = render(
        <SearchListCard
          item={imageItem}
          safeItemName="concept-car.png"
          formatFileSize={defaultFormatSize}
          onItemClick={mockItemClick}
          onContextMenu={mockContextMenu}
          index={0}
        />
      )

      const img = container.querySelector('img')
      expect(img).toBeDefined()
      expect(img?.getAttribute('src')).toContain('file:///')
      expect(img?.getAttribute('src')).toContain('concept-car.png')
    })

    it('falls back to SystemFileIcon if thumbnail fails to load', () => {
      const { container } = render(
        <SearchListCard
          item={imageItem}
          safeItemName="concept-car.png"
          formatFileSize={defaultFormatSize}
          onItemClick={mockItemClick}
          onContextMenu={mockContextMenu}
          index={0}
        />
      )

      const img = container.querySelector('img')
      expect(img).not.toBeNull()
      fireEvent.error(img!)
      expect(screen.getByTestId('system-file-icon')).toBeDefined()
    })

    it('renders multimodal AI description in Row 3', () => {
      render(
        <SearchListCard
          item={imageItem}
          safeItemName="concept-car.png"
          formatFileSize={defaultFormatSize}
          onItemClick={mockItemClick}
          onContextMenu={mockContextMenu}
          index={0}
        />
      )

      expect(screen.getByText('AI描述:')).toBeDefined()
      expect(screen.getByText('一辆深蓝色纯电动跑车，停在展台中心反光强烈')).toBeDefined()
    })
  })

  describe('Video rendering with chunks', () => {
    const videoItem: FileType = {
      id: 'video-1',
      name: 'highway-drive.mp4',
      path: 'D:\\workspace\\videos\\highway-drive.mp4',
      parentPath: 'D:\\workspace\\videos',
      size: 1024 * 1024 * 80,
      extension: 'mp4',
      modifiedAt: new Date('2026-10-19T12:00:00Z'),
      matchedChunks: [
        { chunkIndex: 0, startSec: 15, endSec: 45, similarity: 0.94 },
        { chunkIndex: 1, startSec: 80, endSec: 110, similarity: 0.88 }
      ]
    }

    it('renders video micro chunk frames without native video tags to protect decoders', () => {
      const { container } = render(
        <SearchListCard
          item={videoItem}
          safeItemName="highway-drive.mp4"
          formatFileSize={defaultFormatSize}
          onItemClick={mockItemClick}
          onContextMenu={mockContextMenu}
          index={0}
        />
      )

      // 验证不直接渲染原生 <video> 标签
      expect(container.querySelectorAll('video').length).toBe(0)
      // 验证渲染了 2 个微缩卡片
      expect(container.querySelectorAll('.group\\/chunk').length).toBe(2)
      // 验证渲染了时间戳
      expect(screen.getByText('00:15')).toBeDefined()
      expect(screen.getByText('01:20')).toBeDefined()
    })
  })

  describe('Audio rendering with ASR chunks', () => {
    const audioItem: FileType = {
      id: 'audio-1',
      name: 'financial-review.mp3',
      path: 'D:\\workspace\\audio\\financial-review.mp3',
      parentPath: 'D:\\workspace\\audio',
      size: 1024 * 1024 * 12,
      extension: 'mp3',
      modifiedAt: new Date('2026-10-15T09:00:00Z'),
      matchedChunks: [
        { chunkIndex: 0, startSec: 65, endSec: 95, similarity: 0.91, text: '海外研发预算分配规划' }
      ]
    }

    it('renders audio chunk chips with ASR text in Row 3', () => {
      const { container } = render(
        <SearchListCard
          item={audioItem}
          safeItemName="financial-review.mp3"
          formatFileSize={defaultFormatSize}
          onItemClick={mockItemClick}
          onContextMenu={mockContextMenu}
          index={0}
        />
      )

      expect(container.querySelectorAll('.group\\/audio').length).toBe(1)
      expect(screen.getByText('01:05 - 01:35')).toBeDefined()
      expect(screen.getByText('海外研发预算分配规划')).toBeDefined()
    })
  })

  describe('Unanalyzed item handling', () => {
    const unanalyzedItem: FileType = {
      id: 'un-1',
      name: 'raw-data.bin',
      path: 'D:\\workspace\\raw-data.bin',
      parentPath: 'D:\\workspace',
      size: 2048,
      extension: 'bin',
      modifiedAt: new Date('2026-10-21T01:00:00Z'),
      isUnanalyzed: true,
      matchType: 'unanalyzed'
    }

    it('shows unanalyzed tip and submit button in Row 3', () => {
      render(
        <SearchListCard
          item={unanalyzedItem}
          safeItemName="raw-data.bin"
          formatFileSize={defaultFormatSize}
          onItemClick={mockItemClick}
          onContextMenu={mockContextMenu}
          index={0}
        />
      )

      expect(screen.getByText('尚未进行 AI 深度分析，命中文件名')).toBeDefined()
      const analyzeBtn = screen.getByText('立即分析')
      expect(analyzeBtn).toBeDefined()
      fireEvent.click(analyzeBtn)
      expect(window.electronAPI!.addToAnalysisQueue).toHaveBeenCalled()
    })
  })

  describe('Tag filtering and three-tier sorting in SearchListCard', () => {
    it('filters out pervasive tags like 全年龄, 已归档, 无水印 by default', () => {
      const itemWithPervasiveTags: FileType = {
        id: 'filter-1',
        name: 'sample.png',
        path: 'D:\\workspace\\sample.png',
        parentPath: 'D:\\workspace',
        size: 1024,
        extension: 'png',
        modifiedAt: new Date('2026-10-21T01:00:00Z'),
        tags: ['全年龄', '已归档', '无水印', '自然风景', '日落']
      }

      render(
        <SearchListCard
          item={itemWithPervasiveTags}
          safeItemName="sample.png"
          formatFileSize={defaultFormatSize}
          onItemClick={mockItemClick}
          onContextMenu={mockContextMenu}
          index={0}
          searchKeyword="风景"
        />
      )

      expect(screen.queryByText('#全年龄')).toBeNull()
      expect(screen.queryByText('#已归档')).toBeNull()
      expect(screen.queryByText('#无水印')).toBeNull()
      expect(screen.getByText('#自然风景')).toBeDefined()
      expect(screen.getByText('#日落')).toBeDefined()
    })

    it('permits pervasive tag when explicitly searched by user', () => {
      const itemWithArchived: FileType = {
        id: 'filter-2',
        name: 'report.pdf',
        path: 'D:\\workspace\\report.pdf',
        parentPath: 'D:\\workspace',
        size: 1024,
        extension: 'pdf',
        modifiedAt: new Date('2026-10-21T01:00:00Z'),
        tags: ['全年龄', '已归档', '财务报表']
      }

      render(
        <SearchListCard
          item={itemWithArchived}
          safeItemName="report.pdf"
          formatFileSize={defaultFormatSize}
          onItemClick={mockItemClick}
          onContextMenu={mockContextMenu}
          index={0}
          searchKeyword="已归档"
        />
      )

      expect(screen.queryByText('#全年龄')).toBeNull()
      expect(screen.getByText('#已归档')).toBeDefined()
      expect(screen.getByText('#财务报表')).toBeDefined()
    })

    it('orders keyword-matched tags first, then fused tags, then other tags', () => {
      const itemWithTiers: FileType = {
        id: 'tier-1',
        name: 'photo.jpg',
        path: 'D:\\workspace\\photo.jpg',
        parentPath: 'D:\\workspace',
        size: 1024,
        extension: 'jpg',
        modifiedAt: new Date('2026-10-21T01:00:00Z'),
        tags: ['热带海滩', '晚霞', '高清4K', '日落'],
        fusedTags: ['晚霞', '日落']
      }

      const { container } = render(
        <SearchListCard
          item={itemWithTiers}
          safeItemName="photo.jpg"
          formatFileSize={defaultFormatSize}
          onItemClick={mockItemClick}
          onContextMenu={mockContextMenu}
          index={0}
          searchKeyword="海滩"
        />
      )

      const tagEls = Array.from(container.querySelectorAll('.search-list-card span'))
        .filter(el => el.textContent?.startsWith('#'))
        .map(el => el.textContent)

      expect(tagEls[0]).toBe('#热带海滩')
      expect(['#晚霞', '#日落']).toContain(tagEls[1])
      expect(['#晚霞', '#日落']).toContain(tagEls[2])
      expect(tagEls[3]).toBe('#高清4K')
    })
  })
});
