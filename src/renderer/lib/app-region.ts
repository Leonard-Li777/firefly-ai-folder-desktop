import { normalizeAppRegion, type AppRegion } from '@firefly/shared'

/**
 * 当前客户端所属区域（渲染层唯一判定入口）
 *
 * 唯一可靠来源是 preload 注入的 `__APP_REGION__`（主进程 `resolveAppRegion()` 读取
 * 安装器写入的 app_env.json 后经 `--app-region=` 下发，preload.ts 再经
 * `contextBridge.exposeInMainWorld` 挂载）。缺省按国际版处理，与主进程口径一致。
 *
 * ⚠️ 注意：desktop 渲染层**不存在** `window.__APP_CONFIG__`（从未被 preload 注入），
 * 且渲染层配置对象不含 `SITE_DOMAIN` 字段，二者都不参与区域判定。
 */
export function getAppRegion(): AppRegion {
  const raw =
    (window as any)?.__APP_REGION__ || (window as any)?.electronAPI?.getAppRegion?.() || ''
  return normalizeAppRegion(raw)
}
