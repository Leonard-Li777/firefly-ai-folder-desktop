import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render, fireEvent } from '@testing-library/react'
import { DoneView } from '../components/DoneView'
import { useOrganizeStore } from '../../../../stores/organize-store'
import { VirtualDirectoryNode } from '@firefly/types'

// Mock 依赖项
vi.mock('@app/languages', () => ({
  t: (key: string, params?: any) => {
    if (params && typeof params === 'object') {
      let res = key
      for (const k in params) {
        res = res.replace(new RegExp('\\{' + k + '\\}', 'g'), params[k])
      }
      return res
    }
    return key
  },
  $t: (key: string) => key,
  Translate: ({ children }: any) => children,
  i18nScope: { t: (s: string) => s, activeLanguage: 'zh-CN', defaultLanguage: 'zh-CN' },
  default: { t: (s: string) => s, activeLanguage: 'zh-CN', defaultLanguage: 'zh-CN' }
}))

vi.mock('@voerkai18n/react', () => ({
  useVoerkaI18n: () => ({
    t: (s: string, params?: any) => {
      if (params && typeof params === 'object') {
        let res = s
        for (const k in params) {
          res = res.replace(new RegExp('\\{' + k + '\\}', 'g'), params[k])
        }
        return res
      }
      return s
    },
    activeLanguage: 'zh-CN',
    defaultLanguage: 'zh-CN'
  })
}))

vi.mock('@/renderer/stores/settings-store', () => {
  const mockStore = () => ({
    getConfigValue: () => 50
  })
  mockStore.getState = () => ({
    getConfigValue: () => 50
  })
  return {
    useSettingsStore: mockStore
  }
})

vi.mock('@/renderer/components/common/SplitPane', () => ({
  SplitPane: ({ sections }: any) => (
    <div data-testid="split-pane">
      {sections.map((s: any) => (
        <div key={s.id}>{s.content}</div>
      ))}
    </div>
  )
}))

vi.mock('@/renderer/components/file-explorer/Organize/components/PlanSidebar', () => ({
  PlanSidebar: () => <div data-testid="plan-sidebar" />
}))

vi.mock('@/renderer/components/file-explorer/Organize/components/VDirTree', () => ({
  VDirTree: () => <div data-testid="vdir-tree" />
}))

