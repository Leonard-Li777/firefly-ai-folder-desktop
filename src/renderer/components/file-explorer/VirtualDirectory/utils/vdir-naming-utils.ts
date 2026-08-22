import { t } from '@app/languages'

/**
 * 虚拟目录名称防重与递增数字后缀算法
 * 如果 baseName 在 existingNames 中冲突，自动递增生成 baseName (1), baseName (2) 等唯一名称
 */
export function getUniqueVirtualDirectoryName(baseName: string, existingNames: string[]): string {
  const sanitizedBase = (baseName || '').trim() || t('新虚拟目录')
  const existingSet = new Set(existingNames.filter(Boolean).map(n => n.trim().toLowerCase()))

  if (!existingSet.has(sanitizedBase.toLowerCase())) {
    return sanitizedBase
  }

  // 如果基准名称本身已经带了 "(x)" 尾缀，剥离出根名字
  // 例如 "工作文档 (1)" -> root = "工作文档"
  const match = sanitizedBase.match(/^(.*?)(?:\s*\(\d+\))?$/)
  const rootName = (match && match[1] ? match[1].trim() : sanitizedBase) || t('新虚拟目录')

  let counter = 1
  while (true) {
    const candidate = `${rootName} (${counter})`
    if (!existingSet.has(candidate.toLowerCase())) {
      return candidate
    }
    counter++
  }
}
