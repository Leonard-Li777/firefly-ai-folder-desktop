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
      config: {
        ttsEnabled: true
      } as any
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

    // 容器应当为空，不呈现任何播放按钮或下拉组件
    expect(container.firstChild).toBeNull()
  })

  it('当安装了 TTS 插件但处于停用状态时，组件完全不呈现', () => {
    const inactiveModule: PluginModuleItem = {
      id: 'tts_moss_onnx',
      name: '个性声音克隆 (Moss-TTS)',
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
          tabTitle: '语音合成 (TTS)',
          componentId: 'tts'
        }
      }
    }

    usePluginCenterStore.setState({ modules: [inactiveModule] })

    const { container } = render(<TTSActionGroup text="测试文本" textId="test-2" />)

    expect(container.firstChild).toBeNull()
  })

  it('当激活了 M5-TTS 插件时，组件正常呈现朗读操作胶囊', () => {
    const activeM5Module: PluginModuleItem = {
      id: 'tts_m5_onnx',
      name: '极速语音合成 (M5-TTS)',
      version: '1.0.0',
      category: 'media',
      capability_slot: 'voice_tts',
      author_code: 'official',
      availability: 'available',
      total_bytes: 1000,
      install_state: 'active',
      description: 'M5-TTS 插件',
      contributes: {
        settings: {
          scope: 'global',
          tabTitle: '极速语音朗读 (M5-TTS)',
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
