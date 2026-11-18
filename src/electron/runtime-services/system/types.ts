import type {
  ModuleKind,
  ModuleCategory,
  ModuleInstallState,
  ModuleAuthorCode,
  ModuleAvailability,
  PluginCapabilitySlot,
  SlotPolicy,
  BackendType,
  EmbeddingEpochRecord
} from '../database/dao/modular-resource-dao'
import type {
  DirRuntimePhase,
  PluginDirErrorCode,
  PluginDirInfo,
  ValidatePluginDirResult
} from '@firefly/types/config-types'
import type { VerifiedDownloadResult, DirMigrationProgressPayload } from './file-download-service'

export type { PluginCapabilitySlot, SlotPolicy, BackendType, EmbeddingEpochRecord }
export type {
  VerifiedDownloadResult,
  DirRuntimePhase,
  PluginDirErrorCode,
  PluginDirInfo,
  ValidatePluginDirResult,
  DirMigrationProgressPayload,
  ModuleKind,
  ModuleCategory,
  ModuleInstallState,
  ModuleAuthorCode,
  ModuleAvailability
}

export interface CatalogResourceSpec {
  resource_id: string
  asset_name: string
  target_local_path?: string
  active_source_key?: 'auto' | 'cn' | 'global'
  active_url?: string
  expected_bytes: number
  expected_sha256: string
}

export interface CatalogModuleEntry {
  id: string
  name?: string
  description?: string
  icon?: string
  kind?: ModuleKind
  version: string
  catalog_version: number
  category: ModuleCategory
  capability_slot?: PluginCapabilitySlot
  slot_policy?: SlotPolicy
  backend_type?: BackendType
  author_code?: ModuleAuthorCode
  author_name?: string | null
  availability?: ModuleAvailability
  delist_reason?: 'general_deprecation' | 'security_violation' | null
  firecore_cost?: number
  total_bytes: number
  catalog_meta_json?: string | Record<string, unknown> | null
  config_schema?: string | Record<string, unknown> | null
  install_state?: ModuleInstallState
  selected_variant?: string | null
  install_path?: string | null
  resources?: CatalogResourceSpec[]
  contributes?: {
    settings?: import('@firefly/types').PluginSettingsContribution
  }
}

export interface ModuleDownloadProgressEvent {
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

import type {
  BuiltinModuleRecord,
  ResourceDownloadRecord
} from '../database/dao/modular-resource-dao'

export interface BuiltinModuleView extends BuiltinModuleRecord {
  name: string
  description: string
  icon?: string
  is_running?: boolean
  is_usable?: boolean
  can_activate?: boolean
  can_install?: boolean
  can_uninstall?: boolean
  hold_reasons?: string[]
  validation_status?: 'ready' | 'pending_validation' | 'pending_repair' | 'legacy'
  validation_message?: string
  resources: ResourceDownloadRecord[]
  download_progress?: {
    percentage: number
    speed_bytes_per_sec: number
    is_resumed: boolean
  }
  contributes?: {
    settings?: import('@firefly/types').PluginSettingsContribution
  }
}

export type FastReadyStatus = 'ready_fast' | 'legacy_heal' | 'pending_repair' | 'pending_validation'

export interface ResourceValidationEntry {
  resourceId: string
  sharedSubDir: string
  physicalDir: string | null
  status: FastReadyStatus | 'unknown_resource'
  validationLevel: 'full' | 'legacy'
  reason?: string
  checkedAt: number
}

export interface FastReadyBarrierResult {
  rootStatus: 'ready' | 'unavailable'
  readyResources: ResourceValidationEntry[]
  legacyHealResources: ResourceValidationEntry[]
  pendingValidationResources: ResourceValidationEntry[]
  pendingRepairResources: ResourceValidationEntry[]
  timedOut: boolean
  elapsedMs: number
}

export interface TopologyChangeNotificationOptions {
  moduleId?: string
  reason?: string
  restartPolicy?: 'restart' | 'ensure-running' | 'stop-if-unused'
}

export type TopologyChangeHandler = (
  opts: TopologyChangeNotificationOptions
) => Promise<void> | void
