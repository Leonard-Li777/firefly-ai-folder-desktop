/**
 * Deployment Manager - 跨平台部署配置管理器
 * 处理不同平台的二进制文件打包和模型文件管理
 */

import * as path from 'path'
import * as fs from 'fs/promises'
import { app } from 'electron'
import { platformAdapter } from '@firefly/electron-llamaIndex-service'
import { filePermissionManager } from '../filesystem/file-permission-manager'
import { logger, LogCategory } from '@firefly/shared'
import {
  TPlatform,
  TArchitecture,
  THardwareAcceleration,
  IFileValidationResult
} from '@firefly/types/llama-server'

/**
 * 二进制文件配置接口
 */
export interface IBinaryPackageConfig {
  /** 平台 */
  platform: TPlatform
  /** 架构 */
  architecture: TArchitecture
  /** 硬件加速类型 */
  acceleration: THardwareAcceleration
  /** 包名称 */
  packageName: string
  /** 相对路径 */
  relativePath: string
  /** 是否必需 */
  required: boolean
  /** 优先级 */
  priority: number
  /** 预期文件大小（字节） */
  expectedSize?: number
  /** 预期SHA256哈希 */
  expectedHash?: string
  /** 依赖的系统组件 */
  dependencies?: string[]
}

/**
 * 模型文件配置接口
 */
export interface IModelPackageConfig {
  /** 模型ID */
  modelId: string
  /** 模型名称 */
  name: string
  /** 主模型文件 */
  mainFile: string
  /** 多模态投影文件（可选） */
  mmProjFile?: string
  /** 配置文件（可选） */
  configFile?: string
  /** 模型大小（字节） */
  totalSize: number
  /** 支持的能力 */
  capabilities: string[]
  /** 最小系统要求 */
  requirements: {
    minMemory: number // MB
    minVRAM?: number // MB
    recommendedThreads: number
  }
}

/**
 * 部署验证结果接口
 */
export interface IDeploymentValidationResult {
  /** 是否有效 */
  isValid: boolean
  /** 平台兼容性 */
  platformCompatible: boolean
  /** 二进制文件验证结果 */
  binaryValidation: Map<string, IFileValidationResult>
  /** 模型文件验证结果 */
  modelValidation: Map<string, IFileValidationResult>
  /** 缺失的文件 */
  missingFiles: string[]
  /** 权限问题 */
  permissionIssues: string[]
  /** 警告信息 */
  warnings: string[]
  /** 错误信息 */
  errors: string[]
}

/**
 * 跨平台部署管理器
 */
export class DeploymentManager {
  private static instance: DeploymentManager

