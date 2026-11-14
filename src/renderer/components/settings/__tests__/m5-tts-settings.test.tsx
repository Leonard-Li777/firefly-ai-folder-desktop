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
vi.mock('electron', () => ({
  dialog: { showMessageBox: vi.fn() },
  clipboard: { writeText: vi.fn() }
}))

import { M5TTSSettings } from '../m5-tts-settings'
import { useSettingsStore } from '../../../stores/settings-store'
import { useTTSAudioStore } from '../../../stores/tts-audio-store'

describe('M5TTSSettings 极速语音合成设置面板测试', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({
      config: {
        ttsSpeed: 1.0,
        ttsDefaultVoiceSid: 'azure_yunxi',
        ttsFavoriteVoices: ['azure_yunxi', 'azure_yunye']
      } as any
    })
  })

  it('成功渲染 M5-TTS 设置面板且绝不包含音色克隆按钮或克隆模态框', () => {
    render(<M5TTSSettings />)

    // 验证核心标题与特性说明
    expect(screen.getByText('极速语音合成与朗读')).toBeInTheDocument()
    expect(screen.getByText('默认朗读倍率')).toBeInTheDocument()
    expect(screen.getByText('我的收藏音色')).toBeInTheDocument()
    expect(screen.getByText('发音人音色库')).toBeInTheDocument()

    // 核心断言：绝对不能存在“克隆新音色”或“自定义”按钮
    expect(screen.queryByText('克隆新音色')).toBeNull()
    expect(screen.queryByText('克隆我的声音')).toBeNull()
    expect(screen.queryByText('自定义')).toBeNull()
  })

  it('支持切换默认语速并同步至设置 Store', async () => {
    const updateConfigValueSpy = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      updateConfigValue: updateConfigValueSpy
    } as any)

    render(<M5TTSSettings />)

    const speedBtn = screen.getByText('1.5x')
    fireEvent.click(speedBtn)

    expect(updateConfigValueSpy).toHaveBeenCalledWith('TTS_SPEED', 1.5)
  })

  it('支持发音人关键词搜索与过滤', async () => {
    render(<M5TTSSettings />)

    const searchInput = screen.getByPlaceholderText(/搜索发音人姓名/i)
    fireEvent.change(searchInput, { target: { value: '云希' } })

    // 列表中应包含云希
    expect(screen.getAllByText('云希').length).toBeGreaterThan(0)
  })

  it('支持试听例句播放触发', async () => {
    const playMock = vi.fn().mockResolvedValue(undefined)
    useTTSAudioStore.setState({
      play: playMock
    } as any)

    render(<M5TTSSettings />)

    // 点击第一个试听按钮
    const auditionButtons = screen.getAllByTitle('试听例句')
    expect(auditionButtons.length).toBeGreaterThan(0)

    fireEvent.click(auditionButtons[0])
    expect(playMock).toHaveBeenCalled()
  })
})
