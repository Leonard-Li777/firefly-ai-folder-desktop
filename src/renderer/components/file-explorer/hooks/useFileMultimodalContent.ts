import { useState, useEffect, useRef } from 'react'

/**
 * 获取文件的多模态描述内容
 * 当 filePath 变化时自动请求分析结果，提取 multimodalContent 字段
 */
export function useFileMultimodalContent(filePath: string): {
  multimodalContent: string | null
  loading: boolean
} {
  const [multimodalContent, setMultimodalContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const lastPathRef = useRef<string>('')

  useEffect(() => {
    if (!filePath) {
      setMultimodalContent(null)
      setLoading(false)
      lastPathRef.current = ''
      return
    }

    // 相同路径不重复请求
    if (lastPathRef.current === filePath) return

    lastPathRef.current = filePath
    let cancelled = false

    const fetchContent = async () => {
      setLoading(true)
      try {
        const result = await window.electronAPI?.getFileAnalysisResult?.(filePath)
        if (!cancelled) {
          setMultimodalContent(result?.multimodalContent || null)
        }
      } catch {
        if (!cancelled) {
          setMultimodalContent(null)
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    fetchContent()

    return () => {
      cancelled = true
    }
  }, [filePath])

  return { multimodalContent, loading }
}
