/**
 * 引擎桥接服务模块出口
 */
export {
  EngineBridgeService,
  engineBridgeService,
  TIER2_ENGINE_PORT
} from './engine-bridge-service'
// Tier2EngineStatus / EngineBridgeSnapshot 为纯类型，须用 type 方式重导出
export type { Tier2EngineStatus, EngineBridgeSnapshot } from './engine-bridge-service'
// Tier2CircuitState / Tier2CircuitBreakerOptions 为纯类型，须用 type 方式重导出
export type { Tier2CircuitState, Tier2CircuitBreakerOptions } from './tier2-circuit-breaker'
export {
  EngineSwappingCoordinator,
  engineSwappingCoordinator,
  EngineNotAvailableError,
  registerEngineReadinessChecker,
  __resetEngineReadinessCheckerForTest,
  runWithEngineGateContext,
  resolveEngineGateChannel,
  executeWithEngineTransportGate,
  withEngineGate,
  isAvailableForInference,
  parseRetryAfter
} from './engine-swapping-coordinator'
export type {
  EngineWorkerStatus,
  EngineMetricsSnapshot,
  EngineCapability,
  EngineReadinessStatus,
  EngineGateIntent,
  EngineGateContext,
  IEngineReadinessChecker
} from './engine-swapping-coordinator'
export {
  matchesEngineTargetMode,
  waitForEngineStatusReactive,
  createAbortError,
  SHARED_STARTUP_HARD_TIMEOUT_MS,
  DEFAULT_ENSURE_MODE_TIMEOUT_MS,
  DEFAULT_KICK_ACK_TIMEOUT_MS,
  DEFAULT_STOPPED_DEBOUNCE_MS
} from './engine-readiness-barrier'
export type {
  EngineTargetMode,
  EnsureReadyOptions,
  EnsureReadyResult,
  WaitForEngineStatusReactiveParams
} from './engine-readiness-barrier'
export {
  ProcessTreeManager,
  processTreeManager,
  formatJobObjectName,
  PID_REUSE_TOLERANCE_MS,
  DefaultPlatformProcessTreeDriver
} from './process-tree-manager'
export type { IPlatformProcessTreeDriver, ProcessTreeManagerOptions } from './process-tree-manager'
