import { create } from 'zustand'

export type PluginCategory =
  | 'ai-engine'
  | 'perception'
  | 'media'
  | 'tool'
  | 'parser'
  | 'vfs-archive'
export type PluginAuthorCode = 'official' | 'community' | 'third_party'
export type PluginAvailability = 'available' | 'coming_soon' | 'unavailable'
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
  author_code: PluginAuthorCode
  author_name?: string | null
  availability: PluginAvailability
  firecore_cost?: number
  total_bytes: number
  install_state: PluginInstallState
  selected_variant?: string | null
  description: string
  icon?: string
  config_schema?: string | null
  user_config?: string | null
  error_message?: string | null
  download_progress?: DownloadProgress
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
  list: () => Promise<PluginModuleItem[]>
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
  onProgress?: (callback: (event: ModularResourceProgressPayload) => void) => () => void
}

export interface PluginCenterState {
  isOverlayOpen: boolean
  configuringModuleId: string | null
  searchKeyword: string
  selectedCategory: string
  modules: PluginModuleItem[]
  isLoading: boolean

  // 弹层开关动作
  setOverlayOpen: (open: boolean) => void
  openOverlay: () => void
  closeOverlay: () => void
  toggleOverlay: () => void

  // 筛选与搜索
  setSearchKeyword: (keyword: string) => void
  setSelectedCategory: (category: string) => void

  // 插件管理与 IPC 持久化读写
  loadModules: () => Promise<PluginModuleItem[]>
  setConfiguringModuleId: (id: string | null) => void
  installPlugin: (id: string) => Promise<void>
  uninstallPlugin: (id: string) => Promise<void>
  togglePluginActive: (id: string, active: boolean) => Promise<void>
  updateUserConfig: (id: string, userConfig: string | null) => Promise<void>
  updateDownloadProgress: (id: string, progress: DownloadProgress) => void
  subscribeProgress: () => () => void
  resetForTest: () => void
}

export const INITIAL_PLUGINS: PluginModuleItem[] = [
  {
    id: 'advanced_ai_engine',
    name: '高级本地 AI 推理引擎',
    version: '1.0.0',
    category: 'ai-engine',
    author_code: 'official',
    author_name: null,
    availability: 'available',
    total_bytes: 2314200000,
    install_state: 'active',
    description: '深度语义理解、智能重命名与多模态分析的大语言模型推理引擎',
    icon: 'Brain'
  },
  {
    id: 'offline_tts',
    name: '离线语音合成 TTS',
    version: '1.0.0',
    category: 'media',
    author_code: 'official',
    author_name: null,
    availability: 'available',
    total_bytes: 216426086, // 206.4 MB
    install_state: 'active',
    description: '高质量离线自然语音朗读、伴音生成与多语种音色克隆引擎',
    icon: 'Volume2'
  },
  {
    id: 'asr_engine',
    name: '语音识别与字幕提取 ASR',
    version: '0.9.2',
    category: 'perception',
    author_code: 'official',
    author_name: null,
    availability: 'available',
    total_bytes: 185597132,
    install_state: 'not_installed',
    description: 'SenseVoice 极速高精音频转录、富文本标点对齐与多语言语音识别',
    icon: 'Mic'
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
    description: '基于本地硬件加速的图像生成、超分辨率画面修复与视觉扩展',
    icon: 'Sparkles'
  },
  {
    id: 'cad_3d_parser',
    name: 'CAD / 3D 图纸模型解析器',
    version: '1.2.0',
    category: 'parser',
    author_code: 'official',
    author_name: null,
    availability: 'available',
    total_bytes: 94500000,
    install_state: 'not_installed',
    description: 'DWG/DXF 工程图纸与 OBJ/GLTF 三维模型离线轻量解析与缩略图渲染',
    icon: 'Box'
  },
  {
    id: 'ai_organize_skill',
    name: 'AI 整理助手与外部智能体 Skill API',
    version: '1.2.0',
    category: 'tool',
    author_code: 'official',
    author_name: null,
    availability: 'available',
    total_bytes: 0,
    install_state: 'not_installed',
    description: '对外提供本地 HTTP API 与 OpenClaw/外部智能体通信桥梁，支持渐进式语义检索、视频高光切片定位与自动化整理方案推送',
    icon: 'FolderSync'
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
    availability: raw.availability || seed?.availability || 'available',
    firecore_cost: raw.firecore_cost ?? 0,
    total_bytes: raw.total_bytes ?? seed?.total_bytes ?? 0,
    install_state: raw.install_state || 'not_installed',
    selected_variant: raw.selected_variant ?? null,
    description: raw.description || seed?.description || '',
    icon: raw.icon || seed?.icon,
    config_schema: raw.config_schema ?? null,
    user_config: raw.user_config ?? null,
    error_message: raw.error_message ?? null,
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

  setOverlayOpen: (open: boolean) => {
    set({
      isOverlayOpen: open,
      // 关闭弹层时若在配置子界面，重置回主列表
      ...(open ? {} : { configuringModuleId: null })
    })
    if (open) {
      void get().loadModules()
    }
  },

  openOverlay: () => {
    set({ isOverlayOpen: true })
    void get().loadModules()
  },

  closeOverlay: () => {
    set({ isOverlayOpen: false, configuringModuleId: null })
  },

  toggleOverlay: () => {
    const next = !get().isOverlayOpen
    set({
      isOverlayOpen: next,
      ...(next ? {} : { configuringModuleId: null })
    })
    if (next) {
      void get().loadModules()
    }
  },

  setSearchKeyword: (keyword: string) => {
    set({ searchKeyword: keyword })
  },

  setSelectedCategory: (category: string) => {
    set({ selectedCategory: category })
  },

  setConfiguringModuleId: (id: string | null) => {
    set({ configuringModuleId: id })
  },

  loadModules: async () => {
    const bridge = getModularResourceBridge()
    if (!bridge || typeof bridge.list !== 'function') {
      return get().modules
    }
    set({ isLoading: true })
    try {
      const list = await bridge.list()
      if (Array.isArray(list) && list.length > 0) {
        const normalized = list.map(normalizeRemoteModuleItem)
        set({ modules: normalized, isLoading: false })
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
            percentage: 5,
            speed_bytes_per_sec: 1024 * 1024 * 4.2,
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
    set(state => ({
      modules: state.modules.map(m => {
        if (m.id !== id) return m
        return {
          ...m,
          install_state: active ? 'active' : 'installed_inactive'
        }
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
          install_state: progress.percentage >= 100 ? 'active' : 'downloading',
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

  resetForTest: () => {
    set({
      isOverlayOpen: false,
      configuringModuleId: null,
      searchKeyword: '',
      selectedCategory: 'all',
      modules: INITIAL_PLUGINS,
      isLoading: false
    })
  }
}))
