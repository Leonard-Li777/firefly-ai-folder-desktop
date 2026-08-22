/**
 * 获取构建时指定的引擎类型
 * 返回编译时注入的 __AI_ENGINE__ 常量
 */
export function getBuildTimeEngineType(): string {
  try {
    // 返回编译时注入的全局常量
    return __AI_ENGINE__;
  } catch (error) {
    // 如果常量未定义（例如在非 Vite 环境运行测试），回退到环境变量或默认值
    return process.env.AI_ENGINE || 'llama.cpp';
  }
}

