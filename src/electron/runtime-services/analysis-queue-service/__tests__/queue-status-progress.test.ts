import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => {
  const mockApp = {
    getPath: vi.fn(() => '/tmp/mock-user-data'),
    getAppPath: vi.fn(() => process.cwd()),
    getVersion: vi.fn(() => '1.0.0'),
    isPackaged: false
  }
  const mockPowerMonitor = { on: vi.fn() }
  const mockIpc = { on: vi.fn(), handle: vi.fn() }
  return {
    default: { app: mockApp, ipcMain: mockIpc, powerMonitor: mockPowerMonitor },
    app: mockApp,
    ipcMain: mockIpc,
    powerMonitor: mockPowerMonitor
  }
})

vi.mock('electron-conf', () => ({
  Conf: class MockConf {
    private _store: Record<string, any> = {}
    get(key: string, def?: any) {
      return this._store[key] ?? def
    }
    set(key: string, val: any) {
      this._store[key] = val
    }
    onDidChange() {}
  }
}))

vi.mock('@app/languages', () => ({
  t: (s: string) => s
}))

import { AnalysisQueueService } from '../analysis-queue-service'

describe('AnalysisQueueService: getQueueStatus 与 getProgress', () => {
  let service: AnalysisQueueService

  beforeEach(() => {
    service = new AnalysisQueueService()
  })

  it('队列未初始化或为空时，返回空闲与 100% 进度', () => {
    const status = service.getQueueStatus()
    expect(status.systemIdle).toBe(true)
    expect(status.queueLength).toBe(0)
    expect(status.currentProcessingFile).toBeNull()
    expect(status.total).toBe(0)

    const prog = service.getProgress()
    expect(prog.isIdle).toBe(true)
    expect(prog.percentage).toBe(100)
    expect(prog.analysis.status).toBe('idle')
    expect(prog.analysis.progressPercentage).toBe(100)
    expect(prog.organizePage.status).toBe('idle')
  })

  it('队列有排队任务与正在分析项时，准确计算当前文件、长度与百分比', () => {
    // 模拟 mock getSnapshot
    vi.spyOn(service, 'getSnapshot').mockReturnValue({
      items: [
        {
          id: 1,
          path: 'D:/test/1.jpg',
          name: '1.jpg',
          size: 100,
          type: '.jpg',
          itemType: 'file',
          taskType: 'analysis',
          status: 'completed',
          addedAt: 1,
          updatedAt: 1
        },
        {
          id: 2,
          path: 'D:/test/2.jpg',
          name: '2.jpg',
          size: 100,
          type: '.jpg',
          itemType: 'file',
          taskType: 'analysis',
          status: 'analyzing',
          progress: 50,
          addedAt: 1,
          updatedAt: 1
        },
        {
          id: 3,
          path: 'D:/test/3.jpg',
          name: '3.jpg',
          size: 100,
          type: '.jpg',
          itemType: 'file',
          taskType: 'analysis',
          status: 'pending',
          addedAt: 1,
          updatedAt: 1
        },
        {
          id: 4,
          path: 'D:/test/4.jpg',
          name: '4.jpg',
          size: 100,
          type: '.jpg',
          itemType: 'file',
          taskType: 'analysis',
          status: 'pending',
          addedAt: 1,
          updatedAt: 1
        }
      ],
      running: true,
      currentAnalyzingItem: {
        id: 2,
        path: 'D:/test/2.jpg',
        name: '2.jpg',
        size: 100,
        type: '.jpg',
        itemType: 'file',
        taskType: 'analysis',
        status: 'analyzing',
        progress: 50,
        addedAt: 1,
        updatedAt: 1
      },
      status: 'running'
    })

    const status = service.getQueueStatus()
    expect(status.systemIdle).toBe(false)
    expect(status.queueLength).toBe(3) // 2 pending + 1 analyzing
    expect(status.currentProcessingFile).toBe('D:/test/2.jpg')
    expect(status.total).toBe(4)
    expect(status.completed).toBe(1)
    expect(status.processing).toBe(1)
    expect(status.pending).toBe(2)

    const prog = service.getProgress()
    expect(prog.isIdle).toBe(false)
    // 1 completed + 0.5 analyzing = 1.5 / 4 = 37.5%
    expect(prog.percentage).toBe(37.5)
    expect(prog.analysis.status).toBe('processing')
    expect(prog.analysis.progressPercentage).toBe(37.5)
  })

  it('队列已暂停但有未完成任务时，状态标记为 paused', () => {
    vi.spyOn(service, 'getSnapshot').mockReturnValue({
      items: [
        {
          id: 1,
          path: 'D:/test/1.jpg',
          name: '1.jpg',
          size: 100,
          type: '.jpg',
          itemType: 'file',
          taskType: 'analysis',
          status: 'pending',
          addedAt: 1,
          updatedAt: 1
        }
      ],
      running: false,
      status: 'paused'
    })

    const prog = service.getProgress()
    expect(prog.isIdle).toBe(false)
    expect(prog.analysis.status).toBe('paused')
    expect(prog.analysis.progressPercentage).toBe(0)
  })
})
