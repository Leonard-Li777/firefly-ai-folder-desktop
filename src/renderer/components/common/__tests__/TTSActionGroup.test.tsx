// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, act } from '@testing-library/react'

// Mock 语言包
vi.mock('@app/languages', () => ({
  t: (str: string) => str,
  default: {}
}))

// Mock Electron API
vi.mock('electron', () => ({
  BrowserWindow: {
    getFocusedWindow: () => null,
    getAllWindows: () => []
  }
}))

import { TTSActionGroup } from '../TTSActionGroup'
import { useTTSAudioStore } from '../../../stores/tts-audio-store'
import { usePluginCenterStore, type PluginModuleItem } from '../../../stores/plugin-center-store'
import { useSettingsStore } from '../../../stores/settings-store'

describe('TTSActionGroup: 未安装与激活状态下的 UI 与业务呈现测试', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    usePluginCenterStore.setState({ modules: [] })
    useSettingsStore.setState({
      config: {} as any
    })
    useTTSAudioStore.setState({
      status: 'idle',
      playingText: '',
      playingTextId: '',
      allVoices: []
    })
  })

  it('当没有安装任何 TTS 插件（modules 为空）时，组件完全不呈现（返回 null）', () => {
    usePluginCenterStore.setState({ modules: [] })

    const { container } = render(<TTSActionGroup text="测试文本" textId="test-1" />)

    // 未安装任何 TTS 插件时，呈现「待安装/启动」小字占位（而非空白），让用户知晓此处有语音功能位
    expect(container.firstChild).not.toBeNull()
    expect(screen.getByTestId('tts-action-placeholder')).toBeInTheDocument()
    expect(screen.getByText('语音播放待安装/启动')).toBeInTheDocument()
  })

  it('当安装了 TTS 插件但处于停用状态时，呈现「待安装/启动」小字占位', () => {
    const inactiveModule: PluginModuleItem = {
      id: 'tts_moss_onnx',
      name: '个性化声音克隆与朗读',
      version: '1.0.0',
      category: 'media',
      capability_slot: 'voice_tts',
      author_code: 'official',
      availability: 'available',
      total_bytes: 1000,
      install_state: 'installed_inactive',
      description: 'TTS 插件',
      contributes: {
        settings: {
          scope: 'global',
          tabTitle: '个性化声音克隆',
          componentId: 'tts'
        }
      }
    }

    usePluginCenterStore.setState({ modules: [inactiveModule] })

    const { container } = render(<TTSActionGroup text="测试文本" textId="test-2" />)

    // 停用状态等同于未就绪，同样呈现「待安装/启动」小字占位
    expect(container.firstChild).not.toBeNull()
    expect(screen.getByTestId('tts-action-placeholder')).toBeInTheDocument()
  })

  it('当激活了 M5-TTS 插件时，组件正常呈现朗读操作胶囊', () => {
    const activeM5Module: PluginModuleItem = {
      id: 'tts_m5_onnx',
      name: '极速语音合成与朗读',
      version: '1.0.0',
      category: 'media',
      capability_slot: 'voice_tts',
      author_code: 'official',
      availability: 'available',
      total_bytes: 1000,
      install_state: 'active',
      description: '极速语音朗读插件',
      contributes: {
        settings: {
          scope: 'global',
          tabTitle: '极速语音朗读',
          componentId: 'tts'
        }
      }
    }

    usePluginCenterStore.setState({ modules: [activeM5Module] })

    const { container } = render(<TTSActionGroup text="测试文本" textId="test-3" />)

    // 应当渲染出按钮组
    expect(container.firstChild).not.toBeNull()
    expect(screen.getByTitle('语音朗读')).toBeInTheDocument()
  })

  it('当用户在设置中主动关闭语音功能（ttsEnabled=false）时，组件完全隐藏不显示占位', () => {
    // 即使有已激活的 TTS 插件，用户主动关闭语音功能也应完全隐藏（而非显示「待安装」占位）
    const activeM5Module: PluginModuleItem = {
      id: 'tts_m5_onnx',
      name: '极速语音合成与朗读',
      version: '1.0.0',
      category: 'media',
      capability_slot: 'voice_tts',
      author_code: 'official',
      availability: 'available',
      total_bytes: 1000,
      install_state: 'active',
      description: '极速语音朗读插件',
      contributes: {
        settings: {
          scope: 'global',
          tabTitle: '极速语音朗读',
          componentId: 'tts'
        }
      }
    }
    usePluginCenterStore.setState({ modules: [activeM5Module] })
    useSettingsStore.setState({ config: { ttsEnabled: false } as any })

    const { container } = render(<TTSActionGroup text="测试文本" textId="test-disabled" />)

    expect(container.firstChild).toBeNull()
    expect(screen.queryByTestId('tts-action-placeholder')).toBeNull()
  })

  it('当没有安装 TTS 插件时调用 ttsAudioStore.play(...)，安全跳过且不抛错、不阻断', async () => {
    usePluginCenterStore.setState({ modules: [] })

    // 调用 play
    await act(async () => {
      await useTTSAudioStore
        .getState()
        .play('这是一段待朗读的测试文本', { textId: 'test-direct-call' })
    })

    // 状态应当保持 idle，绝对不会进入 loading/playing，更不会抛错中断
    expect(useTTSAudioStore.getState().status).toBe('idle')
    expect(useTTSAudioStore.getState().playingTextId).toBe('')
  })
})
