/**
 * TagTreeQuery · 路径归一化与 LIKE 转义工具（拆分自原 TagTreeQuery.ts，只搬不改，逐字节保真）。
 * 原为模块顶层导出函数，拆分后 barrel 仍 re-export 以保外部导入契约零变化。
 */

/**
 * Windows 原生路径转义辅助函数 (Spec §3.1.2)
 * 使用 | 作为转义符，原样保留原生反斜杠 \，杜绝 ESCAPE '\' 时末尾反斜杠转义通配符引发的漏查漏洞
 */
export function escapeLikePrefixWindows(prefix: string): string {
  if (!prefix) return ''
  return prefix.replace(/\|/g, '||').replace(/%/g, '|%').replace(/_/g, '|_')
}

export function normalizeCodePath(p: string): string {
  if (!p) return ''
  const trimmed = p.trim().replace(/\\/g, '/')
  const segments = trimmed.split('/').filter(Boolean)
  return segments.length > 0 ? `/${segments.join('/')}` : ''
}
