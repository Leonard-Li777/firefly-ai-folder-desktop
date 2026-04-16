import { describe, it, expect } from 'vitest'

/**
 * 模拟 handleRedeem 中的提取逻辑
 */
function extractCode(input: string): string {
  let code = input.trim()
  if (!code) return ''
  
  const base62Match = code.match(/[a-zA-Z0-9]{16}/)
  if (base62Match) {
    return base62Match[0]
  }
  return code
}

describe('Invitation Code Extraction (Regex)', () => {
  it('应该能从纯邀请码中提取', () => {
    const input = '2dxw3ZRN7O7ABLJG'
    expect(extractCode(input)).toBe('2dxw3ZRN7O7ABLJG')
  })

  it('应该能从完整 URL 中提取', () => {
    const input = 'https://ai-folder.com/download?ref=2dxw3ZRN7O7ABLJG&source=share'
    expect(extractCode(input)).toBe('2dxw3ZRN7O7ABLJG')
  })

  it('应该能从带空格或杂质的字符串中提取', () => {
    const input = ' 我的邀请码是 [2dxw3ZRN7O7ABLJG] 快来使用 '
    expect(extractCode(input)).toBe('2dxw3ZRN7O7ABLJG')
  })

  it('如果没找到 16 位 Base62，应返回原字符串 (用于处理短码等潜在情况)', () => {
    const input = 'short-code'
    expect(extractCode(input)).toBe('short-code')
  })
})
