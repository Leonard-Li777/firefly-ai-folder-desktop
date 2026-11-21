/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { renderHook, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { useOrganizeState } from '../hooks/useOrganizeState'
import { useOrganizeStore } from '../../../../stores/organize-store'
import { useAnalyzedDirectoryStore } from '../../../../stores/analyzed-directory-store'
import { useSettingsStore } from '../../../../stores/settings-store'
import { SENTINEL_NAMES } from '@firefly/shared'
import { VirtualDirectoryNode } from '@firefly/types'

const { mockT, mockIpcRenderer } = vi.hoisted(() => {
  const tFn = (key: string, params?: any) => {
    if (params && typeof params === 'object') {
      let res = key
      for (const k in params) {
        res = res.replace(new RegExp('\\{' + k + '\\}', 'g'), params[k])
      }
      return res
    }
    return key
  }
  const listeners = new Map<string, Set<(...args: any[]) => void>>()
  const ipc = {
    invoke: vi.fn(),
    on: (channel: string, listener: (...args: any[]) => void) => {
      if (!listeners.has(channel)) listeners.set(channel, new Set())
      listeners.get(channel)!.add(listener)
      return ipc
    },
    removeListener: (channel: string, listener: (...args: any[]) => void) => {
      listeners.get(channel)?.delete(listener)
      return ipc
    },
    emit: (channel: string, ...args: any[]) => {
      for (const fn of [...(listeners.get(channel) || [])]) {
        fn(...args)
      }
    },
    removeAllListeners: () => listeners.clear(),
    listenerCount: (channel: string) => listeners.get(channel)?.size || 0
  }
  return { mockT: tFn, mockIpcRenderer: ipc }
})

vi.mock('electron', () => ({
  ipcRenderer: mockIpcRenderer
}))

import { organizeApi } from '../../../../../electron/preload/organize'

const mockNavigate = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return {
    ...actual,
    useNavigate: () => mockNavigate
  }
})

vi.mock('@app/languages', () => ({
  t: mockT,
  $t: (key: string) => key,
  Translate: ({ children }: any) => children,
  i18nScope: { t: mockT, activeLanguage: 'zh-CN', defaultLanguage: 'zh-CN' },
  default: { t: mockT, activeLanguage: 'zh-CN', defaultLanguage: 'zh-CN' }
}))

vi.mock('@voerkai18n/react', () => ({
  useVoerkaI18n: () => ({ activeLanguage: 'zh-CN', t: mockT })
}))

vi.mock('../../../common/Toast', () => ({
  toast: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn()
  }
}))

