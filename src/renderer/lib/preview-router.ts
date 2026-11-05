/**
 * 预览路由仲裁器与三级熔断状态机 (PreviewRouter & PreviewCircuitBreaker)
 * 遵循规格书 docs/specs/file-previewer-engine-and-custom-extensions-spec.md (v1.2)
 */

import { PreviewCandidate, PreviewContext, PreviewRouteType } from './preview-types'
import { FLYFISH_EXTENSIONS, NATIVE_EXTENSIONS } from './preview-utils'
import { logger, LogCategory } from '@firefly/shared'

/**
 * 三级熔断管理器
 */
export class PreviewCircuitBreaker {
  /** L1: 单文件故障记录 Map<fileFingerprint, Set<pluginId>> */
  private fileTripped = new Map<string, Set<string>>()

  /** L2: 格式级连续故障计数 Map<`${pluginId}:${ext}`, number> */
  private extensionFailures = new Map<string, number>()
  /** L2: 格式级已熔断集合 Set<`${pluginId}:${ext}`> */
  private extensionTripped = new Set<string>()

  /** L3: 插件级致命故障计数 Map<pluginId, number> */
  private pluginFailures = new Map<string, number>()
  /** L3: 插件级已熔断集合 Set<pluginId> */
  private pluginTripped = new Set<string>()

  /**
   * 记录一次故障
   * @param pluginId 插件或预览器 ID
   * @param ext 文件扩展名（不带点）
   * @param fileFingerprint 文件复合元数据指纹
   * @param isCrashOrTimeout 是否为致命崩溃或未响应超时
   */
  recordFailure(
    pluginId: string,
    ext: string,
    fileFingerprint: string,
    isCrashOrTimeout: boolean = false
  ): void {
    const normExt = (ext || '').toLowerCase().replace(/^\./, '')

    // 1. 记录 L1 单文件熔断
    let files = this.fileTripped.get(fileFingerprint)
    if (!files) {
      // 容量防膨胀限制：保留最近 500 个文件指纹，先进先出淘汰
      if (this.fileTripped.size >= 500) {
        const oldestKey = this.fileTripped.keys().next().value
        if (oldestKey) this.fileTripped.delete(oldestKey)
      }
      files = new Set<string>()
      this.fileTripped.set(fileFingerprint, files)
    }
    files.add(pluginId)

    if (isCrashOrTimeout) {
      // 2. 统计 L2 格式级故障
      const extKey = `${pluginId}:${normExt}`
      const extCount = (this.extensionFailures.get(extKey) || 0) + 1
      this.extensionFailures.set(extKey, extCount)
      if (extCount >= 2) {
        this.extensionTripped.add(extKey)
        logger.warn(
          LogCategory.RENDERER,
          `[PreviewCircuitBreaker] L2 格式级熔断触发: 插件 ${pluginId} 对格式 .${normExt} 已被屏蔽`
        )
      }

      // 3. 统计 L3 插件级故障
      const pluginCount = (this.pluginFailures.get(pluginId) || 0) + 1
      this.pluginFailures.set(pluginId, pluginCount)
      if (pluginCount >= 3) {
        this.pluginTripped.add(pluginId)
        logger.warn(
          LogCategory.RENDERER,
          `[PreviewCircuitBreaker] L3 插件级熔断触发: 插件 ${pluginId} 在当前会话中已注销`
        )
      }
    }
  }

  /**
   * 判断目标候选者在指定文件和格式下是否已触发熔断
   */
  isTripped(pluginId: string, ext: string, fileFingerprint: string): boolean {
    const normExt = (ext || '').toLowerCase().replace(/^\./, '')

    // L3 插件级全量屏蔽
    if (this.pluginTripped.has(pluginId)) return true

    // L2 格式级屏蔽
    if (this.extensionTripped.has(`${pluginId}:${normExt}`)) return true

    // L1 单文件屏蔽
    const files = this.fileTripped.get(fileFingerprint)
    if (files && files.has(pluginId)) return true

    return false
  }

  /**
   * 重置指定插件的熔断状态
   */
  resetPlugin(pluginId: string): void {
    this.pluginTripped.delete(pluginId)
    this.pluginFailures.delete(pluginId)

    // 清理该插件相关的格式级熔断
    for (const key of Array.from(this.extensionTripped)) {
      if (key.startsWith(`${pluginId}:`)) {
        this.extensionTripped.delete(key)
        this.extensionFailures.delete(key)
      }
    }

    // 清理单文件记录
    for (const [, set] of this.fileTripped.entries()) {
      set.delete(pluginId)
    }
  }

  /**
   * 清空所有熔断状态（如切换工作区或会话重置）
   */
  resetAll(): void {
    this.fileTripped.clear()
    this.extensionFailures.clear()
    this.extensionTripped.clear()
    this.pluginFailures.clear()
    this.pluginTripped.clear()
  }
}

/**
 * 预览路由器核心类
 */
export class PreviewRouter {
  private static instance: PreviewRouter | null = null

  private providers: PreviewCandidate[] = []
  private circuitBreaker = new PreviewCircuitBreaker()
  private userOffsets = new Map<string, number>()

