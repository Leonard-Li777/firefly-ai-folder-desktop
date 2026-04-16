import EventEmitter from 'events'
import path from 'node:path'
import fs from 'node:fs'
import { app, net, session, webContents, BrowserWindow } from 'electron'
import { logger, LogCategory } from '@yonuc/shared'
import { t } from '@app/languages'

import { configService } from '../config/config-service'
import type { IModelFile, IModelSummary } from '@yonuc/types/model-manager'
import type { DownloadProgressEvent, DownloadTaskSummary } from '@yonuc/types'

/**
 * 下载任务状态
 */
export enum DownloadStatus {
  PENDING = 'pending',
  DOWNLOADING = 'downloading',
  COMPLETED = 'completed',
  ERROR = 'error',
  CANCELLED = 'canceled',
  RETRYING = 'retrying'
}

/**
 * 下载任务接口
 */
export interface DownloadTask {
  taskId: string
  modelId: string
  modelName: string
  files: Array<{
    name: string
    url: string
    sizeBytes: number
    required: boolean
    type: string
  }>
  destDir: string
  totalBytes: number
  receivedBytes: number
  startTime: number
  status: DownloadStatus
  currentRequest?: any
  currentFileIndex: number
  currentFileName?: string
  retryCount: number
  lastProgressUpdate: number
  lastSpeedBytes: number
  lastSpeedTime: number
  speedBps: number
  error?: string
  webContentsId?: number
  autoRetry: boolean
  currentFileReceivedBytes: number // 当前正在下载的文件已收到的字节

  /**
   * 内部控制字段：用于处理"服务端不支持Range导致需要重启下载"等场景。
   * 该字段不会通过IPC序列化输出。
   */
  suppressNextError?: boolean
}

/**
 * 下载管理事件
 */
export enum DownloadManagerEvent {
  TASK_STARTED = 'task-started',
  TASK_PROGRESS = 'task-progress',
  TASK_COMPLETED = 'task-completed',
  TASK_ERROR = 'task-error',
  TASK_CANCELLED = 'task-canceled'
}

/**
 * 下载管理器类
 * 封装通用的下载逻辑，支持断点续传、重试机制等功能
 */
export class ModelDownloadManager extends EventEmitter {
  private static instance: ModelDownloadManager
  private activeTasks = new Map<string, DownloadTask>()
  private taskTimeouts = new Map<string, NodeJS.Timeout>()
  private initializationPromises = new Map<string, Promise<DownloadTaskSummary>>()

  /**
   * 获取单例实例
   */
  static getInstance(): ModelDownloadManager {
    if (!ModelDownloadManager.instance) {
      ModelDownloadManager.instance = new ModelDownloadManager()
    }
    return ModelDownloadManager.instance
  }

  private constructor() {
    super()
  }

  /**
   * 检查模型是否已下载完成
   */
  async checkModelDownloadStatus(modelId: string): Promise<{
    isDownloaded: boolean
    hasPartialFiles: boolean
    downloadProgress: number
    missingFiles: string[]
    existingFiles: Array<{ name: string; size: number; expectedSize: number }>
  }> {
    const model = await this.getModelById(modelId)
    if (!model) {
      throw new Error(t('模型 {modelId} 处不存在', { modelId }))
    }

    const destDir = this.getModelDirectory(modelId)
    
    // 增加物理目录存在性检查
    if (!fs.existsSync(destDir)) {
      logger.info(LogCategory.MODEL_SERVICE, `[DownloadManager] 模型目录不存在: ${destDir}`)
      return {
        isDownloaded: false,
        hasPartialFiles: false,
        downloadProgress: 0,
        missingFiles: model.files.filter(f => f.required).map(f => f.name),
        existingFiles: []
      }
    }

    const missingFiles: string[] = []
    const existingFiles: Array<{ name: string; size: number; expectedSize: number }> = []
    let totalExpectedSize = 0
    let totalActualSize = 0

    // 检查每个必需文件
    for (const file of model.files) {
      if (file.required) {
        totalExpectedSize += file.sizeBytes
        const filePath = path.join(destDir, file.name)

        if (fs.existsSync(filePath)) {
          try {
            const stats = fs.statSync(filePath)
            const actualSize = stats.size
            const expectedSize = file.sizeBytes

            if (actualSize !== expectedSize) {
              missingFiles.push(file.name)
            } else {
              totalActualSize += actualSize
              existingFiles.push({
                name: file.name,
                size: actualSize,
                expectedSize
              })
            }
          } catch (err) {
            logger.warn(LogCategory.MODEL_SERVICE, `检查文件大小时出错: ${filePath}`, err)
            missingFiles.push(file.name)
          }
        } else {
          missingFiles.push(file.name)
        }
      }
    }

    const isDownloaded = missingFiles.length === 0
    const hasPartialFiles = existingFiles.length > 0
    const downloadProgress = totalExpectedSize > 0 ? (totalActualSize / totalExpectedSize) * 100 : 0

    return {
      isDownloaded,
      hasPartialFiles,
      downloadProgress,
      missingFiles,
      existingFiles
    }
  }

