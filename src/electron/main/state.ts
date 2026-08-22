import { BrowserWindow } from 'electron'
import type { ILlamaIndexAIService } from '@firefly/types'
import type { ICoreEngine } from '@firefly/core-engine'
import { AnalyzedDirectoryService } from '../runtime-services/filesystem/analyzed-directory-service/index'
import { VirtualDirectoryService } from '../runtime-services/filesystem/virtual-directory-service/index'
import { DirectoryContextService } from '../runtime-services/filesystem/directory-context-service'
import { OrganizeRealDirectoryService } from '../runtime-services/filesystem/organize-real-directory-service/index'
import { FileCleanupService } from '../runtime-services/filesystem/file-cleanup-service'

// Global service instances
export let globalLlamaIndexService: ILlamaIndexAIService | null = null
export function setGlobalLlamaIndexService(service: ILlamaIndexAIService | null) {
  globalLlamaIndexService = service
}

export let coreEngine: ICoreEngine | null = null
export function setCoreEngine(engine: ICoreEngine | null) {
  coreEngine = engine
}

export const analyzedDirectoryService = new AnalyzedDirectoryService()
export const virtualDirectoryService = new VirtualDirectoryService()

export let directoryContextService: DirectoryContextService | null = null
export function setDirectoryContextService(service: DirectoryContextService | null) {
  directoryContextService = service
}

export let organizeRealDirectoryService: OrganizeRealDirectoryService | null = null
export function setOrganizeRealDirectoryService(service: OrganizeRealDirectoryService | null) {
  organizeRealDirectoryService = service
}

export let fileCleanupService: FileCleanupService | null = null
export function setFileCleanupService(service: FileCleanupService | null) {
  fileCleanupService = service
}

// State and caches
export const organizePlanAbortControllers = new Map<string, AbortController>()
// Reorganize 暂停/结束控制标志（key: virtualDirectoryId）
export const reorganizePauseFlags = new Map<number, boolean>()
export const reorganizeEndFlags = new Map<number, boolean>()
// 硬件加速后端描述缓存统一由 AI 包维护（llama-engine-service 等包内代码写入），
// 此处 re-export 包内绑定，避免迁移后出现两份独立状态导致 Footer 无法感知 CUDA 等后端
export {
  activeHardwareBackendCache,
  setActiveHardwareBackendCache
} from '@firefly/electron-llamaIndex-service'

export const syncedDirectories = new Set<string>()

export const cliForceConfigStage =
  process.argv.includes('--force-config-stage') ||
  process.env.FORCE_CONFIG_STAGE === '1' ||
  process.env.FORCE_CONFIG_STAGE?.toLowerCase() === 'true'

export let initializationPhaseStarted = false
export function setInitializationPhaseStarted(started: boolean) {
  initializationPhaseStarted = started
}

export let earlyInitializationPromise: Promise<void> | null = null
export function setEarlyInitializationPromise(promise: Promise<void> | null) {
  earlyInitializationPromise = promise
}
