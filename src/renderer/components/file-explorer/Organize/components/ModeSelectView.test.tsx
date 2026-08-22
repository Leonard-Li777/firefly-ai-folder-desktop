import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render } from '@testing-library/react'
import { ModeSelectView } from './ModeSelectView'

// Mock 语言包 t 函数
vi.mock('@app/languages', () => ({
  t: (key: string, params?: Record<string, any>) => {
    if (params) {
      let str = key
      Object.keys(params).forEach(k => {
        str = str.replace(`{${k}}`, String(params[k]))
      })
      return str
    }
    return key
  }
}))

describe('ModeSelectView Component unit tests', () => {
  it('应能正确渲染虚拟目录卡片的小字，显示未归类文件个数与文件总数', () => {
    const mockVDirs = [
      {
        id: 1,
        name: '工作文档集',
        dirCount: 4,
        unclassifiedCount: 5,
        fileCount: 42
      }
    ]

    const { getByText } = render(
      <ModeSelectView
        organizeMode="fast-organize"
        onSelectMode={vi.fn()}
        hasVirtualDirectories={true}
        virtualDirectories={mockVDirs}
      />
    )

    // 验证虚拟目录名称正确展示
    expect(getByText('工作文档集')).toBeInTheDocument()

    // 验证目录个数 (4)、未归类文件个数 (5) 与文件总数 (42) 正确展示
    expect(getByText('4')).toBeInTheDocument()
    expect(getByText(/个目录/)).toBeInTheDocument()
    expect(getByText(/未归类/)).toBeInTheDocument()
    expect(getByText('5')).toBeInTheDocument()
    expect(getByText(/共/)).toBeInTheDocument()
    expect(getByText('42')).toBeInTheDocument()
  })

  it('在模式选择 stage，主用户点击草稿卡片删除按钮应触发 onDeleteDraftVDir 回调', () => {
    const onDeleteDraftVDir = vi.fn()
    const mockDraftVDir = [
      {
        id: 99,
        name: '未保存的测试草稿',
        source: 'draft',
        dirCount: 2,
        unclassifiedCount: 1,
        fileCount: 10
      }
    ]

    const { getByTitle } = render(
      <ModeSelectView
        organizeMode="fast-organize"
        onSelectMode={vi.fn()}
        hasVirtualDirectories={true}
        virtualDirectories={mockDraftVDir}
        onDeleteDraftVDir={onDeleteDraftVDir}
      />
    )

    const deleteBtn = getByTitle('删除草稿')
    expect(deleteBtn).toBeInTheDocument()
    deleteBtn.click()

    expect(onDeleteDraftVDir).toHaveBeenCalledWith(99)
  })
})
