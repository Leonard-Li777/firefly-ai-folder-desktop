import {
  DuplicateDeleteResult,
  DuplicateDetectionOptions,
  DuplicateGroup,
  DuplicateFixAction,
  DuplicateFixResult
} from '@firefly/types'
import { LogCategory, logger } from '@firefly/shared'
import { DEFAULT_CONCURRENCY, existsAsync, mapLimit } from '../../infra/fs'
import { omniService } from '../system/omni-service'
import {
  applySmartRecommendKeep,
  formatBytes,
  getProtectedExcludedItems,
  parseResolution
} from './duplicate-detection/duplicate-recommendation'
import { getTargetFilesFromDb } from './duplicate-detection/duplicate-db-repository'
import {
  mergeDuplicateGroups,
  scanDocSemanticsAndHeuristics,
  scanViaOmniRust
} from './duplicate-detection/duplicate-scanner'
import { trashDuplicateFiles } from './duplicate-detection/duplicate-trash'
import { executeStrategyFix } from './duplicate-detection/duplicate-fix-executor'

export class DuplicateDetectionService {
  /**
   * Omni API 基础 URL：统一委托给 omniService.getBaseUrl() 单一事实源（由服务发现文件与 SSE 动态维护），
   * 已彻底退役脆弱的 OMNI_ACTUAL_PORT 环境变量读取依赖。
   */
  private get omniApiUrl(): string {
    return omniService.getBaseUrl()
  }

  /**
   * 获取当前系统与配置中不可被清理的受保护排除项名单 (严格依据 IGNORE_RULES 中的 isCzkawka 配置)
   */
  public getProtectedExcludedItems(): string[] {
    return getProtectedExcludedItems()
  }

  /**
   * 执行双轨并行查重扫描 (支持已分析与未分析的全量工作区物理文件)
   */
  public async scanDuplicates(
    options: DuplicateDetectionOptions,
    onProgress?: (data: {
      scanned: number
      totalScanned: number
      stage: string
      group?: any
    }) => void
  ): Promise<DuplicateGroup[]> {
    const fileIdsCount = options.fileIds?.length ?? 0
    const hasWorkspacePath = options.workspaceDirectoryPath
      ? await existsAsync(options.workspaceDirectoryPath)
      : false

    logger.debug(LogCategory.FILE_ORGANIZATION, '开始执行双轨查重扫描', {
      workspaceDirectoryPath: options.workspaceDirectoryPath,
      targetFilesCount: fileIdsCount > 0 ? fileIdsCount : '全目录全量物理文件',
      strategiesCount: options.strategies?.length ?? 0,
      minSimilarity: options.minSimilarity
    })
    const startTime = Date.now()

    // 1. 获取要扫描的目标文件列表与已有元数据 (从 SQLite 读取已分析记录，用于后续元数据富化)
    const dbFiles = await getTargetFilesFromDb(options)
    const existsFlags = await mapLimit(dbFiles, DEFAULT_CONCURRENCY, async f =>
      existsAsync(f.path)
    )
    const filePaths = dbFiles.filter((_, idx) => existsFlags[idx]).map(f => f.path)

    // 若既没有指定文件且工作区目录无效，则无目标可扫
    if (filePaths.length === 0 && !hasWorkspacePath) {
      return []
    }

    // 2. 双轨并发扫描 (Promise.all)
    // Omni 负责对全量物理目录进行全策略扫描，DocSemantics 负责对已有数据库文本进行语义对比
    const [omniResult, docResult] = await Promise.allSettled([
      scanViaOmniRust(this.omniApiUrl, filePaths, options, onProgress),
      dbFiles.length > 0 ? scanDocSemanticsAndHeuristics(dbFiles, options) : Promise.resolve([])
    ])

    const omniGroups = omniResult.status === 'fulfilled' ? omniResult.value : []
    const docGroups = docResult.status === 'fulfilled' ? docResult.value : []

    // 3. 结果合并与数据库元数据富化 (图片分辨率、质量分、缩略图)
    const mergedGroups = mergeDuplicateGroups(omniGroups, docGroups, dbFiles)

    // 4. 默认智能推荐保留项打标 (最高分辨率 > 最高质量分 > 最新修改时间)
    applySmartRecommendKeep(mergedGroups, 'highest_resolution')

    logger.debug(
      LogCategory.FILE_ORGANIZATION,
      `查重扫描完成，发现 ${mergedGroups.length} 个相似/重复组，耗时: ${Date.now() - startTime}ms`
    )

    return mergedGroups
  }

  /**
   * 应用智能推荐保留规则
   */
  public static parseResolution(resStr?: string): number {
    return parseResolution(resStr)
  }

  public static formatBytes(bytes: number): string {
    return formatBytes(bytes)
  }

  public static applySmartRecommendKeep(groups: DuplicateGroup[], rule: string): DuplicateGroup[] {
    return applySmartRecommendKeep(groups, rule)
  }

  public applySmartRecommendKeep(groups: DuplicateGroup[], rule: string): DuplicateGroup[] {
    return DuplicateDetectionService.applySmartRecommendKeep(groups, rule)
  }

  /**
   * 安全清理选中的冗余文件 (移入操作系统回收站)
   */
  public async trashDuplicateFiles(filePaths: string[]): Promise<DuplicateDeleteResult> {
    return trashDuplicateFiles(filePaths)
  }

  /**
   * 执行专属指标修复动作 (优化视频、清理Exif、更名异常文件名、修正扩展名)
   */
  public async executeStrategyFix(
    action: DuplicateFixAction,
    fileTargets: Array<string | { path: string; newName?: string }>,
    workspaceDirectoryPath?: string
  ): Promise<DuplicateFixResult> {
    return executeStrategyFix(action, fileTargets, this.omniApiUrl, workspaceDirectoryPath)
  }
}

export const duplicateDetectionService = new DuplicateDetectionService()
