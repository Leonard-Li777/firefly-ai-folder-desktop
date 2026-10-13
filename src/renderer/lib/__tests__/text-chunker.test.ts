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

  it('分句切片保留句末标点，并遵循字符阈值切分', () => {
    const text = '你好！欢迎使用萤核智能文件夹。这是一个测试长句；请问今天有什么可以帮您的？'
    const chunks = splitTextIntoChunks(text, 50)

    expect(chunks.length).toBe(4)
    expect(chunks[0]).toBe('你好！')
    expect(chunks[1]).toBe('欢迎使用萤核智能文件夹。')
    expect(chunks[2]).toBe('这是一个测试长句；')
    expect(chunks[3]).toBe('请问今天有什么可以帮您的？')
  })

  it('空文本和纯空白字符串安全兜底', () => {
    expect(cleanTextForTTS('')).toBe('')
    expect(splitTextIntoChunks('')).toEqual([])
    expect(splitTextIntoChunks('   \n\t  ')).toEqual([])
  })
})
