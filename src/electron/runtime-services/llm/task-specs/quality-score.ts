/**
 * apps/desktop/src/electron/runtime-services/llm/task-specs/quality-score.ts
 *
 * 文件质量评分任务 TaskSpec (quality-score)
 * 规范依据：docs/specs/generative-engine-pocket-cpu-and-unified-abstraction-spec.md §4.3, §4.4
 */

import type { TaskSpec, FinishReason } from './types'
import { extractBalancedJsonObject, GenerativeEngineMode } from '@firefly/shared'

export interface QualityScoreInput {
  fileName: string
  contentSnippet?: string
  metrics?: Record<string, unknown>
}

export interface QualityScoreOutput {
  score: number // 1..5
  reason?: string
}

export const qualityScoreTaskSpec: TaskSpec<QualityScoreInput, QualityScoreOutput> = {
  taskId: 'quality-score',
  allowedModes: ['cpu', 'local', 'cloud'],

  systemPrompt(mode: GenerativeEngineMode): string {
    if (mode === 'cpu') {
      return 'Rate file quality from 1 to 5. Output JSON: {"score": 5}'
    }
    return (
      '你是一个严谨的文件内容质量评估专家。综合评估文件的完整度、规范性与清晰度，给出 1 到 5 分的评分（整数）。\n' +
      '请严格输出 JSON 格式：\n' +
      '{\n  "score": 5,\n  "reason": "评分理由"\n}'
    )
  },

  userPrompt(_mode: GenerativeEngineMode, input: QualityScoreInput): string {
    const parts = [`文件名: ${input.fileName}`]
    if (input.contentSnippet) parts.push(`正文摘要: ${input.contentSnippet.slice(0, 300)}`)
    return parts.join('\n')
  },

  async postValidate(rawOutput: string, finishReason: FinishReason): Promise<QualityScoreOutput> {
    if (finishReason === 'length') {
      throw new Error('质量评分生成被长度截断 (finishReason=length)')
    }

    const extracted = extractBalancedJsonObject<{ score?: number | string; reason?: string }>(
      rawOutput
    )
    if (!extracted.success) {
      throw new Error(`无法从输出中提取合法评分 JSON: ${extracted.error}`)
    }

    const rawScore = Number(extracted.data?.score)
    if (isNaN(rawScore) || !Number.isInteger(rawScore) || rawScore < 1 || rawScore > 5) {
      throw new Error(`评分必须为 1 到 5 之间的整数，实际得到: ${extracted.data?.score}`)
    }

    return {
      score: rawScore,
      reason: extracted.data?.reason
    }
  }
}
