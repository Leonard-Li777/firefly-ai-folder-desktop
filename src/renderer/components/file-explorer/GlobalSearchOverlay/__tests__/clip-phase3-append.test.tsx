/**
 * 工单 13：GlobalSearchOverlay phase3（冷态 CLIP 追加）行为测试。
 *
 * 覆盖 AC11 中属于渲染层的部分：
 *  - 只追加、按 path 去重、已有项位置/顺序不变（列表快照）；
 *  - 过期 seq 直接丢弃；重复 phase3 同 seq 只处理一次；
 *  - 1500ms 熔断只作用 phase2，不得吞掉 phase3；
 *  - 热态（phase2 不带 clipPending）不展示加载提示、不产生二次刷新。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { render, screen, act } from '@testing-library/react'
import { GlobalSearchOverlay } from '../index'
import { useSearchStore } from '../../../../stores/search-store'
import type { WorkspaceDirectory } from '@firefly/types'

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
      {props.renderToolbar &&
        props.renderToolbar({
          viewMode: props.viewMode,
          setViewMode: props.onViewModeChange,
          gridCardWidth: 120,
          setGridCardWidth: vi.fn(),
          files: props.files
        })}
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
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  }
})

global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as any

const mockWorkspace: WorkspaceDirectory = {
  id: 'ws-1',
  name: 'Work',
  path: 'C:\\Work',
  type: 'workspace'
}

function item(path: string, name: string) {
  return { id: path, path, name } as any
}

/** 已渲染列表的 path 顺序快照 —— 用来证明「只追加、不重排」 */
function renderedPaths(): string[] {
  return screen
    .queryAllByTestId('file-item')
    .map(el => el.getAttribute('data-path') || '')
}

