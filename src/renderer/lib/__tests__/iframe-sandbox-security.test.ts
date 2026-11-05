import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, act } from '@testing-library/react'
import { ExternalIframeAdapter } from '../../components/file-explorer/adapters/ExternalIframeAdapter'
import { PreviewCandidate, PreviewContext, PreviewSession } from '../preview-types'
import { PreviewRouter } from '../preview-router'

describe('IframeSandboxSecurity (Spec §8.2 维度 B: 隔离与容灾验收)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    PreviewRouter.getInstance().getCircuitBreaker().resetAll()
  })

  const mockCandidate: PreviewCandidate = {
    id: 'test_cad_viewer',
    name: 'CAD 查看器',
    kind: 'external_iframe',
    supportedExtensions: ['dwg', 'dxf'],
    declaredPriority: 90,
    effectivePriority: 90,
    isOfficialCertified: true,
    isTrustedForPrivate: false
  }

  const mockSession: PreviewSession = {
    sessionId: 'session_sec_test',
    requestId: 'req_sec_test_0',
    generation: 1,
    filePath: 'C:/test/drawing.dwg',
    abortController: new AbortController(),
    cursor: 0,
    candidates: [mockCandidate]
  }

  const mockContext: PreviewContext = {
    filePath: 'C:/test/drawing.dwg',
    fileName: 'drawing.dwg',
    extension: 'dwg',
    fileSize: 1024,
    fileFingerprint: 'C:/test/drawing.dwg:1024:100',
    requestId: 'req_sec_test_0',
    generation: 1,
    signal: new AbortController().signal,
    isPrivate: false
  }

  it('1. 严格沙箱门禁：禁止 allow-same-origin，只允许 allow-scripts', () => {
    const { container } = render(
      React.createElement(ExternalIframeAdapter, {
        session: mockSession,
        candidate: mockCandidate,
        context: mockContext
      })
    )

    const iframe = container.querySelector('iframe')
    expect(iframe).not.toBeNull()
    const sandboxAttr = iframe?.getAttribute('sandbox') || ''
    // 必须有 allow-scripts
    expect(sandboxAttr).toContain('allow-scripts')
    // 严禁包含 allow-same-origin (防 DOM 穿透)
    expect(sandboxAttr).not.toContain('allow-same-origin')
    // 严禁包含 allow-top-navigation / allow-modals
    expect(sandboxAttr).not.toContain('allow-top-navigation')
    expect(sandboxAttr).not.toContain('allow-modals')
  })

  it('2. CSP 离线锁死属性配置符合规范', () => {
    const { container } = render(
      React.createElement(ExternalIframeAdapter, {
        session: mockSession,
        candidate: mockCandidate,
        context: mockContext
      })
    )

    const iframe = container.querySelector('iframe')
    const cspAttr = iframe?.getAttribute('csp') || ''
    expect(cspAttr).toContain("connect-src 'self' blob:")
    expect(cspAttr).toContain("object-src 'none'")
  })

  it('3. 死循环/无响应容灾：1.5s 握手超时强杀并触发熔断降级', () => {
    const onError = vi.fn()
    const { container } = render(
      React.createElement(ExternalIframeAdapter, {
        session: mockSession,
        candidate: mockCandidate,
        context: mockContext,
        onError
      })
    )

    const iframe = container.querySelector('iframe')
    expect(iframe?.src).toContain('sessionId=session_sec_test')

    // 推进 1.5 秒超时
    act(() => {
      vi.advanceTimersByTime(1500)
    })

    // 判定强杀：iframe.src 被立即重置为 about:blank 且触发 onError
    expect(iframe?.src).toBe('about:blank')
    expect(onError).toHaveBeenCalledWith(expect.any(Error))

    // 检查熔断状态：超时计入崩溃/未响应，格式级故障计数增加
    const cb = PreviewRouter.getInstance().getCircuitBreaker()
    expect(cb.isTripped('test_cad_viewer', 'dwg', mockContext.fileFingerprint)).toBe(true)
  })
})
