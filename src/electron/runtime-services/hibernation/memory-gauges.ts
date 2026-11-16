/**
 * 模块休眠与能耗纯函数投影 (projectMemoryGauges)
 * 遵循 L3 规格书: docs/specs/unified-module-hibernation-and-energy-transparency-spec.md §3.3.2
 */

import { HibernationSnapshot, ModuleRuntimeMetric } from './types'

/**
 * 纯函数计算各内存仪表盘度量值
 * 严格落地规则：
 * 1. 严禁命令式累加已释放字节
 * 2. 驻留期严格核验实测采样；跨代、采样缺失或负值时标记不确定 (hasUncertainMemoryModules)
 * 3. 节约量严格要求 state === 'available' 且代次匹配的真实释放快照；处于 reserved 或跨代标记未决
 * 4. 返回不可变去重数组 uncertainKinds
 */
export function projectMemoryGauges(
  modules: readonly ModuleRuntimeMetric[]
): Pick<
  HibernationSnapshot,
  | 'totalResidentRamBytes'
  | 'totalResidentVramBytes'
  | 'totalSavedRamBytes'
  | 'totalSavedVramBytes'
  | 'hasUncertainVramModules'
  | 'hasUncertainMemoryModules'
  | 'uncertainKinds'
> {
  const kindsSet = new Set<'ram' | 'vram'>()
  let totalResidentRamBytes = 0
  let totalResidentVramBytes = 0
  let totalSavedRamBytes = 0
  let totalSavedVramBytes = 0

  for (const m of modules) {
    const defaultKind = m.effectiveMemoryKind ?? m.defaultMemoryKind ?? 'ram'

    // ISS-04 / ISS-05 / ISS-10: 驻留期严格核验实测采样；跨代、采样缺失或负值时标记不确定
    if (m.state === 'resident' || m.state === 'loading' || m.state === 'draining') {
      if (
        m.residentSample &&
        m.residentSample.bytes > 0 &&
        m.residentSample.modelGeneration === m.modelGeneration
      ) {
        if (m.residentSample.kind === 'vram') {
          totalResidentVramBytes += m.residentSample.bytes
        } else {
          totalResidentRamBytes += m.residentSample.bytes
        }
      } else if (m.residentSample && m.residentSample.modelGeneration !== m.modelGeneration) {
        // ISS-05: 跨代残留采样标记未决异常，不盲目累加，也不计 0
        kindsSet.add(m.residentSample.kind)
      } else if (m.state === 'resident' && (!m.residentSample || m.residentSample.bytes <= 0)) {
        // 模块已就绪运行但首个物理采样未就绪：标记占用确认中
        kindsSet.add(defaultKind)
      }
    } else if (m.state === 'error' && m.lastFailureKind === 'unload') {
      if (
        m.residentSample &&
        m.residentSample.bytes > 0 &&
        m.residentSample.modelGeneration === m.modelGeneration
      ) {
        if (m.residentSample.kind === 'vram') {
          totalResidentVramBytes += m.residentSample.bytes
        } else {
          totalResidentRamBytes += m.residentSample.bytes
        }
      } else {
        // ISS-05 / ISS-10: 采样缺失或 generation 不匹配时标记未决异常
        kindsSet.add(m.residentSample?.kind ?? defaultKind)
      }
    } else if (m.state === 'hibernated') {
      // ISS-02 / ISS-08 / ISS-09 / ISS-10: 节约量严格要求 state === 'available' 且代次匹配的真实释放快照
      if (m.lastReleased !== undefined) {
        if (m.lastReleased.modelGeneration === m.modelGeneration) {
          if (m.lastReleased.state === 'available' && m.lastReleased.bytes > 0) {
            if (m.lastReleased.kind === 'vram') {
              totalSavedVramBytes += m.lastReleased.bytes
            } else {
              totalSavedRamBytes += m.lastReleased.bytes
            }
          } else if (m.lastReleased.state === 'reserved') {
            kindsSet.add(m.lastReleased.kind)
          }
        } else {
          // 跨代释放快照未决：标记不确定异常
          kindsSet.add(m.lastReleased.kind)
        }
      } else if ((m.lastReleasedBytes ?? 0) > 0) {
        // 兜底：若未注入完整 lastReleased 但有 lastReleasedBytes
        if (defaultKind === 'vram') {
          totalSavedVramBytes += m.lastReleasedBytes!
        } else {
          totalSavedRamBytes += m.lastReleasedBytes!
        }
      }
    }
  }

  const uncertainKinds: readonly ('ram' | 'vram')[] = Object.freeze(Array.from(kindsSet))
  return {
    totalResidentRamBytes,
    totalResidentVramBytes,
    totalSavedRamBytes,
    totalSavedVramBytes,
    hasUncertainMemoryModules: uncertainKinds.length > 0,
    hasUncertainVramModules: kindsSet.has('vram'),
    uncertainKinds
  }
}