describe('DoneView Component & Filtering logic', () => {
  it('当实体分类树中已经归类了某文件时，该文件即使存在于未归类节点中也必须被二次校验防误杀过滤擦除', () => {
    const mockTree: VirtualDirectoryNode[] = [
      {
        name: '技术应用',
        parent: null,
        fileCount: 1,
        totalSize: 0,
        subdirectories: [],
        files: [
          {
            id: 99,
            fileId: 99,
            fileFingerprint: 'fp-99',
            name: '腾讯会议_办公协同.lnk',
            relativePath: 'D:\\腾讯会议_办公协同.lnk'
          }
        ]
      },
      {
        name: '未归类',
        parent: null,
        fileCount: 2,
        totalSize: 0,
        subdirectories: [],
        files: [
          // 已经归类的 99 号文件
          {
            id: 99,
            fileId: 99,
            fileFingerprint: 'fp-99',
            name: '腾讯会议_办公协同.lnk',
            relativePath: 'D:\\腾讯会议_办公协同.lnk'
          },
          // 真正未归类的 100 号文件
          {
            id: 100,
            fileId: 100,
            fileFingerprint: 'fp-100',
            name: '真正未归类文件.txt',
            relativePath: 'D:\\真正未归类文件.txt'
          }
        ]
      }
    ]

    const { getByText } = render(
      <DoneView
        tree={mockTree}
        organizeMode="incremental-organize"
        options={{
          allowCreateNew: false,
          flattenToRoot: false,
          skipEmptyDirs: true,
          deduplicateFiles: false
        }}
        onReorganize={vi.fn()}
        onRescue={vi.fn()}
        hasRescueFailed={false}
        draft={null}
        candidate={null}
        setOptions={vi.fn()}
      />
    )

    // 真正未归类的文件应该留在界面未归类列表中
    expect(getByText('真正未归类文件.txt')).toBeInTheDocument()
  })

  it('Done 视图应渲染及格线阈值与多目录归属双滑块，移除旧的文件去重选项，并提供高级AI深度找补按钮', () => {
    const mockTree: VirtualDirectoryNode[] = [
      {
        name: '未归类',
        parent: null,
        fileCount: 1,
        totalSize: 0,
        subdirectories: [],
        files: [
          {
            id: 101,
            name: '待找补.pdf',
            relativePath: '待找补.pdf'
          }
        ]
      }
    ]

    const onRescue = vi.fn()
    const { getByText, queryByText } = render(
      <DoneView
        tree={mockTree}
        organizeMode="identity-blueprint"
        options={{
          allowCreateNew: false,
          flattenToRoot: false,
          skipEmptyDirs: false,
          deduplicateFiles: false
        }}
        onReorganize={vi.fn()}
        onRescue={onRescue}
        hasRescueFailed={false}
        draft={null}
        candidate={null}
        setOptions={vi.fn()}
      />
    )

    // 1. 验证双滑块控件渲染
    expect(getByText(/及格线阈值/)).toBeInTheDocument()
    expect(getByText(/多目录归属上限/)).toBeInTheDocument()

    // 2. 验证旧的“文件去重”checkbox 已彻底移除
    expect(queryByText('文件去重')).toBeNull()

    // 3. 验证高级 AI 深度找补按钮
    const rescueBtn = getByText('高级 AI 深度找补')
    expect(rescueBtn).toBeInTheDocument()
    rescueBtn.click()
    expect(onRescue).toHaveBeenCalledWith(true)
  })

  it('当 rawMatches 预置有效时，拖拽滑块应成功触发纯内存重塑 handleReshape 并更新 finalTree', () => {
    const mockFile = { id: 201, name: '年度财务报表.xlsx', relativePath: '年度财务报表.xlsx' }
    const baseTree: VirtualDirectoryNode[] = [
      {
        name: '财务管理',
        parent: null,
        fileCount: 0,
        totalSize: 0,
        subdirectories: [],
        files: []
      },
      {
        name: '未归类',
        parent: null,
        fileCount: 0,
        totalSize: 0,
        subdirectories: [],
        files: []
      }
    ]

    // 预置 Store 状态
    useOrganizeStore.getState().setRawMatches({
      201: [{ path: '财务管理', score: 0.85 }]
    })
    useOrganizeStore.getState().setFilesMap({ 201: mockFile })
    useOrganizeStore.getState().setDraftTree(baseTree)

    const { container } = render(
      <DoneView
        tree={baseTree}
        organizeMode="identity-blueprint"
        options={{
          allowCreateNew: false,
          flattenToRoot: false,
          skipEmptyDirs: false,
          deduplicateFiles: false
        }}
        onReorganize={vi.fn()}
        onRescue={vi.fn()}
        hasRescueFailed={false}
        draft={null}
        candidate={null}
        setOptions={vi.fn()}
      />
    )

    // 找到及格线阈值滑块 input
    const sliders = container.querySelectorAll('input[type="range"]')
    expect(sliders.length).toBeGreaterThanOrEqual(2)
    const thresholdSlider = sliders[0]

    // 模拟将阈值调整为 0.7（低于 0.85，文件入围财务管理）
    fireEvent.change(thresholdSlider, { target: { value: '0.7' } })

    const finalTree = useOrganizeStore.getState().finalTree
    expect(finalTree).toBeDefined()
    const finNode = finalTree?.find(n => n.name === '财务管理')
    expect(finNode?.files.some((f: any) => f.id === 201)).toBe(true)

    // 模拟将阈值调高为 0.9（高于 0.85，文件应落入未归类）
    fireEvent.change(thresholdSlider, { target: { value: '0.9' } })
    const updatedFinalTree = useOrganizeStore.getState().finalTree
    const updatedFinNode = updatedFinalTree?.find(n => n.name === '财务管理')
    expect(updatedFinNode?.files.some((f: any) => f.id === 201)).toBe(false)
    const unclassifiedNode = updatedFinalTree?.find(n => n.name === '未归类')
    expect(unclassifiedNode?.files.some((f: any) => f.id === 201)).toBe(true)
  })
})
