/**
 * apps/desktop/src/electron/runtime-services/llm/task-specs/types.ts
 *
 * 统一 TaskSpec 契约接口定义
 * 规范依据：docs/specs/generative-engine-pocket-cpu-and-unified-abstraction-spec.md §4.3, §4.4
 */

import type { GenerativeEngineMode } from '@firefly/shared'

export type TaskId = 'short-name' | 'tag' | 'quality-score' | 'directory-plan'

export type FinishReason = 'stop' | 'length' | 'cancelled' | 'content_filter'

export interface TaskSpec<I, O> {
  taskId: TaskId
  /** 该任务允许运行的引擎底座（如 directory-plan 仅允许 local/cloud，cpu 底座拦截） */
  allowedModes: GenerativeEngineMode[]
  /** 构造系统提示词（根据底座类型自适应 0.3B compact 极简变体或 standard 丰富模板） */
  systemPrompt(mode: GenerativeEngineMode, input: I): string
  /** 构造用户输入提示词 */
  userPrompt(mode: GenerativeEngineMode, input: I): string
  /** 结构化后验解析校验，若不符合契约抛出异常（严禁静默假成功） */
  postValidate(rawOutput: string, finishReason: FinishReason): Promise<O>
}
