import { MaterialIcon, cn } from '../../../../lib/utils'

import { ProgressBar } from '../../../ui/ProgressBar'
import React, { useMemo } from 'react'
import { getQualityScoreStars } from '@firefly/types'
import { formatDateTime } from '@firefly/shared'
import { t } from '@app/languages'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { openExternalLink } from '../../../../lib/external-link'
import { AnalysisTimeTab } from './AnalysisTimeTab'

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

function makeMarkdownComponents(anchorMap: Map<string, string>) {
  const heading =
    (tag: string) =>
    ({ children, ...props }: any) => {
      const id = getAnchorId(children, anchorMap)
      const Tag = tag as any
      return (
        <Tag id={id} {...props}>
          {children}
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
        {children}
      </p>
    ),
    blockquote: ({ children }: any) => (
      <blockquote className="border-l-4 border-primary/60 bg-muted/40 pl-3 py-1.5 my-2 text-sm italic text-muted-foreground rounded-r-md">
        {children}
      </blockquote>
    ),
    ul: ({ children }: any) => (
      <ul className="list-disc pl-5 space-y-1 mb-2 last:mb-0">{children}</ul>
    ),
    ol: ({ children }: any) => (
      <ol className="list-decimal pl-5 space-y-1 mb-2 last:mb-0">{children}</ol>
    ),
    li: ({ children }: any) => <li className="text-sm break-words">{children}</li>,
    strong: ({ children }: any) => (
      <strong className="font-bold text-foreground">{children}</strong>
    ),
    code: ({ children }: any) => (
      <code className="bg-muted px-1.5 py-0.5 rounded text-[11px] font-mono">{children}</code>
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

function SummaryMarkdown({ content, maskClass }: { content: string; maskClass?: string }) {
  const anchorMap = useMemo(() => extractAnchorMap(content), [content])
  const components = useMemo(() => makeMarkdownComponents(anchorMap), [anchorMap])
  return (
    <div
      className={cn(
        'text-sm text-foreground bg-muted/30 p-3 rounded-md border border-border/50 leading-relaxed break-words overflow-hidden',
        maskClass
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components as any}>
        {content}
      </ReactMarkdown>
    </div>
  )
}

export const AnalysisTabs: React.FC<any> = ({
  availableTabs,
  activeTab,
  setActiveTab,
  analysisResult,
  maskClass,
  formatDate
}) => {
  if (availableTabs.length === 0) return null

  return (
    <div className="pt-4 mb-6">
      <div className="flex border-b border-border/80 overflow-hidden mb-4 w-full">
        {availableTabs.map((tab: any) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              'flex-1 min-w-0 w-0 flex items-center justify-center px-2 py-2.5 text-xs font-semibold transition-all duration-200 cursor-pointer -mb-[1px] border-b-2 rounded-t-md',
              activeTab === tab.id
                ? 'border-primary text-primary font-bold bg-primary/5'
                : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/30'
            )}
          >
            <MaterialIcon icon={tab.icon} className="text-sm mr-1.5 flex-shrink-0" />
            <span className="truncate">{tab.label}</span>
          </button>
        ))}
      </div>
      <div className="min-h-[100px]">
        {activeTab === 'quality' && (
          <div className="space-y-4">
            {analysisResult.qualityScore !== undefined && analysisResult.qualityScore !== null && (
              <>
                <div className="flex items-center space-x-3 bg-muted/20 p-3 rounded-lg border border-border/40">
                  <div className="flex text-yellow-500 text-xl">
                    {getQualityScoreStars(analysisResult.qualityScore || 0).stars.map(
                      (starType: string, i: number) => (
                        <MaterialIcon key={i} icon={starType} className="text-xl" />
                      )
                    )}
                  </div>
                  <span className="text-sm font-semibold text-foreground">
                    {analysisResult.qualityScore.toFixed(1)} / 10
                  </span>
                  {analysisResult.qualityConfidence !== undefined &&
                    analysisResult.qualityConfidence !== null && (
                      <span className="text-xs text-muted-foreground ml-2">
                        {t('置信度: ')}
                        {(analysisResult.qualityConfidence * 100).toFixed(0)}%
                      </span>
                    )}
                </div>

                {analysisResult.qualityCriteria && (
                  <div className="space-y-2.5 bg-muted/10 p-3 rounded-lg border border-border/30">
                    <div className="flex items-center text-xs text-muted-foreground">
                      <span className="w-16 flex-shrink-0">{t('技术指标')}</span>
                      <ProgressBar
                        value={analysisResult.qualityCriteria.technical}
                        max={10}
                        className="flex-1 h-1.5"
                        showValue
                      />
                    </div>
                    <div className="flex items-center text-xs text-muted-foreground">
                      <span className="w-16 flex-shrink-0">{t('美学评估')}</span>
                      <ProgressBar
                        value={analysisResult.qualityCriteria.aesthetic}
                        max={10}
                        className="flex-1 h-1.5"
                        showValue
                      />
                    </div>
                    <div className="flex items-center text-xs text-muted-foreground">
                      <span className="w-16 flex-shrink-0">{t('内容价值')}</span>
                      <ProgressBar
                        value={analysisResult.qualityCriteria.content}
                        max={10}
                        className="flex-1 h-1.5"
                        showValue
                      />
                    </div>
                    <div className="flex items-center text-xs text-muted-foreground">
                      <span className="w-16 flex-shrink-0">{t('完整性')}</span>
                      <ProgressBar
                        value={analysisResult.qualityCriteria.completeness}
                        max={10}
                        className="flex-1 h-1.5"
                        showValue
                      />
                    </div>
                    <div className="flex items-center text-xs text-muted-foreground">
                      <span className="w-16 flex-shrink-0">{t('时效性')}</span>
                      <ProgressBar
                        value={analysisResult.qualityCriteria.timeliness}
                        max={10}
                        className="flex-1 h-1.5"
                        showValue
                      />
                    </div>
                  </div>
                )}
              </>
            )}

            {analysisResult.multimodalContent ? (
              <div
                className={cn(
                  'text-xs text-foreground bg-muted/30 p-3 rounded-md border border-border/50 whitespace-pre-wrap leading-relaxed',
                  maskClass
                )}
              >
                {analysisResult.multimodalContent}
              </div>
            ) : analysisResult.qualityReasoning ? (
              <div
                className={cn(
                  'text-xs text-foreground bg-muted/30 p-3 rounded-md border border-border/50 whitespace-pre-wrap leading-relaxed',
                  maskClass
                )}
              >
                {analysisResult.qualityReasoning}
              </div>
            ) : (
              !analysisResult.qualityScore && (
                <div className="text-sm text-muted-foreground italic">
                  {t('暂无评分数据 (请点击下方"重新分析"获取)')}
                </div>
              )
            )}
          </div>
        )}
        {activeTab === 'ocr' && (
          <SummaryMarkdown
            content={(() => {
              if (analysisResult.lrc?.trim()) return analysisResult.lrc
              if (analysisResult.ocrContent?.trim()) return analysisResult.ocrContent
              const isImageFile =
                analysisResult.type === 'image' ||
                (analysisResult.mimeType && analysisResult.mimeType.startsWith('image/'))
              if (isImageFile && analysisResult.content?.trim()) return analysisResult.content
              if (
                analysisResult.content &&
                (analysisResult.content.includes('OCR') ||
                  analysisResult.content.includes('图片内提取文字'))
              ) {
                return analysisResult.content
              }
              return `> ${t('暂无 OCR 识别结果')}`
            })()}
            maskClass={maskClass}
          />
        )}

        {activeTab === 'summary' && (
          <SummaryMarkdown content={analysisResult.content} maskClass={maskClass} />
        )}
        {activeTab === 'timing' && analysisResult.analysisStats && (
          <AnalysisTimeTab
            stats={analysisResult.analysisStats}
            maskClass={maskClass}
            lastAnalyzedAt={analysisResult.lastAnalyzedAt}
            formatDate={formatDate}
          />
        )}
        {activeTab === 'metadata' && (
          <div className={cn('space-y-3', maskClass)}>
            {/* Magika 类型识别卡片（全量 7 项完整展现：支持 catObj 与 metadata 跨来源联合补充） */}
            {(() => {
              let catObj: any = analysisResult.category
              if (typeof catObj === 'string' && catObj.trim()) {
                try {
                  catObj = JSON.parse(catObj)
                } catch {
                  catObj = { label: catObj }
                }
              }
              if (!catObj || typeof catObj !== 'object') {
                catObj = {}
              }

              // 从 catObj 与 metadata 联合提取 7 项经典 Magika 项目
              const meta = analysisResult.metadata || {}

              const labelVal =
                catObj.label ||
                catObj.type ||
                analysisResult.type ||
                meta.magikaLabel ||
                meta.type ||
                meta.FileType ||
                meta.FileTypeExtension
              const descriptionVal =
                catObj.description ||
                meta.description ||
                meta.magikaDescription ||
                (meta.Make && meta.Model ? `${meta.Make} ${meta.Model}` : undefined)
              const mimeVal =
                catObj.mime_type ||
                catObj.mimeType ||
                analysisResult.mimeType ||
                meta.mime_type ||
                meta.mimeType ||
                meta.MIMEType
              const extensionsVal =
                catObj.extensions ||
                catObj.exts ||
                meta.extensions ||
                meta.exts ||
                meta.FileTypeExtension
              const groupVal =
                catObj.group ||
                meta.group ||
                meta.magikaGroup ||
                (meta.MIMEType?.startsWith('image/') ? 'image' : undefined)
              const isTextVal =
                catObj.is_text ??
                catObj.isText ??
                meta.is_text ??
                meta.isText ??
                (meta.MIMEType?.startsWith('text/') ? true : false)
              const scoreVal = catObj.score ?? catObj.confidence ?? meta.score ?? meta.confidence

              const fullItems = [
                { key: 'label', label: t('类型标签'), val: labelVal },
                { key: 'description', label: t('描述'), val: descriptionVal },
                { key: 'mime_type', label: t('MIME类型'), val: mimeVal },
                { key: 'extensions', label: t('扩展名'), val: extensionsVal },
                { key: 'group', label: t('文件分组'), val: groupVal },
                { key: 'is_text', label: t('是否文本'), val: isTextVal },
                { key: 'score', label: t('置信度'), val: scoreVal }
              ]

              const visibleItems = fullItems.filter(
                item => item.val !== undefined && item.val !== null && item.val !== ''
              )

              if (visibleItems.length === 0) return null

              return (
                <div className="rounded-lg border border-border/40 bg-muted/20 overflow-hidden divide-y divide-border/30 shadow-sm">
                  {visibleItems.map(({ key, label, val }) => {
                    let displayVal: React.ReactNode
                    if (key === 'extensions' && Array.isArray(val)) {
                      displayVal = val.filter(Boolean).join(', ') || '-'
                    } else if (key === 'is_text') {
                      displayVal = val ? t('是') : t('否')
                    } else if (key === 'score' && typeof val === 'number') {
                      displayVal = `${(val * 100).toFixed(1)}%`
                    } else if (Array.isArray(val)) {
                      displayVal = val.join(', ')
                    } else {
                      displayVal = String(val)
                    }
                    return (
                      <div
                        key={key}
                        className="flex items-center justify-between p-2.5 text-xs hover:bg-muted/40 transition-colors"
                      >
                        <span className="font-mono text-muted-foreground shrink-0 mr-3">
                          {label}
                        </span>
                        <span className="text-foreground text-right break-all">{displayVal}</span>
                      </div>
                    )
                  })}
                </div>
              )
            })()}
            {analysisResult.metadata &&
            typeof analysisResult.metadata === 'object' &&
            Object.keys(analysisResult.metadata).length > 0 ? (
              <div className="rounded-lg border border-border/40 bg-muted/20 overflow-hidden divide-y divide-border/30">
                {(() => {
                  try {
                    const formatValue = (val: any): string => {
                      if (
                        typeof val === 'string' &&
                        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(val)
                      ) {
                        try {
                          const date = new Date(val)
                          if (!isNaN(date.getTime())) return formatDateTime(date)
                        } catch (e) {
                          console.warn('[AnalysisTabs] 日期格式化失败:', e)
                        }
                      }
                      if (Array.isArray(val)) return val.join(', ')
                      if (typeof val === 'boolean') return val ? t('是') : t('否')
                      return String(val)
                    }

                    // 仅过滤内部智能重命名暂存字段以及超长专有二进制 hex 码
                    const SKIP_KEYS = new Set([
                      'ExifToolVersion', // 工具版本号
                      'MakerNote', // 100KB+ 超长相机专有二进制 hex 码，避免卡顿
                      'ThumbnailImage', // 嵌入缩略图二进制字段
                      'raw_smart_name', // 内部智能重命名暂存字段
                      'naming_template'
                    ])
                    // ExifDateTime 日期对象特征：含 _ctor 或同时有 year/month/day 子字段
                    const isExifDateTimeObj = (v: any): boolean =>
                      typeof v === 'object' &&
                      v !== null &&
                      !Array.isArray(v) &&
                      ('_ctor' in v || ('year' in v && 'month' in v && 'day' in v))
                    // 将 ExifDateTime 对象格式化为可读日期字符串
                    const formatExifDateTimeObj = (v: any): string => {
                      try {
                        if (typeof v.toISOString === 'function')
                          return formatDateTime(new Date(v.toISOString()))
                        const { year, month, day, hour = 0, minute = 0, second = 0 } = v
                        if (year && month && day) {
                          return formatDateTime(
                            new Date(
                              Date.UTC(year, month - 1, day, hour, minute, Math.floor(second))
                            )
                          )
                        }
                      } catch {
                        /* 格式化失败则兜底 */
                      }
                      return v.rawValue ?? String(v)
                    }

                    const renderPairs = (obj: any, prefix = ''): React.ReactNode[] => {
                      if (typeof obj !== 'object' || obj === null) return []
                      return Object.entries(obj).flatMap<React.ReactNode>(([key, val]) => {
                        const fullKey = prefix ? `${prefix}.${key}` : key
                        // 全局过滤无意义字段或超长二进制字段（如 MakerNote / exif.MakerNote）
                        if (SKIP_KEYS.has(key) || SKIP_KEYS.has(fullKey)) return []
                        // 如果值是超过 500 字符的纯 Hex/Base64 二进制乱码，自动过滤
                        if (typeof val === 'string' && val.length > 500 && /^[0-9a-fA-F\s]+$/.test(val)) {
                          return []
                        }
                        // ExifDateTime 对象：直接渲染格式化日期，不递归展开子字段
                        if (isExifDateTimeObj(val)) {
                          const displayDate = formatExifDateTimeObj(val)
                          return [
                            <div
                              key={fullKey}
                              className="flex items-start justify-between p-2.5 text-xs hover:bg-muted/40 transition-colors"
                            >
                              <span className="font-mono text-muted-foreground shrink-0 mr-3">
                                {fullKey}
                              </span>
                              <span className="font-mono text-foreground text-right break-all">
                                {displayDate}
                              </span>
                            </div>
                          ]
                        }
                        if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
                          return renderPairs(val, fullKey)
                        }
                        return [
                          <div
                            key={fullKey}
                            className="flex items-start justify-between p-2.5 text-xs hover:bg-muted/40 transition-colors"
                          >
                            <span className="font-mono text-muted-foreground shrink-0 mr-3">
                              {fullKey}
                            </span>
                            <span className="font-mono text-foreground text-right break-all">
                              {formatValue(val)}
                            </span>
                          </div>
                        ]
                      })
                    }

                    const items = renderPairs(analysisResult.metadata)
                    return items.length > 0 ? items : null
                  } catch (e) {
                    return (
                      <pre className="p-3 text-xs font-mono text-foreground whitespace-pre-wrap break-words">
                        {String(analysisResult.metadata)}
                      </pre>
                    )
                  }
                })()}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}
