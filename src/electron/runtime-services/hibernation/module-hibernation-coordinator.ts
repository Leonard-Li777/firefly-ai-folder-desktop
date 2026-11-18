/**
 * 统一模块休眠调度协调器 (ModuleHibernationCoordinator)
 * 遵循 L3 规格书: docs/specs/unified-module-hibernation-and-energy-transparency-spec.md §2.1 / §2.2
 *
 * 本文件保留为 barrel，职责分块拆分至 ./module-hibernation-coordinator/ 子目录：
 *   - types.ts                       协调器构造选项
 *   - module-hibernation-coordinator.ts 服务主体（策略判断 / 休眠执行 / 恢复执行）
 *
 * 外部导入路径保持不变。
 */
export * from './module-hibernation-coordinator/index'
