import type { AnalysisMode } from '@firefly/types'

/**
 * 判定 CPU 阶段结束、进入 `if (phase === 'cpu')` 提前返回之前，
 * 是否需要即时将 Stage 2（fact / fused / visual）标签持久化到 `file_tag_relations`。
 *
 * 为什么不能仅按 `analysisMode === 'full' || analysisMode === 'quick_name'` 判定：
 * 双阶段调度器以 `phase === 'cpu'` 调用 `processFile` 时，函数会在 `if (phase === 'cpu')`
 * 处提前返回；对于 `simple` 模式，后续不再进入 GPU 阶段，而是由 Worker 直接调用
 * `completeAsCpuOnly` 收口。若此处跳过落库，Stage 2 产出的标签会在内存中算完即丢弃。
 * 而在全量单阶段（`phase === 'all'`）下，`simple` 模式会继续执行到后半段的 `simple` 落库分支，
 * 故 `phase !== 'cpu'` 时仍仅对 `full` / `quick_name` 提前落库以避免重复写入。
 */
export function shouldPersistStage2TagsBeforePhaseReturn(
  phase: 'cpu' | 'gpu' | 'all',
  analysisMode: AnalysisMode | string,
  hasPreflightContext: boolean
): boolean {
  if (!hasPreflightContext) {
    return false
  }
  if (phase === 'cpu') {
    return true
  }
  return analysisMode === 'full' || analysisMode === 'quick_name'
}
