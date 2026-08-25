/**
 * 目录上下文分析服务
 * 智能分析工作目录的整体用途和内容特征
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import Database from 'better-sqlite3'
import { DirectoryContextAnalysis } from '@firefly/types/dimension-types'
import { LanguageCode } from '@firefly/types/i18n-types'
import {
  logger,
  LogCategory,
  FileCategory,
  getFileCategory,
  validateAndNormalizeNamingPattern
} from '@firefly/shared'
import { t } from '@app/languages'
import { magikaService } from '../system/magika-service'
import { ConfigOrchestrator } from '../../config/config-orchestrator'
import { loadIgnoreRules, shouldIgnoreFile } from '../analysis/analysis-ignore-service'
import { IIgnoreRule } from '@firefly/types/settings-types'
import { DirectoryAnalyzer, IModelCapabilityAdapter, AIHelper } from '@firefly/core-engine'
import { LlamaIndexAIAdapter } from '../../adapters/llama-index-ai-adapter'
import { ILlamaIndexAIService } from '@firefly/types'
import { databaseService } from '../database/database-service'

/**
 * 目录上下文分析服务类
 */
export class DirectoryContextService {
  private aiService: ILlamaIndexAIService
  private directoryAnalyzer: DirectoryAnalyzer
  private capabilityAdapter: IModelCapabilityAdapter
  private aiHelper: AIHelper

  constructor(aiService: ILlamaIndexAIService) {
    const aiAdapter = new LlamaIndexAIAdapter(aiService)
    this.aiService = aiService
    this.capabilityAdapter = aiAdapter.capabilityAdapter
    this.aiHelper = new AIHelper(this.capabilityAdapter)

    // 创建正确的AI适配器
    // 传递 aiAdapter 作为 aiService 给 DirectoryAnalyzer
    this.directoryAnalyzer = new DirectoryAnalyzer(
      aiAdapter,
      aiAdapter.capabilityAdapter,
      (key: string) => ConfigOrchestrator.getInstance().getValue(key as any),
      this.aiHelper
    )
  }

  /** 获取 DirectoryAnalyzer 实例（供其他服务使用） */
  getDirectoryAnalyzer(): DirectoryAnalyzer {
    return this.directoryAnalyzer
  }

  private get db(): Database.Database {
    if (!databaseService.db) {
      throw new Error(t('数据库连接未初始化'))
    }
    return databaseService.db
  }

  /**
   * 从模拟数据库中获取目录分析结果（用于集成测试）
   */
  private async getMockResultFromDB(directoryPath: string): Promise<any | null> {
    const mockDbPath = process.env.TEST_MOCK_DB_PATH
    if (!mockDbPath || !require('node:fs').existsSync(mockDbPath)) return null

    logger.info(
      LogCategory.DIRECTORY_CONTEXT,
      `[测试模式] 正在从模拟数据库尝试获取目录分析结果: ${directoryPath}`
    )

    try {
      const Database = require('better-sqlite3')
      const db = new Database(mockDbPath, { readonly: true })

      const dirName = path.basename(directoryPath)
      let row = db
        .prepare('SELECT * FROM workspace_directories WHERE path = ?')
        .get(directoryPath) as any

      if (!row) {
        // 尝试通过最后一段路径匹配
        row = db
          .prepare(
            'SELECT * FROM workspace_directories WHERE path LIKE ? AND is_analyzed = 1 LIMIT 1'
          )
          .get(`%${path.sep}${dirName}`) as any
      }

      if (row && row.context_analysis) {
        const analysis = JSON.parse(row.context_analysis)
        db.close()
        logger.info(
          LogCategory.DIRECTORY_CONTEXT,
          `[测试模式] 成功从模拟数据库获取目录分析结果: ${directoryPath}`
        )
        return analysis
      }

      db.close()
      return null
    } catch (error) {
      logger.warn(
        LogCategory.DIRECTORY_CONTEXT,
        `[测试模式] 从模拟数据库获取目录结果失败: ${error instanceof Error ? error.message : String(error)}`
      )
      return null
    }
  }

