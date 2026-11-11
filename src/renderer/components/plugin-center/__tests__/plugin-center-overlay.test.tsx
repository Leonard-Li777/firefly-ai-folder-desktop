// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'

// Mock 语言包
vi.mock('@app/languages', () => ({
  t: (str: string, vars?: any) => {
    if (!vars) return str
    let res = str
    for (const [k, v] of Object.entries(vars)) {
      res = res.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
    }
    return res
  },
  default: {}
}))

vi.mock('@voerkai18n/react', () => ({
  useVoerkaI18n: () => ({
    t: (str: string, vars?: any) => {
      if (!vars) return str
      let res = str
      for (const [k, v] of Object.entries(vars)) {
        res = res.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
      }
      return res
    }
  })
}))

// Mock 子设置组件，加速渲染并隔离复杂依赖
vi.mock('../../settings/ai-engine-config-settings', () => ({
  AIEngineConfigSettings: () => (
    <div data-testid="mock-ai-engine-settings">AI Engine Settings Mock</div>
  )
}))

vi.mock('../../settings/tts-settings', () => ({
  TTSSettings: () => <div data-testid="mock-tts-settings">TTS Settings Mock</div>
}))

import { PluginCenterOverlay } from '../PluginCenterOverlay'
import {
  usePluginCenterStore,
  formatPluginErrorMessage,
  getPluginErrorMessages,
  type EnvironmentVisibilityEnvelope
} from '../../../stores/plugin-center-store'

