import packageJson from '../../../package.json';

/**
 * 获取构建时指定的引擎类型
 * 优先从 package.json 中的 ai-engine 字段读取
 */
export function getBuildTimeEngineType(): string {
  try {
    // 直接从导入的 package.json 中读取，这样 Vite 会在构建时将其嵌入
    const engine = (packageJson as any)['ai-engine'];
    if (engine) {
      return engine;
    }
    
    // 如果导入失败或没有该字段，尝试返回默认值
    return 'llama.cpp';
  } catch (error) {
    console.error('Failed to get build time engine type:', error);
    return 'llama.cpp';
  }
}
