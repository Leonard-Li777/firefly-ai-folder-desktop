/**
 * apps/desktop/src/electron/runtime-services/llm/task-specs/short-name.ts
 *
 * 智能文件名提炼任务 TaskSpec (short-name)
 * 规范依据：docs/specs/generative-engine-pocket-cpu-and-unified-abstraction-spec.md §4.3, §4.4
 */

import type { TaskSpec, FinishReason } from './types'
import {
  extractBalancedJsonObject,
  sanitizeFileNameStrict,
  GenerativeEngineMode
} from '@firefly/shared'

export interface ShortNameInput {
  originalName: string
  extension?: string
  contentSnippet?: string
  tags?: string[]
}

export interface ShortNameOutput {
  name: string
  reason?: string
}

export const shortNameTaskSpec: TaskSpec<ShortNameInput, ShortNameOutput> = {
  taskId: 'short-name',
  allowedModes: ['cpu', 'local', 'cloud'],

  systemPrompt(mode: GenerativeEngineMode): string {
    if (mode === 'cpu') {
      // 0.3B compact 极简引导
      return 'You are a file naming expert. Extract a concise, clean filename. Output JSON: {"name": "..."}'
    }
    return (
      '你是一个专业的文件智能命名提炼助手。根据用户提供的原文件名、扩展名、正文摘要与标签，提炼出一个简洁、规范、可读性高的智能文件名。\n' +
      '请严格输出 JSON 格式：\n' +
      '{\n  "name": "规范文件名",\n  "reason": "命名理由"\n}'
    )
  },

  userPrompt(_mode: GenerativeEngineMode, input: ShortNameInput): string {
    const parts = [`原文件名: ${input.originalName}`]
    if (input.extension) parts.push(`格式扩展名: ${input.extension}`)
    if (input.tags && input.tags.length > 0) parts.push(`语义标签: ${input.tags.join(', ')}`)
    if (input.contentSnippet) parts.push(`正文摘要: ${input.contentSnippet.slice(0, 300)}`)
    return parts.join('\n')
  },

  async postValidate(rawOutput: string, finishReason: FinishReason): Promise<ShortNameOutput> {
    if (finishReason === 'length') {
      throw new Error('文件名生成被长度截断 (finishReason=length)')
    }

    const extracted = extractBalancedJsonObject<{ name?: string; reason?: string }>(rawOutput)
    if (!extracted.success || !extracted.data?.name) {
      throw new Error(`无法从输出中提取合法的文件名 JSON: ${extracted.error || 'name 缺失'}`)
    }

    // 执行严格 8 步安全净化管线
    const cleanName = sanitizeFileNameStrict(extracted.data.name, { finishReason })
    return {
      name: cleanName,
      reason: extracted.data.reason
    }
  }
}