describe('GlobalSearchOverlay phase3（冷态 CLIP 追加）', () => {
  let progressCallback: ((payload: any) => void) | null = null
  let currentSeq = 0

  beforeEach(async () => {
    vi.useFakeTimers()
    progressCallback = null
    useSearchStore.setState({ globalSearchKeyword: '' })
    ;(window as any).electronAPI = {
      // 让 Promise 永不 resolve：只走流式推送，避免 Promise 路径抢先写入 handledPhase2SeqRef
      searchWorkspaceFiles: vi.fn(() => new Promise(() => {})),
      onSearchProgress: vi.fn().mockImplementation((cb: any) => {
        progressCallback = cb
        return () => {
          progressCallback = null
        }
      }),
      onAnalysisQueueUpdated: vi.fn(() => () => {}),
      getConfigValue: vi.fn(() => undefined),
      utils: { openFileWithDefaultApp: vi.fn() }
    }
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  async function mountAndStartSearch(keyword = '红色的跑车') {
    render(<GlobalSearchOverlay workspaceDirectory={mockWorkspace} />)
    act(() => {
      useSearchStore.setState({ globalSearchKeyword: keyword })
    })
    await act(async () => {
      vi.advanceTimersByTime(260)
    })
    const calls = (window.electronAPI!.searchWorkspaceFiles as any).mock.calls
    currentSeq = calls[calls.length - 1][2].seq
  }

  it('phase2 带 clipPending 时展示加载提示，phase3 到达后隐藏并追加新项', async () => {
    await mountAndStartSearch()

    act(() => {
      progressCallback?.({
        phase: 'phase2',
        seq: currentSeq,
        items: [item('C:\\Work\\a.jpg', 'a.jpg')],
        total: 1,
        clipPending: true
      })
    })
    expect(screen.getByTestId('clip-cold-hint')).toBeInTheDocument()

    act(() => {
      progressCallback?.({
        phase: 'phase3',
        seq: currentSeq,
        items: [item('C:\\Work\\b.jpg', 'b.jpg')],
        total: 2
      })
    })

    // 提示收起 + 新项追加到尾部
    expect(screen.queryByTestId('clip-cold-hint')).toBeNull()
    expect(renderedPaths()).toEqual(['C:\\Work\\a.jpg', 'C:\\Work\\b.jpg'])
  })

  it('热态（phase2 不带 clipPending）不展示提示，也不发生二次刷新', async () => {
    await mountAndStartSearch()

    act(() => {
      progressCallback?.({
        phase: 'phase2',
        seq: currentSeq,
        items: [item('C:\\Work\\a.jpg', 'a.jpg')],
        total: 1
      })
    })

    expect(screen.queryByTestId('clip-cold-hint')).toBeNull()
    const before = renderedPaths()
    await act(async () => {
      vi.advanceTimersByTime(8000)
    })
    // 热态结果已在 phase2 内，后续不得再有任何置换
    expect(renderedPaths()).toEqual(before)
  })

  it('phase3 只追加：已存在 path 去重，已有项顺序与下标绝对不变', async () => {
    await mountAndStartSearch()

    act(() => {
      progressCallback?.({
        phase: 'phase2',
        seq: currentSeq,
        items: [
          item('C:\\Work\\a.jpg', 'a.jpg'),
          item('C:\\Work\\b.jpg', 'b.jpg'),
          item('C:\\Work\\c.jpg', 'c.jpg')
        ],
        total: 3,
        clipPending: true
      })
    })
    const snapshot = renderedPaths()

    act(() => {
      progressCallback?.({
        phase: 'phase3',
        seq: currentSeq,
        // b 已存在（典型：冷态 CLIP 命中的正是用户已看到的高相关项）
        items: [item('C:\\Work\\b.jpg', 'b.jpg'), item('C:\\Work\\d.jpg', 'd.jpg')],
        total: 4
      })
    })

    const after = renderedPaths()
    // 前缀完全一致 = 位置快照成立（不重排、不清空）
    expect(after.slice(0, snapshot.length)).toEqual(snapshot)
    // 只多出真正的新项
    expect(after).toEqual([...snapshot, 'C:\\Work\\d.jpg'])
  })

  it('过期 seq 的 phase3 直接丢弃', async () => {
    await mountAndStartSearch()

    act(() => {
      progressCallback?.({
        phase: 'phase2',
        seq: currentSeq,
        items: [item('C:\\Work\\a.jpg', 'a.jpg')],
        total: 1,
        clipPending: true
      })
    })

    act(() => {
      progressCallback?.({
        phase: 'phase3',
        seq: currentSeq - 1, // 上一轮请求的迟到结果
        items: [item('C:\\Work\\stale.jpg', 'stale.jpg')],
        total: 2
      })
    })

    expect(renderedPaths()).toEqual(['C:\\Work\\a.jpg'])
  })

  it('1500ms 熔断只作用 phase2：phase3 迟到仍能追加', async () => {
    await mountAndStartSearch()

    act(() => {
      progressCallback?.({
        phase: 'phase1',
        seq: currentSeq,
        items: [item('C:\\Work\\a.jpg', 'a.jpg')],
        total: 1
      })
    })
    expect(screen.getByText('深度语义对齐中...')).toBeInTheDocument()

    // 熔断触发（呼吸条归位 idle）
    await act(async () => {
      vi.advanceTimersByTime(1600)
    })
    expect(screen.queryByText('深度语义对齐中...')).toBeNull()

    // phase2 与 phase3 随后到达
    act(() => {
      progressCallback?.({
        phase: 'phase2',
        seq: currentSeq,
        items: [item('C:\\Work\\a.jpg', 'a.jpg')],
        total: 1,
        clipPending: true
      })
      progressCallback?.({
        phase: 'phase3',
        seq: currentSeq,
        items: [item('C:\\Work\\late.jpg', 'late.jpg')],
        total: 2
      })
    })

    expect(renderedPaths()).toEqual(['C:\\Work\\a.jpg', 'C:\\Work\\late.jpg'])
  })

  it('同一 seq 的 phase3 重复到达只追加一次', async () => {
    await mountAndStartSearch()

    act(() => {
      progressCallback?.({
        phase: 'phase2',
        seq: currentSeq,
        items: [item('C:\\Work\\a.jpg', 'a.jpg')],
        total: 1,
        clipPending: true
      })
    })

    const phase3 = {
      phase: 'phase3' as const,
      seq: currentSeq,
      items: [item('C:\\Work\\d.jpg', 'd.jpg')],
      total: 2
    }
    act(() => {
      progressCallback?.(phase3)
    })
    act(() => {
      progressCallback?.(phase3)
    })

    expect(renderedPaths()).toEqual(['C:\\Work\\a.jpg', 'C:\\Work\\d.jpg'])
  })

  it('清空搜索词后冷态提示一并收掉，不残留', async () => {
    await mountAndStartSearch()

    act(() => {
      progressCallback?.({
        phase: 'phase2',
        seq: currentSeq,
        items: [item('C:\\Work\\a.jpg', 'a.jpg')],
        total: 1,
        clipPending: true
      })
    })
    expect(screen.getByTestId('clip-cold-hint')).toBeInTheDocument()

    act(() => {
      useSearchStore.setState({ globalSearchKeyword: '' })
    })
    // 清空后浮层整体卸载，提示自然不存在
    expect(screen.queryByTestId('clip-cold-hint')).toBeNull()
  })
})
