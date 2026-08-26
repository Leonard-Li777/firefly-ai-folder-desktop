import React, { useMemo, useState, useEffect } from 'react'
import { FileItem, DirectoryItem, SettingsCategory } from '@firefly/types'
import { FileCategory, isCategory, getFileCategory, formatDateTime } from '@firefly/shared'
import { t } from '@app/languages'
import { cn, MaterialIcon } from '../../../lib/utils'
import { Button } from '../../ui/button'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '../../ui/alert-dialog'

import { useFileDetails } from './hooks/useFileDetails'
import { PreviewSection } from './components/PreviewSection'
import { AnalysisTabs } from './tabs/AnalysisTabs'
import { TagList } from './components/TagList'
import { DirectoryProfileSection } from './components/DirectoryProfileSection'
import { getUnitTypeLabel, getUnitTheme } from '../FileList/utils'
import { useSettingsStore } from '../../../stores/settings-store'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { openExternalLink } from '../../../lib/external-link'

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

function MarkdownRenderer({ content, maskClass }: { content: string; maskClass?: string }) {
  const anchorMap = React.useMemo(() => extractAnchorMap(content), [content])
  const components = React.useMemo(() => makeMarkdownComponents(anchorMap), [anchorMap])
  return (
    <div className={cn('break-words', maskClass)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components as any}>
        {content}
      </ReactMarkdown>
    </div>
  )
}

