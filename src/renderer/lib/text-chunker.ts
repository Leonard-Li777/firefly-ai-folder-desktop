/**
 * 文本清洗与分句切片工具
 * apps/desktop/src/renderer/lib/text-chunker.ts
 *
 * 职责：
 * 1. 过滤 Markdown 语法标记（标题、图片、链接、代码块、粗斜体等）
 * 2. 剥离 LRC 歌词时间戳与头部元数据
 * 3. 基于句末标点将长文本切分为适合 Kokoro 离线合成的自然短句序列
 */

/**
 * 剥离 Markdown 语法标记，保留纯文本朗读内容
 */
export function stripMarkdown(markdown: string): string {
  if (!markdown) return ''

  return markdown
    // 移除多行代码块
    .replace(/```[\s\S]*?```/g, '')
    // 移除行内代码标记，保留文字
    .replace(/`([^`]+)`/g, '$1')
    // 移除图片 ![alt](url)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '')
    // 转换链接 [text](url) 为 text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // 移除 HTML 标签
    .replace(/<[^>]+>/g, '')
    // 移除标题井号
    .replace(/^\s*#{1,6}\s+/gm, '')
    // 移除粗体/斜体/删除线
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    // 移除引用符号 >
    .replace(/^\s*>\s+/gm, '')
    // 移除列表标记 -, +, *, 1.
    .replace(/^\s*[-+*]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    // 移除水平分割线
    .replace(/^\s*[-*_]{3,}\s*$/gm, '')
    // 压缩连续多个空行
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 剥离 LRC 歌词中的时间戳与元数据标签
 */
export function stripLrcTimestamps(lrc: string): string {
  if (!lrc) return ''

  return lrc
    // 移除头部元标签 [ti:title], [ar:artist], etc.
    .replace(/\[(ti|ar|al|by|offset|length):[^\]]*\]/gi, '')
    // 移除歌词时间戳 [00:12.34] 或 [01:23.456]
    .replace(/\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]/g, '')
    // 规范化空行
    .replace(/\n{2,}/g, '\n')
    .trim()
}

/**
 * 综合清洗面向 TTS 的原始文本
 */
export function cleanTextForTTS(text: string, options?: { isLrc?: boolean }): string {
  if (!text) return ''
  let cleaned = text

  if (options?.isLrc) {
    cleaned = stripLrcTimestamps(cleaned)
  }

  // 统一清洗 Markdown 符号
  cleaned = stripMarkdown(cleaned)

  // 修复非句末标点（如逗号、顿号、冒号等）后的排版软换行，合并为单句防断句失真
  cleaned = cleaned.replace(/([，,、:：])\s*[\r\n]+\s*/g, '$1')

  // 替换连续空白字符，保留换行
  cleaned = cleaned.replace(/[ \t]+/g, ' ')

  return cleaned.trim()
}

/**
 * 将长文本拆解为若干自然短句，保留句末标点
 * @param text 清洗后的纯文本
 * @param maxChunkLength 单句最大字符阈值（超过则按逗号二次切分，防推理超时）
 */
export function splitTextIntoChunks(text: string, maxChunkLength = 120): string[] {
  if (!text || !text.trim()) return []

  // 1. 基于句末标点正则初次切句：包含句号、问号、叹号、分号及换行符
  const rawSentences = text.match(/[^。！？；\n\r.!?]+[。！？；\n\r.!?]*/g) || [text]

  const chunks: string[] = []

  for (const raw of rawSentences) {
    const trimmed = raw.trim()
    if (!trimmed) continue

    // 2. 若单句在阈值内，直接保留
    if (trimmed.length <= maxChunkLength) {
      chunks.push(trimmed)
      continue
    }

    // 3. 超过最大阈值，按逗号/空格等次级停顿符号二次拆分
    const subMatches = trimmed.match(/[^，,、 ]+[，,、 ]*/g)
    if (!subMatches || subMatches.length === 1) {
      // 无法通过逗号进一步切分（如无停顿超长单句），按硬长度分块
      let start = 0
      while (start < trimmed.length) {
        chunks.push(trimmed.slice(start, start + maxChunkLength))
        start += maxChunkLength
      }
      continue
    }

    // 贪婪拼合次级短句，使其逼近 maxChunkLength
    let currentBuffer = ''
    for (const sub of subMatches) {
      if (currentBuffer.length + sub.length > maxChunkLength && currentBuffer.length > 0) {
        chunks.push(currentBuffer.trim())
        currentBuffer = sub
      } else {
        currentBuffer += sub
      }
    }
    if (currentBuffer.trim()) {
      chunks.push(currentBuffer.trim())
    }
  }

  // 自然返回切分后的语义短句（杜绝强制空格拼接中文短句制造的停顿失真）
  return chunks.map(c => c.trim()).filter(Boolean)
}
