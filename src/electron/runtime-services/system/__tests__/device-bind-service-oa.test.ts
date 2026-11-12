// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest'

const configMap = new Map<string, string>()
const mockRpc = vi.fn()
const mockFunctionsInvoke = vi.fn()

vi.mock('@firefly/server', () => ({
  WORKSPACE_CONSTANTS: {
    SUPABASE_URL: 'https://mock.supabase.co',
    SUPABASE_ANON_KEY: 'mock-anon-key'
  }
}))

vi.mock('@firefly/shared', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  },
  LogCategory: { SYSTEM: 'SYSTEM' },
  getSharedSchemaName: () => 'app_v4'
}))

vi.mock('../remote-config-service', () => ({
  RemoteConfigService: {
    getInstance: () => ({
      getSupabaseClient: () => ({
        schema: () => ({
          rpc: mockRpc
        }),
        functions: {
          invoke: mockFunctionsInvoke
        }
      })
    })
  }
}))

vi.mock('../system-identity-service', () => ({
  SystemIdentityService: {
    getInstance: () => ({
      getMachineId: () => 'mock-machine-id-12345678',
      getAuthHeader: vi.fn()
    })
  }
}))

vi.mock('../supabase-client-factory', () => ({
  createSupabaseClient: vi.fn()
}))

vi.mock('../../../config/config-orchestrator', () => ({
  ConfigOrchestrator: {
    getInstance: () => ({
      getValue: (k: string) => configMap.get(k) || '',
      updateValue: async (k: string, v: string) => {
        configMap.set(k, v)
      }
    })
  }
}))

vi.mock('../../../main/window', () => ({
  getMainWindow: () => null
}))

import { DeviceBindService } from '../device-bind-service'

describe('DeviceBindService Stage 2 (公众号口令 & 邮箱绑定共用闭环)', () => {
  const service = DeviceBindService.getInstance()

  beforeEach(() => {
    vi.clearAllMocks()
    configMap.clear()
  })

  it('本地无 BIND_SESSION_TOKEN 时返回 BIND_SESSION_EXPIRED 且不调用 RPC', async () => {
    const res = await service.completeOaContactBinding()
    expect(res).toEqual({ success: false, error: 'BIND_SESSION_EXPIRED' })
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('公众号确认激活且 seated=true 时保存设备令牌、清空临时会话并返回 active', async () => {
    configMap.set('BIND_SESSION_TOKEN', 'bind-session-oa-1')
    mockRpc.mockResolvedValueOnce({
      data: {
        success: true,
        status: 'active',
        seated: true,
        contact_channel: 'wechat_oa',
        device_token: 'device-token-oa-1',
        session_token: 'device-token-oa-1'
      },
      error: null
    })

    const res = await service.completeOaContactBinding('INV99999')

    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith('rpc_complete_oa_contact_binding', {
      p_bind_session_token: 'bind-session-oa-1',
      p_invitation_code: 'INV99999'
    })
    expect(configMap.get('DEVICE_AUTH_TOKEN')).toBe('device-token-oa-1')
    expect(configMap.get('BIND_SESSION_TOKEN')).toBe('')
    expect(res.success).toBe(true)
    expect(res.status).toBe('active')
    expect(res.contact_channel).toBe('wechat_oa')
  })

  it('公众号确认激活但 seated=false 且席位已满时自动尝试入席并返回 need_evict', async () => {
    configMap.set('BIND_SESSION_TOKEN', 'bind-session-oa-2')
    mockRpc.mockResolvedValueOnce({
      data: {
        success: true,
        status: 'active',
        seated: false,
        contact_channel: 'wechat_oa',
        device_token: 'device-token-oa-2',
        session_token: 'device-token-oa-2'
      },
      error: null
    })
    mockFunctionsInvoke.mockResolvedValueOnce({
      data: {
        success: false,
        error: 'NEED_EVICT',
        need_evict: true,
        seated: false
      },
      error: null
    })

    const res = await service.completeOaContactBinding()

    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith('rpc_complete_oa_contact_binding', {
      p_bind_session_token: 'bind-session-oa-2',
      p_invitation_code: null
    })
    expect(mockFunctionsInvoke).toHaveBeenCalledTimes(1)
    expect(mockFunctionsInvoke).toHaveBeenCalledWith('seat-device', {
      headers: {
        authorization: 'Bearer device-token-oa-2'
      },
      body: {
        evictDeviceId: null
      }
    })
    expect(res).toMatchObject({
      success: true,
      status: 'need_evict',
      need_evict: true,
      seated: false,
      contact_channel: 'wechat_oa',
      device_token: 'device-token-oa-2'
    })
  })

  it('邮箱绑定返回 seated=false 且入席成功时归一返回 status=active, seated=true', async () => {
    configMap.set('BIND_SESSION_TOKEN', 'bind-session-email-1')
    mockRpc.mockResolvedValueOnce({
      data: {
        success: true,
        status: 'active',
        seated: false,
        contact_channel: 'email',
        device_token: 'device-token-email-1',
        session_token: 'device-token-email-1'
      },
      error: null
    })
    mockFunctionsInvoke.mockResolvedValueOnce({
      data: {
        success: true,
        seated: true
      },
      error: null
    })

    const res = await service.completeEmailBinding('test@example.com', '123456')

    expect(mockRpc).toHaveBeenCalledWith('rpc_complete_email_binding_and_invitation', {
      p_bind_session_token: 'bind-session-email-1',
      p_email: 'test@example.com',
      p_code: '123456',
      p_invitation_code: null
    })
    expect(mockFunctionsInvoke).toHaveBeenCalledWith('seat-device', {
      headers: {
        authorization: 'Bearer device-token-email-1'
      },
      body: {
        evictDeviceId: null
      }
    })
    expect(res).toMatchObject({
      success: true,
      status: 'active',
      seated: true,
      contact_channel: 'email',
      device_token: 'device-token-email-1'
    })
  })

  it('当 RPC 返回 SESSION_EXPIRED 时自动清空本地 BIND_SESSION_TOKEN 并返回失败', async () => {
    configMap.set('BIND_SESSION_TOKEN', 'stale-session-token')
    mockRpc.mockResolvedValueOnce({
      data: {
        success: false,
        error: 'SESSION_EXPIRED',
        message: '绑定会话已过期，请重新微信扫码'
      },
      error: null
    })

    const res = await service.completeOaContactBinding()

    expect(res).toEqual({
      success: false,
      error: 'SESSION_EXPIRED',
      message: '绑定会话已过期，请重新微信扫码'
    })
    expect(configMap.get('BIND_SESSION_TOKEN')).toBe('')
  })
})
