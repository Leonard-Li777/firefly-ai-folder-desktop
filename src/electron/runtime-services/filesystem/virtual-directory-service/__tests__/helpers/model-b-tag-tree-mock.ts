/**
 * 模型 B TagTreeQuery 测试夹具工厂。
 *
 * 模型 A 的 file_tag_relations 直接物化 code_path；模型 B 只存 path_id，
 * code_path 下沉到 tag_paths，前缀计数走递归 CTE，标签计数按 ftr.tag_code / via_parent_code 聚合。
 * 旧 mock 用同一批「relations 行」回答所有 SQL，导致计数查询拿不到 file_count 列而恒为 0。
 * 本工厂按 SQL 语义分流，精确模拟模型 B 的四种查询形态。
 */
import { vi } from 'vitest'

export interface MockTagRelation {
  tagCode: string
  viaParentCode: string
  fileFingerprint: string
  codePath: string
}

function prefixCountsOf(relations: MockTagRelation[]): Array<{ prefix_code_path: string; file_count: number }> {
  const grouped = new Map<string, Set<string>>()
  for (const r of relations) {
    const segments = r.codePath.split('/').filter(Boolean)
    for (let i = 1; i <= segments.length; i++) {
      const prefix = `/${segments.slice(0, i).join('/')}`
      if (!grouped.has(prefix)) grouped.set(prefix, new Set())
      grouped.get(prefix)!.add(r.fileFingerprint)
    }
  }
  return Array.from(grouped, ([prefix_code_path, fps]) => ({
    prefix_code_path,
    file_count: fps.size
  }))
}

function distinctFingerprints(relations: MockTagRelation[], keyOf: (r: MockTagRelation) => string) {
  const grouped = new Map<string, Set<string>>()
  for (const r of relations) {
    const key = keyOf(r)
    if (!grouped.has(key)) grouped.set(key, new Set())
    grouped.get(key)!.add(r.fileFingerprint)
  }
  return grouped
}

export function createModelBTagTreeMockDb(
  relations: MockTagRelation[],
  privateTagRows: any[] = []
): any {
  const fingerprints = Array.from(new Set(relations.map(r => r.fileFingerprint)))
  const prefixCounts = prefixCountsOf(relations)
  const byTag = distinctFingerprints(relations, r => r.tagCode)
  const byTagParent = distinctFingerprints(relations, r => `${r.tagCode}::${r.viaParentCode}`)

  return {
    name: ':memory:',
    function: vi.fn(),
    pragma: vi.fn(),
    prepare: vi.fn((sql: string) => {
      const q = String(sql)
      if (q.includes('FROM file_tags_private')) {
        return { all: () => privateTagRows, get: () => null }
      }
      // A. 递归 CTE 前缀计数
      if (q.includes('prefix_code_path') || q.includes('COUNT(DISTINCT file_id) AS file_count')) {
        return { all: () => prefixCounts, get: () => null }
      }
      // D. 物化路径对照（模型 B 从 tag_paths 取）
      if (q.includes('JOIN tag_paths tp')) {
        return {
          all: () =>
            relations.map(r => ({ tag_code: r.tagCode, code_path: r.codePath })),
          get: () => null
        }
      }
      // C. tag::via_parent 计数
      if (q.includes('COUNT(DISTINCT wf.id) AS file_count') && q.includes('via_parent_code')) {
        return {
          all: () =>
            Array.from(byTagParent, ([key, fps]) => {
              const [tag_code, via_parent_code] = key.split('::')
              return { tag_code, via_parent_code, file_count: fps.size }
            }),
          get: () => null
        }
      }
      // B. 标签自身计数
      if (q.includes('COUNT(DISTINCT wf.id) AS file_count')) {
        return {
          all: () =>
            Array.from(byTag, ([tag_code, fps]) => ({ tag_code, file_count: fps.size })),
          get: () => null
        }
      }
      // 有效文件指纹集
      if (q.includes('FROM workspace_files wf')) {
        return {
          all: () => fingerprints.map(file_fingerprint => ({ file_fingerprint })),
          get: () => null
        }
      }
      // 兜底：模型 B 关系行（含 tag_paths 下钻后的 code_path 别名）
      if (q.includes('FROM file_tag_relations')) {
        return {
          all: () =>
            relations.map(r => ({
              tag_code: r.tagCode,
              via_parent_code: r.viaParentCode,
              file_fingerprint: r.fileFingerprint,
              code_path: r.codePath
            })),
          get: () => null
        }
      }
      return { all: () => [], get: () => null }
    })
  }
}
