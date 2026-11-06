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
  category: PluginCategory
  author_code: PluginAuthorCode
  author_name?: string | null
  availability: PluginAvailability
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

export interface PluginCenterState {
  isOverlayOpen: boolean
  configuringModuleId: string | null
  searchKeyword: string
  selectedCategory: string
  modules: PluginModuleItem[]

  // 弹层开关动作
  setOverlayOpen: (open: boolean) => void
  openOverlay: () => void
  closeOverlay: () => void
  toggleOverlay: () => void

  // 筛选与搜索
  setSearchKeyword: (keyword: string) => void
  setSelectedCategory: (category: string) => void

  // 插件管理
  setConfiguringModuleId: (id: string | null) => void
  installPlugin: (id: string) => void
  togglePluginActive: (id: string, active: boolean) => void
  updateUserConfig: (id: string, userConfig: string | null) => void
  updateDownloadProgress: (id: string, progress: DownloadProgress) => void
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
  }
]

export const usePluginCenterStore = create<PluginCenterState>((set, get) => ({
  isOverlayOpen: false,
  configuringModuleId: null,
  searchKeyword: '',
  selectedCategory: 'all',
  modules: INITIAL_PLUGINS,

  setOverlayOpen: (open: boolean) => {
    set({
      isOverlayOpen: open,
      // 关闭弹层时若在配置子界面，重置回主列表
      ...(open ? {} : { configuringModuleId: null })
    })
  },

  openOverlay: () => {
    set({ isOverlayOpen: true })
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

  installPlugin: (id: string) => {
    set(state => ({
      modules: state.modules.map(m => {
        if (m.id !== id) return m
        return {
          ...m,
          install_state: 'downloading',
          download_progress: {
            percentage: 5,
            speed_bytes_per_sec: 1024 * 1024 * 4.2,
            is_resumed: false
          }
        }
      })
    }))
  },

  togglePluginActive: (id: string, active: boolean) => {
    set(state => ({
      modules: state.modules.map(m => {
        if (m.id !== id) return m
        return {
          ...m,
          install_state: active ? 'active' : 'installed_inactive'
        }
      })
    }))
  },

  updateUserConfig: (id: string, userConfig: string | null) => {
    set(state => ({
      modules: state.modules.map(m => {
        if (m.id !== id) return m
        return {
          ...m,
          user_config: userConfig
        }
      })
    }))
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

  resetForTest: () => {
    set({
      isOverlayOpen: false,
      configuringModuleId: null,
      searchKeyword: '',
      selectedCategory: 'all',
      modules: INITIAL_PLUGINS
    })
  }
}))
