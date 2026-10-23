import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * 定价页区域域名护栏（国内版 / 国际版分流）
 *
 * 背景缺陷：`getMarketingPricingUrl` 曾把兜底 baseUrl 硬编码为国际版
 * `https://www.aifolder.net/pricing`，而两份 app-config（cn / intl）都没有
 * `PAYMENT_INFO.pricing_url` 字段，导致国内版客户端点击「前往购买萤火」
 * 「升级帐户」「开通 Pro」「企业版购买」时全部被导向国际版站点。
 *
 * 另一处历史缺陷：实现曾读取 `window.__APP_CONFIG__`，但 desktop 渲染层从未
 * 注入该全局（preload 只注入 `__APP_REGION__`），PAYMENT_INFO 恒为空对象，
 * 使「配置优先」分支形同虚设。现统一从 `useConfigStore` 读取真实配置。
 *
 * 本护栏锁定：
 * 1. 定价页/购买页域名必须由 `getOfficialSiteDomain()`（区域推导）决定，严禁硬编码区域域名；
 * 2. `pricing_url`（定价页完整地址）与 `official_site_url`（官网根）语义不得混用；
 * 3. 配置非法时回退区域域名，不得在渲染期抛错；
 * 4. URL 形状（路径 / query 顺序 / 锚点）锁定为全等断言。
 */

vi.mock('@src/languages', () => ({
  default: { activeLanguage: 'zh-CN' },
  t: (s: string) => s
}))

// 区域域名表与归一化函数取真实实现（SITE_DOMAINS 是本次修复的事实源，mock 掉就等于没测）；
// 仅隔离与本用例无关的机器码编码函数，避免拉起 shared 的完整依赖图
vi.mock('@firefly/shared', async importOriginal => {
  const actual = await importOriginal<typeof import('@firefly/shared')>()
  return {
    ...actual,
    encodeMachineIdToRef: (id: string) => `ref_${id}`,
    encodeMachineIdToBase64: (id: string) => `b64_${id}`
  }
})

// 渲染进程配置的唯一真实来源（替代并不存在的 window.__APP_CONFIG__）
const configState: { config: any } = { config: null }
vi.mock('../../stores/config-store', () => ({
  useConfigStore: {
    getState: () => configState
  }
}))

import {
  buildPricingUrlSync,
  getMarketingPricingUrl,
  getOfficialSiteDomain,
  getOfficialSiteOrigin
} from '../marketing-link'

const setRegion = (region?: string) => {
  if (region === undefined) {
    delete (window as any).__APP_REGION__
  } else {
    ;(window as any).__APP_REGION__ = region
  }
}

const setPaymentInfo = (paymentInfo?: Record<string, any>) => {
  configState.config = paymentInfo ? { PAYMENT_INFO: paymentInfo } : null
}

