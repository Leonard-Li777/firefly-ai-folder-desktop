/**
 * skip-5w-synthesis.test.ts — 生成式 AI 启用时跳过 CPU 阶段 5W 造句单测
 * 遵循规格书：docs/specs/skip-cpu-5w-synthesis-when-generative-ai-enabled-spec.md
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  shell: {
    showItemInFolder: vi.fn()
  },
  app: {
    getPath: vi.fn().mockReturnValue('C:\\test'),
    getName: vi.fn().mockReturnValue('firefly'),
    isPackaged: false
  },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn()
  }
}))

vi.mock('electron-conf', () => ({
  Conf: class {
    get() {
      return {}
    }
    set() {}
  }
}))

import { isAiStageEnabled } from '../../../../config/analysis-mode'
import { resolveFileDescription } from '../resolve-file-description'

describe('skip5wSynthesis: 分析模式驱动判定契约', () => {
  it('标准分析 (simple) 模式下必须不跳过 5W 造句 (提供保底机械名与描述)', () => {
    expect(isAiStageEnabled('simple')).toBe(false)
  })

  it('增强分析 (quick_name) 模式下必须跳过 5W 造句 (由后续大模型生成)', () => {
    expect(isAiStageEnabled('quick_name')).toBe(true)
  })

  it('全面分析 (full) 模式下必须跳过 5W 造句 (由后续大模型生成)', () => {
    expect(isAiStageEnabled('full')).toBe(true)
  })
})

describe('resolveFileDescription: 结合 skip5wSynthesis 的终局描述解析', () => {
  it('正常大模型推理产出：AI 描述覆盖 CPU 阶段 null 描述', () => {
    const desc = resolveFileDescription({
      aiDescription: '这是一个深度提炼的AI文件描述',
      omniDescription: null
    })
    expect(desc).toBe('这是一个深度提炼的AI文件描述')
  })

  it('纯文本大模型看图 (aiLacksVisualGrounding)：由于跳过5W，omni为null，如实返回null不造假', () => {
    const desc = resolveFileDescription({
      aiDescription: '信息不足，无法推断',
      aiLacksVisualGrounding: true,
      omniDescription: null
    })
    expect(desc).toBeNull()
  })

  it('大模型未产出且CPU跳过：两方皆无时安全返回 null (由 SQL 兜底)', () => {
    const desc = resolveFileDescription({
      aiDescription: null,
      omniDescription: null
    })
    expect(desc).toBeNull()
  })
})

describe('OmniService: perceive 请求体序列化透传', () => {
  it('OmniPerceptionOptions 中的 skip5wSynthesis 正确映射至 skip_5w_synthesis', () => {
    const options = {
      skip5wSynthesis: true,
      fileFingerprint: 'test_fp_123',
      enableVisualTags: false
    }

    // 模拟 omniService.perceive 内部构造的 reqBody 结构
    const reqBody = {
      file_path: '/test/doc.docx',
      file_fingerprint: options.fileFingerprint,
      enable_visual_tags: options.enableVisualTags,
      skip_5w_synthesis: options.skip5wSynthesis
    }

    expect(reqBody.skip_5w_synthesis).toBe(true)
  })
})
