/**
 * 虚拟目录工具函数
 */

/**
 * 解析目标选中的虚拟目录 ID，考虑槽位过期限制
 * @param queryId URL 中的虚拟目录 ID（可能为 null）
 * @param vdirs 所有虚拟目录列表
 * @param slotLimit 槽位上限（undefined 表示无限制）
 * @returns 应选中的虚拟目录 ID，列表为空时返回 null
 */
/**
 * 计算在指定索引之前、没有 access_vdir 的虚拟目录数量
 */
export function getUnprotectedCountBefore(
  vdirs: { id: number }[],
  entitlements: { type: string; metadata?: { virtual_directory_id?: number } }[] | undefined,
  index: number
): number {
  return vdirs
    .slice(0, index)
    .filter(
      vd =>
        !entitlements?.some(
          e =>
            e.type === 'access_vdir' && String(e.metadata?.virtual_directory_id) === String(vd.id)
        )
    ).length
}

export function resolveTargetId(
  queryId: number | null,
  vdirs: { id: number }[],
  slotLimit: number | undefined,
  entitlements?: { type: string; metadata?: { virtual_directory_id?: number } }[]
): number | null {
  if (vdirs.length === 0) return null

  const hasAccessVdir = (id: number) =>
    entitlements?.some(
      e => e.type === 'access_vdir' && String(e.metadata?.virtual_directory_id) === String(id)
    )

  const isVdirActive = (index: number, id: number) => {
    if (slotLimit === undefined) return true
    if (hasAccessVdir(id)) return true
    const unprotectedBefore = vdirs
      .slice(0, index)
      .filter((_, i) => !hasAccessVdir(vdirs[i].id)).length
    return unprotectedBefore < slotLimit
  }

  if (queryId) {
    const idx = vdirs.findIndex(d => d.id === queryId)
    if (idx >= 0) return queryId
  }

  // 回退到第一个活跃的虚拟目录
  const firstValid = vdirs.findIndex((d, i) => isVdirActive(i, d.id))
  return firstValid >= 0 ? vdirs[firstValid].id : null
}
