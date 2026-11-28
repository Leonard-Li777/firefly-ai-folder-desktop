/**
 * 维度树工具统一出口（R-27 / W6 物理拆分后的桶文件）
 *
 * 原单体（1825 行）已按职责拆为三个内聚子模块，本文件仅做稳定出口转发，
 * 所有既有 `import { ... } from './dimension-tree-utils'` 调用点零改动：
 * - `dimension-tree/dimension-keys`：编码路径归一化、标签 key 解析与顶层主干排序权重
 * - `dimension-tree/dimension-build`：父子索引聚合、层级嵌套、分支特化与维度树构建
 * - `dimension-tree/dimension-select`：可见/隐藏标签筛选、选中集还原与缩放 key 迁移
 *
 * 依赖方向单向（keys ← build ← select），严禁反向引用形成循环。
 */
export * from './dimension-tree/dimension-keys'
export * from './dimension-tree/dimension-build'
export * from './dimension-tree/dimension-select'
