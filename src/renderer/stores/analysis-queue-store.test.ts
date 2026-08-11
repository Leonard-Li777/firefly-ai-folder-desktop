import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useAnalysisQueueStore, useFileQueueState } from './analysis-queue-store'

vi.mock('@app/languages', () => ({
  t: (key: string) => key
}))

describe('AnalysisQueueStore & useFileQueueState Selector', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset store state
    useAnalysisQueueStore.setState({
      snapshot: {
        items: [],
        running: false
      }
    })

    // Mock electronAPI
    window.electronAPI = {
      utils: {
        isPathEqual: vi.fn((p1, p2) => p1 === p2)
      }
    } as any
  })

  it('should select correct status and error for a file in the queue', () => {
    useAnalysisQueueStore.setState({
      snapshot: {
        items: [
          {
            id: 1,
            path: '/path/to/file1.txt',
            name: 'file1.txt',
            size: 100,
            type: '.txt',
            itemType: 'file',
            status: 'analyzing',
            addedAt: Date.now(),
            updatedAt: Date.now()
          },
          {
            id: 2,
            path: '/path/to/file2.txt',
            name: 'file2.txt',
            size: 200,
            type: '.txt',
            itemType: 'file',
            status: 'failed',
            error: 'AI Error',
            addedAt: Date.now(),
            updatedAt: Date.now()
          }
        ],
        running: true
      }
    })

    const { result: res1 } = renderHook(() => useFileQueueState('/path/to/file1.txt'))
    expect(res1.current).toEqual({ status: 'analyzing', error: undefined })

    const { result: res2 } = renderHook(() => useFileQueueState('/path/to/file2.txt'))
    expect(res2.current).toEqual({ status: 'failed', error: 'AI Error' })
  })

  it('should fallback to isAnalyzedOnDisk if not in the queue', () => {
    const { result: res1 } = renderHook(() => useFileQueueState('/path/to/unknown.txt', true))
    expect(res1.current).toEqual({ status: 'completed', error: undefined })

    const { result: res2 } = renderHook(() => useFileQueueState('/path/to/unknown.txt', false))
    expect(res2.current).toEqual({ status: undefined, error: undefined })
  })

  it('should trigger confirm modal with Stage 4 files when adding multiple files', async () => {
    const checkStage4FilesMock = vi.fn().mockResolvedValue(['/path/to/file1.txt'])
    const addToAnalysisQueueMock = vi.fn().mockResolvedValue(undefined)

    window.electronAPI = {
      checkStage4Files: checkStage4FilesMock,
      addToAnalysisQueue: addToAnalysisQueueMock,
      getAnalysisQueue: vi.fn().mockResolvedValue({ items: [], running: false }),
      utils: {
        isPathEqual: (p1: string, p2: string) => p1 === p2
      }
    } as any

    const items = [
      { path: '/path/to/file1.txt', name: 'file1.txt', size: 100, type: '.txt' },
      { path: '/path/to/file2.txt', name: 'file2.txt', size: 200, type: '.txt' }
    ]

    await useAnalysisQueueStore.getState().addItems(items)

    expect(checkStage4FilesMock).toHaveBeenCalledWith(['/path/to/file1.txt', '/path/to/file2.txt'])
    expect(useAnalysisQueueStore.getState().showConfirmModal).toBe(true)
    expect(useAnalysisQueueStore.getState().confirmModalFiles).toEqual([
      { path: '/path/to/file1.txt', name: 'file1.txt', size: 100, type: '.txt' }
    ])
    expect(addToAnalysisQueueMock).not.toHaveBeenCalled()
  })

  it('should skip Stage 4 files and enqueue other files when handleConfirmSkip is called', async () => {
    const addToAnalysisQueueMock = vi.fn().mockResolvedValue(undefined)
    const startAnalysisMock = vi.fn().mockResolvedValue(undefined)

    window.electronAPI = {
      addToAnalysisQueue: addToAnalysisQueueMock,
      startAnalysis: startAnalysisMock,
      getAnalysisQueue: vi.fn().mockResolvedValue({ items: [], running: false }),
      utils: {
        isPathEqual: (p1: string, p2: string) => p1 === p2
      }
    } as any

    useAnalysisQueueStore.setState({
      showConfirmModal: true,
      confirmModalFiles: [
        { path: '/path/to/file1.txt', name: 'file1.txt', size: 100, type: '.txt' }
      ],
      pendingAddItems: [
        { path: '/path/to/file1.txt', name: 'file1.txt', size: 100, type: '.txt' },
        { path: '/path/to/file2.txt', name: 'file2.txt', size: 200, type: '.txt' }
      ]
    })

    await useAnalysisQueueStore.getState().handleConfirmSkip()

    expect(useAnalysisQueueStore.getState().showConfirmModal).toBe(false)
    expect(addToAnalysisQueueMock).toHaveBeenCalledWith([
      { path: '/path/to/file2.txt', name: 'file2.txt', size: 200, type: '.txt' }
    ], false)
  })

  it('should directly enqueue a single file without triggering popup', async () => {
    const checkStage4FilesMock = vi.fn()
    const addToAnalysisQueueMock = vi.fn().mockResolvedValue(undefined)

    window.electronAPI = {
      checkStage4Files: checkStage4FilesMock,
      addToAnalysisQueue: addToAnalysisQueueMock,
      getAnalysisQueue: vi.fn().mockResolvedValue({ items: [], running: false }),
      utils: {
        isPathEqual: (p1: string, p2: string) => p1 === p2
      }
    } as any

    const items = [
      { path: '/path/to/file1.txt', name: 'file1.txt', size: 100, type: '.txt' }
    ]

    await useAnalysisQueueStore.getState().addItems(items)

    expect(checkStage4FilesMock).not.toHaveBeenCalled()
    expect(useAnalysisQueueStore.getState().showConfirmModal).toBe(false)
    expect(addToAnalysisQueueMock).toHaveBeenCalledWith(items, undefined)
  })
})
