/**
 * AI 平台工具模块
 * 用于检测和获取 package.json 中配置的 AI 平台
 */

import path from 'node:path'
import fs from 'node:fs'
import { app } from 'electron'

/**
 * AI 平台类型
 */
export type AIPlatform = 'llama.cpp' | 'ollama'

/**
 * AI 平台配置
 */
export interface AIPlatformConfig {
  platform: AIPlatform
  isOllama: boolean
  isLlamaCpp: boolean
}

/**
 * 默认配置
 */
const DEFAULT_PLATFORM: AIPlatform = 'llama.cpp'

/**
 * 缓存的配置值
 */
let cachedConfig: AIPlatformConfig | null = null

/**
 * 获取 package.json 中的 AI 平台配置
 */
export function getAIPlatformFromPackageJson(): AIPlatform {
  if (cachedConfig) {
    return cachedConfig.platform
  }

  try {
    const isPackaged = app.isPackaged
    const resourcesPath = process.resourcesPath

    // 尝试多个可能的路径
    const possiblePaths = [
      // 1. 生产环境: 非 ASAR 结构 (app/package.json)
      isPackaged ? path.join(resourcesPath, 'app', 'package.json') : '',
      // 2. 生产环境: ASAR 结构 (app.asar/package.json)
      isPackaged ? path.join(resourcesPath, 'app.asar', 'package.json') : '',
      // 3. 开发环境: 根目录
      path.join(process.cwd(), 'package.json'),
      // 4. 开发环境: 指定子目录
      path.join(process.cwd(), 'apps/desktop/package.json'),
      // 5. 编译后环境: 相对路径
      path.join(__dirname, '../../../../package.json'),
      path.join(__dirname, '../../../../apps/desktop/package.json'),
    ].filter(p => p !== '')

    let packageJson: any = null
    let foundPath = ''

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        try {
          const content = fs.readFileSync(p, 'utf-8')
          packageJson = JSON.parse(content)
          foundPath = p
          // 只有当真的含有 ai-platform 字段时才确认找到
          if (packageJson && packageJson['ai-platform']) {
            break
          }
        } catch (e) {
          // 继续尝试下一个路径
        }
      }
    }

    if (packageJson && packageJson['ai-platform']) {
      const platform = packageJson['ai-platform']
      if (platform === 'ollama' || platform === 'llama.cpp') {
        console.log(`[AIPlatform] 从 package.json 读取 AI 平台配置: ${platform} (路径: ${foundPath})`)
        return platform
      }
    }

    console.log(`[AIPlatform] 未找到有效的 ai-platform 配置 (已尝试 ${possiblePaths.length} 个路径)，使用默认值: ${DEFAULT_PLATFORM}`)
    return DEFAULT_PLATFORM
  } catch (error) {
    console.warn('[AIPlatform] 读取 AI 平台配置失败，使用默认值:', error)
    return DEFAULT_PLATFORM
  }
}

/**
 * 获取 AI 平台配置
 */
export function getAIPlatformConfig(): AIPlatformConfig {
  if (cachedConfig) {
    return cachedConfig
  }

  const platform = getAIPlatformFromPackageJson()
  
  cachedConfig = {
    platform,
    isOllama: platform === 'ollama',
    isLlamaCpp: platform === 'llama.cpp'
  }

  return cachedConfig
}

/**
 * 检查当前是否为 Ollama 模式
 */
export function isOllamaMode(): boolean {
  return getAIPlatformConfig().isOllama
}

/**
 * 检查当前是否为 llama.cpp 模式
 */
export function isLlamaCppMode(): boolean {
  return getAIPlatformConfig().isLlamaCpp
}

/**
 * 获取当前 AI 平台
 */
export function getCurrentPlatform(): AIPlatform {
  return getAIPlatformConfig().platform
}

/**
 * 清除缓存（主要用于测试）
 */
export function clearPlatformCache(): void {
  cachedConfig = null
}
