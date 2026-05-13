import { IAIEngineAdapter } from '@yonuc/types';
import { OllamaAdapter } from './ollama-adapter';
import { LlamafileAdapter } from './llamafile-adapter';
import { LlamacppAdapter } from './llamacpp-adapter';
import { ConfigOrchestrator } from '../../../config/config-orchestrator';
import { getBuildTimeEngineType } from '../../../config/engine-detection';
import { logger, LogCategory } from '@yonuc/shared';

export class AIEngineFactory {
  private static adapters: Map<string, IAIEngineAdapter> = new Map();

  static getAdapter(engineType?: string): IAIEngineAdapter {
    const type = engineType || this.getCurrentEngineType();
    
    if (!this.adapters.has(type)) {
      this.adapters.set(type, this.createAdapter(type));
    }
    
    return this.adapters.get(type)!;
  }

  private static createAdapter(type: string): IAIEngineAdapter {
    switch (type) {
      case 'ollama':
        return new OllamaAdapter();
      case 'llama.cpp':
        return new LlamacppAdapter();
      case 'llamafile':
      default:
        return new LlamafileAdapter();
    }
  }

  private static getCurrentEngineType(): string {
    const buildTimeEngine = getBuildTimeEngineType();
    try {
      const orchestrator = ConfigOrchestrator.getInstance();
      // 从配置中读取 AI_ENGINE。由于 config.default.ts 已更新，
      // getValue 默认会返回 build-time 引擎，除非用户在本地配置中覆盖。
      const engine = orchestrator.getValue<string>('AI_ENGINE');
      
      // 强制迁移逻辑：如果持久化的是旧默认值 'llamafile'，但构建时已明确改为 'llama.cpp'，
      // 则自动执行平滑迁移，以确保应用正常工作。
      if (engine === 'llamafile' && buildTimeEngine === 'llama.cpp') {
        logger.info(LogCategory.AI_SERVICE, `检测到引擎升级: 从 llamafile 自动切换到构建时指定的 ${buildTimeEngine}`);
        // 异步更新持久化配置，不阻塞当前流程
        setTimeout(() => {
          orchestrator.updateValue('AI_ENGINE', buildTimeEngine).catch(err => {
            logger.error(LogCategory.AI_SERVICE, '自动同步 AI_ENGINE 配置失败', err);
          });
        }, 100);
        return buildTimeEngine;
      }

      if (engine) {
        logger.debug(LogCategory.AI_SERVICE, `当前配置的 AI 引擎: ${engine} (构建时默认: ${buildTimeEngine})`);
        return engine;
      }

      return buildTimeEngine;
    } catch (e) {
      logger.warn(LogCategory.AI_SERVICE, '获取 AI 引擎配置失败，回退到构建时默认值', e);
      return buildTimeEngine;
    }
  }

  /**
   * 从 package.json 中获取编译时指定的 AI 平台
   */
  public static getBuildTimeEngineType(): string {
    return getBuildTimeEngineType();
  }
}
