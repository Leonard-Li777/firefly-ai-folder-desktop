import { MagikaFileCategory as MagikaCategory } from '@firefly/types'
import { AnydocResult } from '../../system/anydoc-service'

/**
 * 从 Omni 感知结果中归一化提取 Magika 文件分类（规避跨版本字段漂移）
 *
 * 背景（2026-10-14 定性）：Omni `/api/perceive` 的分类结果在不同版本挂在三个不同位置：
 *   1. `metadata.category`（早期约定，FileProcessor 历史唯一读取点）；
 *   2. `metadata.magika`（Rust omni-extract / omni-server 现行实际输出键名）；
 *   3. `perception.category` / `perception.magika`（感知根层直接平铺的形态）。
 * 历史实现只读 1，命中率极低，导致：
 *   - `[FileProcessor] Magika 分类识别完成: xxx (undefined)` —— magikaCategory 为 null
 *     却仍打印（对象存在但 label/group 全空，模板字面量求值为 undefined）；
 *   - `files.file_group` 退化为 `{mime_type, extensions}` 兜底，丢失 `group/label`，
 *     进而使标签入库层的媒体领域判定（image/video/audio/ebook）与属性面板 Magika 字段静默失效。
 *
 * 归一化规则：按 1 → 2 → 3 顺序取第一个可用值；字符串按 JSON 解析；
 * 命中对象须至少含 label / group / mime_type 之一，否则视为无效并继续回退。
 *
 * @param anydocResult anydocService.perceive 的返回结果
 * @returns 归一化后的 Magika 分类对象；无可用分类时返回 null
 */
export function resolveOmniMagikaCategory(
  anydocResult: AnydocResult | null | undefined
): MagikaCategory | null {
  const metadata = anydocResult?.metadata as any
  const perception = anydocResult?.perception as any

  const rawCandidates: unknown[] = [
    metadata?.category,
    metadata?.magika,
    perception?.category,
    perception?.magika
  ]

  for (const raw of rawCandidates) {
    if (!raw) continue

    let parsed: unknown = raw
    if (typeof raw === 'string') {
      try {
        parsed = JSON.parse(raw)
      } catch {
        continue
      }
    }

    if (!parsed || typeof parsed !== 'object') continue
    const cat = parsed as Partial<MagikaCategory> & Record<string, any>
    const hasSignal = Boolean(cat.label || cat.group || cat.mime_type)
    if (!hasSignal) continue

    const rawExtensions = cat.extensions ?? cat.extension
    return {
      description: typeof cat.description === 'string' ? cat.description : '',
      extensions: Array.isArray(rawExtensions)
        ? rawExtensions.filter((e: unknown) => typeof e === 'string')
        : typeof rawExtensions === 'string' && rawExtensions
          ? [rawExtensions]
          : [],
      group: typeof cat.group === 'string' ? cat.group : '',
      is_text: cat.is_text === true,
      label: typeof cat.label === 'string' ? cat.label : '',
      mime_type: typeof cat.mime_type === 'string' ? cat.mime_type : cat.mimeType || '',
      score: typeof cat.score === 'number' ? cat.score : 0
    }
  }

  return null
}
