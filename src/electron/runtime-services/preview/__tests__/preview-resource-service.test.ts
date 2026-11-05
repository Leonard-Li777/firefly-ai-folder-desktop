import { describe, it, expect, beforeEach } from 'vitest'
import { PreviewResourceService } from '../preview-resource-service'

describe('PreviewResourceService', () => {
  let service: PreviewResourceService

  beforeEach(() => {
    service = new PreviewResourceService()
  })

  it('mountSession 与 unmountSession 生命周期管理', () => {
    const sessionId = 'session-test-1'
    const filePath = 'C:/test/model.step'

    // 挂载
    const mounted = service.mountSession(sessionId, filePath)
    expect(mounted).toBe(true)
    expect(service.getActiveSessionCount()).toBe(1)

    const entry = service.getSession(sessionId)
    expect(entry?.filePath).toBe(filePath)
    expect(entry?.abortController).toBeDefined()
    expect(entry?.abortController.signal.aborted).toBe(false)

    // 卸载
    const unmounted = service.unmountSession(sessionId)
    expect(unmounted).toBe(true)
    expect(service.getActiveSessionCount()).toBe(0)
    expect(service.getSession(sessionId)).toBeUndefined()
  })

  it('同 sessionId 重复挂载时自动终止旧流并更新', () => {
    const sessionId = 'session-dup'
    service.mountSession(sessionId, 'C:/test/old.step')
    const oldEntry = service.getSession(sessionId)

    service.mountSession(sessionId, 'C:/test/new.step')
    const newEntry = service.getSession(sessionId)

    expect(oldEntry?.abortController.signal.aborted).toBe(true)
    expect(newEntry?.filePath).toBe('C:/test/new.step')
    expect(newEntry?.abortController.signal.aborted).toBe(false)
    expect(service.getActiveSessionCount()).toBe(1)
  })

  it('参数非法时拒绝挂载', () => {
    expect(service.mountSession('', 'C:/test.step')).toBe(false)
    expect(service.mountSession('s-1', '')).toBe(false)
    expect(service.getActiveSessionCount()).toBe(0)
  })

  it('卸载不存在的会话返回 false', () => {
    expect(service.unmountSession('non-existent')).toBe(false)
  })

  it('handleRequest 正确响应 OPTIONS 预检请求并返回完整 CORS 头', async () => {
    const request = new Request('ff-preview://session/s1/stream', {
      method: 'OPTIONS'
    })
    const response = await service.handleRequest(request)

    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('OPTIONS')
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Range')
    expect(response.headers.get('Access-Control-Max-Age')).toBe('86400')
  })

  it('handleRequest 针对过期或无效 Session 返回 404/400 且附带 CORS 头', async () => {
    const notFoundReq = new Request('ff-preview://session/missing-session/stream', {
      method: 'GET'
    })
    const notFoundRes = await service.handleRequest(notFoundReq)
    expect(notFoundRes.status).toBe(404)
    expect(notFoundRes.headers.get('Access-Control-Allow-Origin')).toBe('*')

    const badReq = new Request('ff-preview://invalid-format', {
      method: 'GET'
    })
    const badRes = await service.handleRequest(badReq)
    expect(badRes.status).toBe(400)
    expect(badRes.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })
})
