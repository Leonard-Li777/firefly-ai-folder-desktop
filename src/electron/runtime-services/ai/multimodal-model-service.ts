/**
 * Multimodal Model Service - 处理多模态模型的特殊需求
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { EventEmitter } from 'events';
import {
  ILlamaModelConfig,
  IModelFile,
  IModelValidationResult,
  TModelCapabilityType
} from '@yonuc/types';
import { getLlamaModelConfig } from '../../model';
import { t } from '@app/languages';

/**
 * 多模态文件组合接口
 */
export interface IMultiModalFileGroup {
  /** 主模型文件 */
  mainModel: IModelFile;
  /** 多模态投影文件 */
  mmproj?: IModelFile;
  /** 分词器文件 */
  tokenizer?: IModelFile;
  /** 配置文件 */
  config?: IModelFile;
  /** 其他辅助文件 */
  auxiliary: IModelFile[];
}

/**
 * 多模态模型信息接口
 */
export interface IMultiModalModelInfo {
  /** 模型ID */
  modelId: string;
  /** 是否为多模态模型 */
  isMultiModal: boolean;
  /** 文件组合 */
  fileGroups: IMultiModalFileGroup;
  /** 支持的模态类型 */
  supportedModalities: TModelCapabilityType[];
  /** 模型架构信息 */
  architecture: {
    /** 主模型架构 */
    mainArchitecture: string;
    /** 视觉编码器架构 */
    visionEncoder?: string;
    /** 音频编码器架构 */
    audioEncoder?: string;
  };
  /** 依赖关系 */
  dependencies: {
    /** 必需的文件 */
    required: string[];
    /** 可选的文件 */
    optional: string[];
  };
}

/**
 * 文件关联验证结果
 */
export interface IFileAssociationResult {
  /** 是否有效 */
  isValid: boolean;
  /** 主模型文件状态 */
  mainModelStatus: {
    exists: boolean;
    valid: boolean;
    error?: string;
  };
  /** mmproj文件状态 */
  mmprojStatus?: {
    exists: boolean;
    valid: boolean;
    compatible: boolean;
    error?: string;
  };
  /** 其他文件状态 */
  auxiliaryStatus: {
    [fileName: string]: {
      exists: boolean;
      valid: boolean;
      error?: string;
    };
  };
  /** 兼容性检查结果 */
  compatibility: {
    /** 文件版本是否兼容 */
    versionCompatible: boolean;
    /** 架构是否匹配 */
    architectureMatch: boolean;
    /** 参数规模是否匹配 */
    parameterSizeMatch: boolean;
  };
  /** 错误信息 */
  errors: string[];
  /** 警告信息 */
  warnings: string[];
}

/**
 * 多模态模型服务
 */
export class MultiModalModelService extends EventEmitter {
  private static instance: MultiModalModelService;
  private modelInfoCache = new Map<string, IMultiModalModelInfo>();

  public static getInstance(): MultiModalModelService {
    if (!MultiModalModelService.instance) {
      MultiModalModelService.instance = new MultiModalModelService();
    }
    return MultiModalModelService.instance;
  }

  private constructor() {
    super();
  }
  async analyzeMultiModalModel(modelId: string): Promise<IMultiModalModelInfo> {
    // 检查缓存
    const cached = this.modelInfoCache.get(modelId);
    if (cached) return cached;

    const modelConfig = getLlamaModelConfig(modelId);
    if (!modelConfig) {
      throw new Error(t('模型配置不存在: {modelId}', { modelId }));
    }

    const info = await this.buildMultiModalInfo(modelConfig);

    // 缓存结果
    this.modelInfoCache.set(modelId, info);

    return info;
  }

