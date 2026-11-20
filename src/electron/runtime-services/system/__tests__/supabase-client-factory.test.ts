import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../config/config-orchestrator', () => ({
  ConfigOrchestrator: {
    getInstance: () => ({
      getValue: () => undefined
    })
  }
}))

vi.mock('../../../utils/native-network', () => ({
  nativeFetch: vi.fn()
}))

import { appendLangQueryIfSafe } from '../supabase-client-factory'

describe('supabase-client-factory appendLangQueryIfSafe', () => {
  it('不得向 PostgREST 表端点追加 _lang，避免触发 failed to parse filter (zh-CN)', () => {
    const url =
      'https://example.supabase.co/rest/v1/app_configs?select=namespace,key&locale=in.(*,zh-CN)'
    expect(appendLangQueryIfSafe(url, 'zh-CN')).toBe(url)

    const urlObj = new URL(url)
    expect(appendLangQueryIfSafe(urlObj, 'zh-CN')).toBe(urlObj)
  })

  it('不得向 PostgREST RPC 端点追加 _lang', () => {
    const url = 'https://example.supabase.co/rest/v1/rpc/get_user_tier'
    expect(appendLangQueryIfSafe(url, 'zh-CN')).toBe(url)
  })

  it('对非 PostgREST 端点（如 Edge Functions）正常追加 _lang 且不重复追加', () => {
    const edgeUrl = 'https://example.supabase.co/functions/v1/bootstrap'
    expect(appendLangQueryIfSafe(edgeUrl, 'zh-CN')).toBe(`${edgeUrl}?_lang=zh-CN`)

    const edgeUrlWithQuery = 'https://example.supabase.co/functions/v1/bootstrap?foo=1'
    expect(appendLangQueryIfSafe(edgeUrlWithQuery, 'zh-CN')).toBe(`${edgeUrlWithQuery}&_lang=zh-CN`)

    const alreadyHasLang = 'https://example.supabase.co/functions/v1/bootstrap?_lang=en-US'
    expect(appendLangQueryIfSafe(alreadyHasLang, 'zh-CN')).toBe(alreadyHasLang)

    const edgeUrlObj = new URL(edgeUrl)
    expect(appendLangQueryIfSafe(edgeUrlObj, 'zh-CN')).toBe(`${edgeUrl}?_lang=zh-CN`)
  })
})
