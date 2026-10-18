import { describe, it, expect } from 'vitest'
import { deriveEngineBadge, isEngineServiceOnline, isEngineServiceReady } from '../engine-status-badge'

/**
 * 引擎推理服务状态判定护栏（PRD-0044）
 *
 * 背景缺陷：引擎侧 `EngineCoordinator::get_status()` 在「有请求正在处理」时把 status 由
 * `ready` 切换为 `processing`（`apps/firefly-ai-engine/src-tauri/src/engine/mod.rs`）。
 * UI 侧曾散写 `status === 'ready'` 表达「服务已启动」，导致分析文件期间：
 *   - 设置页「启动服务 / 停止服务」按钮交替闪现；
 *   - 徽章「已启动 / 已连接」交替闪现；
 *   - 「当前模型」展示名在运行模型与激活槽位模型之间跳变。
 * 本护栏锁定「已启动」的唯一口径，防止回归。
 */
describe('引擎推理服务状态判定（ready / processing 同属已启动）', () => {
  it('isEngineServiceReady：空闲与推理中都算服务已就绪', () => {
    expect(isEngineServiceReady('ready')).toBe(true)
    expect(isEngineServiceReady('processing')).toBe(true)
  })

  it('isEngineServiceReady：启动中 / 已停止 / 异常 / 空值都不算就绪', () => {
    expect(isEngineServiceReady('starting')).toBe(false)
    expect(isEngineServiceReady('stopped')).toBe(false)
    expect(isEngineServiceReady('error')).toBe(false)
    expect(isEngineServiceReady(null)).toBe(false)
    expect(isEngineServiceReady(undefined)).toBe(false)
  })

  it('isEngineServiceOnline：已就绪或正在拉起，一律展示「停止服务」而非「启动服务」', () => {
    // 核心回归点：分析文件（processing）时按钮不得回退为「启动服务」
    expect(isEngineServiceOnline('processing')).toBe(true)
    expect(isEngineServiceOnline('ready')).toBe(true)
    expect(isEngineServiceOnline('starting')).toBe(true)
    expect(isEngineServiceOnline('stopped')).toBe(false)
    expect(isEngineServiceOnline('error')).toBe(false)
    expect(isEngineServiceOnline(undefined)).toBe(false)
  })

  it('徽章：推理中（started=true）仍派生「已启动」，不得降级为「已连接」', () => {
    const res = deriveEngineBadge({
      selected: true,
      local: { detecting: false, failed: false, connected: true, started: true, available: true }
    })
    expect(res.status).toBe('started')
    expect(res.grayed).toBe(false)

    const idle = deriveEngineBadge({
      selected: true,
      local: { detecting: false, failed: false, connected: true, started: false, available: true }
    })
    expect(idle.status).toBe('connected')
  })
})
