import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { renderHook, act, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { useOrganizeState } from '../hooks/useOrganizeState'
import { toast } from '../../../common/Toast'

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

/**
 * 规格：docs/specs/batch-tag-same-dimension-mutex-spec.md §5.5 / 分片 S3
 *
 * 存量缺陷（本次修复）：saveBatchTags 的 catch 只 toast.error 后**resolve**，
 * 调用方（BatchTagView.handleSave）的 try/catch 永远不触发 ⇒
 * 「保存失败不重置工作台」与 §5.4 的覆盖提示都不可实现。
 *
 * 本文件锁两件事：
 *   1. 失败路径必须 reject（rethrow），且 toast.error 只弹一次；
 *   2. 成功路径必须把 BatchTagResult 原样透传（overriddenCount 可达视图层）。
 */
describe('S3：saveBatchTags 返回值透传与错误重抛（规格 §5.5）', () => {
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(MemoryRouter, null, children)

  beforeEach(() => {
    vi.clearAllMocks()
    ;(window as any).electronAPI = {
      // 宽泛兜底：mount 期间 hook 可能探测各类接口，全部返回安全空结果
      analyzedDirectory: {
        getDimensionGroups: vi.fn().mockResolvedValue({ groups: [] }),
        getDirectoryTree: vi.fn().mockResolvedValue({ tree: null }),
        getHighFrequencyTags: vi.fn().mockResolvedValue({ tags: [] })
      },
      organizeBatch: {
        applyTags: vi.fn(),
        inspectControlledTags: vi.fn().mockResolvedValue({ success: true, results: [] }),
        deleteTagGlobally: vi.fn().mockResolvedValue(true)
      },
      organize: {
        getOrganizePlan: vi.fn().mockResolvedValue({ plan: [] }),
        executeOrganize: vi.fn().mockResolvedValue({ success: true })
      },
      virtualDirectory: {
        list: vi.fn().mockResolvedValue({ directories: [] }),
        get: vi.fn().mockResolvedValue(null)
      }
    }
  })

  it('§5.5-1：applyTags 失败时 saveBatchTags 必须 reject，且 toast.error 只弹一次', async () => {
    ;(window as any).electronAPI.organizeBatch.applyTags = vi
      .fn()
      .mockRejectedValue(new Error('批量打标失败: disk I/O error'))

    const { result } = renderHook(() => useOrganizeState(), { wrapper })

    await act(async () => {
      await expect(
        result.current.saveBatchTags({
          fileIds: [1],
          addTags: [{ dimensionId: 140, dimensionName: '视角', viaParentCode: 'builtin.perspective', tagName: '俯视' }]
        })
      ).rejects.toThrow('批量打标失败: disk I/O error')
    })

    // 重抛前保留 toast（避免上层忘记提示），且不重复弹
    expect(toast.error).toHaveBeenCalledTimes(1)
    // finally 中的 saving 状态必须复位，否则按钮会卡死在「保存中」
    expect(result.current.isSavingTags).toBe(false)
  })

  it('§5.5-2：applyTags 成功时原样透传 BatchTagResult（overriddenCount 可达视图层）', async () => {
    ;(window as any).electronAPI.organizeBatch.applyTags = vi.fn().mockResolvedValue({
      successCount: 2,
      failedCount: 0,
      updatedFileIds: [1, 2],
      overriddenCount: 3,
      overrides: []
    })

    const { result } = renderHook(() => useOrganizeState(), { wrapper })

    let returned: any
    await act(async () => {
      returned = await result.current.saveBatchTags({
        fileIds: [1, 2],
        addTags: [
          { dimensionId: 140, dimensionName: '视角', viaParentCode: 'builtin.perspective', tagName: '俯视' }
        ]
      })
    })

    // 透传契约：视图层靠它发 §5.4 的「共覆盖 N 处」提示
    expect(returned).toMatchObject({ successCount: 2, overriddenCount: 3 })
    expect(result.current.isSavingTags).toBe(false)
  })

  it('§5.5-3：fileIds 为空时仅提示、不调 IPC、不抛异常', async () => {
    const { result } = renderHook(() => useOrganizeState(), { wrapper })

    await act(async () => {
      await result.current.saveBatchTags({ fileIds: [], addTags: [] })
    })

    expect(toast.warning).toHaveBeenCalledWith('暂无目标文件')
    expect((window as any).electronAPI.organizeBatch.applyTags).not.toHaveBeenCalled()
  })
})
