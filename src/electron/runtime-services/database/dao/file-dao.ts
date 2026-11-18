import type { Database } from 'better-sqlite3'
import { FileDaoSharedBase } from './file-dao/shared'
import { FileCrudMixin } from './file-dao/file-crud'
import { FileQueryMixin } from './file-dao/file-query'
import { FileVideoMixin } from './file-dao/file-video'

/**
 * FileDao（Ticket 10 · 大文件模块化拆分）。
 *
 * 原单文件 2702 行按职责边界拆为三个 mixin：
 *   - `file-dao/file-crud.ts`  — 文件基础 CRUD / 分析结果读写 / FTS 检索语句；
 *   - `file-dao/file-query.ts` — 拼音索引 / FTS 标签同步；
 *   - `file-dao/file-video.ts` — 视频时序切片 / 视频片段调度。
 * 共享字段与展示名解析收敛于 `file-dao/shared.ts`（FileDaoSharedBase）。
 *
 * 本文件保留原路径作为聚合出口：采用「共享基类 → CRUD → 查询/拼音 → 视频 → FileDao」的线性继承链，
 * `this` 类型完整、运行时方法齐全，对外导出（FileDao / MAX_SEGMENT_ATTEMPTS / VideoCoverageStats）
 * 与外部导入路径完全不变，属「移动不改逻辑」重构。
 */

export { MAX_SEGMENT_ATTEMPTS, VideoCoverageStats } from './file-dao/shared'

export class FileDao extends FileVideoMixin {
  constructor(db: Database) {
    super(db)
  }
}
