// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { FileAdmissionNoticeBar } from '../components/FileAdmissionNoticeBar'
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
  t: (key: string) => key,
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

describe('FileAdmissionNoticeBar 公共吸底提示条组件与 FileList 集成', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()

    global.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as any

    window.electronAPI = {
      getAnalysisQueue: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      utils: {
        isPathEqual: (a: string, b: string) =>
          a.replace(/[\\/]+/g, '/').toLowerCase() === b.replace(/[\\/]+/g, '/').toLowerCase(),
        normalizeForCache: (p: string) => p.toLowerCase(),
        stripTrailingSlash: (p: string) => p.replace(/[\\/]+$/, ''),
        isSubPath: (parent: string, child: string) =>
          child.replace(/[\\/]+/g, '/').toLowerCase().startsWith(parent.replace(/[\\/]+/g, '/').toLowerCase()),
        getPlatform: () => 'win32'
      }
    } as any
  })

  describe('公共组件单元测试', () => {
    it('当 visible 为 true 且未关闭时，正常渲染提示文案与操作按钮', () => {
      const handleOpen = vi.fn()
      render(
        <FileAdmissionNoticeBar
          visible={true}
          workspaceId={101}
          onOpenAdmissionRules={handleOpen}
        />
      )

      expect(screen.getByTestId('file-admission-notice-bar')).toBeInTheDocument()
      expect(screen.getByText('我的文件不在列表中？试试修改')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /文件准入与包含规则/ })).toBeInTheDocument()
      expect(screen.getByText('知道了')).toBeInTheDocument()
      expect(screen.getByLabelText('关闭')).toBeInTheDocument()
    })

    it('点击“文件准入与包含规则”触发 onOpenAdmissionRules 回调', () => {
      const handleOpen = vi.fn()
      render(
        <FileAdmissionNoticeBar
          visible={true}
          workspaceId={101}
          onOpenAdmissionRules={handleOpen}
        />
      )

      fireEvent.click(screen.getByRole('button', { name: /文件准入与包含规则/ }))
      expect(handleOpen).toHaveBeenCalledTimes(1)
    })

    it('点击“知道了”后隐藏提示条，并在 localStorage 中记录关闭状态，重新渲染不再出现', () => {
      const handleOpen = vi.fn()
      const { rerender } = render(
        <FileAdmissionNoticeBar
          visible={true}
          workspaceId={101}
          onOpenAdmissionRules={handleOpen}
        />
      )

      fireEvent.click(screen.getByText('知道了'))
      expect(screen.queryByTestId('file-admission-notice-bar')).not.toBeInTheDocument()
      expect(localStorage.getItem('firefly_dismiss_file_admission_notice_banner')).toBe('true')

      // 重新渲染同一组件或切换工作区时依然保持隐藏，不再反复出现
      rerender(
        <FileAdmissionNoticeBar
          visible={true}
          workspaceId={102}
          onOpenAdmissionRules={handleOpen}
        />
      )
      expect(screen.queryByTestId('file-admission-notice-bar')).not.toBeInTheDocument()
    })

    it('点击关闭图标 X 后隐藏提示条并在 localStorage 中全局记录关闭状态', () => {
      const handleOpen = vi.fn()
      render(
        <FileAdmissionNoticeBar
          visible={true}
          workspaceId={102}
          onOpenAdmissionRules={handleOpen}
        />
      )

      fireEvent.click(screen.getByLabelText('关闭'))
      expect(screen.queryByTestId('file-admission-notice-bar')).not.toBeInTheDocument()
      expect(localStorage.getItem('firefly_dismiss_file_admission_notice_banner')).toBe('true')
    })

    it('初始状态若已记录关闭，则首屏直接不渲染', () => {
      localStorage.setItem('firefly_dismiss_file_admission_notice_banner', 'true')
      render(
        <FileAdmissionNoticeBar
          visible={true}
          workspaceId={101}
          onOpenAdmissionRules={vi.fn()}
        />
      )
      expect(screen.queryByTestId('file-admission-notice-bar')).not.toBeInTheDocument()
    })

    it('当 visible 为 false 时完全不渲染', () => {
      render(
        <FileAdmissionNoticeBar
          visible={false}
          workspaceId={103}
          onOpenAdmissionRules={vi.fn()}
        />
      )
      expect(screen.queryByTestId('file-admission-notice-bar')).not.toBeInTheDocument()
    })
  })

  describe('FileList 页面吸底集成测试', () => {
    it('真实物理目录下 FileList 吸底渲染该提示条，点击能正确跳转到工作区设置的 ignore_rules Tab', () => {
      const openSettingsSpy = vi.spyOn(useSettingsStore.getState(), 'openWorkspaceSettings')

      useVirtualDirectoryStore.setState({
        workspaceDirectories: [
          {
            id: 88,
            workspace_id: 88,
            path: 'D:\\Projects\\PhotoGallery',
            name: 'PhotoGallery',
            type: 'SPEEDY',
            recursive: true,
            isActive: true,
            workspace_config: JSON.stringify({ schemaVersion: 1, status: 'ready' })
          } as any
        ],
        currentWorkspaceDirectory: {
          id: 88,
          path: 'D:\\Projects\\PhotoGallery'
        } as any
      })

      render(
        <FileList
          files={[
            {
              id: 'file-1',
              name: 'cover.jpg',
              path: 'D:\\Projects\\PhotoGallery\\cover.jpg',
              size: 1024,
              extension: 'jpg',
              isAnalyzed: true
            } as any
          ]}
          directories={[]}
          selectedFiles={[]}
          activeItem={null}
          onFileSelect={vi.fn()}
          onFileDoubleClick={vi.fn()}
          onDirectoryChange={vi.fn()}
          isRealDirectory={true}
          currentPath="D:\\Projects\\PhotoGallery"
          workspaceDirectoryPath="D:\\Projects\\PhotoGallery"
          viewMode="list"
        />
      )

      const noticeBar = screen.getByTestId('file-admission-notice-bar')
      expect(noticeBar).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: /文件准入与包含规则/ }))
      expect(openSettingsSpy).toHaveBeenCalledWith({
        workspaceId: 88,
        targetTab: 'ignore_rules'
      })
    })

    it('非真实物理目录（如虚拟目录或搜索视图）下，提示条绝不渲染', () => {
      render(
        <FileList
          files={[
            {
              id: 'file-2',
              name: 'document.pdf',
              path: 'D:\\Projects\\PhotoGallery\\document.pdf',
              size: 2048,
              extension: 'pdf',
              isAnalyzed: true
            } as any
          ]}
          directories={[]}
          selectedFiles={[]}
          activeItem={null}
          onFileSelect={vi.fn()}
          onFileDoubleClick={vi.fn()}
          onDirectoryChange={vi.fn()}
          isRealDirectory={false}
          currentPath="virtual://tags/work"
          viewMode="list"
        />
      )

      expect(screen.queryByTestId('file-admission-notice-bar')).not.toBeInTheDocument()
    })
  })
})