  /**
   * 开始下载模型
   */
  async startDownload(
    modelId: string,
    webContentsId?: number,
    options?: {
      autoRetry?: boolean
      retryAttempts?: number
    }
  ): Promise<DownloadTaskSummary> {
    // 1. 同步检查：如果任务已在列表中，直接返回
    const existingTask = Array.from(this.activeTasks.values()).find(
      task => task.modelId === modelId
    )

    if (existingTask) {
      if (existingTask.status === DownloadStatus.PENDING || existingTask.status === DownloadStatus.ERROR) {
        logger.info(LogCategory.MODEL_SERVICE, `[DownloadManager] 恢复现有任务: ${modelId}`)
        this.resumeDownload(existingTask.taskId)
      } else {
        logger.info(LogCategory.MODEL_SERVICE, `[DownloadManager] 模型已在下载中，返回现有任务: ${modelId}`)
      }

      return {
        taskId: existingTask.taskId,
        modelId: existingTask.modelId,
        destDir: existingTask.destDir,
        totalBytes: existingTask.totalBytes
      }
    }

    // 2. 并发控制：如果正在初始化，等待结果
    if (this.initializationPromises.has(modelId)) {
      logger.info(LogCategory.MODEL_SERVICE, `[DownloadManager] 正在等待模型下载任务初始化: ${modelId}`)
      return this.initializationPromises.get(modelId)!
    }

    // 3. 执行初始化
    const promise = this._startDownloadInternal(modelId, webContentsId, options)
    this.initializationPromises.set(modelId, promise)

    try {
      return await promise
    } finally {
      this.initializationPromises.delete(modelId)
    }
  }

  /**
   * 内部下载任务初始化逻辑
   */
  private async _startDownloadInternal(
    modelId: string,
    webContentsId?: number,
    options?: {
      autoRetry?: boolean
      retryAttempts?: number
    }
  ): Promise<DownloadTaskSummary> {
    const model = await this.getModelById(modelId)
    if (!model) {
      const allModels = await this.getAllModels()
      const errorMsg = t('模型 "{modelId}" 不存在。库中可用数量: {allModelsLength}', { modelId, allModelsLength: allModels.length })
      logger.error(LogCategory.MODEL_SERVICE, `[DownloadManager] ${errorMsg}`)
      throw new Error(errorMsg)
    }

    // 检查是否已有该模型的任务
    const existingTask = Array.from(this.activeTasks.values()).find(
      task => task.modelId === modelId
    )

    if (existingTask) {
      if (existingTask.status === DownloadStatus.PENDING || existingTask.status === DownloadStatus.ERROR) {
        logger.info(LogCategory.MODEL_SERVICE, `[DownloadManager] 恢复现有任务: ${modelId}`)
        this.resumeDownload(existingTask.taskId)
      } else {
        logger.info(LogCategory.MODEL_SERVICE, `[DownloadManager] 模型已在下载中，返回现有任务: ${modelId}`)
      }

      return {
        taskId: existingTask.taskId,
        modelId: existingTask.modelId,
        destDir: existingTask.destDir,
        totalBytes: existingTask.totalBytes
      }
    }

    // 创建新的下载任务
    const taskId = `${modelId}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`
    const destDir = this.getModelDirectory(modelId)

    // 确保目录存在
    this.ensureModelDirectory(destDir)

    let initialReceivedBytes = 0
    let currentFileIndex = 0
    const requiredFiles = model.files.filter(f => f.required)

    for (let i = 0; i < requiredFiles.length; i++) {
      const file = requiredFiles[i]
      const filePath = path.join(destDir, file.name)
      if (fs.existsSync(filePath)) {
        try {
          const stats = fs.statSync(filePath)
          if (stats.size === file.sizeBytes) {
            initialReceivedBytes += stats.size
          } else {
            currentFileIndex = i
            break
          }
        } catch (err) {
          logger.warn(
            LogCategory.MODEL_SERVICE,
            `检查文件状态以恢复时出错: ${filePath}`,
            err
          )
          currentFileIndex = i
          break
        }
      } else {
        currentFileIndex = i
        break
      }
      if (i === requiredFiles.length - 1) {
        currentFileIndex = requiredFiles.length
      }
    }

    if (currentFileIndex === requiredFiles.length && requiredFiles.length > 0) {
      logger.info(LogCategory.MODEL_SERVICE, `[DownloadManager] 模型已下载完成: ${modelId}`)
      const totalBytes = requiredFiles.reduce((sum, f) => sum + f.sizeBytes, 0)
      this.emitDownloadEvent(DownloadManagerEvent.TASK_COMPLETED, {
        taskId,
        modelId,
        status: DownloadStatus.COMPLETED,
        receivedBytes: totalBytes,
        totalBytes,
        progress: 100
      })
      return { taskId, modelId, destDir, totalBytes }
    }

    const task: DownloadTask = {
      taskId,
      modelId,
      modelName: model.name,
      files: model.files.map(f => ({
        name: f.name,
        url: f.url,
        sizeBytes: f.sizeBytes,
        required: f.required,
        type: f.type || 'model'
      })),
      destDir,
      totalBytes: model.files.filter(f => f.required).reduce((sum, f) => sum + f.sizeBytes, 0),
      receivedBytes: initialReceivedBytes,
      startTime: Date.now(),
      status: DownloadStatus.DOWNLOADING,
      currentFileIndex,
      retryCount: 0,
      lastProgressUpdate: Date.now(),
      lastSpeedBytes: 0,
      lastSpeedTime: Date.now(),
      speedBps: 0,
      webContentsId,
      autoRetry: options?.autoRetry !== false,
      currentFileReceivedBytes: 0
    }

    this.activeTasks.set(taskId, task)

    logger.info(LogCategory.MODEL_SERVICE, `[DownloadManager] 开始下载模型: ${modelId}, 任务ID: ${taskId}`)

    // 发送开始事件
    this.emitDownloadEvent(DownloadManagerEvent.TASK_STARTED, {
      taskId,
      modelId,
      modelName: model.name,
      totalBytes: task.totalBytes,
      receivedBytes: task.receivedBytes,
      status: DownloadStatus.DOWNLOADING
    })

    // 开始下载第一个文件
    this.downloadNextFile(taskId)

    return {
      taskId,
      modelId,
      destDir,
      totalBytes: task.totalBytes
    }
  }