  /**
   * 二进制文件配置映射
   */
  private readonly binaryConfigs: IBinaryPackageConfig[] = [
    // Windows配置
    {
      platform: 'win32',
      architecture: 'x64',
      acceleration: 'cuda',
      packageName: 'llama-bin-win-cuda-x64',
      relativePath: 'llama/llama-bin-win-cuda-x64',
      required: false,
      priority: 100,
      dependencies: ['CUDA Runtime 12.4', 'Visual C++ Redistributable']
    },
    {
      platform: 'win32',
      architecture: 'x64',
      acceleration: 'hip',
      packageName: 'llama-bin-win-hip-x64',
      relativePath: 'llama/llama-bin-win-hip-x64',
      required: false,
      priority: 90,
      dependencies: ['AMD ROCm / HIP Driver', 'Visual C++ Redistributable']
    },
    {
      platform: 'win32',
      architecture: 'x64',
      acceleration: 'hip',
      packageName: 'llama-bin-win-rocm-x64',
      relativePath: 'llama/llama-bin-win-rocm-x64',
      required: false,
      priority: 91,
      dependencies: ['AMD ROCm / HIP Driver', 'Visual C++ Redistributable']
    },
    {
      platform: 'win32',
      architecture: 'x64',
      acceleration: 'vulkan',
      packageName: 'llama-bin-win-vulkan-x64',
      relativePath: 'llama/llama-bin-win-vulkan-x64',
      required: false,
      priority: 80,
      dependencies: ['Vulkan Runtime']
    },
    {
      platform: 'win32',
      architecture: 'x64',
      acceleration: 'sycl',
      packageName: 'llama-bin-win-sycl-x64',
      relativePath: 'llama/llama-bin-win-sycl-x64',
      required: false,
      priority: 75,
      dependencies: ['Intel oneAPI DPC++ Compiler', 'Visual C++ Redistributable']
    },
    {
      platform: 'win32',
      architecture: 'x64',
      acceleration: 'openvino',
      packageName: 'llama-bin-win-openvino-x64',
      relativePath: 'llama/llama-bin-win-openvino-x64',
      required: false,
      priority: 85,
      dependencies: ['Intel oneAPI Runtime', 'Visual C++ Redistributable']
    },
    {
      platform: 'win32',
      architecture: 'x64',
      acceleration: 'cpu',
      packageName: 'llama-bin-win-cpu-x64',
      relativePath: 'llama/llama-bin-win-cpu-x64',
      required: true,
      priority: 60,
      dependencies: ['Visual C++ Redistributable']
    },
    {
      platform: 'win32',
      architecture: 'arm64',
      acceleration: 'cpu',
      packageName: 'llama-bin-win-cpu-arm64',
      relativePath: 'llama/llama-bin-win-cpu-arm64',
      required: true,
      priority: 60,
      dependencies: ['Visual C++ Redistributable']
    },

    // macOS配置
    {
      platform: 'darwin',
      architecture: 'arm64',
      acceleration: 'cpu',
      packageName: 'llama-bin-macos-arm64',
      relativePath: 'llama/llama-bin-macos-arm64',
      required: true,
      priority: 90,
      dependencies: []
    },

    // Linux配置
    {
      platform: 'linux',
      architecture: 'x64',
      acceleration: 'vulkan',
      packageName: 'llama-bin-ubuntu-vulkan-x64',
      relativePath: 'llama/llama-bin-ubuntu-vulkan-x64',
      required: false,
      priority: 80,
      dependencies: ['Vulkan Loader', 'Mesa Vulkan Drivers']
    },
    {
      platform: 'linux',
      architecture: 'arm64',
      acceleration: 'vulkan',
      packageName: 'llama-bin-ubuntu-vulkan-arm64',
      relativePath: 'llama/llama-bin-ubuntu-vulkan-arm64',
      required: false,
      priority: 80,
      dependencies: ['Vulkan Loader']
    },
    {
      platform: 'linux',
      architecture: 'x64',
      acceleration: 'cuda',
      packageName: 'llama-bin-ubuntu-cuda-x64',
      relativePath: 'llama/llama-bin-ubuntu-cuda-x64',
      required: false,
      priority: 100,
      dependencies: ['CUDA Runtime', 'NVIDIA Driver']
    },
    {
      platform: 'linux',
      architecture: 'x64',
      acceleration: 'openvino',
      packageName: 'llama-bin-ubuntu-openvino-x64',
      relativePath: 'llama/llama-bin-ubuntu-openvino-x64',
      required: false,
      priority: 85,
      dependencies: ['Intel oneAPI Runtime']
    },
    {
      platform: 'linux',
      architecture: 'x64',
      acceleration: 'cpu',
      packageName: 'llama-bin-ubuntu-x64',
      relativePath: 'llama/llama-bin-ubuntu-x64',
      required: true,
      priority: 60,
      dependencies: []
    },
    {
      platform: 'linux',
      architecture: 'arm64',
      acceleration: 'cpu',
      packageName: 'llama-bin-ubuntu-arm64',
      relativePath: 'llama/llama-bin-ubuntu-arm64',
      required: true,
      priority: 60,
      dependencies: []
    }
  ]

  /**
   * 模型文件配置映射（当前版本未使用）
   */
  private readonly modelConfigs: IModelPackageConfig[] = []

  private constructor() {}

  /**
   * 获取单例实例
   */
  static getInstance(): DeploymentManager {
    if (!DeploymentManager.instance) {
      DeploymentManager.instance = new DeploymentManager()
    }
    return DeploymentManager.instance
  }

  /**
   * 获取当前平台的二进制配置
   */
  getCurrentPlatformBinaryConfigs(): IBinaryPackageConfig[] {
    const platformConfig = platformAdapter.getPlatformConfig()

    return this.binaryConfigs
      .filter(
        config =>
          config.platform === platformConfig.platform &&
          config.architecture === platformConfig.architecture
      )
      .sort((a, b) => b.priority - a.priority)
  }

  /**
   * 设置extraResources目录结构
   */
  async setupExtraResourcesStructure(): Promise<void> {
    const extraResourcesPath = platformAdapter.getExtraResourcesPath()

    // 创建基础目录结构
    const directories = [
      'llama', // 二进制文件目录
      'models', // 模型文件目录
      'configs', // 配置文件目录
      'temp', // 临时文件目录
      'logs' // 日志文件目录
    ]

    for (const dir of directories) {
      const dirPath = platformAdapter.normalizePath(path.join(extraResourcesPath, dir))

      try {
        await fs.mkdir(dirPath, { recursive: true })
        logger.info(LogCategory.DEPLOYMENT_MANAGER, `已创建目录: ${dirPath}`)
      } catch (error) {
        logger.warn(LogCategory.DEPLOYMENT_MANAGER, `创建目录失败 ${dirPath}: ${error}`)
      }
    }

    // 创建平台特定的二进制目录
    const platformConfigs = this.getCurrentPlatformBinaryConfigs()

    for (const config of platformConfigs) {
      const binaryDir = platformAdapter.normalizePath(
        path.join(extraResourcesPath, config.relativePath)
      )

      try {
        await fs.mkdir(binaryDir, { recursive: true })
        logger.info(LogCategory.DEPLOYMENT_MANAGER, `已创建二进制目录: ${binaryDir}`)
      } catch (error) {
        logger.warn(LogCategory.DEPLOYMENT_MANAGER, `创建二进制目录失败 ${binaryDir}: ${error}`)
      }
    }
  }

