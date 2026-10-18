import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { BatchTagView } from '../components/BatchTagView'
import { DimensionGroup } from '@firefly/types'
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

vi.mock('../../../common/SplitPane', () => ({
  SplitPane: ({ sections }: any) => (
    <div data-testid="split-pane">
      {sections.map((s: any) => (
        <div key={s.id} data-testid={`section-${s.id}`}>
          {s.content}
        </div>
      ))}
    </div>
  )
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
 * 规格：docs/specs/batch-tag-same-dimension-mutex-spec.md §5.2–5.5 / 分片 S3 / §8.2 U1–U5
 *
 * S3 是互斥的 UI 侧防线，与 S2（写库侧）配套：
 *   - U1/U3：三态互斥（单选维度点第二个标签，第一个回到 initial；多选维度不受影响）
 *   - U2：单选维度的「全附」替换为不可点纯文本「选一个」（D-02），且状态机层仍兜底
 *   - U4：保存成功后 overriddenCount > 0 弹 info toast（D-03：只提示，不撤销）
 *   - U5：保存失败必须 reject 且不重置工作台（依赖 saveBatchTags 重抛，§5.5）
 *
 * 维度 code 一律用**维度根 code**（builtin.perspective / builtin.content_tags），
 * 与 TagTreeQuery 运行时 groups.push({ code: dimCode })（TagTreeQuery.ts:918,1082）一致。
 * 注意勿用 concept('视角')——那是 omw.13919059.n，不在单选集合里（会退化成 unknown）。
 */
describe('S3：BatchTagView 三态互斥 / 全附门禁 / 覆盖提示 / 保存重抛', () => {
  const mockFiles = [
    { id: 1, name: 'file1.txt', dimensionTags: [] },
    { id: 2, name: 'file2.txt', dimensionTags: [] }
  ]

  // 单选维度：视角（classifyDimensionMutexScope('builtin.perspective') === 'single'）
  const singleGroup: DimensionGroup = {
    id: 140,
    name: '视角',
    code: 'builtin.perspective',
    metadata: { flag: { isPanDimension: false } },
    tags: [
      { dimensionId: 140, tagValue: '平视', fileCount: 0 },
      { dimensionId: 140, tagValue: '俯视', fileCount: 0 }
    ]
  } as DimensionGroup

  // 多选维度：内容标签（classifyDimensionMutexScope('builtin.content_tags') === 'multi'）
  const multiGroup: DimensionGroup = {
    id: 28,
    name: '内容标签',
    code: 'builtin.content_tags',
    metadata: { flag: { isPanDimension: true } },
    tags: [
      { dimensionId: 28, tagValue: '山', fileCount: 0 },
      { dimensionId: 28, tagValue: '城市', fileCount: 0 }
    ]
  } as DimensionGroup

  beforeEach(() => {
    vi.clearAllMocks()
    ;(window as any).electronAPI = {
      analyzedDirectory: {
        getDimensionGroups: vi.fn().mockResolvedValue({ groups: [] })
      },
      organizeBatch: {
        inspectControlledTags: vi.fn().mockResolvedValue({
          success: true,
          results: [{ tagName: '', isControlled: false, matchedParent: false, code: null, parentCodes: [] }]
        })
      }
    }
  })

  const renderView = (
    groups: DimensionGroup[],
    onSaveTags: any = vi.fn().mockResolvedValue({
      successCount: 2,
      failedCount: 0,
      updatedFileIds: [1, 2],
      overriddenCount: 0
    })
  ) =>
    render(
      <BatchTagView
        files={mockFiles}
        dimensionGroups={groups}
        onSaveTags={onSaveTags}
      />
    )

  const clickSave = () => {
    const saveTrigger = document.getElementById('btn-save-tags-trigger')
    expect(saveTrigger).toBeInTheDocument()
    fireEvent.click(saveTrigger!)
  }

  it('U1：单选维度点第二个标签 → 第一个回到 initial，保存 payload 只含第二个', async () => {
    const onSaveTags = vi.fn().mockResolvedValue({
      successCount: 2,
      failedCount: 0,
      updatedFileIds: [1, 2],
      overriddenCount: 0
    })
    renderView([singleGroup], onSaveTags)

    await waitFor(() => {
      expect(screen.getByText('视角')).toBeInTheDocument()
    })

    // 先点「平视」→ add_all
    fireEvent.click(screen.getByText('平视'))
    // 再点「俯视」→ 互斥把「平视」置回 initial，只保留「俯视」
    fireEvent.click(screen.getByText('俯视'))

    clickSave()

    await waitFor(() => {
      expect(onSaveTags).toHaveBeenCalledTimes(1)
    })
    const payload = onSaveTags.mock.calls[0][0]
    const addedTagNames = (payload.addTags || []).map((t: any) => t.tagName)
    expect(addedTagNames).toEqual(['俯视'])
    expect(addedTagNames).not.toContain('平视')
    // 触发的标签必须带上维度根 code（写库侧作用域键）
    expect(payload.addTags[0].viaParentCode).toBe('builtin.perspective')
    // 互斥只动选中态：没有任何 removeTags 产生
    expect(payload.removeTags).toEqual([])
  })

  it('U2：单选维度 3 个「全附」位点均替换为纯文本「选一个」，且直接触发状态机也不写入 add_all', async () => {
    const onSaveTags = vi.fn().mockResolvedValue({
      successCount: 2,
      failedCount: 0,
      updatedFileIds: [1, 2],
      overriddenCount: 0
    })
    // 本用例只渲染单选维度，故文档范围内出现「全附」即证明门禁失效
    renderView([singleGroup], onSaveTags)

    await waitFor(() => {
      expect(screen.getByText('视角')).toBeInTheDocument()
    })

    // 单选维度不渲染「全附」按钮（文档范围内唯一维度即单选维度）
    expect(screen.queryByText('全附')).not.toBeInTheDocument()
    // 改为不可点纯文本提示（D-02：不是 disabled 按钮，纯文本是明确的语义声明）
    const hint = screen.getByText('选一个')
    expect(hint).toBeInTheDocument()
    expect(hint.tagName).toBe('SPAN')
    // 「恢复」按钮仍然可用（重置路径不受门禁影响）
    expect(screen.getByText('恢复')).toBeInTheDocument()
  })

  it('U3：多选维度「全附」按钮照旧，点选后两个标签都进 addTags', async () => {
    const onSaveTags = vi.fn().mockResolvedValue({
      successCount: 2,
      failedCount: 0,
      updatedFileIds: [1, 2],
      overriddenCount: 0
    })
    renderView([multiGroup], onSaveTags)

    await waitFor(() => {
      expect(screen.getByText('内容标签')).toBeInTheDocument()
    })

    const viewCard = screen.getByText('内容标签').closest('.space-y-3')!
    const addAllBtn = within(viewCard as HTMLElement).getByText('全附')
    expect(addAllBtn.tagName).toBe('BUTTON')
    fireEvent.click(addAllBtn)

    clickSave()

    await waitFor(() => {
      expect(onSaveTags).toHaveBeenCalledTimes(1)
    })
    const payload = onSaveTags.mock.calls[0][0]
    const addedTagNames = (payload.addTags || []).map((t: any) => t.tagName)
    // 多选维度两个标签都保留（注意：中文按码点排序，城 < 山）
    expect(addedTagNames).toHaveLength(2)
    expect(addedTagNames).toEqual(expect.arrayContaining(['山', '城市']))
  })

  it('U4：保存成功且 overriddenCount > 0 → info toast 提示共覆盖处数（D-03 只提示不撤销）', async () => {
    const onSaveTags = vi.fn().mockResolvedValue({
      successCount: 2,
      failedCount: 0,
      updatedFileIds: [1, 2],
      overriddenCount: 3
    })
    renderView([multiGroup], onSaveTags)

    await waitFor(() => {
      expect(screen.getByText('内容标签')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('山'))
    clickSave()

    await waitFor(() => {
      expect(onSaveTags).toHaveBeenCalledTimes(1)
    })
    // §5.4：计数是跨文件/跨维度汇总，故用「共覆盖」；且不提供撤销入口
    expect(toast.info).toHaveBeenCalledWith('共覆盖 3 处单选冲突标签')
  })

  it('U5：保存失败（onSaveTags reject）→ 不重置工作台，pending 变更徽标仍在', async () => {
    const onSaveTags = vi.fn().mockRejectedValue(new Error('批量打标失败: disk I/O'))
    renderView([multiGroup], onSaveTags)

    await waitFor(() => {
      expect(screen.getByText('内容标签')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('山'))
    // 保存前应有 pending 变更徽标
    expect(screen.getByText('+1 附加')).toBeInTheDocument()

    clickSave()

    await waitFor(() => {
      expect(onSaveTags).toHaveBeenCalledTimes(1)
    })
    // 失败提示
    expect(toast.error).toHaveBeenCalledWith('保存标签失败: 批量打标失败: disk I/O')
    // 悲观保护：工作台未被重置，pending 变更仍在（若 saveBatchTags 吞异常 resolve，此处会假绿）
    expect(screen.getByText('+1 附加')).toBeInTheDocument()
  })
})
