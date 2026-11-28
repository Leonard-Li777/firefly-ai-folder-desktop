import { useState, useEffect, useRef, useCallback } from 'react'

/**
 * 获取文件的多模态描述内容
 * 当 filePath 变化或文件刚分析完成时，自动请求最新的分析结果并提取 multimodalContent 字段
 */
export function useFileMultimodalContent(filePath: string): {
  multimodalContent: string | null
  loading: boolean
  refresh: () => Promise<void>
} {
  const [multimodalContent, setMultimodalContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const lastSeenStatusRef = useRef<string | null>(null)
  const seenTerminalDeltaKeysRef = useRef<Set<string>>(new Set())
  const requestSeqRef = useRef<number>(0)
  const isMountedRef = useRef<boolean>(true)

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  const fetchContent = useCallback(async () => {
    const seq = ++requestSeqRef.current
    if (!filePath) {
      if (isMountedRef.current) {
        setMultimodalContent(null)
        setLoading(false)
      }
      return
    }

    if (isMountedRef.current) setLoading(true)
    try {
      const result = await window.electronAPI?.getFileAnalysisResult?.(filePath)
      if (!isMountedRef.current || seq !== requestSeqRef.current) return
      setMultimodalContent(result?.multimodalContent || null)
    } catch {
      if (!isMountedRef.current || seq !== requestSeqRef.current) return
      setMultimodalContent(null)
    } finally {
      if (isMountedRef.current && seq === requestSeqRef.current) {
        setLoading(false)
      }
    }
  }, [filePath])

  // 1. 当 filePath 变化时，立即请求一次
  useEffect(() => {
    lastSeenStatusRef.current = null
    seenTerminalDeltaKeysRef.current.clear()
    fetchContent()
  }, [fetchContent])

  // 2. 监听分析队列更新事件，当该文件分析完成时立即刷新（接入双轨 terminalDeltas）
  useEffect(() => {
    if (!filePath || !window.electronAPI?.onAnalysisQueueUpdated) return

    const cleanup = window.electronAPI.onAnalysisQueueUpdated((rawPayload: any) => {
      const isPathEqual = window.electronAPI?.utils?.isPathEqual
      const isDualTrack = Boolean(
        rawPayload &&
        typeof rawPayload === 'object' &&
        'snapshot' in rawPayload &&
        rawPayload.snapshot
      )
      const snapshot = isDualTrack ? rawPayload.snapshot : rawPayload
      const terminalDeltas: any[] =
        isDualTrack && Array.isArray(rawPayload.terminalDeltas) ? rawPayload.terminalDeltas : []

      let handledByDelta = false
      for (const delta of terminalDeltas) {
        const matched =
          delta?.path && (isPathEqual ? isPathEqual(delta.path, filePath) : delta.path === filePath)
        if (!matched) continue
        const dedupeKey = `${delta.id}:${delta.status}:${delta.updatedAt}`
        if (seenTerminalDeltaKeysRef.current.has(dedupeKey)) continue
        seenTerminalDeltaKeysRef.current.add(dedupeKey)
        if (delta.status === 'completed') {
          handledByDelta = true
          lastSeenStatusRef.current = 'completed'
          fetchContent()
        } else {
          lastSeenStatusRef.current = delta.status
        }
      }
      if (handledByDelta) return

      const items = snapshot?.items || []
      const queueItem = items.find((i: any) =>
        i.path && isPathEqual ? isPathEqual(i.path, filePath) : i.path === filePath
      )

      if (queueItem) {
        if (
          !isDualTrack &&
          queueItem.status === 'completed' &&
          lastSeenStatusRef.current !== 'completed'
        ) {
          lastSeenStatusRef.current = 'completed'
          fetchContent()
        } else {
          lastSeenStatusRef.current = queueItem.status
        }
      }
    })

    return () => {
      cleanup?.()
    }
  }, [filePath, fetchContent])

  // 3. 监听全局文件数据更新事件（如 smartname-updated, files-updated）
  useEffect(() => {
    if (!filePath) return

    const handleUpdate = () => {
      fetchContent()
    }

    window.addEventListener('smartname-updated', handleUpdate)
    window.addEventListener('files-updated', handleUpdate)

    return () => {
      window.removeEventListener('smartname-updated', handleUpdate)
      window.removeEventListener('files-updated', handleUpdate)
    }
  }, [filePath, fetchContent])

  return { multimodalContent, loading, refresh: fetchContent }
}
