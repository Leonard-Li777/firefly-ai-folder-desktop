import { IAIEngineAdapter, EngineCapability, StartOptions, CommandContext } from '@yonuc/types';
import { logger, LogCategory } from '@yonuc/shared';
import path from 'node:path';
import fs from 'fs-extra';
import { app } from 'electron';
import { hardwareDetectionService } from '../../system/hardware-detection-service';
import { ConfigOrchestrator } from '../../../config/config-orchestrator';

export class LlamafileAdapter implements IAIEngineAdapter {
  readonly engineName = 'llamafile';
  private readonly engineDir: string;
  private readonly binaryName: string;
  private readonly bundlesDir: string;

  constructor() {
    // 移除硬编码的路径初始化，逻辑移交至 LlamaEngineService
  }



  async initialize(): Promise<void> {
    logger.info(LogCategory.AI_SERVICE, 'LlamafileAdapter: 正在初始化 llamafile 引擎...');
    // 统一使用 llamaEngineService 进行部署，它会同时处理 llamafile 和 llama.cpp
    const { llamaEngineService } = await import('../../llama/llama-engine-service');
    await llamaEngineService.ensureEngineDeployed();
  }

  async start(options: StartOptions): Promise<void> {
    logger.info(LogCategory.AI_SERVICE, `LlamafileAdapter: 准备启动模型 ${options.modelId}`);
  }

  async stop(): Promise<void> {
    logger.info(LogCategory.AI_SERVICE, 'LlamafileAdapter: 停止服务');
  }

  async isRunning(): Promise<boolean> {
    return false;
  }

  async getCapabilities(): Promise<EngineCapability> {
    const hardwareInfo = await hardwareDetectionService.getHardwareInfo();
    return {
      hasCuda: hardwareInfo.gpu.type === 'nvidia',
      hasMetal: process.platform === 'darwin',
      hasVulkan: true, // llamafile 通常内置 vulkan 支持
      hasAvx2: hardwareInfo.cpu.features.avx2 || true
    };
  }

  async buildCommandContext(options: StartOptions): Promise<CommandContext> {
    const { llamaEngineService } = await import('../../llama/llama-engine-service');
    // 显式指定首选引擎为 llamafile
    const binaryPath = await llamaEngineService.getServerBinaryPath('llamafile');
    const args = [
      '--server',
      '--jinja',
      '--host', '127.0.0.1',
      '--verbose'
    ];

    // 检查传入的模型路径是否真实有效
    let effectiveModelPath = options.modelPath;
    if (effectiveModelPath && !fs.existsSync(effectiveModelPath)) {
      logger.warn(LogCategory.AI_SERVICE, `LlamafileAdapter: 传入的模型路径不存在，将尝试解析: ${effectiveModelPath}`);
      effectiveModelPath = undefined;
    }

    if (effectiveModelPath) {
      args.push('--model', effectiveModelPath);
    } else if (options.modelId && options.modelId !== 'builtin') {
      // 尝试解析本地缓存路径
      const resolvedPath = await llamaEngineService.resolveModelPath(options.modelId);
      if (resolvedPath) {
        logger.info(LogCategory.AI_SERVICE, `LlamafileAdapter: 找到本地模型文件: ${resolvedPath}`);
        args.push('--model', resolvedPath);
        
        // 尝试解析多模态投影器 (如果存在)
        const projectorPath = await llamaEngineService.resolveModelPath(options.modelId, 'projector');
        if (projectorPath) {
          logger.info(LogCategory.AI_SERVICE, `LlamafileAdapter: 找到多模态投影器: ${projectorPath}`);
          args.push('--mmproj', projectorPath);
        }
      } else {
        // 未找到本地文件，让引擎尝试在线拉取
        args.push('-hf', options.modelId);
      }
    }

    if (options.gpuLayers !== undefined) {
      args.push('--n-gpu-layers', String(options.gpuLayers));
    } else {
      // 默认尝试使用全部 GPU 层
      args.push('--n-gpu-layers', '999');
    }

    return {
      command: binaryPath,
      args,
      env: {
        ...process.env
      }
    };
  }

  async buildDownloadCommand(modelId: string): Promise<CommandContext> {
    const { llamaEngineService } = await import('../../llama/llama-engine-service');
    const { unifiedModelManager } = await import('../../llama/unified-model-manager');
    const binaryPath = llamaEngineService.getCompletionBinaryPath();
    const engineDir = llamaEngineService.getEngineDir();
    const baseDir = unifiedModelManager.getModelBaseDir();

    // 设置环境变量
    const env: NodeJS.ProcessEnv = { ...process.env, LLAMA_CACHE: baseDir };
    if (process.platform === 'win32') {
      env.PATH = `${engineDir};${process.env.PATH}`;
    }

    return {
      command: binaryPath,
      args: [
        '-hf', `"${modelId}"`,
        '--no-conversation'
      ],
      env
    };
  }
}

