/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { renderHook, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { useOrganizeState } from '../hooks/useOrganizeState'
import { useOrganizeStore } from '../../../../stores/organize-store'
import { useAnalyzedDirectoryStore } from '../../../../stores/analyzed-directory-store'
import { useSettingsStore } from '../../../../stores/settings-store'

const { mockT } = vi.hoisted(() => {
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
  return { mockT: tFn }
})

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

describe('useOrganizeState 3,000 容量硬上限与找补截断验证', () => {
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(MemoryRouter, { initialEntries: ['/organize'] }, children)

  let mockReorganize: any

  beforeEach(() => {
    vi.clearAllMocks()
    useOrganizeStore.setState({
      finalTree: [],
      draftTree: [],
      stage: 'done'
    })
    useSettingsStore.setState({
      config: {
        organizeCapacityLimit: 3000
      } as any
    })
    useAnalyzedDirectoryStore.getState().setCurrentWorkspaceDirectory({
      id: 1,
      path: '/workspace',
      name: 'workspace'
    } as any)
    mockReorganize = vi.fn().mockResolvedValue({ success: true, tree: [] })
    ;(window as any).electronAPI = {
      getCurrentWorkspaceDirectory: vi.fn().mockResolvedValue({ id: 1, path: '/workspace' }),
      organizeRealDirectory: {
        getAnalyzedFiles: vi.fn().mockResolvedValue([]),
        getLightweightFiles: vi.fn().mockResolvedValue([]),
        getAnalyzedCount: vi.fn().mockResolvedValue(0)
      },
      virtualDirectory: {
        getAnalyzedCount: vi.fn().mockResolvedValue(0),
        generateNameAndStrategyCandidates: vi.fn().mockResolvedValue({ candidates: [] }),
        getDirectoryTree: vi.fn().mockResolvedValue({ tree: null }),
        getWorkspaceDirectoryById: vi.fn().mockResolvedValue({ id: 1, path: '/workspace' }),
        reorganize: mockReorganize,
        list: vi.fn().mockResolvedValue([]),
        onReorganizeProgress: vi.fn().mockReturnValue(() => {})
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

  it('待整理文件超过 3,000 个时，触发容量超限守卫与弹窗，阻断前进', async () => {
    // 模拟前置探针返回 3,005，触发门禁并不拉取文件对象（0 对象进内存）
    ;(window as any).electronAPI.organizeRealDirectory.getAnalyzedCount.mockResolvedValue(3005)
    ;(window as any).electronAPI.virtualDirectory.getAnalyzedCount.mockResolvedValue(3005)

    const { result } = renderHook(() => useOrganizeState(), { wrapper })

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
    })

    expect(result.current.toOrganizeFiles.length).toBe(0)
    expect(result.current.isCapacityExceeded).toBe(true)
    expect(result.current.capacityExceededCount).toBe(3005)
    expect(result.current.showCapacityLimitDialog).toBe(true)
    expect(result.current.canForward).toBe(false)
  })

  it('待整理文件 <= 3,000 个时，容量超限守卫不触发', async () => {
    ;(window as any).electronAPI.organizeRealDirectory.getAnalyzedCount.mockResolvedValue(50)
    ;(window as any).electronAPI.virtualDirectory.getAnalyzedCount.mockResolvedValue(50)
    const mockFiles = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1,
      path: `/workspace/file_${i + 1}.txt`,
      name: `file_${i + 1}.txt`,
      smartName: `file_${i + 1}`,
      extension: 'txt',
      isAnalyzed: true
    }))
    ;(window as any).electronAPI.organizeRealDirectory.getLightweightFiles.mockResolvedValue(mockFiles)

    const { result } = renderHook(() => useOrganizeState(), { wrapper })

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
    })

    expect(result.current.toOrganizeFiles.length).toBe(50)
    expect(result.current.isCapacityExceeded).toBe(false)
    expect(result.current.showCapacityLimitDialog).toBe(false)
  })

  it('点击 handleGoToAnalyzedPage 时，正确导航到已分析页面', async () => {
    const { result } = renderHook(() => useOrganizeState(), { wrapper })

    act(() => {
      result.current.handleGoToAnalyzedPage()
    })

    expect(mockNavigate).toHaveBeenCalledWith('/analyzed-directory', {
      state: { startInOrganizeMode: true, workspaceId: 1 }
    })
    expect(result.current.showCapacityLimitDialog).toBe(false)
  })

  it('Done 阶段未归类找补 (handleRescue) 超出 200 个文件时，必须严格截断前 200 个传入后端', async () => {
    useAnalyzedDirectoryStore.getState().setCurrentWorkspaceDirectory({
      id: 1,
      path: '/workspace',
      name: 'workspace'
    } as any)

    // 构造一个包含 280 个未归类文件的 finalTree
    const unclassified280 = Array.from({ length: 280 }, (_, i) => ({
      id: i + 1,
      name: `unclassified_${i + 1}.txt`,
      path: `/workspace/unclassified_${i + 1}.txt`
    }))

    useOrganizeStore.setState({
      finalTree: [
        {
          name: '未归类',
          isUnclassified: true,
          files: unclassified280
        } as any
      ]
    })

    const { result } = renderHook(() => useOrganizeState(), { wrapper })

    await act(async () => {
      await result.current.handleRescue()
    })

    expect(mockReorganize).toHaveBeenCalledTimes(1)
    const callArgs = mockReorganize.mock.calls[0][1]
    expect(callArgs.isRescue).toBe(true)
    // 关键断言：传给后端的 files 数组必须被截断至 exactly 200
    expect(callArgs.files).toHaveLength(200)
    expect(callArgs.files[0].id).toBe(1)
    expect(callArgs.files[199].id).toBe(200)
  })

  it('超限弹窗中选择仅整理前 3,000 个文件 (handleLimitToFirst3000Files) 时，成功拉取 3,000 个并解除阻断', async () => {
    ;(window as any).electronAPI.organizeRealDirectory.getAnalyzedCount.mockResolvedValue(5200)
    ;(window as any).electronAPI.virtualDirectory.getAnalyzedCount.mockResolvedValue(5200)

    const mock3000 = Array.from({ length: 3000 }, (_, i) => ({
      id: i + 1,
      path: `/workspace/file_${i + 1}.txt`,
      name: `file_${i + 1}.txt`,
      smartName: `file_${i + 1}`,
      extension: 'txt',
      isAnalyzed: true
    }))
    ;(window as any).electronAPI.organizeRealDirectory.getLightweightFiles.mockResolvedValue(mock3000)

    const { result } = renderHook(() => useOrganizeState(), { wrapper })

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
    })

    // 初始状态触发超限
    expect(result.current.isCapacityExceeded).toBe(true)
    expect(result.current.showCapacityLimitDialog).toBe(true)
    expect(result.current.toOrganizeFiles.length).toBe(0)

    // 用户在弹窗中选择“仅整理前 3,000 个文件”
    await act(async () => {
      await result.current.handleLimitToFirst3000Files()
    })

    // 验证解除阻断
    expect((window as any).electronAPI.organizeRealDirectory.getLightweightFiles).toHaveBeenCalledWith(
      '/workspace',
      undefined,
      3000
    )
    expect(result.current.toOrganizeFiles.length).toBe(3000)
    expect(result.current.isCapacityExceeded).toBe(false)
    expect(result.current.capacityExceededCount).toBe(0)
    expect(result.current.showCapacityLimitDialog).toBe(false)
  })

  it('配置中心常量生效：当配置为 10 (测试场景) 且文件为 15 时触发阻断，点击仅整理前批次拉取 10 个解除阻断', async () => {
    useSettingsStore.setState({
      config: {
        ...useSettingsStore.getState().config,
        organizeCapacityLimit: 10
      } as any
    })

    ;(window as any).electronAPI.organizeRealDirectory.getAnalyzedCount.mockResolvedValue(15)
    ;(window as any).electronAPI.virtualDirectory.getAnalyzedCount.mockResolvedValue(15)

    const mock10 = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      path: `/workspace/file_${i + 1}.txt`,
      name: `file_${i + 1}.txt`,
      smartName: `file_${i + 1}`,
      extension: 'txt',
      isAnalyzed: true
    }))
    ;(window as any).electronAPI.organizeRealDirectory.getLightweightFiles.mockResolvedValue(mock10)

    const { result } = renderHook(() => useOrganizeState(), { wrapper })

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
    })

    // 验证当前动态读取的容量上限为 10
    expect(result.current.organizeCapacityLimit).toBe(10)
    expect(result.current.isCapacityExceeded).toBe(true)
    expect(result.current.capacityExceededCount).toBe(15)
    expect(result.current.showCapacityLimitDialog).toBe(true)

    // 用户在弹窗中选择仅整理前 10 个文件
    await act(async () => {
      await result.current.handleLimitToFirst3000Files()
    })

    // 验证调用参数下推为 10
    expect((window as any).electronAPI.organizeRealDirectory.getLightweightFiles).toHaveBeenCalledWith(
      '/workspace',
      undefined,
      10
    )
    expect(result.current.toOrganizeFiles.length).toBe(10)
    expect(result.current.isCapacityExceeded).toBe(false)
    expect(result.current.capacityExceededCount).toBe(0)
    expect(result.current.showCapacityLimitDialog).toBe(false)
  })

  it('路由门禁：当处于已分析页面 (/analyzed-directory) 时，即使后台 KeepAlive 存活，也不拉取文件且弹窗恒为 false', async () => {
    ;(window as any).electronAPI.organizeRealDirectory.getAnalyzedCount.mockResolvedValue(5000)

    const analyzedWrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(MemoryRouter, { initialEntries: ['/analyzed-directory'] }, children)

    const { result } = renderHook(() => useOrganizeState(), { wrapper: analyzedWrapper })

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
    })

    // 严密断言：非 /organize 页面下绝不弹窗、不拉取文件
    expect(result.current.showCapacityLimitDialog).toBe(false)
    expect(result.current.isCapacityExceeded).toBe(false)
    expect(result.current.toOrganizeFiles).toHaveLength(0)
    expect((window as any).electronAPI.organizeRealDirectory.getLightweightFiles).not.toHaveBeenCalled()
  })
  it('从已分析页面携带勾选文件进入 /organize 时，正确带入文件并复位旧模式', async () => {
    useOrganizeStore.getState().setOrganizeMode('incremental-organize')

    const mockSelectedFiles = [
      { id: 101, path: 'D:\\test\\a.txt', name: 'a.txt', extension: 'txt', is_analyzed: 1, isAnalyzed: true },
      { id: 102, path: 'D:\\test\\b.txt', name: 'b.txt', extension: 'txt', is_analyzed: 1, isAnalyzed: true }
    ]
    ;(window as any).electronAPI.organizeRealDirectory.getLightweightFiles.mockResolvedValue(mockSelectedFiles)

    const selectedWrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(
        MemoryRouter,
        {
          initialEntries: [
            {
              pathname: '/organize',
              state: {
                selectedFileIds: [101, 102],
                selectedFilePaths: ['D:\\test\\a.txt', 'D:\\test\\b.txt'],
                initialStage: 'root-mode-select'
              }
            }
          ]
        },
        children
      )

    const { result } = renderHook(() => useOrganizeState(), { wrapper: selectedWrapper })

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
    })

    // 验证旧模式被成功清除且勾选文件正确带入
    expect(useOrganizeStore.getState().organizeMode).toBeUndefined()
    expect(result.current.toOrganizeFiles).toHaveLength(2)
    expect(result.current.toOrganizeFiles[0].id).toBe(101)
    expect(result.current.toOrganizeFiles[1].id).toBe(102)
    expect(result.current.showCapacityLimitDialog).toBe(false)
  })
})
