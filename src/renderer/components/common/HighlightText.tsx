import React, { useMemo } from 'react'
import { splitTextForHighlight } from '@firefly/shared'
import { useSearchStore } from '../../stores/search-store'
import { cn } from '../../lib/utils'

export interface HighlightTextProps {
  /** 待展示并可能高亮的文本 */
  text: string
  /** 显式传入的分词列表（优先于全局状态） */
  tokens?: string[]
  /** 显式传入的查询关键词（若未传 tokens，可传单个 keyword） */
  keyword?: string
  /** 外部样式容器类名 */
  className?: string
  /** 高亮 <mark> 标签自定义样式 */
  markClassName?: string
  /** 原生 HTML title */
  title?: string
  /** 是否禁用高亮 */
  disabled?: boolean
}

export const HighlightText: React.FC<HighlightTextProps> = React.memo(({
  text,
  tokens: propTokens,
  keyword: propKeyword,
  className,
  markClassName = 'bg-amber-300/80 dark:bg-amber-400/35 text-amber-950 dark:text-amber-100 font-semibold rounded-sm px-0.5',
  title,
  disabled = false
}) => {
  const globalKeyword = useSearchStore(s => s.globalSearchKeyword)
  const globalTokens = useSearchStore(s => s.searchTokens)

  const activeTokens = useMemo(() => {
    if (disabled) return []
    if (propTokens && propTokens.length > 0) return propTokens
    if (propKeyword && propKeyword.trim()) return [propKeyword.trim()]
    if (globalTokens && globalTokens.length > 0) return globalTokens
    if (globalKeyword && globalKeyword.trim()) return [globalKeyword.trim()]
    return []
  }, [disabled, propTokens, propKeyword, globalTokens, globalKeyword])

  const parts = useMemo(() => {
    if (!text || activeTokens.length === 0) {
      return [{ text: text || '', isMatch: false }]
    }
    return splitTextForHighlight(text, activeTokens)
  }, [text, activeTokens])

  if (!text) return null

  return (
    <span className={className} title={title ?? text}>
      {parts.map((part, index) =>
        part.isMatch ? (
          <mark key={index} className={cn(markClassName)}>
            {part.text}
          </mark>
        ) : (
          <React.Fragment key={index}>{part.text}</React.Fragment>
        )
      )}
    </span>
  )
})

HighlightText.displayName = 'HighlightText'
