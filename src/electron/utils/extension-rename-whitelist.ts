/**
 * macOS 文档软件专有格式改名保护白名单（穷举，2026-10-16 用户裁定）
 *
 * 背景：Apple iWork 三件套及众多 macOS 文档软件的专有格式**物理上就是 ZIP 压缩包**
 * （OPCF/zip 内核单文件包，`PK\x03\x04` 魔数）。两条扩展名检测链路都会因此误判：
 * 1. 批量更名检测（analysis-queue-service `checkExtensionMismatch`）：Magika 将
 *    `.key`/`.numbers`/`.pages` 等判为 zip，导致它们进入「扩展名不匹配」改名列表；
 * 2. Omni 批量清理（czkawka BadExtensions / desktop `fix_extension` 魔法嗅探）：
 *    同样会把 PK 魔数判为「真实扩展名 zip」并提示改名。
 * 一旦改名，文件即失去应用关联、无法打开（内容虽仍是 zip，但格式语义被破坏）。
 *
 * 本白名单穷举此类扩展名（小写、不带点）。**规则**：命中白名单的扩展名
 * 禁止进入任何改名列表、禁止触发 fix_extension 改名动作（ADR-0008）。
 * 新增同类格式时必须同步更新两侧白名单（本文件 + omni-cleanup 的
 * BAD_EXTENSION_PROTECTED_EXTS），并补充单测。
 */

/** 物理为 ZIP 压缩包、但绝不可改名的 macOS 文档软件专有扩展名（小写、不带点） */
export const ZIP_BUNDLE_DOCUMENT_EXTENSIONS: readonly string[] = [
  // ── Apple iWork 三件套（OPCF/zip 内核单文件包，用户点名）──
  'key', // Keynote 讲演
  'numbers', // Numbers 表格
  'pages', // Pages 文稿
  // ── iWork 主题/模板族（与正文同构的 zip 内核单文件包）──
  'kth', // Keynote 主题
  'pwpt', // Pages 模板
  'mbtt', // Numbers 模板
  // ── Apple 平台其他 zip 内核文档/归档格式 ──
  'xip', // Apple 签名归档（zip + CMS 签名，改名即破坏签名校验）
  'ibooks', // Apple iBooks 电子书导出格式
  // ── 第三方 macOS 文档软件的 zip 内核单文件格式 ──
  'graffle', // OmniGraffle 单文件文稿
  'sketch', // Sketch 设计稿
  'xmind', // XMind 思维导图
  'mindnode', // MindNode 思维导图
  'itmz', // iThoughts 思维导图
  'mmap' // MindManager 思维导图
]

const PROTECTED_EXT_SET = new Set(ZIP_BUNDLE_DOCUMENT_EXTENSIONS)

/**
 * 判定扩展名是否受改名保护（白名单门禁）
 * 归一化：容忍前导点与任意大小写（如 ".KEY" / "Key" 均视为受保护）
 *
 * @param extension 扩展名（可带点，如 ".key"；也接受文件名路径由调用方先取 extname）
 */
export function isRenameProtectedExtension(extension: string | null | undefined): boolean {
  if (!extension) return false
  const normalized = extension.toLowerCase().replace(/^\.+/, '')
  return PROTECTED_EXT_SET.has(normalized)
}
