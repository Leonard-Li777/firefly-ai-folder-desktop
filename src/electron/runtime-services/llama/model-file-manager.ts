/**
 * Model File Manager - 模型文件管理器
 * 处理模型文件的下载、验证和管理
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { app } from 'electron';
import { platformAdapter } from '../system/platform-adapter';
import { filePermissionManager } from '../filesystem/file-permission-manager';
import { calculateFileFingerprint as calculateFileFingerprintCore } from '@yonuc/core-engine/utils/file-fingerprint';
import { logger, LogCategory } from '@yonuc/shared';
import {
  IFileValidationResult
} from '@yonuc/types/llama-server';
import { hardwareDetectionService } from '../system/hardware-detection-service';

/**
 * 模型文件信息接口
 */
export interface IModelFileInfo {
  /** 模型ID */
  modelId: string;
  /** 模型名称 */
  name: string;
  /** 文件名 */
  fileName: string;
  /** 文件类型 */
  fileType: 'main' | 'mmproj' | 'config';
  /** 本地路径 */
  localPath: string;
  /** 文件大小（字节） */
  size: number;
  /** SHA256哈希值 */
  hash?: string;
  /** 下载URL */
  downloadUrl?: string;
  /** 是否已安装 */
  installed: boolean;
  /** 最后验证时间 */
  lastValidated?: Date;
}

/**
 * 模型下载进度接口
 */
export interface IModelDownloadProgress {
  /** 模型ID */
  modelId: string;
  /** 文件名 */
  fileName: string;
  /** 已下载字节数 */
  downloaded: number;
  /** 总字节数 */
  total: number;
  /** 下载速度（字节/秒） */
  speed: number;
  /** 进度百分比 */
  percentage: number;
  /** 剩余时间（秒） */
  remainingTime: number;
  /** 状态 */
  status: 'downloading' | 'completed' | 'error' | 'paused';
  /** 错误信息 */
  error?: string;
}

/**
 * 模型管理统计接口
 */
export interface IModelManagementStats {
  /** 总模型数 */
  totalModels: number;
  /** 已安装模型数 */
  installedModels: number;
  /** 总文件数 */
  totalFiles: number;
  /** 已安装文件数 */
  installedFiles: number;
  /** 总磁盘使用量（字节） */
  totalDiskUsage: number;
  /** 可用磁盘空间（字节） */
  availableDiskSpace: number;
  /** 最后更新时间 */
  lastUpdated: Date;
}

/**
 * 模型文件管理器
 */
export class ModelFileManager {
  private static instance: ModelFileManager;
  private modelsPath: string;
  private configPath: string;
  private modelFiles: Map<string, IModelFileInfo[]> = new Map();
  private downloadProgress: Map<string, IModelDownloadProgress> = new Map();

  private constructor() {
    const extraResourcesPath = platformAdapter.getExtraResourcesPath();
    this.modelsPath = platformAdapter.normalizePath(path.join(extraResourcesPath, 'models'));
    this.configPath = platformAdapter.normalizePath(path.join(extraResourcesPath, 'configs', 'models.json'));
  }

  /**
   * 获取单例实例
   */
  static getInstance(): ModelFileManager {
    if (!ModelFileManager.instance) {
      ModelFileManager.instance = new ModelFileManager();
    }
    return ModelFileManager.instance;
  }

  /**
   * 初始化模型文件管理器
   */
  async initialize(): Promise<void> {
    try {
      // 确保模型目录存在
      await fs.mkdir(this.modelsPath, { recursive: true });
      
      // 加载模型配置
      await this.loadModelConfig();
      
      // 扫描已存在的模型文件
      await this.scanExistingModels();
      
      logger.info(LogCategory.MODEL_FILE_MANAGER, '模型文件管理器初始化完成');
    } catch (error) {
      logger.error(LogCategory.MODEL_FILE_MANAGER, '模型文件管理器初始化失败:', error);
      throw error;
    }
  }

  /**
   * 加载模型配置
   */
  private async loadModelConfig(): Promise<void> {
    try {
      const configData = await fs.readFile(this.configPath, 'utf8');
      const config = JSON.parse(configData);
      
      // 清空现有配置
      this.modelFiles.clear();
      
      // 加载模型配置
      for (const modelConfig of config.models) {
        const modelFiles: IModelFileInfo[] = [];
        
        // 主模型文件
        if (modelConfig.files && modelConfig.files.length > 0) {
          for (let i = 0; i < modelConfig.files.length; i++) {
            const fileName = modelConfig.files[i];
            const fileType = i === 0 ? 'main' : 
                           fileName.includes('mmproj') ? 'mmproj' : 'config';
            
            modelFiles.push({
              modelId: modelConfig.id,
              name: modelConfig.name,
              fileName,
              fileType,
              localPath: platformAdapter.normalizePath(path.join(this.modelsPath, fileName)),
              size: 0,
              hash: undefined,
              downloadUrl: undefined,
              installed: false
            });
          }
        }
        
        this.modelFiles.set(modelConfig.id, modelFiles);
      }
      
    } catch (error) {
      logger.warn(LogCategory.MODEL_FILE_MANAGER, '加载模型配置失败，使用默认配置:', error);
      await this.createDefaultConfig();
    }
  }

