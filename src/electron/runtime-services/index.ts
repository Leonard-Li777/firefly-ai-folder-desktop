/**
 * 运行时服务公共 API
 * 提供数据库、文件系统、系统服务等平台集成服务
 * 
 * 注意：此包不依赖 Electron，所有 Electron 特定功能由调用方注入
 */

// 数据库服务
export * from './database'

// 文件系统服务
export * from './filesystem'

// 系统服务
export * from './system'

// 配置服务保留在 apps/desktop 中,通过依赖注入或平台适配器访问
// export * from './config'

// 错误处理
export * from './error'

// 工具函数
export * from './utils'

// 集成服务
export * from './integration'
export * from './llama'
export * from './invitation/invitation-service'

