import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AnalysisWriteDispatcher } from './analysis-write-dispatcher'
import type { AnalysisQueueSnapshot } from '@firefly/types'

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => [])
  }
}))

vi.mock('@app/languages', () => ({
  t: (text: string) => text
}))

vi.mock('../database/database-service', () => ({
  databaseService: {
    updateAnalysisQueue: vi.fn()
  }
}))

vi.mock('@firefly/shared', async importOriginal => {
  const actual = await importOriginal<typeof import('@firefly/shared')>()
  return {
    ...actual,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn()
    }
  }
})

describe('AnalysisWriteDispatcher.updateItemStatus 超时通知结构化契约（工单 B8）', () => {
  let mockItem: any
  let mockQueueManager: any
  let notifyFrontend: ReturnType<typeof vi.fn>
  let dispatcher: AnalysisWriteDispatcher

  beforeEach(() => {
    vi.clearAllMocks()
    mockItem = {
      id: 42,
      name: 'demo.pdf',
      path: 'D:\\docs\\demo.pdf',
      status: 'analyzing',
      progress: 50,
      updatedAt: 0
    }
    mockQueueManager = {
      getQueue: () => [mockItem]
    }
    notifyFrontend = vi.fn()
    dispatcher = new AnalysisWriteDispatcher(
      () => mockQueueManager,
      () => ({ items: [mockItem] }) as unknown as AnalysisQueueSnapshot,
      notifyFrontend
    )
  })

  it('仅当 extra.isTimeout === true 且 status === failed 时触发超时警告通知', () => {
    dispatcher.updateItemStatus(42, 'failed', 100, 'request failed', { isTimeout: true })

    expect(notifyFrontend).toHaveBeenCalledTimes(1)
    expect(notifyFrontend).toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('demo.pdf'),
      false,
      'timeout-42',
      5000,
      expect.objectContaining({ category: 'AI_ENGINE_CONFIG' })
    )
  })

  it('错误文案包含中文「超时」或英文「timeout」但未传 extra.isTimeout 时，不得触发超时通知', () => {
    dispatcher.updateItemStatus(42, 'failed', 100, '模型响应超时 timeout')

    expect(notifyFrontend).not.toHaveBeenCalled()
  })
})