  /**
   * 分析目录上下文
   */
  async analyzeDirectoryContext(
    directoryPath: string,
    language: LanguageCode,
    force = false
  ): Promise<DirectoryContextAnalysis> {
    try {
      // 优先检查模拟结果（测试模式）
      if (process.env.APP_ENV === 'test') {
        const mockResult = await this.getMockResultFromDB(directoryPath)
        if (mockResult) {
          // 确保返回的是完整的 DirectoryContextAnalysis 结构
          const contextAnalysis: DirectoryContextAnalysis = {
            ...mockResult,
            directoryPath: directoryPath,
            analyzedAt: new Date()
          }
          // 保存到当前测试数据库中，以便后续使用缓存
          await this.saveContextAnalysis(directoryPath, contextAnalysis)
          return contextAnalysis
        }
      }

      // 直接使用原生路径，不归一化
      // 如果不是强制分析，尝试使用缓存
      if (!force) {
        const cached = await this.getDirectoryContext(directoryPath)
        // 检查缓存是否有效（包含必要的AI分析结果）
        if (cached && cached.analysisStrategy) {
          logger.info(LogCategory.DIRECTORY_CONTEXT, `使用缓存的目录上下文分析: ${directoryPath}`)
          return cached
        }
      }

      logger.info(LogCategory.DIRECTORY_CONTEXT, `开始分析目录上下文: ${directoryPath}`)

      // 1. 收集目录统计信息
      const stats = await this.collectDirectoryStats(directoryPath)

      // 2. 分析文件名模式
      const namingPatterns = await this.analyzeNamingPatterns(directoryPath)

      // 3. 检测语言特征
      const languageDetected = await this.detectLanguageFeatures(directoryPath)

      // 4. 检测特殊文件
      const specialFiles = await this.detectSpecialFiles(directoryPath)

      // 5. 判断是否为极速工作区
      let isSpeedy = false
      try {
        const workspaceRow = databaseService.db
          ?.prepare(
            `
          SELECT w.type FROM workspaces w
          JOIN workspace_directories wd ON wd.workspace_id = w.workspace_id
          WHERE wd.path = ? LIMIT 1
        `
          )
          .get(directoryPath) as { type?: string }
        if (workspaceRow?.type === 'SPEEDY') {
          isSpeedy = true
        }
      } catch (e) {
        // 忽略查询错误
      }

      // 6. 使用AI进行综合分析
      const aiAnalysis = await this.performAIAnalysis(
        {
          directoryPath: directoryPath,
          fileTypeDistribution: stats.fileTypeDistribution,
          namingPatterns,
          languageDetected,
          specialFiles
        },
        language,
        isSpeedy
      )

      const contextAnalysis: DirectoryContextAnalysis = {
        directoryPath: directoryPath,
        directoryType: aiAnalysis.directoryType,
        fileTypeDistribution: stats.fileTypeDistribution,
        namingPatterns,
        languageDetected,
        specialFiles,
        recommendedDimensions: aiAnalysis.recommendedDimensions,
        recommendedTags: aiAnalysis.recommendedTags,
        analysisStrategy: aiAnalysis.analysisStrategy,
        namingPattern: aiAnalysis.namingPattern,
        confidence: aiAnalysis.confidence,
        analyzedAt: new Date()
      }

      // 6. 保存到数据库
      await this.saveContextAnalysis(directoryPath, contextAnalysis)

      logger.info(LogCategory.DIRECTORY_CONTEXT, `目录上下文分析完成: ${directoryPath}`)
      return contextAnalysis
    } catch (error) {
      logger.error(LogCategory.DIRECTORY_CONTEXT, `目录上下文分析失败: ${directoryPath}`, error)
      throw error
    }
  }

  private async collectDirectoryStats(
    directoryPath: string
  ): Promise<{ fileTypeDistribution: Record<string, number> }> {
    const fileTypeDistribution: Record<string, number> = {}

    try {
      const entries = await fs.readdir(directoryPath, { withFileTypes: true })
      const files = entries.filter(e => e.isFile())

      for (const file of files) {
        const ext = path.extname(file.name)
        const type = this.getFileTypeCategory(ext)
        fileTypeDistribution[type] = (fileTypeDistribution[type] || 0) + 1
      }
    } catch (error) {
      logger.error(LogCategory.DIRECTORY_CONTEXT, '收集目录统计信息失败:', error)
    }

    return { fileTypeDistribution }
  }

  /**
   * 获取文件类型分类
   */
  private getFileTypeCategory(ext: string): string {
    const category = getFileCategory(ext)
    if (category === 'unknown') return 'other'
    return category
    return category
  }

