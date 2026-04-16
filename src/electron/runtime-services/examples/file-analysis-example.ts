/**
 * 文件分析服务使用示例
 * 
 * 此文件展示了如何将文件分析服务集成到现有系统中
 * 以及如何使用各种文件处理器进行内容提取
 */

import { fileAnalysisService, FileAnalysisResult } from './file-analysis-service'
import { aiService } from './ai-service'
import { EventEmitter } from 'events'

/**
 * 文件分析集成服务示例
 * 展示如何将文件分析服务与AI服务结合使用
 */
export class FileAnalysisIntegrationService extends EventEmitter {
  private isInitialized = false

  /**
   * 初始化文件分析集成服务
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return
    }

    try {
      // 初始化AI服务
      await aiService.initialize()
      
      // 设置文件分析服务事件监听
      this.setupEventListeners()
      
      this.isInitialized = true
      console.log('文件分析集成服务初始化完成')
    } catch (error) {
      console.error('文件分析集成服务初始化失败:', error)
      throw error
    }
  }

  /**
   * 设置事件监听器
   */
  private setupEventListeners(): void {
    // 监听文件分析完成事件
    fileAnalysisService.on('file-analyzed', async (result: FileAnalysisResult) => {
      console.log(`文件分析完成: ${result.filename}`)
      
      // 将分析结果传递给AI服务进行分类
      if (result.status === 'completed') {
        await this.classifyAnalyzedFile(result)
      }
    })

    // 监听分析错误事件
    fileAnalysisService.on('analysis-error', (result: FileAnalysisResult) => {
      console.error(`文件分析失败: ${result.filename}`, result.error)
    })

    // 监听分析完成事件
    fileAnalysisService.on('analysis-completed', () => {
      console.log('所有文件分析完成')
      this.emit('batch-analysis-completed')
    })
  }

  /**
   * 对分析完成的文件进行AI分类
   */
  private async classifyAnalyzedFile(result: FileAnalysisResult): Promise<void> {
    try {
      // 准备AI分类所需的数据
      const contentPreview = result.content ? result.content.substring(0, 500) : ''
      const metadata = this.prepareMetadataForAI(result.metadata)
      
      // 调用AI服务进行分类
      const classificationResult = await aiService.classifyFile(
        result.filename,
        contentPreview,
        metadata
      )
      
      // 将分类结果与文件分析结果合并
      const enhancedResult = {
        ...result,
        classification: classificationResult
      }
      
      // 发送增强的分析结果
      this.emit('file-classified', enhancedResult)
      
      console.log(`文件分类完成: ${result.filename}`, classificationResult)
    } catch (error) {
      console.error(`文件分类失败: ${result.filename}`, error)
    }
  }

  /**
   * 为AI分类准备元数据
   */
  private prepareMetadataForAI(metadata: Record<string, any>): any {
    const aiMetadata: any = {
      fileSize: metadata.fileSize,
      createdAt: metadata.createdAt,
      modifiedAt: metadata.modifiedAt
    }

    // 添加图片元数据
    if (metadata.exif) {
      aiMetadata.image = {
        camera: metadata.exif.camera,
        hasGPS: !!metadata.exif.gps,
        hasExif: true
      }
    }

    // 添加音频元数据
    if (metadata.audio) {
      aiMetadata.audio = {
        duration: metadata.audio.duration,
        hasArtist: !!metadata.common?.artist,
        hasAlbum: !!metadata.common?.album
      }
    }

    // 添加视频元数据
    if (metadata.video) {
      aiMetadata.video = {
        resolution: `${metadata.video.width}x${metadata.video.height}`,
        duration: metadata.format?.duration,
        isHD: metadata.video.width >= 1280
      }
    }

    // 添加PDF元数据
    if (metadata.pdf) {
      aiMetadata.document = {
        pageCount: metadata.pdf.pageCount,
        type: 'pdf'
      }
    }

    return aiMetadata
  }

  /**
   * 批量分析文件
   */
  async batchAnalyzeFiles(fileInfos: any[]): Promise<void> {
    console.log(`开始批量分析 ${fileInfos.length} 个文件`)
    
    // 添加文件到分析队列
    await fileAnalysisService.batchAddToAnalysisQueue(fileInfos)
    
    // 返回分析队列状态
    return new Promise((resolve) => {
      const onCompleted = () => {
        this.off('batch-analysis-completed', onCompleted)
        resolve()
      }
      
      this.on('batch-analysis-completed', onCompleted)
    })
  }

