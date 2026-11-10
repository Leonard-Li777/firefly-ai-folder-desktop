/**
 * apps/desktop/src/electron/runtime-services/llm/task-specs/tag.ts
 *
 * 语义打标任务 TaskSpec (tag)
 * 规范依据：docs/specs/generative-engine-pocket-cpu-and-unified-abstraction-spec.md §4.3, §4.4
 * 必须遵守 controlled-concepts-guide.md G1/G2 准入门禁
 */

import type { TaskSpec, FinishReason } from './types'
import {
  extractBalancedJsonObject,
  isCandidateWordAdmissible,
  isControlledConcept,
  concept,
  GenerativeEngineMode
} from '@firefly/shared'

export interface TagTaskInput {
  fileName: string
  contentSnippet?: string
  existingTags?: string[]
}

export interface TagItem {
  tag: string
  code: string
  isControlled: boolean
}

export interface TagTaskOutput {
  tags: string[]
  conceptCodes: string[]
  items?: TagItem[]
}

export const tagTaskSpec: TaskSpec<TagTaskInput, TagTaskOutput> = {
  taskId: 'tag',
  allowedModes: ['cpu', 'local', 'cloud'],

  systemPrompt(mode: GenerativeEngineMode): string {
    if (mode === 'cpu') {
      return 'Extract key topic tags from document. Output JSON: {"tags": ["tag1", "tag2"]}'
    }
    return (
      '你是一个严谨的语义实体与概念打标助手。从提供的文档或文件名中提取 1~5 个核心主题/实体标签。\n' +
      '请严格输出 JSON 格式：\n' +
      '{\n  "tags": ["标签1", "标签2"]\n}'
    )
  },

  userPrompt(_mode: GenerativeEngineMode, input: TagTaskInput): string {
    const parts = [`文件名: ${input.fileName}`]
    if (input.contentSnippet) parts.push(`正文摘要: ${input.contentSnippet.slice(0, 400)}`)
    return parts.join('\n')
  },

  async postValidate(rawOutput: string, finishReason: FinishReason): Promise<TagTaskOutput> {
    if (finishReason === 'length') {
      throw new Error('标签生成被长度截断 (finishReason=length)')
    }

    const extracted = extractBalancedJsonObject<{ tags?: string[] }>(rawOutput)
    if (!extracted.success || !Array.isArray(extracted.data?.tags)) {
      throw new Error(`无法从输出中提取合法标签列表: ${extracted.error || 'tags 缺失'}`)
    }

    // 强制执行 controlled-concepts-guide.md G1/G2 准入把关与过滤，并映射为受控本体码
    const admittedTags: string[] = []
    const conceptCodes: string[] = []
    const items: TagItem[] = []

    for (const rawTag of extracted.data.tags) {
      if (typeof rawTag !== 'string') continue
      const tag = rawTag.trim()
      if (!tag) continue

      // G1/G2 准入校验：拦截停用词、坏码位、未受控虚词与非实体短语
      const check = isCandidateWordAdmissible(tag)
      if (check.admissible) {
        admittedTags.push(tag)
        const isControlled = isControlledConcept(tag)
        const code = isControlled ? concept(tag as any) : `_ext.${tag.replace(/[\s\t\n]+/g, '_')}`
        conceptCodes.push(code)
        items.push({ tag, code, isControlled })
      }
    }

    return {
      tags: admittedTags,
      conceptCodes,
      items
    }
  }
}
