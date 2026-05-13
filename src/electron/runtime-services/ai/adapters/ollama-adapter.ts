import { IAIEngineAdapter, EngineCapability, StartOptions, CommandContext } from '@yonuc/types';
import { OllamaService, OllamaStatus } from '../ollama-service';
import { logger, LogCategory } from '@yonuc/shared';
import { nativeApi } from '../../utils/native-network';
import { spawn } from 'child_process';

/**
 * 获取标准化环境变量
 */
const getStandardizedEnv = (extraEnv = {}) => ({
  ...process.env,
  "PYTHONIOENCODING": "utf-8",
  "LANG": "en_US.UTF-8",
  "LC_ALL": "en_US.UTF-8",
  "CHCP": "65001",
  "OLLAMA_ORIGINS": "*",
  ...extraEnv
});

export class OllamaAdapter implements IAIEngineAdapter {
  readonly engineName = 'ollama';
  private ollamaService: OllamaService;

  constructor() {
    this.ollamaService = OllamaService.getInstance();
  }

  async initialize(): Promise<void> {
    logger.info(LogCategory.AI_SERVICE, 'OllamaAdapter: 正在初始化 Ollama 环境...');
    const result = await this.ollamaService.checkInstallation();
    if (!result.installed) {
      logger.warn(LogCategory.AI_SERVICE, 'Ollama 未安装，可能需要引导用户安装');
    }
  }

  async start(options: StartOptions): Promise<void> {
    const { modelId, port = 11434 } = options;
    if (!modelId) return;

    logger.info(LogCategory.AI_SERVICE, `OllamaAdapter: 正在加载模型 ${modelId}...`);

    try {
      /**
       * 1. 优先尝试 API 加载：
       * 向 Ollama 发送一个空提示词的 generate 请求，触发静默加载到显存。
       */
      try {
        const loadUrl = `http://127.0.0.1:${port}/api/generate`;
        await nativeApi.post(loadUrl, {
          model: modelId,
          prompt: "",
          keep_alive: -1 
        }, { timeout: 3000 });
        
        logger.info(LogCategory.AI_SERVICE, `Ollama 模型已通过 API 静默加载: ${modelId}`);
        return;
      } catch (apiError) {
        logger.debug(LogCategory.AI_SERVICE, 'Ollama API 加载模型未就绪，回退到命令行方式');
      }

      /**
       * 2. 命令行备选方案：
       * 使用 'ollama show' 触发加载。
       */
      const workingPath = this.ollamaService.getWorkingPath();
      const finalCmd = workingPath.includes(' ') && !workingPath.startsWith('"') ? `"${workingPath}"` : workingPath;

      const child = spawn(finalCmd, ['show', modelId], {
        stdio: 'ignore', 
        windowsHide: true,
        shell: true,
        env: getStandardizedEnv()
      });

      child.unref();
      logger.info(LogCategory.AI_SERVICE, `Ollama 静默加载指令(CLI)已发送 (PID: ${child.pid})`);
    } catch (error) {
      logger.error(LogCategory.AI_SERVICE, `OllamaAdapter 加载模型失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async stop(): Promise<void> {
    logger.info(LogCategory.AI_SERVICE, 'OllamaAdapter: 停止服务');
    // Ollama 停止模型通常通过 keep_alive: 0 的请求，或者等待超时
  }

  async isRunning(): Promise<boolean> {
    const status = this.ollamaService.getServiceStatus ? (this.ollamaService as any).getServiceStatus() : this.ollamaService.getStatus();
    return status === OllamaStatus.INSTALLED || (status as any) === 'running';
  }

  async getCapabilities(): Promise<EngineCapability> {
    return {
      hasCuda: true,
      hasMetal: process.platform === 'darwin',
      hasVulkan: false,
      hasAvx2: true
    };
  }

  async buildCommandContext(options: StartOptions): Promise<CommandContext> {
    const ollamaPath = this.ollamaService.getWorkingPath();
    return {
      command: ollamaPath,
      args: ['serve'],
      env: {
        OLLAMA_ORIGINS: "*"
      }
    };
  }

  async buildDownloadCommand(modelId: string): Promise<CommandContext> {
    const ollamaPath = this.ollamaService.getWorkingPath();
    return {
      command: ollamaPath,
      args: ['pull', modelId],
      env: {}
    };
  }
}
