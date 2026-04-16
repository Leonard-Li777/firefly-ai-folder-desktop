import { BrowserWindow, app, ipcMain, net, session, webContents } from 'electron'
import type {
  DownloadProgressEvent,
  DownloadTaskSummary,
  HardwareInfo,
  ModelSummary
} from '@yonuc/types'
import type { ILlamaModelConfig, IModelSummary } from '@yonuc/types'
import { LogCategory, logger } from '@yonuc/shared'

import EventEmitter from 'events'
import { ModelConfig } from '../../model'
import { ModelConfigService } from '../analysis/model-config-service'
import { configService } from '../config/config-service'
import { ConfigOrchestrator } from '../../config/config-orchestrator'
import { exec } from 'node:child_process'
import fixPath from 'fix-path'
import fs from 'node:fs'
import { LlamaModelManager } from './llama-model-manager'
import { ModelDownloadManager } from '../ai/model-download-manager'
import os from 'node:os'
import path from 'node:path'

// 在 macOS 和 Linux 上修复 PATH 环境变量
if (process.platform !== 'win32') {
  try {
    const fixPathFunc = typeof fixPath === 'function' ? fixPath : (fixPath as any).default;
    if (typeof fixPathFunc === 'function') {
      fixPathFunc();
    }
  } catch (e) {
    console.error('Failed to fix PATH in LlamaModelService:', e);
  }
}
import { promisify } from 'node:util'

type VRAMSource = 'electron-api' | 'nvidia-smi' | 'dxdiag' | 'system-command' | 'default'
type GPUType = 'dedicated' | 'integrated' | 'none'
interface VRAMInfo {
  valueMB: number
  source: VRAMSource
  gpuType: GPUType
  detectionTimeMs: number
  attempts: {
    method: string
    timeMs: number
    success: boolean
    valueMB?: number
  }[]
}

const execPromise = promisify(exec)

