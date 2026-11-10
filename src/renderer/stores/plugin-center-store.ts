import { create } from 'zustand'

export type PluginCategory =
  | 'ai-engine'
  | 'perception'
  | 'media'
  | 'tool'
  | 'parser'
  | 'vfs-archive'
export type PluginAuthorCode = 'official' | 'community' | 'third_party'
export type PluginAvailability = 'coming_soon' | 'draft' | 'approved' | 'delisted'
export type PluginInstallState =
  | 'not_installed'
  | 'downloading'
  | 'installed_inactive'
  | 'active'
  | 'error'

export interface DownloadProgress {
  percentage: number
  speed_bytes_per_sec: number
  is_resumed: boolean
}

export interface PluginModuleItem {
  id: string
  name: string
  version: string
  catalog_version?: number
  category: PluginCategory
  capability_slot?: string
  slot_policy?: string
  backend_type?: string
  author_code: PluginAuthorCode
  author_name?: string | null
  availability: PluginAvailability
  delist_reason?: 'general_deprecation' | 'security_violation' | null
  firecore_cost?: number
  total_bytes: number
  install_state: PluginInstallState
  selected_variant?: string | null
  is_running?: boolean
  is_usable?: boolean
  can_activate?: boolean
  can_install?: boolean
  can_uninstall?: boolean
  hold_reasons?: string[]
  description: string
  hardware_requirement?: {
    level: 'minimal' | 'recommended' | 'heavy' | 'high'
    text: string
  }
  icon?: string
  config_schema?: string | null
  user_config?: string | null
  error_message?: string | null
  download_progress?: DownloadProgress
  contributes?: {
    settings?: import('@firefly/types').PluginSettingsContribution
  }
  resources?: Array<{
    resource_id: string
    asset_name: string
    expected_bytes: number
    expected_sha256?: string
  }>
}

export interface ModularResourceProgressPayload {
  moduleId: string
  resourceId: string
  downloadedBytes: number
  expectedBytes: number
  percentage: number
  speedBytesPerSec: number
  isResumed: boolean
  state: 'downloading' | 'verifying' | 'extracting' | 'completed' | 'failed'
  errorMessage?: string
}

export interface IModularResourceBridge {
  list: (filter?: {
    scope?: 'market' | 'installed'
    category?: string
    includeDraft?: boolean
  }) => Promise<PluginModuleItem[]>
  getDevMode?: () => Promise<boolean>
  setDevMode?: (payload: { enabled: boolean }) => Promise<boolean>
  install: (moduleId: string) => Promise<PluginModuleItem>
  uninstall: (moduleId: string) => Promise<PluginModuleItem>
  updateState: (
    moduleId: string,
    patch: {
      active?: boolean
      userConfig?: Record<string, unknown> | string | null
      selectedVariant?: string
      userConsent?: boolean
    }
  ) => Promise<PluginModuleItem>
  abortAll?: () => Promise<boolean>
  smokeTest?: (payload: {
    profile: 'classic_light' | 'gemma_unified'
    model_paths?: Record<string, string>
    test_tokens?: string[]
  }) => Promise<{ success: boolean; latency_ms?: number; error?: string }>
  getPendingTombstones?: () => Promise<
    Array<{ path: string; registeredAt: string; reason?: string }>
  >
  hasPendingTombstones?: () => Promise<boolean>
  restartApp?: () => Promise<boolean>
  exportOfflinePackage?: (payload: {
    moduleId: string
    targetFilePath?: string
  }) => Promise<string | null>
  importOfflinePackage?: (payload?: { archivePath?: string }) => Promise<PluginModuleItem | null>
  pickAndImportLocalPlugin?: () => Promise<{
    canceled: boolean
    module?: PluginModuleItem
    error?: string
  }>
  onProgress?: (callback: (event: ModularResourceProgressPayload) => void) => () => void
}

export interface PluginCenterState {
  isOverlayOpen: boolean
  configuringModuleId: string | null
  searchKeyword: string
  selectedCategory: string
  modules: PluginModuleItem[]
  isLoading: boolean
  isDeveloperMode: boolean
  scope: 'market' | 'installed'

  // 弹层开关动作
  setOverlayOpen: (open: boolean) => void | Promise<void>
  openOverlay: () => void | Promise<void>
  closeOverlay: () => void
  toggleOverlay: () => void | Promise<void>

