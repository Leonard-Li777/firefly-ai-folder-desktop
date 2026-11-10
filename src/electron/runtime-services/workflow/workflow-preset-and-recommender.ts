/**
 * Electron 运行时工作流推荐器服务接入层
 * 遵循 Spec v1.1 §3.2 与 Ticket 02 规范：
 * 默认连接 organize-taxonomy-source.ts 中的 BLUEPRINT_STATIC_TEMPLATES 事实源
 */

import {
  recommendWorkflowByProfile as baseRecommendWorkflowByProfile,
  DirectoryProfileStats,
  WorkflowRecommendation,
  BlueprintStaticTemplate
} from '@firefly/shared'
import { BLUEPRINT_STATIC_TEMPLATES } from '../../config/organize-taxonomy-source'

export type { DirectoryProfileStats, WorkflowRecommendation, BlueprintStaticTemplate }

/**
 * 工作区文件画像工作流推荐器 (纯函数入口)
 *
 * @pure
 * @param stats 只读文件画像统计入参
 * @param templates 可选的蓝图静态模板列表，缺省时默认直读 BLUEPRINT_STATIC_TEMPLATES 事实源
 * @returns 排序后的推荐结果数组 (最多 Top 5)
 */
export function recommendWorkflowByProfile(
  stats: Readonly<DirectoryProfileStats>,
  templates: readonly BlueprintStaticTemplate[] = BLUEPRINT_STATIC_TEMPLATES
): WorkflowRecommendation[] {
  return baseRecommendWorkflowByProfile(stats, templates)
}
