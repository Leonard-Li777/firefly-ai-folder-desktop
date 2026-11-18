import { DatabaseQueryProxyMixin } from './database-service/query-proxy'

/**
 * 数据库服务 Facade
 * 负责 SQLite 数据库的初始化、迁移框架以及将 CRUD 操作转发给各个 DAO
 *
 * Ticket 07 拆分：shared / init / migration / query-proxy 四个内聚子文件，
 * 本文件保留原路径作为聚合出口，对外导出与导入路径完全不变。
 */
export class DatabaseService extends DatabaseQueryProxyMixin {}


/** @deprecated 向量已由 Omni zvec 托管，类型保留仅为兼容外部引用 */
export interface FileVectorRecord {
  fileFingerprint: string
  textEmbedding: Float32Array | null
  imageEmbedding: Float32Array | null
  multimodalEmbedding: Float32Array | null
  status: number
  modelVersion: string | null
  meta: Record<string, any>
  updatedAt?: string
}

/** @deprecated 向量写入请调用 Omni /api/v1/vector/upsert */
export interface SaveFileVectorInput {
  fileFingerprint: string
  textEmbedding?: Float32Array | null
  imageEmbedding?: Float32Array | null
  multimodalEmbedding?: Float32Array | null
  status?: number
  modelVersion?: string | null
  meta?: Record<string, any>
}

export const databaseService = new DatabaseService()