  /**
   * 分析文件名模式
   */
  private async analyzeNamingPatterns(directoryPath: string): Promise<string[]> {
    const patterns: Set<string> = new Set()

    try {
      const entries = await fs.readdir(directoryPath)
      const fileNames = entries.filter(name => !name.startsWith('.'))

      if (fileNames.length === 0) return []

      // 检测数字编号模式 (前缀)
      // 宽松模式：只要有文件以数字开头即可 (保留原有逻辑，但可以稍微严格一点，比如>10%)
      if (fileNames.filter(name => /^\d+/.test(name)).length > 0) {
        patterns.add('numeric_prefix')
      }

      // 检测数字编号模式 (后缀) - 常见于 name_01.jpg
      if (fileNames.some(name => /[\-_]?\d+\.[^.]+$/.test(name))) {
        patterns.add('numeric_suffix')
      }

      // 检测章节模式
      if (fileNames.some(name => /第\d+章|chapter\d+|ep\d+/i.test(name))) {
        patterns.add('chapter_pattern')
      }

      // 检测日期模式 (增强版)
      // 支持 YYYY-MM-DD, YYYYMMDD, YYYY_MM_DD, YYMMDD 等
      if (fileNames.some(name => /(\d{4}[-_\.]?\d{2}[-_\.]?\d{2})/.test(name))) {
        patterns.add('date_pattern')
      }

      // 检测系列模式 (Robust)
      // 只要有超过 50% 的文件共享相同的前3个字符，就认为是系列模式
      const prefixCounts = new Map<string, number>()
      let validLenCount = 0
      for (const name of fileNames) {
        if (name.length >= 3) {
          const p = name.substring(0, 3)
          prefixCounts.set(p, (prefixCounts.get(p) || 0) + 1)
          validLenCount++
        }
      }

      // 如果文件数量足够，且大部分文件共享前缀
      if (validLenCount > 0) {
        const maxCount = Math.max(...Array.from(prefixCounts.values()))
        // 阈值：至少3个文件，或者超过50%的文件
        const threshold = Math.max(3, validLenCount * 0.5)

        if (maxCount >= threshold || (validLenCount < 6 && maxCount >= 2)) {
          patterns.add('series_pattern')
        }
      }

      // 保留原来的严格检查作为补充 (以防前缀很长但文件数少的情况)
      const baseName = this.findCommonBaseName(fileNames)
      if (baseName && baseName.length >= 3) {
        // 修改为 >= 3
        patterns.add('series_pattern')
      }
    } catch (error) {
      logger.error(LogCategory.DIRECTORY_CONTEXT, '分析文件名模式失败:', error)
    }

    return Array.from(patterns)
  }

  /**
   * 查找公共基础名称
   */
  private findCommonBaseName(fileNames: string[]): string {
    if (fileNames.length === 0) return ''

    let common = fileNames[0]
    for (let i = 1; i < fileNames.length; i++) {
      let j = 0
      while (j < common.length && j < fileNames[i].length && common[j] === fileNames[i][j]) {
        j++
      }
      common = common.substring(0, j)
      if (common.length === 0) break
    }

    return common.trim()
  }

  /**
   * 检测语言特征
   */
  private async detectLanguageFeatures(directoryPath: string): Promise<string[]> {
    const languages: Set<string> = new Set()

    try {
      const entries = await fs.readdir(directoryPath)

      for (const name of entries) {
        // 检测中文
        if (/[\u4e00-\u9fa5]/.test(name)) {
          languages.add('zh-CN')
        }

        // 检测日文
        if (/[\u3040-\u309f\u30a0-\u30ff]/.test(name)) {
          languages.add('ja-JP')
        }

        // 检测韩文
        if (/[\uac00-\ud7af]/.test(name)) {
          languages.add('ko-KR')
        }

        // 如果没有特殊字符，假定为英文
        if (/^[a-zA-Z0-9\s\-_]+\.[a-zA-Z0-9]+$/.test(name)) {
          languages.add('en-US')
        }
      }
    } catch (error) {
      logger.error(LogCategory.DIRECTORY_CONTEXT, '检测语言特征失败:', error)
    }

    return Array.from(languages)
  }

