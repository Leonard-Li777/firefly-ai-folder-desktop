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
  candidates: PreviewCandidate[]
  cursor: number
  isFallback: boolean
  fallbackFromCandidate: PreviewCandidate | null
  isLoading: boolean
  hasFailedCurrent: boolean
  onCandidateReady: () => void
  onCandidateError: (err?: Error) => void
  onRetryNext: () => void
  resetAndRetry: () => void
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

  // 构造基础 PreviewContext 发生器
  const buildContext = useCallback(
    (gen: number, cur: number, signal: AbortSignal): PreviewContext => ({
      filePath,
      fileName,
      extension: ext,
      fileSize,
      fileFingerprint: getFileFingerprint(filePath, fileSize),
      requestId: `req_${gen}_${cur}`,
      generation: gen,
      signal,
      isPrivate,
      workspaceDirectoryType,
      multimodalContent,
      currentTime,
      highlightRange
    }),
    [
      filePath,
      fileName,
      ext,
      fileSize,
      isPrivate,
      workspaceDirectoryType,
      multimodalContent,
      currentTime,
      highlightRange
    ]
  )

  // 固化当前会话的初始候选栈，避免因运行期熔断缩容导致 cursor 与 candidates 双重步进脱节跳过中间备选
  const [candidates, setCandidates] = useState<PreviewCandidate[]>(() =>
    router.resolveCandidates(buildContext(generation, 0, abortControllerRef.current.signal))
  )

  const context = buildContext(generation, cursor, abortControllerRef.current.signal)
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

      // 重新解析新文件的新会话候选栈
      const nextCandidates = router.resolveCandidates(
        buildContext(currentGen, 0, nextAbortController.signal)
      )
      setCandidates(nextCandidates)

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

  const resetAndRetry = useCallback(() => {
    // 恢复首选候选者的熔断状态并复位游标
    const topCandidate = candidates[0]
    if (topCandidate) {
      router.getCircuitBreaker().resetPlugin(topCandidate.id)
    }
    setCursor(0)
    setIsLoading(true)
    setHasFailedCurrent(false)
  }, [candidates, router])

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
    candidates,
    cursor,
    isFallback: cursor > 0,
    fallbackFromCandidate: cursor > 0 ? candidates[0] : null,
    isLoading,
    hasFailedCurrent,
    onCandidateReady,
    onCandidateError,
    onRetryNext,
    resetAndRetry
  }
}
