// @vitest-environment jsdom

import { describe, it, expect } from 'vitest'
import { formatPluginAuthor } from '../format-plugin-author'

describe('formatPluginAuthor (插件中心作者展示多语言规范)', () => {
  it('官方插件 (official) 必须输出 Firefly 官方', () => {
    const result = formatPluginAuthor({
      author_code: 'official',
      author_name: null
    })
    expect(result).toBe('Firefly 官方')
  })

  it('官方插件即使带有 author_name，仍恒返回 Firefly 官方', () => {
    const result = formatPluginAuthor({
      author_code: 'official',
      author_name: 'Seaeye'
    })
    expect(result).toBe('Firefly 官方')
  })

  it('多语言切换：传入对应语言的翻译函数时动态返回多语言版本', () => {
    // 模拟英文环境
    const mockEnT = (key: string) => {
      if (key === 'Firefly 官方') return 'Firefly Official'
      return key
    }
    expect(formatPluginAuthor({ author_code: 'official' }, mockEnT)).toBe('Firefly Official')

    // 模拟日文环境
    const mockJaT = (key: string) => {
      if (key === 'Firefly 官方') return 'Firefly 公式'
      return key
    }
    expect(formatPluginAuthor({ author_code: 'official' }, mockJaT)).toBe('Firefly 公式')

    // 模拟韩文环境
    const mockKoT = (key: string) => {
      if (key === 'Firefly 官方') return 'Firefly 공식'
      return key
    }
    expect(formatPluginAuthor({ author_code: 'official' }, mockKoT)).toBe('Firefly 공식')
  })

  it('社区贡献 (community) 存在作者名时展示作者真实名', () => {
    const result = formatPluginAuthor({
      author_code: 'community',
      author_name: 'OpenSourceHero'
    })
    expect(result).toBe('OpenSourceHero')
  })

  it('社区贡献 (community) 作者名为空时优雅兜底提示', () => {
    const result = formatPluginAuthor({
      author_code: 'community',
      author_name: '   '
    })
    expect(result).toBe('社区贡献（作者未提供）')
  })

  it('第三方插件 (third_party) 存在作者名时展示第三方名称', () => {
    const result = formatPluginAuthor({
      author_code: 'third_party',
      author_name: 'Autodesk'
    })
    expect(result).toBe('Autodesk')
  })

  it('第三方插件 (third_party) 作者名为空时兜底提示', () => {
    const result = formatPluginAuthor({
      author_code: 'third_party',
      author_name: null
    })
    expect(result).toBe('第三方插件（作者未提供）')
  })

  it('传入 null 或 undefined 时优雅兜底 Firefly 官方防白屏', () => {
    expect(formatPluginAuthor(null)).toBe('Firefly 官方')
    expect(formatPluginAuthor(undefined)).toBe('Firefly 官方')
  })
})