  /**
   * 检测特殊文件
   */
  private async detectSpecialFiles(directoryPath: string): Promise<string[]> {
    const specialFiles: string[] = []

    const enableUnitRecognition =
      ConfigOrchestrator.getInstance().getValue<boolean>('ENABLE_UNIT_RECOGNITION')
    const specialFileNames = [
      'package.json',
      '.gitignore',
      'README.md',
      'tsconfig.json',
      '.minunit',
      'index.html',
      'main.py'
    ].filter(name => {
      // 如果禁用了最小单元识别，则忽略 .minunit 文件
      if (name === '.minunit' && !enableUnitRecognition) {
        return false
      }
      return true
    })

    try {
      const entries = await fs.readdir(directoryPath)

      for (const name of specialFileNames) {
        if (entries.includes(name)) {
          specialFiles.push(name)
        }
      }
    } catch (error) {
      logger.error(LogCategory.DIRECTORY_CONTEXT, '检测特殊文件失败:', error)
    }

    return specialFiles
  }

  /**
   * 递归扫描目录并获取文件相对路径列表
   */
  private async scanDirectoryRecursively(
    dir: string,
    root: string,
    ignoreRules: IIgnoreRule[] = []
  ): Promise<string[]> {
    let results: string[] = []
    try {
      const list = await fs.readdir(dir)
      for (const file of list) {
        const filePath = path.join(dir, file)

        // 使用统一的忽略规则检查
        if (shouldIgnoreFile(filePath, file, ignoreRules)) {
          continue
        }

        const stat = await fs.stat(filePath)

        if (stat && stat.isDirectory()) {
          const subResults = await this.scanDirectoryRecursively(filePath, root, ignoreRules)
          results = results.concat(subResults)
        } else {
          // 直接使用原生路径，不归一化
          results.push(path.relative(root, filePath))
        }
      }
    } catch (error) {
      logger.warn(LogCategory.DIRECTORY_CONTEXT, `扫描目录失败: ${dir}`, error)
    }
    return results
  }

  /**
   * 使用AI进行综合分析
   */
  private async performAIAnalysis(
    data: {
      directoryPath: string
      fileTypeDistribution: Record<string, number>
      namingPatterns: string[]
      languageDetected: string[]
      specialFiles: string[]
    },
    language: LanguageCode,
    isSpeedy?: boolean
  ): Promise<{
    directoryType: string
    recommendedDimensions: string[]
    recommendedTags: Record<string, string[]>
    analysisStrategy: string
    namingPattern: string
    confidence: number
  }> {
    try {
      // 递归扫描文件结构
      // 加载统一配置中的忽略规则
      const ignoreRules = loadIgnoreRules()
      const fileStructure = await this.scanDirectoryRecursively(
        data.directoryPath,
        data.directoryPath,
        ignoreRules
      )

      // 动态计算文件数量限制 (每个文件名预估30字符)
      // 使用公共辅助类计算截断长度 (内部自动判断本地/云端及上下文长度)
      const maxContentLength =
        (await this.aiHelper.getMaxContentLength()) - AIHelper.DIRECTORY_ANALYSIS_PREVIEW_LIMIT
      const fileLimit = Math.floor(maxContentLength / 30)

      // 随机抽取文件作为预览样本，避免以篇概全
      const shuffled = [...fileStructure].sort(() => 0.5 - Math.random())
      const limitedFileStructure = shuffled.slice(0, fileLimit)
      if (fileStructure.length > fileLimit) {
        limitedFileStructure.push(`... (共 ${fileStructure.length} 个文件)`)
      }

      // 使用 DirectoryAnalyzer 进行分析
      return await this.directoryAnalyzer.analyzeDirectoryWithAI(
        {
          ...data,
          fileStructure: limitedFileStructure
        },
        language,
        isSpeedy
      )
    } catch (error) {
      logger.error(LogCategory.DIRECTORY_CONTEXT, 'AI分析失败:', error)
      // 返回默认值或抛出错误
      return {
        directoryType: 'unknown',
        recommendedDimensions: [],
        recommendedTags: {},
        analysisStrategy: 'standard',
        namingPattern: '[领域]内容描述',
        confidence: 0
      }
    }
  }

