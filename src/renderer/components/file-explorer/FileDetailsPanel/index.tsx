import React, { useMemo, useState, useEffect } from 'react'
import { FileItem, DirectoryItem } from '@firefly/types'
import { FileCategory, isCategory, getFileCategory, formatDateTime } from '@firefly/shared'
import i18nScope, { t } from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'
import { MaterialIcon, cn } from '../../../lib/utils'
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
import { resolveThumbnailUrl, toSafeFileUrl } from '../FileList/components/thumbnail-url-utils'
import {
  useDetailsCardsStore,
  DETAILS_CARD_IDS,
  DetailsCardId
} from './stores/details-cards-store'
import { DetailsMicroActionStrip } from './components/DetailsMicroActionStrip'
import { DetailsPinnedBanner } from './components/DetailsPinnedBanner'
import { DetailsBottomActions } from './components/DetailsBottomActions'
import { DetailsCardWrapper } from './cards/DetailsCardWrapper'
import { DetailsCardMiniPreview } from './cards/DetailsCardMiniPreview'
import { DetailsCardSummary } from './cards/DetailsCardSummary'
import { DetailsCardTags } from './cards/DetailsCardTags'
import { DetailsCardMetrics } from './cards/DetailsCardMetrics'

export interface FileDetailsPanelProps {
  pageId?: string
  item?: FileItem | DirectoryItem
  onClose?: () => void
  onFileDeleted?: (item?: any) => void
  onFileUpdated?: (item?: any) => void
  workspaceDirectoryPath?: string
  workspaceDirectoryType?: string
  currentDirectoryPath?: string
  isRealDirectory?: boolean
  showPreview?: boolean
  previewCollapsed?: boolean
}

