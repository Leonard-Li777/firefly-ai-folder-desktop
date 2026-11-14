// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { WorkspaceSettingsDialog } from '../WorkspaceSettingsDialog'
import { useSettingsStore } from '../../../stores/settings-store'
import { useVirtualDirectoryStore } from '../../../stores/virtual-directory-store'
import { usePluginCenterStore } from '../../../stores/plugin-center-store'
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
vi.mock('../../common/Toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn()
  }
}))

describe('WorkspaceSettingsDialog 美化确认对话框拦截测试 (无原生confirm)', () => {
  const mockWorkspace: WorkspaceDirectory = {
    id: 1,
    workspace_id: 1,
    path: 'D:/mock/desktop',
    name: 'desktop',
    type: 'SPEEDY',
    recursive: true,
    isActive: true,
    whitelist_patterns: [],
    workspace_config: JSON.stringify({
      schemaVersion: 1,
      status: 'ready',
      customExcludeRules: []
    })
  }

  const mockUpdateWorkspaceWhitelist = vi.fn().mockResolvedValue({ success: true })

  beforeEach(() => {
    vi.clearAllMocks()

    useSettingsStore.setState({
      isWorkspaceSettingsOpen: true,
      targetWorkspaceId: 1,
      targetWorkspaceTab: 'ignore_rules',
      ignoreRules: []
    })

    useVirtualDirectoryStore.setState({
      workspaceDirectories: [mockWorkspace],
      currentWorkspaceDirectory: mockWorkspace
    })

    usePluginCenterStore.setState({
      modules: []
    })

    window.electronAPI = {
      updateWorkspaceWhitelist: mockUpdateWorkspaceWhitelist,
      previewWorkspaceWhitelistImpact: vi.fn().mockResolvedValue({
        success: true,
        totalFiles: 10,
        includedFiles: 5,
        excludedFiles: 5,
        isSampled: false
      }),
      getAllWorkspaceDirectories: vi.fn().mockResolvedValue([mockWorkspace]),
      getHardwareInfo: vi.fn().mockResolvedValue(null)
    } as any
  })

  it('规则修改未保存时关闭弹窗，拦截并弹出系统中美化的 React 确认对话框，严禁调用系统原生 confirm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm')

    render(<WorkspaceSettingsDialog />)

    // 直达文件准入与包含规则 Tab
    const input = await screen.findByPlaceholderText(
      '输入扩展名（如 png 或 .docx，回车添加，支持逗号分隔）'
    )
    fireEvent.change(input, { target: { value: 'docx' } })
    fireEvent.click(screen.getByText('添加'))

    // 确认右上角出现「保存包含与排除规则」
    expect(await screen.findByText('保存包含与排除规则')).toBeDefined()

    // 此时用户没有点击保存，而是直接点击弹窗关闭按钮 (触发 Dialog onOpenChange)
    // 模拟触发 Dialog 试图关闭：点击取消或遮罩
    const closeSettings = useSettingsStore.getState().closeWorkspaceSettings
    // 监听 closeSettings 调用
    const closeSpy = vi.spyOn(useSettingsStore.getState(), 'closeWorkspaceSettings')

    // 点击切换 Tab 触发离开拦截
    const aiEngineTabBtn = screen.getAllByText('检索式引擎')[0]
    fireEvent.click(aiEngineTabBtn)

    // 美化的 React 确认对话框弹出
    const confirmDialog = await screen.findByTestId('unsaved-admission-rules-dialog')
    expect(confirmDialog).toBeDefined()
    expect(screen.getByText('文件准入与包含规则已修改，是否保存？')).toBeDefined()

    // 绝对未调用系统原生 confirm
    expect(confirmSpy).not.toHaveBeenCalled()

    // 点击美化对话框里的【保存并继续】
    const saveBtn = screen.getByTestId('unsaved-confirm-save-btn')
    fireEvent.click(saveBtn)

    await waitFor(() => {
      expect(mockUpdateWorkspaceWhitelist).toHaveBeenCalledWith(1, ['.docx'])
      // 成功切换到「检索式引擎」
      expect(screen.queryByTestId('unsaved-admission-rules-dialog')).toBeNull()
    })

    confirmSpy.mockRestore()
    closeSpy.mockRestore()
  })

  it('美化确认对话框中点击【不保存】，丢弃改动并继续离开', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm')

    render(<WorkspaceSettingsDialog />)

    const input = await screen.findByPlaceholderText(
      '输入扩展名（如 png 或 .docx，回车添加，支持逗号分隔）'
    )
    fireEvent.change(input, { target: { value: 'xlsx' } })
    fireEvent.click(screen.getByText('添加'))

    expect(await screen.findByText('保存包含与排除规则')).toBeDefined()

    // 点击切换 Tab
    const aiEngineTabBtn = screen.getAllByText('检索式引擎')[0]
    fireEvent.click(aiEngineTabBtn)

    // 弹出美化对话框
    await screen.findByTestId('unsaved-admission-rules-dialog')

    // 点击【不保存】
    const discardBtn = screen.getByTestId('unsaved-confirm-discard-btn')
    fireEvent.click(discardBtn)

    await waitFor(() => {
      // 对话框关闭
      expect(screen.queryByTestId('unsaved-admission-rules-dialog')).toBeNull()
    })

    // 未调用保存接口
    expect(mockUpdateWorkspaceWhitelist).not.toHaveBeenCalled()
    expect(confirmSpy).not.toHaveBeenCalled()

    confirmSpy.mockRestore()
  })

  it('美化确认对话框中点击【取消】，关闭对话框并留在当前规则编辑页面', async () => {
    render(<WorkspaceSettingsDialog />)

    const input = await screen.findByPlaceholderText(
      '输入扩展名（如 png 或 .docx，回车添加，支持逗号分隔）'
    )
    fireEvent.change(input, { target: { value: 'pptx' } })
    fireEvent.click(screen.getByText('添加'))

    expect(await screen.findByText('保存包含与排除规则')).toBeDefined()

    // 触发离开
    const aiEngineTabBtn = screen.getAllByText('检索式引擎')[0]
    fireEvent.click(aiEngineTabBtn)

    await screen.findByTestId('unsaved-admission-rules-dialog')

    // 点击【取消】
    const cancelBtn = screen.getByTestId('unsaved-confirm-cancel-btn')
    fireEvent.click(cancelBtn)

    await waitFor(() => {
      expect(screen.queryByTestId('unsaved-admission-rules-dialog')).toBeNull()
    })

    // 依然停留在当前页面，右上角的保存按钮依然在
    expect(screen.getByText('保存包含与排除规则')).toBeDefined()
    expect(mockUpdateWorkspaceWhitelist).not.toHaveBeenCalled()
  })
})