  constructor() {
    this.initDefaultProviders()
  }

  public static getInstance(): PreviewRouter {
    if (!PreviewRouter.instance) {
      PreviewRouter.instance = new PreviewRouter()
    }
    return PreviewRouter.instance
  }

  /**
   * 注册默认的原生与内置候选者
   */
  private initDefaultProviders(): void {
    // 1. 系统大图标与元数据保底
    this.registerProvider({
      id: 'system_icon_fallback',
      name: '系统图标与元数据',
      kind: 'system_icon',
      supportedExtensions: ['*'],
      declaredPriority: 0,
      effectivePriority: 0,
      isOfficialCertified: true,
      isTrustedForPrivate: true
    })

    // 2. Flyfish 通用预览引擎保底 (30+ 常见与专业格式)
    this.registerProvider({
      id: 'flyfish_viewer_fallback',
      name: 'Flyfish 通用预览引擎',
      kind: 'flyfish',
      supportedExtensions: Array.from(FLYFISH_EXTENSIONS),
      declaredPriority: 10,
      effectivePriority: 10,
      isOfficialCertified: true,
      isTrustedForPrivate: true
    })

    // 3. 原生内置可信 React 预览器 (音视频、图片、文本脚本)
    this.registerProvider({
      id: 'builtin_media_previewer',
      name: '原生音视频与文档预览器',
      kind: 'builtin_react',
      supportedExtensions: Array.from(NATIVE_EXTENSIONS),
      declaredPriority: 70,
      effectivePriority: 70,
      isOfficialCertified: true,
      isTrustedForPrivate: true
    })
  }

  /**
   * 注册外部或内置候选提供者
   */
  registerProvider(provider: PreviewCandidate): void {
    const existingIdx = this.providers.findIndex(p => p.id === provider.id)
    if (existingIdx >= 0) {
      this.providers[existingIdx] = provider
    } else {
      this.providers.push(provider)
    }
  }

  /**
   * 注销提供者
   */
  unregisterProvider(providerId: string): void {
    this.providers = this.providers.filter(p => p.id !== providerId)
    this.circuitBreaker.resetPlugin(providerId)
  }

  /**
   * 设置用户自定义优先级偏移
   */
  setUserOffset(candidateId: string, offset: number): void {
    this.userOffsets.set(candidateId, offset)
  }

  /**
   * 计算候选者有效优先级
   */
  private computeEffectivePriority(candidate: PreviewCandidate): number {
    const certBonus = candidate.isOfficialCertified ? 100 : 0
    const userOffset = this.userOffsets.get(candidate.id) || 0
    return candidate.declaredPriority + certBonus + userOffset
  }

  /**
   * 根据上下文解析当前文件有序候选栈
   */
  resolveCandidates(context: PreviewContext): PreviewCandidate[] {
    const ext = (context.extension || '').toLowerCase().replace(/^\./, '')
    const stack: PreviewCandidate[] = []

    for (const provider of this.providers) {
      // 1. 格式匹配检查 (* 或具体扩展名匹配)
      const matchesExt =
        provider.supportedExtensions.includes('*') ||
        provider.supportedExtensions.map(e => e.toLowerCase()).includes(ext)
      if (!matchesExt) continue

      // 2. PRIVATE 目录排他门控
      if (context.isPrivate && !provider.isTrustedForPrivate) {
        logger.info(
          LogCategory.RENDERER,
          `[PreviewRouter] 跳过第三方插件 ${provider.id}: PRIVATE 目录已激活隐私保护`
        )
        continue
      }

      // 3. 熔断状态机拦截
      if (this.circuitBreaker.isTripped(provider.id, ext, context.fileFingerprint)) {
        logger.info(LogCategory.RENDERER, `[PreviewRouter] 跳过已熔断插件: ${provider.id} (${ext})`)
        continue
      }

      // 4. 计算有效优先级并加入候选栈
      stack.push({
        ...provider,
        effectivePriority: this.computeEffectivePriority(provider)
      })
    }

    // 5. 按 effectivePriority 降序排序，相同优先级按 ID 字母序稳定排序
    stack.sort((a, b) => {
      if (b.effectivePriority !== a.effectivePriority) {
        return b.effectivePriority - a.effectivePriority
      }
      return a.id.localeCompare(b.id)
    })

    return stack
  }

  /**
   * 静态探测目标扩展名最高优先级候选者（用于兼容层快速探测）
   */
  peekTopCandidate(extension?: string): PreviewCandidate | null {
    const ext = (extension || '').toLowerCase().replace(/^\./, '')
    if (!ext) return null

    // 伪造一个轻量公开上下文探测
    const dummyContext: PreviewContext = {
      filePath: `dummy.${ext}`,
      fileName: `dummy.${ext}`,
      extension: ext,
      fileSize: 0,
      fileFingerprint: `dummy.${ext}:0:0`,
      requestId: 'peek',
      generation: 0,
      signal: new AbortController().signal,
      isPrivate: false
    }

    const candidates = this.resolveCandidates(dummyContext)
    return candidates.length > 0 ? candidates[0] : null
  }

  getCircuitBreaker(): PreviewCircuitBreaker {
    return this.circuitBreaker
  }
}