  /**
   * 保存上下文分析到数据库
   */
  private async saveContextAnalysis(
    directoryPath: string,
    analysis: DirectoryContextAnalysis
  ): Promise<void> {
    try {
      analysis.namingPattern = validateAndNormalizeNamingPattern(analysis.namingPattern)
      logger.info(LogCategory.DIRECTORY_CONTEXT, `保存目录上下文分析: ${directoryPath}`)

      try {
        await databaseService.addDirectory(directoryPath)
      } catch (addError) {
        logger.warn(
          LogCategory.DIRECTORY_CONTEXT,
          `确保目录记录存在时失败: ${directoryPath}`,
          addError
        )
      }

      const stmt = this.db.prepare(`
        UPDATE workspace_directories
        SET context_analysis = ?, is_analyzed = 1, last_analyzed_at = ?
        WHERE path = ?
      `)

      const result = stmt.run(JSON.stringify(analysis), new Date().toISOString(), directoryPath)

      if (result.changes === 0) {
        logger.warn(
          LogCategory.DIRECTORY_CONTEXT,
          `保存目录上下文分析失败：未找到匹配的记录: ${directoryPath}`
        )
      } else {
        logger.info(
          LogCategory.DIRECTORY_CONTEXT,
          `成功保存目录上下文分析: ${directoryPath}, changes: ${result.changes}`
        )
      }
    } catch (error) {
      logger.error(LogCategory.DIRECTORY_CONTEXT, '保存上下文分析失败:', error)
      throw error
    }
  }

  /**
   * 更新目录上下文的特定字段（智能文件名格式 / AI分析策略 / 重命名模板 / 继承模式）
   */
  async updateDirectoryContextAnalysis(
    directoryPath: string,
    updates: {
      namingPattern?: string
      analysisStrategy?: string
      namingTemplate?: string
      inheritMode?: {
        analysisStrategy?: 'inherit' | 'current_only' | 'broadcast'
        namingPattern?: 'inherit' | 'current_only' | 'broadcast'
        namingTemplate?: 'inherit' | 'current_only' | 'broadcast'
      }
    }
  ): Promise<void> {
    try {
      let existing: DirectoryContextAnalysis | null = await this.getDirectoryContext(directoryPath)
      if (!existing) {
        existing = {
          directoryPath,
          fileTypeDistribution: {},
          recommendedTags: {},
          specialFiles: [],
          description: '',
          namingPattern: '',
          analysisStrategy: '',
          namingTemplate: '',
          confidence: 1.0,
          analyzedAt: new Date()
        }
      }

      if (updates.namingPattern !== undefined) {
        existing.namingPattern = validateAndNormalizeNamingPattern(updates.namingPattern)
      }

      if (updates.analysisStrategy !== undefined) {
        existing.analysisStrategy = updates.analysisStrategy
      }

      if (updates.namingTemplate !== undefined) {
        existing.namingTemplate = updates.namingTemplate
      }

      if (updates.inheritMode !== undefined) {
        existing.inheritMode = {
          ...(existing.inheritMode || {
            analysisStrategy: 'inherit',
            namingPattern: 'inherit',
            namingTemplate: 'inherit'
          }),
          ...updates.inheritMode
        }
      }

      await this.saveContextAnalysis(directoryPath, existing)
      logger.info(
        LogCategory.DIRECTORY_CONTEXT,
        `目录上下文分析字段已更新: ${directoryPath}`,
        updates
      )
    } catch (error) {
      logger.error(
        LogCategory.DIRECTORY_CONTEXT,
        `更新目录上下文分析字段失败: ${directoryPath}`,
        error
      )
      throw error
    }
  }

