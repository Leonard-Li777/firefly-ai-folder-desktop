/**
 * PreviewContent 异步按需边界（预览根拆包）
 *
 * 三个预览宿主（PreviewOverlay / SplitPreviewPanel / FilePreviewPanel）统一经本边界
 * 消费 PreviewContent：预览内容子树（含重型预览器依赖）整体拆为独立异步 chunk，
 * 主渲染首屏 bundle 不再承载；首次打开预览时按需加载，Suspense 占位与既有加载态一致。
 */
import React, { Suspense, lazy } from 'react'
import type { PreviewContentProps } from './PreviewContent'

const PreviewContentImpl = lazy(() =>
  import('./PreviewContent').then(m => ({ default: m.PreviewContent }))
)

export const PreviewContent: React.FC<PreviewContentProps> = props => (
  <Suspense
    fallback={
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    }
  >
    <PreviewContentImpl {...props} />
  </Suspense>
)

export default PreviewContent
