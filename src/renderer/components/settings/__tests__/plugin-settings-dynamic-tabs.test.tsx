// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'

// Mock 语言包
vi.mock('@app/languages', () => ({
  t: (str: string) => str,
  default: {}
}))

vi.mock('@voerkai18n/react', () => ({
  useVoerkaI18n: () => ({
    t: (str: string) => str
  })
}))

// Mock Electron API
const mockDialogShowMessageBox = vi.fn().mockResolvedValue({ response: 0 })
const mockClipboardWriteText = vi.fn()
vi.mock('electron', () => ({
  dialog: {
    showMessageBox: (...args: any[]) => mockDialogShowMessageBox(...args)
  },
  clipboard: {
    writeText: (...args: any[]) => mockClipboardWriteText(...args)
  },
  BrowserWindow: {
    getFocusedWindow: () => null,
    getAllWindows: () => []
  }
}))

import { SETTINGS_COMPONENT_MAP } from '../settings-component-map'
import {
  handleExecutableSecurityBlock,
  isSecurityBlockError
} from '../../../../electron/runtime-services/system/antivirus-guard'
import { useSettingsStore } from '../../../stores/settings-store'
import { usePluginCenterStore, type PluginModuleItem } from '../../../stores/plugin-center-store'
import { SystemSettingsDialog } from '../SystemSettingsDialog'
import { PluginCenterOverlay } from '../../plugin-center/PluginCenterOverlay'
import { SettingsCategory } from '@firefly/types'