const FileDetailsPanelComponent: React.FC<FileDetailsPanelProps> = ({
  pageId = 'default_page',
  item,
  onClose,
  onFileDeleted,
  onFileUpdated,
  workspaceDirectoryPath,
  workspaceDirectoryType,
  currentDirectoryPath,
  isRealDirectory = true,
  previewCollapsed = true
}) => {
  const { t, activeLanguage } = useVoerkaI18n(i18nScope)
  const {
    analysisResult,
    reanalyzing,
    queueStatus,
    deleting,
    isDirectory,
    handleReanalyze,
    handleBatchAnalyzeSubfiles,
    handleDirectoryReanalyze,
    handleClearAnalysis,
    handleDirectoryClearAnalysis,
    refreshAnalysis
  } = useFileDetails(
    item,
    workspaceDirectoryPath,
    onFileUpdated ? () => onFileUpdated(item) : undefined,
    currentDirectoryPath
  )

  const [activeTab, setActiveTab] = useState('')
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const maskClass = workspaceDirectoryType === 'PRIVATE' ? 'ph-mask' : ''
  const showDirectory = !item
  const isDir = Boolean(isDirectory)

  // 微宫格 4 大卡片开闭状态管理
  const visibleCards = useDetailsCardsStore(s => s.getVisibleCards(pageId))
  const toggleCard = useDetailsCardsStore(s => s.toggleCard)

  // 目录模式下仅展示分析指标，单文件模式展示用户可见的微宫格卡片集合
  const isDirMode = isDir || showDirectory
  const effectiveCards = useMemo(() => {
    if (isDirMode) {
      return [DETAILS_CARD_IDS.METRICS]
    }
    return visibleCards
  }, [isDirMode, visibleCards])

  const isFileAnalysis = React.useCallback(
    (res: any) =>
      !isDirectory &&
      !showDirectory &&
      res &&
      !('contextAnalysis' in res) &&
      !('fileCount' in res) &&
      ('smartName' in res ||
        'dimensionTags' in res ||
        'qualityScore' in res ||
        'qualityReasoning' in res ||
        'multimodalContent' in res ||
        'analysisStats' in res ||
        'content' in res ||
        'metadata' in res ||
        res.itemType === 'file'),
    [isDirectory, showDirectory]
  )

  const isDirAnalysis = React.useCallback(
    (res: any) =>
      res &&
      (isDirectory ||
        showDirectory ||
        'contextAnalysis' in res ||
        'fileCount' in res ||
        'subdirectoriesCount' in res ||
        res.itemType === 'directory'),
    [isDirectory, showDirectory]
  )

  const getTagColor = React.useCallback((index: number) => {
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
  }, [])

  const formatDate = React.useCallback((d: any) => formatDateTime(d), [])

  // 生成缩略图 URL
  const getThumbnailUrl = (): string | null => {
    if (!item || isDirectory) return null
    const thumbPathRaw =
      (analysisResult as any)?.thumbnailPath ||
      ('thumbnailPath' in item ? (item as any).thumbnailPath : undefined)
    const filePath =
      'path' in item && typeof (item as any).path === 'string' ? (item as any).path : undefined
    const wsPath =
      workspaceDirectoryPath ||
      ('workspaceDirectoryPath' in item ? (item as any).workspaceDirectoryPath : undefined)

    const url = resolveThumbnailUrl(thumbPathRaw, filePath, wsPath)
    if (!url) return null

    const lastAnalyzedAt = (analysisResult as any)?.lastAnalyzedAt
    const refreshKey = lastAnalyzedAt ? new Date(lastAnalyzedAt).getTime() : null

    return refreshKey ? `${url}?t=${refreshKey}` : url
  }

  // 原图预览 URL
  const getOriginalImageUrl = (): string | null => {
    if (
      !item ||
      isDirectory ||
      !('extension' in item) ||
      !isCategory((item as any).extension, FileCategory.IMAGE)
    )
      return null
    return toSafeFileUrl((item as FileItem).path)
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

    const fileCategory = getFileCategory(analysisResult.name || analysisResult.path || '')
    const isImageFile = fileCategory === FileCategory.IMAGE
    const isAudioVideo = fileCategory === FileCategory.AUDIO || fileCategory === FileCategory.VIDEO

    const hasImageOcr =
      isImageFile && Boolean(analysisResult.ocr?.trim() || analysisResult.content?.trim())
    if (hasImageOcr) {
      tabs.push({ id: 'ocr', label: t('OCR'), icon: 'document_scanner' })
    }

    if (isAudioVideo) {
      if (analysisResult.asr?.trim() || analysisResult.content?.trim()) {
        tabs.push({ id: 'asr', label: t('音频文本'), icon: 'record_voice_over' })
      }
      if (analysisResult.lrc?.trim()) {
        tabs.push({ id: 'lrc', label: t('歌词'), icon: 'music_note' })
      }
    }

    if (!isImageFile && !isAudioVideo && analysisResult.content?.trim()) {
      tabs.push({ id: 'summary', label: t('内容摘要'), icon: 'summarize' })
    }

    const hasCategoryContent = Boolean(
      analysisResult.category &&
      (typeof analysisResult.category === 'object'
        ? Object.keys(analysisResult.category).length > 0
        : String(analysisResult.category).trim().length > 0)
    )
    const hasMetadataObject = Boolean(
      analysisResult.metadata &&
      typeof analysisResult.metadata === 'object' &&
      Object.keys(analysisResult.metadata).length > 0
    )
    const hasMetadataContent = hasCategoryContent || hasMetadataObject
    if (hasMetadataContent) tabs.push({ id: 'metadata', label: t('元数据'), icon: 'analytics' })
    if (analysisResult.analysisStats) tabs.push({ id: 'timing', label: t('耗时'), icon: 'timer' })
    return tabs
  }, [analysisResult, activeLanguage, isFileAnalysis, t])

  useEffect(() => {
    if (availableTabs.length > 0 && !availableTabs.some(tab => tab.id === activeTab))
      setActiveTab(availableTabs[0].id)
  }, [availableTabs, activeTab])

  // 渲染指定 ID 的微宫格卡片内容
  const renderCardContent = (id: DetailsCardId) => {
    switch (id) {
      case DETAILS_CARD_IDS.MINI_PREVIEW:
        return (
          <DetailsCardMiniPreview
            displayUrl={displayUrl}
            item={item}
            isDirectory={isDir}
            showDirectory={showDirectory}
            analysisResult={analysisResult}
            isFileAnalysis={isFileAnalysis}
            previewCollapsed={previewCollapsed}
          />
        )
      case DETAILS_CARD_IDS.SUMMARY:
        return (
          <DetailsCardSummary
            item={item}
            analysisResult={analysisResult}
            isDirectory={isDir}
            showDirectory={showDirectory}
            maskClass={maskClass}
            isFileAnalysis={isFileAnalysis}
            isDirAnalysis={isDirAnalysis}
          />
        )
      case DETAILS_CARD_IDS.TAGS:
        return (
          <DetailsCardTags
            analysisResult={analysisResult}
            getTagColor={getTagColor}
            onTagDeleted={refreshAnalysis}
            isDirectory={isDir}
            showDirectory={showDirectory}
            isFileAnalysis={isFileAnalysis}
          />
        )
      case DETAILS_CARD_IDS.METRICS:
        return (
          <DetailsCardMetrics
            item={item}
            analysisResult={analysisResult}
            isDirectory={isDir}
            showDirectory={showDirectory}
            availableTabs={availableTabs}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            maskClass={maskClass}
            formatDate={formatDate}
            getTagColor={getTagColor}
            refreshAnalysis={refreshAnalysis}
            workspaceDirectoryPath={workspaceDirectoryPath}
            isDirAnalysis={isDirAnalysis}
          />
        )
      default:
        return null
    }
  }

  const isOnlyOneVisible = effectiveCards.length <= 1

  return (
    <aside className="w-full flex-1 min-w-0 border-l border-border flex flex-col h-full overflow-hidden select-text @container/details bg-card">
      {/* 升维范式 1：极简微型动作槽（左侧复原胶囊，右侧面板全局折叠 X） */}
      <DetailsMicroActionStrip
        pageId={pageId}
        visibleCards={visibleCards}
        isDirMode={isDirMode}
        onToggleCard={toggleCard}
        onClose={onClose}
      />

      {/* 置顶状态横幅（原文件丢失告警 / 最小单元标记） */}
      <DetailsPinnedBanner item={item} analysisResult={analysisResult} />

      {/* 自适应内容高度网格容器 (L3 Spec: auto-rows-min，自然高度撑开，整体平滑滚动) */}
      <div
        data-testid="file-details-container"
        className="flex-1 min-h-0 w-full overflow-y-auto p-3.5 grid grid-cols-1 @[540px]/details:grid-cols-2 auto-rows-min gap-3.5 content-start"
      >
        {effectiveCards.map((cardId, index) => {
          // 动态跨列规则：当仅有 1 张卡片可见时（包括目录画像），或者恰好有 3 张卡片可见的首张，在宽屏跨两列全宽
          const isSpanTwo =
            effectiveCards.length === 1 || (effectiveCards.length === 3 && index === 0)
          const spanClass = isSpanTwo ? '@[540px]/details:col-span-2 w-full' : ''

          return (
            <DetailsCardWrapper
              key={cardId}
              id={cardId}
              isOnlyOneVisible={isOnlyOneVisible}
              onCloseCard={() => toggleCard(pageId, cardId)}
              className={cn(spanClass, effectiveCards.length === 1 && 'min-h-[260px]')}
            >
              {renderCardContent(cardId)}
            </DetailsCardWrapper>
          )
        })}
      </div>

      {/* 底部自适应限宽靠右工具栏 (L3 Spec: 宽屏靠右收敛，主按钮 <=140px，清空方块 h-8 w-8) */}
      {isRealDirectory && (
        <DetailsBottomActions
          isDirectory={isDir}
          showDirectory={showDirectory}
          analysisResult={analysisResult}
          reanalyzing={reanalyzing}
          queueStatus={queueStatus}
          deleting={deleting}
          isFileAnalysis={isFileAnalysis}
          isDirAnalysis={isDirAnalysis}
          handleReanalyze={handleReanalyze}
          handleDirectoryReanalyze={handleDirectoryReanalyze}
          handleBatchAnalyzeSubfiles={handleBatchAnalyzeSubfiles}
          onOpenClearDialog={() => setShowDeleteDialog(true)}
        />
      )}

      {/* 确认清空分析结果对话框 */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('确认清空分析结果？')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('此操作将删除该{category}的所有AI分析数据{sentens}，但不会删除{category}本身。', {
                category: isDir ? t('目录') : t('文件'),
                sentens: isDir
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
                await (isDir ? handleDirectoryClearAnalysis() : handleClearAnalysis())
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

export const FileDetailsPanel = React.memo(FileDetailsPanelComponent)
