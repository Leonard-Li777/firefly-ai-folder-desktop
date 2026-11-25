import type { IModuleRuntimeStore } from '../module-runtime-store'
import type { LeaseRegistry } from '../lease-registry'
import type { MemoryProbe } from '../memory-probe'
import type { IEngineBridgeService, IPowerMonitorService } from '../types'

export interface OmniLifecycleProvider {
  ensureRunning(): Promise<boolean>
  getGeneration(): number
  isReady?: () => boolean
}

export interface ModuleHibernationCoordinatorOptions {
  runtimeStore?: IModuleRuntimeStore
  leaseRegistry?: LeaseRegistry
  memoryProbe?: MemoryProbe
  engineBridgeService?: IEngineBridgeService
  omniLifecycle?: OmniLifecycleProvider
  onClusterActivityChanged?: (clusterId: 'analysis_suite' | 'tts_media') => void
  coldStartTimeoutMsProvider?: (targetId?: string) => number
  powerMonitorService?: IPowerMonitorService
  getSystemIdleTime?: () => number
  getFreeMemory?: () => number
  getTotalMemory?: () => number
}
