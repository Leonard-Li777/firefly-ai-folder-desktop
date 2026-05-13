import { t } from '@app/languages'
import { fileAnalysisService, FileAnalysisResult } from '@yonuc/core-engine'
import { FileScannerService, ScanResult } from '@yonuc/core-engine/services/file-scanner-service'
import { databaseService } from '../database/database-service'
import { FileInfo } from '@yonuc/types'
import { EventEmitter } from 'events'

// 定义本地类型来替代缺失的类型
interface FileChangeEvent {
  type: 'add' | 'change' | 'unlink'
  path: string
  fileInfo?: FileInfo
}

interface ScanStrategy {
  ignorePatterns?: string[]
  includeHidden?: boolean
  maxDepth?: number
}

// 扩展ScanResult类型以包含缺失的属性
interface ExtendedScanResult extends ScanResult {
  directory: string
  totalFiles: number
}

/**
 * 文件扫描与分析集成服务
 * 
 * 这个服务将文件扫描和文件分析功能集成在一起，
 * 提供统一的文件处理接口，包括扫描、分析、存储和监控
 */
export class FileScannerIntegrationService extends EventEmitter {
  private fileScanner: FileScannerService
  private isProcessing = false
  private processedFiles = new Set<string>()
  private scanResults = new Map<string, ExtendedScanResult>()
  private analysisResults = new Map<string, FileAnalysisResult>()

  constructor() {
    super()
    this.fileScanner = new FileScannerService()
    this.setupEventHandlers()
  }

  /**
   * 设置事件处理器
   */
  private setupEventHandlers(): void {
    // 监听扫描完成事件
    this.fileScanner.on('scan-complete', async (result: ScanResult) => {
      // 扩展result以包含缺失的属性
      const extendedResult: ExtendedScanResult = {
        ...result,
        directory: (result as any).directory || '',
        totalFiles: result.files.length
      }
      this.scanResults.set(extendedResult.directory, extendedResult)
      this.emit('scan-complete', extendedResult)

      // 扫描完成后自动开始分析
      await this.processScannedFiles(result.files)
    })

    // 监听扫描进度事件
    this.fileScanner.on('scan-progress', (progress) => {
      this.emit('scan-progress', progress)
    })

    // 监听扫描错误事件
    this.fileScanner.on('scan-error', (error) => {
      this.emit('scan-error', error)
    })

    // 监听文件变化事件
    this.fileScanner.on('file-change', async (event: FileChangeEvent) => {
      this.emit('file-change', event)

      if (event.fileInfo && (event.type === 'add' || event.type === 'change')) {
        // 新增或修改的文件，添加到分析队列
        await this.processFile(event.fileInfo)
      } else if (event.type === 'unlink') {
        // 删除的文件，从数据库中移除
        await this.removeFileFromDatabase(event.path)
      }
    })

    // 监听分析完成事件
    fileAnalysisService.on('file-analyzed', (result: FileAnalysisResult) => {
      this.analysisResults.set(result.fileId, result)
      this.emit('file-analyzed', result)

      // 分析完成后保存到数据库
      this.saveToDatabase(result)
    })

    // 监听分析错误事件
    fileAnalysisService.on('analysis-error', (result: FileAnalysisResult) => {
      this.emit('analysis-error', result)
    })

    // 监听分析队列更新事件
    fileAnalysisService.on('queue-updated', (queue) => {
      this.emit('analysis-queue-updated', queue)
    })

    // 监听分析完成事件
    fileAnalysisService.on('analysis-completed', () => {
      this.emit('analysis-completed')
    })
  }

  /**
   * 开始扫描指定目录
   */
  async scanDirectory(directoryPath: string, strategy?: Partial<ScanStrategy>): Promise<ExtendedScanResult> {
    if (this.isProcessing) {
      throw new Error(t('正在处理中，请等待当前任务完成'))
    }

    try {
      this.isProcessing = true

      this.emit('scan-start', { directory: directoryPath })

      // 开始扫描
      const result = await this.fileScanner.scanDirectory(directoryPath)

      // 扩展结果以包含缺失的属性
      const extendedResult: ExtendedScanResult = {
        ...result,
        directory: directoryPath,
        totalFiles: result.files.length
      }

      return extendedResult

    } catch (error) {
      this.emit('scan-error', { error, directory: directoryPath })
      throw error
    } finally {
      this.isProcessing = false
    }
  }