  /**
   * 验证多模态文件关联
   */
  async validateFileAssociations(modelId: string, modelDir: string): Promise<IFileAssociationResult> {
    const info = await this.analyzeMultiModalModel(modelId);
    const result: IFileAssociationResult = {
      isValid: true,
      mainModelStatus: { exists: false, valid: false },
      auxiliaryStatus: {},
      compatibility: {
        versionCompatible: true,
        architectureMatch: true,
        parameterSizeMatch: true
      },
      errors: [],
      warnings: []
    };

    // 验证主模型文件
    const mainModelPath = path.join(modelDir, info.fileGroups.mainModel.name);
    try {
      const stats = await fs.stat(mainModelPath);
      result.mainModelStatus.exists = true;

      // 验证文件大小
      const expectedSize = info.fileGroups.mainModel.sizeBytes;
      const tolerance = expectedSize * 0.05; // 5%误差

      if (Math.abs(stats.size - expectedSize) <= tolerance) {
        result.mainModelStatus.valid = true;
      } else {
        result.mainModelStatus.valid = false;
        result.mainModelStatus.error = t('大小不匹配，期望: {}, 实际: {}', [expectedSize, stats.size]);
        result.errors.push(result.mainModelStatus.error);
      }
    } catch (error) {
      result.mainModelStatus.exists = false;
      const errorMessage = error instanceof Error ? error.message : String(error);
      result.mainModelStatus.error = t('主模型文件不存在: {error}', [errorMessage]);
      result.errors.push(result.mainModelStatus.error);
      result.isValid = false;
    }

    // 验证mmproj文件（如果存在）
    if (info.fileGroups.mmproj) {
      const mmprojPath = path.join(modelDir, info.fileGroups.mmproj.name);
      result.mmprojStatus = { exists: false, valid: false, compatible: false };

      try {
        const stats = await fs.stat(mmprojPath);
        result.mmprojStatus.exists = true;

        // 验证文件大小
        const expectedSize = info.fileGroups.mmproj.sizeBytes;
        const tolerance = expectedSize * 0.05;

        if (Math.abs(stats.size - expectedSize) <= tolerance) {
          result.mmprojStatus.valid = true;

          // 检查兼容性
          const compatibility = await this.checkMmprojCompatibility(
            mainModelPath,
            mmprojPath,
            info
          );
          result.mmprojStatus.compatible = compatibility.compatible;

          if (!compatibility.compatible) {
            result.mmprojStatus.error = compatibility.reason;
            result.warnings.push(t('mmproj兼容性警告: {compatibility.reason}', [compatibility.reason]));
          }
        } else {
          result.mmprojStatus.valid = false;
          result.mmprojStatus.error = t('mmproj文件大小不匹配');
          result.warnings.push(result.mmprojStatus.error);
        }
      } catch (error) {
        result.mmprojStatus.exists = false;
        const errorMessage = error instanceof Error ? error.message : String(error);
        result.mmprojStatus.error = t('mmproj文件不存在: {error}', [errorMessage]);
        result.warnings.push(result.mmprojStatus.error);
      }
    }

    // 验证辅助文件
    for (const auxFile of info.fileGroups.auxiliary) {
      const auxPath = path.join(modelDir, auxFile.name);
      const auxStatus = { exists: false, valid: false, error: undefined as string | undefined };

      try {
        const stats = await fs.stat(auxPath);
        auxStatus.exists = true;

        const expectedSize = auxFile.sizeBytes;
        const tolerance = expectedSize * 0.05;

        if (Math.abs(stats.size - expectedSize) <= tolerance) {
          auxStatus.valid = true;
        } else {
          auxStatus.valid = false;
          auxStatus.error = t('文件大小不匹配');
          result.warnings.push(t('辅助文件 {} 大小不匹配', [auxFile.name]));
        }
      } catch (error) {
        auxStatus.exists = false;
        const errorMessage = error instanceof Error ? error.message : String(error);
        auxStatus.error = t('文件不存在: {error}', [errorMessage])

        if (auxFile.required) {
          result.errors.push(t('必需的辅助文件不存在:  {}', [auxFile.name]))
          result.isValid = false;
        } else {
          result.warnings.push(t('可选的辅助文件不存在: {}', [auxFile.name]))
        }
      }

      result.auxiliaryStatus[auxFile.name] = auxStatus;
    }

    return result;
  }

