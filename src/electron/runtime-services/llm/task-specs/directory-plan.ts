/**
 * apps/desktop/src/electron/runtime-services/llm/task-specs/directory-plan.ts
 *
 * 目录规划重构任务 TaskSpec (directory-plan)
 * 规范依据：docs/specs/generative-engine-pocket-cpu-and-unified-abstraction-spec.md §4.3
 * 铁律：高阶复杂推理任务，仅允许 local (独显) 与 cloud 底座，cpu 底座坚决拦截
 */

import type { TaskSpec, FinishReason } from './types'
import { extractBalancedJsonObject, GenerativeEngineMode } from '@firefly/shared'

export interface DirectoryPlanInput {
  targetFolder: string
  fileList: string[]
  depth?: number
}

export interface DirectoryPlanOutput {
  plan: Record<string, string[]>
  summary: string
}

export const directoryPlanTaskSpec: TaskSpec<DirectoryPlanInput, DirectoryPlanOutput> = {
  taskId: 'directory-plan',
  // 高阶多步骤规划任务：仅允许 local 深度独显版与 cloud 顶级版，cpu 极速版直接拦截
  allowedModes: ['local', 'cloud'],

  systemPrompt(_mode: GenerativeEngineMode): string {
    return (
      '你是一个专业的智能目录重构与文件整理规划专家。根据用户提供的散乱文件列表，生成合理的分类归档子目录规划。\n' +
      '请严格输出 JSON 格式：\n' +
      '{\n  "plan": { "子目录名称": ["file1", "file2"] },\n  "summary": "重构理由"\n}'
    )
  },

  userPrompt(_mode: GenerativeEngineMode, input: DirectoryPlanInput): string {
    return `目标根目录: ${input.targetFolder}\n待整理文件清单:\n${input.fileList.slice(0, 100).join('\n')}`
  },

  async postValidate(rawOutput: string, finishReason: FinishReason): Promise<DirectoryPlanOutput> {
    if (finishReason === 'length') {
      throw new Error('目录规划生成被长度截断 (finishReason=length)')
    }

    const extracted = extractBalancedJsonObject<{
      plan?: Record<string, string[]>
      summary?: string
    }>(rawOutput)

    if (!extracted.success || !extracted.data?.plan) {
      throw new Error(`无法从输出中提取合法目录规划 JSON: ${extracted.error || 'plan 字段缺失'}`)
    }

    return {
      plan: extracted.data.plan,
      summary: extracted.data.summary || '已根据语义重新组织目录'
    }
  }
}
