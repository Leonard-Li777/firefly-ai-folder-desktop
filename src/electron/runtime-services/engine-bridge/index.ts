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