  /**
   * 解析目录的有效生效配置（考虑自底向上的继承链）
   */
  async getEffectiveDirectoryConfig(directoryPath: string): Promise<DirectoryContextAnalysis | null> {
    try {
      const current = await this.getDirectoryContext(directoryPath)
      if (!current) return null

      const inheritMode = current.inheritMode || {
        analysisStrategy: 'inherit',
        namingPattern: 'inherit',
        namingTemplate: 'inherit'
      }

      // 如果全部是 current_only 或 broadcast，直接返回自身配置
      const needsInherit =
        inheritMode.analysisStrategy === 'inherit' ||
        inheritMode.namingPattern === 'inherit' ||
        inheritMode.namingTemplate === 'inherit'

      if (!needsInherit) {
        return current
      }

      // 向上寻找祖先目录并查找 broadcast 配置
      const effective: DirectoryContextAnalysis = {
        ...current,
        inheritedFrom: {}
      }

      const ancestors = this.findAncestorDirectories(directoryPath)
      for (const ancestorPath of ancestors) {
        const ancestorContext = await this.getDirectoryContext(ancestorPath)
        if (!ancestorContext) continue

        const ancestorMode = ancestorContext.inheritMode || {
          analysisStrategy: 'inherit',
          namingPattern: 'inherit',
          namingTemplate: 'inherit'
        }

        // 检查分析策略
        if (
          inheritMode.analysisStrategy === 'inherit' &&
          !effective.inheritedFrom?.analysisStrategy &&
          ancestorMode.analysisStrategy === 'broadcast' &&
          ancestorContext.analysisStrategy
        ) {
          effective.analysisStrategy = ancestorContext.analysisStrategy
          if (!effective.inheritedFrom) effective.inheritedFrom = {}
          effective.inheritedFrom.analysisStrategy = ancestorPath
        }

        // 检查智能文件名规则
        if (
          inheritMode.namingPattern === 'inherit' &&
          !effective.inheritedFrom?.namingPattern &&
          ancestorMode.namingPattern === 'broadcast' &&
          ancestorContext.namingPattern
        ) {
          effective.namingPattern = ancestorContext.namingPattern
          if (!effective.inheritedFrom) effective.inheritedFrom = {}
          effective.inheritedFrom.namingPattern = ancestorPath
        }

        // 检查智能文件名重命名模板
        if (
          inheritMode.namingTemplate === 'inherit' &&
          !effective.inheritedFrom?.namingTemplate &&
          ancestorMode.namingTemplate === 'broadcast' &&
          ancestorContext.namingTemplate
        ) {
          effective.namingTemplate = ancestorContext.namingTemplate
          if (!effective.inheritedFrom) effective.inheritedFrom = {}
          effective.inheritedFrom.namingTemplate = ancestorPath
        }
      }

      return effective
    } catch (err) {
      logger.error(LogCategory.DIRECTORY_CONTEXT, `解析目录继承配置失败: ${directoryPath}`, err)
      return this.getDirectoryContext(directoryPath)
    }
  }

  /**
   * 查找所有父级工作区目录（自底向上排序）
   */
  private findAncestorDirectories(targetPath: string): string[] {
    try {
      const rows = this.db.prepare('SELECT path FROM workspace_directories WHERE path != ?').all(targetPath) as Array<{ path: string }>
      const { isSubPath } = require('@firefly/shared')

      return rows
        .map(r => r.path)
        .filter(parentPath => isSubPath(parentPath, targetPath))
        .sort((a, b) => b.length - a.length) // 最长路径最接近当前节点
    } catch {
      return []
    }
  }

  async getDirectoryContext(directoryPath: string): Promise<DirectoryContextAnalysis | null> {
    try {
      const stmt = this.db.prepare(`
        SELECT context_analysis
        FROM workspace_directories
        WHERE path = ?
      `)

      const row = stmt.get(directoryPath) as any

      if (row && row.context_analysis) {
        return JSON.parse(row.context_analysis) as DirectoryContextAnalysis
      }
    } catch (error) {
      logger.error(LogCategory.DIRECTORY_CONTEXT, '获取目录上下文分析失败:', error)
    }

    return null
  }

  /**
   * 清除目录上下文分析
   */
  async clearDirectoryContext(directoryPath: string): Promise<void> {
    try {
      this.db.transaction(() => {
        // 1. 重置目录状态
        this.db
          .prepare(
            `
          UPDATE workspace_directories
          SET context_analysis = NULL, is_analyzed = 0, last_analyzed_at = NULL
          WHERE path = ?
        `
          )
          .run(directoryPath)

        // 2. 同时清理分析队列中的该目录
        this.db
          .prepare(
            `
          DELETE FROM analysis_queue 
          WHERE item_id = (SELECT id FROM workspace_directories WHERE path = ?) AND item_type = 'directory'
        `
          )
          .run(directoryPath)
      })()

      logger.info(LogCategory.DIRECTORY_CONTEXT, `已清除目录上下文分析: ${directoryPath}`)
    } catch (error) {
      logger.error(LogCategory.DIRECTORY_CONTEXT, '清除目录上下文分析失败:', error)
    }
  }