describe('useOrganizeRescue 深度找补：保留既有文件与每批次动态增量渲染', () => {
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(MemoryRouter, { initialEntries: ['/organize'] }, children)

  let mockReorganize: any
  let resolveReorganize: ((value: any) => void) | null

  const existingFile = {
    id: 1,
    fileId: 1,
    name: '已归类文档.pdf',
    smartName: '已归类文档.pdf',
    path: '/workspace/已归类文档.pdf',
    originalPath: '/workspace/已归类文档.pdf',
    relativePath: '技术资料/已归类文档.pdf'
  }

  const rescueFile1 = {
    id: 2,
    fileId: 2,
    name: '待找补1.pdf',
    smartName: '待找补1.pdf',
    path: '/workspace/待找补1.pdf',
    originalPath: '/workspace/待找补1.pdf',
    relativePath: '待找补1.pdf'
  }

  const rescueFile2 = {
    id: 3,
    fileId: 3,
    name: '待找补2.pdf',
    smartName: '待找补2.pdf',
    path: '/workspace/待找补2.pdf',
    originalPath: '/workspace/待找补2.pdf',
    relativePath: '待找补2.pdf'
  }

  const outlineTree: VirtualDirectoryNode[] = [
    {
      name: '技术资料',
      files: [],
      subdirectories: [],
      fileCount: 0
    }
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    mockIpcRenderer.removeAllListeners()
    resolveReorganize = null

    useOrganizeStore.setState({
      stage: 'structure',
      organizeMode: 'identity-blueprint',
      draft: { name: '测试方案', strategy: '按主题分类', source: 'identity-blueprint' },
      finalTree: [],
      draftTree: JSON.parse(JSON.stringify(outlineTree)),
      hasRescueFailed: false,
      unmatchedCount: 0,
      thresholdScore: 0.4,
      maxCandidatesPerFile: 1,
      userPinnedFileMap: new Map(),
      options: {
        flattenToRoot: false,
        skipEmptyDirs: false,
        allowCreateNew: false
      } as any
    })
    useSettingsStore.setState({
      config: {
        QUEUE_BATCH_SIZE: 1
      } as any
    })
    useAnalyzedDirectoryStore.getState().setCurrentWorkspaceDirectory({
      id: 1,
      path: '/workspace',
      name: 'workspace'
    } as any)

    mockReorganize = vi.fn().mockImplementation(
      () =>
        new Promise(resolve => {
          resolveReorganize = resolve
        })
    )
    ;(window as any).electronAPI = {
      getCurrentWorkspaceDirectory: vi.fn().mockResolvedValue({ id: 1, path: '/workspace' }),
      organizeRealDirectory: {
        getAnalyzedFiles: vi.fn().mockResolvedValue([existingFile, rescueFile1, rescueFile2]),
        getLightweightFiles: vi.fn().mockResolvedValue([existingFile, rescueFile1, rescueFile2]),
        getAnalyzedCount: vi.fn().mockResolvedValue(3),
        calculateFilePathsCosine: vi.fn().mockResolvedValue({
          success: true,
          matches: {
            1: [{ path: '技术资料', score: 0.9 }],
            2: [{ path: '技术资料', score: 0.1 }],
            3: [{ path: '技术资料', score: 0.1 }]
          }
        })
      },
      virtualDirectory: {
        getAnalyzedCount: vi.fn().mockResolvedValue(3),
        generateNameAndStrategyCandidates: vi.fn().mockResolvedValue({ candidates: [] }),
        getDirectoryTree: vi.fn().mockResolvedValue({ tree: null }),
        getWorkspaceDirectoryById: vi.fn().mockResolvedValue({ id: 1, path: '/workspace' }),
        createFromStrategy: vi.fn().mockResolvedValue({ id: 99, name: '测试方案' }),
        updateMeta: vi.fn().mockResolvedValue({ success: true }),
        reorganize: mockReorganize,
        syncIncrementalDirectoryTree: vi.fn().mockResolvedValue({ success: true }),
        replaceFiles: vi.fn().mockResolvedValue({ success: true }),
        list: vi.fn().mockResolvedValue([]),
        // 使用真实的 preload onReorganizeProgress 实现！
        onReorganizeProgress: organizeApi.virtualDirectory.onReorganizeProgress
      },
      analyzedDirectory: {
        getDimensionGroups: vi.fn().mockResolvedValue({ groups: [] }),
        getDirectoryTree: vi.fn().mockResolvedValue({ tree: null }),
        getHighFrequencyTags: vi.fn().mockResolvedValue({ tags: [] })
      },
      organizeBatch: {
        applyTags: vi.fn(),
        inspectControlledTags: vi.fn().mockResolvedValue({ success: true, results: [] }),
        deleteTagGlobally: vi.fn().mockResolvedValue(true)
      }
    }
  })

  it('先完成一轮常规整理，再点击深度找补：不得清空已有文件，且每批次找补后应动态增加文件到目录树中', async () => {
    const { result } = renderHook(() => useOrganizeState(), { wrapper })

    // 等待初始文件加载
    await act(async () => {
      await result.current.loadFilesToOrganize()
    })

    // 1. 先执行一轮常规整理（cosine matching -> 进入 done 阶段）
    await act(async () => {
      await result.current.executeStartOrganize()
    })

    const getTechFiles = () =>
      (result.current.displayTree.find(n => n.name === '技术资料')?.files || []).map(f => f.name)
    const getUnclassifiedFiles = () =>
      (
        result.current.displayTree.find(n => n.name === SENTINEL_NAMES.UNCLASSIFIED)?.files || []
      ).map(f => f.name)

    expect(result.current.stage).toBe('done')
    expect(getTechFiles()).toEqual(['已归类文档.pdf'])
    expect(getUnclassifiedFiles()).toEqual(['待找补1.pdf', '待找补2.pdf'])

    // 2. 点击「生成式 AI 深度找补」
    let rescuePromise: Promise<void>
    act(() => {
      rescuePromise = result.current.handleRescue(true)
    })

    // 模拟后端第 1 批次完成，假设第 1 批次未成功归类任何文件（仅返回空目录骨架 + 未归类）
    act(() => {
      mockIpcRenderer.emit(
        'virtual-directory/reorganize-progress',
        {},
        {
          stage: 'ai-calling',
          currentStep: 1,
          totalSteps: 3,
          message: '正在处理批次 1/3...',
          currentTreePreview: [
            {
              name: '技术资料',
              files: [],
              subdirectories: [],
              fileCount: 0
            },
            {
              name: SENTINEL_NAMES.UNCLASSIFIED,
              files: [{ ...rescueFile1 }, { ...rescueFile2 }],
              subdirectories: [],
              fileCount: 2
            }
          ]
        }
      )
    })

    // 症状 1：已有归类文件「已归类文档.pdf」绝对不能被清空！
    expect(getTechFiles()).toEqual(['已归类文档.pdf'])

    // 模拟后端第 2 批次完成，找补成功了「待找补1.pdf」
    act(() => {
      mockIpcRenderer.emit(
        'virtual-directory/reorganize-progress',
        {},
        {
          stage: 'ai-calling',
          currentStep: 2,
          totalSteps: 3,
          message: '正在处理批次 2/3...',
          currentTreePreview: [
            {
              name: '技术资料',
              files: [{ ...rescueFile1 }],
              subdirectories: [],
              fileCount: 1
            },
            {
              name: SENTINEL_NAMES.UNCLASSIFIED,
              files: [{ ...rescueFile2 }],
              subdirectories: [],
              fileCount: 1
            }
          ]
        }
      )
    })

    // 症状 1 + 2：原有「已归类文档.pdf」保留，且「待找补1.pdf」必须动态增加到「技术资料」中！
    expect(getTechFiles()).toEqual(['已归类文档.pdf', '待找补1.pdf'])
    expect(getUnclassifiedFiles()).toEqual(['待找补2.pdf'])

    // 模拟找补全部结束
    await act(async () => {
      resolveReorganize!({
        success: true,
        tree: [
          {
            name: '技术资料',
            files: [{ ...rescueFile1 }, { ...rescueFile2 }],
            subdirectories: [],
            fileCount: 2
          }
        ]
      })
      await rescuePromise!
    })

    expect(getTechFiles()).toEqual(['已归类文档.pdf', '待找补1.pdf', '待找补2.pdf'])
    expect(getUnclassifiedFiles()).toEqual([])
    expect(mockIpcRenderer.listenerCount('virtual-directory/reorganize-progress')).toBe(0)
  })

  it('preload onReorganizeProgress 取消订阅必须精准移除 virtual-directory/reorganize-progress 监听器，杜绝僵尸监听器泄漏', () => {
    const cb = vi.fn()
    const unsub = organizeApi.virtualDirectory.onReorganizeProgress(cb)
    expect(mockIpcRenderer.listenerCount('virtual-directory/reorganize-progress')).toBe(1)

    mockIpcRenderer.emit('virtual-directory/reorganize-progress', {}, { currentStep: 1 })
    expect(cb).toHaveBeenCalledTimes(1)

    unsub()
    expect(mockIpcRenderer.listenerCount('virtual-directory/reorganize-progress')).toBe(0)

    mockIpcRenderer.emit('virtual-directory/reorganize-progress', {}, { currentStep: 2 })
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('深度找补开启 allowCreateNew 且批次进度返回新目录时，应保留既有归类文件并动态渲染新目录与新归类文件', async () => {
    useOrganizeStore.setState({
      stage: 'done',
      finalTree: [
        {
          name: '技术资料',
          files: [{ ...existingFile }],
          subdirectories: [],
          fileCount: 1
        },
        {
          name: SENTINEL_NAMES.UNCLASSIFIED,
          files: [{ ...rescueFile1 }, { ...rescueFile2 }],
          subdirectories: [],
          fileCount: 2
        }
      ],
      draftTree: [
        {
          name: '技术资料',
          files: [{ ...existingFile }],
          subdirectories: [],
          fileCount: 1
        }
      ],
      options: {
        flattenToRoot: false,
        skipEmptyDirs: false,
        allowCreateNew: true
      } as any
    })

    const { result } = renderHook(() => useOrganizeState(), { wrapper })

    let rescuePromise: Promise<void>
    act(() => {
      rescuePromise = result.current.handleRescue(true)
    })

    // 第 1 批次 AI 新建了「财务合同」目录并归入了「待找补1.pdf」
    act(() => {
      mockIpcRenderer.emit(
        'virtual-directory/reorganize-progress',
        {},
        {
          stage: 'ai-calling',
          currentStep: 1,
          totalSteps: 2,
          isRescue: true,
          message: '正在处理批次 1/2...',
          currentTreePreview: [
            {
              name: '财务合同',
              files: [{ ...rescueFile1 }],
              subdirectories: [],
              fileCount: 1
            },
            {
              name: SENTINEL_NAMES.UNCLASSIFIED,
              files: [{ ...rescueFile2 }],
              subdirectories: [],
              fileCount: 1
            }
          ]
        }
      )
    })

    const techFiles = (
      result.current.displayTree.find(n => n.name === '技术资料')?.files || []
    ).map(f => f.name)
    const financeFiles = (
      result.current.displayTree.find(n => n.name === '财务合同')?.files || []
    ).map(f => f.name)
    const unclassifiedFiles = (
      result.current.displayTree.find(n => n.name === SENTINEL_NAMES.UNCLASSIFIED)?.files || []
    ).map(f => f.name)

    expect(techFiles).toEqual(['已归类文档.pdf'])
    expect(financeFiles).toEqual(['待找补1.pdf'])
    expect(unclassifiedFiles).toEqual(['待找补2.pdf'])
    expect(useOrganizeStore.getState().unmatchedCount).toBe(1)

    await act(async () => {
      resolveReorganize!({
        success: true,
        tree: [
          {
            name: '财务合同',
            files: [{ ...rescueFile1 }, { ...rescueFile2 }],
            subdirectories: [],
            fileCount: 2
          }
        ]
      })
      await rescuePromise!
    })

    expect(mockIpcRenderer.listenerCount('virtual-directory/reorganize-progress')).toBe(0)
  })

  it('点击「自动找补」时严禁并发重入：在当前找补未结束（及批次进度刷新 finalTree）期间，reorganize 只允许调用 1 次', async () => {
    useOrganizeStore.setState({
      stage: 'done',
      finalTree: [
        {
          name: '技术资料',
          files: [{ ...existingFile }],
          subdirectories: [],
          fileCount: 1
        },
        {
          name: SENTINEL_NAMES.UNCLASSIFIED,
          files: [{ ...rescueFile1 }, { ...rescueFile2 }],
          subdirectories: [],
          fileCount: 2
        }
      ],
      draftTree: [
        {
          name: '技术资料',
          files: [{ ...existingFile }],
          subdirectories: [],
          fileCount: 1
        }
      ],
      hasRescueFailed: false
    })

    const { result } = renderHook(() => useOrganizeState(), { wrapper })

    // 点击「自动找补」
    let autoRescuePromise: Promise<void>
    act(() => {
      autoRescuePromise = result.current.handleAutoRescue()
    })

    // 关键断言 1：点击自动找补后，不得因为 useEffect 立即并发触发第 2 次 reorganize
    expect(mockReorganize).toHaveBeenCalledTimes(1)

    // 模拟第 1 批次进度回调更新 finalTree（此时仍在找补中）
    act(() => {
      mockIpcRenderer.emit('virtual-directory/reorganize-progress', {}, {
        stage: 'ai-calling',
        currentStep: 1,
        totalSteps: 2,
        isRescue: true,
        message: '正在处理批次 1/2...',
        currentTreePreview: [
          {
            name: '技术资料',
            files: [{ fileId: 2, smartName: '待找补1.pdf' }],
            subdirectories: [],
            fileCount: 1
          },
          {
            name: SENTINEL_NAMES.UNCLASSIFIED,
            files: [{ fileId: 3, smartName: '待找补2.pdf' }],
            subdirectories: [],
            fileCount: 1
          }
        ]
      })
    })

    // 关键断言 2：批次进度刷新 finalTree 期间，仍不得并发触发新的 reorganize
    expect(mockReorganize).toHaveBeenCalledTimes(1)

    // 结束本轮找补（全部归类完成）
    await act(async () => {
      resolveReorganize!({
        success: true,
        tree: [
          {
            name: '技术资料',
            files: [
              { fileId: 2, smartName: '待找补1.pdf' },
              { fileId: 3, smartName: '待找补2.pdf' }
            ],
            subdirectories: [],
            fileCount: 2
          }
        ]
      })
      await autoRescuePromise!
    })

    expect(mockReorganize).toHaveBeenCalledTimes(1)
    expect(result.current.isAutoRescuing).toBe(false)
  })
})