  // 筛选与搜索
  setSearchKeyword: (keyword: string) => void
  setSelectedCategory: (category: string) => void
  setDeveloperMode: (enabled: boolean) => Promise<void>
  setScope: (scope: 'market' | 'installed') => void

  // 插件管理与 IPC 持久化读写
  loadModules: () => Promise<PluginModuleItem[]>
  setConfiguringModuleId: (id: string | null) => void
  installPlugin: (id: string) => Promise<void>
  uninstallPlugin: (id: string) => Promise<void>
  togglePluginActive: (id: string, active: boolean) => Promise<void>
  updateUserConfig: (id: string, userConfig: string | null) => Promise<void>
  updateDownloadProgress: (id: string, progress: DownloadProgress) => void
  subscribeProgress: () => () => void
  hasPendingTombstones: boolean
  pendingTombstones: Array<{ path: string; registeredAt: string; reason?: string }>
  checkPendingTombstones: () => Promise<void>
  restartApp: () => Promise<void>
  exportOfflinePackage: (moduleId: string) => Promise<string | null>
  importOfflinePackage: (archivePath?: string) => Promise<PluginModuleItem | null>
  pickAndImportLocalPlugin: () => Promise<boolean>
  resetForTest: () => void
}

export const INITIAL_PLUGINS: PluginModuleItem[] = [
  {
    id: 'engine_classic_light',
    name: '经典轻量 AI 引擎 (Classic Light)',
    version: '1.0.0',
    category: 'ai-engine',
    capability_slot: 'base_embedding',
    slot_policy: 'exclusive_required',
    backend_type: 'omni_onnx',
    author_code: 'official',
    author_name: null,
    availability: 'approved',
    total_bytes: 319195255,
    install_state: 'not_installed',
    contributes: {
      settings: {
        scope: 'workspace',
        tabTitle: '基础 AI 引擎',
        componentId: 'basic_ai_engine',
        priority: 10
      }
    },
    description:
      '【通过意思找文件与图片】根据你描述的大致意思快速搜索照片和文档。占用极少内存，即使老电脑和低配轻薄本也能流畅运行。不支持音视频',
    hardware_requirement: {
      level: 'minimal',
      text: '配置要求极低 · 老电脑与轻薄本首选'
    },
    icon: 'Feather',
    resources: [
      {
        resource_id: 'bekko-a8m',
        asset_name: 'bekko-a8m-1.0.0.zip',
        expected_bytes: 106269288
      },
      {
        resource_id: 'chinese-clip',
        asset_name: 'chinese-clip-int8-v3.zip',
        expected_bytes: 212925967
      }
    ]
  },
  {
    id: 'engine_gemma_unified',
    name: '统一全模态 AI 引擎 (Gemma Unified)',
    version: '1.0.0',
    category: 'ai-engine',
    capability_slot: 'base_embedding',
    slot_policy: 'exclusive_required',
    backend_type: 'omni_onnx',
    author_code: 'official',
    author_name: null,
    availability: 'approved',
    total_bytes: 254003864,
    install_state: 'not_installed',
    contributes: {
      settings: {
        scope: 'workspace',
        tabTitle: '基础 AI 引擎',
        componentId: 'basic_ai_engine',
        priority: 10
      }
    },
    description:
      '【更聪明的全能搜索大脑】对复杂句子和图片、音视频的理解更深入精准，找东西更懂你的心思。推荐 8GB 或以上内存电脑使用。',
    hardware_requirement: {
      level: 'recommended',
      text: '推荐配置 · 电脑内存 8GB 或以上'
    },
    icon: 'Layers',
    resources: [
      {
        resource_id: 'embeddinggemma-2-onnx',
        asset_name: 'embeddinggemma-2-onnx-1.0.0.zip',
        expected_bytes: 254003864
      }
    ]
  },
  {
    id: 'pocket-cpu-int8-onnx',
    name: '轻量CPU生成式引擎 (Pocket CPU)',
    version: '1.0.0',
    category: 'ai-engine',
    capability_slot: 'ai_engine_cpu',
    slot_policy: 'exclusive_optional',
    backend_type: 'omni_onnx',
    author_code: 'official',
    author_name: null,
    availability: 'approved',
    total_bytes: 380633088,
    install_state: 'not_installed',
    contributes: {
      settings: {
        scope: 'global',
        tabTitle: '生成式引擎',
        componentId: 'ai_engine_config',
        priority: 15
      }
    },
    description:
      '【办公轻薄本标配】内存仅占约400MB，0门槛秒级响应，完全离线私密。支持智能文件名深度润色、描述提取与内容深度解析。',
    hardware_requirement: {
      level: 'minimal',
      text: '配置要求极低 · 纯CPU运行'
    },
    icon: 'Cpu',
    resources: [
      {
        resource_id: 'pocket-cpu-int8-onnx',
        asset_name: 'pocket-cpu-int8-onnx-1.0.0.zip',
        expected_bytes: 380633088
      }
    ]
  },
  {
    id: 'perception_nsfw',
    name: '敏感内容与 NSFW 分级识别',
    version: '1.0.0',
    category: 'perception',
    capability_slot: 'perception_nsfw',
    slot_policy: 'exclusive_optional',
    backend_type: 'omni_onnx',
    author_code: 'official',
    author_name: null,
    availability: 'approved',
    total_bytes: 21966375,
    install_state: 'not_installed',
    contributes: {
      settings: {
        scope: 'workspace',
        tabTitle: '文件内容萃取',
        componentId: 'content_extraction',
        priority: 20
      }
    },
    description:
      '【私密与敏感图片标记】自动识别不适合在公开场合打开的图片并加上标记，防止投屏查看时尴尬。所有电脑均可极速运行。',
    hardware_requirement: {
      level: 'minimal',
      text: '配置要求极低 · 极速处理'
    },
    icon: 'ShieldAlert',
    resources: [
      {
        resource_id: 'nsfw-l3',
        asset_name: 'nsfw-l3-1.0.0.zip',
        expected_bytes: 21966375
      }
    ]
  },
  {
    id: 'asr_sensevoice_onnx',
    name: '语音识别与字幕提取 ASR (SenseVoice)',
    version: '1.0.0',
    category: 'perception',
    capability_slot: 'voice_asr',
    slot_policy: 'exclusive_optional',
    backend_type: 'omni_onnx',
    author_code: 'official',
    author_name: null,
    availability: 'approved',
    total_bytes: 168587158,
    install_state: 'not_installed',
    contributes: {
      settings: {
        scope: 'workspace',
        tabTitle: '文件内容萃取',
        componentId: 'content_extraction',
        priority: 25
      }
    },
    description:
      '【录音与视频自动转文字】听懂视频和录音里的说话内容并提取字幕，可以直接搜索“某句话是谁说的”。较耗算力，推荐 16GB 内存或有显卡。',
    hardware_requirement: {
      level: 'heavy',
      text: '较耗算力 · 推荐 16GB 内存或有显卡'
    },
    icon: 'Mic',
    resources: [
      {
        resource_id: 'sherpa-onnx-runtime',
        asset_name: 'sherpa-onnx-runtime-1.13.8-win32-x64.zip',
        expected_bytes: 8282676
      },
      {
        resource_id: 'sensevoice-onnx',
        asset_name: 'sensevoice-onnx-int8.zip',
        expected_bytes: 160304482
      }
    ]
  },
  {
    id: 'tts_moss_onnx',
    name: '离线语音合成 TTS (Moss-TTS)',
    version: '1.0.0',
    category: 'media',
    capability_slot: 'voice_tts',
    slot_policy: 'exclusive_optional',
    backend_type: 'omni_onnx',
    author_code: 'official',
    author_name: null,
    availability: 'approved',
    total_bytes: 249105462,
    install_state: 'not_installed',
    contributes: {
      settings: {
        scope: 'global',
        tabTitle: '语音合成 (TTS)',
        componentId: 'tts',
        priority: 30
      }
    },
    description:
      '【真人般自然朗读文章】把文档和文章读给你听，支持戴耳机离线听书看材料，完全不消耗网络。普通电脑即可流畅发音。',
    hardware_requirement: {
      level: 'minimal',
      text: '配置要求低 · 普通电脑流畅发音'
    },
    icon: 'Volume2',
    resources: [
      {
        resource_id: 'sherpa-onnx-runtime',
        asset_name: 'sherpa-onnx-runtime-1.13.8-win32-x64.zip',
        expected_bytes: 8282676
      },
      {
        resource_id: 'moss-tts',
        asset_name: 'moss-tts-1.0.0.zip',
        expected_bytes: 240822786
      }
    ]
  },
  {
    id: 'diffusion_studio',
    name: '本地生图 Studio',
    version: '0.1.0',
    category: 'ai-engine',
    author_code: 'official',
    author_name: null,
    availability: 'coming_soon',
    total_bytes: 3824100000,
    install_state: 'not_installed',
    description:
      '【电脑本地自己画图】输入一句话即可在本地画出精美图片，不花一分钱。需要较好的独立显卡。',
    hardware_requirement: {
      level: 'high',
      text: '较高配置 · 需要独立显卡'
    },
    icon: 'Sparkles'
  },
  {
    id: 'archive_vfs_parser',
    name: '压缩包透视与深度解析器',
    version: '1.0.0',
    category: 'vfs-archive',
    author_code: 'official',
    author_name: null,
    availability: 'coming_soon',
    delist_reason: null,
    total_bytes: 0,
    install_state: 'not_installed',
    description:
      '【不用解压直接搜压缩包】不用解压 zip/rar 就能直接查看和搜索里面的文件内容，无额外电脑负担。',
    hardware_requirement: {
      level: 'minimal',
      text: '配置要求极低 · 无额外负担'
    },
    icon: 'Archive'
  }
]