  /**
   * 将目录（及其继承生效的）命名模板批量应用到该目录下所有已分析文件的 smart_name
   */
  async applyNamingTemplateToDirectoryFiles(
    directoryPath: string
  ): Promise<{ updatedCount: number; totalCount: number; success: boolean }> {
    try {
      const effectiveConfig = await this.getEffectiveDirectoryConfig(directoryPath)
      const template = effectiveConfig?.namingTemplate?.trim() || ''

      const { NamingDSLEngine } = require('./naming-dsl-engine')
      const { isSubPath } = require('@firefly/shared')
      const pathModule = require('path')

      // 查询所有已分析的文件
      const rows = this.db
        .prepare(`
          SELECT 
            f.id, f.file_fingerprint, f.path, f.name, f.smart_name, f.type, f.author, f.language, f.size,
            wf.created_at, wf.modified_at,
            fc.quality_score, fc.metadata
          FROM workspace_files wf
          JOIN files f ON wf.file_fingerprint = f.file_fingerprint
          LEFT JOIN file_contents fc ON wf.file_fingerprint = fc.file_fingerprint
          WHERE wf.is_analyzed = 1
        `)
        .all() as any[]

      // 筛选属于当前目录或其子目录的文件
      const targetRows = rows.filter(
        r => isSubPath(directoryPath, r.path) || r.path === directoryPath
      )
      if (targetRows.length === 0) {
        return { updatedCount: 0, totalCount: 0, success: true }
      }

      let updatedCount = 0
      const updateStmt = this.db.prepare(
        'UPDATE files SET smart_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      )
      const updateContentStmt = this.db.prepare(
        'UPDATE file_contents SET metadata = ? WHERE file_fingerprint = ?'
      )

      this.db.transaction(() => {
        for (let i = 0; i < targetRows.length; i++) {
          const row = targetRows[i]
          let metadataObj: Record<string, any> = {}
          try {
            if (row.metadata) {
              metadataObj =
                typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata
            }
          } catch {
            metadataObj = {}
          }

          // 获取原始核心智能名（rawSmartName 不需要带扩展名）
          const fileExt = pathModule.extname(row.path || row.name || '').replace(/^\./, '')
          let rawSmartName = metadataObj.raw_smart_name || row.smart_name || row.name || ''
          if (fileExt) {
            rawSmartName = rawSmartName.replace(new RegExp(`\\.${fileExt}$`, 'i'), '')
          }
          rawSmartName = rawSmartName.replace(/\.[a-zA-Z0-9]{1,10}$/i, '').trim()
          if (!rawSmartName) {
            rawSmartName = pathModule.basename(row.name || row.path || '', pathModule.extname(row.name || row.path || ''))
          }

          // 查询该文件的标签维度
          const tagsRows = this.db
            .prepare(`
              SELECT ft.name, ft.dimension_id
              FROM file_tag_relations ftr
              JOIN file_tags ft ON ft.id = ftr.tag_id
              WHERE ftr.file_fingerprint = ?
            `)
            .all(row.file_fingerprint) as Array<{ name: string; dimension_id: string }>

          const dimensionTags: Record<string, string> = {}
          tagsRows.forEach(tr => {
            if (tr.dimension_id && tr.name) {
              dimensionTags[tr.dimension_id] = tr.name
            }
          })

          const fileContext = {
            id: row.id,
            path: row.path,
            name: row.name,
            smartName: rawSmartName,
            rawSmartName,
            size: row.size,
            extension: pathModule.extname(row.path).replace(/^\./, ''),
            modifiedAt: row.modified_at,
            createdAt: row.created_at,
            qualityScore: row.quality_score,
            tags: tagsRows.map(tr => ({ dimensionName: tr.dimension_id, tagValue: tr.name })),
            dimensionTags,
            metadata: metadataObj,
            author: row.author,
            language: row.language
          }

          let newSmartName = rawSmartName
          if (template) {
            newSmartName = NamingDSLEngine.renderTemplate(template, fileContext, i + 1, true)
          }

          // 确保 metadata 中留存无扩展名的 raw_smart_name
          if (metadataObj.raw_smart_name !== rawSmartName) {
            metadataObj.raw_smart_name = rawSmartName
            updateContentStmt.run(JSON.stringify(metadataObj), row.file_fingerprint)
          }

          if (newSmartName && newSmartName !== row.smart_name) {
            updateStmt.run(newSmartName, row.id)
            updatedCount++
          }
        }
      })()

      logger.info(
        LogCategory.DIRECTORY_CONTEXT,
        `批量应用命名模板完成: 目录=${directoryPath}, 模板=${template}, 更新数=${updatedCount}/${targetRows.length}`
      )
      return { updatedCount, totalCount: targetRows.length, success: true }
    } catch (err) {
      logger.error(LogCategory.DIRECTORY_CONTEXT, `批量应用命名模板失败: ${directoryPath}`, err)
      throw err
    }
  }
}
