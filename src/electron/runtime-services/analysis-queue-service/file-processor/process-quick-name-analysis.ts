import { AnalysisQueueItem, LanguageCode, FileCategory as MagikaCategory } from '@firefly/types'
import { LogCategory, logger, PerformanceTimer } from '@firefly/shared'
import { t } from '@app/languages'
import { DimensionAnalyzer, FileDimensionService, type FileInfoInput } from '@firefly/core-engine'
import { IErrorRecoveryConfig } from '../types'

/**
 * 处理快速命名模式下的本地 AI 分析任务
 * 单步生成智能文件名与维度标签，跳过 Stage 3 质量评分与 Stage 4 复杂描述分析
 */
export async function processQuickNameAnalysis(
  item: AnalysisQueueItem,
  fileFingerprint: string,
  fileInfo: FileInfoInput,
  thumbnailRelativePath: string | undefined,
  rootWorkspaceDirPath: string,
  timer: PerformanceTimer,
  deps: {
    dimensionAnalyzer: DimensionAnalyzer | undefined
    fileDimensionService: FileDimensionService | undefined
    errorRecoveryConfig: IErrorRecoveryConfig
  },
  options: {
    language: string
    directoryContext: any
    magikaCategory: MagikaCategory | null
    isSpeedy: boolean
    initialStage?: number
    forceReanalyze?: boolean
  },
  updateItemStatus: (
    itemId: number,
    status: any,
    progress: number,
    error?: string,
    extra?: any
  ) => void,
  processNewDimensionSuggestions: (suggestions: any[], fileFingerprint: string) => Promise<void>
): Promise<any> {
  const { language, directoryContext, magikaCategory, isSpeedy } = options

  // ========== 快速命名阶段：跳过 Stage 3 质量评分，直接执行 Stage 4 智能命名与维度分析 ==========
  updateItemStatus(item.id, 'analyzing', 25, undefined, { analysisStage: 4 })

  if (!deps.dimensionAnalyzer || !deps.fileDimensionService) {
    throw new Error(t('AI 服务未就绪'))
  }

  const existingDimensions = await deps.fileDimensionService.getDimensionsByLanguage(
    language as LanguageCode
  )

  const filePath = fileInfo.path
  const fileType = fileInfo.type

  const processResult = {
    content: fileInfo.content || '',
    metadata: fileInfo.metadata || {},
    qualityScore: undefined,
    qualityConfidence: undefined,
    qualityReasoning: undefined,
    qualityCriteria: undefined,
    multimodalContent: undefined,
    lrc: undefined
  }

  timer.start('dimensionAnalysis')
  logger.info(LogCategory.ANALYSIS_QUEUE, `[快速命名] 执行快速AI分析分支: ${item.name}`)

  const dimResult = await deps.dimensionAnalyzer.quickAnalyzeFile(
    filePath,
    item.name,
    fileType,
    fileInfo.size,
    processResult.content,
    processResult.metadata,
    existingDimensions,
    directoryContext,
    magikaCategory,
    isSpeedy
  )

  if (dimResult) {
    await deps.dimensionAnalyzer.saveDimensionAnalysisResults(
      fileFingerprint,
      filePath,
      dimResult,
      processResult.metadata,
      magikaCategory
    )
    if (dimResult.newDimensions) {
      await processNewDimensionSuggestions(dimResult.newDimensions, fileFingerprint)
    }
  }
  timer.end('dimensionAnalysis')

  return { processResult, dimResult }
}
