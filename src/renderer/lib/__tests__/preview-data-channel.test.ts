import { describe, it, expect, beforeEach } from 'vitest'
import { PreviewResourceService } from '../../../electron/runtime-services/preview/preview-resource-service'

describe('PreviewDataChannel (Spec §8.2 维度 C: 数据通路与流式传输验收)', () => {
  let service: PreviewResourceService

  beforeEach(() => {
    service = new PreviewResourceService()
  })

  it('1. 流式 URL 路径校验与 400 保护', async () => {
    const invalidReq = new Request('ff-preview://invalid-format', { method: 'GET' })
    const res = await service.handleRequest(invalidReq)
    expect(res.status).toBe(400)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })

  it('2. 过期会话访问立即返回 404', async () => {
    const req = new Request('ff-preview://session/expired-session-id/stream', { method: 'GET' })
    const res = await service.handleRequest(req)
    expect(res.status).toBe(404)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })

  it('3. CORS OPTIONS 预检请求返回 204 与完整暴露头', async () => {
    const preflight = new Request('ff-preview://session/session_abc/stream', {
      method: 'OPTIONS',
      headers: {
        Origin: 'null',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'Range'
      }
    })
    const res = await service.handleRequest(preflight)
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET')
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Range')
    expect(res.headers.get('Access-Control-Max-Age')).toBe('86400')
  })

  it('4. 会话卸载后旧 Session 物理销毁', () => {
    service.mountSession('s-live', 'C:/test/file.step')
    expect(service.getActiveSessionCount()).toBe(1)

    // unmount
    service.unmountSession('s-live')
    expect(service.getActiveSessionCount()).toBe(0)
    expect(service.getSession('s-live')).toBeUndefined()
  })
})
