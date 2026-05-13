import { CommandContext, EngineCapability, IAIEngineAdapter, StartOptions } from '@yonuc/types';
import { LogCategory, logger } from '@yonuc/shared';

import fs from 'node:fs';
import { hardwareDetectionService } from '../../system/hardware-detection-service';
import { llamaEngineService } from '../../llama/llama-engine-service';
import path from 'node:path';

export class LlamacppAdapter implements IAIEngineAdapter {
  readonly engineName = 'llama.cpp';

  async initialize(): Promise<void> {
    logger.info(LogCategory.AI_SERVICE, 'LlamacppAdapter: 正在初始化 llama.cpp 引擎...');
    await llamaEngineService.ensureEngineDeployed();
  }

  async start(options: StartOptions): Promise<void> {
    logger.info(LogCategory.AI_SERVICE, `LlamacppAdapter: 准备启动模型 ${options.modelId}`);
    // 真正的进程启动由 LlamaServerService 的 processManager 负责
  }

  async stop(): Promise<void> {
    logger.info(LogCategory.AI_SERVICE, 'LlamacppAdapter: 停止服务');
  }

  async isRunning(): Promise<boolean> {
    // 进程管理在外部，这里主要作为命令构造器
    return false;
  }

  async getCapabilities(): Promise<EngineCapability> {
    const tier = await hardwareDetectionService.getBestAccelerationTier();
    const hardwareInfo = await hardwareDetectionService.getHardwareInfo();
    
    return {
      hasCuda: tier === 'cuda',
      hasMetal: tier === 'metal',
      hasVulkan: tier === 'vulkan',
      hasAvx2: hardwareInfo.cpu.features.avx2 || true,
      hasAvx512: hardwareInfo.cpu.features.avx512 || false
    };
  }

  async buildCommandContext(options: StartOptions): Promise<CommandContext> {
    const { llamaEngineService } = await import('../../llama/llama-engine-service');
    const binaryPath = await llamaEngineService.getServerBinaryPath('llama.cpp');
    const engineDir = llamaEngineService.getEngineDir();
    
    let modelArg: string[] = [];
    let projectorArg: string[] = [];

    // 检查传入的模型路径是否真实有效
    let effectiveModelPath = options.modelPath;
    if (effectiveModelPath && !fs.existsSync(effectiveModelPath)) {
      logger.warn(LogCategory.AI_SERVICE, `LlamacppAdapter: 传入的模型路径不存在，将尝试解析: ${effectiveModelPath}`);
      effectiveModelPath = undefined;
    }

    if (effectiveModelPath) {
      modelArg = ['--model', effectiveModelPath];
    } else {
      // 尝试解析本地缓存路径
      const resolvedPath = await llamaEngineService.resolveModelPath(options.modelId);
      if (resolvedPath) {
        logger.info(LogCategory.AI_SERVICE, `LlamacppAdapter: 找到本地模型文件: ${resolvedPath}`);
        modelArg = ['--model', resolvedPath];
        
        // 尝试解析多模态投影器 (如果存在)
        const projectorPath = await llamaEngineService.resolveModelPath(options.modelId, 'projector');
        if (projectorPath) {
          logger.info(LogCategory.AI_SERVICE, `LlamacppAdapter: 找到多模态投影器: ${projectorPath}`);
          projectorArg = ['--mmproj', projectorPath];
        }
      } else {
        // 未找到本地文件，使用 -hf 模式让引擎自行处理
        modelArg = ['-hf', options.modelId];
      }
    }

    // 构造标准 llama-server 参数
    const args = [
      ...modelArg,
      ...projectorArg,
      '--port', String(options.port || 11434),
      '--ctx-size', String(options.contextWindow || 4096),
      '--parallel', '1',
      '--embedding',
      '--alias', options.modelId,
      '--jinja',
      '--no-mmap'
    ];

    // 生产环境开启详细日志，便于排查用户侧的崩溃问题
    if (process.env.NODE_ENV === 'production') {
      args.push('--verbose');
    }

    if (options.forceCpu) {
      logger.info(LogCategory.AI_SERVICE, 'LlamacppAdapter: 强制 CPU 模式，禁用 GPU 加速');
      args.push('--device', 'none');
      args.push('--n-gpu-layers', '0');
    } else if (options.gpuLayers !== undefined) {
      args.push('--n-gpu-layers', String(options.gpuLayers));
    } else {
      // 如果没有指定，默认尝试开启加速
      args.push('--n-gpu-layers', '99');
    }

    // 在 Windows 上，我们需要将二进制目录加入 PATH 以加载 DLL
    // 关键修正：确保不产生多个不同大小写的 PATH 变量 (如 Path 和 PATH)
    const env: NodeJS.ProcessEnv = { ...process.env };
    const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'Path';
    env[pathKey] = `${engineDir};${env[pathKey]}`;
    
    if (process.platform === 'linux') {
      env.LD_LIBRARY_PATH = `${engineDir}:${process.env.LD_LIBRARY_PATH || ''}`;
    }

    // 过滤掉 undefined 值，满足 Record<string, string> 类型要求
    const filteredEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined) {
        filteredEnv[key] = value;
      }
    }

    return {
      command: binaryPath,
      args,
      env: filteredEnv
    };
  }

  async buildDownloadCommand(modelId: string): Promise<CommandContext> {
    const { llamaEngineService } = await import('../../llama/llama-engine-service');
    const completionPath = llamaEngineService.getCompletionBinaryPath();
    const engineDir = llamaEngineService.getEngineDir();
    
    // 设置环境变量，同样注意 Path 大小写问题
    const env: NodeJS.ProcessEnv = { ...process.env };
    const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'Path';
    env[pathKey] = `${engineDir};${env[pathKey]}`;

    // 过滤掉 undefined 值，满足 Record<string, string> 类型要求
    const filteredEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined) {
        filteredEnv[key] = value;
      }
    }

    const args = [
      '-hf', modelId, // 移除手动添加的引号，交给 UnifiedModelManager 处理或由 spawn 自动处理
      '--no-conversation'
    ];

    // 生产环境开启详细日志，便于排查用户侧的模型下载/验证崩溃问题
    if (process.env.NODE_ENV === 'production') {
      args.push('--verbose');
    }

    return {
      command: completionPath,
      args,
      env: filteredEnv
    };
  }
}

