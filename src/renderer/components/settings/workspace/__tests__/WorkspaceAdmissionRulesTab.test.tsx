// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { WorkspaceAdmissionRulesTab } from '../WorkspaceAdmissionRulesTab'
import { useSettingsStore } from '../../../../stores/settings-store'
import { WorkspaceDirectory } from '@firefly/types'
import { toast } from '../../../common/Toast'

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

  // ready 态配置必须带齐 baseAIConfig 与两组规则数组，否则 parseWorkspaceConfig 会降级为 pending
  const workspaceWithDuplicates: WorkspaceDirectory = {
    ...mockWorkspace,
    workspace_config: JSON.stringify({
      schemaVersion: 1,
      status: 'ready',
      baseAIConfig: {},
      customWhitelistRules: [],
      customIgnoreRules: [
        {
          id: 'dup-1',
          type: 'directory',
          value: 'node_modules',
          isActive: true,
          isSystem: false
        },
        { id: 'own-1', type: 'directory', value: 'temp', isActive: true, isSystem: false }
      ]
    })
  }

  it('AC 3: 醒目渲染绿色物理安全防护徽标与铁律提示', () => {
    render(<WorkspaceAdmissionRulesTab workspace={mockStandardWorkspace} />)

    expect(screen.getByText('绝不删除用户磁盘物理文件')).toBeDefined()
    expect(
      screen.getByText(
        '修改包含与排除规则仅影响真实目录中显示的文件，不会触碰您电脑磁盘中的任何原始物理文件。'
      )
    ).toBeDefined()
  })

  it('AC 1: 包含规则与排除规则常驻可同时设置，不存在互斥的文件入场模式', () => {
    render(<WorkspaceAdmissionRulesTab workspace={mockStandardWorkspace} />)

    // 规格已废除 filterMode 二选一互斥模式：面板不得再出现任何模式切换入口
    expect(screen.queryByText('文件入场模式')).toBeNull()
    expect(screen.queryByText('标准模式 (全量入场)')).toBeNull()
    expect(screen.queryByText('排他包含模式 (仅放行指定格式)')).toBeNull()

    // 即使包含规则为空，两套规则编辑区仍然常驻且同时可见
    expect(screen.getByText('文件准入规则 (可同时设置)')).toBeDefined()
    expect(screen.getByText('包含 + 排除叠加生效')).toBeDefined()
    expect(screen.getByText('目录专属包含规则')).toBeDefined()
    expect(screen.getByText('常用类型快速选用')).toBeDefined()
    expect(screen.getByText('目录专属排除规则')).toBeDefined()
    expect(screen.getByText('添加排除项')).toBeDefined()
  })

  it('回归: 包含规则为空时仍可直接添加扩展名，保存按实际配置写入而不被清空', async () => {
    const onConfigSaved = vi.fn()
    render(
      <WorkspaceAdmissionRulesTab workspace={mockStandardWorkspace} onConfigSaved={onConfigSaved} />
    )

    const input = screen.getByPlaceholderText(
      '输入扩展名（如 png 或 .docx，回车添加，支持逗号分隔）'
    )
    fireEvent.change(input, { target: { value: 'CR3' } })
    fireEvent.click(screen.getByText('添加'))

    expect(screen.getByTestId('whitelist-tag-.cr3')).toBeDefined()

    const saveBtn = await screen.findByText('保存包含与排除规则')
    fireEvent.click(saveBtn)

    await waitFor(() => {
      expect(mockUpdateWorkspaceWhitelist).toHaveBeenCalledWith(mockStandardWorkspace.id, ['.cr3'])
      expect(onConfigSaved).toHaveBeenCalled()
    })
    expect(mockUpdateWorkspaceWhitelist).not.toHaveBeenCalledWith(mockStandardWorkspace.id, [])
  })

  it('回归: 两套规则可同时操作，空包含规则时仍按叠加顺序测算与放行说明', async () => {
    render(<WorkspaceAdmissionRulesTab workspace={mockStandardWorkspace} />)

    // 空包含规则也照常发起测算（不再因「标准模式」跳过或强制按 100% 展示）
    await waitFor(() => {
      expect(mockPreviewWorkspaceWhitelistImpact).toHaveBeenCalledWith(mockStandardWorkspace.id, [])
    })
    expect(screen.getByText('包含规则留空：按排除规则放行其余文件')).toBeDefined()

    // 包含规则区与排除规则区互不排斥，可同时编辑
    expect(screen.getByText('目录专属包含规则')).toBeDefined()
    fireEvent.click(screen.getByText('添加排除项'))
    expect(screen.getByText('新增目录排除规则')).toBeDefined()
    expect(
      screen.getByPlaceholderText('输入扩展名（如 png 或 .docx，回车添加，支持逗号分隔）')
    ).toBeDefined()
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
    const saveBtn = await screen.findByText('保存包含与排除规则')
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
      expect(
        screen.getByText(/基于已扫描文件库（共 100 个文件），预期将精准纳入 75 个目标格式文件/)
      ).toBeDefined()
    })
  })

  it('基于物理抽样探测时正确展示基于当前目录嗅探文案', async () => {
    mockPreviewWorkspaceWhitelistImpact.mockResolvedValueOnce({
      success: true,
      totalFiles: 180,
      includedFiles: 35,
      excludedFiles: 145,
      isSampled: true
    })

    render(<WorkspaceAdmissionRulesTab workspace={mockWorkspace} />)

    await waitFor(() => {
      expect(
        screen.getByText(/基于当前目录嗅探（共 180 个文件），预期将精准纳入 35 个目标格式文件/)
      ).toBeDefined()
    })
  })

  it('目录专属黑名单自动剔除全局排除规则中已配置的项', () => {
    render(<WorkspaceAdmissionRulesTab workspace={workspaceWithDuplicates} />)

    // 与全局重复的 node_modules 仅在下方只读基线中出现一次，专属列表不再重复展示
    expect(screen.getAllByText('node_modules')).toHaveLength(1)
    expect(screen.getByText('temp')).toBeDefined()
    expect(screen.getByText('(1)')).toBeDefined()
    expect(screen.getByText('已自动合并 1 项与全局规则重复的排除项，它们依然生效。')).toBeDefined()
  })

  it('新增与全局规则重复的排除项时提示用户且不写回工作区配置', async () => {
    render(<WorkspaceAdmissionRulesTab workspace={workspaceWithDuplicates} />)

    fireEvent.click(screen.getByText('添加排除项'))
    fireEvent.change(screen.getByPlaceholderText('build, dist, test_data'), {
      target: { value: 'node_modules' }
    })
    fireEvent.click(screen.getByText('保存排除规则'))

    await waitFor(() => {
      expect(toast.info).toHaveBeenCalledWith(
        '这项已经在全局规则里排除了，不需要在当前目录重复添加'
      )
    })
    expect(window.electronAPI.updateWorkspaceConfig).not.toHaveBeenCalled()
  })
})
