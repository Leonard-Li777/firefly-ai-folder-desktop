import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { render, screen, act, fireEvent } from '@testing-library/react'
import { GlobalSearchOverlay } from '../index'
import { useSearchStore } from '../../../../stores/search-store'
import type { FileItem, WorkspaceDirectory } from '@firefly/types'

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

vi.mock('@voerkai18n/react', () => ({
  useVoerkaI18n: () => ({ t: (k: string) => k })
}))

vi.mock('@/renderer/components/file-explorer/FileExplorerLayout', () => ({
  FileExplorerLayout: (props: any) => (
    <div data-testid="file-explorer-layout">
      <div data-testid="file-count">{props.files.length}</div>
      {props.files.map((f: any) => (
        <div key={f.path} data-path={f.path} data-testid="file-item">
          {f.name}
        </div>
      ))}
      {props.renderToolbar && props.renderToolbar({ viewMode: props.viewMode, setViewMode: props.onViewModeChange, gridCardWidth: 120, setGridCardWidth: vi.fn(), files: props.files })}
      {props.renderFooter && props.renderFooter({ files: props.files })}
    </div>
  )
}))

vi.mock('../FileExplorerLayout', () => ({
  FileExplorerLayout: (props: any) => (
    <div data-testid="file-explorer-layout">
      <div data-testid="file-count">{props.files.length}</div>
      {props.files.map((f: any) => (
        <div key={f.path} data-path={f.path} data-testid="file-item">
          {f.name}
        </div>
      ))}
      {props.renderToolbar && props.renderToolbar({ viewMode: props.viewMode, setViewMode: props.onViewModeChange, gridCardWidth: 120, setGridCardWidth: vi.fn(), files: props.files })}
      {props.renderFooter && props.renderFooter({ files: props.files })}
    </div>
  )
}))

vi.mock('@/renderer/stores/preview-overlay-store', () => {
  const state = {
    activePageId: 'main-page',
    filePath: '',
    fileName: '',
    extension: '',
    clearPreview: vi.fn(),
    getPagePreviewFile: vi.fn(),
    pageStates: {}
  }
  const store: any = vi.fn((selector?: any) => (selector ? selector(state) : state))
  store.getState = () => state
  store.setState = vi.fn()
  return { usePreviewOverlayStore: store }
})

vi.mock('@firefly/shared', async importOriginal => {
  const actual = await importOriginal<typeof import('@firefly/shared')>()
  return {
    ...actual,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    }
  }
})

// 补齐 JSDOM 缺失的 ResizeObserver
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as any

