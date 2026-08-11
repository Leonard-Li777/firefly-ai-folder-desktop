import { useState, useEffect, useCallback } from 'react'

interface UseNavigationHistoryProps {
  selectedId: number | null
  virtualCurrentPath: string
  handleVirtualNavigate: (path: string) => void
}

export const useNavigationHistory = ({
  selectedId,
  virtualCurrentPath,
  handleVirtualNavigate
}: UseNavigationHistoryProps) => {
  const [navigationHistory, setNavigationHistory] = useState<string[]>([])
  const [currentHistoryIndex, setCurrentHistoryIndex] = useState(-1)
  const [isHistoryNavigation, setIsHistoryNavigation] = useState(false)

  // 监听虚拟路径变化并压栈
  useEffect(() => {
    if (virtualCurrentPath && navigationHistory[currentHistoryIndex] !== virtualCurrentPath) {
      if (isHistoryNavigation) {
        setIsHistoryNavigation(false)
        return
      }

      setNavigationHistory(prev => {
        const newHistory = prev.slice(0, currentHistoryIndex + 1)
        newHistory.push(virtualCurrentPath)
        return newHistory
      })
      setCurrentHistoryIndex(prev => prev + 1)
    }
  }, [virtualCurrentPath, isHistoryNavigation, navigationHistory, currentHistoryIndex])

  // 切换虚拟目录时，重置历史
  useEffect(() => {
    setNavigationHistory([])
    setCurrentHistoryIndex(-1)
  }, [selectedId])

  const handleBack = useCallback(() => {
    if (currentHistoryIndex > 0) {
      const previousPath = navigationHistory[currentHistoryIndex - 1]
      setIsHistoryNavigation(true)
      setCurrentHistoryIndex(prev => prev - 1)
      handleVirtualNavigate(previousPath)
    }
  }, [currentHistoryIndex, navigationHistory, handleVirtualNavigate])

  const handleForward = useCallback(() => {
    if (currentHistoryIndex < navigationHistory.length - 1) {
      const nextPath = navigationHistory[currentHistoryIndex + 1]
      setIsHistoryNavigation(true)
      setCurrentHistoryIndex(prev => prev + 1)
      handleVirtualNavigate(nextPath)
    }
  }, [currentHistoryIndex, navigationHistory, handleVirtualNavigate])

  const handleUp = useCallback(() => {
    const sep = window.electronAPI!.utils.getPlatform?.() === 'win32' ? '\\' : '/'
    const parts = virtualCurrentPath.split(sep).filter(Boolean)
    if (parts.length > 1) {
      const parentPath = parts.slice(0, parts.length - 1).join(sep)
      handleVirtualNavigate(parentPath)
    }
  }, [virtualCurrentPath, handleVirtualNavigate])

  return {
    navigationHistory,
    currentHistoryIndex,
    handleBack,
    handleForward,
    handleUp
  }
}
