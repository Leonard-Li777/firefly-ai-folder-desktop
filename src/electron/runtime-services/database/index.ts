/**
 * runtime-services 数据库服务导出
 */

export { DatabaseService, databaseService } from './database-service'
export { migrations } from './database'

// 导出类型
export type { Database } from 'better-sqlite3'
