/**
 * TagTreeQuery 模块级共享常量与内部辅助函数
 *
 * 拆分自原 TagTreeQuery.ts 头部常量区（只搬不改，逐字节保真）。
 * 这些符号为模块内部事实源：barrel（TagTreeQuery.ts）只对外 re-export 原有公开接口，
 * 未在原文件导出的内部常量保持 internal，外部契约零变化。
 */
import { TOP_ROOT_CODES, classifyDimensionMutexScope, concept } from '@firefly/shared'

/**
 * Omni 邻接图缓存 TTL（ms）。原为 TagTreeQuery 类私有静态字段 OMNI_MAP_TTL；
 * 拆分后作为本模块单一事实源（邻接图 / 维度树两处比较层同源引用），
 * 数值与语义与原类静态字段逐字节一致（60_000）。
 */
export const OMNI_MAP_TTL = 60_000

/** 内容标签 parent_codes 为空数组的标签的逻辑父级 code */
export const CONTENT_TAGS_CODE = concept('内容标签')
/** builtin.content_tags 恒定垫底序值（与 omni fast path / 回退路径 / 前端比较层的 9999 特例口径统一） */
export const CONTENT_TAGS_TAIL_ORDER = 9999
export const escapeLike = (s: string) => s.replace(/([%_\\])/g, '\\$1')

/** 全系统顶级受控根维度集合（SSOT 事实源派生自 @firefly/shared） */
export const ROOT_DIMENSION_CODES = TOP_ROOT_CODES

/**
 * 标签级 isMultiSelect 派生（人工裁定 2026-10-18：**禁止硬编码**）。
 *
 * 虚拟目录树中「同父互斥」由父节点的 isMultiSelect 决定（virtual-directory-store.ts:356），
 * 因此标签级该值控制的是「此标签的子节点能否并存」。统一走 S0 共享分类器（单一事实源），
 * 与 §5.2「用分类器而非 group.isMultiSelect」的口径一致——不受降级路径影响，unknown 走保守分支。
 *
 * 只有多选维度的标签才允许子节点并存；规则自有 / 单选 / unknown 一律取 false（维持既有互斥行为）。
 */
export const deriveTagMultiSelect = (dimensionCode?: string | null): boolean =>
  dimensionCode ? classifyDimensionMutexScope(dimensionCode) === 'multi' : false