function parseSizeToBytes(size: string): number {
  try {
    const match = size
      .trim()
      .toUpperCase()
      .match(/([\d.]+)\s*(KB|MB|GB|TB)?/)
    if (!match) {
      return 0
    }
    const value = parseFloat(match[1])
    const unit = match[2] || 'B'
    const unitMap: Record<string, number> = {
      B: 1,
      KB: 1024,
      MB: 1024 ** 2,
      GB: 1024 ** 3,
      TB: 1024 ** 4
    }
    const bytes = Math.round(value * (unitMap[unit] || 1))
    return bytes
  } catch (error) {
    logger.error(LogCategory.MODEL_SERVICE, '解析显存大小时出错', error)
    return 0
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(2)}${sizes[i]}`
}

/**
 * 模型加载状态事件定义
 */
export enum ModelLoadingEvent {
  START = 'model-loading-start',
  COMPLETE = 'model-loading-complete',
  ERROR = 'model-loading-error'
}

/**
 * 下载任务接口
 */
interface DownloadTask {
  model: ModelConfig
  files: Array<{
    name: string
    url: string
    sizeBytes: number
    required: boolean
  }>
  destDir: string
  totalBytes: number
  receivedBytes: number
  startTime: number
  currentRequest?: Electron.ClientRequest
  aborted: boolean
  webContentsId?: number
  lastPercent: number
  lastUpdate: number
  fileProgress: Map<string, number>
  currentFileName?: string
  lastSpeedUpdate: number
  lastSpeedBytes: number
  lastUpdateBytes: number
  isUpdating: boolean
  lastDebugLog: number
  retryCount: number // 添加重试计数器
}

export class ModelService extends EventEmitter {
  private static instance: ModelService;
  // 定义安全的IPC通道名称
  private static readonly IPC_CHANNELS = {
    LOADING_START: 'model-service:loading-start',
    LOADING_COMPLETE: 'model-service:loading-complete',
    LOADING_ERROR: 'model-service:loading-error'
  }

  public static getInstance(): ModelService {
    if (!ModelService.instance) {
      ModelService.instance = new ModelService();
    }
    return ModelService.instance;
  }

  // 注册IPC通信处理程序
  private constructor() {
    super()
    this.registerIpcHandlers()
  }

  /**
   * 注册IPC通信处理程序
   */
  private registerIpcHandlers() {
    // 验证IPC通道名称是否安全
    Object.values(ModelService.IPC_CHANNELS).forEach(channel => {
      if (!channel.startsWith('model-service:')) {
        throw new Error(`不安全的IPC通道名称: ${channel}`)
      }
    })

    // 清理之前的监听器
    ipcMain.removeAllListeners(ModelService.IPC_CHANNELS.LOADING_START)
    ipcMain.removeAllListeners(ModelService.IPC_CHANNELS.LOADING_COMPLETE)
    ipcMain.removeAllListeners(ModelService.IPC_CHANNELS.LOADING_ERROR)

    // 注册新的监听器
    ipcMain.on(ModelService.IPC_CHANNELS.LOADING_START, (event, modelId) => {
      if (logger) {
        logger.debug(LogCategory.MODEL_SERVICE, '[ModelService] 收到加载开始请求:', modelId)
      }
      // 这里可以添加额外的验证逻辑
    })
  }

  private downloads = new Map<string, DownloadTask>()

  /**
   * 获取 GGUF 格式的模型列表（新接口）
   */
  async listLlamaModels(): Promise<IModelSummary[]> {
    return await LlamaModelManager.getInstance().listModels()
  }

  /**
   * 获取 GGUF 格式的模型信息
   */
  async getLlamaModelInfo(modelId: string): Promise<ILlamaModelConfig | null> {
    return await LlamaModelManager.getInstance().getModelInfo(modelId)
  }

  /**
   * 检查 GGUF 模型是否已下载
   */
  async isLlamaModelDownloaded(modelId: string): Promise<boolean> {
    return (await ModelDownloadManager.getInstance().checkModelDownloadStatus(modelId)).isDownloaded
  }

  /**
   * 获取 GGUF 模型路径
   */
  async getLlamaModelPath(modelId: string): Promise<string | null> {
    return await LlamaModelManager.getInstance().getModelPath(modelId)
  }

  /**
   * 开始下载 GGUF 模型
   */
  async startLlamaModelDownload(modelId: string, webContentsId?: number): Promise<any> {
    const focusedWebContents = webContents.getFocusedWebContents()
    const task = await ModelDownloadManager.getInstance().startDownload(modelId, focusedWebContents?.id)
    return {
      taskId: task.taskId,
      modelId: task.modelId,
      destDir: task.destDir,
      totalBytes: task.totalBytes
    }
  }

  /**
   * 验证 GGUF 模型
   */
  async validateLlamaModel(modelId: string) {
    return await LlamaModelManager.getInstance().validateModel(modelId)
  }

  /**
   * 获取模型能力信息
   */
  async getModelCapabilities(modelId: string) {
    return await LlamaModelManager.getInstance().getModelCapabilities(modelId)
  }

  /**
   * 根据硬件推荐模型
   */
  async recommendModelsByHardware(memoryGB: number, hasGPU?: boolean, vramGB?: number) {
    return await LlamaModelManager.getInstance().recommendModelsByHardware(memoryGB, hasGPU, vramGB)
  }

  /**
   * 获取多模态模型信息
   */
  async getMultiModalInfo(modelId: string) {
    return await LlamaModelManager.getInstance().getMultiModalInfo(modelId)
  }

  /**
   * 验证多模态文件关联
   */
  async validateMultiModalAssociations(modelId: string) {
    return await LlamaModelManager.getInstance().validateMultiModalAssociations(modelId)
  }

  /**
   * 检查模型是否支持特定模态
   */
  async supportsModality(modelId: string, modality: string) {
    return await LlamaModelManager.getInstance().supportsModality(modelId, modality as any)
  }

  /**
   * 获取模型支持的模态类型
   */
  async getSupportedModalities(modelId: string) {
    return await LlamaModelManager.getInstance().getSupportedModalities(modelId)
  }

  /**
   * 检查文件类型支持
   */
  async checkFileTypeSupport(modelId: string, fileExtension: string) {
    return await LlamaModelManager.getInstance().checkFileTypeSupport(modelId, fileExtension)
  }

  /**
   * 获取模型状态
   */
  async getModelStatus(modelId: string) {
    return await LlamaModelManager.getInstance().getModelStatus(modelId)
  }

  /**
   * 获取支持特定文件类型的模型
   */
  async getModelsByFileType(fileExtension: string) {
    return await LlamaModelManager.getInstance().getModelsByFileType(fileExtension)
  }

  /**
   * 获取能力限制
   */
  async getCapabilityLimitations(modelId: string, capabilityType: string) {
    return await LlamaModelManager.getInstance().getCapabilityLimitations(modelId, capabilityType as any)
  }

  /**
   * 设置当前活跃模型
   */
  async setCurrentModel(modelId: string) {
    return await LlamaModelManager.getInstance().setCurrentModel(modelId)
  }

  /**
   * 获取状态栏信息
   */
  getStatusBarInfo() {
    return LlamaModelManager.getInstance().getStatusBarInfo()
  }

  /**
   * 检查文件兼容性
   */
  async checkFileCompatibility(fileExtension: string) {
    return await LlamaModelManager.getInstance().checkFileCompatibility(fileExtension)
  }
  async listModels(): Promise<ModelSummary[]> {
    const internalModels = await LlamaModelManager.getInstance().listModels();
    
    // 映射后端 IModelSummary 到前端 ModelSummary
    return internalModels.map(model => {
      // 1. 映射质量等级
      const quality = model.performance?.quality as string;
      let mappedQuality: 'basic' | 'good' | 'excellent' | 'best' = 'good';

      if (quality === 'low') mappedQuality = 'basic';
      else if (quality === 'medium') mappedQuality = 'good';
      else if (quality === 'high') mappedQuality = 'excellent';
      else if (quality === 'ultra') mappedQuality = 'best';
      else if (['basic', 'good', 'excellent', 'best'].includes(quality)) {
        mappedQuality = quality as any;
      }

      // 2. 映射文件列表 (补齐 sizeText)
      const mappedFiles = (model.files || []).map(f => ({
        name: f.name,
        url: f.url,
        sizeText: (f as any).sizeText || (f as any).size || `${(f.sizeBytes / (1024 ** 3)).toFixed(2)}GB`,
        sizeBytes: f.sizeBytes,
        required: f.required
      }));

      // 3. 构建最终对象
      const summary: ModelSummary = {
        id: model.id,
        name: model.name,
        description: model.description || '',
        company: model.company || '',
        parameterSize: model.parameterSize || '',
        totalSizeText: model.totalSizeText || '',
        totalSizeBytes: model.totalSizeBytes,
        minVramGB: model.minVramGB,
        recommendedVramGB: model.recommendedVramGB,
        vramRequiredGB: model.vramRequiredGB,
        gpuAccelerated: model.gpuAccelerated,
        performance: {
          speed: model.performance.speed as any,
          quality: mappedQuality
        },
        capabilities: model.capabilities as any[],
        tags: model.tags,
        files: mappedFiles,
        isDownloaded: !!model.isDownloaded,
        isRecommended: !!model.isRecommended
      };

      return summary;
    });
  }

  async checkModelsStatus() {
    return await LlamaModelManager.getInstance().checkModelsStatus()
  }

/**
 * 备份原有逻辑以防万一 (临时)
...
   */
  _old_listModels(): ModelSummary[] {
    // 显式传递当前语言参数，确保加载正确的语言配置
    const currentLanguage = this.getCurrentLanguage()
    const summaries: ModelSummary[] = []
    
    // 获取原始模型配置
    const models = ModelConfigService.getInstance().loadModelConfig(currentLanguage)
    const platform = configService.getValue<'llama.cpp' | 'ollama'>('AI_PLATFORM') || 'llama.cpp'
    
    for (const model of (models || [])) {
      // 映射质量等级以满足 ModelSummary 类型
      const quality = model.performance?.quality as string
      let mappedQuality: 'basic' | 'good' | 'excellent' | 'best' = 'good'

      if (quality === 'low') mappedQuality = 'basic'
      else if (quality === 'medium') mappedQuality = 'good'
      else if (quality === 'high') mappedQuality = 'excellent'
      else if (quality === 'ultra') mappedQuality = 'best'
      else if (['basic', 'good', 'excellent', 'best'].includes(quality)) mappedQuality = quality as any

      // 计算显存需求
      const totalSizeBytes = model.totalSizeBytes || (model.files || []).reduce((acc, f) => acc + (f.required ? f.sizeBytes : 0), 0)
      const vramRequiredGB = model.vramRequiredGB !== undefined
        ? model.vramRequiredGB
        : Math.round((totalSizeBytes / 1024 ** 3) * 100) / 100

      summaries.push({
        id: model.id,
        name: model.name,
        description: model.description || '',
        company: model.company || '',
        parameterSize: model.parameterSize || '',
        totalSizeText: model.totalSize || '',
        totalSizeBytes: totalSizeBytes,
        minVramGB: model.hardwareRequirements?.minMemoryGB ?? model.performance?.minMemoryGB ?? 0,
        recommendedVramGB: model.hardwareRequirements?.recommendedMemoryGB ?? model.performance?.recommendedMemoryGB ?? 0,
        gpuAccelerated: model.hardwareRequirements?.gpuAccelerated ?? true,
        performance: {
          speed: (model.performance?.speed as any) || 'medium',
          quality: mappedQuality
        },
        capabilities: (model.capabilities || []).map(c => c.type),
        tags: model.tags || [],
        files: (model.files || []).map(f => ({
          name: f.name,
          url: f.url,
          sizeText: f.size,
          sizeBytes: f.sizeBytes,
          required: f.required
        })),
        vramRequiredGB: vramRequiredGB
      })
    }

    return summaries.sort((a, b) => {
      // 按照显存需求从低到高排序
      if (a.vramRequiredGB !== b.vramRequiredGB) {
        return a.vramRequiredGB - b.vramRequiredGB
      }

      // 如果显存需求相同，按照内存需求排序
      if (a.minVramGB !== b.minVramGB) {
        return a.minVramGB - b.minVramGB
      }

      // 按照推荐顺序排序
      const recommendedOrder = [
        'qwen3-0.6b-mlx-4bit',
        'gemma-3-1b-q4_0',
        'qwen3-4b',
        'qwen2.5-vl-7b-q2_k',
        'gemma-3-4b-q4_0-mmproj',
        'Qwen3VL-4B-Instruct-Q8_0',
        'qwen2.5-omni-7b-q4_k_m',
        'gemma-3-12b-q4_0-mmproj',
        'qwen2.5-omni-7b-q8_0'
      ]

      const indexA = recommendedOrder.indexOf(a.id)
      const indexB = recommendedOrder.indexOf(b.id)

      if (indexA !== -1 && indexB !== -1) {
        return indexA - indexB
      }
      if (indexA !== -1) return -1
      if (indexB !== -1) return 1

      return 0
    })
  }

  /**
   * 获取当前语言设置
   */
  private getCurrentLanguage(): string {
    try {
      // 优先从配置服务获取语言设置
      const configLanguage = configService.getValue<string>('DEFAULT_LANGUAGE')
      if (configLanguage) {
        return configLanguage
      }

      // 回退到默认语言
      return 'zh-CN'
    } catch (error) {
      logger.warn(LogCategory.MODEL_SERVICE, '获取当前语言设置失败，使用默认语言', error)
      return 'zh-CN'
    }
  }

  private async detectGPUType(gpuModel?: string): Promise<GPUType> {
    if (!gpuModel) return 'none'

    const dedicatedKeywords = ['nvidia', 'geforce', 'radeon', 'rtx', 'gtx', 'amd']
    const integratedKeywords = ['intel', 'iris', 'hd graphics', 'uhd graphics', 'xe graphics']

    const lowerModel = gpuModel.toLowerCase()

    if (dedicatedKeywords.some(keyword => lowerModel.includes(keyword))) {
      return 'dedicated'
    }
    if (integratedKeywords.some(keyword => lowerModel.includes(keyword))) {
      return 'integrated'
    }

    return 'none'
  }

  async getHardwareInfo(): Promise<HardwareInfo> {
    logger.debug(LogCategory.MODEL_SERVICE, '[HardwareInfo] 从缓存配置获取硬件信息')
    const config = ConfigOrchestrator.getInstance();
    
    const cpuInfo = config.getValue<any>('HARDWARE_CPU_INFO');
    const memInfo = config.getValue<any>('HARDWARE_MEMORY_INFO');
    const gpuInfos = config.getValue<any[]>('HARDWARE_GPU_INFO') || [];
    const storageInfo = config.getValue<any>('HARDWARE_STORAGE_INFO');

    // 适配现有的 HardwareInfo 接口结构
    const primaryGpu = gpuInfos.length > 0 ? gpuInfos[0] : null;
    const totalMemGB = memInfo ? Math.round(memInfo.total / 1024) : Math.round(os.totalmem() / 1024 ** 3);
    const freeMemGB = memInfo ? Math.round(memInfo.available / 1024) : Math.round(os.freemem() / 1024 ** 3);

    const hardwareInfo = {
      osPlatform: os.platform(),
      osArch: os.arch(),
      totalMemGB,
      freeMemGB,
      hasGPU: gpuInfos.length > 0,
      gpuModel: primaryGpu?.name,
      vramGB: primaryGpu?.memory ? Math.round(primaryGpu.memory / 1024) : undefined,
      vramSource: 'default' as const,
      gpuType: primaryGpu ? (this as any).quickDetectGPUType(primaryGpu.name) : 'none',
      vramDetectionTimeMs: 0,
      storageFreeGB: storageInfo ? Math.round(storageInfo.available / 1024) : undefined
    }

    logger.debug(LogCategory.MODEL_SERVICE, '[HardwareInfo] 硬件信息(从配置)读取完成:', hardwareInfo)
    return hardwareInfo
  }

  private quickDetectGPUType(gpuModel?: string): GPUType {
    if (!gpuModel) return 'none'
    const lowerModel = gpuModel.toLowerCase()
    const dedicatedKeywords = ['nvidia', 'geforce', 'radeon', 'rtx', 'gtx', 'amd']
    const integratedKeywords = ['intel', 'iris', 'hd graphics', 'uhd graphics', 'xe graphics']
    if (dedicatedKeywords.some(keyword => lowerModel.includes(keyword))) return 'dedicated'
    if (integratedKeywords.some(keyword => lowerModel.includes(keyword))) return 'integrated'
    return 'none'
  }

  private getModelBaseDir(): string {
    try {
      const configuredPath = configService.getValue<string>('MODEL_STORAGE_PATH')
      if (configuredPath && configuredPath.trim().length > 0) {
        return path.resolve(configuredPath.trim())
      }
    } catch (error) {
      logger.warn(LogCategory.MODEL_SERVICE, '读取模型存储路径失败，将使用默认目录', error)
    }
    return path.join(app.getPath('userData'), 'models')
  }

  private ensureModelDir(): string {
    const modelsDir = this.getModelBaseDir()
    try {
      fs.mkdirSync(modelsDir, { recursive: true })
    } catch (err) {
      logger.error(LogCategory.MODEL_SERVICE, '创建模型目录失败:', err)
    }
    return modelsDir
  }


  /**
   * 发送模型加载状态事件
   * @param event 事件类型
   * @param modelId 模型ID
   * @param payload 附加数据
   */
  private emitModelLoadingEvent(event: ModelLoadingEvent, modelId: string, payload?: unknown) {
    logger.debug(LogCategory.MODEL_SERVICE, `[ModelService] 发送模型加载事件: ${event}`, {
      modelId,
      payload
    })

    // 安全验证
    if (!Object.values(ModelLoadingEvent).includes(event)) {
      logger.error(LogCategory.MODEL_SERVICE, '[ModelService] 无效的模型加载事件类型:', event)
      return
    }

    // 验证模型ID格式
    if (!modelId || typeof modelId !== 'string' || !/^[a-z0-9-_.]+$/.test(modelId)) {
      logger.error(LogCategory.MODEL_SERVICE, '[ModelService] 无效的模型ID:', modelId)
      return
    }

    // 验证payload内容
    if (payload && typeof payload !== 'object') {
      logger.error(LogCategory.MODEL_SERVICE, '[ModelService] 无效的payload类型:', typeof payload)
      return
    }

    // 发送给特定webContents
    const task = [...this.downloads.values()].find(d => d.model.id === modelId)
    const wc = task?.webContentsId ? webContents.fromId(task.webContentsId) : undefined

    if (wc) {
      try {
        // 使用安全的IPC通道发送
        const safePayload = this.sanitizePayload(payload)
        wc.send(this.getIpcChannelForEvent(event), { modelId, ...(safePayload as object) })
      } catch (err) {
        logger.error(
          LogCategory.MODEL_SERVICE,
          `[ModelService] 发送事件${event}到webContents失败:`,
          err
        )
      }
    } else {
      // 广播给所有窗口
      BrowserWindow.getAllWindows().forEach(win => {
        try {
          const safePayload = this.sanitizePayload(payload)
          win.webContents.send(this.getIpcChannelForEvent(event), {
            modelId,
            ...(safePayload as object)
          })
        } catch (err) {
          logger.error(LogCategory.MODEL_SERVICE, `[ModelService] 发送事件${event}到窗口失败:`, err)
        }
      })
    }

    // 本地触发事件
    this.emit(event, { modelId, ...(this.sanitizePayload(payload) as object) })
  }

  private emitProgress(
    taskId: string,
    percent?: number,
    canceled?: boolean,
    status: 'downloading' | 'completed' | 'canceled' | 'error' | 'retrying' = 'downloading',
    extra?: Partial<DownloadProgressEvent>
  ) {
    const task = this.downloads.get(taskId)
    const wc = task?.webContentsId ? webContents.fromId(task.webContentsId) : undefined
    const payload: DownloadProgressEvent = {
      taskId,
      modelId: task?.model.id || extra?.modelId || '',
      fileName: extra?.fileName,
      receivedBytes: extra?.receivedBytes ?? task?.receivedBytes ?? 0,
      totalBytes: extra?.totalBytes ?? task?.totalBytes ?? 0,
      speedBps: extra?.speedBps,
      percent,
      status,
      destDir: task?.destDir,
      error: extra?.error
    }
    if (wc) {
      wc.send('model-download-progress', payload)
      if (status === 'completed') wc.send('model-download-complete', payload)
    } else {
      const all = BrowserWindow.getAllWindows()
      all.forEach(win => {
        win.webContents.send('model-download-progress', payload)
        if (status === 'completed') win.webContents.send('model-download-complete', payload)
      })
    }
  }

  /**
   * 获取事件对应的IPC通道
   */
  private getIpcChannelForEvent(event: ModelLoadingEvent): string {
    switch (event) {
      case ModelLoadingEvent.START:
        return ModelService.IPC_CHANNELS.LOADING_START
      case ModelLoadingEvent.COMPLETE:
        return ModelService.IPC_CHANNELS.LOADING_COMPLETE
      case ModelLoadingEvent.ERROR:
        return ModelService.IPC_CHANNELS.LOADING_ERROR
      default:
        throw new Error(`未知的事件类型: ${event}`)
    }
  }

  /**
   * 清理payload中的敏感数据
   */
  private sanitizePayload(payload?: unknown): unknown {
    if (!payload) return {}

    // 移除可能的敏感字段
    const { error, ...rest } = (payload as any) || {}

    // 确保错误信息是字符串
    const safeError = error ? String(error) : undefined

    return {
      ...rest,
      ...(safeError ? { error: safeError } : {})
    }
  }

  /**
   * 检查模型是否已下载完成
   * @param modelId 模型ID
   * @returns 是否已下载完成
   */
  async checkModelDownloadStatus(modelId: string) {
    return await ModelDownloadManager.getInstance().checkModelDownloadStatus(modelId)
  }

  /**
   * 获取已下载模型的目录路径
   * @param modelId 模型ID
   * @returns 模型目录路径，如果未下载则返回null
   */
  async getModelPath(modelId: string): Promise<string | null> {
    const status = await this.checkModelDownloadStatus(modelId)
    if (!status.isDownloaded) {
      return null
    }

    const model = ModelConfigService.getInstance()
      .loadModelConfig()
      .find(m => m.id === modelId)
    if (!model) return null

    return path.join(this.ensureModelDir(), model.id)
  }
  /**
   * 删除已下载的模型
   */
  async deleteModel(modelId: string): Promise<boolean> {
    const model = ModelConfigService.getInstance()
      .loadModelConfig()
      .find(m => m.id === modelId)
    if (!model) {
      throw new Error('模型不存在')
    }

    const dir = path.join(this.ensureModelDir(), model.id)
    if (!fs.existsSync(dir)) {
      return false
    }

    try {
      await fs.promises.rm(dir, { recursive: true, force: true })
      logger.info(LogCategory.MODEL_SERVICE, `模型已删除: ${modelId}`)
      return true
    } catch (error) {
      logger.error(LogCategory.MODEL_SERVICE, `删除模型失败: ${modelId}`, error)
      throw error
    }
  }
}

/**
 * 单例实例
 * 注意：由于可能的循环依赖，建议在方法内部使用 ModelService.getInstance()
 */
export const modelService = ModelService.getInstance();