  /**
   * 创建默认模型配置
   */
  private async createDefaultConfig(): Promise<void> {
    const defaultConfig = {
      version: '1.0.0',
      lastUpdated: new Date().toISOString(),
      models: [
        {
          id: 'gemma-3-1b',
          name: 'Gemma 3 (1B)',
          files: ['gemma-3-1b-q4_k_m.gguf'],
          capabilities: ['text'],
          requirements: {
            minMemory: 2048,
            recommendedThreads: 4
          }
        },
        {
          id: 'gemma-3-4b',
          name: 'Gemma 3 (4B)',
          files: ['gemma-3-4b-q4_k_m.gguf', 'gemma-3-4b-mmproj-q4_0.gguf'],
          capabilities: ['text', 'vision'],
          requirements: {
            minMemory: 8192,
            minVRAM: 4096,
            recommendedThreads: 6
          }
        },
        {
          id: 'qwen2.5-omni-7b-q4',
          name: 'Qwen2.5-Omni (7B Q4)',
          files: ['qwen2.5-omni-7b-q4_k_m.gguf', 'qwen2.5-omni-7b-mmproj-q4_0.gguf'],
          capabilities: ['text', 'vision', 'audio', 'video'],
          requirements: {
            minMemory: 12288,
            minVRAM: 6144,
            recommendedThreads: 8
          }
        }
      ]
    };

    // 确保配置目录存在
    const configDir = path.dirname(this.configPath);
    await fs.mkdir(configDir, { recursive: true });
    
    // 写入默认配置
    await fs.writeFile(this.configPath, JSON.stringify(defaultConfig, null, 2), 'utf8');
    
    // 重新加载配置
    await this.loadModelConfig();
  }

  /**
   * 扫描已存在的模型文件
   */
  private async scanExistingModels(): Promise<void> {
    try {
      const files = await fs.readdir(this.modelsPath);
      
      for (const [modelId, modelFiles] of this.modelFiles.entries()) {
        for (const modelFile of modelFiles) {
          if (files.includes(modelFile.fileName)) {
            try {
              const stats = await fs.stat(modelFile.localPath);
              modelFile.size = stats.size;
              modelFile.installed = true;
              modelFile.lastValidated = new Date();
              
              // 计算文件哈希（可选，对大文件可能很慢）
              // modelFile.hash = await this.calculateFileFingerprint(modelFile.localPath);
              
            } catch (error) {
              logger.warn(LogCategory.MODEL_FILE_MANAGER, `扫描模型文件失败 ${modelFile.fileName}:`, error);
            }
          }
        }
      }
      
    } catch (error) {
      logger.warn(LogCategory.MODEL_FILE_MANAGER, '扫描模型目录失败:', error);
    }
  }

  /**
   * 获取所有模型信息
   */
  getModels(): Map<string, IModelFileInfo[]> {
    return new Map(this.modelFiles);
  }

  /**
   * 获取特定模型的文件信息
   */
  getModelFiles(modelId: string): IModelFileInfo[] | undefined {
    return this.modelFiles.get(modelId);
  }

  /**
   * 获取已安装的模型列表
   */
  getInstalledModels(): string[] {
    const installedModels: string[] = [];
    
    for (const [modelId, modelFiles] of this.modelFiles.entries()) {
      const allFilesInstalled = modelFiles.every(file => file.installed);
      if (allFilesInstalled && modelFiles.length > 0) {
        installedModels.push(modelId);
      }
    }
    
    return installedModels;
  }

  /**
   * 检查模型是否完整安装
   */
  isModelInstalled(modelId: string): boolean {
    const modelFiles = this.modelFiles.get(modelId);
    if (!modelFiles || modelFiles.length === 0) {
      return false;
    }
    
    return modelFiles.every(file => file.installed);
  }

