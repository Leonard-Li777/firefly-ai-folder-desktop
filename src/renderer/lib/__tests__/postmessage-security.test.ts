import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, act } from '@testing-library/react'
import { ExternalIframeAdapter } from '../../components/file-explorer/adapters/ExternalIframeAdapter'
import {
  PreviewCandidate,
  PreviewContext,
  PreviewSession,
  PreviewMessageEnvelope
} from '../preview-types'
import { PreviewRouter } from '../preview-router'

describe('PostMessageSecurity (Spec §8.2 维度 D: 协议安全与三元组核验)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    PreviewRouter.getInstance().getCircuitBreaker().resetAll()
  })

  const mockCandidate: PreviewCandidate = {
    id: 'test_sec_plugin',
    name: '安全测试插件',
    kind: 'external_iframe',
    supportedExtensions: ['dwg'],
    declaredPriority: 90,
    effectivePriority: 90,
    isOfficialCertified: true
  }

  const mockSession: PreviewSession = {
    sessionId: 'session_target_valid',
    requestId: 'req_target_valid_0',
    generation: 2,
    filePath: 'C:/test/file.dwg',
    abortController: new AbortController(),
    cursor: 0,
    candidates: [mockCandidate]
  }

  const mockContext: PreviewContext = {
    filePath: 'C:/test/file.dwg',
    fileName: 'file.dwg',
    extension: 'dwg',
    fileSize: 2048,
    fileFingerprint: 'C:/test/file.dwg:2048:100',
    requestId: 'req_target_valid_0',
    generation: 2,
    signal: new AbortController().signal,
    isPrivate: false
  }

  it('1. 消息过滤：非 iframe 窗口发送的消息被无条件忽略', () => {
    const onReady = vi.fn()
    render(
      React.createElement(ExternalIframeAdapter, {
        session: mockSession,
        candidate: mockCandidate,
        context: mockContext,
        onReady
      })
    )

    // 伪造由顶层 window 自身发出的消息
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            sessionId: mockSession.sessionId,
            generation: mockSession.generation,
            channelSecret: 'fake_secret',
            type: 'PREVIEW_READY'
          },
          source: window // source 不匹配 iframe.contentWindow
        })
      )
    })

    // 不应触发 onReady
    expect(onReady).not.toHaveBeenCalled()
  })

  it('2. 消息过滤：旧 generation 或错误 sessionId 残余消息被丢弃', () => {
    const onReady = vi.fn()
    const { container } = render(
      React.createElement(ExternalIframeAdapter, {
        session: mockSession,
        candidate: mockCandidate,
        context: mockContext,
        onReady
      })
    )

    const iframe = container.querySelector('iframe')
    const fakeContentWindow = iframe?.contentWindow

    // 模拟旧代的残留消息 (generation: 1 != 2)
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            sessionId: mockSession.sessionId,
            generation: 1, // 旧代
            type: 'PREVIEW_READY'
          } as PreviewMessageEnvelope,
          source: fakeContentWindow
        })
      )
    })

    expect(onReady).not.toHaveBeenCalled()
  })
})
