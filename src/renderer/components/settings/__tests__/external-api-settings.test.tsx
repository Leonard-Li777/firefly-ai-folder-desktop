// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { ExternalApiStatusDTO } from '@firefly/types'

vi.mock('@app/languages', () => ({
  t: (str: string, args?: any[]) => {
    if (!Array.isArray(args)) return str
    return args.reduce((acc, val, idx) => acc.replace(`{${idx}}`, String(val)), str)
  },
  default: {}
}))

vi.mock('../../lib/external-link', () => ({
  openExternalLink: vi.fn()
}))

vi.mock('../common/Toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn()
  }
}))

import {
  ExternalApiSettingsTab,
  buildUniversalAgentPrompt,
  getCapabilityDisplayMeta
} from '../external-api-settings'
import { usePluginCenterStore } from '../../../stores/plugin-center-store'
import { useSettingsStore } from '../../../stores/settings-store'

function createMockStatus(overrides: Partial<ExternalApiStatusDTO> = {}): ExternalApiStatusDTO {
  return {
    rev: 1,
    phase: 'running',
    desiredEnabled: true,
    host: '127.0.0.1',
    port: 38300,
    baseUrl: 'http://127.0.0.1:38300',
    uptimeSec: 42,
    discoveryPath: 'C:\\Users\\demo\\AppData\\Roaming\\firefly\\ai-skill-config.json',
    discoveryPresent: true,
    degradationReason: null,
    activity: {
      lastCallTimestamp: null,
      lastCaller: null,
      lastEndpoint: null,
      lastStatusCode: null,
      totalRequests: 0
    },
    presence: { kind: 'standby' },
    lastError: null,
    activeCapabilities: ['search', 'timeline', 'progress', 'virtual-folder-draft', 'ocr'],
    slotReadiness: {
      voice_asr: { ready: false, slotKey: 'voice_asr' },
      voice_tts: { ready: false, slotKey: 'voice_tts' },
      perception_nsfw: { ready: false, slotKey: 'perception_nsfw' }
    },
    ...overrides
  }
}