  /**
   * 获取分析进度
   */
  getAnalysisProgress() {
    return fileAnalysisService.getAnalysisQueueStatus()
  }

  /**
   * 获取支持的文件格式
   */
  getSupportedFormats(): string[] {
    return fileAnalysisService.getSupportedFormats()
  }

  /**
   * 停止分析
   */
  stopAnalysis(): void {
    fileAnalysisService.stopAnalysis()
  }

  /**
   * 清空分析队列
   */
  clearAnalysisQueue(): void {
    fileAnalysisService.clearAnalysisQueue()
  }

  /**
   * 重试失败的分析
   */
  retryFailedAnalysis(): void {
    fileAnalysisService.retryFailedAnalysis()
  }
}

/**
 * 使用示例函数
 */
export async function demonstrateFileAnalysis(): Promise<void> {
  console.log('=== 文件分析服务使用示例 ===')
  
  // 创建集成服务实例
  const integrationService = new FileAnalysisIntegrationService()
  
  try {
    // 初始化服务
    await integrationService.initialize()
    
    // 示例文件信息
    const sampleFiles = [
      {
        id: '1',
        name: 'document.pdf',
        path: '/path/to/document.pdf',
        size: 1024000,
        type: 'document',
        extension: 'pdf'
      },
      {
        id: '2',
        name: 'photo.jpg',
        path: '/path/to/photo.jpg',
        size: 2048000,
        type: 'image',
        extension: 'jpg'
      },
      {
        id: '3',
        name: 'song.mp3',
        path: '/path/to/song.mp3',
        size: 5120000,
        type: 'audio',
        extension: 'mp3'
      },
      {
        id: '4',
        name: 'video.mp4',
        path: '/path/to/video.mp4',
        size: 10240000,
        type: 'video',
        extension: 'mp4'
      }
    ]
    
    // 设置事件监听器
    integrationService.on('file-classified', (result) => {
      console.log('文件分类结果:', {
        filename: result.filename,
        category: result.classification?.category,
        confidence: result.classification?.confidence,
        tags: result.classification?.tags,
        summary: result.classification?.summary
      })
    })
    
    // 执行批量分析
    await integrationService.batchAnalyzeFiles(sampleFiles)
    
    // 监听分析进度
    const checkProgress = setInterval(() => {
      const progress = integrationService.getAnalysisProgress()
      console.log('分析进度:', progress)
      
      if (progress.analyzing === 0 && progress.pending === 0) {
        clearInterval(checkProgress)
        console.log('所有文件分析完成')
      }
    }, 1000)
    
  } catch (error) {
    console.error('示例执行失败:', error)
  }
}

/**
 * 性能测试示例
 */
export async function performanceTest(): Promise<void> {
  console.log('=== 文件分析性能测试 ===')
  
  const integrationService = new FileAnalysisIntegrationService()
  
  try {
    await integrationService.initialize()
    
    // 生成测试文件列表
    const testFiles = Array.from({ length: 100 }, (_, i) => ({
      id: `test-${i}`,
      name: `test-file-${i}.txt`,
      path: `/path/to/test-file-${i}.txt`,
      size: Math.floor(Math.random() * 1000000) + 1000,
      type: 'text',
      extension: 'txt'
    }))
    
    const startTime = Date.now()
    
    // 执行批量分析
    await integrationService.batchAnalyzeFiles(testFiles)
    
    // 等待分析完成
    await new Promise((resolve) => {
      const checkCompletion = () => {
        const progress = integrationService.getAnalysisProgress()
        if (progress.analyzing === 0 && progress.pending === 0) {
          resolve(true)
        } else {
          setTimeout(checkCompletion, 1000)
        }
      }
      checkCompletion()
    })
    
    const endTime = Date.now()
    const totalTime = endTime - startTime
    
    console.log(`性能测试结果:`)
    console.log(`- 文件数量: ${testFiles.length}`)
    console.log(`- 总耗时: ${totalTime}ms`)
    console.log(`- 平均每个文件: ${totalTime / testFiles.length}ms`)
    console.log(`- 吞吐量: ${(testFiles.length / totalTime * 1000).toFixed(2)} 文件/秒`)
    
  } catch (error) {
    console.error('性能测试失败:', error)
  }
}

// 导出单例实例
export const fileAnalysisIntegrationService = new FileAnalysisIntegrationService()