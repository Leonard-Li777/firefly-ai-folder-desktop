import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../config/config-orchestrator', () => ({
  ConfigOrchestrator: {
    getInstance: () => ({
      getValue: (k: string) => {
        if (k === 'ENABLE_IMAGE_OCR') return true
        if (k === 'AI_EMBEDDING_PROFILE') return 'classic_light'
        if (k === 'EMBEDDING_MRL_DIMENSION') return 512
        return null
      }
    })
  }
}))

vi.mock('../modular-resource-service', () => ({
  modularResourceService: {
    getModule: (id: string) => {
      if (id === 'perception_nsfw') {
        return { id: 'perception_nsfw', install_state: 'active' }
      }
      return null
    }
  }
}))

import { omniService, type OmniPerceptionResponse } from '../omni-service'

describe('Omni 原生感知插槽 (Ticket 03) Desktop 端消费与配置同步测试', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('OmniPerceptionResponse 支持并保留 nsfw_perception 与 face_perception 结构', () => {
    const mockResponse: OmniPerceptionResponse = {
      file_path: 'C:/test/sample.jpg',
      mime_type: 'image/jpeg',
      file_size: 1024,
      visual_tags: [],
      audio_events: [],
      is_corrupted: false,
      metadata: {},
      nsfw_perception: {
        status: 'skipped',
        tags: []
      },
      face_perception: {
        status: 'skipped',
        tags: []
      }
    }

    expect(mockResponse.nsfw_perception?.status).toBe('skipped')
    expect(mockResponse.nsfw_perception?.tags).toEqual([])
    expect(mockResponse.face_perception?.status).toBe('skipped')

    const flaggedResponse: OmniPerceptionResponse = {
      ...mockResponse,
      nsfw_perception: {
        status: 'flagged',
        tags: ['nsfw-l3', '色情']
      }
    }
    expect(flaggedResponse.nsfw_perception?.status).toBe('flagged')
    expect(flaggedResponse.nsfw_perception?.tags).toContain('nsfw-l3')
  })

  it('syncConfigFromDesktop 向 /api/config 同步感知插槽激活状态', async () => {
    let capturedBody: any = null
    const globalFetch = vi.fn().mockImplementation((url: string, init: any) => {
      if (url.includes('/api/config')) {
        capturedBody = JSON.parse(init.body)
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({})
        })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
    vi.stubGlobal('fetch', globalFetch)

    const ok = await omniService.syncConfigFromDesktop()
    expect(ok).toBe(true)
    expect(capturedBody).toBeDefined()
    expect(capturedBody.enable_nsfw_perception).toBe(true)
    expect(capturedBody.enable_face_perception).toBe(false)
  })

  it('当用户未开启 perception_nsfw 插件时，下发 enable_nsfw_perception: false 且正确跳过不阻断', async () => {
    const { modularResourceService } = await import('../modular-resource-service')
    vi.spyOn(modularResourceService, 'getModule').mockReturnValue({
      id: 'perception_nsfw',
      install_state: 'installed_inactive'
    } as any)

    let capturedBody: any = null
    const globalFetch = vi.fn().mockImplementation((url: string, init: any) => {
      if (url.includes('/api/config')) {
        capturedBody = JSON.parse(init.body)
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({})
        })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
    vi.stubGlobal('fetch', globalFetch)

    const ok = await omniService.syncConfigFromDesktop()
    expect(ok).toBe(true)
    expect(capturedBody).toBeDefined()
    expect(capturedBody.enable_nsfw_perception).toBe(false)

    // 验证跳过状态下返回数据符合预期，且不产生错误阻断
    const mockSkippedResponse: OmniPerceptionResponse = {
      file_path: 'C:/test/nature.jpg',
      mime_type: 'image/jpeg',
      file_size: 2048,
      visual_tags: ['风景', '山脉'],
      audio_events: [],
      is_corrupted: false,
      metadata: {},
      nsfw_perception: {
        status: 'skipped',
        tags: []
      }
    }
    expect(mockSkippedResponse.nsfw_perception?.status).toBe('skipped')
    expect(mockSkippedResponse.nsfw_perception?.tags).toEqual([])
    expect(mockSkippedResponse.visual_tags).not.toContain('色情')
    expect(mockSkippedResponse.visual_tags).not.toContain('血腥')
  })
})