  /**
   * 开始监视目录变化
   */
  async watchDirectory(directoryPath: string): Promise<void> {
    try {
      await this.fileScanner.watchDirectory(directoryPath)
      this.emit('watch-start', { directory: directoryPath })
    } catch (error) {
      this.emit('watch-error', { error, directory: directoryPath })
      throw error
    }
  }

  /**
   * 停止监视目录变化
   */
  async unwatchDirectory(directoryPath?: string): Promise<void> {
    try {
      await this.fileScanner.unwatchDirectory(directoryPath)
      this.emit('watch-stop')
    } catch (error) {
      this.emit('watch-error', error)
      throw error
    }
  }

  /**
   * 处理扫描到的文件
   */
  private async processScannedFiles(files: FileInfo[]): Promise<void> {
    this.emit('analysis-start', { fileCount: files.length })

    // 批量添加到分析队列
    await fileAnalysisService.batchAddToAnalysisQueue(files)
  }

  /**
   * 处理单个文件
   */
  private async processFile(fileInfo: FileInfo): Promise<void> {
    // 检查是否已经处理过
    if (this.processedFiles.has(fileInfo.path)) {
      return
    }

    this.processedFiles.add(fileInfo.path)

    // 添加到分析队列
    await fileAnalysisService.addToAnalysisQueue(fileInfo)
  }

  /**
   * 保存分析结果到数据库
   */
  private async saveToDatabase(result: FileAnalysisResult): Promise<void> {
    try {
      const fileInfo: FileInfo = {
        id: result.fileId,
        name: result.filename,
        path: result.path,
        size: result.size,
        type: result.type,
        extension: result.extension,
        createdAt: new Date(),
        modifiedAt: new Date()
      }

      await databaseService.addFile(fileInfo)
    } catch (error) {
      this.emit('database-error', { error, fileInfo: result })
    }
  }

  /**
   * 从数据库中移除文件
   */
  private async removeFileFromDatabase(filePath: string): Promise<void> {
    try {
      // 这里需要在database-service中添加删除文件的方法
      // 目前先记录事件
      this.emit('file-removed', { path: filePath })
    } catch (error) {
      this.emit('database-error', { error, path: filePath })
    }
  }

  /**
   * 获取扫描结果
   */
  getScanResult(directoryPath: string): ScanResult | undefined {
    return this.scanResults.get(directoryPath)
  }

  /**
   * 获取所有扫描结果
   */
  getAllScanResults(): ScanResult[] {
    return Array.from(this.scanResults.values())
  }

  /**
   * 获取分析结果
   */
  getAnalysisResult(fileId: string): FileAnalysisResult | undefined {
    return this.analysisResults.get(fileId)
  }

  /**
   * 获取所有分析结果
   */
  getAllAnalysisResults(): FileAnalysisResult[] {
    return Array.from(this.analysisResults.values())
  }

  /**
   * 获取扫描状态
   */
  getScanStatus(): string {
    return this.isProcessing ? 'scanning' : 'idle'
  }

  /**
   * 获取分析队列状态
   */
  getAnalysisStatus(): { completed: number; analyzing: number; pending: number } {
    return fileAnalysisService.getAnalysisQueueStatus() || { completed: 0, analyzing: 0, pending: 0 }
  }

  /**
   * 检查是否正在监视
   */
  isWatching(): boolean {
    return this.fileScanner.getWatchedDirectoriesCount() > 0
  }

