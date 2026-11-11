/**
 * 引擎模型目录与槽位解析器（零 Electron 依赖）
 * apps/desktop/src/electron/runtime-services/engine-bridge/engine-model-catalog-resolver.ts
 *
 * 核心职责（Issue 04 / Deepening Spec §3.4）：
 * 1. 收拢主进程（EngineBridgeService）与渲染进程（ai-engine-config-settings / DirectoryHeader）
 *    重复维护的模型友好名称正则、槽位 Two-Pass 匹配与 D-Spark 激活判定；
 * 2. 纯 TypeScript 零 Electron 依赖，可在主进程、渲染进程与 Vitest Node 单测中直接复用。
 */

export interface CatalogModelEntry {
  id: string
  name: string
  localPath?: string
  fileName?: string
  isEmbedding?: boolean
}

export interface ResolvedEngineModelDisplay {
  llmDisplayName: string | null
  vlmDisplayName: string | null
  isDSparkActive: boolean
}

export interface ResolveDisplayModelOptions {
  builtinCatalog?: CatalogModelEntry[]
  downloadedCatalog?: CatalogModelEntry[]
  modelNameMap?: ReadonlyMap<string, string>
  lastKnownModel?: string | null
  firstDownloadedModel?: string | null
}

export class EngineModelCatalogResolver {
  /**
   * 将原始模型 ID / 路径 / 文件名解析为用户可读的友好名称（单一事实源）
   * - 空值或 mmproj 多模态投影器辅助文件返回空字符串 `''`
   */
  public static resolveFriendlyModelName(
    rawModelId?: string | null,
    options?: {
      catalog?: CatalogModelEntry[]
      modelNameMap?: ReadonlyMap<string, string>
    }
  ): string {
    if (!rawModelId || typeof rawModelId !== 'string') {
      return ''
    }
    const identifier = rawModelId.trim()
    if (!identifier) {
      return ''
    }

    // 防护：mmproj 是多模态投影器辅助文件，不是可直接启动的主模型，不应展示为当前模型名称
    const fileBasename = identifier.replace(/.*[/\\]/, '').toLowerCase()
    if (fileBasename.startsWith('mmproj')) {
      return ''
    }

    // 0. 如果 identifier 本身已经是规范展示名称（包含中文、全角括号、或者非文件名且包含空格），直接返回
    if (
      /[\u4e00-\u9fa5（）]/.test(identifier) ||
      (identifier.includes(' ') &&
        !/[/\\]/.test(identifier) &&
        !identifier.toLowerCase().endsWith('.gguf'))
    ) {
      return identifier
    }

    // 1. 优先从内置模型目录进行语义与归一化匹配（获取 Qwen 3.5 0.8B (中文更佳) 等中文规范名称）
    const catalog = options?.catalog || []
    if (catalog.length > 0) {
      // 1.1 直接精确匹配 id 或 name
      const direct = catalog.find(m => m.id === identifier || m.name === identifier)
      if (direct?.name) return direct.name

      // 1.2 如果 identifier 是完整物理路径，匹配其包含的 repo 仓库标识
      const normalizedPath = identifier.replace(/\\/g, '/').toLowerCase()
      const pathHit = catalog.find(m => {
        if (!m.id) return false
        const repoId = m.id.split(':')[0].toLowerCase()
        if (!repoId) return false
        const repoSlug = repoId.replace('/', '--')
        return normalizedPath.includes(repoId) || normalizedPath.includes(repoSlug)
      })
      if (pathHit?.name) return pathHit.name

      // 1.3 规范化匹配（去掉扩展名、路径前缀）
      const clean = identifier.replace(/\.[^.]+$/, '').replace(/.*[\\/]/, '')
      const cleanNorm = clean.toLowerCase().replace(/[-_:\/]|gguf/gi, '')
      const hit = catalog.find(m => {
        if (!m.id) return false
        if (m.id === clean || m.name === clean) return true
        const idNorm = m.id.toLowerCase().replace(/[-_:\/]|gguf/gi, '')
        if (idNorm.includes(cleanNorm) || cleanNorm.includes(idNorm)) return true

        // 针对模型家族关键词与尺寸进行深度匹配（如 minicpm5 + 1b）
        const cLower = clean.toLowerCase()
        const idLower = m.id.toLowerCase()
        if (cLower.includes('minicpm5') && idLower.includes('minicpm5')) {
          if (cLower.includes('1b') && idLower.includes('1b')) return true
          if (cLower.includes('2b') && idLower.includes('2b')) return true
        }
        if (cLower.includes('qwen') && idLower.includes('qwen')) {
          if (cLower.includes('0.8b') && idLower.includes('0.8b')) return true
        }
        return false
      })
      if (hit && hit.name) {
        return hit.name
      }
    }

    // 2. 次选从 /api/models 映射表中反查（若名称与原始 ID 不同则采用）
    if (options?.modelNameMap && options.modelNameMap.size > 0) {
      const mapped = options.modelNameMap.get(identifier)
      if (mapped && mapped !== identifier) {
        return mapped
      }
    }

    // 3. 兜底语义映射（绝不能将冰冷的文件名原样暴露为模型名称）
    const cleanStem = identifier.replace(/.*[\\/]/, '').replace(/\.[^.]+$/, '')
    if (/minicpm5[-_]1b/i.test(cleanStem)) {
      return 'MiniCPM5 1B（较好•越狱）'
    }
    if (/minicpm5[-_]2b/i.test(cleanStem)) {
      return 'MiniCPM5 2B（高质量•高速）'
    }
    if (/qwen3\.?5[-_]0\.8b/i.test(cleanStem)) {
      return 'Qwen 3.5 0.8B (中文更佳)'
    }

    return cleanStem
  }

