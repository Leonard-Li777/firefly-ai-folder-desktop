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

describe('useOrganizeState 批量整理容量门禁与切片穿透验证', () => {
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(MemoryRouter, { initialEntries: ['/organize'] }, children)

  let mockReorganize: any

  beforeEach(() => {
    vi.clearAllMocks()
    useOrganizeStore.setState({
      stage: 'root-mode-select',
      organizeFileLimitOverride: null,
      bypassCapacityLimit: false,
      finalTree: [],
      draftTree: []
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
        getAnalyzedCount: vi.fn().mockResolvedValue(0),
        calculateFilePathsCosine: vi.fn().mockResolvedValue({ success: true, matches: {} })
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

  it('待整理文件超过 3,000 个时，入场全量拉取且首页不弹窗；点击批量整理入口时触发拦截并弹窗', async () => {
    const mock3005 = Array.from({ length: 3005 }, (_, i) => ({
      id: i + 1,
      path: `/workspace/file_${i + 1}.txt`,
      name: `file_${i + 1}.txt`,
      extension: 'txt',
      isAnalyzed: true
    }))
    ;(window as any).electronAPI.organizeRealDirectory.getLightweightFiles.mockResolvedValue(mock3005)

    const { result } = renderHook(() => useOrganizeState(), { wrapper })

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
    })

    // 入场后在 root-mode-select 首页：全量供给 3005 个，不弹窗！
    expect(result.current.rawToOrganizeCount).toBe(3005)
    expect(result.current.toOrganizeFiles.length).toBe(3005)
    expect(result.current.showCapacityLimitDialog).toBe(false)

    // 用户在首页点击“批量整理”尝试进入 mode-select
    act(() => {
      result.current.handleAttemptEnterModeSelect('mode-select')
    })

    // 触发超限拦截并弹窗，阻止直接切换 stage
    expect(result.current.showCapacityLimitDialog).toBe(true)
    expect(result.current.isCapacityExceeded).toBe(true)
    expect(result.current.capacityExceededCount).toBe(3005)
    expect(useOrganizeStore.getState().stage).toBe('root-mode-select')
  })

  it('待整理文件 <= 3,000 个时，点击批量整理入口直接放行切换到 mode-select', async () => {
    const mock50 = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1,
      path: `/workspace/file_${i + 1}.txt`,
      name: `file_${i + 1}.txt`,
      extension: 'txt',
      isAnalyzed: true
    }))
    ;(window as any).electronAPI.organizeRealDirectory.getLightweightFiles.mockResolvedValue(mock50)

    const { result } = renderHook(() => useOrganizeState(), { wrapper })

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
    })

    expect(result.current.toOrganizeFiles.length).toBe(50)
    expect(result.current.showCapacityLimitDialog).toBe(false)

    act(() => {
      result.current.handleAttemptEnterModeSelect('mode-select')
    })

    expect(result.current.showCapacityLimitDialog).toBe(false)
    expect(useOrganizeStore.getState().stage).toBe('mode-select')
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
    useOrganizeStore.setState({ stage: 'done' })

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
    expect(callArgs.files).toHaveLength(200)
    expect(callArgs.files[0].id).toBe(1)
    expect(callArgs.files[199].id).toBe(200)
  })

  it('超限弹窗中选择仅整理前 3,000 个文件时，整理主流程切片为 3,000，但切回首页保留全量', async () => {
    const mock5200 = Array.from({ length: 5200 }, (_, i) => ({
      id: i + 1,
      path: `/workspace/file_${i + 1}.txt`,
      name: `file_${i + 1}.txt`,
      extension: 'txt',
      isAnalyzed: true
    }))
    ;(window as any).electronAPI.organizeRealDirectory.getLightweightFiles.mockResolvedValue(mock5200)

    const { result } = renderHook(() => useOrganizeState(), { wrapper })

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
    })

    // 点击批量整理触发拦截
    act(() => {
      result.current.handleAttemptEnterModeSelect('mode-select')
    })
    expect(result.current.showCapacityLimitDialog).toBe(true)

    // 用户在弹窗中选择“仅整理前 3,000 个文件”
    act(() => {
      result.current.handleLimitToFirst3000Files()
    })

    // 验证：进入 mode-select，且待整理文件切片为 3000
    expect(useOrganizeStore.getState().stage).toBe('mode-select')
    expect(result.current.toOrganizeFiles.length).toBe(3000)
    expect(result.current.showCapacityLimitDialog).toBe(false)
    expect(result.current.isCapacityExceeded).toBe(false)

    // 关键验证：若切回 root-mode-select 首页或卫星模式，仍能访问全部 5200 个文件！
    act(() => {
      useOrganizeStore.getState().setStage('root-mode-select')
    })
    expect(result.current.toOrganizeFiles.length).toBe(5200)
  })

  it('超限弹窗中选择「我了解风险，仍要整理全部文件」时，设置 bypass 并带全量文件进入 mode-select', async () => {
    const mock5200 = Array.from({ length: 5200 }, (_, i) => ({
      id: i + 1,
      path: `/workspace/file_${i + 1}.txt`,
      name: `file_${i + 1}.txt`,
      extension: 'txt',
      isAnalyzed: true
    }))
    ;(window as any).electronAPI.organizeRealDirectory.getLightweightFiles.mockResolvedValue(mock5200)

    const { result } = renderHook(() => useOrganizeState(), { wrapper })

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
    })

    act(() => {
      result.current.handleAttemptEnterModeSelect('mode-select')
    })
    expect(result.current.showCapacityLimitDialog).toBe(true)

    // 用户选择底部次要链接：我了解风险，仍要整理全部文件
    act(() => {
      result.current.handleBypassLimitAndOrganizeAll()
    })

    // 验证：成功进入 mode-select，toOrganizeFiles 为全量 5200 个，且 bypassCapacityLimit 标记已激活
    expect(useOrganizeStore.getState().stage).toBe('mode-select')
    expect(result.current.toOrganizeFiles.length).toBe(5200)
    expect(result.current.bypassCapacityLimit).toBe(true)
    expect(result.current.showCapacityLimitDialog).toBe(false)
  })

  it('配置中心常量生效：当配置为 10 且文件为 15 时，点击批量整理触发拦截', async () => {
    useSettingsStore.setState({
      config: {
        ...useSettingsStore.getState().config,
        organizeCapacityLimit: 10
      } as any
    })

    const mock15 = Array.from({ length: 15 }, (_, i) => ({
      id: i + 1,
      path: `/workspace/file_${i + 1}.txt`,
      name: `file_${i + 1}.txt`,
      extension: 'txt',
      isAnalyzed: true
    }))
    ;(window as any).electronAPI.organizeRealDirectory.getLightweightFiles.mockResolvedValue(mock15)

    const { result } = renderHook(() => useOrganizeState(), { wrapper })

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
    })

    expect(result.current.organizeCapacityLimit).toBe(10)
    expect(result.current.toOrganizeFiles.length).toBe(15)
    expect(result.current.showCapacityLimitDialog).toBe(false)

    // 点击批量整理
    act(() => {
      result.current.handleAttemptEnterModeSelect('mode-select')
    })

    expect(result.current.showCapacityLimitDialog).toBe(true)
    expect(result.current.capacityExceededCount).toBe(15)

    // 选择前 10 个
    act(() => {
      result.current.handleLimitToFirst3000Files()
    })
    expect(useOrganizeStore.getState().stage).toBe('mode-select')
    expect(result.current.toOrganizeFiles.length).toBe(10)
  })

  it('路由门禁：当处于已分析页面 (/analyzed-directory) 时，即使后台 KeepAlive 存活，也不弹窗', async () => {
    const analyzedWrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(MemoryRouter, { initialEntries: ['/analyzed-directory'] }, children)

    const { result } = renderHook(() => useOrganizeState(), { wrapper: analyzedWrapper })

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
    })

    expect(result.current.showCapacityLimitDialog).toBe(false)
    expect(result.current.isCapacityExceeded).toBe(false)
  })

  it('从已分析页面携带超过容量上限的文件勾选进入 /organize 时，首页正常供给全量，点击批量整理触发拦截', async () => {
    useSettingsStore.setState({
      config: {
        ...useSettingsStore.getState().config,
        organizeCapacityLimit: 10
      } as any
    })

    const selectedIds = Array.from({ length: 15 }, (_, i) => 200 + i)
    const mock15 = selectedIds.map(id => ({
      id,
      path: `D:\\test\\file_${id}.txt`,
      name: `file_${id}.txt`,
      extension: 'txt',
      is_analyzed: 1,
      isAnalyzed: true
    }))
    ;(window as any).electronAPI.organizeRealDirectory.getLightweightFiles.mockResolvedValue(mock15)

    const overLimitWrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(
        MemoryRouter,
        {
          initialEntries: [
            {
              pathname: '/organize',
              state: {
                selectedFileIds: selectedIds,
                selectedFilePaths: selectedIds.map(id => `D:\\test\\file_${id}.txt`),
                initialStage: 'root-mode-select'
              }
            }
          ]
        },
        children
      )

    const { result } = renderHook(() => useOrganizeState(), { wrapper: overLimitWrapper })

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
    })

    // 首页供给全部 15 个勾选文件，不弹窗！
    expect(result.current.toOrganizeFiles).toHaveLength(15)
    expect(result.current.showCapacityLimitDialog).toBe(false)

    // 用户点击批量整理
    act(() => {
      result.current.handleAttemptEnterModeSelect('mode-select')
    })
    expect(result.current.showCapacityLimitDialog).toBe(true)
    expect(result.current.capacityExceededCount).toBe(15)

    // 用户在弹窗中选择“仅整理前 10 个”
    act(() => {
      result.current.handleLimitToFirst3000Files()
    })

    // 验证：整理流程截断为前 10 个
    expect(useOrganizeStore.getState().stage).toBe('mode-select')
    expect(result.current.toOrganizeFiles).toHaveLength(10)
    expect(result.current.toOrganizeFiles[0].id).toBe(200)
    expect(result.current.toOrganizeFiles[9].id).toBe(209)
  })

  it('超限时（文件数 15 > 上限 10），点击批量更名、批量标签、批量清理等卫星模式，直接放行且绝对不弹窗', async () => {
    useSettingsStore.setState({
      config: {
        ...useSettingsStore.getState().config,
        organizeCapacityLimit: 10
      } as any
    })

    const mock15 = Array.from({ length: 15 }, (_, i) => ({
      id: i + 1,
      path: `/workspace/file_${i + 1}.txt`,
      name: `/workspace/file_${i + 1}.txt`,
      extension: 'txt',
      isAnalyzed: true
    }))
    ;(window as any).electronAPI.organizeRealDirectory.getLightweightFiles.mockResolvedValue(mock15)

    const { result } = renderHook(() => useOrganizeState(), { wrapper })

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
    })

    expect(result.current.toOrganizeFiles.length).toBe(15)
    expect(result.current.showCapacityLimitDialog).toBe(false)

    // 1. 点击批量更名 (batch-rename)
    act(() => {
      result.current.handleAttemptEnterModeSelect('batch-rename')
    })
    expect(useOrganizeStore.getState().stage).toBe('batch-rename')
    expect(result.current.showCapacityLimitDialog).toBe(false)
    expect(result.current.toOrganizeFiles.length).toBe(15)

    // 2. 点击批量标签 (batch-tag)
    act(() => {
      result.current.handleAttemptEnterModeSelect('batch-tag')
    })
    expect(useOrganizeStore.getState().stage).toBe('batch-tag')
    expect(result.current.showCapacityLimitDialog).toBe(false)
    expect(result.current.toOrganizeFiles.length).toBe(15)

    // 3. 点击批量清理 (batch-duplicate)
    act(() => {
      result.current.handleAttemptEnterModeSelect('batch-duplicate')
    })
    expect(useOrganizeStore.getState().stage).toBe('batch-duplicate')
    expect(result.current.showCapacityLimitDialog).toBe(false)
    expect(result.current.toOrganizeFiles.length).toBe(15)

    // 4. 返回整理首页 (root-mode-select)
    act(() => {
      result.current.handleAttemptEnterModeSelect('root-mode-select')
    })
    expect(useOrganizeStore.getState().stage).toBe('root-mode-select')
    expect(result.current.showCapacityLimitDialog).toBe(false)
    expect(result.current.toOrganizeFiles.length).toBe(15)

    // 5. 只有点击批量整理 (mode-select) 时才被拦截并弹窗！
    act(() => {
      result.current.handleAttemptEnterModeSelect('mode-select')
    })
    expect(result.current.showCapacityLimitDialog).toBe(true)
    expect(result.current.capacityExceededCount).toBe(15)
  })
})