  /**
   * 取消下载
   */
  async cancelDownload(taskId: string): Promise<void> {
    const task = this.activeTasks.get(taskId)
    if (!task) {
      logger.warn(LogCategory.MODEL_SERVICE, `[DownloadManager] 任务不存在: ${taskId}`)
      return
    }

    logger.info(LogCategory.MODEL_SERVICE, `[DownloadManager] 取消下载任务: ${taskId}`)

    task.status = DownloadStatus.CANCELLED

    // 取消当前请求
    if (task.currentRequest) {
      try {
        task.currentRequest.abort()
      } catch (err) {
        logger.warn(LogCategory.MODEL_SERVICE, `[DownloadManager] 取消请求失败: ${taskId}`, err)
      }
      task.currentRequest = undefined
    }

    // 清除超时定时器
    const timeout = this.taskTimeouts.get(taskId)
    if (timeout) {
      clearTimeout(timeout)
      this.taskTimeouts.delete(taskId)
    }

    // 发送取消事件
    this.emitDownloadEvent(DownloadManagerEvent.TASK_CANCELLED, {
      taskId,
      modelId: task.modelId,
      status: DownloadStatus.CANCELLED
    })

    // 从活跃任务中移除
    this.activeTasks.delete(taskId)

    logger.info(LogCategory.MODEL_SERVICE, `[DownloadManager] 任务已取消: ${taskId}`)
  }

  /**
   * 暂停下载（保留当前状态）
   */
  pauseDownload(taskId: string): void {
    const task = this.activeTasks.get(taskId)
    if (!task) return

    logger.info(LogCategory.MODEL_SERVICE, `[DownloadManager] 暂停下载任务: ${taskId}`)

    if (task.currentRequest) {
      task.currentRequest.abort()
      task.currentRequest = undefined
    }

    task.status = DownloadStatus.PENDING
  }

  /**
   * 恢复下载
   */
  resumeDownload(taskId: string): void {
    const task = this.activeTasks.get(taskId)
    if (!task) return

    // 防止重复启动
    if (task.status === DownloadStatus.DOWNLOADING || task.status === DownloadStatus.RETRYING) {
      logger.info(LogCategory.MODEL_SERVICE, `[DownloadManager] 任务已在运行中，忽略恢复请求: ${taskId}`)
      return
    }

    logger.info(LogCategory.MODEL_SERVICE, `[DownloadManager] 恢复下载任务: ${taskId}`)

    task.status = DownloadStatus.DOWNLOADING

    // 重置速度计算相关的状态
    task.lastSpeedTime = Date.now()
    task.lastSpeedBytes = task.currentFileReceivedBytes || 0
    task.speedBps = 0

    task.currentFileIndex = this.getCurrentFileIndex(task)
    this.downloadNextFile(taskId)
  }

  /**
   * 获取下载任务状态
   */
  getTaskStatus(taskId: string): DownloadTask | null {
    return this.activeTasks.get(taskId) || null
  }

  /**
   * 获取模型的活跃任务
   */
  getModelTask(modelId: string): DownloadTask | null {
    return Array.from(this.activeTasks.values()).find(task => task.modelId === modelId) || null
  }

  /**
   * 检查模型是否有正在进行的下载
   */
  isModelDownloading(modelId: string): boolean {
    return this.getModelTask(modelId) !== null
  }

  /**
   * 获取所有活跃任务
   */
  getAllTasks(): DownloadTask[] {
    return Array.from(this.activeTasks.values())
  }

  private async getModelById(modelId: string): Promise<IModelSummary | null> {
    try {
      // 修复：不应该在主进程中访问 window 对象
      // 改为直接从模型配置服务获取模型信息
      const modelConfigs = await this.getAllModels();
      const model = modelConfigs.find((m: IModelSummary) => m.id === modelId) || null;

      if (!model) {
        logger.warn(LogCategory.MODEL_SERVICE, `[DownloadManager] 找不到模型 ID: "${modelId}", 当前库中共有 ${modelConfigs.length} 个模型`);
        if (modelConfigs.length > 0) {
          logger.debug(LogCategory.MODEL_SERVICE, `[DownloadManager] 库中可用模型 ID 列表: ${modelConfigs.map(m => m.id).join(', ')}`);
        }
      }

      return model;
    } catch (err) {
      logger.error(LogCategory.MODEL_SERVICE, '[DownloadManager] 获取模型列表失败:', err);
      return null;
    }
  }

