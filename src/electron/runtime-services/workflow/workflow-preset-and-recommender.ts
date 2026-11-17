/**
 * Electron 运行时工作流推荐器服务接入层
 * 遵循 workflow-config-ssot-unification-spec 规范：
 * 默认连接 local-workflow-source.ts 中的 LOCAL_WORKFLOW_SOURCE 事实源
 */

import {
  recommendWorkflowByProfile as baseRecommendWorkflowByProfile,
  DirectoryProfileStats,
  WorkflowRecommendation,
  BlueprintStaticTemplate
} from '@firefly/shared'
import { LOCAL_WORKFLOW_SOURCE } from '../../config/local-workflow-source'

export type { DirectoryProfileStats, WorkflowRecommendation, BlueprintStaticTemplate }

/**
 * 工作区文件画像工作流推荐器 (纯函数入口)
 *
 * @pure
 * @param stats 只读文件画像统计入参
 * @param templates 可选的工作流模板列表，缺省时默认直读 LOCAL_WORKFLOW_SOURCE() 纯静态事实源
 * @returns 排序后的推荐结果数组 (最多 Top 5)
 */
export function recommendWorkflowByProfile(
  stats: Readonly<DirectoryProfileStats>,
  templates = LOCAL_WORKFLOW_SOURCE()
): WorkflowRecommendation[] {
  return baseRecommendWorkflowByProfile(stats, templates as any)
}
