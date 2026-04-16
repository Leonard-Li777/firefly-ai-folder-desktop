/**
 * 目录上下文分析服务
 * 智能分析工作目录的整体用途和内容特征
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import Database from 'better-sqlite3'
import { DirectoryContextAnalysis } from '@yonuc/types/dimension-types'
import { LanguageCode } from '@yonuc/types/i18n-types'
import { logger, LogCategory, getIsDebugMode, getBaseQuota } from '@yonuc/shared'
import { configService } from '../config/config-service'
import { loadIgnoreRules, shouldIgnoreFile } from '../analysis/analysis-ignore-service'
import { IIgnoreRule } from '@yonuc/types/settings-types'
import { DirectoryAnalyzer, IModelCapabilityAdapter } from '@yonuc/core-engine'
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
      (key: string) => configService.getValue(key as any),
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
          directoryPath,
          fileTypeDistribution: stats.fileTypeDistribution,
          namingPatterns,
          languageDetected,
          specialFiles,
        },
        language
      )

      const contextAnalysis: DirectoryContextAnalysis = {
        directoryPath,
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
    const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg']
    const videoExts = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.flv']
    const audioExts = ['.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg']
    const documentExts = ['.pdf', '.doc', '.docx', '.txt', '.md', '.rtf']
    const archiveExts = ['.zip', '.rar', '.7z', '.tar', '.gz']
    const codeExts = ['.js', '.ts', '.py', '.java', '.cpp', '.c', '.go']

    if (imageExts.includes(ext)) return 'image'
    if (videoExts.includes(ext)) return 'video'
    if (audioExts.includes(ext)) return 'audio'
    if (documentExts.includes(ext)) return 'document'
    if (archiveExts.includes(ext)) return 'archive'
    if (codeExts.includes(ext)) return 'code'

    return 'other'
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
          results.push(path.relative(root, filePath))
        }
      }
    } catch (error) {
      logger.warn(LogCategory.DIRECTORY_CONTEXT, `扫描目录失败: ${dir}`, error)
    }
    return results
  }

  /**
   * 使用AI进行综合分析（委托给 DirectoryAnalyzer）
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
   * 清理和提取JSON字符串（增强版）
   * 移除特殊字符，提取JSON块，修复常见格式问题
   */
  private sanitizeAndExtractJSON(response: string): string {
    let cleaned = response.trim()

    // 1. 提取代码块中的JSON
    const codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
    if (codeBlockMatch) {
      cleaned = codeBlockMatch[1].trim()
    }

    // 2. 提取花括号内的JSON对象
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      cleaned = jsonMatch[0]
    }

    // 3. 移除可能导致解析失败的特殊字符
    // 移除零宽字符和不可见字符
    cleaned = cleaned.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '')

    // 4. 修复常见的JSON格式问题
    // 移除尾部逗号
    cleaned = cleaned.replace(/,(\s*[}\]])/g, '$1')

    // 5. 移除字符串中的控制字符（但保留换行符和制表符）
    // 逐个替换控制字符，避免 ESLint 错误
    for (let i = 0;i <= 8;i++) {
      cleaned = cleaned.replace(new RegExp(String.fromCharCode(i), 'g'), '');
    }
    // 移除其他特定的控制字符
    cleaned = cleaned.replace(new RegExp(String.fromCharCode(11), 'g'), ''); // 垂直制表符
    cleaned = cleaned.replace(new RegExp(String.fromCharCode(12), 'g'), ''); // 换页符
    for (let i = 14;i <= 31;i++) {
      cleaned = cleaned.replace(new RegExp(String.fromCharCode(i), 'g'), '');
    }

    // 6. 修复省略号和其他可能的问题字符
    // 将中文省略号替换为三个点
    cleaned = cleaned.replace(/…/g, '...')

    // 7. 修复转义字符问题 - 使用更智能的方式
    cleaned = this.fixEscapeCharactersInJSON(cleaned)

    return cleaned
  }

  /**
   * 修复JSON字符串中的转义字符问题
   * 遍历JSON字符串，只修复字符串值内的转义字符
   */
  private fixEscapeCharactersInJSON(jsonStr: string): string {
    let result = ''
    let inString = false
    let i = 0
    let fixCount = 0

    while (i < jsonStr.length) {
      const char = jsonStr[i]
      const nextChar = i + 1 < jsonStr.length ? jsonStr[i + 1] : ''

      // 处理引号 - 判断是否进入/退出字符串
      if (char === '"') {
        // 检查引号前是否有未转义的反斜杠
        let backslashCount = 0
        let j = i - 1
        while (j >= 0 && jsonStr[j] === '\\') {
          backslashCount++
          j--
        }

        // 如果反斜杠数量是偶数（包括0），说明引号没有被转义
        if (backslashCount % 2 === 0) {
          inString = !inString
        }
        result += char
        i++
        continue
      }

      // 在字符串内部，处理反斜杠
      if (inString && char === '\\') {
        // 检查这个反斜杠前面有多少个连续的反斜杠
        let precedingBackslashes = 0
        let j = i - 1
        while (j >= 0 && jsonStr[j] === '\\') {
          precedingBackslashes++
          j--
        }

        // 检查下一个字符是否是有效的转义字符
        const validEscapeChars = ['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']

        if (validEscapeChars.includes(nextChar)) {
          // 有效的转义序列，保持原样
          result += char
          i++
        } else if (nextChar === '') {
          // 字符串末尾的单独反斜杠，需要转义
          fixCount++
          result += '\\\\'
          i++
        } else {
          // 无效的转义序列
          // 如果前面有奇数个反斜杠，说明当前这个反斜杠本身被转义了，保持原样
          if (precedingBackslashes % 2 === 1) {
            result += char
            i++
          } else {
            // 否则需要转义这个反斜杠
            fixCount++
            result += '\\\\'
            i++
          }
        }
      } else {
        // 不在字符串内，或者不是反斜杠，直接添加
        result += char
        i++
      }
    }

    if (fixCount > 0) {
      logger.info(LogCategory.DIRECTORY_CONTEXT, `[DirectoryContext] 修复了 ${fixCount} 个无效的转义序列`)
    }

    return result
  }

  /**
   * 尝试修复截断的JSON（增强版）
   */
  private tryRepairTruncatedJSON(jsonStr: string): string | null {
    try {
      logger.info(LogCategory.DIRECTORY_CONTEXT, `[DirectoryContext] 尝试修复截断的JSON，原始长度: ${jsonStr.length}`)

      // 1. 基本清理：移除首尾空白
      let truncatedJson = jsonStr.trim()

      // 2. 提取可能的JSON对象（从第一个{到最后一个}）
      const firstBrace = truncatedJson.indexOf('{')
      const lastBrace = truncatedJson.lastIndexOf('}')

      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        truncatedJson = truncatedJson.substring(firstBrace, lastBrace + 1)
      }

      // 3. 清理和提取JSON（增强版）
      truncatedJson = this.sanitizeAndExtractJSON(truncatedJson)

      // 4. 计算大括号和方括号的平衡
      let openBraces = 0
      let closeBraces = 0
      let openBrackets = 0  // [
      let closeBrackets = 0 // ]
      let inString = false
      let escapeNext = false

      for (let i = 0;i < truncatedJson.length;i++) {
        const char = truncatedJson[i]

        if (escapeNext) {
          escapeNext = false
          continue
        }

        if (char === '\\') {
          escapeNext = true
          continue
        }

        if (char === '"') {
          inString = !inString
          continue
        }

        if (!inString) {
          if (char === '{') {
            openBraces++
          } else if (char === '}') {
            closeBraces++
          } else if (char === '[') {
            openBrackets++
          } else if (char === ']') {
            closeBrackets++
          }
        }
      }

      // 5. 如果JSON已经平衡，直接返回
      if (openBraces === closeBraces && openBrackets === closeBrackets) {
        return truncatedJson
      }

      logger.info(LogCategory.DIRECTORY_CONTEXT, `[DirectoryContext] 检测到JSON不平衡: ${openBraces} 开括号, ${closeBraces} 闭括号, ${openBrackets} 开方括号, ${closeBrackets} 闭方括号`)

      // 6. 如果在字符串中截断，先关闭字符串
      if (inString) {
        truncatedJson += '"'
        logger.info(LogCategory.DIRECTORY_CONTEXT, '[DirectoryContext] 添加缺失的引号')
      }

      // 7. 尝试智能修复：移除最后一个不完整的属性
      // 查找最后一个逗号或冒号的位置
      let lastComma = -1
      let lastColon = -1
      let depth = 0
      inString = false
      escapeNext = false

      for (let i = 0;i < truncatedJson.length;i++) {
        const char = truncatedJson[i]

        if (escapeNext) {
          escapeNext = false
          continue
        }

        if (char === '\\') {
          escapeNext = true
          continue
        }

        if (char === '"') {
          inString = !inString
          continue
        }

        if (!inString) {
          if (char === '{' || char === '[') {
            depth++
          } else if (char === '}' || char === ']') {
            depth--
          } else if (char === ',' && depth === 1) {
            lastComma = i
          } else if (char === ':' && depth === 1) {
            lastColon = i
          }
        }
      }

      // 如果最后一个冒号在最后一个逗号之后，说明可能在属性值中截断
      if (lastColon > lastComma && lastComma > 0) {
        // 截断到最后一个逗号之前（移除不完整的属性）
        truncatedJson = truncatedJson.substring(0, lastComma)
        logger.info(LogCategory.DIRECTORY_CONTEXT, `[DirectoryContext] 移除不完整的属性，截断到位置 ${lastComma}`)
      }

      // 添加缺失的闭括号
      const bracesToAdd = openBraces - closeBraces
      if (bracesToAdd > 0) {
        const closingBraces = '}'.repeat(bracesToAdd)
        truncatedJson += closingBraces
        logger.info(LogCategory.DIRECTORY_CONTEXT, `[DirectoryContext] 添加 ${bracesToAdd} 个闭括号`)
      }

      // 添加缺失的闭方括号
      const bracketsToAdd = openBrackets - closeBrackets
      if (bracketsToAdd > 0) {
        const closingBrackets = ']'.repeat(bracketsToAdd)
        truncatedJson += closingBrackets
        logger.info(LogCategory.DIRECTORY_CONTEXT, `[DirectoryContext] 添加 ${bracketsToAdd} 个闭方括号`)
      }

      return truncatedJson
    } catch (error) {
      logger.error(LogCategory.DIRECTORY_CONTEXT, '[DirectoryContext] JSON修复失败:', error)
      return null
    }
  }

  /**
   * 解析AI分析响应
   */
  private parseAIAnalysisResponse(response: string): {
    directoryType: string
    recommendedDimensions: string[]
    recommendedTags: Record<string, string[]>
    analysisStrategy: string
    namingPattern: string
    confidence: number
  } {
    try {
      // 清理响应，提取JSON
      let jsonStr = response.trim()

      // 移除代码块标记
      if (jsonStr.startsWith('```json')) {
        jsonStr = jsonStr.substring(7)
      }
      if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.substring(3)
      }
      if (jsonStr.endsWith('```')) {
        jsonStr = jsonStr.substring(0, jsonStr.length - 3)
      }
      jsonStr = jsonStr.trim()

      // 移除开头的任何非JSON文本（如"好的，我将..."等对话文本）
      const firstBraceIndex = jsonStr.indexOf('{')
      if (firstBraceIndex > 0) {
        logger.info(LogCategory.DIRECTORY_CONTEXT, `[DirectoryContext] 检测到JSON前的对话文本，移除前 ${firstBraceIndex} 个字符`)
        jsonStr = jsonStr.substring(firstBraceIndex)
      }

      // 移除结尾的任何非JSON文本
      const lastBraceIndex = jsonStr.lastIndexOf('}')
      if (lastBraceIndex !== -1 && lastBraceIndex < jsonStr.length - 1) {
        logger.info(LogCategory.DIRECTORY_CONTEXT, `[DirectoryContext] 检测到JSON后的额外文本，移除后 ${jsonStr.length - lastBraceIndex - 1} 个字符`)
        jsonStr = jsonStr.substring(0, lastBraceIndex + 1)
      }

      // 记录原始响应长度用于调试
      logger.info(LogCategory.DIRECTORY_CONTEXT, `[DirectoryContext] 原始响应长度: ${response.length}, 清理后长度: ${jsonStr.length}`)

      let data: any = null

      // 首先尝试直接解析
      try {
        data = JSON.parse(jsonStr)
        logger.info(LogCategory.DIRECTORY_CONTEXT, '[DirectoryContext] JSON解析成功')
      } catch (parseError) {
        const errorMsg = parseError instanceof Error ? parseError.message : String(parseError)
        logger.warn(LogCategory.DIRECTORY_CONTEXT, '[DirectoryContext] JSON解析失败，尝试修复:', errorMsg)

        // 显示错误位置附近的内容以帮助调试
        const errorMatch = errorMsg.match(/position (\d+)/)
        if (errorMatch) {
          const errorPos = parseInt(errorMatch[1], 10)
          const start = Math.max(0, errorPos - 50)
          const end = Math.min(jsonStr.length, errorPos + 50)
          logger.info(LogCategory.DIRECTORY_CONTEXT, '[DirectoryContext] 错误位置附近的内容:', JSON.stringify(jsonStr.substring(start, end)))
        }

        // 尝试修复截断的JSON
        const repairedJson = this.tryRepairTruncatedJSON(jsonStr)
        if (repairedJson) {
          try {
            data = JSON.parse(repairedJson)
            logger.info(LogCategory.DIRECTORY_CONTEXT, '[DirectoryContext] 修复后的JSON解析成功')
          } catch (repairError) {
            const repairErrorMsg = repairError instanceof Error ? repairError.message : String(repairError)
            logger.error(LogCategory.DIRECTORY_CONTEXT, '[DirectoryContext] 修复后的JSON仍然无法解析:', repairErrorMsg)

            // 显示修复后错误位置附近的内容
            const repairErrorMatch = repairErrorMsg.match(/position (\d+)/)
            if (repairErrorMatch) {
              const repairErrorPos = parseInt(repairErrorMatch[1], 10)
              const start = Math.max(0, repairErrorPos - 50)
              const end = Math.min(repairedJson.length, repairErrorPos + 50)
              logger.info(LogCategory.DIRECTORY_CONTEXT, '[DirectoryContext] 修复后错误位置附近的内容:', JSON.stringify(repairedJson.substring(start, end)))
            }

            logger.error(LogCategory.DIRECTORY_CONTEXT, '[DirectoryContext] 原始响应内容:', response.substring(0, 500))
            return {
              directoryType: 'general',
              recommendedDimensions: [],
              recommendedTags: {},
              analysisStrategy: 'standard',
              namingPattern: '序号_内容描述',
              confidence: 0.5,
            }
          }
        } else {
          logger.error(LogCategory.DIRECTORY_CONTEXT, '[DirectoryContext] 无法修复JSON')
          logger.error(LogCategory.DIRECTORY_CONTEXT, '[DirectoryContext] 原始响应内容:', response.substring(0, 500))
          return {
              directoryType: 'general',
              recommendedDimensions: [],
              recommendedTags: {},
              analysisStrategy: 'standard',
              namingPattern: '序号_内容描述',
              confidence: 0.5,
            }
        }
      }

      if (!data) {
        return {
          directoryType: 'general',
          recommendedDimensions: [],
          recommendedTags: {},
          analysisStrategy: 'standard',
          namingPattern: '序号_内容描述',
          confidence: 0.5,
        }
      }

      return {
        directoryType: data.directoryType || 'general',
        recommendedDimensions: data.recommendedDimensions || [],
        recommendedTags: data.recommendedTags || {},
        analysisStrategy: data.analysisStrategy || 'standard',
        namingPattern: data.namingPattern || '序号_内容描述',
        confidence: data.confidence || 0.5,
      }
    } catch (error) {
      logger.error(LogCategory.DIRECTORY_CONTEXT, '解析AI分析响应失败:', error)
      if (error instanceof Error) {
        logger.error(LogCategory.DIRECTORY_CONTEXT, '错误详情:', error.message)
      }
      logger.error(LogCategory.DIRECTORY_CONTEXT, '原始响应内容:', response.substring(0, 500))
      return {
        directoryType: 'general',
        recommendedDimensions: [],
        recommendedTags: {},
        analysisStrategy: 'standard',
        namingPattern: '序号_内容描述',
        confidence: 0.5,
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

        // 2. 同时清理分析队列中的该目录，确保可以重新添加
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
