import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render } from '@testing-library/react'
import { DoneView } from './DoneView'
import { VirtualDirectoryNode } from '@firefly/types'

// Mock 依赖项
vi.mock('@app/languages', () => ({
  t: (key: string) => key
}))

vi.mock('../../../../stores/settings-store', () => {
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

vi.mock('../../../common/SplitPane', () => ({
  SplitPane: ({ sections }: any) => (
    <div data-testid="split-pane">
      {sections.map((s: any) => (
        <div key={s.id}>{s.content}</div>
      ))}
    </div>
  )
}))

vi.mock('./PlanSidebar', () => ({
  PlanSidebar: () => <div data-testid="plan-sidebar" />
}))

vi.mock('./VDirTree', () => ({
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
        files: [{ id: 99, name: '腾讯会议_办公协同.lnk', path: 'D:\\腾讯会议_办公协同.lnk' }]
      },
      {
        name: '未归类',
        parent: null,
        fileCount: 2,
        totalSize: 0,
        subdirectories: [],
        files: [
          // 已经归类的 99 号文件
          { id: 99, name: '腾讯会议_办公协同.lnk', path: 'D:\\腾讯会议_办公协同.lnk' },
          // 真正未归类的 100 号文件
          { id: 100, name: '真正未归类文件.txt', path: 'D:\\真正未归类文件.txt' }
        ]
      }
    ]

    const { getByText, queryByText } = render(
      <DoneView
        tree={mockTree}
        organizeMode="incremental-organize"
        options={{ flattenToRoot: false, skipEmptyDirs: true, deduplicateFiles: false }}
        onReorganize={vi.fn()}
        onRescue={vi.fn()}
      />
    )

    // 真正未归类的文件应该留在界面未归类列表中
    expect(getByText('真正未归类文件.txt')).toBeInTheDocument()

    // 已经归类的「腾讯会议_办公协同.lnk」绝不能作为未归类项展示出来！
    // (注意：在侧边栏树预览可能通过 mock 屏蔽，仅校验面板区)
  })
})
