import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * 定价页区域域名护栏（国内版 / 国际版分流）
 *
 * 背景缺陷：`getMarketingPricingUrl` 曾把兜底 baseUrl 硬编码为国际版
 * `https://www.aifolder.net/pricing`，而两份 app-config（cn / intl）都没有
 * `PAYMENT_INFO.pricing_url` 字段，导致国内版客户端点击「前往购买萤火」
 * 「升级帐户」「开通 Pro」「企业版购买」时全部被导向国际版站点。
 *
 * 本护栏锁定：定价页/购买页域名必须由 `getOfficialSiteDomain()`（区域推导）决定，
 * 严禁在链路中硬编码任一区域域名。
 */

vi.mock('@src/languages', () => ({
  default: { activeLanguage: 'zh-CN' },
  t: (s: string) => s
}))

vi.mock('@firefly/shared', () => ({
  encodeMachineIdToRef: (id: string) => `ref_${id}`,
  encodeMachineIdToBase64: (id: string) => `b64_${id}`
}))

import { buildPricingUrlSync, getOfficialSiteDomain } from '../marketing-link'

const setRegion = (region?: string) => {
  if (region === undefined) {
    delete (window as any).__APP_REGION__
  } else {
    ;(window as any).__APP_REGION__ = region
  }
}

const setAppConfig = (config?: any) => {
  if (config === undefined) {
    delete (window as any).__APP_CONFIG__
  } else {
    ;(window as any).__APP_CONFIG__ = config
  }
}

describe('定价页区域域名分流', () => {
  beforeEach(() => {
    setRegion(undefined)
    setAppConfig(undefined)
    // 屏蔽 electronAPI 的区域注入通道，保证用例只走显式设置的 __APP_REGION__
    ;(window as any).electronAPI = { isPackaged: true }
  })

  it('国内版（cn）：购买萤火链接必须落在 aifolder.iocn.cn，绝不能出现 aifolder.net', () => {
    setRegion('cn')
    const url = buildPricingUrlSync('buy_firecores')
    expect(url.startsWith('https://aifolder.iocn.cn/pricing')).toBe(true)
    expect(url).not.toContain('aifolder.net')
    expect(url).toContain('action=buy_firecores')
    expect(url).toContain('#firecores')
  })

  it('国内版（大写 CN）：同样识别为国内版（test-setup 即注入大写）', () => {
    setRegion('CN')
    const url = buildPricingUrlSync('upgrade_pro')
    expect(url.startsWith('https://aifolder.iocn.cn/pricing')).toBe(true)
    expect(url).toContain('action=upgrade_pro')
  })

  it('国际版（intl）：仍落在 www.aifolder.net', () => {
    setRegion('intl')
    const url = buildPricingUrlSync('upgrade_pro')
    expect(url.startsWith('https://www.aifolder.net/pricing')).toBe(true)
    expect(url).not.toContain('iocn.cn')
  })

  it('缺省区域：兜底国际版（与 resolveAppRegion 的缺省口径一致）', () => {
    const url = buildPricingUrlSync('enterprise')
    expect(url.startsWith('https://www.aifolder.net/pricing')).toBe(true)
    expect(url).toContain('#enterprise')
  })

  it('设备标识码：ident_code 只携带一次且编码正确', () => {
    setRegion('cn')
    const url = buildPricingUrlSync('enterprise', 'a+b/c==')
    expect(url).toContain('ident_code=a%2Bb%2Fc%3D%3D')
    expect(url.split('ident_code=').length).toBe(2)
  })

  it('SITE_DOMAIN 显式配置优先于区域推导', () => {
    setRegion('intl')
    setAppConfig({ SITE_DOMAIN: 'https://aifolder.iocn.cn' })
    expect(getOfficialSiteDomain()).toBe('https://aifolder.iocn.cn')
    expect(buildPricingUrlSync('buy_firecores').startsWith('https://aifolder.iocn.cn/pricing')).toBe(
      true
    )
  })

  it('SITE_DOMAIN 带尾斜杠时不产生双斜杠', () => {
    setRegion('cn')
    setAppConfig({ SITE_DOMAIN: 'https://aifolder.iocn.cn/' })
    const url = buildPricingUrlSync('buy_firecores')
    expect(url).not.toContain('iocn.cn//pricing')
  })

  it('PAYMENT_INFO.pricing_url 显式配置优先于区域推导（配置即事实源）', () => {
    setRegion('cn')
    setAppConfig({ PAYMENT_INFO: { pricing_url: 'https://example.com/plans' } })
    const url = buildPricingUrlSync('upgrade_pro')
    expect(url.startsWith('https://example.com/plans')).toBe(true)
  })
})