  /**
   * 验证模型文件完整性
   */
  async validateModelFiles(modelId: string): Promise<Map<string, IFileValidationResult>> {
    const results = new Map<string, IFileValidationResult>();
    const modelFiles = this.modelFiles.get(modelId);
    
    if (!modelFiles) {
      throw new Error(`未找到模型: ${modelId}`);
    }
    
    for (const modelFile of modelFiles) {
      try {
        const validation = await filePermissionManager.validateBinaryFile(
          modelFile.localPath,
          modelFile.hash
        );
        
        results.set(modelFile.fileName, validation);
        
        // 更新文件信息
        if (validation.exists) {
          modelFile.installed = true;
          modelFile.size = validation.size;
          modelFile.lastValidated = new Date();
        } else {
          modelFile.installed = false;
        }
        
      } catch (error) {
        results.set(modelFile.fileName, {
          isValid: false,
          exists: false,
          executable: false,
          size: 0,
          type: 'unknown',
          errors: [`验证失败: ${error}`],
          warnings: []
        });
      }
    }
    
    return results;
  }

  /**
   * 计算文件哈希
   * 使用统一的 core-engine 实现 (HMAC-SHA256 采样算法)
   */
  async calculateFileFingerprint(filePath: string): Promise<string> {
    return calculateFileFingerprintCore(filePath);
  }

  /**
   * 获取模型目录路径
   */
  getModelsPath(): string {
    return this.modelsPath;
  }

  /**
   * 获取特定模型文件的完整路径
   */
  getModelFilePath(modelId: string, fileName: string): string | undefined {
    const modelFiles = this.modelFiles.get(modelId);
    if (!modelFiles) {
      return undefined;
    }
    
    const modelFile = modelFiles.find(file => file.fileName === fileName);
    return modelFile?.localPath;
  }

  /**
   * 添加新模型配置
   */
  async addModel(modelConfig: {
    id: string;
    name: string;
    files: string[];
    capabilities?: string[];
    requirements?: any;
  }): Promise<void> {
    // 检查模型是否已存在
    if (this.modelFiles.has(modelConfig.id)) {
      throw new Error(`模型已存在: ${modelConfig.id}`);
    }
    
    // 创建模型文件信息
    const modelFiles: IModelFileInfo[] = [];
    
    for (let i = 0; i < modelConfig.files.length; i++) {
      const fileName = modelConfig.files[i];
      const fileType = i === 0 ? 'main' : 
                     fileName.includes('mmproj') ? 'mmproj' : 'config';
      
      modelFiles.push({
        modelId: modelConfig.id,
        name: modelConfig.name,
        fileName,
        fileType,
        localPath: platformAdapter.normalizePath(path.join(this.modelsPath, fileName)),
        size: 0,
        hash: undefined,
        downloadUrl: undefined,
        installed: false
      });
    }
    
    this.modelFiles.set(modelConfig.id, modelFiles);
    
    // 更新配置文件
    await this.saveModelConfig();
  }

  /**
   * 移除模型配置
   */
  async removeModel(modelId: string, deleteFiles: boolean = false): Promise<void> {
    const modelFiles = this.modelFiles.get(modelId);
    if (!modelFiles) {
      throw new Error(`未找到模型: ${modelId}`);
    }
    
    // 如果需要删除文件
    if (deleteFiles) {
      for (const modelFile of modelFiles) {
        try {
          if (modelFile.installed) {
            await fs.unlink(modelFile.localPath);
            logger.info(LogCategory.MODEL_FILE_MANAGER, `已删除模型文件: ${modelFile.fileName}`);
          }
        } catch (error) {
          logger.warn(LogCategory.MODEL_FILE_MANAGER, `删除模型文件失败 ${modelFile.fileName}:`, error);
        }
      }
    }
    
    // 从配置中移除
    this.modelFiles.delete(modelId);
    
    // 更新配置文件
    await this.saveModelConfig();
  }

  /**
   * 保存模型配置
   */
  private async saveModelConfig(): Promise<void> {
    const config = {
      version: '1.0.0',
      lastUpdated: new Date().toISOString(),
      models: Array.from(this.modelFiles.entries()).map(([modelId, files]) => {
        const firstFile = files[0];
        return {
          id: modelId,
          name: firstFile.name,
          files: files.map(file => file.fileName),
          installed: files.every(file => file.installed)
        };
      })
    };
    
    await fs.writeFile(this.configPath, JSON.stringify(config, null, 2), 'utf8');
  }

