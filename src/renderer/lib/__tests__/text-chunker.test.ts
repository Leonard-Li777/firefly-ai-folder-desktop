import { describe, it, expect } from 'vitest'
import {
  stripMarkdown,
  stripLrcTimestamps,
  cleanTextForTTS,
  splitTextIntoChunks
} from '../text-chunker'

describe('text-chunker - 文本清洗与分句切片测试', () => {
  it('正确剥离 Markdown 语法标记，保留纯朗读文本', () => {
    const md = `
# 标题一
这是一段包含 **粗体文字** 和 *斜体文字* 的介绍。
还包含一个 [链接文字](https://example.com) 以及图片 ![图片描述](https://img.png)。

\`\`\`javascript
const code = 'block';
\`\`\`

行内代码 \`console.log("hello")\` 也应该保留文本。
> 这是引用内容
- 列表项1
- 列表项2
    `.trim()

    const cleaned = stripMarkdown(md)
    expect(cleaned).not.toContain('#')
    expect(cleaned).not.toContain('**')
    expect(cleaned).not.toContain('![图片描述]')
    expect(cleaned).toContain('粗体文字')
    expect(cleaned).toContain('斜体文字')
    expect(cleaned).toContain('链接文字')
    expect(cleaned).not.toContain('https://example.com')
    expect(cleaned).toContain('console.log("hello")')
    expect(cleaned).toContain('列表项1')
  })

  it('正确剔除 LRC 歌词时间戳与头部元数据', () => {
    const lrc = `
[ti:月亮代表我的心]
[ar:邓丽君]
[al:岛国之情歌第二集]
[00:01.00]你问我爱你有多深
[00:05.500]我爱你有几分
[00:10.20]我的情也真，我的爱也真
    `.trim()

    const cleaned = stripLrcTimestamps(lrc)
    expect(cleaned).not.toContain('[ti:')
    expect(cleaned).not.toContain('[00:01.00]')
    expect(cleaned).not.toContain('[00:05.500]')
    expect(cleaned).toContain('你问我爱你有多深')
    expect(cleaned).toContain('我爱你有几分')
    expect(cleaned).toContain('我的情也真，我的爱也真')
  })

  it('短文本未达下限时贪婪聚合为饱满单句，避免过碎碎片断音', () => {
    const text = '你好！欢迎使用萤核智能文件夹。这是一个测试长句；请问今天有什么可以帮您的？'
    // 默认 minChunkLength = 45，由于总长 39 < 45，贪婪合并为 1 句，朗读约 8s，推理仅需 1.5s
    const chunks = splitTextIntoChunks(text)

    expect(chunks.length).toBe(1)
    expect(chunks[0]).toBe('你好！欢迎使用萤核智能文件夹。这是一个测试长句；请问今天有什么可以帮您的？')
  })

  it('长文本切片遵循 45~120 字符饱满度聚合与句末标点保留', () => {
    const longText =
      '第一章开始。晨光透过窗帘洒在书桌上，微风轻轻拂过窗台的花草，带来了清新的泥土芬芳。少年伸了个懒腰，揉了揉惺忪的睡眼，推开房门走向阳台。今天是个风和日丽的好天气。他下定决心，要完成那份搁置已久的研究计划。'
    const chunks = splitTextIntoChunks(longText, 120, 45)

    expect(chunks.length).toBeGreaterThan(1)
    // 每个切片（除收尾句外）字符数均满足 >= 45 且 <= 120
    for (let i = 0; i < chunks.length - 1; i++) {
      expect(chunks[i].length).toBeGreaterThanOrEqual(45)
      expect(chunks[i].length).toBeLessThanOrEqual(120)
    }
    // 保持原始标点
    expect(chunks[0]).toContain('。')
  })

  it('超长无句号段落按逗号等次级标点优雅拆解', () => {
    const commaText =
      '在这个宁静而又充满希望的早晨，阳光洒满了整个大地，微风吹拂着树梢上的嫩叶，鸟儿在枝头欢快地歌唱，远处的群山在薄雾中若隐若现，小溪潺潺流淌穿过森林，仿佛一切都在诉说着大自然的美好与生机。'
    const chunks = splitTextIntoChunks(commaText, 60, 30)

    expect(chunks.length).toBeGreaterThanOrEqual(2)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(60)
    }
  })

  it('显式指定极小阈值时兼容严格按句切分', () => {
    const text = '你好！欢迎使用。再见！'
    const chunks = splitTextIntoChunks(text, 20, 1)

    expect(chunks.length).toBe(3)
    expect(chunks[0]).toBe('你好！')
    expect(chunks[1]).toBe('欢迎使用。')
    expect(chunks[2]).toBe('再见！')
  })

  it('空文本和纯空白字符串安全兜底', () => {
    expect(cleanTextForTTS('')).toBe('')
    expect(splitTextIntoChunks('')).toEqual([])
    expect(splitTextIntoChunks('   \n\t  ')).toEqual([])
  })
})