  /**
   * 将引擎激活槽位值匹配到内置模型目录或已下载/自定义模型列表条目（Two-Pass 先精确后模糊）
   */
  public static matchSlotToCatalog(
    slot: string,
    prefer: 'language' | 'embedding',
    layers: CatalogModelEntry[][] = []
  ): { id: string; name: string } | null {
    if (!slot) return null

    const slotLower = slot.toLowerCase().replace(/\\/g, '/')
    const slotId = slotLower.split('@')[0]
    const slotFileName = slotId.replace(/.*\//, '')
    if (slotFileName.startsWith('mmproj')) return null

    const nonEmptyLayers = layers.filter(l => Array.isArray(l) && l.length > 0)
    if (nonEmptyLayers.length === 0) return null

    const matchesSlotType = (entry: CatalogModelEntry): boolean => {
      const entryIsEmbedding =
        entry.isEmbedding === true ||
        /wemm|embedding/i.test(entry.id) ||
        /wemm|embedding/i.test(entry.name) ||
        Boolean(entry.fileName && /wemm|embedding/i.test(entry.fileName))
      return prefer === 'embedding' ? entryIsEmbedding : !entryIsEmbedding
    }

    // Pass 1：ID / 名称精确匹配
    for (const layer of nonEmptyLayers) {
      for (const entry of layer) {
        if (!entry.id || !entry.name) continue
        if (!matchesSlotType(entry)) continue
        const idLower = entry.id.toLowerCase()
        if (slotId === idLower || slotLower === entry.name.toLowerCase()) {
          return { id: entry.id, name: entry.name }
        }
      }
    }

    // Pass 2：路径与基名归一化模糊匹配
    const slotBase = slotId.replace(/.*\//, '').split(':')[0]
    const norm = (s: string): string => s.replace(/[-_:./\\]|gguf/gi, '').toLowerCase()
    const slotIdNorm = norm(slotBase)
    const slotStemNorm = norm(slotFileName.replace(/\.[^.]+$/, ''))
    const looksLikePath = slotLower.includes('.gguf') || slotLower.split('/').length >= 3

    const fuzzyMatch = (a: string, b: string): boolean =>
      a.length > 0 &&
      b.length > 0 &&
      (a === b || (a.length > 3 && b.length > 3 && (a.includes(b) || b.includes(a))))

    const extractQuantTag = (rawId: string): string | null => {
      const withoutDrive = rawId.replace(/^[a-z]:/i, '')
      const colonIdx = withoutDrive.indexOf(':')
      if (colonIdx < 0) return null
      const tag = withoutDrive
        .slice(colonIdx + 1)
        .trim()
        .toLowerCase()
      if (!tag || tag.endsWith('.gguf') || tag.includes('/')) return null
      return tag.replace(/^ud[-_]/, '').replace(/_/g, '-')
    }
    const slotQuant = extractQuantTag(slotId)

    for (const layer of nonEmptyLayers) {
      for (const entry of layer) {
        if (!entry.id || !entry.name) continue
        if (!matchesSlotType(entry)) continue

        const idLower = entry.id.toLowerCase()
        const entryQuant = extractQuantTag(idLower)
        if (slotQuant && entryQuant && slotQuant !== entryQuant) continue

        const entryBase = idLower.replace(/.*\//, '').split(':')[0]
        const entryBaseNorm = norm(entryBase)

        const lpLower = entry.localPath ? entry.localPath.toLowerCase().replace(/\\/g, '/') : ''
        const fnLower = entry.fileName
          ? entry.fileName.toLowerCase().replace(/\\/g, '/')
          : lpLower
            ? lpLower.replace(/.*\//, '')
            : ''
        const fnStem = fnLower ? fnLower.replace(/\.[^.]+$/, '') : ''
        const fnStemNorm = fnStem ? norm(fnStem) : ''

        const hit =
          fuzzyMatch(slotBase, entryBase) ||
          fuzzyMatch(slotIdNorm, entryBaseNorm) ||
          fuzzyMatch(slotStemNorm, entryBaseNorm) ||
          (looksLikePath &&
            (() => {
              const repoId = idLower.split(':')[0]
              if (!repoId || repoId.length <= 3) return false
              const repoSlug = repoId.replace(/\//g, '--')
              return (
                slotLower.includes(repoId) || (repoSlug !== repoId && slotLower.includes(repoSlug))
              )
            })()) ||
          (lpLower.length > 0 &&
            (slotLower === lpLower ||
              (looksLikePath &&
                lpLower.length > 3 &&
                slotLower.length > 3 &&
                (lpLower.includes(slotLower) || slotLower.includes(lpLower))))) ||
          (fnLower.length > 0 && (slotLower === fnLower || slotFileName === fnLower)) ||
          fuzzyMatch(slotBase, fnStem) ||
          fuzzyMatch(slotIdNorm, fnStemNorm) ||
          fuzzyMatch(slotStemNorm, fnStemNorm)

        if (hit) {
          return { id: entry.id, name: entry.name }
        }
      }
    }

    return null
  }

  /**
   * 解析当前激活的展示模型对（同时返回 `{ llm, vlm }` 与 `{ model, modelName }`）
   */
  public static resolveDisplayModelPair(
    statusRaw: unknown,
    options?: ResolveDisplayModelOptions
  ): {
    llm: string | null
    vlm: string | null
    model: string | null
    modelName: string | null
  } {
    const raw =
      statusRaw && typeof statusRaw === 'object' ? (statusRaw as Record<string, any>) : null
    const layers: CatalogModelEntry[][] = [
      options?.builtinCatalog || [],
      options?.downloadedCatalog || []
    ]

    const toFriendly = (id?: string | null): string | null => {
      if (!id) return null
      const resolved = EngineModelCatalogResolver.resolveFriendlyModelName(id, {
        catalog: options?.builtinCatalog,
        modelNameMap: options?.modelNameMap
      })
      return resolved || null
    }

    const isRunningOrStarting =
      raw?.status === 'ready' || raw?.status === 'processing' || raw?.status === 'starting'
    const running =
      raw?.current_model ||
      raw?.model ||
      (Array.isArray(raw?.loaded_models) && raw.loaded_models.length > 0
        ? raw.loaded_models[0]
        : null) ||
      null
    const runningName = raw?.current_model_name || raw?.model_name || null

    let primaryModel: string | null = null
    let primaryModelName: string | null = null

    // P1：运行模型（仅实际运行态；停止态跳过，严禁使用残留 current_model）
    if (isRunningOrStarting && running) {
      const friendly = toFriendly(running)
      if (friendly || runningName) {
        primaryModel = running
        primaryModelName = runningName || friendly
      }
    }

    // P2：激活主语言模型槽位
    if (!primaryModel && raw?.active_language_model) {
      const langHit = EngineModelCatalogResolver.matchSlotToCatalog(
        String(raw.active_language_model),
        'language',
        layers
      )
      if (langHit) {
        primaryModel = langHit.id
        primaryModelName = langHit.name
      } else {
        const friendly = toFriendly(String(raw.active_language_model))
        if (friendly) {
          primaryModel = String(raw.active_language_model)
          primaryModelName = friendly
        }
      }
    }

    // P3：激活嵌入向量模型槽位
    if (!primaryModel && raw?.active_embedding_model) {
      const embHit = EngineModelCatalogResolver.matchSlotToCatalog(
        String(raw.active_embedding_model),
        'embedding',
        layers
      )
      if (embHit) {
        primaryModel = embHit.id
        primaryModelName = embHit.name
      } else {
        const friendly = toFriendly(String(raw.active_embedding_model))
        if (friendly) {
          primaryModel = String(raw.active_embedding_model)
          primaryModelName = friendly
        }
      }
    }

    // P4：兜底 —— 上次已知运行模型 → 本地首个已下载就绪模型
    if (!primaryModel) {
      const fallback = options?.lastKnownModel || options?.firstDownloadedModel || null
      primaryModel = fallback
      primaryModelName = toFriendly(fallback)
    }

    // 解析 VLM / 视觉模型槽位（若存在独立 active_vision_model / active_vlm_model 或主模型自身为 VLM）
    const rawVlmSlot =
      raw?.active_vision_model ||
      raw?.active_vlm_model ||
      raw?.vlm_model ||
      (primaryModel && /minicpm[-_]?v|qwen.*vl|llava|internvl/i.test(primaryModel)
        ? primaryModel
        : null)
    const vlmFriendly = rawVlmSlot ? toFriendly(String(rawVlmSlot)) : null

    return {
      llm: primaryModelName,
      vlm: vlmFriendly,
      model: primaryModel,
      modelName: primaryModelName
    }
  }

  /**
   * 判定当前引擎是否激活了 D-Spark / 草稿投机采样加速
   */
  public static isDSparkActive(statusRaw: unknown): boolean {
    if (!statusRaw || typeof statusRaw !== 'object') {
      return false
    }
    const raw = statusRaw as Record<string, any>

    // 1. 优先读取引擎上报的真实自适应运行时参数
    const rp = raw.runtime_params as any
    if (rp && typeof rp === 'object') {
      if (
        rp.effective_enable_draft === true ||
        rp.enable_draft === true ||
        rp.enableDraft === true
      ) {
        return true
      }
      if (
        rp.effective_enable_draft === false ||
        rp.enable_draft === false ||
        rp.enableDraft === false
      ) {
        return false
      }
    }

    // 2. 其次匹配当前激活模型 ID、物理路径或展示名中的 spark / dspark / draft 标记
    const modelCandidates = [
      raw.current_model,
      raw.current_model_name,
      raw.model,
      raw.active_language_model
    ]
    for (const m of modelCandidates) {
      if (typeof m === 'string' && /(?:dspark|spark|draft)/i.test(m)) {
        return true
      }
    }

    return false
  }
}
