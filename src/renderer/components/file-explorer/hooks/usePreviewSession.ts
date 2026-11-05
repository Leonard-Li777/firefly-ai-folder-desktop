/**
 * 预览会话管理 Hook (usePreviewSession)
 * 管理 Session 生命周期、防翻页竞态、候选栈游标流转与主进程会话挂载
 * 遵循规格书 docs/specs/file-previewer-engine-and-custom-extensions-spec.md (v1.2 §2)
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  PreviewCandidate,
  PreviewContext,
  PreviewSession,
  getFileFingerprint
} from '../../../lib/preview-types'
import { PreviewRouter } from '../../../lib/preview-router'
import { logger, LogCategory } from '@firefly/shared'

export interface UsePreviewSessionProps {
  filePath: string
  fileName: string
  extension?: string
  fileSize?: number
  isPrivate?: boolean
  workspaceDirectoryType?: 'SPEEDY' | 'PRIVATE' | 'VDIR'
  multimodalContent?: string | null
  currentTime?: number
  highlightRange?: [number, number]
}

export interface UsePreviewSessionReturn {
  session: PreviewSession
  context: PreviewContext
  currentCandidate: PreviewCandidate
  isLoading: boolean
  hasFailedCurrent: boolean
  onCandidateReady: () => void
  onCandidateError: (err?: Error) => void
  onRetryNext: () => void
}

const FALLBACK_ICON_CANDIDATE: PreviewCandidate = {
  id: 'system_icon_fallback',
  name: '系统图标与元数据',
  kind: 'system_icon',
  supportedExtensions: ['*'],
  declaredPriority: 0,
  effectivePriority: 0,
  isOfficialCertified: true,
  isTrustedForPrivate: true
}

let globalGenerationCounter = 0

export function usePreviewSession(props: UsePreviewSessionProps): UsePreviewSessionReturn {
  const {
    filePath,
    fileName,
    extension,
    fileSize = 0,
    isPrivate = false,
    workspaceDirectoryType,
    multimodalContent,
    currentTime,
    highlightRange
  } = props

  const ext = (extension || fileName.split('.').pop() || '').toLowerCase()
  const router = PreviewRouter.getInstance()

  const [generation, setGeneration] = useState(() => ++globalGenerationCounter)
  const [sessionId, setSessionId] = useState(
    () => `session_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  )
  const [cursor, setCursor] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [hasFailedCurrent, setHasFailedCurrent] = useState(false)

  const abortControllerRef = useRef<AbortController>(new AbortController())
  const activeSessionIdRef = useRef<string>(sessionId)
  const isFirstMountRef = useRef<boolean>(true)

  // 构造当前 PreviewContext
  const context: PreviewContext = {
    filePath,
    fileName,
    extension: ext,
    fileSize,
    fileFingerprint: getFileFingerprint(filePath, fileSize),
    requestId: `req_${generation}_${cursor}`,
    generation,
    signal: abortControllerRef.current.signal,
    isPrivate,
    workspaceDirectoryType,
    multimodalContent,
    currentTime,
    highlightRange
  }

  // 计算当前候选栈
  const candidates = router.resolveCandidates(context)
  const currentCandidate = candidates[cursor] || candidates[0] || FALLBACK_ICON_CANDIDATE

  // 当文件路径或隐私属性改变时，初始化新 Session
  useEffect(() => {
    let currentSessionId = sessionId
    let currentGen = generation

    if (!isFirstMountRef.current) {
      currentGen = ++globalGenerationCounter
      currentSessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
      const oldSessionId = activeSessionIdRef.current

      // 1. 中止上一个 Session
      abortControllerRef.current.abort()
      const nextAbortController = new AbortController()
      abortControllerRef.current = nextAbortController

      // 2. 主进程注销旧会话
      if (
        window?.electronAPI?.preview &&
        oldSessionId &&
        typeof window.electronAPI.preview.unmountSession === 'function'
      ) {
        window.electronAPI.preview.unmountSession(oldSessionId).catch(() => {})
      }

      activeSessionIdRef.current = currentSessionId
      setGeneration(currentGen)
      setSessionId(currentSessionId)
      setCursor(0)
      setIsLoading(true)
      setHasFailedCurrent(false)
    } else {
      isFirstMountRef.current = false
    }

    // 挂载当前有效会话
    if (
      window?.electronAPI?.preview &&
      filePath &&
      typeof window.electronAPI.preview.mountSession === 'function'
    ) {
      window.electronAPI.preview.mountSession(currentSessionId, filePath).catch(() => {})
    }

    logger.debug(
      LogCategory.RENDERER,
      `[usePreviewSession] 激活预览会话: gen=${currentGen}, session=${currentSessionId}, file=${filePath}`
    )

    // 组件卸载时清理会话
    return () => {
      abortControllerRef.current.abort()
      if (typeof window?.electronAPI?.preview?.unmountSession === 'function' && currentSessionId) {
        window.electronAPI.preview.unmountSession(currentSessionId).catch(() => {})
      }
    }
  }, [filePath, isPrivate])

  const onCandidateReady = useCallback(() => {
    setIsLoading(false)
    setHasFailedCurrent(false)
  }, [])

  const onRetryNext = useCallback(() => {
    setHasFailedCurrent(true)
    setIsLoading(true)
    setCursor(prev => {
      const next = prev + 1
      if (next < candidates.length) {
        logger.info(
          LogCategory.RENDERER,
          `[usePreviewSession] 候选者降级: ${candidates[prev]?.id} -> ${candidates[next]?.id}`
        )
        return next
      }
      return prev
    })
  }, [candidates])

  const onCandidateError = useCallback(
    (err?: Error) => {
      logger.warn(
        LogCategory.RENDERER,
        `[usePreviewSession] 当前候选者渲染失败 (${currentCandidate.id}): ${err?.message}`
      )
      onRetryNext()
    },
    [currentCandidate.id, onRetryNext]
  )

  const session: PreviewSession = {
    sessionId,
    requestId: context.requestId,
    generation,
    filePath,
    abortController: abortControllerRef.current,
    cursor,
    candidates
  }

  return {
    session,
    context,
    currentCandidate,
    isLoading,
    hasFailedCurrent,
    onCandidateReady,
    onCandidateError,
    onRetryNext
  }
}