  /**
   * 获取模型的下载优先级
   * 多模态模型需要按特定顺序下载文件
   */
  getDownloadPriority(modelId: string): IModelFile[] {
    const modelConfig = getLlamaModelConfig(modelId);
    if (!modelConfig) return [];

    const prioritizedFiles: IModelFile[] = [];

    // 1. 首先下载主模型文件
    const mainModelFiles = modelConfig.files.filter(f => f.type === 'model' && f.required);
    prioritizedFiles.push(...mainModelFiles);

    // 2. 然后下载mmproj文件
    const mmprojFiles = modelConfig.files.filter(f => f.type === 'mmproj' && f.required);
    prioritizedFiles.push(...mmprojFiles);

    // 3. 最后下载其他辅助文件
    const otherFiles = modelConfig.files.filter(f =>
      f.type !== 'model' && f.type !== 'mmproj' && f.required
    );
    prioritizedFiles.push(...otherFiles);

    // 4. 可选文件放在最后
    const optionalFiles = modelConfig.files.filter(f => !f.required);
    prioritizedFiles.push(...optionalFiles);

    return prioritizedFiles;
  }

  /**
   * 检查模型完整性（多模态特定）
   */
  async checkMultiModalIntegrity(modelId: string, modelDir: string): Promise<IModelValidationResult> {
    const info = await this.analyzeMultiModalModel(modelId);
    const associationResult = await this.validateFileAssociations(modelId, modelDir);

    const validationResult: IModelValidationResult = {
      isValid: associationResult.isValid,
      modelId,
      validatedFiles: [],
      missingFiles: [],
      corruptedFiles: [],
      errors: [...associationResult.errors],
      warnings: [...associationResult.warnings]
    };

    // 构建验证文件列表
    const allFiles = [
      info.fileGroups.mainModel,
      ...(info.fileGroups.mmproj ? [info.fileGroups.mmproj] : []),
      ...info.fileGroups.auxiliary
    ];

    for (const file of allFiles) {
      const filePath = path.join(modelDir, file.name);

      try {
        const stats = await fs.stat(filePath);
        const sizeMatch = Math.abs(stats.size - file.sizeBytes) <= (file.sizeBytes * 0.05);

        validationResult.validatedFiles.push({
          fileName: file.name,
          exists: true,
          sizeMatch,
          error: !sizeMatch ? t('文件大小不匹配') : undefined
        });

        if (!sizeMatch) {
          validationResult.corruptedFiles.push(file.name);
        }
      } catch {
        validationResult.validatedFiles.push({
          fileName: file.name,
          exists: false,
          sizeMatch: false,
          error: t('文件不存在')
        });

        if (file.required) {
          validationResult.missingFiles.push(file.name);
        }
      }
    }

    // 如果有缺失或损坏的必需文件，标记为无效
    if (validationResult.missingFiles.length > 0 || validationResult.corruptedFiles.length > 0) {
      validationResult.isValid = false;
    }

    // 添加多模态特定的验证
    if (info.isMultiModal && info.fileGroups.mmproj) {
      if (!associationResult.mmprojStatus?.exists) {
        validationResult.errors.push(t('多模态模型缺少mmproj文件'));
        validationResult.isValid = false;
      } else if (!associationResult.mmprojStatus.compatible) {
        validationResult.warnings.push(t('mmproj文件可能与主模型不兼容'));
      }
    }

    return validationResult;
  }

  /**
   * 获取模型支持的模态类型
   */
  getSupportedModalities(modelId: string): TModelCapabilityType[] {
    const modelConfig = getLlamaModelConfig(modelId);
    if (!modelConfig) return [];

    return modelConfig.capabilities.map(cap => cap.type);
  }

