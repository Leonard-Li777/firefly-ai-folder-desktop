// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { WorkspaceAdmissionRulesTab } from '../WorkspaceAdmissionRulesTab'
import { useSettingsStore } from '../../../../stores/settings-store'
import { WorkspaceDirectory } from '@firefly/types'

// Mock 语言包
vi.mock('@app/languages', () => ({
  t: (key: string, params?: any) => {
    if (params && typeof params === 'object') {
      let res = key
      for (const k in params) {
        res = res.replace(new RegExp('\\{' + k + '\\}', 'g'), String(params[k]))
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

// Mock Toast
vi.mock('../../../common/Toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn()
  }
}))

describe('WorkspaceAdmissionRulesTab 包含与排除规则管理及影响预览', () => {
  const mockWorkspace: WorkspaceDirectory = {
    id: 1,
    workspace_id: 1,
    path: 'D:/mock/photos',
    name: 'photos',
    type: 'SPEEDY',
    recursive: true,
    isActive: true,
    whitelist_patterns: ['.cr3', '.arw'],
    workspace_config: JSON.stringify({
      schemaVersion: 1,
      status: 'ready',
      customIgnoreRules: [
        {
          id: 'rule-1',
          type: 'directory',
          value: 'temp',
          isActive: true,
          isSystem: false,
          description: '临时目录'
        }
      ]
    })
  }

  const mockStandardWorkspace: WorkspaceDirectory = {
    id: 2,
    workspace_id: 2,
    path: 'D:/mock/documents',
    name: 'documents',
    type: 'SPEEDY',
    recursive: true,
    isActive: true,
    whitelist_patterns: [],
    workspace_config: JSON.stringify({
      schemaVersion: 1,
      status: 'ready',
      customIgnoreRules: []
    })
  }

  const mockUpdateWorkspaceWhitelist = vi.fn().mockResolvedValue({ success: true })
  const mockPreviewWorkspaceWhitelistImpact = vi.fn().mockResolvedValue({
    success: true,
    totalFiles: 100,
    includedFiles: 75,
    excludedFiles: 25,
    isSampled: false
  })

  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({
      ignoreRules: [
        { id: 'sys-1', type: 'directory', value: '.git', isSystem: true, isActive: true },
        { id: 'sys-2', type: 'directory', value: 'node_modules', isSystem: true, isActive: true }
      ]
    })

    window.electronAPI = {
      updateWorkspaceWhitelist: mockUpdateWorkspaceWhitelist,
      previewWorkspaceWhitelistImpact: mockPreviewWorkspaceWhitelistImpact,
      updateWorkspaceConfig: vi.fn().mockResolvedValue({ success: true }),
      utils: {
        probeDirectoryProfile: vi.fn().mockResolvedValue({
          detectedIntent: 'fast_archive',
          confidence: 0.9,
          stats: {
            totalSampled: 100,
            docCount: 10,
            imageCount: 80,
            videoCount: 10,
            otherCount: 0,
            topExtensions: [
              { ext: '.cr3', count: 50 },
              { ext: '.arw', count: 25 },
              { ext: '.jpg', count: 25 }
            ],
            durationMs: 12,
            hitTimeBudget: false
          }
        })
      }
    } as any
  })

  it('AC 3: 醒目渲染绿色物理安全防护徽标与铁律提示', () => {
    render(<WorkspaceAdmissionRulesTab workspace={mockStandardWorkspace} />)

    expect(screen.getByText('绝不删除用户磁盘物理文件')).toBeDefined()
    expect(
      screen.getByText(
        '修改包含与排除规则仅重新过滤 AI 索引与分析队列，绝不会删除或修改您电脑磁盘中的任何原始物理文件。'
      )
    ).toBeDefined()
  })

  it('AC 1: 支持在标准模式与包含规则模式之间无缝切换', async () => {
    render(<WorkspaceAdmissionRulesTab workspace={mockStandardWorkspace} />)

    // 初始标准模式
    expect(screen.getByText('标准模式 (全量入场)')).toBeDefined()
    expect(screen.getByText('排他包含模式 (仅放行指定格式)')).toBeDefined()

    // 点击切换至排他模式
    fireEvent.click(screen.getByText('排他包含模式 (仅放行指定格式)'))

    // 切换后显示扩展名相关输入与预设
    await waitFor(() => {
      expect(screen.getByText('已启用的包含规则扩展名')).toBeDefined()
      expect(screen.getByText('常用类型快速选用')).toBeDefined()
    })

    // 再切换回标准模式
    fireEvent.click(screen.getByText('标准模式 (全量入场)'))
    await waitFor(() => {
      expect(screen.queryByText('已启用的包含规则扩展名')).toBeNull()
    })
  })

  it('AC 2: 包含规则扩展名展示，键入扩展名时自动规范化为纯小写带点格式 (.png)', async () => {
    render(<WorkspaceAdmissionRulesTab workspace={mockWorkspace} />)

    // 初始已有 .cr3 和 .arw 徽章
    expect(screen.getByTestId('whitelist-tag-.cr3')).toBeDefined()
    expect(screen.getByTestId('whitelist-tag-.arw')).toBeDefined()

    // 输入不带点且大写的扩展名 "PNG"
    const input = screen.getByPlaceholderText(
      '输入扩展名（如 png 或 .docx，回车添加，支持逗号分隔）'
    )
    fireEvent.change(input, { target: { value: 'PNG' } })
    fireEvent.click(screen.getByText('添加'))

    // 自动转为小写带点 .png
    await waitFor(() => {
      expect(screen.getByTestId('whitelist-tag-.png')).toBeDefined()
    })

    // 支持逗号分隔批量添加 "nef, .DNG"
    fireEvent.change(input, { target: { value: 'nef, .DNG' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })

    await waitFor(() => {
      expect(screen.getByTestId('whitelist-tag-.nef')).toBeDefined()
      expect(screen.getByTestId('whitelist-tag-.dng')).toBeDefined()
    })

    // 点击移除 .cr3
    const removeCr3Btn = screen.getByTestId('whitelist-tag-.cr3').querySelector('button')
    expect(removeCr3Btn).toBeDefined()
    fireEvent.click(removeCr3Btn!)

    await waitFor(() => {
      expect(screen.queryByTestId('whitelist-tag-.cr3')).toBeNull()
    })
  })

  it('支持快速选用分类预设扩展名', async () => {
    render(<WorkspaceAdmissionRulesTab workspace={mockWorkspace} />)

    // 快速预设中包含 .pdf
    expect(screen.getByText('.pdf')).toBeDefined()

    // 点击 .pdf 预设按钮
    fireEvent.click(screen.getByText('.pdf'))

    await waitFor(() => {
      // 列表中现在应该有了 .pdf
      const pdfBadges = screen.getAllByText('.pdf')
      expect(pdfBadges.length).toBeGreaterThan(0)
    })
  })

  it('AC 4: 修改包含规则后点击保存，成功调用 updateWorkspaceWhitelist 并触发回调', async () => {
    const onConfigSaved = vi.fn()
    render(<WorkspaceAdmissionRulesTab workspace={mockWorkspace} onConfigSaved={onConfigSaved} />)

    // 添加新扩展名以产生修改 (dirty)
    const input = screen.getByPlaceholderText(
      '输入扩展名（如 png 或 .docx，回车添加，支持逗号分隔）'
    )
    fireEvent.change(input, { target: { value: 'docx' } })
    fireEvent.click(screen.getByText('添加'))

    // 出现保存按钮
    const saveBtn = await screen.findByText('保存准入规则与包含模式')
    expect(saveBtn).toBeDefined()

    fireEvent.click(saveBtn)

    await waitFor(() => {
      expect(mockUpdateWorkspaceWhitelist).toHaveBeenCalledWith(
        mockWorkspace.id,
        expect.arrayContaining(['.cr3', '.arw', '.docx'])
      )
      expect(onConfigSaved).toHaveBeenCalled()
    })
  })

  it('实时测算与展示预期纳入与排除比例', async () => {
    render(<WorkspaceAdmissionRulesTab workspace={mockWorkspace} />)

    await waitFor(() => {
      expect(mockPreviewWorkspaceWhitelistImpact).toHaveBeenCalledWith(1, ['.cr3', '.arw'])
    })

    await waitFor(() => {
      expect(screen.getByText('预期影响测算')).toBeDefined()
      expect(screen.getByText('预计纳入: 75%')).toBeDefined()
      expect(screen.getByText('预计排除: 25%')).toBeDefined()
    })
  })
})
