import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { concept, getCanonicalConceptName } from '@firefly/shared'
import { SearchListCard, SEARCH_LIST_ROW_HEIGHT, sanitizeSnippetHtml, toSafeFileUrl } from '../SearchListCard'
import type { FileType } from '../../types'
import { usePreviewOverlayStore, setCurrentVideoPlaybackTime, getCurrentVideoPlaybackTime } from '../../../../../stores/preview-overlay-store'

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

describe('toSafeFileUrl utility', () => {
  it('converts Windows drive path to safe file URL', () => {
    expect(toSafeFileUrl('D:\\workspace\\cat.png')).toBe('file:///D:/workspace/cat.png')
  })

  it('encodes special characters like # and spaces in paths', () => {
    expect(toSafeFileUrl('D:\\workspace\\设计图#1 [最新].png')).toBe(
      'file:///D:/workspace/%E8%AE%BE%E8%AE%A1%E5%9B%BE%231%20%5B%E6%9C%80%E6%96%B0%5D.png'
    )
  })

  it('handles empty path safely', () => {
    expect(toSafeFileUrl('')).toBe('')
  })
})

describe('SearchListCard Component', () => {
  const defaultFormatSize = (size?: number) => `${size || 0} B`
  const mockItemClick = vi.fn()
  const mockContextMenu = vi.fn()
  const mockDoubleClick = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    const baseApi = {
      utils: {
        launchExternalDeepLink: vi.fn().mockResolvedValue({ success: true }),
        openFileWithDefaultApp: vi.fn().mockResolvedValue(true),
        isPathEqual: (p1: string, p2: string) => p1 === p2
      },
      addToAnalysisQueue: vi.fn().mockResolvedValue(true),
      onModelStatusChanged: vi.fn().mockReturnValue(() => {}),
      onAIServiceError: vi.fn().mockReturnValue(() => {}),
      getAIStatus: vi.fn().mockResolvedValue({ status: 'ready' }),
      getAIModelStatus: vi.fn().mockResolvedValue({ status: 'ready' })
    }
    window.electronAPI = new Proxy(baseApi, {
      get(target: any, prop: string) {
        if (prop in target) return target[prop]
        if (typeof prop === 'string' && prop.startsWith('on')) {
          return vi.fn().mockReturnValue(() => {})
        }
        return vi.fn().mockResolvedValue(undefined)
      }
    }) as any
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

    it('swaps primary and secondary filenames when swapFileNameDisplay is true', () => {
      const { container } = render(
        <SearchListCard
          item={textItem}
          safeItemName="项目规划书.docx"
          formatFileSize={defaultFormatSize}
          onItemClick={mockItemClick}
          onContextMenu={mockContextMenu}
          index={0}
          swapFileNameDisplay={true}
        />
      )

      // Row 1 应该是真实文件名，Row 2 应该是智能文件名
      const row1Title = container.querySelector('.text-\\[13px\\]')
      expect(row1Title?.textContent).toContain('项目规划书.docx')

      const row2Subtitle = container.querySelector('[title="D:\\\\workspace\\\\docs\\\\项目规划书.docx"]')
      expect(row2Subtitle?.textContent).toContain('2026战略规划.docx')
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

    it('renders right-aligned metrics with deterministic date (70px) and size (50px) columns', () => {
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

      expect(container.querySelector('.w-\\[70px\\]')).not.toBeNull()
      expect(container.querySelector('.w-\\[50px\\]')).not.toBeNull()
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

    it('resolves relative thumbnailPath using workspaceDirectoryPath prop', () => {
      const relativeThumbItem: FileType = {
        ...imageItem,
        thumbnailPath: '.VirtualDirectory/.thumbnail/thumb-1.webp'
      }
      const { container } = render(
        <SearchListCard
          item={relativeThumbItem}
          safeItemName="concept-car.png"
          workspaceDirectoryPath="D:\\workspace"
          formatFileSize={defaultFormatSize}
          onItemClick={mockItemClick}
          onContextMenu={mockContextMenu}
          index={0}
        />
      )
      const img = container.querySelector('img')
      expect(img).not.toBeNull()
      expect(img?.getAttribute('src')).toBe('file:///D:/workspace/.VirtualDirectory/.thumbnail/thumb-1.webp')
    })

    it('infers workspaceDirectoryPath from item.path containing .VirtualDirectory', () => {
      const virtualPathItem: FileType = {
        ...imageItem,
        path: 'D:\\projects\\repo\\.VirtualDirectory\\images\\cat.png',
        thumbnailPath: '.VirtualDirectory/.thumbnail/cat-thumb.webp'
      }
      const { container } = render(
        <SearchListCard
          item={virtualPathItem}
          safeItemName="cat.png"
          formatFileSize={defaultFormatSize}
          onItemClick={mockItemClick}
          onContextMenu={mockContextMenu}
          index={0}
        />
      )
      const img = container.querySelector('img')
      expect(img).not.toBeNull()
      expect(img?.getAttribute('src')).toBe('file:///D:/projects/repo/.VirtualDirectory/.thumbnail/cat-thumb.webp')
    })

    it('gracefully falls back from thumbnail to original image, and to icon only when both fail', () => {
      const dualSourceItem: FileType = {
        ...imageItem,
        path: 'D:\\workspace\\gallery\\original-photo.png',
        thumbnailPath: 'D:\\workspace\\thumbnails\\broken-thumb.webp'
      }
      const { container } = render(
        <SearchListCard
          item={dualSourceItem}
          safeItemName="original-photo.png"
          formatFileSize={defaultFormatSize}
          onItemClick={mockItemClick}
          onContextMenu={mockContextMenu}
          index={0}
        />
      )
      const img = container.querySelector('img')
      expect(img).not.toBeNull()
      expect(img?.getAttribute('src')).toBe('file:///D:/workspace/thumbnails/broken-thumb.webp')

      // 第一次失败：缩略图损坏，平滑降级渲染原图
      fireEvent.error(img!)
      expect(container.querySelector('img')?.getAttribute('src')).toBe('file:///D:/workspace/gallery/original-photo.png')

      // 第二次失败：原图也损坏，退化为系统图标
      fireEvent.error(container.querySelector('img')!)
      expect(screen.getByTestId('system-file-icon')).toBeDefined()
    })

    it('identifies image even if path has no extension but item.extension is set', () => {
      const extensionOnlyItem: FileType = {
        id: 'img-virtual',
        name: 'abstract-art',
        path: 'virtual-id-12345',
        extension: 'png',
        size: 2048,
        modifiedAt: new Date('2026-10-20T08:00:00Z')
      }
      const { container } = render(
        <SearchListCard
          item={extensionOnlyItem}
          safeItemName="abstract-art"
          formatFileSize={defaultFormatSize}
          onItemClick={mockItemClick}
          onContextMenu={mockContextMenu}
          index={0}
        />
      )
      expect(container.querySelector('img')).not.toBeNull()
    })

    it('falls back to SystemFileIcon if single image source fails to load', () => {
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

    it('renders video micro chunk frames with time-anchored video preview and timestamp badge', () => {
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

      // 验证渲染了 2 个微缩卡片
      expect(container.querySelectorAll('.group\\/chunk').length).toBe(2)

      // 验证渲染了带有时间锚点的 video 抽帧缩略图
      const videos = container.querySelectorAll('video')
      expect(videos.length).toBe(2)
      expect(videos[0].getAttribute('src')).toContain('#t=15')
      expect(videos[1].getAttribute('src')).toContain('#t=80')

      // 验证渲染了完整起止时间戳
      expect(screen.getByText('00:15 - 00:45')).toBeDefined()
      expect(screen.getByText('01:20 - 01:50')).toBeDefined()
    })

    it('hides timestamp badge by default with opacity-0 and reveals on hover', () => {
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

      // 验证微型时间胶囊包含 opacity-0，保证画面纯净不遮挡
      const badges = container.querySelectorAll('.group\\/chunk .opacity-0')
      expect(badges.length).toBeGreaterThanOrEqual(2)
    })

    it('triggers item selection and opens preview with seek timestamp upon clicking video chunk', () => {
      const { container } = render(
        <SearchListCard
          item={videoItem}
          safeItemName="highway-drive.mp4"
          formatFileSize={defaultFormatSize}
          onItemClick={mockItemClick}
          onContextMenu={mockContextMenu}
          index={3}
        />
      )

      const firstChunk = container.querySelector('.group\\/chunk')
      expect(firstChunk).not.toBeNull()
      fireEvent.click(firstChunk!)

      // 验证触发了父级行选中
      expect(mockItemClick).toHaveBeenCalledWith(3, expect.anything())

      // 验证触发了预览跳轴参数同步
      const previewState = usePreviewOverlayStore.getState()
      expect(previewState.filePath).toBe(videoItem.path)
      expect(previewState.currentTime).toBe(15)
      expect(previewState.highlightRange).toEqual([15, 45])
    })
    it('does not re-trigger onItemClick on second chunk click when already active, avoiding selection toggle off', () => {
      const { container, rerender } = render(
        <SearchListCard
          item={videoItem}
          safeItemName="highway-drive.mp4"
          formatFileSize={defaultFormatSize}
          onItemClick={mockItemClick}
          onContextMenu={mockContextMenu}
          index={3}
          isActive={false}
          isSelected={false}
        />
      )

      const chunks = container.querySelectorAll('.group\\/chunk')
      expect(chunks.length).toBeGreaterThanOrEqual(2)

      // 第一次点击：未激活时，通知父级选中
      fireEvent.click(chunks[0])
      expect(mockItemClick).toHaveBeenCalledTimes(1)
      expect(usePreviewOverlayStore.getState().currentTime).toBe(15)

      // 模拟父级状态已将该行激活/选中
      rerender(
        <SearchListCard
          item={videoItem}
          safeItemName="highway-drive.mp4"
          formatFileSize={defaultFormatSize}
          onItemClick={mockItemClick}
          onContextMenu={mockContextMenu}
          index={3}
          isActive={true}
          isSelected={true}
        />
      )

      // 第二次点击（点击另一个切片）：不重复调用 onItemClick，防范父级单选 toggle 取消选择
      fireEvent.click(chunks[1])
      expect(mockItemClick).toHaveBeenCalledTimes(1) // 依然是 1 次，没有被再次调用！
      // 但时间轴精准更新为第 2 个切片的时间 (startSec = 80)
      expect(usePreviewOverlayStore.getState().currentTime).toBe(80)
      expect(usePreviewOverlayStore.getState().highlightRange).toEqual([80, 110])
    })

    it('Ticket 05: dual-track seek and highlightRange decoupling with repPtsSec and seekSec', () => {
      const dualTrackItem: FileType = {
        id: 'vid-dual-track',
        name: 'racing-action.mp4',
        path: 'D:\\workspace\\videos\\racing-action.mp4',
        category: 'video',
        parentPath: 'D:\\workspace\\videos',
        size: 1024 * 1024 * 80,
        extension: 'mp4',
        modifiedAt: new Date('2026-10-19T12:00:00Z'),
        matchedChunks: [
          {
            chunkIndex: 0,
            startSec: 10.0,
            endSec: 25.0,
            repPtsSec: 18.0,
            seekSec: 16.5,
            similarity: 0.95
          }
        ]
      }

      const { container } = render(
        <SearchListCard
          item={dualTrackItem}
          safeItemName="racing-action.mp4"
          formatFileSize={defaultFormatSize}
          onItemClick={mockItemClick}
          onContextMenu={mockContextMenu}
          index={0}
        />
      )

      // 缩略图封面严格使用 repPtsSec (18) 取帧
      const video = container.querySelector('video')
      expect(video).not.toBeNull()
      expect(video!.getAttribute('src')).toContain('#t=18')

      // 角标显示完整起止时间
      expect(screen.getByText('00:10 - 00:25')).toBeDefined()

      // 点击切片
      const chunkEl = container.querySelector('.group\\/chunk')
      expect(chunkEl).not.toBeNull()
      fireEvent.click(chunkEl!)

      // 验证双轨解耦：currentTime 严格为动作前摇 seekSec (16.5)，highlightRange 严格为完整物理区间 [10, 25] (左翼无吞噬)
      const previewState = usePreviewOverlayStore.getState()
      expect(previewState.currentTime).toBe(16.5)
      expect(previewState.highlightRange).toEqual([10.0, 25.0])
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

    it('triggers item selection and opens preview upon clicking audio chunk', () => {
      const { container } = render(
        <SearchListCard
          item={audioItem}
          safeItemName="financial-review.mp3"
          formatFileSize={defaultFormatSize}
          onItemClick={mockItemClick}
          onContextMenu={mockContextMenu}
          index={1}
        />
      )

      const chip = container.querySelector('.group\\/audio')
      expect(chip).not.toBeNull()
      fireEvent.click(chip!)

      // 验证触发了父级行选中
      expect(mockItemClick).toHaveBeenCalledWith(1, expect.anything())

      // 验证触发了音频切片跳轴参数同步
      const previewState = usePreviewOverlayStore.getState()
      expect(previewState.filePath).toBe(audioItem.path)
      expect(previewState.currentTime).toBe(65)
      expect(previewState.highlightRange).toEqual([65, 95])
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
      const allAges = getCanonicalConceptName(concept('全年龄'))!
      const archived = getCanonicalConceptName(concept('已归档'))!
      const noWatermark = getCanonicalConceptName(concept('无水印'))!

      const itemWithPervasiveTags: FileType = {
        id: 'filter-1',
        name: 'sample.png',
        path: 'D:\\workspace\\sample.png',
        parentPath: 'D:\\workspace',
        size: 1024,
        extension: 'png',
        modifiedAt: new Date('2026-10-21T01:00:00Z'),
        tags: [allAges, archived, noWatermark, '自然风景', '日落']
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

      expect(screen.queryByText(`#${allAges}`)).toBeNull()
      expect(screen.queryByText(`#${archived}`)).toBeNull()
      expect(screen.queryByText(`#${noWatermark}`)).toBeNull()
      expect(screen.getByText('#自然风景')).toBeDefined()
      expect(screen.getByText('#日落')).toBeDefined()
    })

    it('permits pervasive tag when explicitly searched by user', () => {
      const allAges = getCanonicalConceptName(concept('全年龄'))!
      const archived = getCanonicalConceptName(concept('已归档'))!

      const itemWithArchived: FileType = {
        id: 'filter-2',
        name: 'report.pdf',
        path: 'D:\\workspace\\report.pdf',
        parentPath: 'D:\\workspace',
        size: 1024,
        extension: 'pdf',
        modifiedAt: new Date('2026-10-21T01:00:00Z'),
        tags: [allAges, archived, '财务报表']
      }

      render(
        <SearchListCard
          item={itemWithArchived}
          safeItemName="report.pdf"
          formatFileSize={defaultFormatSize}
          onItemClick={mockItemClick}
          onContextMenu={mockContextMenu}
          index={0}
          searchKeyword={archived}
        />
      )

      expect(screen.queryByText(`#${allAges}`)).toBeNull()
      expect(screen.getByText(`#${archived}`)).toBeDefined()
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

  describe('PreviewToolbar and togglePreviewMode seek retention', () => {
    it('preserves seek timestamp and range when toggling between split and fullscreen modes', () => {
      const pageId = 'test-video-page'
      const store = usePreviewOverlayStore.getState()
      store.openPreview('D:\test.mp4', 'test.mp4', 'mp4', pageId, {
        currentTime: 25,
        highlightRange: [25, 60]
      })

      // 切换全屏
      usePreviewOverlayStore.getState().togglePreviewMode(pageId)
      const fullscreenState = usePreviewOverlayStore.getState()
      expect(fullscreenState.isOpen).toBe(true)
      expect(fullscreenState.previewMode).toBe('fullscreen')
      expect(fullscreenState.currentTime).toBe(25)
      expect(fullscreenState.highlightRange).toEqual([25, 60])

      // 切换回分栏
      usePreviewOverlayStore.getState().togglePreviewMode(pageId)
      const splitState = usePreviewOverlayStore.getState()
      expect(splitState.isOpen).toBe(false)
      expect(splitState.previewMode).toBe('split')
      expect(splitState.currentTime).toBe(25)
      expect(splitState.highlightRange).toEqual([25, 60])
    })

    it('launches external deep link with seekSeconds when clicking default app in PreviewToolbar', async () => {
      const pageId = 'test-toolbar-page'
      const testVideoPath = 'D:/videos/demo.mp4'
      usePreviewOverlayStore.getState().openPreview(testVideoPath, 'demo.mp4', 'mp4', pageId, {
        currentTime: 42,
        highlightRange: [42, 80]
      })

      const { PreviewToolbar } = await import('../../../PreviewToolbar')
      render(
        <PreviewToolbar
          pageId={pageId}
          filePath={testVideoPath}
          fileName="demo.mp4"
          showSwitch={false}
          showRawText={false}
          onToggleRawText={() => {}}
        />
      )

      const defaultAppBtn = screen.getByText('默认程序打开').closest('button')
      expect(defaultAppBtn).not.toBeNull()
      fireEvent.click(defaultAppBtn!)

      // VERIFY_DEEP_LINK
      expect(window.electronAPI!.utils.launchExternalDeepLink).toHaveBeenCalledWith({
        filePath: testVideoPath,
        category: 'video',
        seekSeconds: 42
      })
    })

    it('seamlessly hands over live playback time when toggling fullscreen during playback', () => {
      const pageId = 'test-live-video-page'
      const store = usePreviewOverlayStore.getState()
      store.openPreview('D:/videos/live.mp4', 'live.mp4', 'mp4', pageId, {
        currentTime: 10,
        highlightRange: [10, 30]
      })

      // 模拟视频已播放到 28.5 秒
      setCurrentVideoPlaybackTime(28.5)

      // 切换全屏模式
      usePreviewOverlayStore.getState().togglePreviewMode(pageId)
      const fullscreenState = usePreviewOverlayStore.getState()
      expect(fullscreenState.isOpen).toBe(true)
      expect(fullscreenState.currentTime).toBe(28.5)

      // 模拟全屏中继续播放到 45 秒并退回分栏
      setCurrentVideoPlaybackTime(45)
      usePreviewOverlayStore.getState().togglePreviewMode(pageId)
      const splitState = usePreviewOverlayStore.getState()
      expect(splitState.isOpen).toBe(false)
      expect(splitState.currentTime).toBe(45)
    })

    it('injects W3C Media Fragments #t= URI for native video in FilePreview', async () => {
      const { FilePreview } = await import('../../../FilePreview')
      const { container } = render(
        <FilePreview
          filePath="D:/videos/media-fragment.mp4"
          fileName="media-fragment.mp4"
          extension="mp4"
          currentTime={33.7}
        />
      )

      const videoEl = container.querySelector('video')
      expect(videoEl).not.toBeNull()
      expect(videoEl?.getAttribute("src")).toContain("#t=33.7")
    })
  })
})
