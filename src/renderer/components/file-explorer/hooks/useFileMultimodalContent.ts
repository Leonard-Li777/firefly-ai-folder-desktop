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

  const fetchContent = useCallback(async () => {
    if (!filePath) {
      setMultimodalContent(null)
      setLoading(false)
      return
    }

    setLoading(true)
    try {
      const result = await window.electronAPI?.getFileAnalysisResult?.(filePath)
      setMultimodalContent(result?.multimodalContent || null)
    } catch {
      setMultimodalContent(null)
    } finally {
      setLoading(false)
    }
  }, [filePath])

  // 1. 当 filePath 变化时，立即请求一次
  useEffect(() => {
    lastSeenStatusRef.current = null
    fetchContent()
  }, [fetchContent])

  // 2. 监听分析队列更新事件，当该文件分析完成时立即刷新
  useEffect(() => {
    if (!filePath || !window.electronAPI?.onAnalysisQueueUpdated) return

    const cleanup = window.electronAPI.onAnalysisQueueUpdated((snapshot: any) => {
      const isPathEqual = window.electronAPI?.utils?.isPathEqual
      const items = snapshot?.items || []
      const queueItem = items.find((i: any) =>
        i.path && isPathEqual ? isPathEqual(i.path, filePath) : i.path === filePath
      )

      if (queueItem) {
        if (queueItem.status === 'completed' && lastSeenStatusRef.current !== 'completed') {
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
