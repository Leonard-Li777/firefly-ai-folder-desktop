import { BUILTIN_MODULE_CATALOG_META, buildResourceSpecFromCatalog } from '@firefly/shared'
import type { CatalogModuleEntry } from './types'

/**
 * 本地离线内置插件目录种子 (IN-04 纯离线兜底 SSOT)
 * 所有模块资源规格、字节数与 `_shared` 相对路径严格派生自 `@firefly/shared` 单一事实源。
 */
export const DEFAULT_CATALOG_SEEDS: CatalogModuleEntry[] = [
  // 1. 检索式引擎：经典轻量极速档 (二选一必选)
  {
    id: BUILTIN_MODULE_CATALOG_META.engine_classic_light.id,
    name: '经典轻量语义搜索',
    description:
      '【通过意思找文件与图片】根据你描述的大致意思快速搜索照片和文档。占用极少内存，即使老电脑和低配轻薄本也能流畅运行。',
    icon: 'Feather',
    kind: 'builtin-module',
    version: BUILTIN_MODULE_CATALOG_META.engine_classic_light.version,
    catalog_version: BUILTIN_MODULE_CATALOG_META.engine_classic_light.catalogVersion,
    category: BUILTIN_MODULE_CATALOG_META.engine_classic_light.category,
    capability_slot: BUILTIN_MODULE_CATALOG_META.engine_classic_light.capabilitySlot,
    slot_policy: BUILTIN_MODULE_CATALOG_META.engine_classic_light.slotPolicy,
    backend_type: BUILTIN_MODULE_CATALOG_META.engine_classic_light.backendType,
    author_code: 'official',
    total_bytes: BUILTIN_MODULE_CATALOG_META.engine_classic_light.totalBytes,
    install_state: 'not_installed',
    contributes: {
      settings: {
        scope: 'workspace',
        tabTitle: '基础 AI 引擎',
        componentId: 'basic_ai_engine',
        priority: 10
      }
    },
    resources: BUILTIN_MODULE_CATALOG_META.engine_classic_light.resourceIds.map(
      buildResourceSpecFromCatalog
    )
  },
  // 2. 检索式引擎：统一全模态档 (二选一必选)
  {
    id: BUILTIN_MODULE_CATALOG_META.engine_gemma_unified.id,
    name: '高精度全能语义搜索',
    description:
      '【更聪明的全能搜索大脑】对复杂句子和图片的理解更深入精准，找东西更懂你的心思。推荐 8GB 或以上内存电脑使用。',
    icon: 'Layers',
    kind: 'builtin-module',
    version: BUILTIN_MODULE_CATALOG_META.engine_gemma_unified.version,
    catalog_version: BUILTIN_MODULE_CATALOG_META.engine_gemma_unified.catalogVersion,
    category: BUILTIN_MODULE_CATALOG_META.engine_gemma_unified.category,
    capability_slot: BUILTIN_MODULE_CATALOG_META.engine_gemma_unified.capabilitySlot,
    slot_policy: BUILTIN_MODULE_CATALOG_META.engine_gemma_unified.slotPolicy,
    backend_type: BUILTIN_MODULE_CATALOG_META.engine_gemma_unified.backendType,
    author_code: 'official',
    total_bytes: BUILTIN_MODULE_CATALOG_META.engine_gemma_unified.totalBytes,
    install_state: 'not_installed',
    contributes: {
      settings: {
        scope: 'workspace',
        tabTitle: '基础 AI 引擎',
        componentId: 'basic_ai_engine',
        priority: 10
      }
    },
    resources: BUILTIN_MODULE_CATALOG_META.engine_gemma_unified.resourceIds.map(
      buildResourceSpecFromCatalog
    )
  },
  // 3. 生成式引擎：轻量 CPU 引擎 (Pocket CPU)
  {
    id: BUILTIN_MODULE_CATALOG_META['pocket-cpu-int8-onnx'].id,
    name: '轻量CPU引擎',
    description:
      '【办公轻薄本标配】内存仅占约400MB，0门槛秒级响应，完全离线私密。支持智能文件名深度润色、描述提取与内容深度解析。',
    icon: 'Cpu',
    kind: 'builtin-module',
    version: BUILTIN_MODULE_CATALOG_META['pocket-cpu-int8-onnx'].version,
    catalog_version: BUILTIN_MODULE_CATALOG_META['pocket-cpu-int8-onnx'].catalogVersion,
    category: BUILTIN_MODULE_CATALOG_META['pocket-cpu-int8-onnx'].category,
    capability_slot: BUILTIN_MODULE_CATALOG_META['pocket-cpu-int8-onnx'].capabilitySlot,
    slot_policy: BUILTIN_MODULE_CATALOG_META['pocket-cpu-int8-onnx'].slotPolicy,
    backend_type: BUILTIN_MODULE_CATALOG_META['pocket-cpu-int8-onnx'].backendType,
    author_code: 'official',
    availability: BUILTIN_MODULE_CATALOG_META['pocket-cpu-int8-onnx'].availability,
    total_bytes: BUILTIN_MODULE_CATALOG_META['pocket-cpu-int8-onnx'].totalBytes,
    install_state: 'not_installed',
    contributes: {
      settings: {
        scope: 'global',
        tabTitle: '生成式引擎',
        componentId: 'ai_engine_config',
        priority: 15
      }
    },
    resources: BUILTIN_MODULE_CATALOG_META['pocket-cpu-int8-onnx'].resourceIds.map(
      buildResourceSpecFromCatalog
    )
  },
  // 4. 感知分析模型：敏感内容与安全识别
  {
    id: BUILTIN_MODULE_CATALOG_META.perception_nsfw.id,
    name: '敏感内容过滤与安全识别',
    description:
      '【私密与敏感图文标记】自动识别私密敏感图片与包含露骨敏感描述的文档/AIGC文本并打上标记，防止投屏查看时尴尬。所有电脑均可极速运行。',
    icon: 'ShieldAlert',
    kind: 'builtin-module',
    version: BUILTIN_MODULE_CATALOG_META.perception_nsfw.version,
    catalog_version: BUILTIN_MODULE_CATALOG_META.perception_nsfw.catalogVersion,
    category: BUILTIN_MODULE_CATALOG_META.perception_nsfw.category,
    capability_slot: BUILTIN_MODULE_CATALOG_META.perception_nsfw.capabilitySlot,
    slot_policy: BUILTIN_MODULE_CATALOG_META.perception_nsfw.slotPolicy,
    backend_type: BUILTIN_MODULE_CATALOG_META.perception_nsfw.backendType,
    author_code: 'official',
    total_bytes: BUILTIN_MODULE_CATALOG_META.perception_nsfw.totalBytes,
    install_state: 'not_installed',
    contributes: {
      settings: {
        scope: 'workspace',
        tabTitle: '文件内容萃取',
        componentId: 'content_extraction',
        priority: 20
      }
    },
    resources: BUILTIN_MODULE_CATALOG_META.perception_nsfw.resourceIds.map(
      buildResourceSpecFromCatalog
    )
  },
  // 5. 语音识别与字幕提取 ASR
  {
    id: BUILTIN_MODULE_CATALOG_META.asr_sensevoice_onnx.id,
    name: '语音识别与字幕提取',
    description:
      '【录音与视频自动转文字】听懂视频和录音里的说话内容并提取字幕，可以直接搜索“某句话是谁说的”。较耗算力，推荐 16GB 内存或有显卡。',
    icon: 'Mic',
    kind: 'builtin-module',
    version: BUILTIN_MODULE_CATALOG_META.asr_sensevoice_onnx.version,
    catalog_version: BUILTIN_MODULE_CATALOG_META.asr_sensevoice_onnx.catalogVersion,
    category: BUILTIN_MODULE_CATALOG_META.asr_sensevoice_onnx.category,
    capability_slot: BUILTIN_MODULE_CATALOG_META.asr_sensevoice_onnx.capabilitySlot,
    slot_policy: BUILTIN_MODULE_CATALOG_META.asr_sensevoice_onnx.slotPolicy,
    backend_type: BUILTIN_MODULE_CATALOG_META.asr_sensevoice_onnx.backendType,
    author_code: 'official',
    total_bytes: BUILTIN_MODULE_CATALOG_META.asr_sensevoice_onnx.totalBytes,
    install_state: 'not_installed',
    contributes: {
      settings: {
        scope: 'workspace',
        tabTitle: '文件内容萃取',
        componentId: 'content_extraction',
        priority: 25
      }
    },
    resources: BUILTIN_MODULE_CATALOG_META.asr_sensevoice_onnx.resourceIds.map(
      buildResourceSpecFromCatalog
    )
  },
  // 6. 离线语音合成 TTS (Moss-TTS 与 M5-TTS)
  {
    id: BUILTIN_MODULE_CATALOG_META.tts_moss_onnx.id,
    name: '个性化声音克隆与朗读',
    availability: 'draft',
    description:
      '【支持克隆专属声音】内置声音提取器，上传一段录音即可克隆专属声音朗读文章。支持 50+ 款精选音色与自定义克隆。',
    icon: 'Volume2',
    kind: 'builtin-module',
    version: BUILTIN_MODULE_CATALOG_META.tts_moss_onnx.version,
    catalog_version: BUILTIN_MODULE_CATALOG_META.tts_moss_onnx.catalogVersion,
    category: BUILTIN_MODULE_CATALOG_META.tts_moss_onnx.category,
    capability_slot: BUILTIN_MODULE_CATALOG_META.tts_moss_onnx.capabilitySlot,
    slot_policy: BUILTIN_MODULE_CATALOG_META.tts_moss_onnx.slotPolicy,
    backend_type: BUILTIN_MODULE_CATALOG_META.tts_moss_onnx.backendType,
    author_code: 'official',
    total_bytes: BUILTIN_MODULE_CATALOG_META.tts_moss_onnx.totalBytes,
    install_state: 'not_installed',
    contributes: {
      settings: {
        scope: 'global',
        tabTitle: '个性化声音克隆',
        componentId: 'tts',
        priority: 30
      }
    },
    resources: BUILTIN_MODULE_CATALOG_META.tts_moss_onnx.resourceIds.map(
      buildResourceSpecFromCatalog
    )
  },
  {
    id: BUILTIN_MODULE_CATALOG_META.tts_m5_onnx.id,
    name: '极速语音合成与朗读',
    description:
      '【极速省电朗读】按下播放毫秒级即刻发声，内置 50+ 丰富高品质声线，长篇文档朗读流畅不卡顿。普通轻薄本流畅运行。',
    icon: 'Zap',
    kind: 'builtin-module',
    version: BUILTIN_MODULE_CATALOG_META.tts_m5_onnx.version,
    catalog_version: BUILTIN_MODULE_CATALOG_META.tts_m5_onnx.catalogVersion,
    category: BUILTIN_MODULE_CATALOG_META.tts_m5_onnx.category,
    capability_slot: BUILTIN_MODULE_CATALOG_META.tts_m5_onnx.capabilitySlot,
    slot_policy: BUILTIN_MODULE_CATALOG_META.tts_m5_onnx.slotPolicy,
    backend_type: BUILTIN_MODULE_CATALOG_META.tts_m5_onnx.backendType,
    author_code: 'official',
    author_name: null,
    availability: BUILTIN_MODULE_CATALOG_META.tts_m5_onnx.availability,
    firecore_cost: 0,
    total_bytes: BUILTIN_MODULE_CATALOG_META.tts_m5_onnx.totalBytes,
    install_state: 'not_installed',
    contributes: {
      settings: {
        scope: 'global',
        tabTitle: '极速语音朗读',
        componentId: 'tts',
        priority: 30
      }
    },
    resources: BUILTIN_MODULE_CATALOG_META.tts_m5_onnx.resourceIds.map(buildResourceSpecFromCatalog)
  }
]
