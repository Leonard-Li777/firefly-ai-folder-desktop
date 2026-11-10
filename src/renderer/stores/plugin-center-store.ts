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

export interface EnvironmentVisibility {
  isDev: boolean
  isEnterpriseOffline: boolean
  developerModeEnabled: boolean
  allowDeveloperMode: boolean
  allowLocalPluginImport: boolean
  allowOfflineImport: boolean
  allowOfflineExport: boolean
}

export interface EnvironmentVisibilityEnvelope {
  epoch: string
  revision: number
  visibility: Readonly<EnvironmentVisibility>
}

/**
 * 离线包与插件中心错误码白名单大白话字典（恪守 RULE 2.16 大白话禁术语铁律）
 */
export const PLUGIN_ERROR_MESSAGES: Record<string, string> = {
  SIGNATURE_INVALID: '插件签名校验未通过，安装包可能已被损坏或非法篡改，已安全终止。',
  ASSET_HASH_MISMATCH: '插件核心模型或资源文件校验不一致，文件可能已损坏，请重新下载或获取。',
  MODULE_ACTIVE_CONFLICT: '已有相同类型的核心插件正在运行中，请先停用当前运行的插件后再试。',
  VERSION_CONFLICT: '检测到已安装同等或更高版本的插件，无需重复安装。',
  RESOURCE_CONFLICT: '插件所需资源与现有组件存在版本冲突，无法直接覆盖。',
  QUOTA_EXCEEDED: '电脑磁盘剩余存储空间不足，无法解压或安装该插件，请清理磁盘空间后重试。',
  ZIP_ENTRY_REJECTED: '离线安装包内包含非法路径或被禁止的文件，系统已安全拦截。',
  JOB_SUPERSEDED: '已有更高优先级的离线包任务正在进行，当前操作已取消。',
  RESOURCE_DIR_INVALID: '插件资源目录命名格式不合规，安装已取消。',
  MANIFEST_INVALID: '插件描述配置文件格式有误或缺失必要信息，无法读取。',
  MANIFEST_MISSING: '离线安装包中缺少必要的插件信息描述文件。',
  BUNDLE_EMPTY: '离线总包中未包含任何可用的插件内容。',
  EXPORT_BUSY: '当前有其他离线任务正在运行，请稍候再试。',
  IMPORT_BUSY: '当前有离线包正在解压或安装中，请稍候再试。',
  VERIFICATION_CRASH_LIMIT: '离线包安全校验连续异常，为保障系统安全已停止处理该文件。',
  NETWORK_ERROR: '网络连接超时或中断，请检查网络后重试。',
  PERMISSION_DENIED: '系统权限不足，无法写入插件目录，请以管理员身份运行或检查目录权限。',
  UNSUPPORTED_ARCH: '当前电脑硬件或系统架构不受该插件支持。',
  CHECKSUM_FAILED: '文件完整性校验失败，请重新获取安装包。',
  DOWNLOAD_FAILED: '组件资源下载失败，请检查网络连接后重试。',
  MODULE_NOT_FOUND: '未找到对应的插件信息，可能已被移除。',
  UNKNOWN_ERROR: '插件操作发生未知异常，请稍后重试。',
  // 目录管理与镜像下载大白话提示 (RULE 2.16 & Spec §7.4)
  PATH_NOT_ASCII: '文件夹路径不能包含中文，请选择纯英文路径',
  PATH_HAS_WHITESPACE: '文件夹路径中不能有空格，请去掉空格后重试',
  PATH_RESERVED_DEVICE_NAME: '文件夹名称不能使用系统保留字（如 CON、PRN 等）',
  PATH_TOO_LONG: '文件夹层级太深，请选择路径更短的文件夹',
  PATH_NOT_WRITABLE: '该文件夹没有写入权限，请更换其他磁盘位置',
  PATH_NOT_A_DIRECTORY: '所选位置是一个文件，请选择一个文件夹',
  PATH_NOT_ABSOLUTE: '请选择完整的磁盘绝对路径',
  UNC_PATH_FORBIDDEN: '不支持局域网共享路径，请选择本地磁盘文件夹',
  SAME_AS_CURRENT: '所选文件夹与当前正在使用的插件目录相同，无需迁移',
  INSUFFICIENT_SPACE: '目标磁盘可用空间不足，请清理磁盘后重试',
  SYSTEM_DIR_FORBIDDEN: '不能选择系统核心文件夹或磁盘根目录，请选择普通自定义文件夹',
  DIR_CHANGE_GATE_ACTIVE: '插件目录变更需重启软件生效，暂无法进行其他操作',
  DISK_FULL_DURING_MIGRATION: '迁移过程中磁盘空间耗尽，已自动取消并安全还原',
  MIGRATION_CANCELLED: '已取消插件目录迁移，保持原目录不变',
  MIGRATION_NOT_CANCELLABLE: '目录迁移已进入最后提交阶段，无法取消，请稍候',
  HASH_MISMATCH: '文件复制过程中发现损坏，已自动安全回滚',
  SYMLINK_REJECTED: '不支持包含快捷方式或符号链接的目录',
  TARGET_MODULE_LOCKED: '目标文件夹中的旧模型文件正被其他程序占用，无法覆盖',
  NETWORK_TIMEOUT: '网络连接缓慢或超时，正在自动切换备用网络重试'
}

