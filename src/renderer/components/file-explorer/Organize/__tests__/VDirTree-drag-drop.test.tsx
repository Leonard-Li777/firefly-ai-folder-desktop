import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render, fireEvent } from '@testing-library/react'
import { VDirTree } from '../components/VDirTree'
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
    t: (s: string) => s,
    activeLanguage: 'zh-CN',
    defaultLanguage: 'zh-CN'
  })
}))

vi.mock('@/renderer/stores/settings-store', () => {
  const mockStore = () => false
  mockStore.getState = () => ({
    getConfigValue: () => false
  })
  return {
    useSettingsStore: mockStore
  }
})

describe('VDirTree Drag & Drop to file and directory', () => {
  it('应当支持拖拽文件放置到同级文件旁边（以该文件父目录作为目标目录）', () => {
    const mockNodes: VirtualDirectoryNode[] = [
      {
        name: '设计素材',
        parent: null,
        fileCount: 1,
        totalSize: 100,
        subdirectories: [],
        files: [
          {
            id: 10,
            fileId: 10,
            name: '主KV视觉.psd',
            smartName: '主KV视觉.psd',
            relativePath: '主KV视觉.psd'
          }
        ]
      }
    ]

    const onMoveNodeOrFile = vi.fn()

    const { getByText } = render(
      <VDirTree
        nodes={mockNodes}
        allowEdit={true}
        onMoveNodeOrFile={onMoveNodeOrFile}
      />
    )

    // 目录与文件均应渲染
    expect(getByText('设计素材')).toBeInTheDocument()
    const fileElement = getByText('主KV视觉.psd')
    expect(fileElement).toBeInTheDocument()

    // 模拟将未归类文件拖放到现有文件“主KV视觉.psd”上
    const dropEvent = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      dataTransfer: {
        getData: vi.fn((format: string) => {
          if (format === 'application/json') {
            return JSON.stringify({
              type: 'file',
              file: { id: 99, name: '未归类Logo.png' }
            })
          }
          return ''
        })
      }
    }

    // 找到文件节点所在的 container (具有 drop 处理的行)
    const fileRow = fileElement.closest('.cursor-pointer')
    expect(fileRow).not.toBeNull()

    if (fileRow) {
      fireEvent.drop(fileRow, dropEvent)
      // 验证目标 key 必须是该文件的父目录 '设计素材'，而不是文件自身
      expect(onMoveNodeOrFile).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'file',
          file: expect.objectContaining({ id: 99 })
        }),
        '设计素材'
      )
    }
  })

  it('拖动到子目录或子目录内文件后，展开的子目录在节点增量更新后依然保持展开，不自动收起', () => {
    const initialNodes: VirtualDirectoryNode[] = [
      {
        name: '工作',
        parent: null,
        fileCount: 1,
        totalSize: 100,
        subdirectories: [
          {
            name: '周报',
            parent: null,
            fileCount: 1,
            totalSize: 100,
            subdirectories: [],
            files: [
              {
                id: 101,
                fileId: 101,
                name: '第1周.md',
                smartName: '第1周.md',
                relativePath: '工作/周报/第1周.md'
              }
            ]
          }
        ],
        files: []
      }
    ]

    const onMoveNodeOrFile = vi.fn()

    const { getByText, rerender } = render(
      <VDirTree
        nodes={initialNodes}
        allowEdit={true}
        onMoveNodeOrFile={onMoveNodeOrFile}
      />
    )

    // 默认 expand-all 模式下，根目录“工作”、嵌套子目录“周报”及其内部文件“第1周.md”均自动展开可见
    expect(getByText('工作')).toBeInTheDocument()
    expect(getByText('周报')).toBeInTheDocument()
    expect(getByText('第1周.md')).toBeInTheDocument()

    // 模拟拖动新文件到“周报”目录中的“第1周.md”文件旁边
    const fileElement = getByText('第1周.md')
    const fileRow = fileElement.closest('.cursor-pointer')
    expect(fileRow).not.toBeNull()

    const dropEvent = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      dataTransfer: {
        getData: vi.fn((format: string) => {
          if (format === 'application/json') {
            return JSON.stringify({
              type: 'file',
              file: { id: 102, name: '第2周.md' }
            })
          }
          return ''
        })
      }
    }

    if (fileRow) {
      fireEvent.drop(fileRow, dropEvent)
      // 验证目标 key 必须是该文件的父目录全路径 '工作/周报'
      expect(onMoveNodeOrFile).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'file',
          file: expect.objectContaining({ id: 102 })
        }),
        '工作/周报'
      )
    }

    // 模拟外部 state 更新：放入新文件后重新向 VDirTree 传入新的 nodes
    const updatedNodes: VirtualDirectoryNode[] = [
      {
        name: '工作',
        parent: null,
        fileCount: 2,
        totalSize: 200,
        subdirectories: [
          {
            name: '周报',
            parent: null,
            fileCount: 2,
            totalSize: 200,
            subdirectories: [],
            files: [
              {
                id: 101,
                fileId: 101,
                name: '第1周.md',
                smartName: '第1周.md',
                relativePath: '工作/周报/第1周.md'
              },
              {
                id: 102,
                fileId: 102,
                name: '第2周.md',
                smartName: '第2周.md',
                relativePath: '工作/周报/第2周.md'
              }
            ]
          }
        ],
        files: []
      }
    ]

    rerender(
      <VDirTree
        nodes={updatedNodes}
        allowEdit={true}
        onMoveNodeOrFile={onMoveNodeOrFile}
      />
    )

    // 重点验证：更新后“工作”和“周报”依然保持展开状态，新旧两个文件均在 DOM 中可见（未被折叠隐藏）
    expect(getByText('工作')).toBeInTheDocument()
    expect(getByText('周报')).toBeInTheDocument()
    expect(getByText('第1周.md')).toBeInTheDocument()
    expect(getByText('第2周.md')).toBeInTheDocument()
  })
})
