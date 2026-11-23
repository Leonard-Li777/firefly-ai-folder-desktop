import React from 'react'
import i18nScope, { t } from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'
import { MaterialIcon, cn } from '../../../../lib/utils'
import { HighlightText } from '../../../common/HighlightText'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { openExternalLink } from '../../../../lib/external-link'
import { useSearchStore } from '../../../../stores/search-store'
import { useSettingsStore } from '../../../../stores/settings-store'

function extractAnchorMap(content: string): Map<string, string> {
  const map = new Map<string, string>()
  const linkRe = /\[([^\]]+)\]\(#([^)]+)\)/g
  let match: RegExpExecArray | null
  while ((match = linkRe.exec(content)) !== null) {
    const linkText = match[1].trim()
    const anchorId = match[2]
    const normalized = linkText.replace(/\s+\d+$/, '').trim()
    if (normalized && !map.has(normalized)) {
      map.set(normalized, anchorId)
    }
  }
  return map
}

function getAnchorId(children: any, anchorMap: Map<string, string>): string | undefined {
  const text = extractText(children)
  if (!text) return undefined
  const normalized = text.trim()
  if (anchorMap.has(normalized)) return anchorMap.get(normalized)
  const withoutNum = normalized.replace(/\s+\d+$/, '').trim()
  return anchorMap.get(withoutNum)
}

function extractText(node: any): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (node?.props?.children) return extractText(node.props.children)
  return ''
}

function highlightChildren(children: any, tokens: string[]) {
  if (!tokens || tokens.length === 0) return children
  if (typeof children === 'string') {
    return <HighlightText text={children} tokens={tokens} />
  }
  if (Array.isArray(children)) {
    return children.map((c, idx) => (
      <React.Fragment key={idx}>{highlightChildren(c, tokens)}</React.Fragment>
    ))
  }
  return children
}

function makeMarkdownComponents(anchorMap: Map<string, string>, tokens: string[] = []) {
  const heading =
    (tag: string) =>
    ({ children, ...props }: any) => {
      const id = getAnchorId(children, anchorMap)
      const Tag = tag as any
      return (
        <Tag id={id} {...props}>
          {highlightChildren(children, tokens)}
        </Tag>
      )
    }
  return {
    h1: heading('h1'),
    h2: heading('h2'),
    h3: heading('h3'),
    h4: heading('h4'),
    p: ({ children }: any) => (
      <p className="mb-2 text-sm leading-relaxed last:mb-0 break-words whitespace-pre-line">
        {highlightChildren(children, tokens)}
      </p>
    ),
    ul: ({ children }: any) => (
      <ul className="list-disc pl-5 space-y-1 mb-2 last:mb-0">{children}</ul>
    ),
    ol: ({ children }: any) => (
      <ol className="list-decimal pl-5 space-y-1 mb-2 last:mb-0">{children}</ol>
    ),
    li: ({ children }: any) => (
      <li className="text-sm break-words">{highlightChildren(children, tokens)}</li>
    ),
    strong: ({ children }: any) => (
      <strong className="font-bold text-foreground">{highlightChildren(children, tokens)}</strong>
    ),
    code: ({ children }: any) => (
      <code className="bg-muted px-1.5 py-0.5 rounded text-[11px] font-mono break-all whitespace-pre-wrap">
        {children}
      </code>
    ),
    a: ({ href, children }: any) => (
      <a
        href={href}
        className="text-primary underline break-all hover:opacity-80 cursor-pointer"
        onClick={e => {
          e.preventDefault()
          if (!href) return
          if (href.startsWith('#')) {
            const id = href.slice(1)
            const el = document.getElementById(id)
            if (el) el.scrollIntoView({ behavior: 'smooth' })
            return
          }
          openExternalLink(href)
        }}
      >
        {children}
      </a>
    )
  }
}

export function MarkdownRenderer({ content, maskClass }: { content: string; maskClass?: string }) {
  const tokens = useSearchStore(s => s.searchTokens)
  const globalKeyword = useSearchStore(s => s.globalSearchKeyword)
  const effectiveTokens = React.useMemo(() => {
    if (tokens && tokens.length > 0) return tokens
    if (globalKeyword && globalKeyword.trim()) return [globalKeyword.trim()]
    return []
  }, [tokens, globalKeyword])

  const anchorMap = React.useMemo(() => extractAnchorMap(content), [content])
  const components = React.useMemo(
    () => makeMarkdownComponents(anchorMap, effectiveTokens),
    [anchorMap, effectiveTokens]
  )
  return (
    <div className={cn('break-words', maskClass)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components as any}>
        {content}
      </ReactMarkdown>
    </div>
  )
}

