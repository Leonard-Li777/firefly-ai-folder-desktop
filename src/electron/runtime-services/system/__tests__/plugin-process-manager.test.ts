import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  deriveRunDecision,
  type HoldReason,
  type RunContext,
  type RunDecision
} from '../plugin-run-decision'
import {
  PluginProcessManager,
  getPluginProcessManager,
  setPluginProcessManagerForTest
} from '../plugin-process-manager'
import type {
  PluginAvailability,
  BuiltinModuleRecord
} from '../../database/dao/modular-resource-dao'

describe('Plugin Run Decision (纯函数生命周期决策)', () => {
  it('安全违规模块强阻断：shouldRun 为 false 且包含 securityDelist', () => {
    const decision = deriveRunDecision(
      {
        availability: 'delisted',
        install_state: 'active',
        delist_reason: 'security_violation'
      },
      { devModeEffective: true }
    )
    expect(decision.shouldRun).toBe(false)
    expect(decision.holdReasons).toContain('securityDelist')
    expect(decision.blockReason).toMatch(/安全违规/)
  })

  it('普通下架（general_deprecation）不判定为安全阻断，但已安装用户可继续遵循生命周期或提示', () => {
    const decision = deriveRunDecision(
      {
        availability: 'delisted',
        install_state: 'active',
        delist_reason: 'general_deprecation'
      },
      { devModeEffective: true }
    )
    // 普通废弃下架不产生 securityDelist 挂起
    expect(decision.holdReasons).not.toContain('securityDelist')
    expect(decision.shouldRun).toBe(true)
  })

  it('草稿模块在开发者模式关闭时阻断：shouldRun 为 false 且包含 devModeOff', () => {
    const decision = deriveRunDecision(
      {
        availability: 'draft',
        install_state: 'active',
        delist_reason: null
      },
      { devModeEffective: false }
    )
    expect(decision.shouldRun).toBe(false)
    expect(decision.holdReasons).toContain('devModeOff')
    expect(decision.blockReason).toMatch(/开发者模式/)
  })

  it('草稿模块在开发者模式开启时放行：shouldRun 为 true', () => {
    const decision = deriveRunDecision(
      {
        availability: 'draft',
        install_state: 'active',
        delist_reason: null
      },
      { devModeEffective: true }
    )
    expect(decision.shouldRun).toBe(true)
    expect(decision.holdReasons).not.toContain('devModeOff')
  })

  it('规划预热中模块阻断：shouldRun 为 false', () => {
    const decision = deriveRunDecision(
      {
        availability: 'coming_soon',
        install_state: 'active',
        delist_reason: null
      },
      { devModeEffective: true }
    )
    expect(decision.shouldRun).toBe(false)
    expect(decision.blockReason).toMatch(/预热/)
  })

  it('槽位被抢占阻断：shouldRun 为 false 且包含 slotPreempted', () => {
    const decision = deriveRunDecision(
      {
        availability: 'approved',
        install_state: 'active',
        delist_reason: null
      },
      { devModeEffective: true, slotPreempted: true }
    )
    expect(decision.shouldRun).toBe(false)
    expect(decision.holdReasons).toContain('slotPreempted')
    expect(decision.blockReason).toMatch(/独占能力槽位/)
  })

  it('【G-04 红线】：严禁以 holdReasons.length === 0 作为 shouldRun 判定依据（非 active 用户意图）', () => {
    const decision = deriveRunDecision(
      {
        availability: 'approved',
        install_state: 'installed_inactive',
        delist_reason: null
      },
      { devModeEffective: true, slotPreempted: false }
    )
    // 此时无任何异常挂起诊断，holdReasons 为空数组
    expect(decision.holdReasons.length).toBe(0)
    // 但因为用户未激活，shouldRun 必须严格为 false！
    expect(decision.shouldRun).toBe(false)
    expect(decision.blockReason).toMatch(/用户未激活/)
  })

  it('全量收集所有命中的挂起诊断原因（不短路）', () => {
    const decision = deriveRunDecision(
      {
        availability: 'draft',
        install_state: 'active',
        delist_reason: 'security_violation'
      },
      { devModeEffective: false, slotPreempted: true }
    )
    expect(decision.shouldRun).toBe(false)
    // 同时命中三项挂起原因
    expect(decision.holdReasons).toContain('securityDelist')
    expect(decision.holdReasons).toContain('devModeOff')
    expect(decision.holdReasons).toContain('slotPreempted')
    expect(decision.holdReasons.length).toBe(3)
  })
})

