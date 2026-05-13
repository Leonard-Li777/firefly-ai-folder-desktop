/**
 * 目录上下文分析服务
 * 智能分析工作目录的整体用途和内容特征
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import Database from 'better-sqlite3'
import { DirectoryContextAnalysis } from '@yonuc/types/dimension-types'
import { LanguageCode } from '@yonuc/types/i18n-types'
import { logger, LogCategory } from '@yonuc/shared'
import { ConfigOrchestrator } from '../../config/config-orchestrator'
import { loadIgnoreRules, shouldIgnoreFile } from '../analysis/analysis-ignore-service'
import { IIgnoreRule } from '@yonuc/types/settings-types'
import { DirectoryAnalyzer, IModelCapabilityAdapter } from '@yonuc/core-engine'
import { FileCategory, getFileCategory } from '@yonuc/shared'
import { LlamaIndexAIAdapter, } from '../../adapters/llama-index-ai-adapter'
import { LlamaRuntimeBridgeAdapter } from '../../adapters/llama-runtime-bridge-adapter'
import { ILlamaIndexAIService } from '@yonuc/types'
import { databaseService } from '../database/database-service'
import { AIHelper } from '@yonuc/core-engine'

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
    const runtimeAdapter = new LlamaRuntimeBridgeAdapter(aiAdapter)
    this.aiService = aiService
    this.capabilityAdapter = aiAdapter.capabilityAdapter
    this.aiHelper = new AIHelper(this.capabilityAdapter)
    
    // 创建正确的AI适配器
    // 传递 aiAdapter 作为 aiService 给 DirectoryAnalyzer
    this.directoryAnalyzer = new DirectoryAnalyzer(
      runtimeAdapter,
      aiAdapter.capabilityAdapter,
      (key: string) => ConfigOrchestrator.getInstance().getValue(key as any),
      this.aiHelper
    )
  }

  private get db(): Database.Database {
    if (!databaseService.db) {
      throw new Error('数据库连接未初始化')
    }
    return databaseService.db
  }

  /**
   * 分析目录上下文
   */
  async analyzeDirectoryContext(
    directoryPath: string,
    language: LanguageCode,
    force: boolean = false
  ): Promise<DirectoryContextAnalysis> {
    try {
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

      // 5. 使用AI进行综合分析
      const aiAnalysis = await this.performAIAnalysis(
        {
          directoryPath: directoryPath,
          fileTypeDistribution: stats.fileTypeDistribution,
          namingPatterns,
          languageDetected,
          specialFiles,
        },
        language
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
        analyzedAt: new Date(),
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

  /**
   * 收集目录统计信息
   */
  private async collectDirectoryStats(
    directoryPath: string
  ): Promise<{ fileTypeDistribution: Record<string, number> }> {
    const fileTypeDistribution: Record<string, number> = {}

    try {
      const entries = await fs.readdir(directoryPath, { withFileTypes: true })

      for (const entry of entries) {
        if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase()
          const type = this.getFileTypeCategory(ext)
          fileTypeDistribution[type] = (fileTypeDistribution[type] || 0) + 1
        }
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
    const category = getFileCategory(ext);
    if (category === 'unknown') return 'other';
    if (category === FileCategory.SOURCE) return 'code';
    return category;
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
      if (baseName && baseName.length >= 3) { // 修改为 >= 3
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
    for (let i = 1;i < fileNames.length;i++) {
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

    const specialFileNames = [
      'package.json',
      '.gitignore',
      'README.md',
      'tsconfig.json',
      '.minunit',
      'index.html',
      'main.py',
    ]

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
    language: LanguageCode
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
      const fileStructure = await this.scanDirectoryRecursively(data.directoryPath, data.directoryPath, ignoreRules)

      // 动态计算文件数量限制 (每个文件名预估30字符)
      // 使用公共辅助类计算截断长度 (内部自动判断本地/云端及上下文长度)
      const maxContentLength = await this.aiHelper.getMaxContentLength() - AIHelper.DIRECTORY_ANALYSIS_PREVIEW_LIMIT
      const fileLimit = Math.floor(maxContentLength / 30)
      
      const limitedFileStructure = fileStructure.slice(0, fileLimit)
      if (fileStructure.length > fileLimit) {
        limitedFileStructure.push(`... (共 ${fileStructure.length} 个文件)`)
      }

      // 使用 DirectoryAnalyzer 进行分析
      return await this.directoryAnalyzer.analyzeDirectoryWithAI({
        ...data,
        fileStructure: limitedFileStructure
      }, language)
    } catch (error) {
      logger.error(LogCategory.DIRECTORY_CONTEXT, 'AI分析失败:', error)
      // 返回默认值或抛出错误
      return {
        directoryType: 'unknown',
        recommendedDimensions: [],
        recommendedTags: {},
        analysisStrategy: 'standard',
        namingPattern: '序号_内容描述',
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
      logger.info(LogCategory.DIRECTORY_CONTEXT, `保存目录上下文分析: ${directoryPath}`)

      try {
        await databaseService.addDirectory(directoryPath)
      } catch (addError) {
        logger.warn(LogCategory.DIRECTORY_CONTEXT, `确保目录记录存在时失败: ${directoryPath}`, addError)
      }

      const stmt = this.db.prepare(`
        UPDATE workspace_directories
        SET context_analysis = ?, is_analyzed = 1, last_analyzed_at = CURRENT_TIMESTAMP
        WHERE path = ?
      `)

      const result = stmt.run(JSON.stringify(analysis), directoryPath)

      if (result.changes === 0) {
        logger.warn(LogCategory.DIRECTORY_CONTEXT, `保存目录上下文分析失败：未找到匹配的记录: ${directoryPath}`)
      } else {
        logger.info(LogCategory.DIRECTORY_CONTEXT, `成功保存目录上下文分析: ${directoryPath}, changes: ${result.changes}`)
      }
    } catch (error) {
      logger.error(LogCategory.DIRECTORY_CONTEXT, '保存上下文分析失败:', error)
      throw error
    }
  }

  /**
   * 获取目录上下文分析
   */
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
        this.db.prepare(`
          UPDATE workspace_directories
          SET context_analysis = NULL, is_analyzed = 0, last_analyzed_at = NULL
          WHERE path = ?
        `).run(directoryPath)

        // 2. 同时清理分析队列中的该目录
        this.db.prepare(`
          DELETE FROM analysis_queue 
          WHERE item_id = (SELECT id FROM workspace_directories WHERE path = ?) AND item_type = 'directory'
        `).run(directoryPath)
      })()

      logger.info(LogCategory.DIRECTORY_CONTEXT, `已清除目录上下文分析: ${directoryPath}`)
    } catch (error) {
      logger.error(LogCategory.DIRECTORY_CONTEXT, '清除目录上下文分析失败:', error)
    }
  }
}