export const FileDetailsPanel: React.FC<any> = ({
  item,
  onClose,
  onFileDeleted,
  onFileUpdated,
  workspaceDirectoryPath,
  workspaceDirectoryType,
  currentDirectoryPath,
  isRealDirectory = true
}) => {
  const {
    analysisResult,
    reanalyzing,
    deleting,
    isDirectory,
    handleReanalyze,
    handleBatchAnalyzeSubfiles,
    handleDirectoryReanalyze,
    handleClearAnalysis,
    handleDirectoryClearAnalysis,
    refreshAnalysis
  } = useFileDetails(item, workspaceDirectoryPath, onFileUpdated, currentDirectoryPath)
  const [activeTab, setActiveTab] = useState('')
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const maskClass = workspaceDirectoryType === 'PRIVATE' ? 'ph-mask' : ''
  const showDirectory = !item

  const isFileAnalysis = (res: any) => res && 'smartName' in res
  const isDirAnalysis = (res: any) => res && 'fileCount' in res

  const getTagColor = (index: number) => {
    const colors = [
      'bg-primary/10 text-primary',
      'bg-green-500/10 text-green-600 dark:text-green-500',
      'bg-yellow-500/10 text-yellow-600 dark:text-yellow-500',
      'bg-purple-500/10 text-purple-600 dark:text-purple-500',
      'bg-pink-500/10 text-pink-600 dark:text-pink-500',
      'bg-indigo-500/10 text-indigo-600 dark:text-indigo-500',
      'bg-red-500/10 text-red-600 dark:text-red-500',
      'bg-orange-500/10 text-orange-600 dark:text-orange-500',
      'bg-teal-500/10 text-teal-600 dark:text-teal-500',
      'bg-cyan-500/10 text-cyan-600 dark:text-cyan-500'
    ]
    return colors[index % colors.length]
  }

  // 生成虚拟路径（基于维度标签 + 主文件名）
  const generateVirtualPath = (res: any, useRealName?: boolean): string => {
    if (!res) return ''
    const parts: string[] = []
    const dimensionOrder = [t('文件类型'), t('文件用途')]
    if (Array.isArray(res.dimensionTags)) {
      for (const dimName of dimensionOrder) {
        const dimGroup = res.dimensionTags.find((d: any) => d.dimension === dimName)
        if (dimGroup && dimGroup.tags.length > 0) {
          parts.push(dimGroup.tags[0].name)
        }
      }
    }
    const fileName = useRealName ? res.name || '' : res.smartName || res.name || ''
    if (fileName) parts.push(fileName)
    const joined = parts.join('/')
    return window.electronAPI?.utils?.normalizePath(joined) || joined
  }

  // 生成缩略图URL
  const getThumbnailUrl = (): string | null => {
    if (!item || isDirectory) return null
    const thumbPathRaw =
      (analysisResult as any)?.thumbnailPath ||
      ('thumbnailPath' in item ? (item as any).thumbnailPath : undefined)
    if (!thumbPathRaw) return null

    const thumbnailPath = thumbPathRaw as string
    let finalWorkspaceDirectoryPath = workspaceDirectoryPath || ''
    if (
      !finalWorkspaceDirectoryPath &&
      'workspaceDirectoryPath' in item &&
      (item as any).workspaceDirectoryPath
    ) {
      finalWorkspaceDirectoryPath = (item as any).workspaceDirectoryPath as string
    }

    // 兜底：若仍缺乏工作区根路径，通过文件 path 进行切分推导
    if (!finalWorkspaceDirectoryPath && 'path' in item && typeof (item as any).path === 'string') {
      const itemPath = (item as any).path as string
      const virtIdx = itemPath.indexOf('.VirtualDirectory')
      if (virtIdx > 0) {
        finalWorkspaceDirectoryPath = itemPath.substring(0, virtIdx).replace(/[\\/]+$/, '')
      }
    }

    const { normalizeForCache } = window.electronAPI?.utils || {
      normalizeForCache: (p: string) => p
    }

    const isAbs =
      /^[a-zA-Z]:[\\/]/.test(thumbnailPath) ||
      thumbnailPath.startsWith('/') ||
      thumbnailPath.startsWith('\\')

    let absPath = ''
    if (isAbs) {
      absPath = thumbnailPath
    } else if (finalWorkspaceDirectoryPath) {
      absPath = `${finalWorkspaceDirectoryPath.replace(/[\\/]+$/, '')}/${thumbnailPath.replace(/^[\\/]+/, '')}`
    } else {
      return null
    }

    const normalized = normalizeForCache(absPath).replace(/\\/g, '/')
    const cleanPath = normalized.startsWith('/') ? normalized : `/${normalized}`
    const refreshKey = (analysisResult as any)?.lastAnalyzedAt
      ? new Date((analysisResult as any).lastAnalyzedAt).getTime()
      : Date.now()

    return `file://${cleanPath}?t=${refreshKey}`
  }

  // 生成原始图片URL - 如果没有缩略图，但文件本身是图片，则直接显示
  const getOriginalImageUrl = (): string | null => {
    if (
      !item ||
      isDirectory ||
      !('extension' in item) ||
      !isCategory((item as any).extension, FileCategory.IMAGE)
    )
      return null
    const { normalizeForCache } = window.electronAPI!.utils
    const normalizedPath = normalizeForCache((item as FileItem).path)
    return `file://${normalizedPath}`
  }

  const displayUrl = useMemo(
    () => getThumbnailUrl() || getOriginalImageUrl(),
    [item, isDirectory, analysisResult, workspaceDirectoryPath]
  )

  const availableTabs = useMemo(() => {
    if (!analysisResult || !isFileAnalysis(analysisResult)) return []
    const tabs: any[] = []
    if (
      analysisResult.qualityScore != null ||
      analysisResult.multimodalContent?.trim() ||
      analysisResult.qualityReasoning
    )
      tabs.push({ id: 'quality', label: t('质量评分'), icon: 'star_rate' })

    // 从 file-constants.ts 获取文件分类，用于判断各 tab 的显示类型
    const fileCategory = getFileCategory(analysisResult.name || analysisResult.path || '')
    // 文档文本类：DOCUMENT / TEXT / OFFICE / CODE / EBOOK
    const isDocumentText = [
      FileCategory.DOCUMENT,
      FileCategory.TEXT,
      FileCategory.OFFICE,
      FileCategory.CODE,
      FileCategory.EBOOK
    ].includes(fileCategory)
    // OCR/语音/歌词 支持的类型：图片（OCR）、音频（语音/歌词）
    const isOcrSupported =
      fileCategory === FileCategory.IMAGE || fileCategory === FileCategory.AUDIO

    const isImageFile = fileCategory === FileCategory.IMAGE
    const hasOcr =
      isOcrSupported &&
      Boolean(
        analysisResult.lrc?.trim() ||
          analysisResult.ocrContent?.trim() ||
          (isImageFile && analysisResult.content?.trim()) ||
          (analysisResult.content &&
            (analysisResult.content.includes('OCR') ||
              analysisResult.content.includes('图片内提取文字')))
      )

    if (hasOcr) tabs.push({ id: 'ocr', label: t('OCR/语音/歌词'), icon: 'graphic_eq' })
    // 文档摘要：仅文档文本类文件显示
    if (isDocumentText && analysisResult.content?.trim())
      tabs.push({ id: 'summary', label: t('内容摘要'), icon: 'summarize' })
    tabs.push({ id: 'metadata', label: t('元数据'), icon: 'analytics' })
    if (analysisResult.analysisStats) tabs.push({ id: 'timing', label: t('耗时'), icon: 'timer' })
    return tabs
  }, [analysisResult])

  useEffect(() => {
    if (availableTabs.length > 0 && !availableTabs.some(t => t.id === activeTab))
      setActiveTab(availableTabs[0].id)
  }, [availableTabs, activeTab])

  const openSettings = useSettingsStore(s => s.openSettings)

  return (
    <aside className="flex-shrink-0 border-l border-border flex flex-col h-full overflow-hidden select-text">
      <div className="flex-1 overflow-y-auto p-6">
        {((item && 'status' in item && (item as any).status === 0) ||
          (analysisResult &&
            'status' in analysisResult &&
            (analysisResult as any).status === 0)) && (
          <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-xl flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-red-600 dark:text-red-400 text-sm font-semibold">
              <MaterialIcon icon="warning" className="text-red-500 text-base" />
              <span>{t('原文件丢失')}</span>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="text-xs border-red-500/40 hover:bg-red-500/20 text-red-600 dark:text-red-400 h-7 px-2.5"
              onClick={() => openSettings(SettingsCategory.FILE_DISPLAY)}
            >
              {t('关闭显示所有丢失文件')}
            </Button>
          </div>
        )}

        {/* 最小单元标识 */}
        {item && (item as any).isUnit && (
          <div
            className="mb-4 p-3 rounded-xl border space-y-2"
            style={{ borderColor: 'inherit', backgroundColor: 'inherit' }}
          >
            {(() => {
              const uType = (item as any).unitType
              const uReason = (item as any).unitReason || ''
              const uConfidence = (item as any).unitConfidence
              const uLabel = getUnitTypeLabel(uType)
              const uTheme = getUnitTheme(uType)
              return (
                <>
                  <div className="flex items-center gap-2">
                    <span className={`material-icons text-lg ${uTheme.color} ${uTheme.darkColor}`}>
                      {uTheme.icon}
                    </span>
                    <span className={`text-sm font-semibold ${uTheme.color} ${uTheme.darkColor}`}>
                      {t(uLabel)}
                    </span>
                    <span
                      className={`px-1.5 py-0.5 rounded-md text-[10px] font-semibold border ${uTheme.color} ${uTheme.darkColor} ${uTheme.border} ${uTheme.darkBorder} bg-white/80 dark:bg-gray-900/80`}
                    >
                      {t('最小单元')}
                    </span>
                    {uConfidence !== undefined && (
                      <span className="text-xs text-muted-foreground ml-auto">
                        {t('置信度')}: {Math.round(uConfidence * 100)}%
                      </span>
                    )}
                  </div>
                  {uReason && (
                    <p className="text-xs text-muted-foreground leading-relaxed">{uReason}</p>
                  )}
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {t('已经有序，目录内文件不进行逐一分析')}
                  </p>
                  {/* 可选类型：可关闭最小单元识别 */}
                  {['design_project', 'album', 'series'].includes(uType || '') && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-2 text-xs h-7 px-2.5 text-orange-600 dark:text-orange-400 border-orange-300/50 dark:border-orange-700/50 hover:bg-orange-500/10"
                      onClick={() => openSettings(SettingsCategory.ANALYSIS)}
                    >
                      <MaterialIcon icon="tune" className="text-xs mr-1" />
                      {t('关闭最小单元识别')}
                    </Button>
                  )}
                </>
              )
            })()}
          </div>
        )}

        <div className="text-center mb-6">
          <PreviewSection
            displayUrl={displayUrl}
            item={item}
            isDirectory={isDirectory}
            showDirectory={showDirectory}
            analysisResult={analysisResult}
            isFileAnalysis={isFileAnalysis}
          />
          {analysisResult &&
            isFileAnalysis(analysisResult) &&
            analysisResult.isAnalyzed &&
            (analysisResult.smartName ||
              (analysisResult.dimensionTags && analysisResult.dimensionTags.length > 0)) && (
              <>
                {(() => {
                  const swap =
                    useSettingsStore.getState().getConfigValue<boolean>('SWAP_FILE_NAME_DISPLAY') ??
                    false
                  if (swap) {
                    return (
                      <>
                        <h2 className="font-semibold text-base mt-3 text-primary break-all">
                          {item?.name || ''}
                        </h2>
                        {analysisResult.smartName && (
                          <p className="text-xs text-muted-foreground mt-1 break-all">
                            {generateVirtualPath(analysisResult, false)}
                          </p>
                        )}
                      </>
                    )
                  }
                  return (
                    <>
                      <h2 className="font-semibold text-base mt-3 text-primary break-all">
                        {generateVirtualPath(analysisResult)}
                      </h2>
                      {item && !showDirectory && (
                        <p className="text-xs text-muted-foreground mt-1 break-all">{item.name}</p>
                      )}
                    </>
                  )
                })()}
                {analysisResult.description && (
                  <div className="mt-2 text-left">
                    <MarkdownRenderer content={analysisResult.description} maskClass={maskClass} />
                  </div>
                )}
              </>
            )}
          {analysisResult && isDirAnalysis(analysisResult) && (
            <h2 className="font-semibold text-base mt-3 text-foreground break-all">
              ⭐{analysisResult.name}
              {analysisResult.contextAnalysis?.directoryType &&
                ` (${analysisResult.contextAnalysis.directoryType})`}
            </h2>
          )}
          {!analysisResult && item && isDirectory && (
            <h2 className="font-semibold text-base mt-3 text-foreground break-all">
              📁{item.name}
            </h2>
          )}
        </div>

        {analysisResult && isFileAnalysis(analysisResult) && analysisResult.isAnalyzed && (
          <TagList
            analysisResult={analysisResult}
            getTagColor={getTagColor}
            onTagDeleted={refreshAnalysis}
          />
        )}

        {(showDirectory || isDirectory) && analysisResult && isDirAnalysis(analysisResult) && (
          <DirectoryProfileSection
            analysisResult={analysisResult}
            isDirAnalysis={isDirAnalysis}
            getTagColor={getTagColor}
            formatDate={(d: any) => formatDateTime(d)}
            onRefresh={refreshAnalysis}
            isUnit={!!(item as any)?.isUnit}
            workspaceDirectoryPath={workspaceDirectoryPath || (item as any)?.workspaceDirectoryPath}
          />
        )}

        {(showDirectory || isDirectory) && !analysisResult && item && (
          <div className="border-t border-border pt-4 mb-6">
            <h3 className="text-sm font-semibold mb-3 text-foreground">{t('目录属性')}</h3>
            <div className="bg-muted/30 rounded-xl p-4 space-y-3 text-sm border border-border/50">
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">{t('目录名')}</span>
                <span className="font-bold break-all ml-4 text-right">{item.name}</span>
              </div>
              {item.path && (
                <div className="flex justify-between items-start flex-col gap-1">
                  <span className="text-muted-foreground">{t('路径')}</span>
                  <span className="text-xs break-all text-muted-foreground/80 font-mono bg-muted/50 p-2 rounded-md w-full border border-border/30">
                    {item.path}
                  </span>
                </div>
              )}
              {item.fileCount !== undefined && (
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">{t('文件数量')}</span>
                  <span className="font-bold">
                    {item.fileCount} {t('个')}
                  </span>
                </div>
              )}
              {item.subdirectoriesCount !== undefined && (
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">{t('子目录数量')}</span>
                  <span className="font-bold">
                    {item.subdirectoriesCount} {t('个')}
                  </span>
                </div>
              )}
              {item.size !== undefined && item.size > 0 && (
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">{t('大小')}</span>
                  <span className="font-bold">
                    {((item.size || 0) / 1024 / 1024).toFixed(2)} MB
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        <AnalysisTabs
          availableTabs={availableTabs}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          analysisResult={analysisResult}
          maskClass={maskClass}
          formatDate={(d: any) => formatDateTime(d)}
        />
      </div>

      {/* 底部操作按钮 — 仅真实目录显示分析相关操作 */}
      {isRealDirectory && (
        <div className="p-4 border-t">
          <div className="flex space-x-2 items-stretch">
            <div className="flex-1 flex space-x-2 min-w-0">
              {isDirectory || showDirectory ? (
                <>
                  <div className="relative flex-1 group">
                    <div className="absolute bottom-full left-0 mb-2 w-40 p-2 bg-popover text-popover-foreground text-xs text-center leading-relaxed rounded-md shadow-lg border border-border opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-50 pointer-events-none">
                      {t('分析目录特征，以指导目录中文件的后续分析')}
                    </div>
                    <Button
                      variant="secondary"
                      className="w-full px-2"
                      onClick={handleDirectoryReanalyze}
                      disabled={reanalyzing}
                    >
                      {reanalyzing ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-primary mr-2"></div>
                          {t('分析中')}
                        </>
                      ) : (
                        <>
                          <MaterialIcon icon="refresh" className="text-base mr-1.5" />
                          <span className="truncate">{t('目录画像')}</span>
                        </>
                      )}
                    </Button>
                  </div>

                  <div className="relative flex-1 group">
                    <div className="absolute bottom-full right-0 mb-2 w-48 p-2 bg-popover text-popover-foreground text-xs text-center leading-relaxed rounded-md shadow-lg border border-border opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-50 pointer-events-none">
                      {t('分析整个目录中的文件')}
                    </div>
                    <Button
                      variant="default"
                      className="w-full px-2 shadow-none hover:shadow-md hover:bg-primary"
                      onClick={handleBatchAnalyzeSubfiles}
                      disabled={reanalyzing}
                    >
                      <MaterialIcon icon="auto_awesome" className="text-base mr-1.5" />
                      <span className="truncate">
                        {analysisResult &&
                        isDirAnalysis(analysisResult) &&
                        analysisResult.analyzedFileCount > 0
                          ? t('重新分析')
                          : t('立即分析')}
                      </span>
                    </Button>
                  </div>
                </>
              ) : (
                <Button
                  variant="secondary"
                  className="w-full hover:shadow-sm hover:bg-primary"
                  onClick={handleReanalyze}
                  disabled={reanalyzing}
                >
                  {reanalyzing ? (
                    <>
                      <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-primary mr-2"></div>
                      {t('分析中...')}
                    </>
                  ) : (
                    <>
                      <MaterialIcon icon="refresh" className="text-base mr-2" />
                      {analysisResult && isFileAnalysis(analysisResult) && analysisResult.isAnalyzed
                        ? t('重新分析')
                        : t('立即分析')}
                    </>
                  )}
                </Button>
              )}
            </div>

            {analysisResult &&
              ((isFileAnalysis(analysisResult) && analysisResult.isAnalyzed) ||
                isDirAnalysis(analysisResult)) && (
                <Button
                  variant="secondary"
                  className="flex-shrink-0 px-3"
                  onClick={() => setShowDeleteDialog(true)}
                  disabled={deleting || reanalyzing}
                  title={t('清空分析结果')}
                >
                  <MaterialIcon icon="delete_forever" className="text-base" />
                </Button>
              )}
          </div>
        </div>
      )}

      {/* 确认删除对话框 */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('确认清空分析结果？')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('此操作将删除该{category}的所有AI分析数据{sentens}，但不会删除{category}本身。', {
                category: isDirectory ? t('目录') : t('文件'),
                sentens: isDirectory
                  ? t('（不包括目录内文件的分析数据）')
                  : t('（包括摘要、标签、向量索引等）')
              })}
              <br />
              <br />
              {t('清空后，您可以重新进行分析。')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="secondary" onClick={() => setShowDeleteDialog(false)}>
              {t('取消')}
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                await (isDirectory ? handleDirectoryClearAnalysis() : handleClearAnalysis())
                setShowDeleteDialog(false)
              }}
            >
              {t('确认清空')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  )
}
