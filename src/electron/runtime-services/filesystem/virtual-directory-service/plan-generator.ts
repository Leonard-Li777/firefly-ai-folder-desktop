import { LogCategory, logger } from '@firefly/shared'
import path from 'node:path'
import { databaseService } from '../../database/database-service'
import { analyzedDirectoryService } from '../analyzed-directory-service'
import { ConfigOrchestrator } from '../../../config/config-orchestrator'
import { unifiedModelManager } from '../../llama/unified-model-manager'
import { DirectoryContextService } from '../directory-context-service'
import Database from 'better-sqlite3'

export async function generateNameAndStrategyCandidates(
  db: Database.Database,
  workspaceId: number,
  state: {
    directoryContextService: any
    globalLlamaIndexService: any
    setDirectoryContextService: (s: any) => void
  },
  count = 3,
  userHint?: string,
  organizeMode?: 'fast-organize' | 'fine-organize',
  /** 可选：仅限这些文件ID的数据用于构建提示词 */
  selectedFileIds?: number[]
): Promise<{
  candidates: Array<{
    name: string
    strategy: string
    perspective: string
    rationale: string
  }>
}> {
  let activeDirectoryContextService = state.directoryContextService
  if (!activeDirectoryContextService && state.globalLlamaIndexService) {
    activeDirectoryContextService = new DirectoryContextService(state.globalLlamaIndexService)
    if (typeof state.setDirectoryContextService === 'function') {
      state.setDirectoryContextService(activeDirectoryContextService)
    }
    logger.info(
      LogCategory.FILE_ORGANIZATION,
      'generateNameAndStrategyCandidates 自动修复：自愈绑定 directoryContextService 成功'
    )
  }

  const directoryAnalyzer = activeDirectoryContextService?.getDirectoryAnalyzer()

  // Gathering stats for analyzer
  const allFiles = await databaseService.getFilesByWorkspaceId(workspaceId)
  // 如果提供了 selectedFileIds，仅使用勾选文件的数据构建提示词
  const selectIdSet =
    selectedFileIds && selectedFileIds.length > 0
      ? new Set(selectedFileIds.map(id => String(id)))
      : null
  const files = selectIdSet ? allFiles.filter(f => selectIdSet.has(String(f.id))) : allFiles

  const fileTypeDistribution: Record<string, number> = {}
  const sampleFileNames: string[] = []
  // 随机抽取最多 20 个文件名作为样本，避免以篇概全
  files.forEach(f => {
    const ext = path.extname(f.path).toLowerCase()
    fileTypeDistribution[ext] = (fileTypeDistribution[ext] || 0) + 1
  })
  const shuffledFiles = [...files].sort(() => 0.5 - Math.random())
  shuffledFiles.slice(0, 20).forEach(f => {
    sampleFileNames.push(f.smart_name || path.basename(f.path))
  })

  logger.info(LogCategory.FILE_ORGANIZATION, 'DEBUG generateNameAndStrategyCandidates stats:', {
    hasDirectoryContextService: !!activeDirectoryContextService,
    hasDirectoryAnalyzer: !!directoryAnalyzer,
    filesCount: files.length,
    workspaceId
  })

  if (!directoryAnalyzer) return { candidates: [] }

  // 获取维度标签树信息
  let dimensionTree: any[] = []
  let workspaceDir: any = null
  let skeletonTags: string[] = []
  try {
    workspaceDir = await databaseService.getWorkspaceDirectoryById(workspaceId)
    logger.info(LogCategory.FILE_ORGANIZATION, '获取维度标签:', {
      workspaceId,
      workspaceDirPath: workspaceDir?.path,
      hasAnalyzedDirectoryService: !!analyzedDirectoryService
    })
    if (workspaceDir && workspaceDir.path && analyzedDirectoryService) {
      const response = await analyzedDirectoryService.getDimensionGroups(workspaceDir.path)
      const groups = response?.groups || []

      // 如果限制了文件选择，查询这些文件实际拥有的标签，用于过滤维度标签树
      let selectedFileTagSet: Set<string> | null = null
      if (selectIdSet && selectIdSet.size > 0) {
        const fpRows = db
          .prepare(
            'SELECT file_fingerprint FROM workspace_files WHERE id IN (' +
              [...selectIdSet].map(() => '?').join(',') +
              ')'
          )
          .all(...[...selectIdSet]) as Array<{ file_fingerprint: string }>
        if (fpRows.length > 0) {
          const fps = fpRows.map(r => r.file_fingerprint)
          const tagRows = db
            .prepare(
              'SELECT DISTINCT ft.name FROM file_tags ft JOIN file_tag_relations ftr ON ftr.tag_id = ft.id WHERE ftr.file_fingerprint IN (' +
                fps.map(() => '?').join(',') +
                ')'
            )
            .all(...fps) as Array<{ name: string }>
          selectedFileTagSet = new Set(tagRows.map(r => r.name))
        }
      }

      logger.info(LogCategory.FILE_ORGANIZATION, '维度标签结果:', {
        groupsCount: groups.length,
        tagsCount: groups.reduce((sum: number, g: any) => sum + (g.tags?.length || 0), 0),
        selectedFileTagSet: selectedFileTagSet?.size
      })
      // 过滤掉文件计数为0的标签，只保留有实际文件的标签；如有限制则只保留已勾选文件拥有的标签
      const tagFilter = (tag: any) => {
        if ((tag.fileCount || 0) <= 0) return false
        if (selectedFileTagSet && !selectedFileTagSet.has(tag.tagValue)) return false
        return true
      }
      dimensionTree = groups
        .map((g: any) => ({
          d: g.name,
          t: (g.tags || [])
            .filter(tagFilter)
            .slice(0, 10)
            .map((tag: any) => ({
              v: tag.tagValue,
              c: tag.fileCount || 0
            }))
        }))
        .filter((g: any) => g.t.length > 0)

      // 计算快速整理模式下的骨架高频标签
      const totalFiles = files.length
      let n = Math.round(Math.sqrt(totalFiles))
      if (totalFiles <= 15) n = 2
      n = Math.min(30, Math.max(2, n))
      const x = Math.max(1, Math.round(n * 0.25))
      const skeletonCount = Math.max(n - x, 1)

      const allTags: Array<{ name: string; fileCount: number }> = []
      for (const g of groups) {
        if (
          g.name === '文件质量' ||
          g.name.toLowerCase() === 'quality' ||
          String(g.id) === 'file_quality' ||
          String(g.id) === 'quality'
        ) {
          continue
        }
        if (g.tags) {
          for (const t of g.tags) {
            if (t.tagValue && (t.fileCount || 0) > 0) {
              if (selectedFileTagSet && !selectedFileTagSet.has(t.tagValue)) continue
              allTags.push({
                name: t.tagValue,
                fileCount: t.fileCount
              })
            }
          }
        }
      }
      const sortedTags = allTags.sort((a, b) => b.fileCount - a.fileCount)
      skeletonTags = sortedTags.slice(0, skeletonCount).map(t => t.name)
    } else {
      logger.warn(LogCategory.FILE_ORGANIZATION, '获取维度标签失败:', {
        workspaceDir: !!workspaceDir,
        workspaceDirPath: workspaceDir?.path,
        analyzedDirectoryService: !!analyzedDirectoryService,
        workspaceId
      })
    }
  } catch (e) {
    logger.error(LogCategory.FILE_ORGANIZATION, '获取维度标签异常:', e)
  }

  // 构建 fileTypeDistribution 字符串，使用 Markdown 表格
  let fileTypeStr = ''
  const fileTypeEntries = Object.entries(fileTypeDistribution)
  if (fileTypeEntries.length > 0) {
    const rows = fileTypeEntries.map(([ext, count]) => `| ${ext} | ${count} |`)
    fileTypeStr = '| 文件扩展名 | 文件数量 |\n| --- | --- |\n' + rows.join('\n')
  }

  // 构建维度标签树字符串，使用 Markdown 表格
  let dimensionTreeStr = ''
  if (dimensionTree.length > 0) {
    const rows: string[] = []
    for (const group of dimensionTree) {
      const dimName = group.d
      for (const tag of group.t || []) {
        rows.push(`| ${dimName} | ${tag.v} | ${tag.c} |`)
      }
    }
    if (rows.length > 0) {
      dimensionTreeStr = '| 维度 | 标签 | 文件数量 |\n| --- | --- | --- |\n' + rows.join('\n')
    }
  }

  const config = ConfigOrchestrator.getInstance()
  const aiServiceMode = config.getValue<string>('AI_SERVICE_MODE')
  const activeSource = config.getValue<string>('SELECTED_MODEL_SOURCE')
  const selectedModelId =
    aiServiceMode === 'cloud'
      ? (config.getValue<string>('AI_CLOUD_SELECTED_MODEL_ID') as string)
      : (config.getValue<string>('SELECTED_MODEL_ID') as string)

  let numPredict = 8192
  if (selectedModelId) {
    let modelConfig = unifiedModelManager.getModelById(selectedModelId, activeSource)
    if (!modelConfig) {
      modelConfig = unifiedModelManager.getModelById(selectedModelId)
    }
    if (!modelConfig) {
      const allModels = unifiedModelManager.getAllModels()
      modelConfig = allModels.find(m => m.id === selectedModelId || m.name === selectedModelId)
    }
    if (modelConfig?.recommendedConfig?.numPredict !== undefined) {
      numPredict = modelConfig.recommendedConfig.numPredict
    }
  }
  const isLimitPredict = numPredict <= 2048
  const finalCount = isLimitPredict ? 1 : count
  const appLanguage = (config.getValue<string>('DEFAULT_LANGUAGE') as any) || 'zh-CN'

  const candidates = await directoryAnalyzer.analyzeForVirtualDirectoryNameCandidates(
    {
      directoryPath: workspaceDir?.path || 'Workspace',
      fileTypeDistribution: fileTypeStr as any,
      namingPatterns: [],
      languageDetected: [],
      specialFiles: [],
      fileStructure: sampleFileNames,
      dimensionTree: dimensionTreeStr,
      userHint,
      organizeMode,
      skeletonTags,
      isLimitPredict
    },
    appLanguage,
    finalCount
  )

  return candidates
}

export async function checkIsLimitPredict(): Promise<boolean> {
  const config = ConfigOrchestrator.getInstance()
  const aiServiceMode = config.getValue<string>('AI_SERVICE_MODE')
  let numPredict = 2048
  if (aiServiceMode !== 'cloud') {
    const selectedModelId = config.getValue<string>('SELECTED_MODEL_ID')
    if (selectedModelId) {
      const modelConfig = unifiedModelManager.getModelById(selectedModelId)
      if (modelConfig?.recommendedConfig?.numPredict !== undefined) {
        numPredict = modelConfig.recommendedConfig.numPredict
      }
    }
  }
  return numPredict === 1024
}
