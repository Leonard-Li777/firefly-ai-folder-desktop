import {
  AIDirectoryStructure,
  VirtualDirectory,
  VirtualDirectoryFileInput,
  DirectoryReorganizeOptions,
  DirectoryReorganizeResult
} from '@firefly/types'
import { LogCategory, logger } from '@firefly/shared'
import Database from 'better-sqlite3'
import path from 'node:path'
import { t } from '@app/languages'
import { databaseService } from '../../database/database-service'
import { analyzedDirectoryService } from '../analyzed-directory-service'
import { ConfigOrchestrator } from '../../../config/config-orchestrator'
import { DirectoryContextService } from '../directory-context-service'
import { unifiedModelManager } from '../../llama/unified-model-manager'

export interface AISchemeProvider {
  db: Database.Database
  createFromStrategy(
    workspaceId: number,
    name: string,
    strategy: string,
    source: string,
    icon?: string,
    perspective?: string
  ): Promise<VirtualDirectory>
  replaceFiles(virtualDirectoryId: number, files: VirtualDirectoryFileInput[]): Promise<void>
  get(id: number): Promise<VirtualDirectory | null>
}

export class AISchemeGenerator {
  constructor(private provider: AISchemeProvider) {}

  /**
   * 获取当前选中模型的 numPredict 值
   * 优先从模型 recommendedConfig 读取，云端模式或无模型时回退到默认值
   */
  private getNumPredict(): number {
    const config = ConfigOrchestrator.getInstance()
    const aiServiceMode = config.getValue<string>('AI_SERVICE_MODE')
    const activeSource = config.getValue<string>('SELECTED_MODEL_SOURCE')
    const selectedModelId =
      aiServiceMode === 'cloud'
        ? (config.getValue<string>('AI_CLOUD_SELECTED_MODEL_ID') as string)
        : (config.getValue<string>('SELECTED_MODEL_ID') as string)

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
        return modelConfig.recommendedConfig.numPredict
      }
    }
    return 8192
  }

  /**
   * 从 AI 整理方案保存为虚拟目录
   */
  async saveFromPlan(
    workspaceId: number,
    name: string,
    structure: AIDirectoryStructure
  ): Promise<VirtualDirectory> {
    const vd = await this.provider.createFromStrategy(
      workspaceId,
      name,
      JSON.stringify({ summary: structure.summary }),
      'ai_skill'
    )

    const files: VirtualDirectoryFileInput[] = []
    const directoryPaths = new Map<string, string>()

    // 构建目录路径映射 (与 OrganizeRealDirectoryService 逻辑对齐)
    const buildPath = (dirId: string): string => {
      if (directoryPaths.has(dirId)) return directoryPaths.get(dirId)!
      const dir = structure.directories.find(d => (d.id || d.name) === dirId)
      if (!dir) return ''
      const parentPath = dir.parent ? buildPath(dir.parent) : ''
      const fullPath = path.join(parentPath, dir.name)
      directoryPaths.set(dirId, fullPath)
      return fullPath
    }

    for (const dir of structure.directories) {
      const relativeDirPath = buildPath(dir.id || dir.name)
      if (dir.files) {
        for (const file of dir.files) {
          if (typeof file === 'object' && file.id) {
            const dbFile = this.provider.db
              .prepare('SELECT file_fingerprint FROM workspace_files WHERE id = ?')
              .get(file.id) as { file_fingerprint: string } | undefined
            if (dbFile) {
              const fileName = file.name || file.smartName || `file_${file.id}`
              files.push({
                fileId: file.id,
                fileFingerprint: dbFile.file_fingerprint,
                relativePath: relativeDirPath ? `${relativeDirPath}/${fileName}` : fileName
              })
            }
          }
        }
      }
    }

    await this.provider.replaceFiles(vd.id, files)
    return vd
  }

  async generateNameAndStrategyCandidates(
    workspaceId: number,
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
    const state = await import('../../../main/state')

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
          const fpRows = this.provider.db
            .prepare(
              'SELECT file_fingerprint FROM workspace_files WHERE id IN (' +
                [...selectIdSet].map(() => '?').join(',') +
                ')'
            )
            .all(...[...selectIdSet]) as Array<{ file_fingerprint: string }>
          if (fpRows.length > 0) {
            const fps = fpRows.map(r => r.file_fingerprint)
            const tagRows = this.provider.db
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

    const numPredict = this.getNumPredict()
    const isLimitPredict = numPredict <= 2048
    const finalCount = isLimitPredict ? 1 : count

    const config = ConfigOrchestrator.getInstance()
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

  async checkIsLimitPredict(): Promise<boolean> {
    const numPredict = this.getNumPredict()
    return numPredict <= 2048
  }

  async reorganize(
    virtualDirectoryId: number,
    options: DirectoryReorganizeOptions
  ): Promise<DirectoryReorganizeResult> {
    const { coreEngine } = await import('../../../main/state')
    if (!coreEngine) throw new Error(t('核心引擎未初始化，请等待初始化完成后再试'))

    const { filesToOrganize, vd } = await this.prepareReorganizeData(
      virtualDirectoryId,
      options,
      virtualDirectoryId > 0
    )

    const result = await (coreEngine as any).directoryReorganizeService.reorganize({
      ...options,
      files: filesToOrganize,
      previousNameAndStrategy: vd ? { name: vd.name, strategy: vd.strategy } : undefined
    })

    return result
  }

  /**
   * 估算整理所需的总批次（与后端实际整理上报的 totalSteps 保持一致，不调用 AI 推理）。
   * 供整理开始前判断是否超过批次告警阈值，避免前端预估（按全部文件数）与实际批次数不一致。
   * 注意：估算阶段即使 virtualDirectoryId 为 0 也会回填标签文件，以便得到真实的骨架直出预分配数量。
   */
  async estimateReorganizeBatches(
    virtualDirectoryId: number,
    options: DirectoryReorganizeOptions
  ): Promise<number> {
    const { coreEngine } = await import('../../../main/state')
    if (!coreEngine) throw new Error(t('核心引擎未初始化，请等待初始化完成后再试'))

    const { filesToOrganize } = await this.prepareReorganizeData(virtualDirectoryId, options, true)

    return (coreEngine as any).directoryReorganizeService.estimateReorganizeBatches({
      ...options,
      files: filesToOrganize
    })
  }

  /**
   * 整理前数据准备：收集待整理文件列表，并按需将文件按标签回填到 selectedTagsTree 的骨架节点上。
   * @param backfillFiles 是否回填标签文件。正式整理与批次估算需要回填（true），预览模式不应回填（false）
   */
  private async prepareReorganizeData(
    virtualDirectoryId: number,
    options: DirectoryReorganizeOptions,
    backfillFiles: boolean
  ): Promise<{ filesToOrganize?: Array<{ id: number; name: string }>; vd: any }> {
    let filesToOrganize: Array<{ id: number; name: string }> | undefined

    // 收集文件列表
    if (options.isRescue && options.files && options.files.length > 0) {
      filesToOrganize = options.files
      logger.info(
        LogCategory.FILE_ORGANIZATION,
        '补救整理批次，直接使用前端传入的待分类文件列表:',
        {
          filesCount: filesToOrganize.length
        }
      )
    } else if (options.selectedFileIds && options.selectedFileIds.length > 0) {
      const placeholders = options.selectedFileIds.map(() => '?').join(',')
      const dbFiles = this.provider.db
        .prepare(
          `
          SELECT wf.id, f.smart_name as name
          FROM workspace_files wf
                 JOIN files f ON wf.file_fingerprint = f.file_fingerprint
          WHERE wf.id IN (${placeholders})
        `
        )
        .all(...options.selectedFileIds) as any[]
      filesToOrganize = dbFiles.map(f => ({ id: f.id, name: f.name }))
    } else if (options.workspaceDirectoryPath) {
      // 预览模式：从工作目录获取所有已分析文件
      const workspaceDir = await databaseService.getWorkspaceDirectoryByPath(
        options.workspaceDirectoryPath
      )
      if (workspaceDir && workspaceDir.id) {
        const allFiles = await databaseService.getFilesByWorkspaceId(workspaceDir.id)
        const analyzedFiles = allFiles.filter(f => f.is_analyzed === 1)
        filesToOrganize = analyzedFiles.map(f => ({
          id: f.id,
          name: f.smart_name || f.name || f.path.split(/[\\/]/).pop() || ''
        }))
        logger.info(LogCategory.FILE_ORGANIZATION, '预览模式获取文件:', {
          totalFiles: allFiles.length,
          analyzedFiles: analyzedFiles.length,
          filesToSend: filesToOrganize.length
        })
      }
    }

    // 预览模式：virtualDirectoryId = 0 时跳过VD查询
    let vd: any = null
    if (virtualDirectoryId > 0) {
      vd = await this.provider.get(virtualDirectoryId)
    }

    // 正式整理或补救整理时（backfillFiles 为 true），由于前端传进来的 selectedTagsTree 各节点的 files 数组通常为空，
    // 我们在此通过查询数据库标签，将 filesToOrganize 中的文件回填到对应的骨架标签节点上，
    // 从而保证底层 fastOrganize 的骨架直出（优先按已有标签自动归类，不经由 AI 分类）逻辑能够正常生效。
    // 在预览模式下（backfillFiles 为 false），我们不应回填文件，以保证只显示目录结构。
    if (
      backfillFiles &&
      options.selectedTagsTree &&
      Array.isArray(options.selectedTagsTree) &&
      filesToOrganize &&
      filesToOrganize.length > 0
    ) {
      const fileIds = filesToOrganize.map(f => f.id)
      const fileTagMap = new Map<number, string[]>()
      const batchSize = 500
      for (let i = 0; i < fileIds.length; i += batchSize) {
        const batchIds = fileIds.slice(i, i + batchSize)
        const placeholders = batchIds.map(() => '?').join(',')
        try {
          const relations = this.provider.db
            .prepare(
              `
              SELECT wf.id as file_id, ft.name as tag_name
              FROM file_tag_relations ftr
                     JOIN file_tags ft ON ftr.tag_id = ft.id
                     JOIN workspace_files wf ON wf.file_fingerprint = ftr.file_fingerprint
              WHERE wf.id IN (${placeholders})
            `
            )
            .all(...batchIds) as Array<{ file_id: number; tag_name: string }>

          for (const rel of relations) {
            if (!fileTagMap.has(rel.file_id)) {
              fileTagMap.set(rel.file_id, [])
            }
            fileTagMap.get(rel.file_id)!.push(rel.tag_name)
          }
        } catch (err) {
          logger.error(LogCategory.FILE_ORGANIZATION, '回填标签树文件时查询数据库失败:', err)
        }
      }

      const backfillTree = (nodes: any[]) => {
        for (const node of nodes) {
          if (!node.name) continue

          if (!node.files) {
            node.files = []
          }

          for (const file of filesToOrganize!) {
            const fileTags = fileTagMap.get(file.id) || []
            if (fileTags.includes(node.name)) {
              const exists = node.files.some((f: any) => String(f.id) === String(file.id))
              if (!exists) {
                node.files.push({
                  id: String(file.id),
                  name: file.name
                })
              }
            }
          }

          if (node.subdirectories && node.subdirectories.length > 0) {
            backfillTree(node.subdirectories)
          }
        }
      }

      backfillTree(options.selectedTagsTree)
      logger.info(
        LogCategory.FILE_ORGANIZATION,
        '回填标签树文件成功，已将符合标签的文件关联到骨架节点中'
      )
    }

    return { filesToOrganize, vd }
  }
}