  /**
   * 获取管理统计信息
   */
  async getManagementStats(): Promise<IModelManagementStats> {
    let totalFiles = 0;
    let installedFiles = 0;
    let totalDiskUsage = 0;
    
    for (const modelFiles of this.modelFiles.values()) {
      totalFiles += modelFiles.length;
      
      for (const file of modelFiles) {
        if (file.installed) {
          installedFiles++;
          totalDiskUsage += file.size;
        }
      }
    }
    
    // 获取可用磁盘空间
    let availableDiskSpace = 0;
    try {
      const storage = await hardwareDetectionService.detectStorage(this.modelsPath);
      availableDiskSpace = storage.available * 1024 * 1024; // MB 转换为字节
    } catch (error) {
      logger.warn(LogCategory.MODEL_FILE_MANAGER, '获取磁盘空间失败:', error);
      // 降级方案
      availableDiskSpace = 10 * 1024 * 1024 * 1024; // 10GB
    }
    
    return {
      totalModels: this.modelFiles.size,
      installedModels: this.getInstalledModels().length,
      totalFiles,
      installedFiles,
      totalDiskUsage,
      availableDiskSpace,
      lastUpdated: new Date()
    };
  }

  /**
   * 清理未使用的模型文件
   */
  async cleanupUnusedFiles(): Promise<{
    cleaned: string[];
    errors: string[];
    spaceSaved: number;
  }> {
    const cleaned: string[] = [];
    const errors: string[] = [];
    let spaceSaved = 0;
    
    try {
      const files = await fs.readdir(this.modelsPath);
      const knownFiles = new Set<string>();
      
      // 收集所有已知的模型文件名
      for (const modelFiles of this.modelFiles.values()) {
        for (const file of modelFiles) {
          knownFiles.add(file.fileName);
        }
      }
      
      // 查找未知文件
      for (const fileName of files) {
        if (!knownFiles.has(fileName) && fileName !== 'README.md') {
          const filePath = path.join(this.modelsPath, fileName);
          
          try {
            const stats = await fs.stat(filePath);
            if (stats.isFile()) {
              spaceSaved += stats.size;
              await fs.unlink(filePath);
              cleaned.push(fileName);
              logger.info(LogCategory.MODEL_FILE_MANAGER, `已清理未使用的文件: ${fileName}`);
            }
          } catch (error) {
            errors.push(`清理文件失败 ${fileName}: ${error}`);
          }
        }
      }
      
    } catch (error) {
      errors.push(`清理过程失败: ${error}`);
    }
    
    return { cleaned, errors, spaceSaved };
  }

  /**
   * 导出模型配置
   */
  async exportConfig(): Promise<string> {
    const config = {
      version: '1.0.0',
      exportedAt: new Date().toISOString(),
      platform: platformAdapter.getPlatformConfig(),
      models: Array.from(this.modelFiles.entries()).map(([modelId, files]) => ({
        id: modelId,
        name: files[0].name,
        files: files.map(file => ({
          fileName: file.fileName,
          fileType: file.fileType,
          size: file.size,
          hash: file.hash,
          installed: file.installed,
          lastValidated: file.lastValidated
        }))
      }))
    };
    
    return JSON.stringify(config, null, 2);
  }

  /**
   * 生成模型管理报告
   */
  async generateReport(): Promise<string> {
    const stats = await this.getManagementStats();
    const installedModels = this.getInstalledModels();
    
    const report = [
      '# 模型文件管理报告',
      '',
      '## 统计信息',
      `- 总模型数: ${stats.totalModels}`,
      `- 已安装模型数: ${stats.installedModels}`,
      `- 总文件数: ${stats.totalFiles}`,
      `- 已安装文件数: ${stats.installedFiles}`,
      `- 磁盘使用量: ${(stats.totalDiskUsage / 1024 / 1024 / 1024).toFixed(2)} GB`,
      `- 可用磁盘空间: ${(stats.availableDiskSpace / 1024 / 1024 / 1024).toFixed(2)} GB`,
      '',
      '## 已安装模型',
      ...installedModels.map(modelId => {
        const files = this.modelFiles.get(modelId) || [];
        const totalSize = files.reduce((sum, file) => sum + file.size, 0);
        return `- ${files[0]?.name || modelId}: ${(totalSize / 1024 / 1024).toFixed(2)} MB`;
      }),
      '',
      '## 模型详情'
    ];
    
    for (const [modelId, files] of this.modelFiles.entries()) {
      report.push(`### ${files[0].name} (${modelId})`);
      report.push(`- 状态: ${this.isModelInstalled(modelId) ? '✅ 已安装' : '❌ 未安装'}`);
      report.push('- 文件:');
      
      for (const file of files) {
        const status = file.installed ? '✅' : '❌';
        const size = file.size > 0 ? ` (${(file.size / 1024 / 1024).toFixed(2)} MB)` : '';
        report.push(`  - ${status} ${file.fileName}${size}`);
      }
      
      report.push('');
    }
    
    return report.join('\n');
  }
}

/**
 * 导出单例实例
 */
export const modelFileManager = ModelFileManager.getInstance();