/**
 * 将底层错误对象或消息转换为零黑话的大白话排障提示
 */
export function formatPluginErrorMessage(error: unknown): string {
  if (!error) return PLUGIN_ERROR_MESSAGES.UNKNOWN_ERROR

  const errObj =
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : null
  const rawCode = String(errObj?.code || '')
    .trim()
    .toUpperCase()
  if (rawCode && PLUGIN_ERROR_MESSAGES[rawCode]) {
    return PLUGIN_ERROR_MESSAGES[rawCode]
  }

  const rawMessage = typeof error === 'string' ? error : String(errObj?.message || error)

  // 匹配已知错误码子串
  for (const [code, msg] of Object.entries(PLUGIN_ERROR_MESSAGES)) {
    if (rawMessage.includes(code)) {
      return msg
    }
  }

  // 常见系统异常转换
  if (rawMessage.includes('EBUSY') || rawMessage.includes('resource busy')) {
    return '文件正在被其他程序占用，请关闭相关应用后重试。'
  }
  if (rawMessage.includes('EACCES') || rawMessage.includes('permission denied')) {
    return PLUGIN_ERROR_MESSAGES.PERMISSION_DENIED
  }
  if (rawMessage.includes('ENOSPC') || rawMessage.includes('no space left')) {
    return PLUGIN_ERROR_MESSAGES.QUOTA_EXCEEDED
  }
  if (
    rawMessage.includes('ECONNRESET') ||
    rawMessage.includes('ETIMEDOUT') ||
    rawMessage.includes('fetch failed')
  ) {
    return PLUGIN_ERROR_MESSAGES.NETWORK_ERROR
  }

  // 过滤专业术语黑话（ONNX, IPC, CRC, Checksum 等）
  const sanitized = rawMessage
    .replace(/\b(ONNX|IPC|Token|Checksum|CRC32|SHA256|Ed25519)\b/gi, '')
    .trim()

  return sanitized || PLUGIN_ERROR_MESSAGES.UNKNOWN_ERROR
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
  exportOfflineBundle?: () => Promise<string | null>
  getEnvironmentVisibility?: () => Promise<EnvironmentVisibilityEnvelope>
  setDeveloperMode?: (payload: { enabled: boolean }) => Promise<EnvironmentVisibilityEnvelope>
  onEnvironmentVisibilityChanged?: (
    callback: (envelope: EnvironmentVisibilityEnvelope) => void
  ) => () => void
  pickAndImportLocalPlugin?: () => Promise<{
    canceled: boolean
    module?: PluginModuleItem
    error?: string
  }>
  pickDirectory?: () => Promise<string | null>
  getPluginDirInfo?: () => Promise<any>
  validatePluginDir?: (targetPath: string) => Promise<any>
  changePluginDir?: (targetPath: string) => Promise<any>
  cancelDirMigration?: () => Promise<any>
  cleanupOldDir?: () => Promise<any>
  dismissOldDirCleanup?: () => Promise<any>
  isOldDirCleanupDismissed?: () => Promise<any>
  onDirMigrationProgress?: (callback: (payload: any) => void) => () => void
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
  environmentVisibility: EnvironmentVisibilityEnvelope | null
  isExportingBundle: boolean
  isImportingBundle: boolean

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

  // 环境可见性与时钟防护
  applyVisibilityEnvelope: (envelope: EnvironmentVisibilityEnvelope) => boolean
  loadEnvironmentVisibility: () => Promise<EnvironmentVisibilityEnvelope | null>
  subscribeEnvironmentVisibility: () => () => void

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
  exportOfflineBundle: () => Promise<string | null>
  importOfflinePackage: (archivePath?: string) => Promise<PluginModuleItem | null>
  pickAndImportLocalPlugin: () => Promise<boolean>
  resetForTest: () => void

  // 目录管理与安全迁移状态 (Issue 02 - 06)
  dirInfo: any | null
  dirPhase: 'STABLE' | 'MIGRATING' | 'PENDING_RESTART'
  isOldDirCleanupDismissed: boolean
  dirMigrationProgress: any | null
  pickDirectory: () => Promise<string | null>
  loadDirInfo: () => Promise<any | null>
  validatePluginDir: (targetPath: string) => Promise<any>
  changePluginDir: (targetPath: string) => Promise<any>
  cancelDirMigration: () => Promise<any>
  cleanupOldDir: () => Promise<any>
  dismissOldDirCleanup: () => Promise<void>
  subscribeDirMigrationProgress: () => () => void
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
      '【办公轻薄本标配】支持智能文件名深度润色、描述提取与内容深度解析，如果已启用萤核引擎则不需要此插件。',
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
  if (typeof window !== 'undefined') {
    if ((window as any).electronAPI?.modularResource) {
      return (window as any).electronAPI.modularResource as IModularResourceBridge
    }
    if ((window as any).modularResource) {
      return (window as any).modularResource as IModularResourceBridge
    }
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

async function syncDevModeFromBridge(
  set: (state: Partial<PluginCenterState>) => void
): Promise<boolean> {
  const bridge = getModularResourceBridge()
  if (bridge && typeof bridge.getDevMode === 'function') {
    try {
      const res = await bridge.getDevMode()
      const isDev =
        typeof res === 'boolean'
          ? res
          : Boolean((res as any)?.devModeEffective ?? (res as any)?.enabled)
      set({ isDeveloperMode: isDev })
      return isDev
    } catch {
      // 忽略探活异常
    }
  }
  return false
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
  environmentVisibility: null,
  isExportingBundle: false,
  isImportingBundle: false,
  hasPendingTombstones: false,
  pendingTombstones: [],

  setOverlayOpen: async (open: boolean) => {
    set({
      isOverlayOpen: open,
      // 关闭弹层时若在配置子界面，重置回主列表
      ...(open ? {} : { configuringModuleId: null })
    })
    if (open) {
      await get().loadEnvironmentVisibility()
      await syncDevModeFromBridge(set)
      await get().loadModules()
    }
  },

  openOverlay: async () => {
    set({ isOverlayOpen: true })
    await get().loadEnvironmentVisibility()
    await syncDevModeFromBridge(set)
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
      await get().loadEnvironmentVisibility()
      await syncDevModeFromBridge(set)
      await get().loadModules()
    }
  },

  setSearchKeyword: (keyword: string) => {
    set({ searchKeyword: keyword })
  },

  setSelectedCategory: (category: string) => {
    set({ selectedCategory: category })
  },

  applyVisibilityEnvelope: (envelope: EnvironmentVisibilityEnvelope) => {
    if (!envelope || typeof envelope !== 'object') return false
    const current = get().environmentVisibility
    // 双锚定时钟防护：仅当跨 epoch 或同一 epoch 内 revision 递增时才采纳
    if (!current || envelope.epoch !== current.epoch || envelope.revision > current.revision) {
      set({
        environmentVisibility: envelope,
        isDeveloperMode: !!envelope.visibility?.developerModeEnabled
      })
      return true
    }
    // 旧 revision 迟到或倒流，丢弃更新
    return false
  },

  loadEnvironmentVisibility: async () => {
    const bridge = getModularResourceBridge()
    if (!bridge || typeof bridge.getEnvironmentVisibility !== 'function') return null
    try {
      const envelope = await bridge.getEnvironmentVisibility()
      if (envelope) {
        get().applyVisibilityEnvelope(envelope)
        return envelope
      }
      return null
    } catch {
      return null
    }
  },

  subscribeEnvironmentVisibility: () => {
    const bridge = getModularResourceBridge()
    if (!bridge || typeof bridge.onEnvironmentVisibilityChanged !== 'function') {
      return () => undefined
    }
    return bridge.onEnvironmentVisibilityChanged(envelope => {
      get().applyVisibilityEnvelope(envelope)
    })
  },

  setDeveloperMode: async (enabled: boolean) => {
    set({ isDeveloperMode: enabled })
    const bridge = getModularResourceBridge()
    if (bridge) {
      if (typeof bridge.setDeveloperMode === 'function') {
        try {
          const envelope = await bridge.setDeveloperMode({ enabled })
          if (envelope) {
            get().applyVisibilityEnvelope(envelope)
          }
        } catch {
          // 降级忽略
        }
      } else if (typeof bridge.setDevMode === 'function') {
        try {
          await bridge.setDevMode({ enabled })
        } catch {
          // 降级忽略
        }
      }
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
          .catch(() => undefined)
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
            .catch(() => undefined)
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
          bridge.updateState(exId, { active: false }).catch(() => undefined)
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
      return () => undefined
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
    } catch {
      // 忽略墓碑读取异常
    }
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

  exportOfflineBundle: async () => {
    const bridge = getModularResourceBridge()
    if (!bridge || typeof bridge.exportOfflineBundle !== 'function') return null
    set({ isExportingBundle: true })
    try {
      return await bridge.exportOfflineBundle()
    } finally {
      set({ isExportingBundle: false })
    }
  },

  importOfflinePackage: async (archivePath?: string) => {
    const bridge = getModularResourceBridge()
    if (!bridge || typeof bridge.importOfflinePackage !== 'function') return null
    set({ isImportingBundle: true })
    try {
      const res = await bridge.importOfflinePackage({ archivePath })
      if (res) {
        await get().loadModules()
        return res
      }
      return null
    } finally {
      set({ isImportingBundle: false })
    }
  },

  // 目录管理与安全迁移状态 (Issue 02 - 06)
  dirInfo: null,
  dirPhase: 'STABLE',
  isOldDirCleanupDismissed: false,
  dirMigrationProgress: null,

  pickDirectory: async () => {
    const bridge = getModularResourceBridge()
    if (!bridge || typeof bridge.pickDirectory !== 'function') {
      return null
    }
    return await bridge.pickDirectory()
  },

  loadDirInfo: async () => {
    const bridge = getModularResourceBridge()
    if (!bridge || typeof bridge.getPluginDirInfo !== 'function') return null
    try {
      const info = await bridge.getPluginDirInfo()
      if (info) {
        set({ dirInfo: info, dirPhase: info.phase || 'STABLE' })
      }
      if (typeof bridge.isOldDirCleanupDismissed === 'function') {
        const dismissed = await bridge.isOldDirCleanupDismissed()
        set({ isOldDirCleanupDismissed: !!dismissed })
      }
      return info
    } catch {
      return null
    }
  },

  validatePluginDir: async (targetPath: string) => {
    const bridge = getModularResourceBridge()
    if (!bridge || typeof bridge.validatePluginDir !== 'function') {
      return { valid: false, errorCode: 'PATH_NOT_WRITABLE', errorMessage: 'Bridge unavailable' }
    }
    return await bridge.validatePluginDir(targetPath)
  },

  changePluginDir: async (targetPath: string) => {
    const bridge = getModularResourceBridge()
    if (!bridge || typeof bridge.changePluginDir !== 'function') {
      return { success: false, errorCode: 'PATH_NOT_WRITABLE' }
    }
    set({ dirPhase: 'MIGRATING' })
    try {
      const res = await bridge.changePluginDir(targetPath)
      await get().loadDirInfo()
      return res
    } catch (err: any) {
      await get().loadDirInfo()
      return { success: false, errorCode: err?.code || 'UNKNOWN_ERROR' }
    }
  },

  cancelDirMigration: async () => {
    const bridge = getModularResourceBridge()
    if (!bridge || typeof bridge.cancelDirMigration !== 'function') {
      return { cancelled: false }
    }
    const res = await bridge.cancelDirMigration()
    await get().loadDirInfo()
    return res
  },

  cleanupOldDir: async () => {
    const bridge = getModularResourceBridge()
    if (!bridge || typeof bridge.cleanupOldDir !== 'function') {
      return { success: false, freedBytes: 0 }
    }
    const res = await bridge.cleanupOldDir()
    await get().loadDirInfo()
    return res
  },

  dismissOldDirCleanup: async () => {
    const bridge = getModularResourceBridge()
    if (bridge && typeof bridge.dismissOldDirCleanup === 'function') {
      await bridge.dismissOldDirCleanup()
    }
    set({ isOldDirCleanupDismissed: true })
  },

  subscribeDirMigrationProgress: () => {
    const bridge = getModularResourceBridge()
    if (!bridge || typeof bridge.onDirMigrationProgress !== 'function') {
      return () => {}
    }
    return bridge.onDirMigrationProgress((payload: any) => {
      set({ dirMigrationProgress: payload })
      if (payload) {
        const isDone =
          payload.phase === 'DONE' ||
          (payload.phase === 'committing' && (payload.percentage ?? 0) >= 100)
        set({ dirPhase: isDone ? 'PENDING_RESTART' : 'MIGRATING' })
      }
    })
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
      environmentVisibility: null,
      isExportingBundle: false,
      isImportingBundle: false,
      hasPendingTombstones: false,
      pendingTombstones: [],
      dirInfo: null,
      dirPhase: 'STABLE',
      isOldDirCleanupDismissed: false,
      dirMigrationProgress: null
    })
  }
}))