let injectedModularResourceBridge: IModularResourceBridge | null = null

/**
 * 供集成测试或预加载桥显式注入自定义 ModularResource IPC 桥
 */
export function setModularResourceBridgeForTest(bridge: IModularResourceBridge | null): void {
  injectedModularResourceBridge = bridge
}

function getModularResourceBridge(): IModularResourceBridge | null {
  if (injectedModularResourceBridge) {
    return injectedModularResourceBridge
  }
  if (typeof window !== 'undefined' && (window as any).electronAPI?.modularResource) {
    return (window as any).electronAPI.modularResource as IModularResourceBridge
  }
  return null
}

function normalizeRemoteModuleItem(raw: any): PluginModuleItem {
  const seed = INITIAL_PLUGINS.find(s => s.id === raw.id)
  return {
    id: raw.id,
    name: raw.name || seed?.name || raw.id,
    version: raw.version || seed?.version || '1.0.0',
    catalog_version: raw.catalog_version ?? 1,
    category: raw.category || seed?.category || 'tool',
    author_code: raw.author_code || seed?.author_code || 'official',
    author_name: raw.author_name !== undefined ? raw.author_name : (seed?.author_name ?? null),
    availability: raw.availability || seed?.availability || 'approved',
    firecore_cost: raw.firecore_cost ?? 0,
    total_bytes: raw.total_bytes ?? seed?.total_bytes ?? 0,
    install_state: raw.install_state || 'not_installed',
    selected_variant: raw.selected_variant ?? null,
    description: raw.description || seed?.description || '',
    hardware_requirement: raw.hardware_requirement || seed?.hardware_requirement,
    icon: raw.icon || seed?.icon,
    config_schema: raw.config_schema ?? null,
    user_config: raw.user_config ?? null,
    error_message: raw.error_message ?? null,
    is_running: raw.is_running,
    is_usable: raw.is_usable,
    can_activate: raw.can_activate,
    can_install: raw.can_install,
    can_uninstall: raw.can_uninstall,
    hold_reasons: raw.hold_reasons,
    ...(raw.download_progress ? { download_progress: raw.download_progress } : {})
  }
}

