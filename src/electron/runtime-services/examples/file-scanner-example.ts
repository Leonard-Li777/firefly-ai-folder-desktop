import { FileScannerService, ScanStrategy, ScanResult, FileChangeEvent } from './file-scanner-service'
import { fileAnalysisService, FileAnalysisResult } from './file-analysis-service'
import { databaseService } from './database-service'
import { FileInfo } from '@/shared/types/types'
import { app } from 'electron'

/**
 * 文件扫描与分析集成示例
 * 
 * 这个示例展示了如何将文件扫描服务与文件分析服务集成，
 * 实现完整的文件处理流程：扫描 -> 分析 -> 存储
 */
export class FileScannerExample {
  private fileScanner: FileScannerService
  private isProcessing = false
  private processedFiles = new Set<string>()

  constructor() {
    this.fileScanner = new FileScannerService()
    this.setupEventHandlers()
  }

  /**
   * 设置事件处理器
   */
  private setupEventHandlers(): void {
    // 监听扫描完成事件
    this.fileScanner.on('scan-complete', async (result: ScanResult) => {
      console.log(`扫描完成: ${result.directory}`)
      console.log(`找到 ${result.totalFiles} 个文件，总大小 ${this.formatFileSize(result.totalSize)}`)
      
      if (result.errors.length > 0) {
        console.warn('扫描过程中出现错误:', result.errors)
      }
      
      // 扫描完成后自动开始分析
      await this.processScannedFiles(result.files)
    })

    // 监听文件变化事件
    this.fileScanner.on('file-change', async (event: FileChangeEvent) => {
      console.log(`文件变化: ${event.type} - ${event.path}`)
      
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
      console.log(`分析完成: ${result.filename}`)
      console.log(`标签: ${result.tags.join(', ')}`)
      
      // 分析完成后保存到数据库
      this.saveToDatabase(result)
    })

    // 监听分析错误事件
    fileAnalysisService.on('analysis-error', (result: FileAnalysisResult) => {
      console.error(`分析失败: ${result.filename}`, result.error)
    })
  }

  /**
   * 开始扫描指定目录
   */
  async startScan(directoryPath: string, strategy?: Partial<ScanStrategy>): Promise<void> {
    if (this.isProcessing) {
      console.warn('正在处理中，请等待当前任务完成')
      return
    }

    try {
      this.isProcessing = true
      
      // 更新扫描策略
      if (strategy) {
        this.fileScanner.updateStrategy(strategy)
      }

      console.log(`开始扫描目录: ${directoryPath}`)
      
      // 开始扫描
      const result = await this.fileScanner.scanDirectory(directoryPath, true)
      
      console.log(`扫描完成，耗时: ${result.duration}ms`)
      
    } catch (error) {
      console.error('扫描失败:', error)
    } finally {
      this.isProcessing = false
    }
  }

  /**
   * 开始监视目录变化
   */
  async startWatching(directoryPath: string): Promise<void> {
    try {
      console.log(`开始监视目录: ${directoryPath}`)
      await this.fileScanner.watchDirectory(directoryPath)
      console.log('目录监视已启动')
    } catch (error) {
      console.error('启动监视失败:', error)
    }
  }

  /**
   * 停止监视目录变化
   */
  async stopWatching(): Promise<void> {
    try {
      await this.fileScanner.unwatchDirectory()
      console.log('目录监视已停止')
    } catch (error) {
      console.error('停止监视失败:', error)
    }
  }

  /**
   * 处理扫描到的文件
   */
  private async processScannedFiles(files: FileInfo[]): Promise<void> {
    console.log(`开始处理 ${files.length} 个文件`)
    
    // 批量添加到分析队列
    await fileAnalysisService.batchAddToAnalysisQueue(files)
    
    console.log('所有文件已添加到分析队列')
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
        createdAt: new Date(), // 使用当前时间，因为扫描时没有获取创建时间
        modifiedAt: new Date() // 使用当前时间
      }

      await databaseService.addFile(fileInfo)
      console.log(`文件信息已保存到数据库: ${result.filename}`)
    } catch (error) {
      console.error('保存到数据库失败:', error)
    }
  }

  /**
   * 从数据库中移除文件
   */
  private async removeFileFromDatabase(filePath: string): Promise<void> {
    try {
      // 这里需要在database-service中添加删除文件的方法
      console.log(`文件已从数据库中移除: ${filePath}`)
    } catch (error) {
      console.error('从数据库移除文件失败:', error)
    }
  }

  /**
   * 获取扫描状态
   */
  getScanStatus(): string {
    return this.fileScanner.getScanStatus()
  }

  /**
   * 获取分析队列状态
   */
  getAnalysisStatus() {
    return fileAnalysisService.getAnalysisQueueStatus()
  }

  /**
   * 格式化文件大小
   */
  private formatFileSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    let size = bytes
    let unitIndex = 0
    
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024
      unitIndex++
    }
    
    return `${size.toFixed(2)} ${units[unitIndex]}`
  }

  /**
   * 获取统计信息
   */
  getStatistics(): {
    scannedFiles: number
    analyzedFiles: number
    cacheSize: number
    isWatching: boolean
    isScanning: boolean
  } {
    const analysisStatus = this.getAnalysisStatus()
    
    return {
      scannedFiles: this.fileScanner.getCacheSize(),
      analyzedFiles: analysisStatus.completed,
      cacheSize: this.fileScanner.getCacheSize(),
      isWatching: this.fileScanner.isWatching(),
      isScanning: this.fileScanner.isCurrentlyScanning()
    }
  }

  /**
   * 清理资源
   */
  async cleanup(): Promise<void> {
    await this.fileScanner.destroy()
    this.processedFiles.clear()
    console.log('资源已清理')
  }
}

/**
 * 使用示例
 */
export async function runFileScannerExample(): Promise<void> {
  const example = new FileScannerExample()
  
  try {
    // 自定义扫描策略
    const customStrategy: Partial<ScanStrategy> = {
      excludeDirs: [
        'node_modules',
        '.git',
        '.vscode',
        'dist',
        'build'
      ],
      excludePatterns: [
        '*.tmp',
        '*.log',
        '*.bak',
        '.DS_Store'
      ],
      includeExtensions: ['txt', 'md', 'json', 'js', 'ts', 'jsx', 'tsx', 'pdf', 'jpg', 'png', 'mp3', 'mp4'],
      maxDepth: 10,
      includeHidden: false,
      followSymlinks: false,
      maxFilesPerScan: 50000,
      scanTimeout: 600000 // 10分钟
    }

    // 获取用户文档目录
    const documentsPath = app.getPath('documents')
    
    // 开始扫描
    await example.startScan(documentsPath, customStrategy)
    
    // 开始监视目录变化
    await example.startWatching(documentsPath)
    
    // 定期输出统计信息
    const statsInterval = setInterval(() => {
      const stats = example.getStatistics()
      console.log('统计信息:', stats)
    }, 5000)
    
    // 模拟运行一段时间
    await new Promise(resolve => setTimeout(resolve, 30000))
    
    // 停止监视
    await example.stopWatching()
    
    // 清理定时器
    clearInterval(statsInterval)
    
  } catch (error) {
    console.error('示例运行失败:', error)
  } finally {
    // 清理资源
    await example.cleanup()
  }
}

// 如果直接运行此文件，则执行示例
if (require.main === module) {
  runFileScannerExample().catch(console.error)
}