  /**
   * 验证部署完整性
   */
  async validateDeployment(): Promise<IDeploymentValidationResult> {
    const result: IDeploymentValidationResult = {
      isValid: false,
      platformCompatible: true,
      binaryValidation: new Map(),
      modelValidation: new Map(),
      missingFiles: [],
      permissionIssues: [],
      warnings: [],
      errors: []
    }

    try {
      // 检查平台兼容性
      const platformConfig = platformAdapter.getPlatformConfig()
      const currentPlatform = process.platform as TPlatform
      const currentArch = process.arch as TArchitecture

      if (
        platformConfig.platform !== currentPlatform ||
        platformConfig.architecture !== currentArch
      ) {
        result.platformCompatible = false
        result.errors.push(
          `平台不匹配: 期望 ${platformConfig.platform}-${platformConfig.architecture}, 实际 ${currentPlatform}-${currentArch}`
        )
      }

      // 验证二进制文件
      await this.validateBinaryFiles(result)

      // 检查权限问题
      await this.checkPermissions(result)

      // 检查依赖
      await this.checkDependencies(result)

      // 判断整体有效性
      result.isValid = result.errors.length === 0 && result.platformCompatible
    } catch (error) {
      result.errors.push(`部署验证失败: ${error}`)
    }

    return result
  }

  /**
   * 验证二进制文件
   */
  private async validateBinaryFiles(result: IDeploymentValidationResult): Promise<void> {
    const platformConfigs = this.getCurrentPlatformBinaryConfigs()
    const extraResourcesPath = platformAdapter.getExtraResourcesPath()

    for (const config of platformConfigs) {
      const binaryPath = platformAdapter.normalizePath(
        path.join(extraResourcesPath, config.relativePath)
      )

      try {
        const validation = await filePermissionManager.validateBinaryFile(
          binaryPath,
          config.expectedHash
        )

        result.binaryValidation.set(config.packageName, validation)

        if (!validation.exists) {
          if (config.required) {
            result.missingFiles.push(binaryPath)
            result.errors.push(`缺少必需的二进制文件: ${config.packageName}`)
          } else {
            result.warnings.push(`缺少可选的二进制文件: ${config.packageName}`)
          }
        } else if (!validation.isValid) {
          result.errors.push(
            `二进制文件验证失败: ${config.packageName} - ${validation.errors.join(', ')}`
          )
        } else if (validation.warnings.length > 0) {
          result.warnings.push(
            `二进制文件警告: ${config.packageName} - ${validation.warnings.join(', ')}`
          )
        }

        if (validation.exists && !validation.executable) {
          result.permissionIssues.push(binaryPath)
        }
      } catch (error) {
        result.errors.push(`验证二进制文件失败 ${config.packageName}: ${error}`)
      }
    }
  }

  /**
   * 检查权限问题
   */
  private async checkPermissions(result: IDeploymentValidationResult): Promise<void> {
    const platformConfig = platformAdapter.getPlatformConfig()

    // 只在需要权限管理的平台上检查
    if (!platformConfig.requiresPermissionManagement) {
      return
    }

    for (const filePath of result.permissionIssues) {
      try {
        const permissions = await filePermissionManager.checkPermissions(filePath)

        if (!permissions.executable) {
          result.warnings.push(`文件缺少执行权限: ${filePath}`)
        }

        if (!permissions.readable) {
          result.errors.push(`文件不可读: ${filePath}`)
        }
      } catch (error) {
        result.errors.push(`检查文件权限失败 ${filePath}: ${error}`)
      }
    }
  }

  /**
   * 检查依赖
   */
  private async checkDependencies(result: IDeploymentValidationResult): Promise<void> {
    try {
      const dependencyCheck = await platformAdapter.checkPlatformDependencies()

      if (!dependencyCheck.available) {
        result.errors.push(`缺少平台依赖: ${dependencyCheck.missing.join(', ')}`)
      }

      if (dependencyCheck.warnings.length > 0) {
        result.warnings.push(...dependencyCheck.warnings)
      }
    } catch (error) {
      result.warnings.push(`依赖检查失败: ${error}`)
    }
  }

