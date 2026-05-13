import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import { AIOrganizeProgressDialog } from '../AIOrganizeProgressDialog'
import { BatchProgress } from '@yonuc/types/organize-types'

// Mock i18n
vi.mock('@app/languages', () => ({
  t: (key: string, params?: Record<string, any>) => {
    if (params) {
      return key.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? ''))
    }
    return key
  }
}))

describe('AIOrganizeProgressDialog', () => {
  it('应该显示批次进度信息', () => {
    const batchProgress: BatchProgress = {
      currentBatch: 3,
      totalBatches: 5,
      processedFiles: 60,
      totalFiles: 100,
    }

    render(<AIOrganizeProgressDialog batchProgress={batchProgress} />)

    expect(screen.getByText(/批次进度：/)).toBeInTheDocument()
    expect(screen.getByText(/文件进度：/)).toBeInTheDocument()
  })

  it('应该显示进度百分比', () => {
    const batchProgress: BatchProgress = {
      currentBatch: 1,
      totalBatches: 2,
      processedFiles: 50,
      totalFiles: 100,
    }

    render(<AIOrganizeProgressDialog batchProgress={batchProgress} />)

    expect(screen.getByText('50%')).toBeInTheDocument()
  })

  it('当有目录结构时应该显示目录数量', () => {
    const batchProgress: BatchProgress = {
      currentBatch: 2,
      totalBatches: 5,
      processedFiles: 40,
      totalFiles: 100,
      currentResult: {
        summary: '已创建工作文档和多媒体资源分类',
        directories: [
          {
            name: '工作文档',
            parent: '',
            files: ['file1.txt', 'file2.txt', 'file3.txt'],
          },
          {
            name: '多媒体资源',
            parent: '',
            files: ['file4.jpg', 'file5.mp4'],
          },
        ],
      },
    }

    render(<AIOrganizeProgressDialog batchProgress={batchProgress} />)

    expect(screen.getByText(/已创建 2 个目录分类/)).toBeInTheDocument()
    expect(screen.getByText(/已创建工作文档和多媒体资源分类/)).toBeInTheDocument()
  })

  it('应该支持显示/隐藏目录树预览', () => {
    const batchProgress: BatchProgress = {
      currentBatch: 2,
      totalBatches: 5,
      processedFiles: 40,
      totalFiles: 100,
      currentResult: {
        summary: '',
        directories: [
          {
            name: '工作文档',
            parent: '',
            files: ['file1.txt', 'file2.txt'],
          },
        ],
      },
    }

    render(<AIOrganizeProgressDialog batchProgress={batchProgress} />)

    // 默认应该显示预览
    expect(screen.getByText(/当前目录结构预览/)).toBeInTheDocument()

    // 点击隐藏按钮
    const toggleButton = screen.getByText('隐藏预览')
    fireEvent.click(toggleButton)

    // 预览应该被隐藏
    expect(screen.queryByText(/当前目录结构预览/)).not.toBeInTheDocument()

    // 点击显示按钮
    const showButton = screen.getByText('显示预览')
    fireEvent.click(showButton)

    // 预览应该再次显示
    expect(screen.getByText(/当前目录结构预览/)).toBeInTheDocument()
  })

  it('最后一批时应该显示完成提示', () => {
    const batchProgress: BatchProgress = {
      currentBatch: 5,
      totalBatches: 5,
      processedFiles: 100,
      totalFiles: 100,
      currentResult: {
        summary: '',
        directories: [],
      },
    }

    render(<AIOrganizeProgressDialog batchProgress={batchProgress} />)

    expect(screen.getByText(/分析完成！正在生成完整预览\.\.\./)).toBeInTheDocument()
  })

  it('非最后一批时应该显示处理中提示', () => {
    const batchProgress: BatchProgress = {
      currentBatch: 3,
      totalBatches: 5,
      processedFiles: 60,
      totalFiles: 100,
    }

    render(<AIOrganizeProgressDialog batchProgress={batchProgress} />)

    expect(screen.getByText(/AI 正在处理更多文件，请稍候\.\.\./)).toBeInTheDocument()
  })

  it('应该调用取消回调', () => {
    const mockOnCancel = vi.fn()
    const batchProgress: BatchProgress = {
      currentBatch: 2,
      totalBatches: 5,
      processedFiles: 40,
      totalFiles: 100,
    }

    render(<AIOrganizeProgressDialog batchProgress={batchProgress} onCancel={mockOnCancel} />)

    const cancelButton = screen.getByText('取消分析')
    fireEvent.click(cancelButton)

    expect(mockOnCancel).toHaveBeenCalledTimes(1)
  })

  it('进度中应该显示持续更新中提示', () => {
    const batchProgress: BatchProgress = {
      currentBatch: 2,
      totalBatches: 5,
      processedFiles: 40,
      totalFiles: 100,
      currentResult: {
        summary: '',
        directories: [
          {
            name: '工作文档',
            parent: '',
            files: ['file1.txt'],
          },
        ],
      },
    }

    render(<AIOrganizeProgressDialog batchProgress={batchProgress} />)

    expect(screen.getByText(/持续更新中\.\.\./)).toBeInTheDocument()
  })
})
