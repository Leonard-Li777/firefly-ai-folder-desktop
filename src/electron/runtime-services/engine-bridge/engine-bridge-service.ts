/**
 * Engine Bridge Service - 桌面端与 Tier 2 上层 AI 引擎的桥接服务
 *
 * 本文件保留为 barrel，职责分块拆分至 ./engine-bridge-service/ 子目录：
 *   - constants.ts            引擎协议端点 / 超时 / 探测参数常量
 *   - types.ts                Tier2EngineStatus / EngineBridgeSnapshot 状态类型
 *   - engine-bridge-service.ts 服务主体（探活 / 拉起 / 请求代理 / 状态机）
 *
 * 外部导入路径保持不变：import { engineBridgeService } from './engine-bridge-service'
 */
export * from './engine-bridge-service/index'