describe('GlobalSearchOverlay (Issue 03 / 双阶段流式上屏与呼吸微条)', () => {
  let progressCallback: ((payload: any) => void) | null = null
  const mockWorkspace: WorkspaceDirectory = {
    id: 'ws-1',
    name: 'Work',
    path: 'C:\\Work',
    type: 'workspace'
  }

  beforeEach(() => {
    vi.useFakeTimers()
    progressCallback = null
    useSearchStore.setState({ globalSearchKeyword: '' })

    ;(window as any).electronAPI = {
      searchWorkspaceFiles: vi.fn().mockImplementation(() => new Promise(() => {})),
      onSearchProgress: vi.fn().mockImplementation(cb => {
        progressCallback = cb
        return () => {
          progressCallback = null
        }
      }),
      onAnalysisQueueUpdated: vi.fn(() => () => {}),
      getConfigValue: vi.fn(() => undefined),
      utils: {
        openFileWithDefaultApp: vi.fn()
      }
    }
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('未输入搜索词时不渲染浮层', () => {
    const { container } = render(<GlobalSearchOverlay workspaceDirectory={mockWorkspace} />)
    expect(container.firstChild).toBeNull()
  })

  it('输入搜索词后渲染浮层，且流式接收 Phase 1 时立即上屏并展示语义对齐中呼吸条', async () => {
    render(<GlobalSearchOverlay workspaceDirectory={mockWorkspace} />)

    act(() => {
      useSearchStore.setState({ globalSearchKeyword: 'report' })
    })

    await act(async () => {
      vi.advanceTimersByTime(260)
    })

    expect(window.electronAPI!.searchWorkspaceFiles).toHaveBeenCalledWith(
      'report',
      'C:\\Work',
      expect.objectContaining({ stream: true, seq: 2 })
    )

    const calls = (window.electronAPI!.searchWorkspaceFiles as any).mock.calls
    const currentSeq = calls[calls.length - 1][2].seq

    // 模拟后端推送 Phase 1 字面先行结果 (Top 100)
    const phase1Items: FileItem[] = [
      { id: '1', path: 'C:\\Work\\report-2024.docx', name: 'report-2024.docx', size: 1024 } as any
    ]

    act(() => {
      progressCallback?.({
        phase: 'phase1',
        seq: currentSeq,
        items: phase1Items,
        total: 1,
        tokens: ['report']
      })
    })

    // 验证 Phase 1 立即上屏
    expect(screen.getByTestId('file-count')).toHaveTextContent('1')
    expect(screen.getByText('report-2024.docx')).toBeInTheDocument()
    // 验证呼吸徽章展示
    expect(screen.getByText('深度语义对齐中...')).toBeInTheDocument()
  })

  it('Phase 2 到达后置换全量结果并恢复空闲态 (呼吸徽章淡出)', async () => {
    render(<GlobalSearchOverlay workspaceDirectory={mockWorkspace} />)

    act(() => {
      useSearchStore.setState({ globalSearchKeyword: 'report' })
    })
    await act(async () => {
      vi.advanceTimersByTime(260)
    })

    const calls = (window.electronAPI!.searchWorkspaceFiles as any).mock.calls
    const currentSeq = calls[calls.length - 1][2].seq

    // Phase 1
    act(() => {
      progressCallback?.({
        phase: 'phase1',
        seq: currentSeq,
        items: [{ id: '1', path: 'C:\\Work\\report-2024.docx', name: 'report-2024.docx' } as any],
        total: 1
      })
    })
    expect(screen.getByText('深度语义对齐中...')).toBeInTheDocument()

    // Phase 2
    act(() => {
      progressCallback?.({
        phase: 'phase2',
        seq: currentSeq,
        items: [
          { id: '1', path: 'C:\\Work\\report-2024.docx', name: 'report-2024.docx' } as any,
          { id: '2', path: 'C:\\Work\\annual-summary.pdf', name: 'annual-summary.pdf', matchType: 'semantic' } as any
        ],
        total: 2
      })
    })

    expect(screen.getByTestId('file-count')).toHaveTextContent('2')
    expect(screen.getByText('annual-summary.pdf')).toBeInTheDocument()
    // 验证呼吸徽章已恢复空闲态
    expect(screen.queryByText('深度语义对齐中...')).toBeNull()
  })

  it('1500ms 安全熔断：若 Phase 2 超时未返回，呼吸条状态机自动平滑归位至 idle', async () => {
    render(<GlobalSearchOverlay workspaceDirectory={mockWorkspace} />)

    act(() => {
      useSearchStore.setState({ globalSearchKeyword: 'timeout-test' })
    })
    await act(async () => {
      vi.advanceTimersByTime(260)
    })

    const calls = (window.electronAPI!.searchWorkspaceFiles as any).mock.calls
    const currentSeq = calls[calls.length - 1][2].seq

    // Phase 1 触发
    act(() => {
      progressCallback?.({
        phase: 'phase1',
        seq: currentSeq,
        items: [{ id: '1', path: 'C:\\Work\\file.txt', name: 'file.txt' } as any],
        total: 1
      })
    })
    expect(screen.getByText('深度语义对齐中...')).toBeInTheDocument()

    // 快进 1500ms 触发安全超时熔断
    await act(async () => {
      vi.advanceTimersByTime(1550)
    })

    // 验证呼吸徽章已安全归位 idle，未无限期挂起
    expect(screen.queryByText('深度语义对齐中...')).toBeNull()
  })

  it('在 Toolbar 中正确展示搜索统计信息与视图设置组件', () => {
    render(<GlobalSearchOverlay workspaceDirectory={mockWorkspace} />)

    act(() => {
      useSearchStore.setState({ globalSearchKeyword: 'invoice' })
    })

    expect(screen.getByText('"invoice"')).toBeInTheDocument()
    expect(screen.getByText(/全域搜索:/)).toBeInTheDocument()
  })

  it('按 ESC 键或点击退出按钮立即关闭浮层并清理搜索', () => {
    render(<GlobalSearchOverlay workspaceDirectory={mockWorkspace} />)

    act(() => {
      useSearchStore.setState({ globalSearchKeyword: 'test' })
    })

    expect(screen.getByText('"test"')).toBeInTheDocument()

    // 模拟按下 Escape 键
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(useSearchStore.getState().globalSearchKeyword).toBe('')
  })
})