  /**
   * 获取所有模型配置
   * 从模型配置服务加载模型列表
   */
  private async getAllModels(): Promise<IModelSummary[]> {
    try {
      // 使用 ModelConfigService 获取模型配置
      const { ModelConfigService } = await import('../analysis/model-config-service');
      const configService = ModelConfigService.getInstance();
      const models = configService.loadModelConfig();

      // 转换为 IModelSummary 格式
      return models.map(model => ({
        id: model.id,
        name: model.name,
        description: model.description,
        company: model.company,
        parameterSize: model.parameterSize,
        totalSizeText: model.totalSize,
        totalSizeBytes: model.totalSizeBytes,
        minVramGB: model.hardwareRequirements?.minVramGB || 0,
        recommendedVramGB: model.hardwareRequirements?.recommendedVramGB || 0,
        gpuAccelerated: model.hardwareRequirements?.gpuAccelerated || false,
        performance: model.performance || { speed: 'medium', quality: 'medium', score: 0 },
        capabilities: (model.capabilities ?? []).map(c => c.type),
        tags: model.tags || [],
        files: model.files || [],
        vramRequiredGB: model.vramRequiredGB || 0,
        isDownloaded: false, // 需要在调用方检查实际下载状态
        isRecommended: false // 需要在调用方检查推荐状态
      }));
    } catch (err) {
      logger.error(LogCategory.MODEL_SERVICE, '[DownloadManager] 获取所有模型失败:', err);
      return [];
    }
  }

  private getModelDirectory(modelId: string): string {
    try {
      const configuredPath = configService.getValue<string>('MODEL_STORAGE_PATH')
      if (configuredPath && configuredPath.trim().length > 0) {
        return path.resolve(path.join(configuredPath.trim(), modelId))
      }
    } catch (error) {
      logger.warn(LogCategory.MODEL_SERVICE, '读取模型存储路径失败，将使用默认目录', error)
    }
    return path.join(app.getPath('userData'), 'models', modelId)
  }

  private ensureModelDirectory(dir: string): void {
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch (err) {
      logger.error(LogCategory.MODEL_SERVICE, '创建模型目录失败:', err)
    }
  }

  private getCurrentFileIndex(task: DownloadTask): number {
    // 找到第一个缺失或不完整的文件
    for (let i = 0; i < task.files.length; i++) {
      const file = task.files[i]
      if (!file.required) continue

      const filePath = path.join(task.destDir, file.name)
      if (!fs.existsSync(filePath)) {
        return i
      }

      try {
        const stats = fs.statSync(filePath)
        if (stats.size !== file.sizeBytes) {
          return i
        }
      } catch (err) {
        return i
      }
    }
    return task.files.length // 所有文件都已完成
  }

  private calculateCompletedRequiredBytes(task: DownloadTask): number {
    let total = 0

    for (const file of task.files) {
      if (!file.required) continue

      const filePath = path.join(task.destDir, file.name)
      try {
        if (!fs.existsSync(filePath)) continue
        const stats = fs.statSync(filePath)
        if (stats.size === file.sizeBytes) {
          total += file.sizeBytes
        }
      } catch (err) {
        logger.debug(LogCategory.MODEL_SERVICE, `[DownloadManager] 计算已完成字节数失败: ${filePath}`, err)
      }
    }

    return total
  }