describe('Ticket 08: 插件中心环境可见性、时钟防护与大白话排障测试套件', () => {
  beforeEach(() => {
    usePluginCenterStore.getState().resetForTest()
  })

  describe('一、三态环境可见性铁律 (3-State Environment Visibility Invariant)', () => {
    it('1. 普通用户生产态 (isDev=false, isEnterpriseOffline=false): 开发者开关、导入按钮、导出按钮均物理不渲染在 DOM 中', async () => {
      const prodEnvelope: EnvironmentVisibilityEnvelope = {
        epoch: 'epoch-1',
        revision: 1,
        visibility: {
          isDev: false,
          isEnterpriseOffline: false,
          developerModeEnabled: false,
          allowDeveloperMode: false,
          allowLocalPluginImport: false,
          allowOfflineImport: false,
          allowOfflineExport: false
        }
      }

      act(() => {
        usePluginCenterStore.setState({
          isOverlayOpen: true,
          environmentVisibility: prodEnvelope
        })
      })

      render(<PluginCenterOverlay />)

      // 验证开发者模式开关彻底不渲染
      expect(screen.queryByTestId('dev-mode-switch')).not.toBeInTheDocument()
      // 验证导入离线包按钮彻底不渲染
      expect(screen.queryByTestId('import-offline-plugin-btn')).not.toBeInTheDocument()
      // 验证导出按钮彻底不渲染
      expect(screen.queryByTestId('export-offline-plugin-btn')).not.toBeInTheDocument()
      expect(screen.queryByTestId('export-offline-bundle-btn')).not.toBeInTheDocument()
      // 验证本地开发插件导入彻底不渲染
      expect(screen.queryByTestId('pick-local-plugin-btn')).not.toBeInTheDocument()
    })

    it('2. 企业离线专享态 (isDev=false, isEnterpriseOffline=true): 仅渲染「导入离线包」按钮，开关与导出均不渲染', async () => {
      const enterpriseEnvelope: EnvironmentVisibilityEnvelope = {
        epoch: 'epoch-1',
        revision: 2,
        visibility: {
          isDev: false,
          isEnterpriseOffline: true,
          developerModeEnabled: false,
          allowDeveloperMode: false,
          allowLocalPluginImport: false,
          allowOfflineImport: true,
          allowOfflineExport: false
        }
      }

      act(() => {
        usePluginCenterStore.setState({
          isOverlayOpen: true,
          environmentVisibility: enterpriseEnvelope
        })
      })

      render(<PluginCenterOverlay />)

      // 验证开发者开关与导出按钮物理不渲染
      expect(screen.queryByTestId('dev-mode-switch')).not.toBeInTheDocument()
      expect(screen.queryByTestId('export-offline-plugin-btn')).not.toBeInTheDocument()
      expect(screen.queryByTestId('export-offline-bundle-btn')).not.toBeInTheDocument()
      expect(screen.queryByTestId('pick-local-plugin-btn')).not.toBeInTheDocument()

      // 验证仅导入离线包按钮渲染并在 DOM 中可用
      const importBtn = screen.getByTestId('import-offline-plugin-btn')
      expect(importBtn).toBeInTheDocument()
      expect(importBtn).toHaveTextContent('导入离线包')
    })

    it('3. 开发者模式调试态 (isDev=true): 完整渲染开发者开关、导入离线包、导出插件包与导出总包按钮', async () => {
      const devEnvelope: EnvironmentVisibilityEnvelope = {
        epoch: 'epoch-1',
        revision: 3,
        visibility: {
          isDev: true,
          isEnterpriseOffline: false,
          developerModeEnabled: true,
          allowDeveloperMode: true,
          allowLocalPluginImport: true,
          allowOfflineImport: true,
          allowOfflineExport: true
        }
      }

      act(() => {
        usePluginCenterStore.setState({
          isOverlayOpen: true,
          isDeveloperMode: true,
          environmentVisibility: devEnvelope
        })
      })

      render(<PluginCenterOverlay />)

      // 验证开发者模式开关存在且为选中态
      const devSwitch = screen.getByTestId('dev-mode-switch')
      expect(devSwitch).toBeInTheDocument()
      expect(devSwitch).toBeChecked()

      // 验证导入离线包按钮存在
      expect(screen.getByTestId('import-offline-plugin-btn')).toBeInTheDocument()
      // 验证本地插件导入按钮存在
      expect(screen.getByTestId('pick-local-plugin-btn')).toBeInTheDocument()
      // 验证导出单包与导出总包按钮均存在
      expect(screen.getByTestId('export-offline-plugin-btn')).toBeInTheDocument()
      expect(screen.getByTestId('export-offline-bundle-btn')).toBeInTheDocument()
    })
  })

  describe('二、双锚定时钟防护 (Dual-Anchor Clock Guard)', () => {
    it('在同一 epoch 内，递增 revision 正常采纳并更新状态', () => {
      const store = usePluginCenterStore.getState()
      const env1: EnvironmentVisibilityEnvelope = {
        epoch: 'epoch-alpha',
        revision: 10,
        visibility: {
          isDev: false,
          isEnterpriseOffline: false,
          developerModeEnabled: false,
          allowDeveloperMode: false,
          allowLocalPluginImport: false,
          allowOfflineImport: false,
          allowOfflineExport: false
        }
      }

      const accepted1 = store.applyVisibilityEnvelope(env1)
      expect(accepted1).toBe(true)
      expect(usePluginCenterStore.getState().environmentVisibility?.revision).toBe(10)

      const env2: EnvironmentVisibilityEnvelope = {
        epoch: 'epoch-alpha',
        revision: 11,
        visibility: {
          isDev: true,
          isEnterpriseOffline: false,
          developerModeEnabled: true,
          allowDeveloperMode: true,
          allowLocalPluginImport: true,
          allowOfflineImport: true,
          allowOfflineExport: true
        }
      }

      const accepted2 = store.applyVisibilityEnvelope(env2)
      expect(accepted2).toBe(true)
      expect(usePluginCenterStore.getState().environmentVisibility?.revision).toBe(11)
      expect(usePluginCenterStore.getState().isDeveloperMode).toBe(true)
    })

    it('同一 epoch 内，迟到的旧 revision (倒流) 被严格拦截丢弃，不发生状态覆盖', () => {
      const store = usePluginCenterStore.getState()
      const latestEnv: EnvironmentVisibilityEnvelope = {
        epoch: 'epoch-alpha',
        revision: 20,
        visibility: {
          isDev: true,
          isEnterpriseOffline: false,
          developerModeEnabled: true,
          allowDeveloperMode: true,
          allowLocalPluginImport: true,
          allowOfflineImport: true,
          allowOfflineExport: true
        }
      }

      store.applyVisibilityEnvelope(latestEnv)
      expect(usePluginCenterStore.getState().environmentVisibility?.revision).toBe(20)

      // 模拟迟到的旧信封 (revision=15 <= 20)
      const staleEnv: EnvironmentVisibilityEnvelope = {
        epoch: 'epoch-alpha',
        revision: 15,
        visibility: {
          isDev: false,
          isEnterpriseOffline: false,
          developerModeEnabled: false,
          allowDeveloperMode: false,
          allowLocalPluginImport: false,
          allowOfflineImport: false,
          allowOfflineExport: false
        }
      }

      const accepted = store.applyVisibilityEnvelope(staleEnv)
      expect(accepted).toBe(false)
      // 状态保持 revision 20，未被倒流污染
      expect(usePluginCenterStore.getState().environmentVisibility?.revision).toBe(20)
      expect(usePluginCenterStore.getState().isDeveloperMode).toBe(true)
    })

    it('跨 epoch（冷启动重置）时，即使新 revision 较小也无条件立即采纳', () => {
      const store = usePluginCenterStore.getState()
      const oldEpochEnv: EnvironmentVisibilityEnvelope = {
        epoch: 'epoch-old',
        revision: 999,
        visibility: {
          isDev: true,
          isEnterpriseOffline: false,
          developerModeEnabled: true,
          allowDeveloperMode: true,
          allowLocalPluginImport: true,
          allowOfflineImport: true,
          allowOfflineExport: true
        }
      }

      store.applyVisibilityEnvelope(oldEpochEnv)
      expect(usePluginCenterStore.getState().environmentVisibility?.epoch).toBe('epoch-old')

      // 系统重启，新 epoch 开启，revision 从 1 开始
      const newEpochEnv: EnvironmentVisibilityEnvelope = {
        epoch: 'epoch-new',
        revision: 1,
        visibility: {
          isDev: false,
          isEnterpriseOffline: true,
          developerModeEnabled: false,
          allowDeveloperMode: false,
          allowLocalPluginImport: false,
          allowOfflineImport: true,
          allowOfflineExport: false
        }
      }

      const accepted = store.applyVisibilityEnvelope(newEpochEnv)
      expect(accepted).toBe(true)
      expect(usePluginCenterStore.getState().environmentVisibility?.epoch).toBe('epoch-new')
      expect(usePluginCenterStore.getState().environmentVisibility?.revision).toBe(1)
      expect(usePluginCenterStore.getState().isDeveloperMode).toBe(false)
    })
  })

  describe('三、导出离线总包交互与 loading 状态管理', () => {
    it('点击「导出离线总包」按钮调用 exportOfflineBundle 并管理等待加载态', async () => {
      let resolveExport!: (val: string | null) => void
      const exportPromise = new Promise<string | null>(res => {
        resolveExport = res
      })

      const devEnvelope: EnvironmentVisibilityEnvelope = {
        epoch: 'epoch-1',
        revision: 1,
        visibility: {
          isDev: true,
          isEnterpriseOffline: false,
          developerModeEnabled: true,
          allowDeveloperMode: true,
          allowLocalPluginImport: true,
          allowOfflineImport: true,
          allowOfflineExport: true
        }
      }

      const mockExportOfflineBundle = vi.fn().mockImplementation(() => exportPromise)

      act(() => {
        usePluginCenterStore.setState({
          isOverlayOpen: true,
          isDeveloperMode: true,
          environmentVisibility: devEnvelope,
          exportOfflineBundle: mockExportOfflineBundle
        })
      })

      render(<PluginCenterOverlay />)

      const bundleBtn = screen.getByTestId('export-offline-bundle-btn')
      expect(bundleBtn).toBeInTheDocument()
      expect(bundleBtn).not.toBeDisabled()

      // 点击导出总包
      await act(async () => {
        fireEvent.click(bundleBtn)
      })

      expect(mockExportOfflineBundle).toHaveBeenCalled()
      // 模拟进入导出中状态
      act(() => {
        usePluginCenterStore.setState({ isExportingBundle: true })
      })

      expect(bundleBtn).toBeDisabled()
      expect(screen.getByText('正在导出总包...')).toBeInTheDocument()

      // 完成导出
      await act(async () => {
        resolveExport('C:\\path\\bundle.ffp')
        usePluginCenterStore.setState({ isExportingBundle: false })
      })

      expect(bundleBtn).not.toBeDisabled()
      expect(screen.getByText('导出离线总包')).toBeInTheDocument()
    })
  })

  describe('四、20+ 错误码大白话提示字典与黑话过滤 (Zero Jargon & Plain Language)', () => {
    it('覆盖全部 22 个标准错误码白名单映射', () => {
      const expectedCodes = [
        'SIGNATURE_INVALID',
        'ASSET_HASH_MISMATCH',
        'MODULE_ACTIVE_CONFLICT',
        'VERSION_CONFLICT',
        'RESOURCE_CONFLICT',
        'QUOTA_EXCEEDED',
        'ZIP_ENTRY_REJECTED',
        'JOB_SUPERSEDED',
        'RESOURCE_DIR_INVALID',
        'MANIFEST_INVALID',
        'MANIFEST_MISSING',
        'BUNDLE_EMPTY',
        'EXPORT_BUSY',
        'IMPORT_BUSY',
        'VERIFICATION_CRASH_LIMIT',
        'NETWORK_ERROR',
        'PERMISSION_DENIED',
        'UNSUPPORTED_ARCH',
        'CHECKSUM_FAILED',
        'DOWNLOAD_FAILED',
        'MODULE_NOT_FOUND',
        'UNKNOWN_ERROR'
      ]

      const messages = getPluginErrorMessages()
      for (const code of expectedCodes) {
        expect(messages[code]).toBeDefined()
        const formatted = formatPluginErrorMessage({ code })
        expect(formatted).toBe(messages[code])
        // 确保没有任何晦涩的底层技术黑话
        expect(formatted).not.toMatch(/ONNX|IPC|Token|Checksum|CRC32|SHA256|Ed25519/i)
      }
    })

    it('支持从复合异常消息文本中智能提取已知错误码', () => {
      const err = new Error('Verification failed with code [SIGNATURE_INVALID]: signature rejected')
      const msg = formatPluginErrorMessage(err)
      expect(msg).toBe(getPluginErrorMessages().SIGNATURE_INVALID)
    })

    it('将系统原生 IO 错误 (EBUSY / EACCES / ENOSPC / 网络异常) 转换为通俗大白话', () => {
      expect(formatPluginErrorMessage(new Error('EBUSY: resource busy or locked'))).toBe(
        '文件正在被其他程序占用，请关闭相关应用后重试。'
      )
      expect(formatPluginErrorMessage(new Error('EACCES: permission denied, open'))).toBe(
        getPluginErrorMessages().PERMISSION_DENIED
      )
      expect(formatPluginErrorMessage(new Error('ENOSPC: no space left on device'))).toBe(
        getPluginErrorMessages().QUOTA_EXCEEDED
      )
      expect(formatPluginErrorMessage(new Error('fetch failed ECONNRESET'))).toBe(
        getPluginErrorMessages().NETWORK_ERROR
      )
    })

    it('对包含底层工程黑话的未知异常进行安全过滤，避免黑话堆栈裸露给用户', () => {
      const technicalError = new Error('ONNX runtime execution error in IPC channel')
      const sanitized = formatPluginErrorMessage(technicalError)
      // 确认专业术语已全部剔除
      expect(sanitized).not.toContain('ONNX')
      expect(sanitized).not.toContain('IPC')
    })
  })
})
