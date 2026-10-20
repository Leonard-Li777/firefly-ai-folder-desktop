/**
 * 逆地理编码适配器注册（main 进程启动时执行）。
 *
 * 背景：core-engine 是跨端共享包，严禁跨边界引用 desktop 主进程模块。此前
 * magika-mapper 直接动态导入 omni-service，既违反包边界，又因该文件物理位于
 * core-engine rootDir 之外而导致 TS6059/TS6307 构建失败。现按 adapters.ts 既有
 * 适配器模式反转依赖方向：本文件在 desktop 侧实现 IGeoAdapter 并注册进 core-engine，
 * magika-mapper 的 GPS 地理位置找补因此获得逆地理编码能力。
 *
 * 仅在 main 进程加载；renderer 不注册，相关能力显式跳过并告警（禁止静默降级）。
 */
import { registerGeoAdapter } from '@firefly/core-engine'
import { omniService } from './omni-service'

registerGeoAdapter({
  async reverseGeo(points, language) {
    const resp = await omniService.reverseGeo(points, language)
    return resp?.results ?? null
  }
})