  /**
   * 获取统计信息
   */
  getStatistics(): {
    scannedDirectories: number
    scannedFiles: number
    analyzedFiles: number
    cacheSize: number
    isWatching: boolean
    isScanning: boolean
    isAnalyzing: boolean
    totalFileSize: number
    averageAnalysisTime: number
  } {
    const analysisStatus = this.getAnalysisStatus()
    const scanResults = this.getAllScanResults()
    const analysisResults = this.getAllAnalysisResults()

    const totalFileSize = scanResults.reduce((sum, result) => sum + result.totalSize, 0)
    const averageAnalysisTime = analysisResults.length > 0
      ? analysisResults.reduce((sum, result) => sum + (result as any).analysisTime || 0, 0) / analysisResults.length
      : 0

    return {
      scannedDirectories: scanResults.length,
      scannedFiles: scanResults.reduce((sum, result) => sum + (result as ExtendedScanResult).totalFiles, 0),
      analyzedFiles: analysisStatus.completed || 0,
      cacheSize: 0, // FileScannerService没有getCacheSize方法
      isWatching: this.fileScanner.getWatchedDirectoriesCount() > 0,
      isScanning: this.isProcessing,
      isAnalyzing: this.isProcessing || (analysisStatus.analyzing || 0) > 0,
      totalFileSize,
      averageAnalysisTime
    }
  }

  /**
   * 搜索文件
   */
  searchFiles(query: string): FileAnalysisResult[] {
    const results = this.getAllAnalysisResults()

    return results.filter(result => {
      // 在文件名中搜索
      if (result.filename.toLowerCase().includes(query.toLowerCase())) {
        return true
      }

      // 在内容中搜索
      if (result.content && result.content.toLowerCase().includes(query.toLowerCase())) {
        return true
      }

      // 在标签中搜索
      if (result.tags.some(tag => tag.toLowerCase().includes(query.toLowerCase()))) {
        return true
      }

      return false
    })
  }

  /**
   * 按标签筛选文件
   */
  filterByTags(tags: string[]): FileAnalysisResult[] {
    const results = this.getAllAnalysisResults()

    return results.filter(result => {
      return tags.every(tag => result.tags.includes(tag))
    })
  }

  /**
   * 按文件类型筛选
   */
  filterByType(type: string): FileAnalysisResult[] {
    const results = this.getAllAnalysisResults()

    return results.filter(result => {
      return result.type === type || result.extension === type
    })
  }

  /**
   * 获取文件统计信息
   */
  getFileStatistics(): {
    byType: Record<string, number>
    byExtension: Record<string, number>
    byTags: Record<string, number>
    totalSize: number
    averageSize: number
  } {
    const results = this.getAllAnalysisResults()

    const byType: Record<string, number> = {}
    const byExtension: Record<string, number> = {}
    const byTags: Record<string, number> = {}

    let totalSize = 0

    for (const result of results) {
      // 按类型统计
      byType[result.type] = (byType[result.type] || 0) + 1

      // 按扩展名统计
      byExtension[result.extension] = (byExtension[result.extension] || 0) + 1

      // 按标签统计
      for (const tag of result.tags) {
        byTags[tag] = (byTags[tag] || 0) + 1
      }

      totalSize += result.size
    }

    return {
      byType,
      byExtension,
      byTags,
      totalSize,
      averageSize: results.length > 0 ? totalSize / results.length : 0
    }
  }

  /**
   * 清理资源
   */
  async cleanup(): Promise<void> {
    await this.fileScanner.unwatchDirectory()
    this.processedFiles.clear()
    this.scanResults.clear()
    this.analysisResults.clear()
    this.removeAllListeners()
  }

  /**
   * 导出数据
   */
  exportData(): {
    scanResults: ScanResult[]
    analysisResults: FileAnalysisResult[]
    statistics: any
  } {
    return {
      scanResults: this.getAllScanResults(),
      analysisResults: this.getAllAnalysisResults(),
      statistics: this.getStatistics()
    }
  }

  /**
   * 导入数据
   */
  importData(data: {
    scanResults?: ScanResult[]
    analysisResults?: FileAnalysisResult[]
  }): void {
    if (data.scanResults) {
      for (const result of data.scanResults) {
        const extendedResult: ExtendedScanResult = {
          ...(result as ExtendedScanResult),
          directory: (result as any).directory || '',
          totalFiles: (result as any).totalFiles || result.files.length
        }
        this.scanResults.set(extendedResult.directory, extendedResult)
      }
    }

    if (data.analysisResults) {
      for (const result of data.analysisResults) {
        this.analysisResults.set(result.fileId, result)
      }
    }
  }
}

// 导出单例实例
export const fileScannerIntegrationService = new FileScannerIntegrationService()
