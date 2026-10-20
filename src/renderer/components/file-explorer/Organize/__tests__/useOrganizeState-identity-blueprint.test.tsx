import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { renderHook, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { useOrganizeState } from '../hooks/useOrganizeState'

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

describe('useOrganizeState 模式门禁防护验证', () => {
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(MemoryRouter, null, children)

  let mockGenerateCandidates: any

  beforeEach(() => {
    vi.clearAllMocks()
    mockGenerateCandidates = vi.fn().mockResolvedValue({ candidates: [] })
    ;(window as any).electronAPI = {
      virtualDirectory: {
        generateNameAndStrategyCandidates: mockGenerateCandidates,
        getDirectoryTree: vi.fn().mockResolvedValue({ tree: null }),
        getWorkspaceDirectoryById: vi.fn().mockResolvedValue({ id: 1, path: '/test' })
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

  it('选择【身份蓝图】模式后，严禁触发语言模型 API (generateNameAndStrategyCandidates)', async () => {
    const { result } = renderHook(() => useOrganizeState(), { wrapper })

    await act(async () => {
      result.current.handleModeSelect('identity-blueprint')
    })

    expect(result.current.stage).toBe('candidates')
    expect(result.current.organizeMode).toBe('identity-blueprint')
    // 门禁生效：绝不能调用大语言模型 API
    expect(mockGenerateCandidates).not.toHaveBeenCalled()
  })

  it('身份蓝图模式下手动调用 generateCandidates 也应被门禁拦截', async () => {
    const { result } = renderHook(() => useOrganizeState(), { wrapper })

    await act(async () => {
      result.current.handleModeSelect('identity-blueprint')
    })

    await act(async () => {
      await result.current.generateCandidates()
    })

    expect(mockGenerateCandidates).not.toHaveBeenCalled()
  })
})
