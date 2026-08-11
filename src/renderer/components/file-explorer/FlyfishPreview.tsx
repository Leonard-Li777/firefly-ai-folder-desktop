import React from 'react'
import { FlyfishPreview as Viewer } from '../common/FlyfishPreview'
import { useTheme } from '../ui/theme-provider'

interface FlyfishPreviewProps {
  filePath: string
  fileName: string
  extension?: string
}

export const FlyfishPreview: React.FC<FlyfishPreviewProps> = ({ filePath, fileName }) => {
  const { theme } = useTheme()
  return (
    <Viewer filePath={filePath} fileName={fileName} theme={theme === 'auto' ? 'system' : theme} />
  )
}