  /**
   * 检查模型是否支持特定模态
   */
  supportsModality(modelId: string, modality: TModelCapabilityType): boolean {
    const supportedModalities = this.getSupportedModalities(modelId);
    return supportedModalities.includes(modality);
  }

  /**
   * 清理缓存
   */
  clearCache(): void {
    this.modelInfoCache.clear();
  }

  /**
   * 构建多模态模型信息
   */
  private async buildMultiModalInfo(modelConfig: ILlamaModelConfig): Promise<IMultiModalModelInfo> {
    const fileGroups: IMultiModalFileGroup = {
      mainModel: modelConfig.files.find(f => f.type === 'model')!,
      mmproj: modelConfig.files.find(f => f.type === 'mmproj'),
      tokenizer: modelConfig.files.find(f => f.type === 'tokenizer'),
      config: modelConfig.files.find(f => f.type === 'config'),
      auxiliary: modelConfig.files.filter(f =>
        f.type !== 'model' && f.type !== 'mmproj' && f.type !== 'tokenizer' && f.type !== 'config'
      )
    };

    const supportedModalities = modelConfig.capabilities.map(cap => cap.type);

    // 推断架构信息
    const architecture = this.inferArchitecture(modelConfig);

    // 构建依赖关系
    const dependencies = {
      required: modelConfig.files.filter(f => f.required).map(f => f.name),
      optional: modelConfig.files.filter(f => !f.required).map(f => f.name)
    };

    return {
      modelId: modelConfig.id,
      isMultiModal: modelConfig.isMultiModal,
      fileGroups,
      supportedModalities,
      architecture,
      dependencies
    };
  }

  /**
   * 推断模型架构
   */
  private inferArchitecture(modelConfig: ILlamaModelConfig): IMultiModalModelInfo['architecture'] {
    const architecture: IMultiModalModelInfo['architecture'] = {
      mainArchitecture: 'unknown'
    };

    // 根据模型ID推断架构
    const modelId = modelConfig.id.toLowerCase();

    if (modelId.includes('qwen')) {
      architecture.mainArchitecture = 'qwen';
      if (modelConfig.isMultiModal) {
        architecture.visionEncoder = 'clip';
        if (modelId.includes('omni')) {
          architecture.audioEncoder = 'whisper';
        }
      }
    } else if (modelId.includes('gemma')) {
      architecture.mainArchitecture = 'gemma';
      if (modelConfig.isMultiModal) {
        architecture.visionEncoder = 'siglip';
      }
    } else if (modelId.includes('minicpm')) {
      architecture.mainArchitecture = 'minicpm';
      if (modelConfig.isMultiModal) {
        architecture.visionEncoder = 'clip';
      }
    }

    return architecture;
  }

  /**
   * 检查mmproj文件兼容性
   */
  private async checkMmprojCompatibility(
    mainModelPath: string,
    mmprojPath: string,
    info: IMultiModalModelInfo
  ): Promise<{ compatible: boolean; reason?: string }> {
    try {
      // 这里可以实现更复杂的兼容性检查
      // 目前基于文件名和大小进行基础检查

      const mainModelStats = await fs.stat(mainModelPath);
      const mmprojStats = await fs.stat(mmprojPath);

      // 检查文件是否存在且有合理大小
      if (mainModelStats.size === 0) {
        return { compatible: false, reason: t('主模型文件为空') };
      }

      if (mmprojStats.size === 0) {
        return { compatible: false, reason: t('mmproj文件为空') };
      }

      // 基于架构的兼容性检查
      if (info.architecture.mainArchitecture === 'unknown') {
        return { compatible: true, reason: t('无法确定架构，假设兼容') };
      }

      // 所有检查通过
      return { compatible: true };
    } catch (error) {
      return { compatible: false, reason: t('兼容性检查失败: {error}', { error }) };
    }
  }
}

/**
 * 单例实例
 * 注意：由于可能的循环依赖，建议在方法内部使用 MultiModalModelService.getInstance()
 */
export const multiModalModelService = MultiModalModelService.getInstance();