describe('Ticket 05: 原生执行器免杀与设置声明式动态挂载测试', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    usePluginCenterStore.setState({
      modules: [],
      isOverlayOpen: false,
      configuringModuleId: null
    })
    useSettingsStore.setState({
      isSystemSettingsOpen: false,
      isWorkspaceSettingsOpen: false,
      isOpen: false,
      currentCategory: SettingsCategory.INTERFACE,
      targetWorkspaceTab: null
    })
  })

  describe('SETTINGS_COMPONENT_MAP 静态白名单注册表', () => {
    it('包含全部声明的设置组件且无动态代码求值', () => {
      expect(SETTINGS_COMPONENT_MAP.interface).toBeDefined()
      expect(SETTINGS_COMPONENT_MAP.ai_engine_config).toBeDefined()
      expect(SETTINGS_COMPONENT_MAP.tts).toBeDefined()
      expect(SETTINGS_COMPONENT_MAP.analysis_ignore_rules).toBeDefined()
      expect(SETTINGS_COMPONENT_MAP.basic_ai_engine).toBeDefined()
      expect(SETTINGS_COMPONENT_MAP.content_extraction).toBeDefined()
      expect(SETTINGS_COMPONENT_MAP.workspace_admission_rules).toBeDefined()
      expect(SETTINGS_COMPONENT_MAP.workspace_maintenance).toBeDefined()
    })
  })

  describe('杀软拦截防御 (Antivirus Security Guard)', () => {
    it('准确识别 EPERM 与 EACCES 权限拦截异常', () => {
      expect(isSecurityBlockError({ code: 'EPERM' })).toBe(true)
      expect(isSecurityBlockError({ code: 'EACCES' })).toBe(true)
      expect(isSecurityBlockError(new Error('spawn EPERM'))).toBe(true)
      expect(isSecurityBlockError(new Error('permission denied'))).toBe(true)
      expect(isSecurityBlockError(new Error('ENOENT: file not found'))).toBe(false)
    })

    it('拦截触发时弹出引导弹窗并写入剪贴板路径', async () => {
      const intercepted = handleExecutableSecurityBlock(
        'C:/Program Files/Firefly/firefly-omni.exe',
        { code: 'EPERM' }
      )
      expect(intercepted).toBe(true)
      expect(mockDialogShowMessageBox).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({
          type: 'warning',
          title: '核心执行器防护提示'
        })
      )
    })
  })

  describe('系统设置 Tab 动态挂载与隐藏', () => {
    it('未激活 TTS / 高级引擎插件时，系统设置自动隐藏对应 Tab', () => {
      const inactiveModules: PluginModuleItem[] = [
        {
          id: 'tts_moss_onnx',
          name: '离线语音合成 TTS',
          version: '1.0.0',
          category: 'media',
          capability_slot: 'voice_tts',
          author_code: 'official',
          availability: 'available',
          total_bytes: 1000,
          install_state: 'installed_inactive',
          description: 'TTS 描述',
          contributes: {
            settings: {
              scope: 'global',
              tabTitle: '语音合成 (TTS)',
              componentId: 'tts'
            }
          }
        }
      ]
      usePluginCenterStore.setState({ modules: inactiveModules })
      useSettingsStore.setState({ isSystemSettingsOpen: true, isOpen: true })

      render(<SystemSettingsDialog />)

      // 基础界面、生成式引擎与忽略规则始终常驻存在
      expect(screen.getByText('界面与显示偏好')).toBeInTheDocument()
      expect(screen.getByText('生成式引擎')).toBeInTheDocument()
      expect(screen.getByText('全局排除文件规则')).toBeInTheDocument()

      // TTS 处于停用状态，Tab 应当被隐藏
      expect(screen.queryByText('语音合成 (TTS)')).toBeNull()
    })

    it('激活 TTS 插件后，系统设置动态挂载对应 Tab', () => {
      const activeModules: PluginModuleItem[] = [
        {
          id: 'tts_moss_onnx',
          name: '离线语音合成 TTS',
          version: '1.0.0',
          category: 'media',
          capability_slot: 'voice_tts',
          author_code: 'official',
          availability: 'available',
          total_bytes: 1000,
          install_state: 'active',
          description: 'TTS 描述',
          contributes: {
            settings: {
              scope: 'global',
              tabTitle: '语音合成 (TTS)',
              componentId: 'tts'
            }
          }
        }
      ]
      usePluginCenterStore.setState({ modules: activeModules })
      useSettingsStore.setState({ isSystemSettingsOpen: true, isOpen: true })

      render(<SystemSettingsDialog />)

      // 激活后 TTS Tab 应成功展示
      expect(screen.getByText('语音合成 (TTS)')).toBeInTheDocument()
    })
  })

  describe('卡片配置按钮一键直达跳转 (Spec §5.2)', () => {
    it('点击全局插件配置按钮直接定位到系统设置对应 Tab 并关闭插件中心覆盖层', () => {
      const testModules: PluginModuleItem[] = [
        {
          id: 'tts_moss_onnx',
          name: '离线语音合成 TTS',
          version: '1.0.0',
          category: 'media',
          capability_slot: 'voice_tts',
          author_code: 'official',
          availability: 'available',
          total_bytes: 1000,
          install_state: 'active',
          description: 'TTS 描述',
          contributes: {
            settings: {
              scope: 'global',
              tabTitle: '语音合成 (TTS)',
              componentId: 'tts'
            }
          }
        }
      ]
      usePluginCenterStore.setState({ modules: testModules, isOverlayOpen: true })

      render(<PluginCenterOverlay />)

      const configButton = screen.getByText('配置')
      expect(configButton).toBeInTheDocument()

      act(() => {
        fireEvent.click(configButton)
      })

      // 覆盖层关闭
      expect(usePluginCenterStore.getState().isOverlayOpen).toBe(false)
      // 系统设置打开且定位在 TTS 分类
      expect(useSettingsStore.getState().isSystemSettingsOpen).toBe(true)
      expect(useSettingsStore.getState().currentCategory).toBe(SettingsCategory.TTS)
    })

    it('点击工作区插件配置按钮直接定位到工作区设置对应 Tab 并关闭覆盖层', () => {
      const testModules: PluginModuleItem[] = [
        {
          id: 'perception_nsfw',
          name: '敏感内容与 NSFW 分级识别',
          version: '1.0.0',
          category: 'perception',
          capability_slot: 'perception_nsfw',
          author_code: 'official',
          availability: 'available',
          total_bytes: 1000,
          install_state: 'active',
          description: 'NSFW 描述',
          contributes: {
            settings: {
              scope: 'workspace',
              tabTitle: '文件内容萃取',
              componentId: 'content_extraction'
            }
          }
        }
      ]
      usePluginCenterStore.setState({ modules: testModules, isOverlayOpen: true })

      render(<PluginCenterOverlay />)

      const configButton = screen.getByText('配置')
      expect(configButton).toBeInTheDocument()

      act(() => {
        fireEvent.click(configButton)
      })

      expect(usePluginCenterStore.getState().isOverlayOpen).toBe(false)
      expect(useSettingsStore.getState().isWorkspaceSettingsOpen).toBe(true)
      expect(useSettingsStore.getState().targetWorkspaceTab).toBe('content_extraction')
    })
  })
})