  /**
   * 修复部署问题
   */
  async repairDeployment(): Promise<{
    success: boolean
    repaired: string[]
    failed: string[]
  }> {
    const repaired: string[] = []
    const failed: string[] = []

    try {
      // 创建目录结构
      await this.setupExtraResourcesStructure()
      repaired.push('目录结构')

      // 修复权限问题
      const validation = await this.validateDeployment()

      for (const filePath of validation.permissionIssues) {
        try {
          await filePermissionManager.repairPermissions(filePath)
          repaired.push(`权限修复: ${path.basename(filePath)}`)
        } catch (error) {
          failed.push(`权限修复失败: ${path.basename(filePath)} - ${error}`)
        }
      }
    } catch (error) {
      failed.push(`部署修复失败: ${error}`)
    }

    return {
      success: failed.length === 0,
      repaired,
      failed
    }
  }

  /**
   * 获取部署统计信息
   */
  async getDeploymentStats(): Promise<{
    platform: string
    architecture: string
    totalBinaries: number
    availableBinaries: number
    totalModels: number
    availableModels: number
    diskUsage: number // MB
    issues: number
  }> {
    const validation = await this.validateDeployment()
    const platformConfig = platformAdapter.getPlatformConfig()

    let diskUsage = 0

    // 计算磁盘使用量
    try {
      const extraResourcesPath = platformAdapter.getExtraResourcesPath()
      diskUsage = await this.calculateDirectorySize(extraResourcesPath)
    } catch (error) {
      logger.warn(LogCategory.DEPLOYMENT_MANAGER, '计算磁盘使用量失败:', error)
    }

    return {
      platform: platformConfig.platform,
      architecture: platformConfig.architecture,
      totalBinaries: this.getCurrentPlatformBinaryConfigs().length,
      availableBinaries: Array.from(validation.binaryValidation.values()).filter(v => v.exists)
        .length,
      totalModels: this.modelConfigs.length,
      availableModels: Array.from(validation.modelValidation.values()).filter(v => v.exists).length,
      diskUsage: Math.round(diskUsage / 1024 / 1024), // 转换为MB
      issues: validation.errors.length + validation.warnings.length
    }
  }

  /**
   * 计算目录大小
   */
  private async calculateDirectorySize(dirPath: string): Promise<number> {
    let totalSize = 0

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name)

        if (entry.isDirectory()) {
          totalSize += await this.calculateDirectorySize(fullPath)
        } else if (entry.isFile()) {
          const stats = await fs.stat(fullPath)
          totalSize += stats.size
        }
      }
    } catch (error) {
      // 忽略无法访问的目录
    }

    return totalSize
  }

  /**
   * 生成部署报告
   */
  async generateDeploymentReport(): Promise<string> {
    const validation = await this.validateDeployment()
    const stats = await this.getDeploymentStats()
    const platformSummary = platformAdapter.getPlatformSummary()

    const report = [
      '# 部署验证报告',
      '',
      '## 平台信息',
      `- 平台: ${platformSummary.platform}`,
      `- 架构: ${platformSummary.architecture}`,
      `- Node.js版本: ${platformSummary.nodeVersion}`,
      `- Electron版本: ${platformSummary.electronVersion}`,
      `- 支持的硬件加速: ${platformSummary.supportedAccelerations.join(', ')}`,
      '',
      '## 部署统计',
      `- 二进制文件: ${stats.availableBinaries}/${stats.totalBinaries}`,
      `- 模型文件: ${stats.availableModels}/${stats.totalModels}`,
      `- 磁盘使用: ${stats.diskUsage} MB`,
      `- 问题数量: ${stats.issues}`,
      '',
      '## 验证结果',
      `- 整体有效性: ${validation.isValid ? '✅ 有效' : '❌ 无效'}`,
      `- 平台兼容性: ${validation.platformCompatible ? '✅ 兼容' : '❌ 不兼容'}`,
      ''
    ]

    if (validation.errors.length > 0) {
      report.push('## 错误')
      validation.errors.forEach(error => report.push(`- ❌ ${error}`))
      report.push('')
    }

    if (validation.warnings.length > 0) {
      report.push('## 警告')
      validation.warnings.forEach(warning => report.push(`- ⚠️ ${warning}`))
      report.push('')
    }

    if (validation.missingFiles.length > 0) {
      report.push('## 缺失文件')
      validation.missingFiles.forEach(file => report.push(`- 📁 ${file}`))
      report.push('')
    }

    report.push('## 优化建议')
    platformSummary.optimizations.forEach(opt => report.push(`- 🔧 ${opt}`))

    return report.join('\n')
  }
}

/**
 * 导出单例实例
 */
export const deploymentManager = DeploymentManager.getInstance()
