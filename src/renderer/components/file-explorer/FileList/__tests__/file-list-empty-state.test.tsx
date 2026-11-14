// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { FileList } from '../index'
import { useSettingsStore } from '../../../../stores/settings-store'
import { useVirtualDirectoryStore } from '../../../../stores/virtual-directory-store'

// Mock react-router-dom
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: '/' })
}))

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

describe('FileList 真实目录空状态与包含规则排障提示', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    global.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as any
    window.electronAPI = {
      getAnalysisQueue: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      utils: {
        isPathEqual: (a: string, b: string) => a.replace(/[\\/]+/g, '/').toLowerCase() === b.replace(/[\\/]+/g, '/').toLowerCase(),
        normalizeForCache: (p: string) => p.toLowerCase(),
        stripTrailingSlash: (p: string) => p.replace(/[\\/]+$/, ''),
        isSubPath: (parent: string, child: string) => child.replace(/[\\/]+/g, '/').toLowerCase().startsWith(parent.replace(/[\\/]+/g, '/').toLowerCase()),
        getPlatform: () => 'win32'
      }
    } as any
  })

  it('真实物理目录在无包含规则且文件为空时，正确展示「目录为空」EmptyState', () => {
    useVirtualDirectoryStore.setState({
      workspaceDirectories: [
        {
          id: 1,
          workspace_id: 1,
          path: 'G:\\person\\H\\小说',
          name: '小说',
          type: 'SPEEDY',
          recursive: true,
          isActive: true,
          workspace_config: JSON.stringify({
            schemaVersion: 1,
            status: 'ready',
            customIncludeRules: []
          })
        } as any
      ],
      currentWorkspaceDirectory: {
        id: 1,
        path: 'G:\\person\\H\\小说'
      } as any
    })

    render(
      <FileList
        files={[]}
        directories={[]}
        selectedFiles={[]}
        activeItem={null}
        onFileSelect={vi.fn()}
        onFileDoubleClick={vi.fn()}
        onDirectoryChange={vi.fn()}
        isRealDirectory={true}
        currentPath="G:\\person\\H\\小说"
        workspaceDirectoryPath="G:\\person\\H\\小说"
        viewMode="list"
      />
    )

    // 断言能看到「目录为空」提示
    expect(screen.getByText('目录为空')).toBeDefined()
  })

  it('真实物理目录在启用了包含规则且文件过滤为空时，正确展示排障提示及「立即查看文件准入与包含排除配置」按钮并能触发点击', () => {
    const openWorkspaceSettingsSpy = vi.fn()
    vi.spyOn(useSettingsStore.getState(), 'openWorkspaceSettings').mockImplementation(openWorkspaceSettingsSpy)

    useVirtualDirectoryStore.setState({
      workspaceDirectories: [
        {
          id: 2,
          workspace_id: 2,
          path: 'G:\\person\\H\\小说\\成人小说',
          name: '成人小说',
          type: 'SPEEDY',
          recursive: true,
          isActive: true,
          workspace_config: JSON.stringify({
            schemaVersion: 1,
            status: 'ready',
            customIncludeRules: [{ type: 'extension', value: '.docx' }]
          })
        } as any
      ],
      currentWorkspaceDirectory: {
        id: 2,
        path: 'G:\\person\\H\\小说\\成人小说'
      } as any
    })

    render(
      <FileList
        files={[]}
        directories={[]}
        selectedFiles={[]}
        activeItem={null}
        onFileSelect={vi.fn()}
        onFileDoubleClick={vi.fn()}
        onDirectoryChange={vi.fn()}
        isRealDirectory={true}
        currentPath="G:\\person\\H\\小说\\成人小说"
        workspaceDirectoryPath="G:\\person\\H\\小说\\成人小说"
        viewMode="list"
      />
    )

    // 断言能看到专属提示卡片与按钮
    expect(screen.getByText('当前没有可显示文件，是否错误设置了文件包含规则？')).toBeDefined()
    expect(screen.getByText('当前工作目录已启用文件包含白名单，非白名单内的文件已被自动隐藏。')).toBeDefined()
    
    const modifyBtn = screen.getByText('立即查看文件准入与包含排除配置')
    expect(modifyBtn).toBeDefined()

    // 点击「立即查看文件准入与包含排除配置」按钮
    fireEvent.click(modifyBtn)

    // 验证调用了工作目录设置打开 ignore_rules tab
    expect(openWorkspaceSettingsSpy).toHaveBeenCalledWith({
      workspaceId: 2,
      targetTab: 'ignore_rules'
    })
  })

  it('网格模式 (grid) 在文件为空时也能正确展示空状态提示', () => {
    useVirtualDirectoryStore.setState({
      workspaceDirectories: [
        {
          id: 3,
          workspace_id: 3,
          path: 'D:\\empty_dir',
          name: 'empty_dir',
          type: 'SPEEDY',
          recursive: true,
          isActive: true,
          workspace_config: JSON.stringify({
            schemaVersion: 1,
            status: 'ready',
            customIncludeRules: []
          })
        } as any
      ],
      currentWorkspaceDirectory: {
        id: 3,
        path: 'D:\\empty_dir'
      } as any
    })

    render(
      <FileList
        files={[]}
        directories={[]}
        selectedFiles={[]}
        activeItem={null}
        onFileSelect={vi.fn()}
        onFileDoubleClick={vi.fn()}
        onDirectoryChange={vi.fn()}
        isRealDirectory={true}
        currentPath="D:\\empty_dir"
        workspaceDirectoryPath="D:\\empty_dir"
        viewMode="grid"
      />
    )

    expect(screen.getByText('目录为空')).toBeDefined()
  })
})