  private getResumePositionOrReset(filePath: string, expectedSizeBytes: number): number {
    if (!fs.existsSync(filePath)) return 0

    try {
      const stats = fs.statSync(filePath)
      const size = stats.size

      // 0字节无需恢复
      if (size <= 0) return 0

      // 超出期望大小，直接重置
      if (size > expectedSizeBytes) {
        logger.warn(
          LogCategory.MODEL_SERVICE,
          `[DownloadManager] 不完整文件大小异常，将重置: ${filePath} (Expected: ${expectedSizeBytes}, Actual: ${size})`
        )
        fs.unlinkSync(filePath)
        return 0
      }

      // GGUF 文件头应为 "GGUF"。如果头部不匹配，通常是 429/403 等错误页面写入导致，应重置。
      if (size < 4) {
        logger.warn(LogCategory.MODEL_SERVICE, `[DownloadManager] 不完整文件过小，无法验证头部，将重置: ${filePath} (Size: ${size})`)
        fs.unlinkSync(filePath)
        return 0
      }

      const fd = fs.openSync(filePath, 'r')
      try {
        const header = Buffer.alloc(4)
        fs.readSync(fd, header, 0, 4, 0)
        const magic = header.toString('ascii')
        if (magic !== 'GGUF') {
          logger.warn(
            LogCategory.MODEL_SERVICE,
            `[DownloadManager] 检测到非GGUF头部（可能是错误响应写入），将重置: ${filePath} (Magic: ${magic})`
          )
          fs.unlinkSync(filePath)
          return 0
        }
      } finally {
        fs.closeSync(fd)
      }

      return size
    } catch (err) {
      logger.warn(LogCategory.MODEL_SERVICE, `[DownloadManager] 检查断点续传文件失败，将重置: ${filePath}`, err)
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
      } catch {
        // 忽略
      }
      return 0
    }
  }

  private parseRetryAfterMs(retryAfterHeader: unknown): number | undefined {
    if (!retryAfterHeader) return undefined

    const raw = Array.isArray(retryAfterHeader) ? retryAfterHeader[0] : retryAfterHeader
    const value = String(raw).trim()

    // 秒数
    const seconds = Number(value)
    if (!Number.isNaN(seconds) && Number.isFinite(seconds)) {
      return Math.max(0, Math.floor(seconds * 1000))
    }

    // HTTP-date
    const dateMs = Date.parse(value)
    if (!Number.isNaN(dateMs)) {
      const diff = dateMs - Date.now()
      return diff > 0 ? diff : 0
    }

    return undefined
  }

  private downloadNextFile(taskId: string): void {
    const task = this.activeTasks.get(taskId)
    if (!task) return

    // 基于磁盘状态刷新已完成字节数，避免出现 receivedBytes > totalBytes 的异常状态
    task.receivedBytes = this.calculateCompletedRequiredBytes(task)

    // 检查任务是否被取消
    if (task.status === DownloadStatus.CANCELLED) {
      logger.debug(LogCategory.MODEL_SERVICE, `[DownloadManager] 任务已取消，跳过文件下载: ${taskId}`)
      return
    }

    // 检查是否所有文件都已下载完成
    if (task.currentFileIndex >= task.files.length) {
      this.completeTask(task)
      return
    }

    // 找到第一个需要下载的文件
    const fileIndex = this.getCurrentFileIndex(task)
    if (fileIndex >= task.files.length) {
      this.completeTask(task)
      return
    }

    task.currentFileIndex = fileIndex
    const file = task.files[fileIndex]
    if (!file.required) {
      // 跳过非必需文件
      this.downloadNextFile(taskId)
      return
    }

    const filePath = path.join(task.destDir, file.name)

    // 如果文件存在且完整，跳过下载
    if (fs.existsSync(filePath)) {
      try {
        const stats = fs.statSync(filePath)
        if (stats.size === file.sizeBytes) {
          logger.debug(LogCategory.MODEL_SERVICE, `[DownloadManager] 文件已存在且完整，跳过: ${filePath} (Size: ${stats.size})`)
          task.currentFileIndex++
          task.currentFileName = undefined
          task.currentFileReceivedBytes = 0

          // 可能存在“前面文件不完整但后面文件已存在”的情况，这里统一基于磁盘状态刷新
          task.receivedBytes = this.calculateCompletedRequiredBytes(task)

          this.sendProgressUpdate(task)
          this.downloadNextFile(taskId)
          return
        } else {
           logger.warn(LogCategory.MODEL_SERVICE, `[DownloadManager] 文件存在但不完整: ${filePath} (Expected: ${file.sizeBytes}, Actual: ${stats.size})`)
        }
      } catch (err) {
        logger.warn(LogCategory.MODEL_SERVICE, `[DownloadManager] 检查文件状态失败: ${filePath}`, err)
      }
    } else {
      logger.debug(LogCategory.MODEL_SERVICE, `[DownloadManager] 文件不存在，准备下载: ${filePath}`)
    }

    // 检查是否存在不完整的文件（并在必要时重置不合法的断点文件）
    const resumePosition = this.getResumePositionOrReset(filePath, file.sizeBytes)

    // 开始下载文件
    this.downloadFile(task, file, filePath, taskId, fileIndex, resumePosition)
  }

  private downloadFile(
    task: DownloadTask,
    file: any,
    filePath: string,
    taskId: string,
    fileIndex: number,
    resumePosition = 0
  ): void {
    if (task.status === DownloadStatus.CANCELLED) {
      logger.debug(LogCategory.MODEL_SERVICE, `[DownloadManager] 任务已取消，跳过文件下载: ${file.name}`)
      return
    }

    const url = file.url
    const requestOptions: { url: string; session: any; headers?: any } = { url, session: session.defaultSession }

    if (resumePosition > 0) {
      requestOptions.headers = { Range: `bytes=${resumePosition}-` }
      logger.info(LogCategory.MODEL_SERVICE, `[DownloadManager] 恢复下载: ${file.name} from ${resumePosition}`)
    }

    const request = net.request(requestOptions)
    task.currentRequest = request

    task.currentFileName = file.name

    // 基于磁盘状态刷新已完成字节数，避免出现 receivedBytes > totalBytes（通常由重复计入或并发流导致）
    task.receivedBytes = this.calculateCompletedRequiredBytes(task)

    // 当前文件已下载字节数（用于断点续传进度展示）
    task.currentFileReceivedBytes = resumePosition

    logger.debug(LogCategory.MODEL_SERVICE, `[DownloadManager] 开始下载文件: ${file.name}`)

    // 如果是断点续传，立即推送一次进度，避免前端看到进度回退
    if (resumePosition > 0) {
      this.sendProgressUpdate(task, resumePosition)
      task.lastProgressUpdate = Date.now()
    }

    // 重置新文件的速度计算
    task.lastSpeedBytes = resumePosition
    task.lastSpeedTime = Date.now()
    task.speedBps = 0

    request.on('response', (response) => {
      logger.debug(LogCategory.MODEL_SERVICE, `[DownloadManager] 收到响应: ${file.name}`, {
        statusCode: response.statusCode,
        headers: response.headers
      })

      const statusCode = response.statusCode ?? 0

      // 1) HTTP 状态码非成功时（例如 429），不能写入文件，否则会把错误页面写入磁盘，导致下次断点续传死循环
      //    这里直接走错误处理，并尽量尊重 Retry-After。
      const isSuccess = statusCode === 200 || statusCode === 206
      if (!isSuccess) {
        const retryDelayMs = statusCode === 429 ? this.parseRetryAfterMs(response.headers['retry-after']) : undefined

        // 429/5xx 等临时错误尽量保留已下载的部分文件，以便后续继续断点续传
        const keepPartialFile = resumePosition > 0 && (statusCode === 429 || statusCode >= 500)

        // 绝大多数 4xx（除 408/429）属于永久错误，重试只会造成“看起来卡死/一直重试”的体验
        const disableRetry = statusCode >= 400 && statusCode < 500 && statusCode !== 408 && statusCode !== 429

        logger.warn(LogCategory.MODEL_SERVICE, `[DownloadManager] 文件下载HTTP错误: ${file.name} (Status: ${statusCode})`, {
          retryAfter: response.headers['retry-after'],
          disableRetry
        })

        try {
          (response as any).destroy?.()
        } catch {
          // 忽略
        }

        this.handleDownloadError(
          task,
          new Error(t('HTTP {statusCode} 下载失败: {fileName}', { statusCode, fileName: file.name })),
          taskId,
          fileIndex,
          { retryDelayMs, keepPartialFile, disableRetry }
        )
        return
      }

      // 2) 断点续传但服务端返回 200（非 206），说明不支持 Range：需要重置文件后从头下载
      if (resumePosition > 0 && statusCode === 200) {
        logger.warn(LogCategory.MODEL_SERVICE, `[DownloadManager] 服务器不支持恢复下载，将重新开始下载: ${file.name}`)

        // 标记本次主动中止产生的错误需要被忽略（并设置一个短期兜底清理，避免误伤后续真实错误）
        task.suppressNextError = true
        setTimeout(() => {
          if (task.suppressNextError) task.suppressNextError = false
        }, 1000)

        // 主动中止前先替换本次请求的 error 监听，避免触发 handleDownloadError 的重试逻辑；同时避免“无 error 监听导致进程抛错”
        request.removeAllListeners('error')
        request.on('error', () => { })

        try {
          request.abort()
        } catch (err) {
          logger.debug(LogCategory.MODEL_SERVICE, `[DownloadManager] 主动中止请求失败（将继续重试）: ${file.name}`, err)
        }

        try {
          (response as any).destroy?.()
        } catch (err) {
          logger.debug(LogCategory.MODEL_SERVICE, `[DownloadManager] 主动销毁响应失败（将继续重试）: ${file.name}`, err)
        }

        task.currentRequest = undefined
        task.currentFileReceivedBytes = 0

        // 清理不完整文件（Range 不可用时不能继续 append）
        try {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath)
          }
        } catch (err) {
          logger.warn(LogCategory.MODEL_SERVICE, `[DownloadManager] 清理不完整文件失败: ${filePath}`, err)
        }

        setImmediate(() => this.downloadFile(task, file, filePath, taskId, fileIndex, 0))
        return
      }

      const writeStream = fs.createWriteStream(filePath, { flags: resumePosition > 0 ? 'a' : 'w' })
      let fileReceivedBytes = resumePosition
      let lastLogTime = Date.now()

      response.on('data', (chunk) => {
        // 检查是否已取消下载
        if (task.status === DownloadStatus.CANCELLED) {
          logger.debug(LogCategory.MODEL_SERVICE, `[DownloadManager] 下载已取消，跳过数据处理: ${file.name}`)
          return
        }

        // 防止旧请求在重启/重试后继续写入与计数
        if (task.currentRequest !== request) {
          return
        }

        writeStream.write(chunk)
        fileReceivedBytes += chunk.length
        task.currentFileReceivedBytes = fileReceivedBytes

        // 更新下载进度
        this.updateDownloadProgress(task, fileReceivedBytes, chunk.length)

        // 定期记录日志
        if (Date.now() - lastLogTime > 5000) {
          logger.debug(LogCategory.MODEL_SERVICE, `[DownloadManager] 文件下载进度: ${file.name}`, {
            received: fileReceivedBytes,
            total: file.sizeBytes,
            progress: (fileReceivedBytes / file.sizeBytes) * 100
          })
          lastLogTime = Date.now()
        }
      })

      response.on('end', () => {
        if (task.status === DownloadStatus.CANCELLED || task.status === DownloadStatus.PENDING) {
          logger.info(LogCategory.MODEL_SERVICE, `[DownloadManager] 下载已${task.status === DownloadStatus.CANCELLED ? '取消' : '暂停'}，跳过文件完成处理: ${file.name}`)
          writeStream.end()
          return
        }

        // 如果该请求已不是当前请求，说明发生了内部重启/重试，忽略旧请求的结束事件
        if (task.currentRequest !== request) {
          writeStream.end()
          return
        }

        writeStream.end(() => {
          // 基于磁盘状态刷新已完成字节数（避免重复计入导致溢出）
          task.receivedBytes = this.calculateCompletedRequiredBytes(task)

          task.currentFileReceivedBytes = 0
          task.currentFileName = undefined
          task.currentRequest = undefined

          logger.debug(LogCategory.MODEL_SERVICE, `[DownloadManager] 文件下载完成: ${file.name}`)

          // 继续下载下一个文件
          this.downloadNextFile(taskId)
        })
      })

      response.on('error', (err) => {
        logger.error(LogCategory.MODEL_SERVICE, `[DownloadManager] 文件下载错误: ${file.name}`, err)
        this.handleDownloadError(task, err, taskId, fileIndex)
      })
    })

    request.on('error', (err) => {
      logger.error(LogCategory.MODEL_SERVICE, `[DownloadManager] 下载请求错误: ${file.name}`, err)
      this.handleDownloadError(task, err, taskId, fileIndex)
    })

    request.end()
  }

  private handleDownloadError(
    task: DownloadTask,
    error: Error,
    taskId: string,
    fileIndex: number,
    options?: {
      retryDelayMs?: number
      keepPartialFile?: boolean
      disableRetry?: boolean
    }
  ): void {
    // 内部主动中止（例如 Range 不支持导致重启下载）产生的错误需要忽略
    if (task.suppressNextError) {
      task.suppressNextError = false
      logger.debug(LogCategory.MODEL_SERVICE, `[DownloadManager] 忽略内部重启导致的错误: ${task.modelId}`, error)
      return
    }

    // 检查是否已取消下载或暂停
    if (task.status === DownloadStatus.CANCELLED || task.status === DownloadStatus.PENDING) {
      logger.debug(LogCategory.MODEL_SERVICE, `[DownloadManager] 任务已${task.status === DownloadStatus.CANCELLED ? '取消' : '暂停'}，忽略错误`)
      return
    }

    task.currentRequest = undefined
    task.currentFileReceivedBytes = 0

    // 清理当前文件（默认会清理；但对于 429/5xx 等临时错误可以保留，以便断点续传继续）
    if (task.currentFileName && !options?.keepPartialFile) {
      const filePath = path.join(task.destDir, task.currentFileName)
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath)
        }
      } catch (err) {
        logger.warn(LogCategory.MODEL_SERVICE, `[DownloadManager] 清理失败文件失败: ${filePath}`, err)
      }
    }

    // 自动重试机制
    if (!options?.disableRetry && task.autoRetry && task.retryCount < 3) {
      task.retryCount++
      task.status = DownloadStatus.RETRYING

      logger.warn(LogCategory.MODEL_SERVICE, `[DownloadManager] 下载失败，准备重试 (${task.retryCount}/3): ${task.modelId}`)

      // 发送重试事件
      this.emitDownloadEvent(DownloadManagerEvent.TASK_ERROR, {
        taskId,
        modelId: task.modelId,
        status: DownloadStatus.RETRYING,
        error: error.message,
        retryCount: task.retryCount
      })

      // 延迟重试
      const baseRetryDelay = Math.pow(2, task.retryCount) * 2000 // 指数退避，2s, 4s, 8s
      const retryDelay = options?.retryDelayMs !== undefined ? Math.max(baseRetryDelay, options.retryDelayMs) : baseRetryDelay

      const timeout = setTimeout(() => {
        logger.info(
          LogCategory.MODEL_SERVICE,
          `[DownloadManager] 开始重试下载: ${task.modelId} (${task.retryCount}/3), delay=${retryDelay}ms`
        )
        task.status = DownloadStatus.DOWNLOADING
        this.downloadNextFile(taskId)
      }, retryDelay)

      this.taskTimeouts.set(taskId, timeout)
      return
    }

    // 达到最大重试次数或不可重试错误，报告错误
    if (options?.disableRetry) {
      logger.error(LogCategory.MODEL_SERVICE, `[DownloadManager] 下载失败（不可重试）: ${task.modelId}`)
    } else {
      logger.error(LogCategory.MODEL_SERVICE, `[DownloadManager] 下载失败，达到最大重试次数: ${task.modelId}`)
    }

    task.status = DownloadStatus.ERROR
    task.error = error.message

    // 发送错误事件
    this.emitDownloadEvent(DownloadManagerEvent.TASK_ERROR, {
      taskId,
      modelId: task.modelId,
      status: DownloadStatus.ERROR,
      error: error.message,
      receivedBytes: task.receivedBytes,
      totalBytes: task.totalBytes
    })

    // 从活跃任务中移除
    this.activeTasks.delete(taskId)
  }

  private updateDownloadProgress(task: DownloadTask, fileReceivedBytes: number, chunkSize: number): void {
    // 计算当前下载速度
    const now = Date.now()
    const timeDiff = (now - task.lastSpeedTime) / 1000
    if (timeDiff > 0.5) { // 每0.5秒更新一次速度
      const bytesDiff = fileReceivedBytes - task.lastSpeedBytes
      
      // 避免负速度（可能是由于重试或并发更新导致）
      if (bytesDiff < 0) {
        task.lastSpeedBytes = fileReceivedBytes
        task.lastSpeedTime = now
        return
      }

      const currentSpeed = bytesDiff / timeDiff

      // 使用指数移动平均 (EMA) 来平滑速度
      const alpha = 0.1 // 平滑因子
      task.speedBps = alpha * currentSpeed + (1 - alpha) * task.speedBps

      task.lastSpeedTime = now
      task.lastSpeedBytes = fileReceivedBytes
    }

    // 发送进度更新（限频）
    if (now - task.lastProgressUpdate > 500) {
      this.sendProgressUpdate(task, fileReceivedBytes)
      task.lastProgressUpdate = now
    }
  }

  private sendProgressUpdate(task: DownloadTask, currentFileBytes?: number): void {
    const currentBytes = currentFileBytes !== undefined ? currentFileBytes : (task.currentFileReceivedBytes || 0)
    const totalBytes = Math.max(0, task.totalBytes || 0)
    const totalReceived = (task.receivedBytes || 0) + currentBytes

    // 防御性处理：任何情况下 receivedBytes 都不应超过 totalBytes
    const safeReceived = totalBytes > 0 ? Math.min(totalBytes, totalReceived) : 0
    const progress = totalBytes > 0 ? Math.min(100, (safeReceived / totalBytes) * 100) : 0

    this.emitDownloadEvent(DownloadManagerEvent.TASK_PROGRESS, {
      taskId: task.taskId,
      modelId: task.modelId,
      status: task.status,
      receivedBytes: safeReceived,
      totalBytes,
      progress,
      speedBps: task.speedBps,
      currentFileName: task.currentFileName
    })
  }

  private completeTask(task: DownloadTask): void {
    // 最终校验文件大小
    let allFilesValid = true
    for (const file of task.files) {
      if (!file.required) continue
      const filePath = path.join(task.destDir, file.name)
      try {
        if (!fs.existsSync(filePath)) {
          logger.error(LogCategory.MODEL_SERVICE, `[DownloadManager] 文件缺失: ${file.name}`)
          allFilesValid = false
          break
        }
        const stats = fs.statSync(filePath)
        if (stats.size !== file.sizeBytes) {
          logger.error(LogCategory.MODEL_SERVICE, `[DownloadManager] 文件大小校验失败: ${file.name}, 期望: ${file.sizeBytes}, 实际: ${stats.size}`)
          allFilesValid = false
          break
        }
      } catch (err) {
        logger.error(LogCategory.MODEL_SERVICE, `[DownloadManager] 无法校验文件: ${file.name}`, err)
        allFilesValid = false
        break
      }
    }

    if (!allFilesValid) {
      const error = new Error('模型文件完整性校验失败')
      logger.error(LogCategory.MODEL_SERVICE, `[DownloadManager] 模型下载校验失败: ${task.modelId}`)
      
      task.status = DownloadStatus.ERROR
      task.error = error.message

      this.emitDownloadEvent(DownloadManagerEvent.TASK_ERROR, {
        taskId: task.taskId,
        modelId: task.modelId,
        status: DownloadStatus.ERROR,
        error: error.message,
        receivedBytes: task.receivedBytes,
        totalBytes: task.totalBytes
      })

      this.activeTasks.delete(task.taskId)
      return
    }

    logger.info(LogCategory.MODEL_SERVICE, `[DownloadManager] 模型下载完成且校验通过: ${task.modelId}`)

    task.status = DownloadStatus.COMPLETED
    task.error = undefined

    // 发送完成事件
    this.emitDownloadEvent(DownloadManagerEvent.TASK_COMPLETED, {
      taskId: task.taskId,
      modelId: task.modelId,
      status: DownloadStatus.COMPLETED,
      receivedBytes: task.totalBytes,
      totalBytes: task.totalBytes,
      progress: 100
    })

    // 更新配置中的selectedModelId
    this.updateSelectedModelId(task.modelId)

    // 从活跃任务中移除
    this.activeTasks.delete(task.taskId)

    // 清理超时定时器
    const timeout = this.taskTimeouts.get(task.taskId)
    if (timeout) {
      clearTimeout(timeout)
      this.taskTimeouts.delete(task.taskId)
    }
  }

  private async updateSelectedModelId(modelId: string): Promise<void> {
    try {
      await configService.updateValue('SELECTED_MODEL_ID', modelId)
      logger.debug(LogCategory.MODEL_SERVICE, '[DownloadManager] 已更新配置中的selectedModelId:', modelId)

      // 通知AI服务重新初始化
      const { aiService } = await import('../ai/ai-service')
      aiService.reinitialize().catch((err: Error) => {
        logger.error(LogCategory.MODEL_SERVICE, '[DownloadManager] AI服务重新初始化失败:', err)
      })
    } catch (err) {
      logger.error(LogCategory.MODEL_SERVICE, '[DownloadManager] 更新配置失败:', err)
    }
  }

  private emitDownloadEvent(event: DownloadManagerEvent, data: any): void {
    this.emit(event, data)

    // 转换为标准IPC格式
    const payload: DownloadProgressEvent = {
      taskId: data.taskId,
      modelId: data.modelId,
      fileName: data.currentFileName,
      receivedBytes: data.receivedBytes,
      totalBytes: data.totalBytes,
      percent: data.progress,
      speedBps: data.speedBps,
      status: this.mapToStandardStatus(data.status),
      error: data.error
    }

    // 发送给特定webContents或所有窗口
    if (data.taskId) {
      const task = this.activeTasks.get(data.taskId) || { webContentsId: undefined }
      const wc = task?.webContentsId ? webContents.fromId(task.webContentsId) : undefined

      if (wc) {
        wc.send('model-download-progress', payload)
        if (payload.status === 'completed') {
          wc.send('model-download-complete', payload)
        }
      } else {
        const allWindows = BrowserWindow.getAllWindows()
        allWindows.forEach((win: any) => {
          win.webContents.send('model-download-progress', payload)
          if (payload.status === 'completed') {
            win.webContents.send('model-download-complete', payload)
          }
        })
      }
    }
  }

  private mapToStandardStatus(status: DownloadStatus | string): 'downloading' | 'completed' | 'error' | 'canceled' | 'retrying' {
    switch (status) {
      case DownloadStatus.DOWNLOADING:
        return 'downloading'
      case DownloadStatus.RETRYING:
        return 'retrying'
      case DownloadStatus.COMPLETED:
        return 'completed'
      case DownloadStatus.ERROR:
        return 'error'
      case DownloadStatus.CANCELLED:
        return 'canceled'
      default:
        return 'downloading'
    }
  }
}

/**
 * 导出单例实例
 * 注意：由于可能的循环依赖，建议在方法内部使用 ModelDownloadManager.getInstance()
 */
export const modelDownloadManager = ModelDownloadManager.getInstance()