interface DetailsCardSummaryProps {
  item?: any
  analysisResult?: any
  isDirectory: boolean
  showDirectory: boolean
  maskClass?: string
  isFileAnalysis: (res: any) => boolean
  isDirAnalysis: (res: any) => boolean
}

export const DetailsCardSummary: React.FC<DetailsCardSummaryProps> = ({
  item,
  analysisResult,
  isDirectory,
  showDirectory,
  maskClass,
  isFileAnalysis,
  isDirAnalysis
}) => {
  const { t } = useVoerkaI18n(i18nScope)
  const swapFileNameDisplay =
    useSettingsStore(s => s.getConfigValue<boolean>('SWAP_FILE_NAME_DISPLAY')) ?? false

  return (
    <div data-testid="details-card-summary" className="w-full flex flex-col min-h-[140px]">
      <div className="w-full flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
          <MaterialIcon icon="auto_awesome" className="text-sm text-primary" />
          {t('摘要语义')}
        </span>
      </div>

      <div className="flex-1 flex flex-col justify-start">
        {/* 单文件模式 */}
        {analysisResult &&
        isFileAnalysis(analysisResult) &&
        analysisResult.isAnalyzed &&
        (analysisResult.smartName ||
          (analysisResult.dimensionTags && analysisResult.dimensionTags.length > 0)) ? (
          <>
            {(() => {
              const realName = item?.name || analysisResult.name || ''
              const smartName = analysisResult.smartName || ''

              if (smartName) {
                const primary = swapFileNameDisplay ? realName : smartName
                const secondary = swapFileNameDisplay ? smartName : realName

                return (
                  <div className="mb-2">
                    <h2
                      className="font-semibold text-sm text-primary break-all cursor-text leading-snug"
                      title={primary}
                    >
                      <HighlightText text={primary} title={primary} />
                    </h2>
                    {secondary && (
                      <p
                        className="text-xs text-muted-foreground mt-0.5 break-all cursor-text"
                        title={secondary}
                      >
                        <HighlightText text={secondary} title={secondary} />
                      </p>
                    )}
                  </div>
                )
              }

              return (
                <h2
                  className="font-semibold text-sm text-foreground break-all cursor-text mb-2 leading-snug"
                  title={realName}
                >
                  <HighlightText text={realName} title={realName} />
                </h2>
              )
            })()}

            {analysisResult.description && (
              <div className="mt-1 text-left text-xs text-muted-foreground/90 leading-relaxed max-h-[180px] overflow-y-auto no-scrollbar">
                <MarkdownRenderer content={analysisResult.description} maskClass={maskClass} />
              </div>
            )}
          </>
        ) : item && !isDirectory ? (
          <h2
            className="font-semibold text-sm text-foreground break-all cursor-text leading-snug"
            title={item.name}
          >
            <HighlightText text={item.name} title={item.name} />
          </h2>
        ) : null}

        {/* 目录模式 */}
        {analysisResult && isDirAnalysis(analysisResult) && (
          <div>
            <h2 className="font-semibold text-sm text-foreground break-all flex items-center gap-1">
              <span>⭐ {analysisResult.name}</span>
              {analysisResult.contextAnalysis?.directoryType && (
                <span className="text-xs text-muted-foreground font-normal">
                  ({analysisResult.contextAnalysis.directoryType})
                </span>
              )}
            </h2>
            {analysisResult.contextAnalysis?.description && (
              <p className="mt-2 text-xs text-muted-foreground leading-relaxed">
                {analysisResult.contextAnalysis.description}
              </p>
            )}
          </div>
        )}

        {!analysisResult && item && isDirectory && (
          <h2 className="font-semibold text-sm text-foreground break-all flex items-center gap-1.5">
            <MaterialIcon icon="folder" className="text-base text-primary/80" />
            <span>{item.name}</span>
          </h2>
        )}
      </div>
    </div>
  )
}
