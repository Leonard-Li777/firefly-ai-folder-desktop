import { useState, useCallback, useEffect } from 'react'
import { FileCategory, getFileCategory } from '@firefly/shared'

interface UsePreviewContentProps {
  filePath: string
  fileName: string
  extension: string
}

interface UsePreviewContentReturn {
  showRawText: boolean
  setShowRawText: (show: boolean) => void
  rawTextContent: string | null
  isTextLoading: boolean
  isTextCapable: boolean
  showSwitch: boolean
  category: FileCategory
}

/**
 * 预览内容逻辑 hook
 * 用于分栏模式、全屏模式、新窗口模式共享预览内容逻辑
 */
export function usePreviewContent({
  filePath,
  fileName,
  extension
}: UsePreviewContentProps): UsePreviewContentReturn {
  const [showRawText, setShowRawText] = useState(false)
  const [rawTextContent, setRawTextContent] = useState<string | null>(null)
  const [isTextLoading, setIsTextLoading] = useState(false)
  const [isTextFile, setIsTextFile] = useState<boolean | null>(null)

  const category = extension ? getFileCategory('file.' + extension) : getFileCategory(fileName)

  const showSwitch = category === FileCategory.TEXT || category === FileCategory.CODE

  const isTextCapable =
    category === FileCategory.TEXT ||
    category === FileCategory.EBOOK ||
    category === FileCategory.CODE ||
    (category === FileCategory.UNKNOWN && isTextFile === true)

  useEffect(() => {
    setShowRawText(false)
    setRawTextContent(null)
    setIsTextFile(null)
  }, [filePath])

  useEffect(() => {
    if (category !== FileCategory.UNKNOWN) {
      setIsTextFile(null)
      return
    }
    window.electronAPI
      ?.getFileAnalysisResult?.(filePath)
      ?.then(result => setIsTextFile(result?.category?.is_text ?? false))
      ?.catch(() => setIsTextFile(false))
  }, [filePath, category])

  const loadRawText = useCallback(async () => {
    if (!filePath) return
    setIsTextLoading(true)
    try {
      let targetPath = filePath
      if (window.electronAPI?.utils?.preprocessTextFile) {
        try {
          targetPath = await window.electronAPI.utils.preprocessTextFile(filePath)
        } catch {
          // 预处理失败，使用原路径
        }
      }
      const base64Data = await window.electronAPI.utils.readFileBase64(targetPath)
      const base64Content = base64Data.split(',')[1]
      const decoded = atob(base64Content)
      const decoder = new TextDecoder('utf-8')
      const bytes = new Uint8Array(decoded.length)
      for (let i = 0; i < decoded.length; i++) {
        bytes[i] = decoded.charCodeAt(i)
      }
      setRawTextContent(decoder.decode(bytes))
    } catch {
      setRawTextContent(null)
    } finally {
      setIsTextLoading(false)
    }
  }, [filePath])

  useEffect(() => {
    if (showRawText && isTextCapable && rawTextContent === null && !isTextLoading) {
      loadRawText()
    }
  }, [showRawText, isTextCapable, rawTextContent, isTextLoading, loadRawText])

  return {
    showRawText,
    setShowRawText,
    rawTextContent,
    isTextLoading,
    isTextCapable,
    showSwitch,
    category
  }
}
