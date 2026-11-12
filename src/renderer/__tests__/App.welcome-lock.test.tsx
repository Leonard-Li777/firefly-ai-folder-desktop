// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// Mock 样式与重型子组件，仅验证 App 启动阶段门控与授权弹层隔离逻辑
vi.mock('../material-icons.css', () => ({}))
vi.mock('../styles.css', () => ({}))

vi.mock('@firefly/shared', () => ({
  LogCategory: { RENDERER: 'renderer' },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

vi.mock('@app/languages', () => ({
  t: (str: string) => str,
  i18nScope: { changeLanguage: vi.fn().mockResolvedValue(undefined) }
}))

vi.mock('../lib/utils', () => ({
  cn: (...args: any[]) => args.filter(Boolean).join(' ')
}))

vi.mock('../components/welcome/WelcomeWizard', () => ({
  WelcomeWizard: ({ initialStep = 1, onComplete }: any) => (
    <div data-testid="welcome-wizard" data-initial-step={String(initialStep)}>
      <span>欢迎向导 Step {initialStep}</span>
      <button type="button" onClick={onComplete}>
        完成欢迎向导
      </button>
    </div>
  )
}))

vi.mock('../components/license/LicenseGateway', () => ({
  LicenseGateway: ({ status }: any) => (
    <div data-testid="license-gateway">软件授权验证:{status}</div>
  )
}))

vi.mock('../components/common/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: any) => <>{children}</>
}))

vi.mock('../components/common/Toast', () => ({
  ToastContainer: () => null,
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
}))

vi.mock('../components/ai/AIServiceErrorDialog', () => ({
  AIServiceErrorDialog: () => null,
  useAIServiceErrorDialog: () => ({ isOpen: false, closeDialog: vi.fn() })
}))

vi.mock('../components/ai/AIClassificationHandler', () => ({ AIClassificationHandler: () => null }))
vi.mock('../components/analysis/AnalysisQueueModal', () => ({ AnalysisQueueModal: () => null }))
vi.mock('../components/analysis/QueueSplitPanel', () => ({ QueueSplitPanel: () => null }))
vi.mock('../components/analysis/QueueWindowPage', () => ({ QueueWindowPage: () => null }))
vi.mock('../components/analysis/ExtensionReconciliationDialog', () => ({ ExtensionReconciliationDialog: () => null }))
vi.mock('../components/analysis/AnalysisConfirmModal', () => ({ AnalysisConfirmModal: () => null }))
vi.mock('../components/common/Footer', () => ({ Footer: () => null }))
vi.mock('../components/file-explorer/RealDirectory', () => ({ RealDirectory: () => null }))
vi.mock('../components/settings', () => ({
  SystemSettingsDialog: () => null,
  WorkspaceSettingsDialog: () => null
}))
vi.mock('../components/file-explorer/AnalyzedDirectory/index', () => ({ AnalyzedDirectory: () => null }))
vi.mock('../components/file-explorer/VirtualDirectory/index', () => ({ VirtualDirectory: () => null }))
vi.mock('../components/file-explorer/PreviewOverlay', () => ({ PreviewOverlay: () => null }))
vi.mock('../components/file-explorer/SplitPreviewPanel', () => ({ SplitPreviewPanel: () => null }))
vi.mock('../components/file-explorer/Organize/index', () => ({ Organize: () => null }))
vi.mock('../components/file-explorer/GlobalSearchOverlay', () => ({ GlobalSearchOverlay: () => null }))
vi.mock('../components/plugin-center/PluginCenterOverlay', () => ({ PluginCenterOverlay: () => null }))
vi.mock('../components/tier/FirecoresRulesDialog', () => ({ FirecoresRulesDialog: () => null }))
vi.mock('../components/tier/UpgradeAccountDialog', () => ({ UpgradeAccountDialog: () => null }))
vi.mock('../components/tier/DeviceBindModal', () => ({ DeviceBindModal: () => null }))
vi.mock('../components/update/UpdateNotification', () => ({ UpdateNotification: () => null }))
vi.mock('../components/common/CrossRegionNoticeBanner', () => ({ CrossRegionNoticeBanner: () => null }))
vi.mock('../components/ui/theme-provider', () => ({ useTheme: () => ({ theme: 'light', setTheme: vi.fn() }) }))
vi.mock('../hooks/useInvitation', () => ({ useInvitation: () => {} }))

vi.mock('../stores/tier-store', () => ({
  useTierStore: Object.assign(
    () => ({
      isRulesOpen: false,
      rulesDefaultTab: 'rules',
      openRulesDialog: vi.fn(),
      closeRulesDialog: vi.fn(),
      isUpgradeOpen: false,
      openUpgradeDialog: vi.fn(),
      closeUpgradeDialog: vi.fn()
    }),
    {
      getState: () => ({
        tier: { plan: 'free' },
        isLoading: false,
        computed_limits: { can_offline: false },
        fetchProfile: vi.fn().mockResolvedValue(undefined)
      })
    }
  )
}))

vi.mock('../stores/virtual-directory-store', () => ({
  useVirtualDirectoryStore: Object.assign(
    (selector: any) => selector({ currentWorkspaceDirectory: '' }),
    {
      subscribe: vi.fn(() => () => {}),
      getState: () => ({
        workspaceDirectories: [],
        setWorkspaceDirectories: vi.fn(),
        setCurrentWorkspaceDirectory: vi.fn()
      })
    }
  )
}))
vi.mock('../stores/analyzed-directory-store', () => ({
  useAnalyzedDirectoryStore: Object.assign(() => ({}), {
    subscribe: vi.fn(() => () => {}),
    getState: () => ({
      workspaceDirectories: [],
      setWorkspaceDirectories: vi.fn()
    })
  })
}))
vi.mock('../stores/preview-overlay-store', () => ({
  usePreviewOverlayStore: () => ({ filePath: null })
}))
vi.mock('../stores/settings-store', () => ({
  useSettingsStore: Object.assign(() => ({}), {
    getState: () => ({
      updateConfig: vi.fn(),
      updateConfigValue: vi.fn().mockResolvedValue(true),
      openSettings: vi.fn()
    })
  })
}))
vi.mock('../stores/ai-service-store', () => ({
  useAIServiceInitialization: () => ({ initializeAIService: vi.fn().mockResolvedValue(undefined) })
}))
vi.mock('../stores/app-store', () => ({
  useAIModelStore: Object.assign(() => ({}), {
    getState: () => ({ setModelStatus: vi.fn() })
  })
}))
vi.mock('../stores/model-store', () => ({
  useModelStore: Object.assign(() => ({}), {
    getState: () => ({
      setServiceStatus: vi.fn(),
      setModelMode: vi.fn(),
      setModelName: vi.fn(),
      setProvider: vi.fn(),
      setVramRequiredGB: vi.fn(),
      setTotalSizeBytes: vi.fn()
    })
  })
}))

import App from '../App'

describe('App 离线欢迎向导强校验回归测试', () => {
  let unauthorizedHandlers: Array<(result: { status: string; error?: string }) => void>
  let reloadSpy: ReturnType<typeof vi.fn>
  let originalLocation: Location

  beforeEach(() => {
    unauthorizedHandlers = []
    localStorage.clear()
    localStorage.setItem('languageConfirmed', 'true')

    reloadSpy = vi.fn()
    originalLocation = window.location
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...originalLocation,
        reload: reloadSpy
      }
    })
  })

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation
    })
    vi.restoreAllMocks()
  })

  it('语言已确认但未安装基础引擎插件时，离线 license:unauthorized 不应 reload 或弹出软件授权验证取代欢迎向导', async () => {
    let installedModules: any[] = []

    ;(window as any).electronAPI = {
      getConfig: vi.fn().mockResolvedValue({
        languageConfirmed: true,
        isFirstRun: true,
        aiServiceMode: 'local'
      }),
      getStartupFlags: vi.fn().mockResolvedValue({ forceConfigStage: false }),
      modularResource: {
        list: vi.fn().mockImplementation(async () => installedModules)
      },
      license: {
        getStatus: vi.fn().mockResolvedValue({ status: 'OFFLINE_EXPIRED', error: '网络不可用' }),
        onUnauthorized: vi.fn((cb: (res: any) => void) => {
          unauthorizedHandlers.push(cb)
          return () => {}
        })
      }
    }

    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>
    )

    // 1. 强校验门禁必须直接锁定在 WelcomeWizard Step 2，且未渲染 LicenseGateway
    await waitFor(() => {
      const wizard = screen.getByTestId('welcome-wizard')
      expect(wizard.getAttribute('data-initial-step')).toBe('2')
    })
    expect(screen.queryByTestId('license-gateway')).toBeNull()

    // 2. 模拟离线后台广播 license:unauthorized 或 app:unauthorized 事件
    act(() => {
      for (const cb of unauthorizedHandlers) {
        cb({ status: 'OFFLINE_EXPIRED', error: '离线验证失败' })
      }
      window.dispatchEvent(
        new CustomEvent('app:unauthorized', { detail: { status: 'OFFLINE_EXPIRED' } })
      )
    })

    // 3. 严禁触发 window.location.reload()，且继续停留在欢迎向导，绝不被软件授权验证取代
    expect(reloadSpy).not.toHaveBeenCalled()
    expect(screen.getByTestId('welcome-wizard')).toBeDefined()
    expect(screen.queryByTestId('license-gateway')).toBeNull()

    // 4. 用户在 Step 2 安装完基础引擎并点击“完成欢迎向导”后，才允许进入后续离线授权验证弹层
    installedModules = [
      { id: 'engine_classic_light', capability_slot: 'base_embedding', install_state: 'active' }
    ]
    fireEvent.click(screen.getByText('完成欢迎向导'))

    await waitFor(() => {
      expect(screen.queryByTestId('welcome-wizard')).toBeNull()
      expect(screen.getByTestId('license-gateway')).toBeDefined()
    })
  })
})