describe('定价页区域域名分流', () => {
  beforeEach(() => {
    setRegion(undefined)
    setPaymentInfo(undefined)
    // 屏蔽 electronAPI 的区域注入通道，保证用例只走显式设置的 __APP_REGION__
    ;(window as any).electronAPI = { isPackaged: true }
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('国内版（cn）：购买萤火链接形状全等（域名 + 路径 + action + 锚点）', () => {
    setRegion('cn')
    expect(buildPricingUrlSync('buy_firecores')).toBe(
      'https://aifolder.iocn.cn/pricing?action=buy_firecores#firecores'
    )
  })

  it('国内版（大写 CN）：同样识别为国内版（test-setup 即注入大写）', () => {
    setRegion('CN')
    expect(buildPricingUrlSync('upgrade_pro')).toBe(
      'https://aifolder.iocn.cn/pricing?action=upgrade_pro'
    )
  })

  it('国际版（intl）：仍落在 www.aifolder.net', () => {
    setRegion('intl')
    expect(buildPricingUrlSync('upgrade_pro')).toBe(
      'https://www.aifolder.net/pricing?action=upgrade_pro'
    )
  })

  it('缺省区域：兜底国际版（与 resolveAppRegion 的缺省口径一致）', () => {
    expect(buildPricingUrlSync('enterprise')).toBe(
      'https://www.aifolder.net/pricing?action=enterprise#enterprise'
    )
  })

  it('设备标识码：ident_code 先于 action，且只携带一次', () => {
    setRegion('cn')
    const url = buildPricingUrlSync('enterprise', 'a+b/c==')
    expect(url).toBe(
      'https://aifolder.iocn.cn/pricing?ident_code=a%2Bb%2Fc%3D%3D&action=enterprise#enterprise'
    )
  })

  it('pricing_url 语义 = 定价页完整地址，原样使用', () => {
    setRegion('cn')
    setPaymentInfo({ pricing_url: 'https://example.com/plans' })
    expect(buildPricingUrlSync('upgrade_pro')).toBe(
      'https://example.com/plans?action=upgrade_pro'
    )
  })

  it('official_site_url 语义 = 官网根，必须补 /pricing（不得落在首页）', () => {
    setRegion('cn')
    setPaymentInfo({ official_site_url: 'https://example.com' })
    expect(buildPricingUrlSync('buy_firecores')).toBe(
      'https://example.com/pricing?action=buy_firecores#firecores'
    )
  })

  it('official_site_url 带 path/query 时只取 origin', () => {
    setRegion('cn')
    setPaymentInfo({ official_site_url: 'https://example.com/landing?from=mail' })
    expect(buildPricingUrlSync('enterprise')).toBe(
      'https://example.com/pricing?action=enterprise#enterprise'
    )
  })

  it('official_site_url 非法（缺 scheme）时回退区域域名并留痕', () => {
    setRegion('cn')
    setPaymentInfo({ official_site_url: 'aifolder.iocn.cn' })
    expect(buildPricingUrlSync('buy_firecores')).toBe(
      'https://aifolder.iocn.cn/pricing?action=buy_firecores#firecores'
    )
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('official_site_url'),
      expect.anything()
    )
  })

  it('pricing_url 非法（缺 scheme）时回退区域域名，不得抛错击穿渲染', () => {
    setRegion('cn')
    setPaymentInfo({ pricing_url: 'aifolder.iocn.cn/pricing' })
    expect(() => buildPricingUrlSync('buy_firecores')).not.toThrow()
    expect(buildPricingUrlSync('buy_firecores')).toBe(
      'https://aifolder.iocn.cn/pricing?action=buy_firecores#firecores'
    )
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('定价页地址非法'),
      expect.anything()
    )
  })

  it('配置为空的国内版：仍按区域落 iocn.cn（配置缺失不得回退国际版）', () => {
    setRegion('cn')
    setPaymentInfo({ method: 'wechat', support_email: 'support@iocn.cn' })
    expect(buildPricingUrlSync('buy_firecores')).toBe(
      'https://aifolder.iocn.cn/pricing?action=buy_firecores#firecores'
    )
  })

  it('getOfficialSiteOrigin 去掉尾斜杠，getOfficialSiteDomain 保持无尾斜杠常量', () => {
    setRegion('cn')
    expect(getOfficialSiteOrigin()).toBe('https://aifolder.iocn.cn')
    expect(getOfficialSiteOrigin()).not.toMatch(/\/$/)
    expect(getOfficialSiteDomain()).toBe('https://aifolder.iocn.cn')
  })

  it('渲染层不再依赖并不存在的 window.__APP_CONFIG__', () => {
    setRegion('cn')
    ;(window as any).__APP_CONFIG__ = { SITE_DOMAIN: 'https://www.aifolder.net' }
    expect(getOfficialSiteDomain()).toBe('https://aifolder.iocn.cn')
    delete (window as any).__APP_CONFIG__
  })

  it('异步入口 getMarketingPricingUrl（forceProductionDomain）同样按区域分流', async () => {
    setRegion('cn')
    await expect(getMarketingPricingUrl('buy_firecores', { forceProductionDomain: true })).resolves.toBe(
      'https://aifolder.iocn.cn/pricing?action=buy_firecores#firecores'
    )
  })

  it('异步入口真实链路：ident_code 取自 license.getIdentCode 且先于 action', async () => {
    setRegion('cn')
    ;(window as any).electronAPI = {
      isPackaged: true,
      license: { getIdentCode: async () => 'a+b/c==' }
    }
    await expect(
      getMarketingPricingUrl('buy_firecores', { forceProductionDomain: true })
    ).resolves.toBe(
      'https://aifolder.iocn.cn/pricing?ident_code=a%2Bb%2Fc%3D%3D&action=buy_firecores#firecores'
    )
  })

  it('异步入口真实链路：worktree/env 追加在 query 末尾且不破坏锚点', async () => {
    setRegion('cn')
    ;(window as any).electronAPI = {
      isPackaged: true,
      license: { getIdentCode: async () => 'abc' },
      getWorktreeInfo: async () => ({ worktreeName: 'tag-patch', isProd: false })
    }
    await expect(
      getMarketingPricingUrl('enterprise', { forceProductionDomain: true })
    ).resolves.toBe(
      'https://aifolder.iocn.cn/pricing?ident_code=abc&action=enterprise&worktree=tag-patch&env=dev#enterprise'
    )
  })

  it('设备标识码读取失败：降级为不带 ident_code 仍能打开定价页并留痕', async () => {
    setRegion('cn')
    ;(window as any).electronAPI = {
      isPackaged: true,
      license: {
        getIdentCode: async () => {
          throw new Error('license ipc not ready')
        }
      }
    }
    await expect(
      getMarketingPricingUrl('buy_firecores', { forceProductionDomain: true })
    ).resolves.toBe('https://aifolder.iocn.cn/pricing?action=buy_firecores#firecores')
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('ident_code'),
      expect.anything()
    )
  })

  it('worktree 信息读取失败：降级为不带 worktree/env 仍能打开定价页并留痕', async () => {
    setRegion('cn')
    ;(window as any).electronAPI = {
      isPackaged: true,
      getWorktreeInfo: async () => {
        throw new Error('worktree ipc not ready')
      }
    }
    await expect(
      getMarketingPricingUrl('enterprise', { forceProductionDomain: true })
    ).resolves.toBe('https://aifolder.iocn.cn/pricing?action=enterprise#enterprise')
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('worktree'),
      expect.anything()
    )
  })
})
