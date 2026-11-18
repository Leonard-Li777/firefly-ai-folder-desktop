/**
 * Omni Native Service - Omni Rust 原生微服务管理器
 *
 * 本文件保留为 barrel，职责分块拆分至 ./omni-service/ 子目录：
 *   - types.ts       Omni 协议类型 / 响应结构 / 受控概念标签类型
 *   - helpers.ts     broadcastOmniStatus 状态广播助手
 *   - omni-service.ts 服务主体（启动 / 请求代理 / 关闭与状态机）
 *
 * 外部导入路径保持不变：import { omniService } from './omni-service'
 */
export * from './omni-service/index'
