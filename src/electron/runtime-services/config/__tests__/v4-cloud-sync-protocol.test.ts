import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CloudAnalysisService } from '@firefly/server'

describe('V4 云端单 RTT 文件缓存同步协议 (Issue 08 & Issue 10)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    delete process.env.IS_INTEGRATION_TEST
  })

  it('checkCloudCacheBatch 应调用 rpc_get_files_batch、解开双重 JSON exif、保留 asr 并入队热度上报', async () => {
    const rpcMock = vi.fn().mockImplementation((fnName: string) => {
      if (fnName === 'rpc_get_files_batch') {
        return Promise.resolve({
          data: [
            {
              file_fingerprint: 'fp_v4_1',
              asr: '这是一段语音转写',
              exif: JSON.stringify(JSON.stringify({ camera: 'Sony', iso: 100 })),
              tags: [{ code: 'builtin.image', code_path: '/builtin.content_tags/builtin.image' }]
            }
          ],
          error: null
        })
      }
      if (fnName === 'rpc_report_cache_hits') {
        return Promise.resolve({
          data: { success: true, accepted_count: 1, updated_count: 1, truncated: false },
          error: null
        })
      }
      return Promise.resolve({ data: null, error: null })
    })

    const svc = CloudAnalysisService.getInstance() as any
    svc.supabase = { schema: () => ({ rpc: rpcMock }) }
    svc.identityProvider = {
      getMachineId: () => 'a'.repeat(64),
      getSignature: () => 'b'.repeat(64),
      getFeatures: () => ({})
    }

    const rows = await svc.checkCloudCacheBatch(['fp_v4_1'], 'zh-CN')
    expect(rows).toHaveLength(1)
    expect(rows[0].asr).toBe('这是一段语音转写')
    expect(rows[0].exif).toEqual({ camera: 'Sony', iso: 100 })
    expect(rpcMock).toHaveBeenCalledWith('rpc_get_files_batch', {
      p_fingerprints: ['fp_v4_1'],
      p_locale: 'zh-CN'
    })

    // 显式冲刷 60s 节流队列，断言调用 rpc_report_cache_hits
    await svc.flushCacheHits()
    expect(rpcMock).toHaveBeenCalledWith('rpc_report_cache_hits', {
      p_fingerprints: ['fp_v4_1']
    })
  })

  it('batchSync 应走单 RTT rpc_batch_sync_files、清理 NUL 字符并级联过滤父表缺失的 tag_relations', async () => {
    const rpcMock = vi.fn().mockResolvedValue({ data: { success: true }, error: null })

    const svc = CloudAnalysisService.getInstance() as any
    svc.supabase = { schema: () => ({ rpc: rpcMock }) }

    await svc.batchSync(
      {
        files: [
          {
            file_fingerprint: 'fp_ok',
            size: 1024,
            extension: 'jpg',
            file_group: 'image',
            smart_name: '测试\u0000图片',
            smart_name_source: 'ai',
            asr: '音频\u0000转写',
            exif: { camera: 'Canon\u0000' }
          },
          {
            file_fingerprint: '', // 非法父表项
            size: 0
          }
        ],
        tags: [
          {
            code: '_ext.custom1',
            name: '自定义标签',
            source: 'user'
          }
        ],
        tag_relations: [
          {
            file_fingerprint: 'fp_ok',
            tag_code: 'builtin.image',
            via_parent_code: 'builtin.content_tags',
            code_path: '/builtin.content_tags/builtin.image',
            depth: 2,
            tag_group: 'ai',
            source: 'ai'
          },
          {
            file_fingerprint: 'fp_missing_parent',
            tag_code: 'builtin.image',
            via_parent_code: 'builtin.content_tags',
            code_path: '/builtin.content_tags/builtin.image',
            depth: 2,
            tag_group: 'ai',
            source: 'ai'
          }
        ]
      },
      'zh-CN'
    )

    expect(rpcMock).toHaveBeenCalledTimes(1)
    const [rpcName, arg] = rpcMock.mock.calls[0]
    expect(rpcName).toBe('rpc_batch_sync_files')
    expect(arg.p_payload.locale).toBe('zh-CN')
    expect(arg.p_payload.files).toHaveLength(1)
    expect(arg.p_payload.file_contents[0].asr).toBe('音频转写')
    expect(arg.p_payload.file_contents[0].exif).toEqual({ camera: 'Canon' })
    expect(arg.p_payload.file_localizations[0].smart_name).toBe('测试图片')
    expect(arg.p_payload.file_tags_private[0].locale).toBe('zh-CN')
    // 父表缺失的 fp_missing_parent 关联已被级联过滤
    expect(arg.p_payload.file_tag_relations).toHaveLength(1)
    expect(arg.p_payload.file_tag_relations[0].file_fingerprint).toBe('fp_ok')
  })

  it('registerDevice 应调用签名校验的 rpc_register_device_heartbeat，严禁 anon 直写 devices 表', async () => {
    const rpcMock = vi.fn().mockResolvedValue({ data: { success: true }, error: null })
    const fromMock = vi.fn(() => {
      throw new Error('anon must not write devices table directly')
    })

    const svc = CloudAnalysisService.getInstance() as any
    svc.isRegistered = false
    svc.supabase = { schema: () => ({ rpc: rpcMock, from: fromMock }) }
    svc.identityProvider = {
      getMachineId: () => 'c'.repeat(64),
      getSignature: () => 'd'.repeat(64),
      getFeatures: () => ({ os: 'windows' })
    }

    await svc.syncFeatures()
    expect(fromMock).not.toHaveBeenCalled()
    expect(rpcMock).toHaveBeenCalledWith(
      'rpc_register_device_heartbeat',
      expect.objectContaining({
        p_machine_id: 'c'.repeat(64),
        p_features: { os: 'windows' }
      })
    )
  })
})