describe('PluginProcessManager (权威调度中枢与 isUsable 分层)', () => {
  let mockDao: any
  let mockModules: Map<string, BuiltinModuleRecord>

  beforeEach(() => {
    mockModules = new Map<string, BuiltinModuleRecord>()

    mockDao = {
      modules: {
        findByIdSync: vi.fn((id: string) => mockModules.get(id) ?? null),
        findActiveBySlotSync: vi.fn((slot: string) => {
          for (const m of mockModules.values()) {
            if (m.capability_slot === slot && m.install_state === 'active') {
              return m
            }
          }
          return null
        }),
        findActiveSync: vi.fn(() => {
          return Array.from(mockModules.values()).filter(m => m.install_state === 'active')
        }),
        updateInstallStateSync: vi.fn((id: string, state: any, err?: string) => {
          const m = mockModules.get(id)
          if (m) {
            m.install_state = state
            m.error_message = err ?? null
          }
        })
      }
    }
  })

  it('【防止非进程类模块假死】：isUsable 对 omni_onnx 与 builtin 模块分层放行', () => {
    const manager = new PluginProcessManager({ dao: mockDao })

    // 1. 注册 omni_onnx 模块（无需子进程）
    mockModules.set('perception_nsfw', {
      id: 'perception_nsfw',
      name: 'NSFW 检测',
      version: '1.0.0',
      catalog_version: 1,
      category: 'perception',
      capability_slot: 'perception_nsfw',
      slot_policy: 'exclusive_optional',
      backend_type: 'omni_onnx',
      author_code: 'official',
      author_name: null,
      availability: 'approved',
      delist_reason: null,
      total_bytes: 1000,
      install_state: 'active'
    } as BuiltinModuleRecord)

    // 2. 注册 builtin 模块（Node 内置服务）
    mockModules.set('ai_organize_skill', {
      id: 'ai_organize_skill',
      name: 'AI Organize Skill',
      version: '1.0.0',
      catalog_version: 1,
      category: 'tool',
      capability_slot: 'tool',
      slot_policy: 'multi_active',
      backend_type: 'builtin',
      author_code: 'official',
      author_name: null,
      availability: 'approved',
      delist_reason: null,
      total_bytes: 0,
      install_state: 'active'
    } as BuiltinModuleRecord)

    // 3. 注册 utility_process 模块（需要真实子进程）
    mockModules.set('custom_parser', {
      id: 'custom_parser',
      name: 'Custom Parser',
      version: '1.0.0',
      catalog_version: 1,
      category: 'parser',
      capability_slot: 'parser',
      slot_policy: 'multi_active',
      backend_type: 'utility_process',
      author_code: 'official',
      author_name: null,
      availability: 'approved',
      delist_reason: null,
      total_bytes: 5000,
      install_state: 'active'
    } as BuiltinModuleRecord)

    // 验证 omni_onnx 与 builtin：内存态虽无 PID，但只要 active 且无 holdReasons 即判定 isUsable = true
    expect(manager.isUsable('perception_nsfw')).toBe(true)
    expect(manager.isUsable('ai_organize_skill')).toBe(true)

    // 验证 utility_process：因尚未启动子进程，判定为 false
    expect(manager.isUsable('custom_parser')).toBe(false)

    // 模拟 utility_process 启动成功
    manager.setRunningForTest('custom_parser', { running: true, pid: 12345 })
    expect(manager.isUsable('custom_parser')).toBe(true)
  })

  it('存在挂起原因时 isUsable 必须返回 false', () => {
    const manager = new PluginProcessManager({ dao: mockDao })

    mockModules.set('perception_nsfw', {
      id: 'perception_nsfw',
      name: 'NSFW 检测',
      version: '1.0.0',
      catalog_version: 1,
      category: 'perception',
      backend_type: 'omni_onnx',
      availability: 'approved',
      delist_reason: null,
      total_bytes: 1000,
      install_state: 'active'
    } as BuiltinModuleRecord)

    // 手动注入 holdReason
    manager.setHoldReasons('perception_nsfw', ['devModeOff'])
    expect(manager.isUsable('perception_nsfw')).toBe(false)
  })

  it('requestActivate 拦截安全下架或未就绪模块并返回清晰错误', async () => {
    const manager = new PluginProcessManager({ dao: mockDao })

    mockModules.set('bad_module', {
      id: 'bad_module',
      name: '恶意模块',
      version: '1.0.0',
      catalog_version: 1,
      category: 'tool',
      backend_type: 'utility_process',
      availability: 'delisted',
      delist_reason: 'security_violation',
      total_bytes: 100,
      install_state: 'installed_inactive'
    } as BuiltinModuleRecord)

    const res = await manager.requestActivate('bad_module', 'user_toggle')
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/安全违规/)
    expect(manager.isUsable('bad_module')).toBe(false)
  })

  it('单选框替换模型：handleSlotSwitchover 平滑停止同槽前任', async () => {
    const manager = new PluginProcessManager({ dao: mockDao })
    const stopSpy = vi.spyOn(manager, 'stopProcess').mockResolvedValue(undefined)

    mockModules.set('engine_classic', {
      id: 'engine_classic',
      name: '经典引擎',
      version: '1.0.0',
      catalog_version: 1,
      category: 'ai-engine',
      capability_slot: 'base_embedding',
      slot_policy: 'exclusive_required',
      backend_type: 'omni_onnx',
      availability: 'approved',
      delist_reason: null,
      total_bytes: 100,
      install_state: 'active'
    } as BuiltinModuleRecord)

    // 新模块 incomingModuleId 为 engine_gemma
    await manager.handleSlotSwitchover('base_embedding', 'engine_gemma')
    // 应该调用 stopProcess 停止同槽前任 engine_classic
    expect(stopSpy).toHaveBeenCalledWith('engine_classic')
  })
})
