/**
 * LazyMount 懒挂载边界组件 —— 开源侧直通存根（`@pro/perf/lazy-mount`）
 *
 * 【存根对称性（D-07）】`electron.vite.config.mts` / vitest 的动态 alias 决定：
 *   - 存在 `pro/src` 时 `@pro/*` → `pro/src/*`（Pro 真实实现）；
 *   - 否则 `@pro/*` → `src/shared/pro-stub/*`（本文件，开源直通存根）。
 *   本文件与 `pro/src/perf/lazy-mount.tsx` 必须导出完全相同的运行时符号集合与签名。
 *
 * 【直通契约（D-07 铁律）】开源侧不做懒挂载治理：
 *   - 直通渲染 `React.lazy(load)`（保留代码分割，但不做首次打开前的挂载延迟）；
 *   - `useOpen` 仍被调用以支撑 `injectOpen` 受控透传，开合行为与改造前一致；
 *   严禁空实现返回伪造组件，也严禁在存根内偷偷另建挂载门控（否则开源 / Pro 行为分裂）。
 *
 * 【禁止静默降级】存根生效时首次渲染 `warn` 一次，显式说明当前走直通路径。
 */
import React, { Suspense, useMemo } from 'react'

/** 实现标识：开源直通存根为 `'stub'`（供解析单测与运行期观测） */
export const LAZY_MOUNT_IMPL = 'stub' as const

export interface LazyMountProps<P extends object = Record<string, never>> {
  /** 开合状态自订阅 hook（与 Pro 实现签名一致） */
  useOpen: () => boolean
  /** 目标组件异步加载器（模块级稳定引用） */
  load: () => Promise<{ default: React.ComponentType<P> }>
  /** 透传给目标组件的 props（open 由 injectOpen 注入，此处省略） */
  componentProps?: Omit<P, 'open'>
  /** 是否向目标组件注入受控 `open` prop */
  injectOpen?: boolean
  /** 异步 chunk 加载期间的 Suspense 占位 */
  fallback?: React.ReactNode
}

let warned = false

/** 直通渲染：不做首次打开前的挂载延迟，其余行为与 Pro 实现逐位一致 */
export function LazyMount<P extends object = Record<string, never>>({
  useOpen,
  load,
  componentProps,
  injectOpen = false,
  fallback = null
}: LazyMountProps<P>): React.ReactElement | null {
  if (!warned) {
    warned = true
    console.warn('[LazyMount] 开源直通存根生效：不做懒挂载延迟，直接渲染 React.lazy(load)')
  }

  const open = useOpen()
  const LazyComponent = useMemo(() => React.lazy(load), [load])

  const props = (injectOpen ? { ...(componentProps as object), open } : componentProps) as P
  return (
    <Suspense fallback={fallback}>
      <LazyComponent {...props} />
    </Suspense>
  )
}

export default LazyMount
