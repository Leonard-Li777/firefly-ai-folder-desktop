import { describe, it, expect } from 'vitest'
import {
  deriveEngineBadge,
  deriveEngineHealthState,
  isEngineServiceOnline,
  isEngineServiceReady
} from '../engine-status-badge'

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

/**
 * 引擎健康状况与「引擎异常」徽章同源派生（2026-10-26 用户报告「引擎异常 + 引擎状态良好」并存）
 *
 * 缺陷成因：徽章读渲染层 AI 服务 ERROR（某次请求失败后的滞留标记），健康卡读主进程熔断器，
 * 两套事实各自演进。引擎在线（快照可达）但推理服务未就绪时，二者必然同屏矛盾。
 * 本护栏锁定「健康状态只认引擎侧事实」，并锁定徽章不再把在线引擎的滞留错误判成异常。
 */
describe('引擎健康状况派生（与徽章同源，禁止自相矛盾）', () => {
  it('引擎自报 error → 健康状态为 open，不得再显示「良好」', () => {
    expect(deriveEngineHealthState({ raw: { status: 'error' }, circuitState: 'closed' })).toBe('open')
  })

  it('引擎自报就绪（ready / processing）→ 一律 closed，避免与「已启动」徽章反向矛盾', () => {
    expect(deriveEngineHealthState({ raw: { status: 'ready' }, circuitState: 'open' })).toBe('closed')
    expect(deriveEngineHealthState({ raw: { status: 'processing' }, circuitState: 'half_open' })).toBe(
      'closed'
    )
  })

  it('未就绪时熔断器三态原样透传（closed / half_open / open）', () => {
    expect(deriveEngineHealthState({ raw: { status: 'stopped' }, circuitState: 'closed' })).toBe(
      'closed'
    )
    expect(deriveEngineHealthState({ raw: { status: 'starting' }, circuitState: 'half_open' })).toBe(
      'half_open'
    )
    expect(deriveEngineHealthState({ raw: { status: 'stopped' }, circuitState: 'open' })).toBe('open')
  })

  it('未知/缺失状态一律回落到 closed（离线时由调用方展示 —，不误报异常）', () => {
    expect(deriveEngineHealthState(null)).toBe('closed')
    expect(deriveEngineHealthState(undefined)).toBe('closed')
    expect(deriveEngineHealthState({ raw: null, circuitState: undefined })).toBe('closed')
    expect(deriveEngineHealthState({ raw: { status: 'stopped' }, circuitState: 'unknown' })).toBe(
      'closed'
    )
  })
})
