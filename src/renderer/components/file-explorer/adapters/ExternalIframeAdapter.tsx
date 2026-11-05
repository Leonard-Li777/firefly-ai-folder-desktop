/**
 * 第三方扩展预览器沙箱适配器 (ExternalIframeAdapter)
 * 遵循规格书 docs/specs/file-previewer-engine-and-custom-extensions-spec.md (v1.2 §4/§5)
 * 严格沙箱 (null opaque origin) + CSP 离线锁死 + 双轨强杀 + 多阶段心跳
 */

import React, { useEffect, useRef, useState } from 'react'
import {
  PreviewCandidate,
  PreviewContext,
  PreviewMessageEnvelope,
  PreviewSession,
  PREVIEW_ERROR_CODES
} from '../../../lib/preview-types'
import { PreviewRouter } from '../../../lib/preview-router'
import { logger, LogCategory } from '@firefly/shared'

export interface ExternalIframeAdapterProps {
  session: PreviewSession
  candidate: PreviewCandidate
  context: PreviewContext
  onReady?: () => void
  onError?: (err: Error) => void
}

export const ExternalIframeAdapter: React.FC<ExternalIframeAdapterProps> = ({
  session,
  candidate,
  context,
  onReady,
  onError
}) => {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const channelSecretRef = useRef<string>(`sec_${Math.random().toString(36).slice(2, 9)}`)
  const [isRendered, setIsRendered] = useState(false)

  const bootTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const heartbeatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 辅助函数：双轨强杀（软注销消息 + 硬卸载 about:blank 强释 WebGL 上下文）
  const killIframe = () => {
    if (iframeRef.current) {
      try {
        iframeRef.current.contentWindow?.postMessage(
          {
            sessionId: session.sessionId,
            requestId: session.requestId,
            generation: session.generation,
            channelSecret: channelSecretRef.current,
            type: 'PREVIEW_DISPOSE'
          },
          '*'
        )
      } catch {}
      try {
        iframeRef.current.src = 'about:blank'
      } catch {}
    }
  }

  // 触发故障处理与降级
  const handleFailure = (reason: string, isCrashOrTimeout: boolean = true) => {
    killIframe()
    // 记录三级熔断状态
    PreviewRouter.getInstance()
      .getCircuitBreaker()
      .recordFailure(candidate.id, context.extension, context.fileFingerprint, isCrashOrTimeout)
    onError?.(new Error(reason))
  }

  // 重置滑动心跳定时器（5秒滑动窗口）
  const resetHeartbeatTimer = () => {
    if (heartbeatTimerRef.current) {
      clearTimeout(heartbeatTimerRef.current)
    }
    heartbeatTimerRef.current = setTimeout(() => {
      logger.warn(
        LogCategory.RENDERER,
        `[ExternalIframeAdapter] 插件 ${candidate.id} 连续 5s 无心跳，判定超时熔断`
      )
      handleFailure('Heartbeat Timeout', true)
    }, 5000)
  }

  useEffect(() => {
    // 1. 启动初始握手定时器 (1.5s BOOTED 硬门禁)
    bootTimerRef.current = setTimeout(() => {
      logger.warn(
        LogCategory.RENDERER,
        `[ExternalIframeAdapter] 插件 ${candidate.id} 启动握手超时 (1.5s)`
      )
      handleFailure('Boot Handshake Timeout', true)
    }, 1500)

    // 2. 注册 postMessage 监听器
    const handleMessage = (event: MessageEvent) => {
      // 严格断言物理来源窗口与活跃 Session 三元组
      if (event.source !== iframeRef.current?.contentWindow) return

      const data = event.data as PreviewMessageEnvelope
      if (!data || typeof data !== 'object') return

      const isBootedMessage = data.type === 'PREVIEW_BOOTED'
      const isSecretMatched =
        data.channelSecret === channelSecretRef.current || (isBootedMessage && !data.channelSecret)

      if (
        data.sessionId !== session.sessionId ||
        data.generation !== session.generation ||
        !isSecretMatched
      ) {
        return // 旧 Session 残余消息直接丢弃
      }

      switch (data.type) {
        case 'PREVIEW_BOOTED': {
          if (bootTimerRef.current) {
            clearTimeout(bootTimerRef.current)
            bootTimerRef.current = null
          }
          // 下发加载任务与会话流式 URL
          iframeRef.current?.contentWindow?.postMessage(
            {
              sessionId: session.sessionId,
              requestId: session.requestId,
              generation: session.generation,
              channelSecret: channelSecretRef.current,
              type: 'PREVIEW_LOAD',
              payload: {
                streamUrl: `ff-preview://session/${session.sessionId}/stream`,
                filePath: context.filePath,
                fileName: context.fileName,
                extension: context.extension,
                fileSize: context.fileSize
              }
            },
            '*'
          )
          // 启动滑动心跳
          resetHeartbeatTimer()
          break
        }
        case 'PREVIEW_PROGRESS': {
          // 收到进度心跳，续期 5 秒
          resetHeartbeatTimer()
          break
        }
        case 'PREVIEW_READY': {
          if (heartbeatTimerRef.current) {
            clearTimeout(heartbeatTimerRef.current)
            heartbeatTimerRef.current = null
          }
          setIsRendered(true)
          onReady?.()
          break
        }
        case 'PREVIEW_ERROR': {
          if (heartbeatTimerRef.current) {
            clearTimeout(heartbeatTimerRef.current)
            heartbeatTimerRef.current = null
          }
          const isCorrupted = data.payload?.code === PREVIEW_ERROR_CODES.ERR_PARSE_CORRUPTED
          handleFailure(data.payload?.message || 'Previewer Reported Error', !isCorrupted)
          break
        }
      }
    }

    window.addEventListener('message', handleMessage)

    return () => {
      window.removeEventListener('message', handleMessage)
      if (bootTimerRef.current) clearTimeout(bootTimerRef.current)
      if (heartbeatTimerRef.current) clearTimeout(heartbeatTimerRef.current)
      killIframe()
    }
  }, [session.sessionId, session.generation, candidate.id])

  const baseEntry = candidate.entryHtmlUrl || `ff-preview://plugin/${candidate.id}/index.html`
  const delimiter = baseEntry.includes('?') ? '&' : '?'
  const entryUrl = `${baseEntry}${delimiter}sessionId=${encodeURIComponent(
    session.sessionId
  )}&channelSecret=${encodeURIComponent(channelSecretRef.current)}&generation=${session.generation}`

  return (
    <div className="w-full h-full relative overflow-hidden bg-background">
      <iframe
        ref={iframeRef}
        src={entryUrl}
        sandbox="allow-scripts"
        {...({
          csp: "default-src 'self' 'unsafe-inline' blob:; connect-src 'self' blob:; object-src 'none';"
        } as any)}
        className="w-full h-full border-none"
        title={candidate.name}
      />
    </div>
  )
}