export const usePluginCenterStore = create<PluginCenterState>((set, get) => ({
  isOverlayOpen: false,
  configuringModuleId: null,
  searchKeyword: '',
  selectedCategory: 'all',
  modules: INITIAL_PLUGINS,
  isLoading: false,
  isDeveloperMode: false,
  scope: 'market',
  hasPendingTombstones: false,
  pendingTombstones: [],

  setOverlayOpen: async (open: boolean) => {
    set({
      isOverlayOpen: open,
      // 关闭弹层时若在配置子界面，重置回主列表
      ...(open ? {} : { configuringModuleId: null })
    })
    if (open) {
      const bridge = getModularResourceBridge()
      if (bridge && typeof bridge.getDevMode === 'function') {
        try {
          const enabled = await bridge.getDevMode()
          set({ isDeveloperMode: !!enabled })
        } catch {}
      }
      await get().loadModules()
    }
  },

  openOverlay: async () => {
    set({ isOverlayOpen: true })
    const bridge = getModularResourceBridge()
    if (bridge && typeof bridge.getDevMode === 'function') {
      try {
        const enabled = await bridge.getDevMode()
        set({ isDeveloperMode: !!enabled })
      } catch {}
    }
    await get().loadModules()
  },

  closeOverlay: () => {
    set({ isOverlayOpen: false, configuringModuleId: null })
  },

  toggleOverlay: async () => {
    const next = !get().isOverlayOpen
    set({
      isOverlayOpen: next,
      ...(next ? {} : { configuringModuleId: null })
    })
    if (next) {
      const bridge = getModularResourceBridge()
      if (bridge && typeof bridge.getDevMode === 'function') {
        try {
          const enabled = await bridge.getDevMode()
          set({ isDeveloperMode: !!enabled })
        } catch {}
      }
      await get().loadModules()
    }
  },

  setSearchKeyword: (keyword: string) => {
    set({ searchKeyword: keyword })
  },

  setSelectedCategory: (category: string) => {
    set({ selectedCategory: category })
  },

  setDeveloperMode: async (enabled: boolean) => {
    set({ isDeveloperMode: enabled })
    const bridge = getModularResourceBridge()
    if (bridge && typeof bridge.setDevMode === 'function') {
      try {
        await bridge.setDevMode({ enabled })
      } catch {}
    }
    await get().loadModules()
  },

  setScope: (scope: 'market' | 'installed') => {
    set({ scope })
    void get().loadModules()
  },

  setConfiguringModuleId: (id: string | null) => {
    set({ configuringModuleId: id })
  },

  pickAndImportLocalPlugin: async () => {
    const bridge = getModularResourceBridge()
    if (!bridge || typeof bridge.pickAndImportLocalPlugin !== 'function') {
      return false
    }
    try {
      const res = await bridge.pickAndImportLocalPlugin()
      if (res && !res.canceled && res.module) {
        await get().loadModules()
        return true
      }
      return false
    } catch {
      return false
    }
  },

  loadModules: async () => {
    const bridge = getModularResourceBridge()
    if (!bridge || typeof bridge.list !== 'function') {
      return get().modules
    }
    set({ isLoading: true })
    try {
      const filter = {
        scope: get().scope,
        includeDraft: get().isDeveloperMode
      }
      const list = await bridge.list(filter)
      if (Array.isArray(list)) {
        const normalized = list.map(normalizeRemoteModuleItem)
        set({ modules: normalized, isLoading: false })
        get()
          .checkPendingTombstones()
          .catch(() => {})
        return normalized
      }
      set({ isLoading: false })
      return get().modules
    } catch {
      set({ isLoading: false })
      return get().modules
    }
  },

  installPlugin: async (id: string) => {
    set(state => ({
      modules: state.modules.map(m => {
        if (m.id !== id) return m
        return {
          ...m,
          install_state: 'downloading',
          error_message: null,
          download_progress: {
            percentage: 0,
            speed_bytes_per_sec: 0,
            is_resumed: false
          }
        }
      })
    }))

    const bridge = getModularResourceBridge()
    if (bridge && typeof bridge.install === 'function') {
      try {
        const updated = await bridge.install(id)
        if (updated) {
          const norm = normalizeRemoteModuleItem(updated)
          set(state => ({
            modules: state.modules.map(m => (m.id === id ? norm : m))
          }))
          get()
            .checkPendingTombstones()
            .catch(() => {})
        }
      } catch (err: any) {
        const errMsg = err?.message || String(err)
        set(state => ({
          modules: state.modules.map(m =>
            m.id === id ? { ...m, install_state: 'error', error_message: errMsg } : m
          )
        }))
      }
    }
  },

  uninstallPlugin: async (id: string) => {
    set(state => ({
      modules: state.modules.map(m =>
        m.id === id ? { ...m, install_state: 'not_installed', download_progress: undefined } : m
      )
    }))

    const bridge = getModularResourceBridge()
    if (bridge && typeof bridge.uninstall === 'function') {
      try {
        const updated = await bridge.uninstall(id)
        if (updated) {
          const norm = normalizeRemoteModuleItem(updated)
          set(state => ({
            modules: state.modules.map(m => (m.id === id ? norm : m))
          }))
        }
      } catch (err: any) {
        const errMsg = err?.message || String(err)
        set(state => ({
          modules: state.modules.map(m =>
            m.id === id ? { ...m, install_state: 'error', error_message: errMsg } : m
          )
        }))
      }
    }
  },

  togglePluginActive: async (id: string, active: boolean) => {
    const currentModules = get().modules
    const target = currentModules.find(m => m.id === id)
    if (!target) return

    // 检查槽位排他策略 (exclusive_required / exclusive_optional)
    const isExclusive =
      target.slot_policy === 'exclusive_required' || target.slot_policy === 'exclusive_optional'
    const targetSlot = target.capability_slot

    // 收集同槽位中需要被互斥停用的插件 ID 列表
    const mutuallyExcludedIds: string[] = []
    if (active && isExclusive && targetSlot) {
      currentModules.forEach(m => {
        if (m.id !== id && m.capability_slot === targetSlot && m.install_state === 'active') {
          mutuallyExcludedIds.push(m.id)
        }
      })
    }

    set(state => ({
      modules: state.modules.map(m => {
        if (m.id === id) {
          return {
            ...m,
            install_state: active ? 'active' : 'installed_inactive'
          }
        }
        if (mutuallyExcludedIds.includes(m.id)) {
          return {
            ...m,
            install_state: 'installed_inactive'
          }
        }
        return m
      })
    }))

    const bridge = getModularResourceBridge()
    if (bridge && typeof bridge.updateState === 'function') {
      try {
        const updated = await bridge.updateState(id, { active })
        if (updated) {
          const norm = normalizeRemoteModuleItem(updated)
          set(state => ({
            modules: state.modules.map(m => (m.id === id ? norm : m))
          }))
        }
        // 同步通知同槽位被互斥停用的插件
        for (const exId of mutuallyExcludedIds) {
          bridge.updateState(exId, { active: false }).catch(() => {})
        }
      } catch {
        // 保留乐观更新状态
      }
    }
  },

  updateUserConfig: async (id: string, userConfig: string | null) => {
    set(state => ({
      modules: state.modules.map(m => {
        if (m.id !== id) return m
        return {
          ...m,
          user_config: userConfig
        }
      })
    }))

    const bridge = getModularResourceBridge()
    if (bridge && typeof bridge.updateState === 'function') {
      try {
        const updated = await bridge.updateState(id, { userConfig })
        if (updated) {
          const norm = normalizeRemoteModuleItem(updated)
          set(state => ({
            modules: state.modules.map(m => (m.id === id ? norm : m))
          }))
        }
      } catch {
        // 保留乐观更新状态
      }
    }
  },

  updateDownloadProgress: (id: string, progress: DownloadProgress) => {
    set(state => ({
      modules: state.modules.map(m => {
        if (m.id !== id) return m
        return {
          ...m,
          install_state: m.install_state === 'active' ? 'active' : 'downloading',
          download_progress: progress
        }
      })
    }))
  },

  subscribeProgress: () => {
    const bridge = getModularResourceBridge()
    if (!bridge || typeof bridge.onProgress !== 'function') {
      return () => {}
    }
    return bridge.onProgress(evt => {
      if (evt.state === 'failed') {
        set(state => ({
          modules: state.modules.map(m =>
            m.id === evt.moduleId
              ? {
                  ...m,
                  install_state: 'error',
                  error_message: evt.errorMessage || '下载失败'
                }
              : m
          )
        }))
        return
      }
      get().updateDownloadProgress(evt.moduleId, {
        percentage: evt.percentage,
        speed_bytes_per_sec: evt.speedBytesPerSec,
        is_resumed: evt.isResumed
      })
    })
  },

  checkPendingTombstones: async () => {
    const bridge = getModularResourceBridge()
    if (!bridge || typeof bridge.getPendingTombstones !== 'function') return
    try {
      const items = await bridge.getPendingTombstones()
      const has = Array.isArray(items) && items.length > 0
      set({ pendingTombstones: items || [], hasPendingTombstones: has })
    } catch {}
  },

  restartApp: async () => {
    const bridge = getModularResourceBridge()
    if (bridge && typeof bridge.restartApp === 'function') {
      await bridge.restartApp()
    }
  },

  exportOfflinePackage: async (moduleId: string) => {
    const bridge = getModularResourceBridge()
    if (!bridge || typeof bridge.exportOfflinePackage !== 'function') return null
    return bridge.exportOfflinePackage({ moduleId })
  },

  importOfflinePackage: async (archivePath?: string) => {
    const bridge = getModularResourceBridge()
    if (!bridge || typeof bridge.importOfflinePackage !== 'function') return null
    try {
      const res = await bridge.importOfflinePackage({ archivePath })
      if (res) {
        await get().loadModules()
        return res
      }
      return null
    } catch (err: any) {
      throw err
    }
  },

  resetForTest: () => {
    set({
      isOverlayOpen: false,
      configuringModuleId: null,
      searchKeyword: '',
      selectedCategory: 'all',
      modules: INITIAL_PLUGINS,
      isLoading: false,
      isDeveloperMode: false,
      scope: 'market',
      hasPendingTombstones: false,
      pendingTombstones: []
    })
  }
}))