describe('ExternalApiSettingsTab 大白话重构与能力联动测试', () => {
  const mockGetStatus = vi.fn()
  const mockSetDesired = vi.fn()
  const mockTestConnection = vi.fn()
  const mockOnStatusChanged = vi.fn(() => () => {})

  beforeEach(() => {
    vi.clearAllMocks()
    ;(window as any).electronAPI = {
      externalApi: {
        getStatus: mockGetStatus,
        setDesired: mockSetDesired,
        testConnection: mockTestConnection,
        onStatusChanged: mockOnStatusChanged
      }
    }
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true
    })
  })

  // TC-EXT-UI-01: 三步走布局 + 运行态与停止态护栏
  it('TC-EXT-UI-01: 运行态展示三步走布局与可复制 Prompt；停止态禁用复制按钮且无非法 URL', async () => {
    mockGetStatus.mockResolvedValueOnce(createMockStatus({ phase: 'running' }))
    const { unmount } = render(<ExternalApiSettingsTab />)

    await waitFor(() => {
      expect(screen.getByTestId('agent-prompt-preview')).toBeInTheDocument()
    })

    expect(screen.getByTestId('external-api-value-card')).toBeInTheDocument()
    expect(screen.getByTestId('external-api-step1-prompt')).toBeInTheDocument()
    expect(screen.getByTestId('external-api-safety-shield')).toBeInTheDocument()
    expect(screen.getByTestId('external-api-step2-capabilities')).toBeInTheDocument()
    expect(screen.getByTestId('external-api-step3-advanced')).toBeInTheDocument()
    expect(screen.getByTestId('copy-agent-prompt-btn')).not.toBeDisabled()

    unmount()

    // 停止态护栏
    mockGetStatus.mockResolvedValueOnce(
      createMockStatus({
        phase: 'stopped',
        desiredEnabled: false,
        port: null,
        baseUrl: null,
        presence: { kind: 'stopped' }
      })
    )
    render(<ExternalApiSettingsTab />)

    await waitFor(() => {
      expect(screen.getByTestId('agent-prompt-disabled-hint')).toBeInTheDocument()
    })
    expect(screen.getByTestId('copy-agent-prompt-btn')).toBeDisabled()
    expect(document.body.textContent).not.toContain('null/api/')
  })

  // TC-EXT-UI-02: 动态 Prompt 注入完整覆盖 8 大能力与 /api/capabilities 热发现
  it('TC-EXT-UI-02: buildUniversalAgentPrompt 精准注入已激活能力并指向 /api/capabilities', () => {
    const prompt = buildUniversalAgentPrompt(
      'http://127.0.0.1:38300',
      'C:\\demo\\ai-skill-config.json',
      ['search', 'timeline', 'progress', 'asr']
    )

    expect(prompt).toContain('智能查找文件')
    expect(prompt).toContain('视频画面与镜头定位')
    expect(prompt).toContain('后台分析进度感知')
    expect(prompt).toContain('语音转文字与台词提取')
    expect(prompt).toContain('GET http://127.0.0.1:38300/api/capabilities')
    expect(prompt).not.toContain('真人语音朗读')
    expect(prompt).not.toContain('隐私与敏感内容把关')
  })

  // TC-EXT-UI-03: 零术语合规审查 (AGENTS.md §2.16)
  it('TC-EXT-UI-03: 面向用户的非 Prompt UI 文本零命中黑话与底层英文缩写', async () => {
    mockGetStatus.mockResolvedValueOnce(createMockStatus())
    render(<ExternalApiSettingsTab />)

    await waitFor(() => {
      expect(screen.getByTestId('capability-card-search')).toBeInTheDocument()
    })

    const forbidden = /FTS5|BM25|时序切片|推理负载|向量|\bOCR\b|\bASR\b|\bTTS\b/
    const valueText = screen.getByTestId('external-api-value-card').textContent || ''
    const capText = screen.getByTestId('external-api-step2-capabilities').textContent || ''
    const safetyText = screen.getByTestId('external-api-safety-shield').textContent || ''

    expect(valueText).not.toMatch(forbidden)
    expect(capText).not.toMatch(forbidden)
    expect(safetyText).not.toMatch(forbidden)

    // 同时核验 getCapabilityDisplayMeta 8 项均无违禁词
    for (const id of [
      'search',
      'virtual-folder-draft',
      'timeline',
      'progress',
      'ocr',
      'asr',
      'tts',
      'sensitive'
    ] as const) {
      const meta = getCapabilityDisplayMeta(id)
      expect(meta.name).not.toMatch(forbidden)
      expect(meta.desc).not.toMatch(forbidden)
    }
  })

  // TC-EXT-UI-04: 插件中心直达与 OCR 一键开启
  it('TC-EXT-UI-04: 点击 ASR 去安装调用 openOverlay({ focusSlot })，点击 OCR 一键开启更新 ENABLE_IMAGE_OCR', async () => {
    const openOverlaySpy = vi.fn().mockResolvedValue(undefined)
    const closeSystemSettingsSpy = vi.fn().mockResolvedValue(undefined)
    const updateConfigValueSpy = vi.fn().mockResolvedValue(undefined)
    usePluginCenterStore.setState({ openOverlay: openOverlaySpy } as any)
    useSettingsStore.setState({
      closeSystemSettings: closeSystemSettingsSpy,
      updateConfigValue: updateConfigValueSpy
    } as any)

    mockGetStatus.mockResolvedValueOnce(
      createMockStatus({
        activeCapabilities: ['search', 'timeline', 'progress', 'virtual-folder-draft']
      })
    )
    render(<ExternalApiSettingsTab />)

    await waitFor(() => {
      expect(screen.getByTestId('capability-action-asr')).toBeInTheDocument()
      expect(screen.getByTestId('capability-action-ocr')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('capability-action-asr'))
    expect(closeSystemSettingsSpy).toHaveBeenCalledTimes(1)
    expect(openOverlaySpy).toHaveBeenCalledWith({ focusSlot: 'voice_asr' })

    fireEvent.click(screen.getByTestId('capability-action-ocr'))
    await waitFor(() => {
      expect(updateConfigValueSpy).toHaveBeenCalledWith('ENABLE_IMAGE_OCR', true)
    })
  })
})
