// @vitest-environment jsdom

import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@app/languages', () => ({
  t: (str: string, params?: any) => str
}))

vi.mock('../../../common/Toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn()
  }
}))

vi.mock('@firefly/shared', async importOriginal => {
  const actual = await importOriginal<typeof import('@firefly/shared')>()
  return {
    ...actual,
    logger: {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    }
  }
})

import { useFileDetails } from '../useFileDetails'

describe('useFileDetails 热刷新与重分析状态响应测试', () => {
  let mockFileAnalysisResult: any
  let analysisQueueCallbacks: Array<(snapshot: any) => void> = []
  let fileAnalysisUpdatedCallbacks: Array<(payload: any) => void> = []

  beforeEach(() => {
    mockFileAnalysisResult = {
      path: 'C:\\test\\portrait.jpg',
      smartName: '卡通男性肖像',
      fingerprint: 'fp_12345678',
      tags: []
    }

    analysisQueueCallbacks = []
    fileAnalysisUpdatedCallbacks = []

    ;(window as any).electronAPI = {
      getFileAnalysisResult: vi.fn(async () => mockFileAnalysisResult),
      getDirectoryAnalysisResult: vi.fn(async () => null),
      getAnalysisQueue: vi.fn(async () => ({ items: [] })),
      addToAnalysisQueue: vi.fn(async () => {}),
      startAnalysis: vi.fn(async () => {}),
      onAnalysisQueueUpdated: vi.fn((cb: any) => {
        analysisQueueCallbacks.push(cb)
        return () => {
          analysisQueueCallbacks = analysisQueueCallbacks.filter(c => c !== cb)
        }
      }),
      onFileAnalysisUpdated: vi.fn((cb: any) => {
        fileAnalysisUpdatedCallbacks.push(cb)
        return () => {
          fileAnalysisUpdatedCallbacks = fileAnalysisUpdatedCallbacks.filter(c => c !== cb)
        }
      }),
      utils: {
        isPathEqual: (a: string, b: string) => (a || '').toLowerCase() === (b || '').toLowerCase()
      }
    }
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('1. 异步返送打标落库广播 (file-analysis-updated: retag) 应当自动触发属性面板热刷新', async () => {
    const onFileUpdated = vi.fn()
    const item = {
      path: 'C:\\test\\portrait.jpg',
      name: 'portrait.jpg',
      size: 1024,
      extension: 'jpg',
      isDirectory: false
    } as any

    const { result } = renderHook(() => useFileDetails(item, undefined, onFileUpdated))

    // 初始加载
    await act(async () => {
      await Promise.resolve()
    })
    expect(window.electronAPI.getFileAnalysisResult).toHaveBeenCalledTimes(1)

    // 模拟后台异步返送打标完成并广播
    mockFileAnalysisResult = {
      ...mockFileAnalysisResult,
      tags: [{ id: 'omw.portrait', name: '肖像' }]
    }

    await act(async () => {
      for (const cb of fileAnalysisUpdatedCallbacks) {
        cb({
          filePath: 'C:\\test\\portrait.jpg',
          fileFingerprint: 'fp_12345678',
          source: 'retag',
          status: 'completed'
        })
      }
      await Promise.resolve()
    })

    // 属性面板应当无需切换文件，立即重新获取分析结果并更新
    expect(window.electronAPI.getFileAnalysisResult).toHaveBeenCalledTimes(2)
    expect(onFileUpdated).toHaveBeenCalled()
    expect(result.current.analysisResult?.tags?.length).toBe(1)
  })

  it('2. 重新分析完成时，即使先前为 completed，时间戳更新也能驱动热刷新', async () => {
    const item = {
      path: 'C:\\test\\portrait.jpg',
      name: 'portrait.jpg',
      size: 1024,
      extension: 'jpg',
      isDirectory: false
    } as any

    const { result } = renderHook(() => useFileDetails(item))

    await act(async () => {
      await Promise.resolve()
    })
    expect(window.electronAPI.getFileAnalysisResult).toHaveBeenCalledTimes(1)

    // 第一次分析完成
    await act(async () => {
      for (const cb of analysisQueueCallbacks) {
        cb({
          items: [
            {
              path: 'C:\\test\\portrait.jpg',
              status: 'completed',
              updatedAt: 1000
            }
          ]
        })
      }
      await new Promise(r => setTimeout(r, 250))
    })
    expect(window.electronAPI.getFileAnalysisResult).toHaveBeenCalledTimes(2)

    // 再次触发重新分析并完成（状态同样是 completed，但时间戳更新为 2000）
    await act(async () => {
      for (const cb of analysisQueueCallbacks) {
        cb({
          items: [
            {
              path: 'C:\\test\\portrait.jpg',
              status: 'completed',
              updatedAt: 2000
            }
          ]
        })
      }
      await new Promise(r => setTimeout(r, 250))
    })

    // 修复后：即使连续两次为 completed，只要 updatedAt 更新，仍会可靠刷新
    expect(window.electronAPI.getFileAnalysisResult).toHaveBeenCalledTimes(3)
  })
})
